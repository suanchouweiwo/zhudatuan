#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadAdapter, resolveDeployment } from './src/adapter.mjs';
import { buildRelease, createReleasePlan, packageRelease } from './src/build-core-1-6.mjs';
import { asDeliveryError, DeliveryError, invariant } from './src/errors.mjs';
import { exactPlacements, runExactBatch } from './src/exact-batch.mjs';
import { artifactClientFromEnvironment, artifactDownloadClientFromEnvironment } from './src/artifact-client-1-6.mjs';
import { runCommand } from './src/runner.mjs';
import { runIndependent } from './src/run-independent.mjs';
import { inspectSimpleArtifact, publishSimpleArtifacts, resolveSimpleArtifact } from './src/simple-artifact-store.mjs';

const SHA = /^[a-f0-9]{40}$/;
const RELEASE_ID = /^r16-([a-f0-9]{40})$/;
const context = { stage: 'startup', operation: null, target: null, node: null, sourceSha: null, completedTargets: [] };
const coreStartedAt = performance.now();

async function main() {
  try {
    const options = parse(process.argv.slice(2));
    context.operation = options.operation;
    const controlRoot = resolve(options.controlRoot ?? process.cwd());
    const sourceSha = sourceFromIdentifier(options.identifier ?? options.sourceSha);
    context.sourceSha = sourceSha;
    const loaded = await loadAdapter(join(controlRoot, '02_platform_pingtai/infrastructure/release/zdt-next.release.json'), controlRoot, { observationOrRecovery: ['status', 'rollback'].includes(options.operation) });
    const adapter = Object.freeze({
      ...(['status', 'rollback'].includes(options.operation) ? loaded : bindControlPlaneModules(loaded, controlRoot)),
      projectRoot: options.sourceRoot ? resolve(options.sourceRoot) : controlRoot,
      stateDirectory: resolve(process.env.RUNNER_TEMP ?? '/tmp', `zdt-runner-1-6-${process.env.GITHUB_RUN_ID ?? process.pid}`),
    });
    let result;
    if (options.operation === 'release' || options.operation === 'retry') {
      invariant(sourceSha, 'SOURCE_SHA_REQUIRED', 'release and retry require a full Source SHA or r16 release id');
      result = await release(adapter, controlRoot, sourceSha, options.target, options.node);
    } else if (options.operation === 'status') {
      invariant(!(options.identifier ?? options.sourceSha) || sourceSha, 'SOURCE_SHA_INVALID', 'status accepts an optional full Source SHA or r16 release id');
      result = await status(adapter, sourceSha);
    } else if (options.operation === 'rollback') {
      result = await rollback(adapter, controlRoot, options.target, options.node);
    } else throw new DeliveryError('OPERATION_UNKNOWN', `Unknown Runner 1.7 operation: ${options.operation}`);
    process.stdout.write(`RUNNER_1_6_RESULT=${JSON.stringify(result)}\n`);
  } catch (unknown) {
    const failure = runnerFailureReceipt(unknown, context);
    process.stderr.write(`RUNNER_1_6_RESULT=${JSON.stringify(failure)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

export function runnerFailureReceipt(unknown, context) {
  const error = asDeliveryError(unknown);
  const details = error.details ?? {};
  const remoteFailure = observationDiagnostic(error).remoteFailure;
  const evidence = remoteFailure?.details ?? details;
  return {
    state: 'FAILED',
    stage: context.stage,
    sourceSha: context.sourceSha,
    controlSha: process.env.CONTROL_SHA ?? null,
    target: context.target,
    node: context.node,
    command: Array.isArray(details.argv) ? details.argv.join(' ') : null,
    exitCode: details.exitCode ?? null,
    error: error.message,
    code: error.code,
    output: details.outputTail ?? null,
    remoteFailure,
    serviceStatus: evidence.serviceStatus ?? nested(evidence, ['candidateFailure', 'details', 'readiness']) ?? nested(evidence, ['receipt', 'readiness']) ?? null,
    current: evidence.current ?? evidence.rollback?.finalCurrent ?? evidence.pointerRecovery?.finalCurrent ?? evidence.rollbackPoint?.pointers?.current ?? null,
    previous: evidence.previous ?? evidence.rollbackPoint?.pointers?.previous ?? null,
    recovery: evidence.rollback ?? evidence.pointerRecovery ?? (remoteFailure?.code === 'ROLLBACK_FAILED' ? evidence.rollbackFailure : null),
    completedTargets: context.completedTargets,
    nextAction: evidence.nextAction ?? (context.sourceSha ? `zdt-delivery status ${context.sourceSha}` : ['release', 'retry'].includes(context.operation) ? 'Provide the original full Source SHA or release id.' : 'Inspect target status and use rollback or manual recovery if needed.'),
  };
}

async function release(adapter, controlRoot, sourceSha, target, node) {
  const exactScope = Boolean(target || node);
  invariant(!exactScope || (target && node), 'EXACT_SCOPE_INCOMPLETE', 'Fast production deployment requires both target and physical node');
  if (exactScope) {
    const placements = exactPlacements(target, node);
    if (placements.length === 1) return deployExact(adapter, controlRoot, sourceSha, placements[0].target, placements[0].node);
    return deployExactBatch(adapter, controlRoot, sourceSha, placements);
  }
  context.stage = 'plan';
  progress('plan', { sourceSha });
  const plan = await createReleasePlan(adapter, { from: `${sourceSha}^`, to: sourceSha });
  const releaseId = `r16-${sourceSha}`;
  if (!plan.deployRequired) return { state: 'NO_CHANGE', releaseId, sourceSha, executor: executor(), targets: [], message: 'No runtime target changed.' };
  const client = await artifactClientFromEnvironment();
  const cache = [];
  progress('artifact-lookup', { sourceSha, targets: plan.deploymentOrder });
  for (const target of plan.deploymentOrder) cache.push(await inspectSimpleArtifact(adapter, { target, sourceSha }, client));
  const needsBuild = cache.some((item) => !item.exists);
  let cacheStatus = 'reused';
  let preparationTimings = null;
  if (needsBuild) {
    preparationTimings = await buildAndPublish(adapter, controlRoot, plan, client, { sourceSha, targets: plan.deploymentOrder });
    cacheStatus = 'built';
  }

  const deployments = [];
  const totalPlacements = plan.deploymentOrder.reduce((count, deploymentTarget) => count + physicalPlacements(adapter, deploymentTarget).length, 0);
  const productionStarted = performance.now();
  const runtimeAgent = await syncRemoteRuntime(adapter, controlRoot);
  for (const deploymentTarget of plan.deploymentOrder) {
    for (const physicalNode of physicalPlacements(adapter, deploymentTarget)) {
      context.stage = 'deploy';
      context.target = deploymentTarget;
      context.node = physicalNode;
      progress('deploy', { sourceSha, target: deploymentTarget, node: physicalNode, completed: deployments.length, total: totalPlacements });
      const deployed = await deployTarget(adapter, client, { target: deploymentTarget, node: physicalNode, sourceSha, runtimeAgent });
      deployments.push(deployed);
    }
  }
  const coreDurationMs = Math.round(performance.now() - productionStarted);
  progress('complete', { sourceSha, coreDurationMs });
  return {
    state: deploymentState(deployments),
    releaseId,
    sourceSha,
    controlSha: process.env.CONTROL_SHA,
    executor: executor(),
    cacheStatus,
    preparationTimings,
    exactScope: false,
    coreDurationMs,
    targets: deployments,
  };
}

async function buildAndPublish(adapter, controlRoot, plan, client, details, { dependenciesReady = false } = {}) {
  let dependenciesMs = 0;
  if (plan.dependencyInstallRequired && !dependenciesReady) {
    context.stage = 'dependencies';
    progress('dependencies', details);
    dependenciesMs = await installDependencies(adapter, controlRoot, plan.deploymentOrder);
  } else {
    progress('dependencies-skipped', { ...details, reason: dependenciesReady ? 'shared-install' : 'no-commands' });
  }
  context.stage = 'build';
  progress('build', details);
  const built = await buildRelease(adapter, plan.planPath, ({ target: commandTarget, ...command }) => progress('build-command', { ...details, ...command, commandTarget }));
  progress('build-complete', { ...details, timings: built.timings });
  context.stage = 'package';
  progress('package', details);
  const packageStarted = performance.now();
  const packaged = await packageRelease(adapter, built.buildPath);
  const packageMs = Math.round(performance.now() - packageStarted);
  progress('package-complete', { ...details, durationMs: packageMs });
  context.stage = 'upload';
  progress('upload', details);
  const uploadStarted = performance.now();
  await publishSimpleArtifacts(adapter, packaged.packagePath, client);
  const uploadMs = Math.round(performance.now() - uploadStarted);
  progress('upload-complete', { ...details, durationMs: uploadMs });
  return { dependenciesMs, testsMs: built.timings.tests, typecheckMs: built.timings.typecheck, buildMs: built.timings.build, buildCoreMs: built.timings.total, packageMs, uploadMs };
}

async function installDependencies(adapter, controlRoot, targets) {
  const engineRoot = join(controlRoot, '04_tools/release-engine');
  const lockfile = await stat(join(engineRoot, 'package-lock.json')).then((value) => ({ present: true, bytes: value.size })).catch((error) => ({ present: false, error: error.code ?? error.message }));
  process.stdout.write(`RUNNER_1_6_DIAGNOSTIC=${JSON.stringify({ stage: 'dependencies', controlRoot, controlSha: process.env.CONTROL_SHA ?? null, controlLockfile: lockfile })}\n`);
  const install = { argv: ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], timeoutMs: 20 * 60_000 };
  const started = performance.now();
  const workspaces = selectedWorkspaces(adapter, targets);
  const sourceInstall = { ...install, argv: sourceInstallArguments(install.argv, workspaces) };
  const results = await runIndependent([
    () => runCommand({ ...install, name: 'install-control-dependencies' }, { ...commandContext(adapter), projectRoot: engineRoot }),
    () => runCommand({ ...sourceInstall, name: 'install-source-dependencies' }, commandContext(adapter)),
  ]);
  const durationMs = Math.round(performance.now() - started);
  process.stdout.write(`RUNNER_1_6_DIAGNOSTIC=${JSON.stringify({ stage: 'dependencies-complete', durationMs, mode: workspaces.length ? 'target-workspaces' : 'full-source', workspaces, installs: results.map(({ name, durationMs }) => ({ name, durationMs })) })}\n`);
  return durationMs;
}

export function selectedWorkspaces(adapter, targets) {
  const workspaces = targets.map((target) => adapter.targets[target]?.buildWorkspace ?? adapter.targets[target]?.workspace);
  return workspaces.every((workspace) => typeof workspace === 'string' && workspace.length > 0) ? [...new Set(workspaces)] : [];
}

export function sourceInstallArguments(base, workspaces) {
  // The console builds from its own workspace dependencies; other targets still use root build tools.
  return [...base, ...workspaces.flatMap((workspace) => ['--workspace', workspace]), ...(workspaces.some((workspace) => workspace !== '@shop/console') ? ['--include-workspace-root'] : [])];
}

async function deployExact(adapter, controlRoot, sourceSha, target, node) {
  context.stage = 'artifact-lookup';
  context.target = target;
  context.node = node;
  resolveDeployment(adapter, node, target);
  const client = await artifactClientFromEnvironment();
  progress('artifact-lookup', { sourceSha, target, node });
  const cached = await inspectSimpleArtifact(adapter, { target, sourceSha }, client);
  let cacheStatus = 'reused';
  let preparationTimings = null;
  if (!cached.exists) {
    context.stage = 'plan';
    progress('plan', { sourceSha, target, node, cacheReason: cached.reason });
    const plan = await createReleasePlan(adapter, { from: `${sourceSha}^`, to: sourceSha, target, prepare: true });
    preparationTimings = await buildAndPublish(adapter, controlRoot, plan, client, { sourceSha, target, node });
    cacheStatus = 'built';
  }
  const productionStarted = performance.now();
  const runtimeAgent = await syncRemoteRuntime(adapter, controlRoot);
  context.stage = 'deploy';
  progress('deploy', { sourceSha, target, node, completed: 0, total: 1 });
  const deployed = await deployTarget(adapter, client, { target, node, sourceSha, runtimeAgent });
  const coreDurationMs = Math.round(performance.now() - productionStarted);
  progress('complete', { sourceSha, target, node, coreDurationMs });
  return {
    state: deploymentState([deployed]),
    releaseId: `r16-${sourceSha}`,
    sourceSha,
    controlSha: process.env.CONTROL_SHA,
    executor: executor(),
    cacheStatus,
    preparationTimings,
    exactScope: true,
    coreDurationMs,
    targets: [deployed],
  };
}

async function deployExactBatch(adapter, controlRoot, sourceSha, placements) {
  for (const { target, node } of placements) resolveDeployment(adapter, node, target);
  const client = await artifactClientFromEnvironment();
  let productionStarted = 0;
  const { deployments, cacheStatus, preparationTimings } = await runExactBatch(adapter, placements, {
    inspect: async (target) => {
      context.stage = 'artifact-lookup';
      context.target = target;
      context.node = placements.find((placement) => placement.target === target)?.node ?? null;
      progress('artifact-lookup', { sourceSha, target, node: context.node });
      return inspectSimpleArtifact(adapter, { target, sourceSha }, client);
    },
    prepare: async (missingTargets) => {
      const plans = [];
      for (const target of missingTargets) {
        context.stage = 'plan';
        context.target = target;
        context.node = placements.find((placement) => placement.target === target)?.node ?? null;
        progress('plan', { sourceSha, target, node: context.node });
        plans.push({ target, plan: await createReleasePlan(adapter, { from: `${sourceSha}^`, to: sourceSha, target, prepare: true }) });
      }
      let dependenciesMs = 0;
      const sharedDependenciesReady = plans.some(({ plan }) => plan.dependencyInstallRequired);
      if (sharedDependenciesReady) {
        context.stage = 'dependencies';
        progress('dependencies', { sourceSha, targets: missingTargets });
        dependenciesMs = await installDependencies(adapter, controlRoot, missingTargets);
      }
      const targets = [];
      for (const { target, plan } of plans) {
        context.target = target;
        context.node = placements.find((placement) => placement.target === target)?.node ?? null;
        const timings = await buildAndPublish(adapter, controlRoot, plan, client, { sourceSha, target, node: context.node }, { dependenciesReady: sharedDependenciesReady });
        targets.push({ target, ...timings });
      }
      return { dependenciesMs, targets };
    },
    sync: async () => {
      productionStarted = performance.now();
      return syncRemoteRuntime(adapter, controlRoot);
    },
    deploy: async ({ target, node }, runtimeAgent, completed, total) => {
      context.stage = 'deploy';
      context.target = target;
      context.node = node;
      progress('deploy', { sourceSha, target, node, completed, total });
      const deployed = await deployTarget(adapter, client, { target, node, sourceSha, runtimeAgent });
      context.completedTargets.push(deployed);
      return deployed;
    },
  });
  const coreDurationMs = Math.round(performance.now() - productionStarted);
  progress('complete', { sourceSha, targets: deployments.map(({ target, node }) => ({ target, node })), coreDurationMs });
  return {
    state: deploymentState(deployments),
    releaseId: `r16-${sourceSha}`,
    sourceSha,
    controlSha: process.env.CONTROL_SHA,
    executor: executor(),
    cacheStatus,
    preparationTimings,
    exactScope: true,
    coreDurationMs,
    targets: deployments,
  };
}

async function deployTarget(adapter, publicClient, { target, node, sourceSha, runtimeAgent }) {
  const resolved = await resolveSimpleArtifact(adapter, { target, sourceSha }, publicClient);
  const deployment = resolveDeployment(adapter, node, target);
  const transport = deployment.node.transport ?? adapter.transport;
  const host = process.env[transport.hostEnv ?? 'AI_DELIVERY_SSH_HOST'] ?? transport.host;
  invariant(host, 'DEPLOY_SSH_HOST_MISSING', `SSH host missing for ${node}`);
  const downloadClient = artifactDownloadClientFromEnvironment(publicClient);
  const artifact = resolved.release.artifact;
  const runtimeManifest = resolved.release.runtimeManifest;
  const result = await runCommand(
    {
      name: `deploy:${node}:${target}`,
      argv: sshArgv(host, [
        runtimeAgent,
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
      ]),
      input: `${JSON.stringify({ artifactUrl: await downloadClient.signGet(artifact.object), manifestUrl: await downloadClient.signGet(runtimeManifest.object), ...(deployment.node.ingress && target === 'database-migration' ? { cloudflare: { apiToken: process.env.CLOUDFLARE_API_TOKEN, zoneId: process.env.CLOUDFLARE_ZONE_ID } } : {}) })}\n`,
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
    health: normalizeReadiness(remote.result?.activation?.readiness),
    recovery: remote.result?.activation?.rollback ?? null,
    nodeIngress: remote.result?.activation?.receipt?.databaseMigration?.ingress ?? null,
    databaseMigration: remote.result?.activation?.receipt?.databaseMigration ?? null,
    targetTimings: remote.result?.activation?.timings ?? null,
    durationMs: result.durationMs,
  };
}

export function deploymentState(targets) {
  return targets.every((target) => target.health?.status === 'ready') ? 'HEALTHY' : 'DEPLOYED';
}

function normalizeReadiness(reported) {
  return reported?.status === 'ready' && reported.attempts === 0 && Array.isArray(reported.checks) && reported.checks.length === 0
    ? { ...reported, status: 'not-checked' }
    : reported ?? null;
}

async function syncRemoteRuntime(adapter, controlRoot) {
  context.stage = 'remote-sync';
  const transport = adapter.transport;
  const host = process.env[transport.hostEnv ?? 'AI_DELIVERY_SSH_HOST'] ?? transport.host;
  invariant(host, 'DEPLOY_SSH_HOST_MISSING', 'SSH host missing for remote runtime sync');
  const agentPath = join(controlRoot, '04_tools/release-engine/remote/agent.mjs');
  const policyPath = join(controlRoot, '02_platform_pingtai/infrastructure/release/zdt-next.remote-policy.json');
  const [agent, policy] = await Promise.all([readFile(agentPath), readFile(policyPath)]);
  const agentSha256 = createHash('sha256').update(agent).digest('hex');
  const policySha256 = createHash('sha256').update(policy).digest('hex');
  progress('remote-sync', { controlSha: process.env.CONTROL_SHA, host });
  const script = remoteRuntimeSyncScript({
    agent: agent.toString('base64'),
    policy: policy.toString('base64'),
    agentSha256,
    policySha256,
  });
  const result = await runCommand(
    {
      name: 'remote-sync',
      argv: sshArgv(host, ['bash', '-s']),
      input: script,
      timeoutMs: 60_000,
    },
    commandContext(adapter)
  );
  progress('remote-sync-complete', {
    controlSha: process.env.CONTROL_SHA,
    agentSha256: `sha256:${agentSha256}`,
    policySha256: `sha256:${policySha256}`,
    durationMs: result.durationMs,
  });
  return `/usr/local/lib/ai-delivery/versions/${agentSha256}-${policySha256}/agent.mjs`;
}

export function remoteRuntimeSyncScript({ agent, policy, agentSha256, policySha256 }) {
  return `set -euo pipefail
install -d -m 0755 /usr/local/lib/ai-delivery/versions
version_dir="/usr/local/lib/ai-delivery/versions/${agentSha256}-${policySha256}"
stage_dir="$(mktemp -d /usr/local/lib/ai-delivery/versions/.stage.XXXXXX)"
agent_link="$(mktemp /usr/local/lib/ai-delivery/.agent-link.XXXXXX)"
cleanup() { rm -rf -- "$stage_dir"; rm -f -- "$agent_link"; }
trap cleanup EXIT
base64 -d > "$stage_dir/agent.mjs" <<'RUNNER_1_6_AGENT'
${agent}
RUNNER_1_6_AGENT
base64 -d > "$stage_dir/zdt-next.json" <<'RUNNER_1_6_POLICY'
${policy}
RUNNER_1_6_POLICY
chmod 0755 "$stage_dir/agent.mjs"
chmod 0644 "$stage_dir/zdt-next.json"
chmod 0755 "$stage_dir"
node --check "$stage_dir/agent.mjs"
node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync(process.argv[1]));if(p.schema!=="ai.delivery.remote-policy.v1"||p.project!=="zdt-next")process.exit(1)' "$stage_dir/zdt-next.json"
[ "$(sha256sum "$stage_dir/agent.mjs" | cut -d' ' -f1)" = "${agentSha256}" ]
[ "$(sha256sum "$stage_dir/zdt-next.json" | cut -d' ' -f1)" = "${policySha256}" ]
if [ ! -d "$version_dir" ]; then
  mv -T "$stage_dir" "$version_dir" || [ -d "$version_dir" ]
fi
[ "$(sha256sum "$version_dir/agent.mjs" | cut -d' ' -f1)" = "${agentSha256}" ]
[ "$(sha256sum "$version_dir/zdt-next.json" | cut -d' ' -f1)" = "${policySha256}" ]
rm -f -- "$agent_link"
ln -s "$version_dir/agent.mjs" "$agent_link"
mv -Tf "$agent_link" /usr/local/lib/ai-delivery/agent.mjs
cleanup
trap - EXIT
printf 'REMOTE_RUNTIME_SYNCED agent=sha256:${agentSha256} policy=sha256:${policySha256}\\n'
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
    try {
      const remote = await remoteObserveNode(adapter, node, entries.map(({ target }) => target));
      for (const observation of remote.result?.targets ?? []) observations.set(`${node}:${observation.target}`, observation);
    } catch (error) {
      for (const { target } of entries) observations.set(`${node}:${target}`, { error: observationDiagnostic(error) });
    }
  }));
  const targets = placements.map(({ target, node }) => observedTarget(sourceSha, target, node, observations.get(`${node}:${target}`)));
  const currentTargets = targets.filter((target) => ['HEALTHY', 'CURRENT'].includes(target.state));
  const durationMs = Math.round(performance.now() - startedAt);
  progress('complete', { sourceSha, operation: 'status', state: 'OBSERVED', durationMs });
  return { state: 'OBSERVED', scope: 'all-configured-placements', releaseId: sourceSha ? `r16-${sourceSha}` : null, sourceSha, controlSha: process.env.CONTROL_SHA, executor: executor(), durationMs, currentTargetCount: currentTargets.length, targets };
}

