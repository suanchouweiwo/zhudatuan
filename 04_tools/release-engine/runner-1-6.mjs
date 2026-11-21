#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { L0_TARGETS, snapshotInputsChanged, snapshotInstanceRoot, splitSnapshotChanges } from './adapters/zdt-next/instance-snapshot-impact.mjs';
import { bindInstance, loadAdapter, resolveDeployment } from './src/adapter.mjs';
import { buildRelease, createReleasePlan, packageRelease } from './src/build-core-1-6.mjs';
import { asDeliveryError, DeliveryError, invariant } from './src/errors.mjs';
import { exactPlacements, runExactBatch } from './src/exact-batch.mjs';
import { artifactClientFromEnvironment, artifactDownloadClientFromEnvironment } from './src/artifact-client-1-6.mjs';
import { changedFiles } from './src/git.mjs';
import { createPlan } from './src/planner.mjs';
import { runCommand } from './src/runner.mjs';
import { runIndependent } from './src/run-independent.mjs';
import { inspectSimpleArtifact, installedReleaseDescriptor, publishSimpleArtifacts, recoverArchivedArtifact, resolveInstalledArtifact, resolveSimpleArtifact } from './src/simple-artifact-store.mjs';
import { prettyStableJson, sha256 } from './src/stable.mjs';

