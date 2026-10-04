#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadAdapter, resolveDeployment } from './src/adapter.mjs';
import { buildRelease, createReleasePlan, packageRelease } from './src/build-core-1-6.mjs';
import { asDeliveryError, DeliveryError, invariant } from './src/errors.mjs';
import { simpleDownloadEndpoint, simpleOssClientFromEnvironment } from './src/oss-client-1-6.mjs';
import { runCommand } from './src/runner.mjs';
import { runIndependent } from './src/run-independent.mjs';
import { inspectSimpleArtifact, publishSimpleArtifacts, resolveSimpleArtifact } from './src/simple-artifact-store.mjs';

const SHA = /^[a-f0-9]{40}$/;
const RELEASE_ID = /^r16-([a-f0-9]{40})$/;
const context = { stage: 'startup', target: null, node: null };

async function main() {
  try {
    const options = parse(process.argv.slice(2));
    const controlRoot = resolve(options.controlRoot ?? process.cwd());
    const sourceSha = sourceFromIdentifier(options.identifier ?? options.sourceSha);
    const loaded = await loadAdapter(join(controlRoot, '02_platform_pingtai/infrastructure/release/zdt-next.release.json'), controlRoot);
    const adapter = Object.freeze({
      ...bindControlPlaneModules(loaded, controlRoot),
      projectRoot: options.sourceRoot ? resolve(options.sourceRoot) : controlRoot,
      stateDirectory: resolve(process.env.RUNNER_TEMP ?? '/tmp', `zdt-runner-1-6-${process.env.GITHUB_RUN_ID ?? process.pid}`),
    });
    let result;
    if (options.operation === 'release' || options.operation === 'retry') {
      invariant(sourceSha, 'SOURCE_SHA_REQUIRED', 'release and retry require a full Source SHA or r16 release id');
      result = await release(adapter, controlRoot, sourceSha, options.target, options.node);
    } else if (options.operation === 'status') {
      invariant(sourceSha, 'SOURCE_SHA_REQUIRED', 'status requires a full Source SHA or r16 release id');
      result = await status(adapter, sourceSha);
    } else if (options.operation === 'rollback') {
      result = await rollback(adapter, controlRoot, options.target, options.node);
    } else if (options.operation === 'control-update') {
      result = await updateRemoteControl(adapter, controlRoot);
    } else throw new DeliveryError('OPERATION_UNKNOWN', `Unknown Runner 1.6 operation: ${options.operation}`);
    process.stdout.write(`RUNNER_1_6_RESULT=${JSON.stringify(result)}\n`);
  } catch (unknown) {
    const error = asDeliveryError(unknown);
    const details = error.details ?? {};
    const failure = {
      state: 'FAILED',
      stage: context.stage,
      target: context.target,
      node: context.node,
      command: Array.isArray(details.argv) ? details.argv.join(' ') : null,
      exitCode: details.exitCode ?? null,
      error: error.message,
      code: error.code,
      output: details.outputTail ?? null,
      serviceStatus: nested(details, ['candidateFailure', 'details', 'readiness']) ?? nested(details, ['receipt', 'readiness']) ?? null,
      recovery: details.rollback ?? details.pointerRecovery ?? null,
    };
    process.stderr.write(`RUNNER_1_6_RESULT=${JSON.stringify(failure)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

async function release(adapter, controlRoot, sourceSha, target, node) {
  const exactScope = Boolean(target || node);
  invariant(!exactScope || (target && node), 'EXACT_SCOPE_INCOMPLETE', 'Fast production deployment requires both target and physical node');
  if (exactScope) return deployExact(adapter, controlRoot, sourceSha, target, node);
  context.stage = 'plan';
  progress('plan', { sourceSha });
  const plan = await createReleasePlan(adapter, { from: `${sourceSha}^`, to: sourceSha });
  const releaseId = `r16-${sourceSha}`;
  if (!plan.deployRequired) return { state: 'HEALTHY', releaseId, sourceSha, executor: executor(), targets: [], message: 'No runtime target changed.' };
  const client = simpleOssClientFromEnvironment();
  const cache = [];
  progress('artifact-lookup', { sourceSha, targets: plan.deploymentOrder });
  for (const target of plan.deploymentOrder) cache.push(await inspectSimpleArtifact(adapter, { target, sourceSha }, client));
  const needsBuild = cache.some((item) => !item.exists);
  let cacheStatus = 'reused';
  if (needsBuild) {
    context.stage = 'dependencies';
    progress('dependencies', { sourceSha });
    await installDependencies(adapter, controlRoot);
    context.stage = 'build';
    progress('build', { sourceSha, targets: plan.deploymentOrder });
    const built = await buildRelease(adapter, plan.planPath);
    progress('build-complete', { sourceSha, timings: built.timings });
    context.stage = 'package';
    progress('package', { sourceSha, targets: plan.deploymentOrder });
    const packaged = await packageRelease(adapter, built.buildPath);
    context.stage = 'upload';
    progress('upload', { sourceSha, targets: plan.deploymentOrder });
    await publishSimpleArtifacts(adapter, packaged.packagePath, client);
    cacheStatus = 'built';
  }

  const deployments = [];
  const totalPlacements = plan.deploymentOrder.reduce((count, deploymentTarget) => count + physicalPlacements(adapter, deploymentTarget).length, 0);
  const productionStarted = performance.now();
  for (const deploymentTarget of plan.deploymentOrder) {
    for (const physicalNode of physicalPlacements(adapter, deploymentTarget)) {
      context.stage = 'deploy';
      context.target = deploymentTarget;
      context.node = physicalNode;
      progress('deploy', { sourceSha, target: deploymentTarget, node: physicalNode, completed: deployments.length, total: totalPlacements });
      const deployed = await deployTarget(adapter, controlRoot, client, { target: deploymentTarget, node: physicalNode, sourceSha });
      deployments.push(deployed);
    }
  }
  const productionDurationMs = Math.round(performance.now() - productionStarted);
  progress('complete', { sourceSha, productionDurationMs, productionSloMs: 60_000 });
  return {
    state: 'HEALTHY',
    releaseId,
    sourceSha,
    controlSha: process.env.CONTROL_SHA,
    executor: executor(),
    cacheStatus,
    exactScope: false,
    productionDurationMs,
    productionSlo: productionDurationMs <= 60_000 ? 'met' : 'missed',
    targets: deployments,
  };
}

async function installDependencies(adapter, controlRoot) {
  const lockfile = await stat(join(controlRoot, 'package-lock.json')).then((value) => ({ present: true, bytes: value.size })).catch((error) => ({ present: false, error: error.code ?? error.message }));
  process.stdout.write(`RUNNER_1_6_DIAGNOSTIC=${JSON.stringify({ stage: 'dependencies', controlRoot, controlSha: process.env.CONTROL_SHA ?? null, controlLockfile: lockfile })}\n`);
  const install = { argv: ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], timeoutMs: 20 * 60_000 };
  const started = performance.now();
  const installs = [() => runCommand({ ...install, name: 'install-control-dependencies' }, { ...commandContext(adapter), projectRoot: controlRoot })];
  if (resolve(controlRoot) !== resolve(adapter.projectRoot)) {
    installs.push(() => runCommand({ ...install, name: 'install-source-dependencies' }, commandContext(adapter)));
  }
  const results = await runIndependent(installs);
  process.stdout.write(`RUNNER_1_6_DIAGNOSTIC=${JSON.stringify({ stage: 'dependencies-complete', durationMs: Math.round(performance.now() - started), installs: results.map(({ name, durationMs }) => ({ name, durationMs })) })}\n`);
}

async function deployExact(adapter, controlRoot, sourceSha, target, node) {
  context.stage = 'artifact-lookup';
  context.target = target;
  context.node = node;
  resolveDeployment(adapter, node, target);
  const productionStarted = performance.now();
  const client = simpleOssClientFromEnvironment();
  progress('artifact-lookup', { sourceSha, target, node });
  const cached = await inspectSimpleArtifact(adapter, { target, sourceSha }, client);
  if (!cached.exists) {
    throw new DeliveryError('ARTIFACT_NOT_READY', `Immutable artifact is not ready for ${target} at ${sourceSha}`, {
      sourceSha,
      target,
      node,
      cache: cached,
      retryable: false,
      nextSafeAction: 'prepare the immutable artifact outside the production cutover and rerun the same exact deployment',
    });
  }
  context.stage = 'deploy';
  progress('deploy', { sourceSha, target, node, completed: 0, total: 1 });
  const deployed = await deployTarget(adapter, controlRoot, client, { target, node, sourceSha });
  const productionDurationMs = Math.round(performance.now() - productionStarted);
  progress('complete', { sourceSha, target, node, productionDurationMs, productionSloMs: 60_000 });
  return {
    state: 'HEALTHY',
    releaseId: `r16-${sourceSha}`,
    sourceSha,
    controlSha: process.env.CONTROL_SHA,
    executor: executor(),
    cacheStatus: 'reused',
    exactScope: true,
    productionDurationMs,
    productionSlo: productionDurationMs <= 60_000 ? 'met' : 'missed',
    targets: [deployed],
  };
}

async function deployTarget(adapter, controlRoot, publicClient, { target, node, sourceSha }) {
  const resolved = await resolveSimpleArtifact(adapter, { target, sourceSha }, publicClient);
  const deployment = resolveDeployment(adapter, node, target);
  const transport = deployment.node.transport ?? adapter.transport;
  const host = process.env[transport.hostEnv ?? 'AI_DELIVERY_SSH_HOST'] ?? transport.host;
  invariant(host, 'DEPLOY_SSH_HOST_MISSING', `SSH host missing for ${node}`);
  const downloadClient = simpleOssClientFromEnvironment(simpleDownloadEndpoint(publicClient.endpoint, process.env.ALIYUN_OSS_INTERNAL_ENDPOINT));
  const agentHash = await fileHash(join(controlRoot, '04_tools/release-engine/remote/agent.mjs'));
  const policyHash = await fileHash(join(controlRoot, '02_platform_pingtai/infrastructure/release/zdt-next.remote-policy.json'));
  const artifact = resolved.release.artifact;
  const runtimeManifest = resolved.release.runtimeManifest;
  const result = await runCommand(
    {
      name: `deploy:${node}:${target}`,
      argv: sshArgv(host, [
        transport.agent ?? '/usr/local/lib/ai-delivery/agent.mjs',
        'deploy-oss-direct-v2',
        '--project',
        adapter.project,
        '--node',
        deployment.executionNode,
        '--target',
        target,
        '--source-sha',
        sourceSha,
        '--sha256',
        artifact.sha256.slice(7),
        '--tree-digest',
        artifact.treeDigest,
        '--manifest-digest',
        runtimeManifest.manifestDigest,
        '--control-sha',
        requiredEnv('CONTROL_SHA'),
        '--github-run-id',
        requiredEnv('GITHUB_RUN_ID'),
        '--github-run-attempt',
        requiredEnv('GITHUB_RUN_ATTEMPT'),
        '--expected-remote-agent-sha256',
        `sha256:${agentHash}`,
        '--expected-remote-policy-sha256',
        `sha256:${policyHash}`,
      ]),
      input: `${JSON.stringify({ artifactUrl: downloadClient.signGet(artifact.object), manifestUrl: downloadClient.signGet(runtimeManifest.object), ...(deployment.node.ingress && target === 'database-migration' ? { cloudflare: { apiToken: process.env.CLOUDFLARE_API_TOKEN, zoneId: process.env.CLOUDFLARE_ZONE_ID } } : {}) })}\n`,
      timeoutMs: transport.deployTimeoutMs ?? 10 * 60_000,
    },
    commandContext(adapter)
  );
  const remote = parseRemote(result.output);
  return {
    target,
    node: deployment.executionNode,
    requestedNode: node,
    current: remote.result?.activation?.current ?? null,
    previous: remote.result?.activation?.previous ?? null,
    health: remote.result?.activation?.readiness ?? null,
    recovery: remote.result?.activation?.rollback ?? null,
    nodeIngress: remote.result?.activation?.receipt?.databaseMigration?.ingress ?? null,
    durationMs: result.durationMs,
  };
}

async function updateRemoteControl(adapter, controlRoot) {
  context.stage = 'control-update';
  const transport = adapter.transport;
  const host = process.env[transport.hostEnv ?? 'AI_DELIVERY_SSH_HOST'] ?? transport.host;
  invariant(host, 'DEPLOY_SSH_HOST_MISSING', 'SSH host missing for control update');
  const agentPath = join(controlRoot, '04_tools/release-engine/remote/agent.mjs');
  const policyPath = join(controlRoot, '02_platform_pingtai/infrastructure/release/zdt-next.remote-policy.json');
  const [agent, policy] = await Promise.all([readFile(agentPath), readFile(policyPath)]);
  const agentSha256 = createHash('sha256').update(agent).digest('hex');
  const policySha256 = createHash('sha256').update(policy).digest('hex');
  progress('control-update', { controlSha: process.env.CONTROL_SHA, host });
  const script = remoteControlUpdateScript({
    agent: agent.toString('base64'),
    policy: policy.toString('base64'),
    agentSha256,
    policySha256,
  });
  const result = await runCommand(
    {
      name: 'control-update',
      argv: sshArgv(host, ['bash', '-s']),
      input: script,
      timeoutMs: 60_000,
    },
    commandContext(adapter)
  );
  return {
    state: 'HEALTHY',
    operation: 'control-update',
    controlSha: process.env.CONTROL_SHA,
    executor: executor(),
    host,
    agentSha256: `sha256:${agentSha256}`,
    policySha256: `sha256:${policySha256}`,
    output: result.output.trim(),
    durationMs: result.durationMs,
  };
}

function remoteControlUpdateScript({ agent, policy, agentSha256, policySha256 }) {
  return `set -euo pipefail
install -d -m 0755 /usr/local/lib/ai-delivery /etc/ai-delivery/projects
agent_tmp="$(mktemp --suffix=.mjs /usr/local/lib/ai-delivery/.agent.XXXXXX)"
policy_tmp="$(mktemp /etc/ai-delivery/projects/.zdt-next.XXXXXX)"
cleanup() { rm -f -- "$agent_tmp" "$policy_tmp"; }
trap cleanup EXIT
base64 -d > "$agent_tmp" <<'RUNNER_1_6_AGENT'
${agent}
RUNNER_1_6_AGENT
base64 -d > "$policy_tmp" <<'RUNNER_1_6_POLICY'
${policy}
RUNNER_1_6_POLICY
chmod 0755 "$agent_tmp"
chmod 0644 "$policy_tmp"
node --check "$agent_tmp"
node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync(process.argv[1]));if(p.schema!=="ai.delivery.remote-policy.v1"||p.project!=="zdt-next")process.exit(1)' "$policy_tmp"
[ "$(sha256sum "$agent_tmp" | cut -d' ' -f1)" = "${agentSha256}" ]
[ "$(sha256sum "$policy_tmp" | cut -d' ' -f1)" = "${policySha256}" ]
mv -f "$agent_tmp" /usr/local/lib/ai-delivery/agent.mjs
mv -f "$policy_tmp" /etc/ai-delivery/projects/zdt-next.json
trap - EXIT
printf 'CONTROL_UPDATED agent=sha256:${agentSha256} policy=sha256:${policySha256}\\n'
`;
}

async function status(adapter, sourceSha) {
  const startedAt = performance.now();
  // Status observes the physical nodes, not a plan reconstructed from source code.
  const placements = Object.keys(adapter.targets).flatMap((target) => physicalPlacements(adapter, target).map((node) => ({ target, node })));
  context.stage = 'status';
  const nodeTargets = Map.groupBy(placements, ({ node }) => node);
  progress('status', { sourceSha, total: placements.length, mode: 'one-connection-per-node', connections: nodeTargets.size });
  const observations = new Map();
  await Promise.all([...nodeTargets].map(async ([node, entries]) => {
    const remote = await remoteObserveNode(adapter, node, entries.map(({ target }) => target));
    for (const observation of remote.result?.targets ?? []) observations.set(`${node}:${observation.target}`, observation);
  }));
  const targets = placements.map(({ target, node }) => observedTarget(sourceSha, target, node, observations.get(`${node}:${target}`)));
  const currentTargets = targets.filter((target) => target.state === 'HEALTHY');
  const durationMs = Math.round(performance.now() - startedAt);
  progress('complete', { sourceSha, operation: 'status', state: 'OBSERVED', durationMs });
  return { state: 'OBSERVED', scope: 'all-configured-placements', releaseId: `r16-${sourceSha}`, sourceSha, controlSha: process.env.CONTROL_SHA, executor: executor(), durationMs, currentTargetCount: currentTargets.length, targets };
}

export function observedTarget(sourceSha, target, node, observation) {
  if (!observation) return { target, node, state: 'UNKNOWN', currentSourceSha: null, previousSourceSha: null, health: null, diagnostic: { code: 'OBSERVATION_MISSING' } };
  const currentSha = observation.status?.currentArtifact?.sourceSha ?? null;
  const previousSha = observation.status?.previousArtifact?.sourceSha ?? null;
  const health = observation.verification?.readiness ?? null;
  if (observation.error?.code === 'CURRENT_POINTER_MISSING' && !currentSha) return { target, node, state: 'EMPTY', currentSourceSha: null, previousSourceSha: previousSha, health, diagnostic: observation.error };
  if (observation.error) return { target, node, state: 'FAILED', currentSourceSha: currentSha, previousSourceSha: previousSha, health, diagnostic: observation.error };
  if (currentSha !== sourceSha) {
    return { target, node, state: previousSha === sourceSha ? 'PREVIOUS' : currentSha ? 'OTHER' : 'EMPTY', currentSourceSha: currentSha, previousSourceSha: previousSha, health };
  }
  return { target, node, state: 'HEALTHY', currentSourceSha: currentSha, previousSourceSha: previousSha, health };
}

async function rollback(adapter, controlRoot, target, node) {
  invariant(Boolean(target) && Boolean(node), 'ROLLBACK_TARGET_REQUIRED', 'rollback requires target and physical node');
  context.stage = 'rollback';
  context.target = target;
  context.node = node;
  const remote = await remoteControl(adapter, target, node, 'rollback');
  return {
    state: 'ROLLED_BACK',
    target,
    node,
    executor: executor(),
    current: remote.result?.current ?? null,
    previous: remote.result?.previous ?? null,
    serviceStatus: remote.result?.readiness ?? null,
    durationMs: remote.result?.timings?.total ?? null,
  };
}

async function remoteControl(adapter, target, node, action) {
  const deployment = resolveDeployment(adapter, node, target);
  const transport = deployment.node.transport ?? adapter.transport;
  const host = process.env[transport.hostEnv ?? 'AI_DELIVERY_SSH_HOST'] ?? transport.host;
  invariant(host, 'DEPLOY_SSH_HOST_MISSING', `SSH host missing for ${node}`);
  const result = await runCommand(
    {
      name: `${action}:${node}:${target}`,
      argv: sshArgv(host, [transport.agent ?? '/usr/local/lib/ai-delivery/agent.mjs', action, '--project', adapter.project, '--node', deployment.executionNode, '--target', target]),
      timeoutMs: transport.deployTimeoutMs ?? 10 * 60_000,
    },
    commandContext(adapter)
  );
  return parseRemote(result.output);
}

async function remoteObserveNode(adapter, node, targets) {
  invariant(targets.length > 0, 'STATUS_TARGETS_REQUIRED', `status targets missing for ${node}`);
  const deployment = resolveDeployment(adapter, node, targets[0]);
  const transport = deployment.node.transport ?? adapter.transport;
  const host = process.env[transport.hostEnv ?? 'AI_DELIVERY_SSH_HOST'] ?? transport.host;
  invariant(host, 'DEPLOY_SSH_HOST_MISSING', `SSH host missing for ${node}`);
  const result = await runCommand(
    {
      name: `observe:${node}`,
      argv: sshArgv(host, [transport.agent ?? '/usr/local/lib/ai-delivery/agent.mjs', 'observe', '--project', adapter.project, '--node', deployment.executionNode, '--targets', targets.join(',')]),
      timeoutMs: transport.deployTimeoutMs ?? 10 * 60_000,
    },
    commandContext(adapter)
  );
  return parseRemote(result.output);
}

function physicalPlacements(adapter, target) {
  return Object.entries(adapter.nodes)
    .filter(([, node]) => node.deployments?.[target] && node.deployments[target].hostedBy === undefined)
    .map(([node]) => node)
    .sort();
}

function commandContext(adapter) {
  return { projectRoot: adapter.projectRoot, environment: {}, changedFiles: [], sourceSha: '', node: '', target: '', logPath: null };
}

function parseRemote(output) {
  try {
    return JSON.parse(output);
  } catch {
    throw new DeliveryError('REMOTE_RESULT_INVALID', 'Remote command did not return JSON', { outputTail: String(output).slice(-4000) });
  }
}

function sshArgv(host, remoteArguments) {
  const argv = ['ssh', '-o', 'BatchMode=yes', '-o', `UserKnownHostsFile=${requiredEnv('ZDT_RELEASE_KNOWN_HOSTS_PATH')}`];
  if (process.env.ZDT_RELEASE_SSH_KEY_PATH) argv.push('-i', process.env.ZDT_RELEASE_SSH_KEY_PATH, '-o', 'IdentitiesOnly=yes');
  return [...argv, host, ...remoteArguments];
}

export function aggregateStatus(states) {
  if (states.includes('FAILED')) return 'FAILED';
  if (states.includes('UNKNOWN')) return 'UNKNOWN';
  if (states.includes('ROLLED_BACK')) return 'ROLLED_BACK';
  return 'HEALTHY';
}

export function observationDiagnostic(unknown) {
  const error = asDeliveryError(unknown);
  const details = error.details ?? {};
  let remoteFailure = null;
  try {
    const parsed = JSON.parse(String(details.outputTail ?? '').trim());
    if (parsed?.ok === false && parsed.error) remoteFailure = parsed.error;
  } catch {}
  return {
    code: error.code,
    error: error.message,
    command: Array.isArray(details.argv) ? details.argv.join(' ') : null,
    exitCode: details.exitCode ?? null,
    output: details.outputTail ?? null,
    remoteFailure,
  };
}

function parse(args) {
  const options = { operation: args[0] };
  for (let index = 1; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith('--') || value === undefined) throw new DeliveryError('ARGUMENT_INVALID', `Invalid argument ${name ?? ''}`);
    options[name.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  }
  return options;
}

export function sourceFromIdentifier(value) {
  if (SHA.test(value ?? '')) return value;
  return RELEASE_ID.exec(value ?? '')?.[1] ?? null;
}

function bindControlPlaneModules(adapter, controlRoot) {
  const bindCommands = (commands = []) =>
    commands.map((command) => ({
      ...command,
      argv: command.argv.map((argument) => (argument.startsWith('04_tools/release-engine/') ? join(controlRoot, argument) : argument)),
    }));
  const targets = Object.fromEntries(
    Object.entries(adapter.targets).map(([name, target]) => [
      name,
      {
        ...target,
        tests: bindCommands(target.tests),
        typecheck: bindCommands(target.typecheck),
        build: bindCommands(target.build),
      },
    ])
  );
  const impactResolvers = Object.fromEntries(
    Object.entries(adapter.impactResolvers ?? {}).map(([name, resolver]) => [
      name,
      {
        ...resolver,
        module: resolver.module.startsWith('04_tools/release-engine/') ? join(controlRoot, resolver.module) : resolver.module,
      },
    ])
  );
  return { ...adapter, targets, impactResolvers, buildPreflight: bindCommands(adapter.buildPreflight) };
}

function executor() {
  return { class: process.env.RUNNER_CLASS ?? 'unknown', name: process.env.RUNNER_NAME ?? 'unknown' };
}
function progress(stage, details = {}) {
  process.stdout.write(`RUNNER_1_6_PROGRESS=${JSON.stringify({ stage, at: new Date().toISOString(), ...details })}\n`);
}
function requiredEnv(name) {
  invariant(process.env[name], 'ENVIRONMENT_VALUE_REQUIRED', `${name} is required`);
  return process.env[name];
}
async function fileHash(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}
function nested(value, path) {
  return path.reduce((item, key) => item?.[key], value);
}