export function observedTarget(sourceSha, target, node, observation) {
  if (!observation) return { target, node, state: 'UNKNOWN', currentSourceSha: null, previousSourceSha: null, health: null, diagnostic: { code: 'OBSERVATION_MISSING' } };
  const currentSha = observation.status?.currentArtifact?.sourceSha ?? null;
  const previousSha = observation.status?.previousArtifact?.sourceSha ?? null;
  const health = normalizeReadiness(observation.verification?.readiness);
  if (observation.error?.code === 'CURRENT_POINTER_MISSING' && !currentSha) return { target, node, state: 'EMPTY', currentSourceSha: null, previousSourceSha: previousSha, health, diagnostic: observation.error };
  if (observation.error) return { target, node, state: 'FAILED', currentSourceSha: currentSha, previousSourceSha: previousSha, health, diagnostic: observation.error };
  if (!sourceSha) return { target, node, state: currentSha ? (health?.status === 'ready' ? 'HEALTHY' : 'CURRENT') : 'EMPTY', currentSourceSha: currentSha, previousSourceSha: previousSha, health };
  if (currentSha !== sourceSha) {
    return { target, node, state: previousSha === sourceSha ? 'PREVIOUS' : currentSha ? 'OTHER' : 'EMPTY', currentSourceSha: currentSha, previousSourceSha: previousSha, health };
  }
  return { target, node, state: health?.status === 'ready' ? 'HEALTHY' : 'CURRENT', currentSourceSha: currentSha, previousSourceSha: previousSha, health };
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
    serviceStatus: normalizeReadiness(remote.result?.readiness),
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
    .filter(([, node]) => node?.deployments?.[target] && node.deployments[target].hostedBy === undefined)
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

export function observationDiagnostic(unknown) {
  const error = asDeliveryError(unknown);
  const details = error.details ?? {};
  let remoteFailure = null;
  for (const line of String(details.outputTail ?? '').trim().split(/\r?\n/).reverse()) {
    try {
      const parsed = JSON.parse(line);
      if (parsed?.ok === false && parsed.error) {
        remoteFailure = parsed.error;
        break;
      }
    } catch {}
  }
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
  process.stdout.write(`RUNNER_1_6_PROGRESS=${JSON.stringify({ stage, at: new Date().toISOString(), elapsedMs: Math.round(performance.now() - coreStartedAt), ...details })}\n`);
}
function requiredEnv(name) {
  invariant(process.env[name], 'ENVIRONMENT_VALUE_REQUIRED', `${name} is required`);
  return process.env[name];
}
function nested(value, path) {
  return path.reduce((item, key) => item?.[key], value);
}