const SHA = /^[a-f0-9]{40}$/;
const RELEASE_ID = /^r16-([a-f0-9]{40})$/;
const L0_NODE = 'zhudatuan-l0';
const context = { stage: 'startup', operation: null, target: null, node: null, sourceSha: null, completedTargets: [] };
const coreStartedAt = performance.now();
async function main() {
  try {
    const options = parse(process.argv.slice(2));
    context.operation = options.operation;
    const controlRoot = resolve(options.controlRoot ?? process.cwd());
    const projectRoot = options.sourceRoot ? resolve(options.sourceRoot) : controlRoot;
    const sourceSha = sourceFromIdentifier(options.identifier ?? options.sourceSha);
    context.sourceSha = sourceSha;
    const isRelease = options.operation === 'release' || options.operation === 'retry';
    const observationOrRecovery = options.operation === 'status' || options.operation === 'rollback';
    const loaded = await loadAdapter(join(controlRoot, '02_platform_pingtai/infrastructure/release/zdt-next.release.json'), controlRoot, { observationOrRecovery });
    const adapter = Object.freeze({
      ...(observationOrRecovery ? loaded : bindControlPlaneModules(loaded, controlRoot)),
      projectRoot,
      stateDirectory: resolve(process.env.RUNNER_TEMP ?? '/tmp', `zdt-runner-1-6-${process.env.GITHUB_RUN_ID ?? process.pid}`),
    });
    let result;
    if (isRelease) {
      invariant(sourceSha, 'SOURCE_SHA_REQUIRED', 'release and retry require a full Source SHA or r16 release id');
      const exactRetry = options.operation === 'retry' && Boolean(options.target && options.node);
      result = await release(adapter, controlRoot, sourceSha, options.target, options.node);
      if (!exactRetry && process.env.ZDT_SYNC_INSTANCES === 'true' && result.targets?.some((entry) => entry.node === L0_NODE)) {
        const deployment = resolveDeployment(adapter, L0_NODE, 'console');
        const transport = deployment.node.transport ?? adapter.transport;
        const host = process.env[transport.hostEnv ?? 'AI_DELIVERY_SSH_HOST'] ?? transport.host;
        const synchronized = await runCommand({
          name: 'synchronize-l0-core', argv: sshArgv(host, ['node', '--input-type=module', '-']),
          input: `import { synchronizeL0Release } from '/opt/sfl/control/node-operations/current/runtime/autonode-task-executor.mjs';\nconsole.log(JSON.stringify(await synchronizeL0Release(${JSON.stringify(sourceSha)}, ${JSON.stringify(process.env.GITHUB_RUN_ID)})));\n`,
          timeoutMs: 120000,
        }, commandContext(adapter));
        result.l0Synchronization = JSON.parse(synchronized.output.trim());
      }
    } else if (options.operation === 'status') {
      invariant(!(options.identifier ?? options.sourceSha) || sourceSha, 'SOURCE_SHA_INVALID', 'status accepts an optional full Source SHA or r16 release id');
      result = await status(adapter, controlRoot, sourceSha);
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
    ...(error.code === 'ARTIFACT_PIN_UNRESOLVED' || remoteFailure?.code === 'ARTIFACT_PIN_UNRESOLVED' ? {
      pointerAction: evidence.pointerAction ?? 'not-performed',
      reason: evidence.reason ?? 'The original artifact could not be identified for this placement.',
    } : {}),
    ...(['deploy', 'remote-sync'].includes(context.stage) && context.selectedArtifact ? { selectedArtifact: context.selectedArtifact } : {}),
    ...(context.operation === 'rollback' ? {
      requestId: context.rollbackRequestId ?? null,
      currentArtifact: observedArtifact(evidence.currentArtifact),
      previousArtifact: observedArtifact(evidence.previousArtifact),
      restart: evidence.restart ?? nested(evidence, ['rollbackFailure', 'details', 'restart']) ?? null,
      pointerAction: evidence.pointerAction ?? null,
      reason: evidence.reason ?? null,
    } : {}),
    recovery: evidence.rollback ?? evidence.pointerRecovery ?? (remoteFailure?.code === 'ROLLBACK_FAILED' ? evidence.rollbackFailure : null),
    completedTargets: context.completedTargets,
    nextAction: evidence.nextAction ?? (context.sourceSha ? `zdt-delivery status ${context.sourceSha}` : ['release', 'retry'].includes(context.operation) ? 'Provide the original full Source SHA or release id.' : 'Inspect target status and use rollback or manual recovery if needed.'),
  };
}

async function release(adapter, controlRoot, sourceSha, target, node) {
  const exactScope = Boolean(target || node);
  invariant(!exactScope || (target && node), 'EXACT_SCOPE_INCOMPLETE', 'Fast production deployment requires both target and physical node');
  const refs = { from: `${sourceSha}^`, to: sourceSha };
  if (exactScope) {
    const placements = await bindExactPlacements(adapter, refs, exactPlacements(target, node));
    if (placements.length === 1) return deployExact(adapter, controlRoot, sourceSha, placements[0]);
    return deployExactBatch(adapter, controlRoot, sourceSha, placements);
  }
  context.stage = 'plan';
  progress('plan', { sourceSha });
  let businessChanges;
  let snapshotAdapter;
  let snapshotPlacements = [];
  if (!adapter.instanceRoot) {
    const changes = await changedFiles(adapter.projectRoot, refs.from, refs.to);
    const { business, snapshot } = splitSnapshotChanges(changes);
    businessChanges = business;
    snapshotAdapter = await bindSourceSnapshot(adapter, snapshot);
    if (snapshotAdapter) {
      const snapshotPlan = await createPlan(snapshotAdapter, { ...refs, changes: snapshot });
      snapshotPlacements = plannedPhysicalPlacements(snapshotAdapter, snapshotPlan)
        .filter(({ node }) => node === L0_NODE)
        .map((placement) => ({ ...placement, artifactAdapter: snapshotAdapter }));
    }
  }

  const plan = await createReleasePlan(adapter, { ...refs, changes: businessChanges });
  const plannedPlacements = plannedPhysicalPlacements(adapter, plan).map((placement) =>
    bindSnapshotPlacement(placement, placement.node, snapshotAdapter));
  const usesExactBatch = plannedPlacements.some(({ node, target }) => node === L0_NODE && L0_TARGETS.includes(target));
  if (snapshotPlacements.length > 0) {
    const placements = new Map(plannedPlacements.map((placement) => [placementKey(placement), placement]));
    for (const placement of snapshotPlacements) placements.set(placementKey(placement), placement);
    const businessPlan = plan.deployRequired && !usesExactBatch ? plan : undefined;
    return deployExactBatch(adapter, controlRoot, sourceSha, [...placements.values()], businessPlan);
  }
  const releaseId = `r16-${sourceSha}`;
  if (!plan.deployRequired) return { state: 'NO_CHANGE', releaseId, sourceSha, executor: executor(), targets: [], message: 'No runtime target changed.' };
  if (usesExactBatch) return deployExactBatch(adapter, controlRoot, sourceSha, plannedPlacements);
  const getClient = releaseArtifactClient();
  const selections = await artifactSelections(adapter, controlRoot, sourceSha, getClient, plannedPlacements);
  const cache = new Map();
  progress('artifact-lookup', { sourceSha, targets: plan.deploymentOrder });
  for (const target of plan.deploymentOrder) {
    if (plannedPlacements.some((placement) => placement.target === target && !selections.selected(placement))) {
      cache.set(target, await inspectSimpleArtifact(adapter, { target, sourceSha }, await getClient()));
    }
  }
  const missingTargets = [...cache].filter(([, item]) => !item.exists).map(([target]) => target);
  let cacheStatus = 'reused';
  let preparationTimings = null;
  if (missingTargets.length) {
    const prepared = await buildAndPublish(adapter, controlRoot, plan, await getClient(), { sourceSha, targets: plan.deploymentOrder }, { artifactTargets: missingTargets });
    preparationTimings = prepared.timings;
    for (const artifact of prepared.artifacts) cache.set(artifact.target, { ...artifact, exists: true });
    cacheStatus = 'built';
  }

  await selections.pin((placement) => cache.get(placement.target));
  const deployments = [];
  const totalPlacements = plannedPlacements.length;
  const productionStarted = performance.now();
  for (const placement of plannedPlacements) {
    const { target, node } = placement;
    context.stage = 'deploy';
    context.target = target;
    context.node = node;
    progress('deploy', { sourceSha, target, node, completed: deployments.length, total: totalPlacements });
    const deployed = await deployTarget(adapter, getClient, {
      ...placement, sourceSha, runtimeAgentFor: selections.runtimeAgentFor, preparedArtifact: selections.selected(placement),
    });
    deployments.push(deployed);
    context.completedTargets.push(deployed);
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

async function bindSourceSnapshot(adapter, snapshotChanges) {
  if (!snapshotInputsChanged(snapshotChanges)) return null;
  const instanceRoot = await snapshotInstanceRoot(adapter.projectRoot);
  return instanceRoot ? bindInstance(adapter, instanceRoot, L0_NODE) : null;
}

function bindSnapshotPlacement(placement, executionNode, snapshotAdapter) {
  return executionNode === L0_NODE && L0_TARGETS.includes(placement.target) &&
    snapshotAdapter?.nodes[L0_NODE]?.deployments[placement.target]
    ? { ...placement, artifactAdapter: snapshotAdapter } : placement;
}

async function bindExactPlacements(adapter, refs, placements) {
  const candidates = new Map();
  for (const placement of placements) {
    const { executionNode } = resolveDeployment(adapter, placement.node, placement.target);
    const key = placementKey({ target: placement.target, node: executionNode });
    if (!candidates.has(key)) candidates.set(key, { placement, executionNode });
  }
  const exact = [...candidates.values()];
  let snapshotAdapter;
  if (!adapter.instanceRoot && exact.some(({ placement, executionNode }) => executionNode === L0_NODE && L0_TARGETS.includes(placement.target))) {
    context.stage = 'plan';
    const { snapshot } = splitSnapshotChanges(await changedFiles(adapter.projectRoot, refs.from, refs.to));
    snapshotAdapter = await bindSourceSnapshot(adapter, snapshot);
  }
  return exact.map(({ placement, executionNode }) => bindSnapshotPlacement(placement, executionNode, snapshotAdapter));
}

async function buildAndPublish(adapter, controlRoot, plan, client, details, { dependenciesReady = false, artifactTargets } = {}) {
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
  const artifacts = await publishSimpleArtifacts(adapter, packaged.packagePath, client, artifactTargets);
  const uploadMs = Math.round(performance.now() - uploadStarted);
  progress('upload-complete', { ...details, durationMs: uploadMs });
  return { artifacts, timings: { dependenciesMs, testsMs: built.timings.tests, typecheckMs: built.timings.typecheck, buildMs: built.timings.build, buildCoreMs: built.timings.total, packageMs, uploadMs } };
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

async function deployExact(adapter, controlRoot, sourceSha, placement) {
  const { target, node, artifactAdapter = adapter } = placement;
  context.stage = 'artifact-lookup';
  context.target = target;
  context.node = node;
  resolveDeployment(adapter, node, target);
  const getClient = releaseArtifactClient();
  const selections = await artifactSelections(adapter, controlRoot, sourceSha, getClient, [placement]);
  progress('artifact-lookup', { sourceSha, target, node });
  const cached = selections.selected(placement) ?? await inspectSimpleArtifact(artifactAdapter, { target, sourceSha }, await getClient());
  let preparedArtifact = cached.exists ? cached : null;
  let cacheStatus = 'reused';
  let preparationTimings = null;
  if (!cached.exists) {
    context.stage = 'plan';
    progress('plan', { sourceSha, target, node, cacheReason: cached.reason });
    const plan = await createReleasePlan(artifactAdapter, { from: `${sourceSha}^`, to: sourceSha, target, prepare: true });
    const prepared = await buildAndPublish(artifactAdapter, controlRoot, plan, await getClient(), { sourceSha, target, node });
    preparationTimings = prepared.timings;
    preparedArtifact = prepared.artifacts.find((artifact) => artifact.target === target);
    cacheStatus = 'built';
  }
  await selections.pin(() => preparedArtifact);
  const productionStarted = performance.now();
  context.stage = 'deploy';
  progress('deploy', { sourceSha, target, node, completed: 0, total: 1 });
  const deployed = await deployTarget(adapter, getClient, {
    ...placement, sourceSha, runtimeAgentFor: selections.runtimeAgentFor, preparedArtifact: selections.selected(placement),
  });
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

async function deployExactBatch(adapter, controlRoot, sourceSha, placements, businessPlan) {
  const getClient = releaseArtifactClient();
  const selections = await artifactSelections(adapter, controlRoot, sourceSha, getClient, placements);
  const variantsByTarget = new Map();
  for (const placement of placements) {
    const { target, node, artifactAdapter = adapter } = placement;
    if (selections.selected(placement)) continue;
    resolveDeployment(adapter, node, target);
    const variants = variantsByTarget.get(target) ?? new Map();
    const cacheKey = artifactAdapter.instanceCacheKey ?? '';
    if (!variants.has(cacheKey)) variants.set(cacheKey, { target, node, artifactAdapter });
    variantsByTarget.set(target, variants);
  }
  const missingVariants = new Map();
  let productionStarted = 0;
  const { deployments, cacheStatus, preparationTimings } = await runExactBatch(adapter, placements, {
    inspect: async (target) => {
      context.stage = 'artifact-lookup';
      context.target = target;
      const missing = [];
      for (const variant of variantsByTarget.get(target)?.values() ?? []) {
        context.node = variant.node;
        progress('artifact-lookup', { sourceSha, target, node: variant.node });
        const cached = await inspectSimpleArtifact(variant.artifactAdapter, { target, sourceSha }, await getClient());
        if (cached.exists) variant.preparedArtifact = cached;
        else missing.push(variant);
      }
      missingVariants.set(target, missing);
      return { exists: missing.length === 0 };
    },
    prepare: async (missingTargets) => {
      const plans = [];
      const missing = missingTargets.flatMap((target) => missingVariants.get(target));
      if (businessPlan && missing.some((variant) => variant.artifactAdapter === adapter)) {
        plans.push({ artifactAdapter: adapter, plan: businessPlan, details: { sourceSha, targets: businessPlan.deploymentOrder } });
      }
      for (const { target, node, artifactAdapter } of missing) {
        if (businessPlan && artifactAdapter === adapter) continue;
        context.stage = 'plan';
        context.target = target;
        context.node = node;
        const details = { sourceSha, target, node };
        progress('plan', details);
        const plan = await createReleasePlan(artifactAdapter, { from: `${sourceSha}^`, to: sourceSha, target, prepare: true });
        plans.push({ artifactAdapter, plan, details });
      }
      let dependenciesMs = 0;
      const sharedDependenciesReady = plans.some(({ plan }) => plan.dependencyInstallRequired);
      if (sharedDependenciesReady) {
        const targets = [...new Set(plans.flatMap(({ plan }) => plan.deploymentOrder))];
        context.stage = 'dependencies';
        progress('dependencies', { sourceSha, targets });
        dependenciesMs = await installDependencies(adapter, controlRoot, targets);
      }
      const targets = [];
      // Instance and ordinary builds can share output directories in the Source checkout.
      for (const { artifactAdapter, plan, details } of plans) {
        context.target = details.target ?? null;
        context.node = details.node ?? null;
        const artifactTargets = missing.filter((variant) => variant.artifactAdapter === artifactAdapter &&
          plan.deploymentOrder.includes(variant.target)).map(({ target }) => target);
        const { artifacts, timings } = await buildAndPublish(artifactAdapter, controlRoot, plan, await getClient(), details, { dependenciesReady: sharedDependenciesReady, artifactTargets });
        for (const artifact of artifacts) {
          variantsByTarget.get(artifact.target).get(artifactAdapter.instanceCacheKey ?? '').preparedArtifact = artifact;
        }
        const scope = details.target ? { target: details.target } : { targets: details.targets };
        targets.push({ ...scope, ...timings });
      }
      return { dependenciesMs, targets };
    },
    sync: async () => {
      await selections.pin(({ target, artifactAdapter = adapter }) =>
        variantsByTarget.get(target)?.get(artifactAdapter.instanceCacheKey ?? '')?.preparedArtifact);
      productionStarted = performance.now();
      return selections.runtimeAgentFor;
    },
    deploy: async ({ target, node, artifactAdapter = adapter }, runtimeAgentFor, completed, total) => {
      context.stage = 'deploy';
      context.target = target;
      context.node = node;
      context.selectedArtifact = null;
      progress('deploy', { sourceSha, target, node, completed, total });
      const preparedArtifact = selections.selected({ target, node });
      const deployed = await deployTarget(adapter, getClient, { target, node, sourceSha, runtimeAgentFor, artifactAdapter, preparedArtifact });
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

function deploymentAgents(adapter, controlRoot) {
  const byHost = new Map();
  return async (host, transport) => {
    if (!byHost.has(host)) byHost.set(host, syncRemoteRuntime(adapter, controlRoot, { transport }));
    return byHost.get(host);
  };
}

function releaseArtifactClient() {
  let client;
  return () => client ??= artifactClientFromEnvironment();
}

async function artifactSelections(adapter, controlRoot, sourceSha, getClient, placements) {
  const runtimeAgentFor = deploymentAgents(adapter, controlRoot);
  const readSource = memoryAgentSource(await readControlRuntime(controlRoot));
  const selected = new Map();
  const ready = new Set();
  const readOrPin = async (placement, artifact) => {
    const { target, node, artifactAdapter = adapter } = placement;
    context.stage = 'artifact-lookup';
    context.target = target;
    context.node = node;
    const deployment = resolveDeployment(adapter, node, target);
    const transport = deployment.node.transport ?? adapter.transport;
    const host = process.env[transport.hostEnv ?? 'AI_DELIVERY_SSH_HOST'] ?? transport.host;
    invariant(host, 'DEPLOY_SSH_HOST_MISSING', `SSH host missing for ${node}`);
    const pinArgs = ['artifact-pin', '--project', adapter.project, '--node', deployment.executionNode,
      '--target', target, '--source-sha', sourceSha, '--instance-key', artifactAdapter.instanceCacheKey ?? 'ordinary',
      ...(artifactAdapter.legacyInstanceCacheKey ? ['--legacy-instance-key', artifactAdapter.legacyInstanceCacheKey] : []),
      ...(target === 'storefront' && artifactAdapter.storefrontEnvironmentDigest
        ? ['--storefront-environment-digest', artifactAdapter.storefrontEnvironmentDigest,
          '--storefront-environment-file-digest', `sha256:${sha256(prettyStableJson(artifactAdapter.storefrontEnvironment ?? {}))}`] : [])];
    const resolveSelected = async (release) => {
      let localIssue;
      if (context.operation === 'retry') {
        const local = await runCommand({
          name: `artifact-local:${deployment.executionNode}:${target}`,
          argv: sshArgv(host, ['node', '--input-type=module', '-', ...pinArgs, '--local-only', 'true',
            '--sha256', release.artifact.sha256.slice(7), '--tree-digest', release.artifact.treeDigest,
            '--manifest-digest', release.runtimeManifest.manifestDigest]),
          input: readSource,
          timeoutMs: transport.deployTimeoutMs ?? 10 * 60_000,
        }, commandContext(adapter));
        const { localManifest, localDamage } = parseRemote(local.output).result ?? {};
        if (localManifest) return resolveInstalledArtifact(artifactAdapter, { target, sourceSha }, release, localManifest);
        localIssue = localDamage;
      }
      try {
        return await resolveSimpleArtifact(artifactAdapter, { target, sourceSha }, await getClient(), release);
      } catch (error) {
        if (!localIssue) throw error;
        throw new DeliveryError(error.code ?? 'ARTIFACT_STORE_UNAVAILABLE', error.message, { ...error.details, localDamage: localIssue });
      }
    };
    const launcher = artifact ? [await runtimeAgentFor(host, transport)] : ['node', '--input-type=module', '-'];
    context.stage = artifact ? 'artifact-pin' : 'artifact-lookup';
    const result = await runCommand({
      name: `artifact-pin:${deployment.executionNode}:${target}`,
      argv: sshArgv(host, [...launcher, ...pinArgs,
        ...(artifact ? ['--write', 'true'] : context.operation === 'retry' ? ['--recover', 'true'] : [])]),
      input: artifact ? JSON.stringify({ release: artifact.release,
        ...(target === 'storefront' ? { storefrontEnvironment: artifactAdapter.storefrontEnvironment } : {}),
      }) : readSource,
      timeoutMs: transport.deployTimeoutMs ?? 10 * 60_000,
    }, commandContext(adapter));
    const { pin, needsRuntimeCapture, needsPin, recoveryCandidates } = parseRemote(result.output).result ?? {};
    if (!pin && recoveryCandidates?.length) {
      for (const [index, { installedManifest, installedInstanceKey, originalDigests }] of recoveryCandidates.entries()) {
        const resolved = installedManifest
          ? await resolveSelected(installedReleaseDescriptor({ ...artifactAdapter, instanceCacheKey: installedInstanceKey }, installedManifest))
          : await recoverArchivedArtifact(artifactAdapter, { target, sourceSha }, await getClient(), originalDigests,
            { classifyOtherVariant: index + 1 < recoveryCandidates.length });
        if (!resolved) continue;
        selected.set(placementKey(placement), { ...resolved, exists: true });
        return;
      }
      throw new DeliveryError('ARTIFACT_PIN_UNRESOLVED', 'No receipt identified the original artifact for this placement and variant',
        { target, node, sourceSha, pointerAction: 'not-performed' });
    }
    if (!pin) return;
    const resolved = artifact?.release.releaseDigest === pin.release.releaseDigest
      ? artifact : await resolveSelected(pin.release);
    selected.set(placementKey(placement), { ...resolved, exists: true });
    if (!needsRuntimeCapture && !needsPin) ready.add(placementKey(placement));
  };
  for (const placement of placements) await readOrPin(placement);
  return {
    runtimeAgentFor,
    selected: (placement) => selected.get(placementKey(placement)),
    async pin(getPrepared) {
      for (const placement of placements) {
        if (ready.has(placementKey(placement))) continue;
        const { artifactAdapter = adapter, target } = placement;
        const prepared = selected.get(placementKey(placement)) ?? getPrepared(placement)
          ?? await resolveSimpleArtifact(artifactAdapter, { target, sourceSha }, await getClient());
        await readOrPin(placement, prepared);
      }
    },
  };
}

async function deployTarget(adapter, getClient, { target, node, sourceSha, runtimeAgentFor, artifactAdapter = adapter, preparedArtifact }) {
  context.selectedArtifact = null;
  const resolved = preparedArtifact ?? await resolveSimpleArtifact(artifactAdapter, { target, sourceSha }, await getClient());
  context.selectedArtifact = observedArtifact(resolved.runtimeManifest);
  const deployment = resolveDeployment(adapter, node, target);
  const transport = deployment.node.transport ?? adapter.transport;
  const host = process.env[transport.hostEnv ?? 'AI_DELIVERY_SSH_HOST'] ?? transport.host;
  invariant(host, 'DEPLOY_SSH_HOST_MISSING', `SSH host missing for ${node}`);
  const runtimeAgent = await runtimeAgentFor(host, transport);
  context.stage = 'deploy';
  const downloadClient = resolved.localOnly ? null : artifactDownloadClientFromEnvironment(await getClient());
  const artifact = resolved.release.artifact;
  const runtimeManifest = resolved.release.runtimeManifest;
  const download = resolved.localOnly ? {} : {
    artifactUrl: await downloadClient.signGet(artifact.object),
    manifestUrl: await downloadClient.signGet(runtimeManifest.object),
  };
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
        ...(resolved.localOnly ? ['--local-only', 'true'] : []),
        ...(context.operation === 'retry' ? ['--repair', 'true'] : []),
      ]),
      input: `${JSON.stringify({ ...download, ...(deployment.node.ingress && target === 'database-migration' ? { cloudflare: { apiToken: process.env.CLOUDFLARE_API_TOKEN, zoneId: process.env.CLOUDFLARE_ZONE_ID }, domainSwitch: process.env.ZDT_DOMAIN_SWITCH === 'true' } : {}) })}\n`,
      timeoutMs: transport.deployTimeoutMs ?? 10 * 60_000,
    },
    commandContext(adapter)
  );
  const remote = parseRemote(result.output);
  return {
    target,
    node: deployment.executionNode,
    requestedNode: node,
    activationMode: remote.result?.activation?.mode ?? null,
    artifactRecovery: remote.result?.staged?.cacheStatus === 'repaired' ? 'repaired-from-original' :
      resolved.localOnly ? 'reused-local' : null,
    selectedArtifact: context.selectedArtifact,
    current: remote.result?.activation?.current ?? null,
    previous: remote.result?.activation?.previous ?? null,
    currentArtifact: observedArtifact(remote.result?.activation?.currentArtifact),
    previousArtifact: observedArtifact(remote.result?.activation?.previousArtifact),
    health: normalizeReadiness(remote.result?.activation?.readiness),
    recovery: remote.result?.activation?.rollback ?? null,
    serviceStatus: remote.result?.activation?.serviceStatus ?? null,
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

async function readControlRuntime(controlRoot) {
  const agentPath = join(controlRoot, '04_tools/release-engine/remote/agent.mjs');
  const policyPath = join(controlRoot, '02_platform_pingtai/infrastructure/release/zdt-next.remote-policy.json');
  const [agent, policy] = await Promise.all([readFile(agentPath), readFile(policyPath)]);
  return {
    agent: agent.toString('base64'),
    policy: policy.toString('base64'),
    agentSha256: createHash('sha256').update(agent).digest('hex'),
    policySha256: createHash('sha256').update(policy).digest('hex'),
  };
}

async function syncRemoteRuntime(adapter, controlRoot, { transport = adapter.transport, activateDefault = true } = {}) {
  context.stage = 'remote-sync';
  const host = process.env[transport.hostEnv ?? 'AI_DELIVERY_SSH_HOST'] ?? transport.host;
  invariant(host, 'DEPLOY_SSH_HOST_MISSING', 'SSH host missing for remote runtime sync');
  const runtime = await readControlRuntime(controlRoot);
  const { agentSha256, policySha256 } = runtime;
  progress('remote-sync', { controlSha: process.env.CONTROL_SHA, host });
  const script = remoteRuntimeSyncScript({ ...runtime, activateDefault });
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

export function remoteRuntimeSyncScript({ agent, policy, agentSha256, policySha256, activateDefault = true }) {
  const defaultLink = activateDefault ? '$(mktemp /usr/local/lib/ai-delivery/.agent-link.XXXXXX)' : '';
  const beforeActivation = activateDefault ? `node --check "$stage_dir/agent.mjs"
node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync(process.argv[1]));if(p.schema!=="ai.delivery.remote-policy.v1"||p.project!=="zdt-next")process.exit(1)' "$stage_dir/zdt-next.json"
` : '';
  const switchDefault = activateDefault ? `rm -f -- "$agent_link"
ln -s "$version_dir/agent.mjs" "$agent_link"
mv -Tf "$agent_link" /usr/local/lib/ai-delivery/agent.mjs
` : '';
  return `set -euo pipefail
install -d -m 0755 /usr/local/lib/ai-delivery/versions
version_dir="/usr/local/lib/ai-delivery/versions/${agentSha256}-${policySha256}"
stage_dir="$(mktemp -d /usr/local/lib/ai-delivery/versions/.stage.XXXXXX)"
agent_link="${defaultLink}"
cleanup() { rm -rf -- "$stage_dir"; if [ -n "$agent_link" ]; then rm -f -- "$agent_link"; fi; }
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
${beforeActivation}[ "$(sha256sum "$stage_dir/agent.mjs" | cut -d' ' -f1)" = "${agentSha256}" ]
[ "$(sha256sum "$stage_dir/zdt-next.json" | cut -d' ' -f1)" = "${policySha256}" ]
if [ ! -d "$version_dir" ]; then
  mv -T "$stage_dir" "$version_dir" || [ -d "$version_dir" ]
fi
[ "$(sha256sum "$version_dir/agent.mjs" | cut -d' ' -f1)" = "${agentSha256}" ]
[ "$(sha256sum "$version_dir/zdt-next.json" | cut -d' ' -f1)" = "${policySha256}" ]
${switchDefault}cleanup
trap - EXIT
printf 'REMOTE_RUNTIME_SYNCED agent=sha256:${agentSha256} policy=sha256:${policySha256}\\n'
`;
}

async function status(adapter, controlRoot, sourceSha) {
  const startedAt = performance.now();
  // Status observes the physical nodes, not a plan reconstructed from source code.
  const placements = Object.keys(adapter.targets).flatMap((target) => physicalPlacements(adapter, target).map((node) => ({ target, node })));
  context.stage = 'status';
  const nodeTargets = Map.groupBy(placements, ({ node }) => node);
  const { agent, policy, agentSha256, policySha256 } = await readControlRuntime(controlRoot);
  const observationSource = memoryAgentSource({ agent, policy });
  progress('status', { sourceSha, total: placements.length, mode: 'one-connection-per-node', connections: nodeTargets.size });
  const observations = new Map();
  await Promise.all([...nodeTargets].map(async ([node, entries]) => {
    try {
      const remote = await remoteObserveNode(adapter, node, entries.map(({ target }) => target), observationSource);
      for (const observation of remote.result?.targets ?? []) observations.set(`${node}:${observation.target}`, observation);
    } catch (error) {
      for (const { target } of entries) observations.set(`${node}:${target}`, { error: observationDiagnostic(error) });
    }
  }));
  const targets = placements.map(({ target, node }) => observedTarget(sourceSha, target, node, observations.get(`${node}:${target}`)));
  const currentTargets = targets.filter((target) => ['HEALTHY', 'CURRENT'].includes(target.state));
  const cloudflare = process.env.ZDT_CLOUDFLARE_DOMAIN?.trim() ? await observeCloudflareDomain() : undefined;
  const durationMs = Math.round(performance.now() - startedAt);
  progress('complete', { sourceSha, operation: 'status', state: 'OBSERVED', durationMs });
  return { state: 'OBSERVED', scope: 'all-configured-placements', releaseId: sourceSha ? `r16-${sourceSha}` : null, sourceSha, controlSha: process.env.CONTROL_SHA, remoteAgentSha256: `sha256:${agentSha256}`, remotePolicySha256: `sha256:${policySha256}`, executor: executor(), durationMs, currentTargetCount: currentTargets.length, targets, cloudflare };
}

function memoryAgentSource({ agent, policy }) {
  const moduleUrl = `data:text/javascript;base64,${agent}#${policy}`;
  return `await import(${JSON.stringify(moduleUrl)});\n`;
}

async function observeCloudflareDomain() {
  const domain = process.env.ZDT_CLOUDFLARE_DOMAIN.trim();
  const actualZone = process.env.ZDT_CLOUDFLARE_ZONE?.trim();
  const configuredZone = process.env.CLOUDFLARE_ZONE_ID?.trim();
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (!token) return { domain, credentialPresent: false };
  const request = async (path, summarize) => {
    try {
      const response = await fetch(`https://api.cloudflare.com/client/v4/${path}`, {
        headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000),
      });
      const body = await response.json();
      return { httpStatus: response.status, success: body.success, errors: body.errors,
        result: body.success ? summarize(body.result) : null };
    } catch (error) { return { networkError: error.cause?.code ?? error.code ?? error.name }; }
  };
  const zoneSummary = (zone) => ({ name: zone.name, status: zone.status });
  const [verification, lookup, configured, actual] = await Promise.all([
    request('user/tokens/verify', (value) => ({ status: value.status })),
    request(`zones?name=${encodeURIComponent(domain)}`, (zones) => zones.map(zoneSummary)),
    configuredZone ? request(`zones/${encodeURIComponent(configuredZone)}`, zoneSummary) : null,
    actualZone ? request(`zones/${encodeURIComponent(actualZone)}`, zoneSummary) : null,
  ]);
  return { domain, credentialPresent: true, configuredZoneMatchesActual: actualZone ? configuredZone === actualZone : null,
    verification, lookup, configured, actual };
}

export function observedTarget(sourceSha, target, node, observation) {
  const currentArtifact = observedArtifact(observation?.status?.currentArtifact);
  const previousArtifact = observedArtifact(observation?.status?.previousArtifact);
  const currentSourceSha = currentArtifact?.sourceSha ?? null;
  const previousSourceSha = previousArtifact?.sourceSha ?? null;
  const health = normalizeReadiness(observation?.verification?.readiness);
  const receipt = {
    target,
    node,
    current: observation?.status?.current ?? null,
    previous: observation?.status?.previous ?? null,
    runtime: observation?.status?.runtime ?? null,
    previousRuntime: observation?.status?.previousRuntime ?? null,
    process: observation?.process ?? null,
    currentSourceSha,
    previousSourceSha,
    currentArtifact,
    previousArtifact,
    health,
  };
  if (!observation) return { ...receipt, state: 'UNKNOWN', diagnostic: { code: 'OBSERVATION_MISSING' } };
  if (observation.error?.code === 'OBSERVATION_CHANGED') return { ...receipt, state: 'CHANGING', diagnostic: observation.error };
  if (['CUTOVER_INCOMPLETE', 'RUNNING_RELEASE_MISMATCH'].includes(observation.error?.code)) {
    return { ...receipt, state: 'INCOMPLETE', diagnostic: observation.error };
  }
  if (observation.error?.code === 'RUNNING_RELEASE_UNCONFIRMED') {
    return { ...receipt, state: 'UNCONFIRMED', diagnostic: observation.error };
  }
  if (observation.error?.code === 'CURRENT_POINTER_MISSING' && !currentSourceSha) return { ...receipt, state: 'EMPTY', diagnostic: observation.error };
  if (observation.error) return { ...receipt, state: 'FAILED', diagnostic: observation.error };
  if (sourceSha && currentSourceSha !== sourceSha) {
    return { ...receipt, state: previousSourceSha === sourceSha ? 'PREVIOUS' : currentSourceSha ? 'OTHER' : 'EMPTY' };
  }
  return { ...receipt, state: currentSourceSha ? (health?.status === 'ready' ? 'HEALTHY' : 'CURRENT') : 'EMPTY' };
}

function observedArtifact(manifest) {
  if (!manifest) return null;
  const entries = Array.isArray(manifest.entries) ? manifest.entries : null;
  const nodeRuntime = entries?.find(({ path, type }) => path === 'node-runtime/manifest.json' && type === 'file');
  // Older artifacts recorded the packaged runtime file without storing the instance cache key.
  const legacyVariant = nodeRuntime ? 'instance-snapshot' : entries && L0_TARGETS.includes(manifest.target) ? 'ordinary' : 'unknown';
  const variant = Object.hasOwn(manifest, 'instanceCacheKey')
    ? (manifest.instanceCacheKey ? 'instance-snapshot' : 'ordinary')
    : legacyVariant;
  return {
    sourceSha: manifest.sourceSha ?? null,
    artifactId: manifest.artifactId ?? null,
    treeDigest: manifest.treeDigest ?? null,
    manifestDigest: manifest.manifestDigest ?? null,
    archiveSha256: manifest.archive?.sha256 ?? null,
    variant,
    instanceCacheKey: manifest.instanceCacheKey ?? null,
    nodeRuntimeManifestSha256: nodeRuntime?.sha256 ?? null,
  };
}

async function rollback(adapter, controlRoot, target, node) {
  invariant(Boolean(target) && Boolean(node), 'ROLLBACK_TARGET_REQUIRED', 'rollback requires target and physical node');
  context.stage = 'rollback';
  context.target = target;
  context.node = node;
  const requestId = process.env.ZDT_DELIVERY_REQUEST_ID?.trim() ||
    (process.env.GITHUB_RUN_ID ? `gh-${process.env.GITHUB_RUN_ID}` : randomUUID());
  invariant(/^[a-zA-Z0-9._-]{1,128}$/.test(requestId), 'ROLLBACK_REQUEST_ID_INVALID', 'Invalid rollback request ID');
  context.rollbackRequestId = requestId;
  const deployment = resolveDeployment(adapter, node, target);
  const transport = deployment.node.transport ?? adapter.transport;
  const host = process.env[transport.hostEnv ?? 'AI_DELIVERY_SSH_HOST'] ?? transport.host;
  invariant(host, 'DEPLOY_SSH_HOST_MISSING', `SSH host missing for ${node}`);
  const remoteAgent = await syncRemoteRuntime(adapter, controlRoot, { transport, activateDefault: false });
  context.stage = 'rollback';
  const result = await runCommand(
    {
      name: `rollback:${node}:${target}`,
      argv: sshArgv(host, [remoteAgent, 'rollback', '--project', adapter.project, '--node', deployment.executionNode, '--target', target,
        '--request-id', requestId, ...(process.env.CONTROL_SHA ? ['--control-sha', process.env.CONTROL_SHA] : [])]),
      timeoutMs: transport.deployTimeoutMs ?? 10 * 60_000,
    },
    commandContext(adapter)
  );
  const remote = parseRemote(result.output);
  return {
    state: 'ROLLED_BACK',
    requestId,
    replayed: remote.result?.replayed ?? false,
    resumed: remote.result?.resumed ?? false,
    target,
    node,
    executionNode: deployment.executionNode,
    controlSha: remote.result?.controlSha ?? process.env.CONTROL_SHA ?? null,
    remoteAgent: remote.result?.remoteAgent ?? remoteAgent,
    executor: executor(),
    current: remote.result?.current ?? null,
    previous: remote.result?.previous ?? null,
    runtime: remote.result?.runtime ?? null,
    previousRuntime: remote.result?.previousRuntime ?? null,
    currentArtifact: observedArtifact(remote.result?.currentArtifact),
    previousArtifact: observedArtifact(remote.result?.previousArtifact),
    restart: remote.result?.restart ?? null,
    serviceStatus: normalizeReadiness(remote.result?.readiness),
    durationMs: remote.result?.timings?.total ?? null,
  };
}

async function remoteObserveNode(adapter, node, targets, observationSource) {
  invariant(targets.length > 0, 'STATUS_TARGETS_REQUIRED', `status targets missing for ${node}`);
  const deployment = resolveDeployment(adapter, node, targets[0]);
  const transport = deployment.node.transport ?? adapter.transport;
  const host = process.env[transport.hostEnv ?? 'AI_DELIVERY_SSH_HOST'] ?? transport.host;
  invariant(host, 'DEPLOY_SSH_HOST_MISSING', `SSH host missing for ${node}`);
  const result = await runCommand(
    {
      name: `observe:${node}`,
      argv: sshArgv(host, ['node', '--input-type=module', '-', 'observe', '--project', adapter.project, '--node', deployment.executionNode, '--targets', targets.join(',')]),
      input: observationSource,
      timeoutMs: transport.deployTimeoutMs ?? 10 * 60_000,
    },
    commandContext(adapter)
  );
  return parseRemote(result.output);
}

function plannedPhysicalPlacements(adapter, plan) {
  return plan.deploymentOrder.flatMap((target) => physicalPlacements(adapter, target).map((node) => ({ target, node })));
}

function placementKey({ node, target }) {
  return `${node}:${target}`;
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
  let remoteFailure = details.remoteFailure ?? null;
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
