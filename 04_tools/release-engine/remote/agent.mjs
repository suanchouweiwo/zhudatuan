#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { setDefaultAutoSelectFamily } from 'node:net';
import { setDefaultResultOrder } from 'node:dns';

import { createReadStream } from 'node:fs';
import { appendFile, chmod, chown, copyFile, cp, link, lstat, mkdir, open, readFile, readlink, readdir, realpath, rename, rm, statfs, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Deployment hosts use IPv4; avoid aborting reachable addresses during IPv6 fallback.
setDefaultAutoSelectFamily(false);
setDefaultResultOrder('ipv4first');

let actionName = 'unknown';
let loadedPolicy = null;
let loadedContext = null;
let cutoverMarker = null;
let releasePlacementTurn = null;
let rollbackPlacementFd;

const FORBIDDEN_DIRECTORIES = new Set(['.git', '.npm', '.nyc_output', '.turbo', '_cacache', 'coverage', 'logs', 'node_modules', 'playwright-report', 'releases', 'test-results', 'tmp', 'temp']);
const MAX_ARTIFACT_BYTES = 150_000_000;
const MAX_DEPENDENCY_LAYER_ARCHIVE_BYTES = 1_500_000_000;
const ROLLBACK_POINTER_NAMES = ['current', 'previous', 'runtime', 'previous-runtime'];
const RESTART_CLIENT_TIMEOUT_MS = 45_000;
const DEFAULT_READINESS = Object.freeze({
  timeoutMs: 30_000,
  intervalMs: 500,
  attemptTimeoutMs: 3_000,
  hardFailureGraceMs: 1_000,
});

try {
  const [action, ...tokens] = process.argv.slice(2);
  actionName = action ?? 'unknown';
  const options = parseOptions(tokens);
  const project = safeName(required(options.project, 'PROJECT_REQUIRED'));
  const policyBody = await readAgentPolicy(action, project, options);
  const policy = JSON.parse(policyBody.toString('utf8'));
  loadedPolicy = policy;
  const nodeKey = safeName(required(options.node, 'NODE_REQUIRED'));
  const targetId = action === 'observe' ? null : safeName(required(options.target, 'TARGET_REQUIRED'));
  const observedTargets = action === 'observe' ? required(options.targets, 'TARGETS_REQUIRED').split(',').map(safeName) : [];
  validatePolicy(policy, project, nodeKey, action === 'observe' ? [] : [targetId], action);
  const nodePolicy = policy.nodes?.[nodeKey];
  assert(nodePolicy, 'NODE_NOT_ALLOWED');
  const preparedActions = new Set(['deploy-oss-direct', 'validate-oss-candidate', 'deploy-oss-direct-v2', 'validate-oss-candidate-v2', 'validate-oss-candidate-v3']);
  const controlPlane = preparedActions.has(action) ? await preparedControlPlane(options, policyBody) : null;
  const makeContext = (targetId) => {
    const deployment = nodePolicy.deployments?.[targetId];
    assert(deployment, 'DEPLOYMENT_NOT_ALLOWED', { node: nodeKey, target: targetId });
    return { project, node: nodeKey, target: targetId, deployment, nodePolicy, policy, controlPlane };
  };
  const context = targetId ? makeContext(targetId) : null;
  loadedContext = context;
  const placementWrites = [
    'seed', 'baseline', 'stage', 'stage-direct', 'reuse', 'reuse-direct',
    'validate-oss-candidate', 'validate-oss-candidate-v2', 'validate-oss-candidate-v3',
    'deploy-oss-direct', 'deploy-oss-direct-v2', 'activate', 'activate-direct',
  ];
  if (placementWrites.includes(action)) releasePlacementTurn = await takePlacementTurn(context);

  let result;
  if (action === 'observe') {
    const targetIds = observedTargets;
    assert(targetIds.length > 0 && new Set(targetIds).size === targetIds.length, 'TARGETS_INVALID');
    result = await observeMany(targetIds, (target) => {
      validatePolicy(policy, project, nodeKey, [target], 'observe');
      return makeContext(target);
    });
  } else if (action === 'lookup') result = await lookup(context, options);
  else if (action === 'artifact-pin') result = await artifactPin(context, options);
  else if (action === 'layer-lookup') result = await dependencyLayerLookup(context, options);
  else if (action === 'stage-layer') result = await stageDependencyLayer(context, options);
  else if (action === 'reuse') result = await reuse(context, options);
  else if (action === 'reuse-direct') result = await reuse(context, options, true);
  else if (action === 'stage') result = await stage(context, options);
  else if (action === 'stage-direct') result = await stage(context, options, true);
  else if (action === 'validate-oss-candidate' || action === 'validate-oss-candidate-v2' || action === 'validate-oss-candidate-v3') result = await validateOssCandidate(context, options);
  else if (action === 'deploy-oss-direct' || action === 'deploy-oss-direct-v2') result = await deployOssDirect(context, options);
  else if (action === 'preflight') result = await preflight(context);
  else if (action === 'baseline') result = await importBaseline(context, options);
  else if (action === 'seed') result = await seed(context, options);
  else if (action === 'activate') result = await activate(context, options);
  else if (action === 'activate-direct') result = await activateDirect(context, options);
  else if (action === 'rollback') {
    const { receipt } = await rollbackRequestRecords(context, options.requestId);
    if (receipt) result = { ...receipt, replayed: true };
    else {
      releasePlacementTurn = await takePlacementTurn(context, { holdForRestart: true });
      result = await rollback(context, options);
    }
  }
  else if (action === 'verify') result = await verifyCurrent(context);
  else if (action === 'status') result = await status(context);
  else throw failure('ACTION_UNKNOWN', { action });

  if (!['status', 'observe', 'artifact-pin'].includes(action) && !(action === 'rollback' && result.replayed)) {
    try { await audit(policy, { action, ...contextSummary(context), result, completedAt: new Date().toISOString() }); }
    catch (error) { process.stderr.write(`REMOTE_AUDIT_WARNING=${JSON.stringify(errorEvidence(error))}\n`); }
  }
  process.stdout.write(`${JSON.stringify({ ok: true, action, result }, null, 2)}\n`);
} catch (error) {
  if (!['status', 'observe', 'artifact-pin'].includes(actionName) && loadedPolicy && loadedContext) {
    try {
      await audit(loadedPolicy, {
        action: actionName,
        ...contextSummary(loadedContext),
        error: { code: error.code ?? 'REMOTE_AGENT_FAILED', message: error.message, details: error.details ?? {} },
        failedAt: new Date().toISOString(),
      });
    } catch {}
  }
  process.stderr.write(`${JSON.stringify({ ok: false, error: { code: error.code ?? 'REMOTE_AGENT_FAILED', message: error.message, details: error.details ?? {} } })}\n`);
  process.exitCode = 1;
} finally {
  if (releasePlacementTurn) await releasePlacementTurn();
}

async function takePlacementTurn(context, { holdForRestart = false } = {}) {
  const root = context.deployment.pointerRoot;
  assertAllowedRoot(context.policy, root);
  const directory = join(root, 'state');
  await mkdir(directory, { recursive: true });
  const turn = join(directory, 'cutover.turn');
  if (holdForRestart) {
    const handle = await open(turn, 'a', 0o600);
    try {
      await command(['flock', '3'], { inheritedFd: handle.fd, timeoutMs: null });
    } catch (error) {
      await handle.close();
      throw error;
    }
    // The restart client inherits this same placement turn if the agent exits while dispatching.
    rollbackPlacementFd = handle.fd;
    return () => handle.close();
  }
  // Closing this pipe releases the placement turn, including when the agent exits.
  const helper = spawn('flock', [turn, 'sh', '-c', 'printf acquired; cat >/dev/null'], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const exited = new Promise((resolve) => helper.once('close', resolve));
  helper.stdin.on('error', () => {});
  try {
    await new Promise((resolve, reject) => {
      helper.stdout.once('data', resolve);
      helper.once('error', reject);
      helper.once('close', (exitCode) => reject(failure('PLACEMENT_TURN_FAILED', { exitCode })));
    });
  } catch (error) {
    helper.stdin.end();
    throw error;
  }
  return async () => {
    helper.stdin.end();
    await exited;
  };
}

async function readAgentPolicy(action, project, options) {
  const moduleUrl = new URL(import.meta.url);
  if (moduleUrl.protocol === 'data:' && (action === 'observe' || (action === 'artifact-pin' && options.write !== 'true'))) {
    return Buffer.from(moduleUrl.hash.slice(1), 'base64');
  }
  const policyRoot = process.env.AI_DELIVERY_POLICY_ROOT ?? '/etc/ai-delivery/projects';
  const bundledPolicy = join(dirname(fileURLToPath(moduleUrl)), `${project}.json`);
  return readFile(await exists(bundledPolicy) ? bundledPolicy : join(policyRoot, `${project}.json`));
}

async function seed(context, options) {
  const sourceSha = required(options.sourceSha, 'SEED_SOURCE_SHA_REQUIRED');
  assert(/^[a-f0-9]{40}$/.test(sourceSha), 'SEED_SOURCE_SHA_INVALID');
  assert(options.approval === `${context.project}:seed-layout:${sourceSha}`, 'SEED_APPROVAL_INVALID');
  const inputs = context.deployment.seedInputs;
  assert(Array.isArray(inputs) && inputs.length > 0, 'SEED_INPUTS_NOT_CONFIGURED');
  const legacyRoot = required(context.nodePolicy.legacyRoot, 'SEED_LEGACY_ROOT_NOT_CONFIGURED');
  assertAllowedRoot(context.policy, legacyRoot);
  const root = context.deployment.pointerRoot;
  assertAllowedRoot(context.policy, root);
  assert(!(await statusPointer(root, 'current')), 'CURRENT_POINTER_ALREADY_EXISTS', { root });
  const currentPath = join(root, 'current');
  const currentEntry = await lstatOrNull(currentPath);
  const unmanagedCurrent = currentEntry?.isDirectory() === true;
  assert(currentEntry === null || unmanagedCurrent, 'CURRENT_LAYOUT_INVALID', { root });
  await ensureTraversablePointerRoot(context);
  const protectedBefore = await protectedProcessSnapshot(context);
  const temporary = join(root, 'candidates', `.seed-${process.pid}-${Date.now()}`);
  try {
    if (unmanagedCurrent) {
      await cp(currentPath, temporary, { recursive: true, dereference: false, errorOnExist: true });
    } else {
      await mkdir(temporary, { recursive: true, mode: 0o755 });
      for (const input of inputs) {
        const source = resolve(legacyRoot, input.source);
        const destination = resolve(temporary, input.destination);
        assert(source.startsWith(`${resolve(legacyRoot)}/`), 'SEED_SOURCE_UNSAFE', { source });
        assert(destination.startsWith(`${resolve(temporary)}/`), 'SEED_DESTINATION_UNSAFE', { destination });
        await mkdir(dirname(destination), { recursive: true });
        await cp(source, destination, { recursive: true, dereference: false, errorOnExist: true });
      }
    }
    const evidence = await treeEvidence(temporary);
    await runChecks(context.deployment.candidateChecks ?? [], { candidateDir: temporary, currentDir: '', ...contextSummary(context) });
    const dependencyLayer = await seedDependencyLayer(context);
    const manifest = {
      schema: 'ai.delivery.artifact.v1',
      engineVersion: 1,
      artifactId: `${context.project}-${context.target}-seed-${evidence.treeDigest.slice(7, 19)}`,
      project: context.project,
      target: context.target,
      targetKind: 'seed',
      sourceSha,
      treeDigest: evidence.treeDigest,
      fileCount: evidence.fileCount,
      criticalFiles: [],
      dependencyLayer,
      seededAt: new Date().toISOString(),
    };
    manifest.manifestDigest = digest(manifest);
    await writeFile(join(temporary, 'AI_DELIVERY_ARTIFACT.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o444 });
    const release = join(root, 'releases', `seed-${evidence.treeDigest.slice(7)}`);
    await mkdir(dirname(release), { recursive: true });
    if (!(await exists(release))) await rename(temporary, release);
    await chmod(release, 0o755);
    const displacedCurrent = unmanagedCurrent ? join(root, 'candidates', `.unmanaged-current-${process.pid}-${Date.now()}`) : null;
    if (displacedCurrent) await rename(currentPath, displacedCurrent);
    try {
      await atomicPointer(currentPath, release);
    } catch (error) {
      if (displacedCurrent) {
        await rm(currentPath, { recursive: true, force: true });
        await rename(displacedCurrent, currentPath);
      }
      throw error;
    }
    if (displacedCurrent) await rm(displacedCurrent, { recursive: true, force: true });
    if (dependencyLayer) await atomicPointer(join(root, 'runtime'), dependencyLayer.path);
    await assertProtectedUnchanged(context, protectedBefore);
    return { seeded: true, current: release, runtime: dependencyLayer?.path ?? null, sourceSha, treeDigest: evidence.treeDigest };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function importBaseline(context, options) {
  assert(context.deployment.allowBaselineImport === true, 'BASELINE_IMPORT_NOT_ALLOWED');
  const sourceSha = required(options.sourceSha, 'BASELINE_SOURCE_SHA_REQUIRED');
  assert(/^[a-f0-9]{40}$/.test(sourceSha), 'BASELINE_SOURCE_SHA_INVALID');
  assert(options.approval === `${context.project}:baseline:${sourceSha}`, 'BASELINE_APPROVAL_INVALID');
  const root = context.deployment.pointerRoot;
  assertAllowedRoot(context.policy, root);
  assert(!(await lstatOrNull(join(root, 'current'))), 'BASELINE_CURRENT_ALREADY_EXISTS', { root });
  const candidate = await pointer(root, 'candidate');
  assert(candidate, 'BASELINE_CANDIDATE_MISSING');
  const manifest = JSON.parse(await readFile(join(candidate, 'AI_DELIVERY_ARTIFACT.json'), 'utf8'));
  assert(manifest.project === context.project && manifest.target === context.target && manifest.sourceSha === sourceSha, 'BASELINE_CANDIDATE_IDENTITY_MISMATCH');
  await runChecks(context.deployment.candidateChecks ?? [], { candidateDir: candidate, currentDir: '', ...contextSummary(context) });
  const protectedBefore = await protectedProcessSnapshot(context);
  await ensureTraversablePointerRoot(context);
  await atomicPointer(join(root, 'current'), candidate);
  const protectedAfter = await assertProtectedUnchanged(context, protectedBefore);
  return { imported: true, current: candidate, sourceSha, treeDigest: manifest.treeDigest, protectedProcesses: { before: protectedBefore, after: protectedAfter } };
}

async function seedDependencyLayer(context) {
  const definition = context.deployment.seedDependencyLayer;
  if (!definition) return null;
  const productionRoot = required(definition.productionRoot, 'SEED_LAYER_ROOT_REQUIRED');
  assert((context.policy.allowedDependencyRoots ?? []).includes(productionRoot), 'DEPENDENCY_LAYER_ROOT_NOT_ALLOWED', { productionRoot });
  const legacyRoot = resolve(context.nodePolicy.legacyRoot);
  const keyFiles = [];
  for (const relative of definition.keyFiles ?? []) {
    assert(safeRelative(relative), 'SEED_LAYER_KEY_UNSAFE', { relative });
    const absolute = resolve(legacyRoot, relative);
    assert(absolute.startsWith(`${legacyRoot}/`), 'SEED_LAYER_KEY_UNSAFE', { relative });
    const stats = await lstat(absolute);
    assert(stats.isFile(), 'SEED_LAYER_KEY_INVALID', { relative });
    keyFiles.push({ path: relative, bytes: stats.size, sha256: `sha256:${await hashFile(absolute)}` });
  }
  const layerDigest = digest({ runtime: definition.runtime, keyFiles });
  const destination = join(productionRoot, layerDigest.slice(7));
  if (!(await exists(destination))) {
    const source = resolve(legacyRoot, required(definition.source, 'SEED_LAYER_SOURCE_REQUIRED'));
    assert(source.startsWith(`${legacyRoot}/`), 'SEED_LAYER_SOURCE_UNSAFE', { source });
    const temporary = join(productionRoot, `.seed-${layerDigest.slice(7)}-${process.pid}`);
    await mkdir(temporary, { recursive: true, mode: 0o755 });
    try {
      await cloneTree(source, join(temporary, 'node_modules'));
      await writeFile(
        join(temporary, 'AI_DELIVERY_LAYER.json'),
        `${JSON.stringify(
          {
            schema: 'ai.delivery.dependency-layer.v1',
            project: context.project,
            digest: layerDigest,
            runtime: definition.runtime,
            keyFiles,
            seededFrom: source,
            createdAt: new Date().toISOString(),
          },
          null,
          2
        )}\n`,
        { mode: 0o444 }
      );
      await mkdir(productionRoot, { recursive: true });
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  const manifest = JSON.parse(await readFile(join(destination, 'AI_DELIVERY_LAYER.json'), 'utf8'));
  assert(manifest.digest === layerDigest && manifest.runtime === definition.runtime, 'SEED_LAYER_EXISTING_MISMATCH', { destination });
  return { strategy: 'shared-content-addressed', runtime: definition.runtime, digest: layerDigest, keyFiles, productionRoot, path: destination };
}

async function cloneTree(source, destination) {
  const stats = await lstat(source);
  if (stats.isDirectory()) {
    await mkdir(destination, { recursive: true, mode: stats.mode & 0o777 });
    for (const name of await readdir(source)) await cloneTree(join(source, name), join(destination, name));
    return;
  }
  if (stats.isSymbolicLink()) {
    await symlink(await readlink(source), destination);
    return;
  }
  assert(stats.isFile(), 'SEED_LAYER_ENTRY_INVALID', { source });
  try {
    await link(source, destination);
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error;
    await copyFile(source, destination);
  }
}

async function stage(context, options, direct = false, repair = false) {
  const started = Date.now();
  const timings = { validation: 0, materialize: 0, candidateChecks: 0, pointer: 0, cleanup: 0 };
  const validationStarted = Date.now();
  const archive = required(options.archive, 'ARCHIVE_REQUIRED');
  const manifestPath = required(options.manifest, 'MANIFEST_REQUIRED');
  assertIncomingPath(context.policy, archive);
  assertIncomingPath(context.policy, manifestPath);
  const archiveStats = await lstat(archive);
  assert(archiveStats.isFile() && archiveStats.size <= MAX_ARTIFACT_BYTES, 'ARTIFACT_ARCHIVE_SIZE_INVALID', { bytes: archiveStats.size, limitBytes: MAX_ARTIFACT_BYTES });
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert(manifest.schema === 'ai.delivery.artifact.v1', 'ARTIFACT_MANIFEST_SCHEMA_INVALID');
  assert(manifest.engineVersion === 2, 'ARTIFACT_ENGINE_VERSION_INVALID');
  assert(manifest.project === context.project && manifest.target === context.target, 'ARTIFACT_SCOPE_MISMATCH');
  assert(/^[a-f0-9]{40}$/.test(manifest.sourceSha), 'ARTIFACT_SOURCE_SHA_INVALID');
  assert(/^sha256:[a-f0-9]{64}$/.test(manifest.treeDigest), 'ARTIFACT_TREE_DIGEST_INVALID');
  assert(/^sha256:[a-f0-9]{64}$/.test(manifest.manifestDigest), 'ARTIFACT_MANIFEST_DIGEST_INVALID');
  assert(/^sha256:[a-f0-9]{64}$/.test(manifest.archive?.sha256), 'ARTIFACT_ARCHIVE_DIGEST_INVALID');
  assert(manifest.totalBytes <= MAX_ARTIFACT_BYTES, 'ARTIFACT_SIZE_INVALID', { archiveBytes: archiveStats.size, totalBytes: manifest.totalBytes, limitBytes: MAX_ARTIFACT_BYTES });
  assert(/^[a-f0-9]{64}$/.test(options.sha256), 'ARTIFACT_DECLARED_HASH_INVALID');
  assert(manifest.archive?.sha256 === `sha256:${await hashFile(archive)}`, 'ARTIFACT_ARCHIVE_HASH_MISMATCH');
  assert(manifest.archive?.bytes === archiveStats.size, 'ARTIFACT_ARCHIVE_BYTES_MISMATCH', { expected: manifest.archive?.bytes, actual: archiveStats.size });
  assert(options.sha256 === manifest.archive.sha256.slice(7), 'ARTIFACT_DECLARED_HASH_MISMATCH');
  assert(options.treeDigest === manifest.treeDigest, 'ARTIFACT_DECLARED_TREE_MISMATCH');
  if (options.sourceSha) assert(options.sourceSha === manifest.sourceSha, 'ARTIFACT_DECLARED_SOURCE_MISMATCH');
  if (options.manifestDigest) assert(options.manifestDigest === manifest.manifestDigest, 'ARTIFACT_DECLARED_MANIFEST_MISMATCH');
  assertManifestEntries(manifest);
  const claimedDigest = manifest.manifestDigest;
  const unsigned = { ...manifest };
  delete unsigned.manifestDigest;
  delete unsigned.manifestPath;
  assert(claimedDigest === digest(unsigned), 'ARTIFACT_MANIFEST_DIGEST_MISMATCH');
  const dependencyLayer = await verifyDependencyLayer(context, manifest.dependencyLayer);
  timings.validation = Date.now() - validationStarted;

  const root = context.deployment.pointerRoot;
  assertAllowedRoot(context.policy, root);
  await ensureTraversablePointerRoot(context);
  const releases = join(root, 'releases');
  const candidates = join(root, 'candidates');
  const identity = artifactIdentity(context, { ...options, sourceSha: manifest.sourceSha, manifestDigest: claimedDigest });
  const originalPath = releasePath(context, identity);
  const release = repair ? `${originalPath}.repair-${randomBytes(8).toString('hex')}` : originalPath;
  await mkdir(releases, { recursive: true, mode: 0o755 });
  await mkdir(candidates, { recursive: true, mode: 0o700 });
  const materializeStarted = Date.now();
  if (!(await exists(release))) {
    const temporary = join(candidates, `.extract-${process.pid}-${Date.now()}`);
    await mkdir(temporary, { recursive: true, mode: 0o755 });
    try {
      await verifyArchiveEntries(archive);
      await command(['tar', '-xzf', archive, '-C', temporary], { timeoutMs: 600_000 });
      const evidence = await treeEvidence(temporary);
      assert(evidence.treeDigest === manifest.treeDigest, 'ARTIFACT_TREE_HASH_MISMATCH', evidence);
      assertTreeMatchesManifest(evidence, manifest);
      await verifyCriticalFiles(temporary, manifest.criticalFiles ?? []);
      await writeFile(join(temporary, 'AI_DELIVERY_ARTIFACT.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o444 });
      await rename(temporary, release);
      if (repair) await writeAtomicJson(repairRecordPath(context, identity), { release });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  } else {
    const evidence = await treeEvidence(release, new Set(['AI_DELIVERY_ARTIFACT.json']));
    assert(evidence.treeDigest === manifest.treeDigest, 'EXISTING_RELEASE_TREE_MISMATCH', evidence);
    assertTreeMatchesManifest(evidence, manifest);
  }
  timings.materialize = Date.now() - materializeStarted;
  const checksStarted = Date.now();
  if (!direct) await runChecks(context.deployment.candidateChecks ?? [], { candidateDir: release, currentDir: (await pointer(context.deployment.pointerRoot, 'current')) ?? '', ...contextSummary(context) });
  timings.candidateChecks = Date.now() - checksStarted;
  const pointerStarted = Date.now();
  await atomicPointer(join(root, 'candidate'), release);
  timings.pointer = Date.now() - pointerStarted;
  const cleanupStarted = Date.now();
  await Promise.all([rm(archive, { force: true }), rm(manifestPath, { force: true })]);
  timings.cleanup = Date.now() - cleanupStarted;
  timings.total = Date.now() - started;
  return {
    release,
    candidate: release,
    sourceSha: manifest.sourceSha,
    treeDigest: manifest.treeDigest,
    dependencyLayer,
    cacheStatus: repair ? 'repaired' : 'miss',
    artifactBytes: manifest.archive.bytes,
    uploadedBytes: manifest.archive.bytes,
    reusedBytes: 0,
    timings,
  };
}

async function deployOssDirect(context, options) {
  const started = Date.now();
  const prepared = await prepareOssCandidate(context, options, true);
  const activation = await activateDirect(context, options, {
    candidate: prepared.staged.candidate, pointers: prepared.current.pointers, replacesCurrent: prepared.replacesCurrent,
  });
  return {
    ...prepared,
    schema: 'ai.delivery.oss-direct.v1',
    activation,
    timings: { ...prepared.timings, total: Date.now() - started },
  };
}

async function validateOssCandidate(context, options) {
  const prepared = await prepareOssCandidate(context, options, false);
  const { identity } = prepared;
  await claimRollbackRecord(join(acceptedCandidateDirectory(context, identity.sourceSha), `${identity.manifestDigest.slice(7)}.json`), identity);
  return prepared;
}

async function prepareOssCandidate(context, options, direct) {
  const started = Date.now();
  const root = context.deployment.pointerRoot;
  const pointers = direct ? await observePointerPair(root) : null;
  const identity = artifactIdentity(context, options);
  const localOnly = options.localOnly === 'true';
  const allowRepair = direct && options.repair === 'true';
  const found = await lookup(context, options, allowRepair);
  if (localOnly) assert(found.exists, 'ARTIFACT_REUSE_MISSING', { ...identity, release: found.release });
  const ingressPayload = context.deployment.databaseMigration?.initialize?.ingress ? await readStdinJson(!localOnly) : null;
  if (ingressPayload) {
    context.cloudflare = ingressPayload.cloudflare;
    context.domainSwitch = ingressPayload.domainSwitch === true;
  }
  let staged;
  let downloadedBytes = 0;
  let downloadMs = 0;
  if (found.exists) {
    staged = await reuse(context, options, direct, found);
  } else {
    const payload = ingressPayload ?? await readStdinJson();
    const incomingRoot = resolve(required(context.policy.incomingRoot, 'INCOMING_ROOT_REQUIRED'));
    assertAllowedRoot(context.policy, incomingRoot);
    await mkdir(incomingRoot, { recursive: true, mode: 0o700 });
    const stem = `${safeName(context.project)}--${safeName(context.node)}--${safeName(context.target)}--${identity.archiveSha256}.candidate-${process.pid}-${Date.now()}`;
    const archive = join(incomingRoot, `${stem}.tar.gz`);
    const manifest = join(incomingRoot, `${stem}.artifact.json`);
    const downloadStarted = Date.now();
    try {
      const manifestDownload = await downloadObject(payload.manifestUrl, manifest, 5_000_000, 'manifest');
      const artifactDownload = await downloadObject(payload.artifactUrl, archive, MAX_ARTIFACT_BYTES, 'artifact');
      downloadedBytes = manifestDownload.bytes + artifactDownload.bytes;
      downloadMs = Date.now() - downloadStarted;
      staged = await stage(context, { ...options, archive, manifest }, direct, found.damage.length > 0);
    } finally {
      await Promise.all([rm(archive, { force: true }), rm(manifest, { force: true })]);
    }
  }
  const currentAfter = await pointer(root, 'current');
  assert(currentAfter === found.current && (!pointers || stableJson(pointers) === stableJson(await observePointerPair(root))),
    'CANDIDATE_VALIDATION_MOVED_CURRENT', { before: found.current, after: currentAfter });
  const replacesCurrent = currentAfter && found.damage.some(({ release }) => release === resolve(root, currentAfter)) ? currentAfter : null;
  const currentSourceSha = replacesCurrent ? identity.sourceSha : await releaseSourceSha(context, currentAfter);
  return {
    schema: 'ai.delivery.oss-candidate.v1',
    identity,
    sourceSha: identity.sourceSha,
    artifactSha256: `sha256:${identity.archiveSha256}`,
    controlPlane: context.controlPlane,
    cacheStatus: found.exists ? found.status : staged.cacheStatus,
    downloadedBytes,
    reusedBytes: found.exists ? found.artifactBytes : 0,
    staged,
    replacesCurrent,
    current: { before: found.current, after: currentAfter, sourceSha: currentSourceSha, unchanged: true, ...(pointers ? { pointers } : {}) },
    timings: {
      artifactLookup: found.artifactLookupMs,
      download: downloadMs,
      candidate: staged.timings?.candidateChecks ?? 0,
      total: Date.now() - started,
    },
  };
}

async function releaseSourceSha(context, release) {
  if (!release) return null;
  const directory = await safeReleaseDirectory(context, release);
  const manifest = await readJson(join(directory, 'AI_DELIVERY_ARTIFACT.json'));
  if (manifest) {
    assert(manifest.schema === 'ai.delivery.artifact.v1' && [1, 2].includes(manifest.engineVersion), 'CURRENT_RELEASE_MANIFEST_INVALID', { release: directory });
    assert(manifest.project === context.project && manifest.target === context.target, 'CURRENT_RELEASE_SCOPE_MISMATCH', { release: directory });
    assert(/^[a-f0-9]{40}$/.test(manifest.sourceSha ?? ''), 'CURRENT_RELEASE_SOURCE_SHA_INVALID', { release: directory });
    const claimedDigest = manifest.manifestDigest;
    const unsigned = { ...manifest };
    delete unsigned.manifestDigest;
    assert(claimedDigest === digest(unsigned), 'CURRENT_RELEASE_MANIFEST_DIGEST_MISMATCH', { release: directory });
    const evidence = await treeEvidence(directory, new Set(['AI_DELIVERY_ARTIFACT.json']));
    if (manifest.engineVersion === 2) {
      assertManifestEntries(manifest);
      assertCurrentTreeMatchesManifest(evidence, manifest, directory);
      await verifyCriticalFiles(directory, manifest.criticalFiles ?? []);
    } else assert(evidence.treeDigest === manifest.treeDigest, 'CURRENT_RELEASE_TREE_MISMATCH', { release: directory });
    return manifest.sourceSha;
  }
  const baseline = await readJson(baselineEvidencePath(context, directory));
  if (!baseline) return null;
  return (await verifyBaselineEvidence(context, directory, baseline)).sourceSha;
}

async function safeReleaseDirectory(context, release) {
  assert(typeof release === 'string' && release.length > 0, 'CURRENT_RELEASE_PATH_INVALID');
  const releasesRoot = await realpath(join(context.deployment.pointerRoot, 'releases'));
  const directory = await realpath(resolve(context.deployment.pointerRoot, release));
  assert(directory.startsWith(`${releasesRoot}/`), 'CURRENT_RELEASE_PATH_UNSAFE', { release, releasesRoot });
  assert((await lstat(directory)).isDirectory(), 'CURRENT_RELEASE_DIRECTORY_INVALID', { release: directory });
  return directory;
}

function baselineEvidencePath(context, release) {
  const key = digest({ project: context.project, node: context.node, target: context.target, release }).slice(7);
  return join(context.deployment.pointerRoot, 'baselines', `${key}.json`);
}

async function verifyBaselineEvidence(context, release, baseline) {
  assert(baseline?.schema === 'ai.delivery.current-baseline.v1', 'CURRENT_BASELINE_SCHEMA_INVALID', { release });
  const claimedDigest = baseline.baselineDigest;
  const unsigned = { ...baseline };
  delete unsigned.baselineDigest;
  assert(claimedDigest === digest(unsigned), 'CURRENT_BASELINE_DIGEST_MISMATCH', { release });
  assert(baseline.project === context.project && baseline.node === context.node && baseline.target === context.target, 'CURRENT_BASELINE_SCOPE_MISMATCH', { release });
  assert(baseline.release === release, 'CURRENT_BASELINE_RELEASE_MISMATCH', { expected: release, actual: baseline.release });
  assert(/^[a-f0-9]{40}$/.test(baseline.sourceSha ?? '') && /^sha256:[a-f0-9]{64}$/.test(baseline.artifactSha256 ?? ''), 'CURRENT_BASELINE_IDENTITY_INVALID', { release });
  const evidence = await treeEvidence(release);
  assert(baseline.treeDigest === evidence.treeDigest && baseline.fileCount === evidence.fileCount && baseline.entryCount === evidence.entryCount && baseline.totalBytes === evidence.totalBytes, 'CURRENT_BASELINE_TREE_MISMATCH', {
    release,
    expected: baseline.treeDigest,
    actual: evidence.treeDigest,
  });
  return baseline;
}

async function readStdinJson(requireDownloadUrls = true) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    assert(bytes <= 64 * 1024, 'OSS_DOWNLOAD_PAYLOAD_TOO_LARGE');
    chunks.push(chunk);
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw failure('OSS_DOWNLOAD_PAYLOAD_INVALID');
  }
  if (requireDownloadUrls) {
    assert(typeof payload.artifactUrl === 'string' && typeof payload.manifestUrl === 'string', 'OSS_DOWNLOAD_URL_REQUIRED');
  }
  return payload;
}

async function downloadObject(url, destination, maximumBytes, kind) {
  let response;
  try {
    response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(120_000) });
  } catch (error) {
    throw failure('OSS_DOWNLOAD_FAILED', { kind, cause: error?.cause?.code ?? error?.name ?? 'FETCH_FAILED' });
  }
  assert(response.ok, 'OSS_DOWNLOAD_FAILED', { kind, status: response.status });
  const declaredBytes = Number(response.headers.get('content-length') ?? '0');
  assert(Number.isFinite(declaredBytes) && declaredBytes <= maximumBytes, 'OSS_DOWNLOAD_SIZE_INVALID', { kind, declaredBytes, maximumBytes });
  const body = Buffer.from(await response.arrayBuffer());
  assert(body.byteLength <= maximumBytes, 'OSS_DOWNLOAD_SIZE_INVALID', { kind, bytes: body.byteLength, maximumBytes });
  await writeFile(destination, body, { flag: 'wx', mode: 0o600 });
  return { bytes: body.byteLength };
}

async function verifyArchiveEntries(archive) {
  const listing = await command(['tar', '-tzf', archive], { timeoutMs: 60_000 });
  for (const entry of listing.stdout.split('\n').filter(Boolean)) {
    const normalized = entry.replace(/^\.\//, '');
    assert(!normalized.startsWith('/') && !normalized.split('/').includes('..'), 'ARTIFACT_ARCHIVE_PATH_UNSAFE', { entry });
    if (normalized) assertArtifactPath(normalized);
  }
}

async function lookup(context, options, allowRepair = false) {
  const started = Date.now();
  const identity = artifactIdentity(context, options);
  const pointers = await placementReleasePointers(context.deployment.pointerRoot);
  const [current, , candidate] = pointers;
  const stored = await locateStoredRelease(context, identity, pointers);
  const { release, manifest, damage } = stored;
  if (!manifest) {
    if (damage.length && !allowRepair) throw damage[0].error;
    return { status: damage.length ? 'damaged' : 'miss', exists: false, release, candidate, current, damage, artifactLookupMs: Date.now() - started };
  }
  const root = context.deployment.pointerRoot;
  const status = candidate && resolve(root, candidate) === release ? 'hit_candidate'
    : current && resolve(root, current) === release ? 'hit_current' : 'hit_release';
  return {
    status,
    exists: true,
    release,
    candidate,
    current,
    damage,
    sourceSha: manifest.sourceSha,
    treeDigest: manifest.treeDigest,
    artifactBytes: manifest.archive.bytes,
    uploadedBytes: 0,
    reusedBytes: manifest.archive.bytes,
    artifactLookupMs: Date.now() - started,
  };
}

async function artifactPin(context, options) {
  if (options.localOnly === 'true') {
    const identity = artifactIdentity(context, options);
    const { manifest, damage } = await locateStoredRelease(context, identity);
    return { localManifest: manifest, localDamage: damage.length ? damage.map(({ release, error }) => ({
      release, code: error.code, message: error.message,
    })) : null };
  }
  const sourceSha = required(options.sourceSha, 'LOOKUP_SOURCE_SHA_REQUIRED');
  const variant = options.instanceKey ?? 'ordinary';
  const root = context.deployment.pointerRoot;
  const pinPath = (instanceKey) => {
    const key = createHash('sha256').update(stableJson({ ...contextSummary(context), sourceSha, variant: instanceKey })).digest('hex');
    return join(root, 'state', 'artifact-pins', `${key}.json`);
  };
  const path = pinPath(variant);
  let pin = await readRollbackRecord(path);
  const write = options.write === 'true';
  if (!pin && !write && options.recover === 'true') {
    if (options.legacyInstanceKey && options.legacyInstanceKey !== variant) {
      const legacy = await readRollbackRecord(pinPath(options.legacyInstanceKey));
      if (legacy && (context.target !== 'storefront' ||
          digest(legacy.storefrontEnvironment ?? {}) === options.storefrontEnvironmentDigest)) {
        return { pin: legacy, needsPin: true };
      }
    }
    const recoveryCandidates = await recoverInstalledArtifacts(context, sourceSha, variant, options);
    if (!recoveryCandidates.length) {
      const [current, previous] = await Promise.all([pointer(root, 'current'), pointer(root, 'previous')]);
      throw failure('ARTIFACT_PIN_UNRESOLVED', { sourceSha, variant, current, previous, pointerAction: 'not-performed',
        reason: 'The original artifact could not be identified from the surviving records for this source and placement.' });
    }
    return { recoveryCandidates };
  }
  if (write) {
    const payload = await readStdinJson(false);
    const release = payload.release;
    assert(release?.project === context.project && release.target === context.target && release.sourceSha === sourceSha,
      'ARTIFACT_PIN_SCOPE_MISMATCH');
    pin ??= await claimRollbackRecord(path, { release, storefrontEnvironment: payload.storefrontEnvironment });
  }
  if (context.target === 'storefront' && variant !== 'ordinary' && Object.keys(pin?.storefrontEnvironment ?? {}).length > 0) {
    const installed = releasePath(context, {
      sourceSha,
      treeDigest: pin.release.artifact.treeDigest,
      manifestDigest: pin.release.runtimeManifest.manifestDigest,
    });
    const snapshotPath = join(nodeRuntimeRecoveryPath(context, installed), 'storefront-public.json');
    if (!(await exists(snapshotPath))) {
      if (!write) return { pin, needsRuntimeCapture: true };
      await claimRollbackRecord(snapshotPath, pin.storefrontEnvironment);
    }
  }
  return { pin };
}

async function recoverInstalledArtifacts(context, sourceSha, variant, options) {
  const candidates = [];
  for await (const original of originalDeploymentArtifacts(context, sourceSha)) {
    if (Object.hasOwn(original, 'instanceCacheKey') &&
        !matchesRetryVariant(original.instanceCacheKey ?? 'ordinary', variant, options.legacyInstanceKey)) continue;
    const candidate = await inspectOriginalArtifact(context, original, variant, options);
    if (!candidate) continue;
    candidates.push(candidate);
    const legacyStorefront = context.target === 'storefront' && variant !== 'ordinary' &&
      original.instanceCacheKey === options.legacyInstanceKey && options.legacyInstanceKey !== variant;
    if (candidate.installedManifest || (Object.hasOwn(original, 'instanceCacheKey') && !legacyStorefront)) break;
  }
  return candidates;
}

function matchesRetryVariant(key, requested, legacy) {
  return key === requested || (requested !== 'ordinary' && key === legacy);
}

async function inspectOriginalArtifact(context, original, variant, options) {
  const root = context.deployment.pointerRoot;
  const { sourceSha } = original;
  const identity = artifactIdentity(context, {
    sourceSha, treeDigest: original.treeDigest, manifestDigest: original.manifestDigest,
    sha256: original.archiveSha256.slice(7),
  });
  const storefrontSnapshot = context.target === 'storefront' && variant !== 'ordinary'
    ? await readJson(join(nodeRuntimeRecoveryPath(context, releasePath(context, identity)), 'storefront-public.json')) : null;
  const storefrontEnvironmentDigest = storefrontSnapshot && typeof storefrontSnapshot === 'object' && !Array.isArray(storefrontSnapshot)
    ? digest(storefrontSnapshot) : null;
  for await (const path of storedReleasePaths(context, identity)) {
    const manifest = await artifactForStatus(root, path);
    if (manifest?.engineVersion !== 2 || manifest.project !== context.project ||
        manifest.target !== context.target || manifest.sourceSha !== sourceSha ||
        manifest.manifestDigest !== identity.manifestDigest || manifest.treeDigest !== identity.treeDigest ||
        manifest.archive?.sha256 !== original.archiveSha256) continue;
    const { manifestDigest, ...unsigned } = manifest;
    if (digest(unsigned) !== manifestDigest) continue;
    const keyed = Object.hasOwn(manifest, 'instanceCacheKey');
    const snapshot = manifest.entries?.some((entry) => entry.path === 'node-runtime/manifest.json');
    if (!keyed && snapshot && variant === 'ordinary') return null;
    const key = keyed ? manifest.instanceCacheKey ?? 'ordinary' : snapshot ? options.legacyInstanceKey : 'ordinary';
    if (key && !matchesRetryVariant(key, variant, options.legacyInstanceKey)) return null;
    if (!key) continue;
    if (context.target === 'storefront' && key !== variant) {
      const packaged = manifest.entries?.find((entry) => entry.path === 'node-runtime/storefront-public.json');
      const recorded = packaged ? packaged.sha256 : storefrontEnvironmentDigest;
      const requested = packaged ? options.storefrontEnvironmentFileDigest : options.storefrontEnvironmentDigest;
      if (!/^sha256:[a-f0-9]{64}$/.test(recorded ?? '') || !/^sha256:[a-f0-9]{64}$/.test(requested ?? '')) continue;
      if (recorded !== requested) return null;
    }
    return { installedManifest: manifest, installedInstanceKey: key === 'ordinary' ? undefined : key };
  }
  return { originalDigests: { ...original, ...(storefrontEnvironmentDigest ? { storefrontEnvironmentDigest } : {}) } };
}

async function* originalDeploymentArtifacts(context, sourceSha) {
  const actions = ['deploy-oss-direct', 'deploy-oss-direct-v2', 'activate', 'activate-direct'];
  const manifests = new Set();
  for await (const record of placementAudit(context)) {
    if (!actions.includes(record.action)) continue;
    const artifact = record.result?.activation?.receipt?.artifact ?? record.result?.receipt?.artifact
      ?? record.error?.details?.receipt?.artifact;
    if (artifact?.sourceSha === sourceSha && /^sha256:[a-f0-9]{64}$/.test(artifact.archiveSha256 ?? '') &&
        /^sha256:[a-f0-9]{64}$/.test(artifact.treeDigest ?? '') && /^sha256:[a-f0-9]{64}$/.test(artifact.manifestDigest ?? '') &&
        !manifests.has(artifact.manifestDigest)) {
      manifests.add(artifact.manifestDigest);
      yield artifact;
    }
  }
}

async function reuse(context, options, direct = false, stored) {
  const started = Date.now();
  const found = stored ?? await lookup(context, options);
  assert(found.exists, 'ARTIFACT_REUSE_MISSING', found);
  const checksStarted = Date.now();
  if (!direct) {
    await runChecks(context.deployment.candidateChecks ?? [], {
      candidateDir: found.release,
      currentDir: found.current ?? '',
      ...contextSummary(context),
    });
  }
  const candidateChecks = Date.now() - checksStarted;
  await ensureTraversablePointerRoot(context);
  const pointerStarted = Date.now();
  if (found.status !== 'hit_candidate') await atomicPointer(join(context.deployment.pointerRoot, 'candidate'), found.release);
  const pointerMs = Date.now() - pointerStarted;
  return {
    ...found,
    status: found.status === 'hit_candidate' ? 'hit_candidate' : 'hit_release',
    candidate: found.release,
    cacheStatus: found.status,
    timings: { artifactLookup: found.artifactLookupMs, candidateChecks, pointer: pointerMs, total: Date.now() - started },
  };
}

async function activateDirect(context, options, prepared) {
  const root = context.deployment.pointerRoot;
  assertAllowedRoot(context.policy, root);
  const sourceSha = required(options.sourceSha, 'DIRECT_SOURCE_SHA_REQUIRED');
  const identity = prepared ? null : await acceptedActivationIdentity(context, options);
  const previousCurrent = prepared?.pointers ? prepared.pointers[0]?.target ?? null : await pointer(root, 'current');
  const installed = identity ? await locateStoredRelease(context, identity) : null;
  if (installed && !installed.manifest) {
    throw installed.damage[0]?.error ?? failure('ARTIFACT_REUSE_MISSING', { ...identity, release: installed.release });
  }
  const candidate = prepared?.candidate ?? installed.release;
  assert(candidate, 'CANDIDATE_MISSING');
  const manifest = installed?.manifest ?? JSON.parse(await readFile(join(candidate, 'AI_DELIVERY_ARTIFACT.json'), 'utf8'));
  assert(manifest.sourceSha === sourceSha, 'DIRECT_SOURCE_SHA_MISMATCH', { expected: sourceSha, actual: manifest.sourceSha });
  const replacesCurrent = prepared?.replacesCurrent ??
    (previousCurrent && installed?.damage.some(({ release }) => release === resolve(root, previousCurrent)) ? previousCurrent : null);
  const activated = await activate(context, {
    ...options,
    approval: `${context.project}:${sourceSha}`,
    expectedCurrent: previousCurrent ?? 'none',
  }, { ...prepared, candidate, replacesCurrent });
  return {
    ...activated,
    direct: true,
    mode: `direct-${activated.mode}`,
  };
}

function acceptedCandidateDirectory(context, sourceSha) {
  return join(context.deployment.pointerRoot, 'state', 'accepted-candidates', sourceSha);
}

async function acceptedActivationIdentity(context, options) {
  if (options.sha256 || options.treeDigest || options.manifestDigest) return artifactIdentity(context, options);

  const sourceSha = options.sourceSha;
  assert(/^[a-f0-9]{40}$/.test(sourceSha), 'LOOKUP_SOURCE_SHA_INVALID');
  const directory = acceptedCandidateDirectory(context, sourceSha);
  const names = await readdir(directory).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const accepted = new Map();
  for (const name of names.filter((name) => /^[a-f0-9]{64}\.json$/.test(name))) {
    const record = await readRollbackRecord(join(directory, name));
    if (record) accepted.set(record.manifestDigest, record);
  }
  const root = context.deployment.pointerRoot;
  for await (const audit of placementAudit(context)) {
    const result = audit.result;
    if (!['validate-oss-candidate', 'validate-oss-candidate-v2', 'validate-oss-candidate-v3'].includes(audit.action) ||
        result?.sourceSha !== sourceSha) continue;
    if (result.identity) {
      accepted.set(result.identity.manifestDigest, result.identity);
    } else if (result.staged?.candidate) {
      const manifest = await artifactForStatus(root, result.staged.candidate);
      if (manifest?.sourceSha !== sourceSha || manifest.archive?.sha256 !== result.artifactSha256 ||
          manifest.treeDigest !== result.staged.treeDigest) continue;
      const identity = artifactIdentity(context, { sourceSha, sha256: manifest.archive.sha256.slice(7),
        treeDigest: manifest.treeDigest, manifestDigest: manifest.manifestDigest });
      if (releasePath(context, identity) === resolve(root, result.staged.candidate)) accepted.set(identity.manifestDigest, identity);
    }
    if (accepted.size > 1) break;
  }
  if (accepted.size !== 1) {
    throw failure(accepted.size ? 'DIRECT_CANDIDATE_AMBIGUOUS' : 'DIRECT_CANDIDATE_NOT_RECORDED', {
      sourceSha, manifests: [...accepted.keys()],
      nextAction: 'Pass the archive, tree and manifest digests from the original candidate receipt.',
    });
  }
  const identity = accepted.values().next().value;
  return artifactIdentity(context, { sourceSha, sha256: identity.archiveSha256,
    treeDigest: identity.treeDigest, manifestDigest: identity.manifestDigest });
}

async function activate(context, options, prepared) {
  const started = Date.now();
  const timings = { candidate: 0, snapshot: 0, cutover: 0, restart: 0, health: 0, isolation: 0 };
  const root = context.deployment.pointerRoot;
  assertAllowedRoot(context.policy, root);
  const candidate = prepared?.candidate ?? await pointer(root, 'candidate');
  assert(candidate, 'CANDIDATE_MISSING');
  const manifest = JSON.parse(await readFile(join(candidate, 'AI_DELIVERY_ARTIFACT.json'), 'utf8'));
  const expectedApproval = `${context.project}:${manifest.sourceSha}`;
  assert(options.approval === expectedApproval, 'PRODUCTION_APPROVAL_INVALID', { expectedApproval });
  const candidateStarted = Date.now();
  await runChecks(context.deployment.candidateChecks ?? [], { candidateDir: candidate, currentDir: (await pointer(root, 'current')) ?? '', ...contextSummary(context) });
  const capacity = await capacityEvidence(context, manifest.archive?.bytes ?? manifest.totalBytes ?? 0);
  await chmod(candidate, 0o755);
  timings.candidate = Date.now() - candidateStarted;
  const snapshotStarted = Date.now();
  const protectedBefore = await protectedProcessSnapshot(context);
  const pointersBefore = await pointerSnapshot(root);
  const previousCurrent = await pointer(root, 'current');
  const expectedCurrent = options.expectedCurrent === 'none' ? null : required(options.expectedCurrent, 'EXPECTED_CURRENT_REQUIRED');
  assert(previousCurrent === expectedCurrent &&
    (!prepared?.pointers || stableJson(prepared.pointers) === stableJson(await observePointerPair(root))),
  'CURRENT_POINTER_CHANGED', { expected: expectedCurrent, actual: previousCurrent });
  assert(previousCurrent || context.deployment.allowFirstActivation === true, 'CURRENT_POINTER_REQUIRED_FOR_ROLLBACK', { root });
  const targetProcessBefore = await processId(context.deployment.restart);
  const previousRuntime = await pointer(root, 'runtime');
  const candidateRuntime = await dependencyLayerPath(context, manifest.dependencyLayer);
  const caddyBefore = await caddySemanticEvidence(context.policy);
  const rollbackPoint = context.deployment.databaseMigration
    ? { status: 'not-applicable', reason: 'database-migrations-are-forward-only', recovery: databaseRecoveryEvidence(context.deployment.databaseMigration), pointers: pointersBefore }
    : { status: 'pointer-based', pointers: pointersBefore };
  await ensureTraversablePointerRoot(context);
  timings.snapshot = Date.now() - snapshotStarted;
  let activationRestart = restartEvidence(context.deployment.restart, false);
  let databaseMigration = null;
  if (context.deployment.databaseMigration) {
    try {
      databaseMigration = await executeDatabaseMigration(context, candidate, manifest);
    } catch (migrationError) {
      const protectedAfter = await assertProtectedUnchanged(context, protectedBefore);
      const caddyAfter = await caddySemanticEvidence(context.policy);
      const readiness = { status: 'not-run', attempts: 0, durationMs: 0, checks: [] };
      const receipt = await deploymentReceipt(context, manifest, {
        pointersBefore,
        rollbackPoint,
        capacity,
        caddyBefore,
        caddyAfter,
        readiness,
        targetProcessBefore,
        targetProcessAfter: await processId(context.deployment.restart),
        protectedBefore,
        protectedAfter,
        databaseMigration: migrationError.details?.databaseMigration ?? null,
        finalStatus: 'failed',
      });
      throw failure('DATABASE_MIGRATION_FAILED', { cause: errorEvidence(migrationError), databaseMigration: receipt.databaseMigration, receipt });
    }
  }
  if (context.nodePolicy.deployments?.['database-migration']?.databaseMigration?.initialize
    && ['identity-api','web-api','purchase-api','storefront'].includes(context.target) && context.deployment.restart?.kind === 'systemd') {
    await command(['systemctl','enable',context.deployment.restart.name]);
  }
  const serviceBefore = await processState(context.deployment.restart);
  const replacesCurrent = Boolean(previousCurrent && prepared?.replacesCurrent === previousCurrent);
  const resumingCurrent = previousCurrent === candidate || replacesCurrent;
  const verified = previousCurrent === candidate && (serviceBefore.kind === 'none' || serviceBefore.activeState === 'active')
    ? await verifyInstalledCandidate(context, candidate) : null;
  if (verified) {
    const { readiness, releases } = verified;
    timings.health = readiness.durationMs;
    const isolationStarted = Date.now();
    const protectedAfter = await assertProtectedUnchanged(context, protectedBefore);
    const caddyAfter = await caddySemanticEvidence(context.policy);
    timings.isolation = Date.now() - isolationStarted;
    timings.total = Date.now() - started;
    return {
      mode: 'verify-only',
      alreadyCurrent: true,
      ...releases,
      runtime: await pointer(root, 'runtime'),
      service: context.deployment.restart,
      serviceStatus: await processState(context.deployment.restart),
      restart: activationRestart,
      readiness,
      targetProcess: { before: targetProcessBefore, after: await processId(context.deployment.restart) },
      cutoverMs: timings.health + timings.isolation,
      timings,
      protectedProcesses: { before: protectedBefore, after: protectedAfter },
      receipt: await deploymentReceipt(context, manifest, {
        pointersBefore,
        rollbackPoint,
        capacity,
        caddyBefore,
        caddyAfter,
        readiness,
        targetProcessBefore,
        targetProcessAfter: await processId(context.deployment.restart),
        protectedBefore,
        protectedAfter,
        databaseMigration,
        finalStatus: 'success',
      }),
    };
  }
  let readiness;
  let activatedReleases;
  let protectedAfter = null;
  let nodeRuntimeRecovery = null;
  if (prepared?.pointers && stableJson(prepared.pointers) !== stableJson(await observePointerPair(root))) {
    throw failure('CURRENT_POINTER_CHANGED', { expected: expectedCurrent, current: await pointer(root, 'current') });
  }
  await markCutover(root);
  try {
    const cutoverStarted = Date.now();
    const runtimeTransition = resumingCurrent ? null : await captureRuntimeTransition(context, previousCurrent, candidate);
    const previousSnapshot = resumingCurrent && await readNodeRuntimeManifest(pointersBefore.previous);
    nodeRuntimeRecovery = runtimeTransition?.outgoing ?? null;
    if (previousCurrent && !resumingCurrent) {
      await atomicPointer(join(root, 'previous'), previousCurrent);
      await restoreOptionalPointer(join(root, 'previous-runtime'), previousRuntime);
    }
    if (candidateRuntime || runtimeTransition || previousSnapshot || (resumingCurrent && await readNodeRuntimeManifest(candidate))) {
      await restoreOptionalPointer(join(root, 'runtime'), candidateRuntime);
    }
    await atomicPointer(join(root, 'current'), candidate);
    if (!(await installNodeRuntime(context, candidate))) {
      if (previousSnapshot) {
        if (!(await restoreNodeRuntime(installedNodeRuntimePath(context, candidate)))) {
          await restoreOrdinaryRuntime(context, pointersBefore.previous, { fromSnapshot: true }, null);
        }
      } else {
        await restoreOrdinaryRuntime(context, previousCurrent, runtimeTransition, pointersBefore.previous);
      }
    }
    timings.cutover = Date.now() - cutoverStarted;
    const processBeforeRestart = await cutoverProcess(context);
    const processBefore = processBeforeRestart?.process ?? await observeProcess(context);
    const restartStarted = Date.now();
    activationRestart = await restart(context.deployment.restart);
    timings.restart = Date.now() - restartStarted;
    readiness = await waitForReadiness(context, { candidateDir: candidate, currentDir: candidate, ...contextSummary(context) });
    timings.health = readiness.durationMs;
    const running = await verifyCutoverProcess(context, candidate, processBefore);
    const isolationStarted = Date.now();
    protectedAfter = await assertProtectedUnchanged(context, protectedBefore);
    timings.isolation = Date.now() - isolationStarted;
    const caddyAfter = await caddySemanticEvidence(context.policy);
    const previous = previousCurrent && !resumingCurrent ? previousCurrent : pointersBefore.previous;
    const pointers = await observePointerPair(root);
    activatedReleases = await releasePointersForStatus(root, pointers.map((entry) => entry?.target ?? null));
    assert(activatedReleases.current === candidate && activatedReleases.previous === previous &&
      (!processBeforeRestart || stableJson(pointers) === stableJson(processBeforeRestart.pointers)),
    'CUTOVER_SUPERSEDED', { candidate, ...activatedReleases });
    await recordConfirmedCutover(root, { pointers, process: running, confirmedAt: Date.now() });
  } catch (candidateError) {
    const currentAtFailure = await pointer(root, 'current');
    if (candidateError.code === 'CUTOVER_SUPERSEDED' || (currentAtFailure !== candidate && currentAtFailure !== previousCurrent)) {
      throw failure('CUTOVER_SUPERSEDED', {
        candidate,
        current: currentAtFailure,
        previousCurrent,
        candidateFailure: errorEvidence(candidateError),
        recovery: 'not-performed-because-a-newer-cutover-owns-current',
      });
    }
    if (resumingCurrent && !databaseMigration) {
      const releases = await releasePointersForStatus(root);
      throw failure('CUTOVER_RESUME_FAILED', { ...releases, candidateFailure: errorEvidence(candidateError) });
    }
    if (databaseMigration) {
      let pointerRecovery = { status: 'restored', error: null };
      try {
        await restoreOptionalPointer(join(root, 'current'), pointersBefore.current);
        await restoreOptionalPointer(join(root, 'previous'), pointersBefore.previous);
        await restoreOptionalPointer(join(root, 'runtime'), pointersBefore.runtime);
        await restoreOptionalPointer(join(root, 'previous-runtime'), pointersBefore['previous-runtime']);
      } catch (error) {
        pointerRecovery = { status: 'failed', error: errorEvidence(error) };
      }
      const protectedAfter = await assertProtectedUnchanged(context, protectedBefore);
      const caddyAfter = await caddySemanticEvidence(context.policy).catch((error) => ({ status: 'capture-failed', digest: null, error: errorEvidence(error) }));
      const receipt = await deploymentReceipt(context, manifest, {
        pointersBefore,
        rollbackPoint,
        capacity,
        caddyBefore,
        caddyAfter,
        readiness: candidateError?.details?.readiness ?? { status: 'failed', error: errorEvidence(candidateError) },
        targetProcessBefore,
        targetProcessAfter: await processId(context.deployment.restart),
        protectedBefore,
        protectedAfter,
        databaseMigration,
        finalStatus: 'database-applied-pointer-record-failed',
      });
      throw failure('DATABASE_MIGRATION_POINTER_RECORD_FAILED', {
        candidateFailure: errorEvidence(candidateError),
        databaseMigration,
        databaseRollback: 'not-performed',
        pointerRecovery,
        receipt,
      });
    }
    activationRestart = candidateError?.details?.restart ?? activationRestart;
    timings.health = candidateError?.details?.durationMs ?? 0;
    const failureConfirmedAt = new Date().toISOString();
    const failureDetectedAt = performance.now();
    const rollbackStarted = performance.now();
    const rollback = {
      triggerDelayMs: null,
      startedAt: null,
      pointerRestoreMs: 0,
      failureResetMs: 0,
      restartMs: 0,
      restart: restartEvidence(context.deployment.restart, false),
      readinessMs: 0,
      totalMs: 0,
      finalCurrent: null,
      finalRuntime: null,
    };
    let rollbackFailure = null;
    try {
      assert(previousCurrent, 'ROLLBACK_BASELINE_MISSING', { root });
      const { observed } = await observeRollbackPlacement(root);
      const rollbackTarget = await verifiedRollbackTarget(context, previousCurrent, observed);
      await restoreNodeRuntime(nodeRuntimeRecovery);
      await chmod(rollbackTarget, 0o755);
      const pointerStarted = performance.now();
      rollback.startedAt = new Date().toISOString();
      rollback.triggerDelayMs = elapsedMs(failureDetectedAt);
      await atomicPointer(join(root, 'current'), rollbackTarget);
      await restoreOptionalPointer(join(root, 'previous'), pointersBefore.previous);
      await restoreOptionalPointer(join(root, 'runtime'), previousRuntime);
      await restoreOptionalPointer(join(root, 'previous-runtime'), pointersBefore['previous-runtime']);
      if (context.target === 'storefront') await restoreStorefrontPublicEnvironment(context, rollbackTarget);
      rollback.pointerRestoreMs = elapsedMs(pointerStarted);
      const processBeforeRestart = await cutoverProcess(context);
      const processBefore = processBeforeRestart?.process ?? await observeProcess(context);
      const restartStarted = performance.now();
      rollback.restart = await restart(context.deployment.restart);
      rollback.restartMs = elapsedMs(restartStarted);
      const failureResetStarted = performance.now();
      await resetFailureState(context.deployment.restart);
      rollback.failureResetMs = elapsedMs(failureResetStarted);
      const rollbackReadiness = await waitForReadiness(context, { candidateDir: rollbackTarget, currentDir: rollbackTarget, ...contextSummary(context) });
      rollback.readiness = rollbackReadiness;
      rollback.readinessMs = rollbackReadiness.durationMs;
      const running = await verifyCutoverProcess(context, rollbackTarget, processBefore);
      protectedAfter = await assertProtectedUnchanged(context, protectedBefore);
      const pointers = await observePointerPair(root);
      rollback.finalCurrent = pointers[0]?.target ?? null;
      rollback.finalRuntime = await pointer(root, 'runtime');
      assert(rollback.finalCurrent === rollbackTarget && (pointers[1]?.target ?? null) === pointersBefore.previous &&
        rollback.finalRuntime === previousRuntime &&
        (!processBeforeRestart || stableJson(pointers) === stableJson(processBeforeRestart.pointers)),
      'CUTOVER_SUPERSEDED', { current: rollback.finalCurrent, previous: pointers[1]?.target ?? null });
      await recordConfirmedCutover(root, { pointers, process: running, confirmedAt: Date.now() });
    } catch (error) {
      rollback.restart = error?.details?.restart ?? rollback.restart;
      rollbackFailure = errorEvidence(error);
      rollback.finalCurrent = await pointer(root, 'current');
      rollback.finalRuntime = await pointer(root, 'runtime');
    }
    rollback.totalMs = elapsedMs(rollbackStarted);
    rollback.triggeredWithinMs = Number.isFinite(rollback.triggerDelayMs) && rollback.triggerDelayMs <= 3_000;
    if (!protectedAfter) {
      protectedAfter = await protectedProcessSnapshot(context).catch((error) => ({ captureError: errorEvidence(error) }));
    }
    timings.rollback = rollback.totalMs;
    timings.total = Date.now() - started;
    const details = {
      candidateFailure: errorEvidence(candidateError),
      failureConfirmedAt,
      rollback,
      rollbackFailure,
      previousCurrent,
      timings,
      targetProcess: { before: targetProcessBefore, after: await processId(context.deployment.restart) },
      protectedProcesses: { before: protectedBefore, after: protectedAfter },
      restartCommands: {
        candidate: activationRestart,
        rollback: rollback.restart,
        total: activationRestart.commandCount + rollback.restart.commandCount,
      },
    };
    details.receipt = await deploymentReceipt(context, manifest, {
      pointersBefore,
      rollbackPoint,
      capacity,
      caddyBefore,
      caddyAfter: await caddySemanticEvidence(context.policy).catch((error) => ({ status: 'capture-failed', digest: null, error: errorEvidence(error) })),
      readiness: candidateError?.details?.readiness ?? { status: 'failed', error: errorEvidence(candidateError) },
      targetProcessBefore,
      targetProcessAfter: details.targetProcess.after,
      protectedBefore,
      protectedAfter,
      finalStatus: rollbackFailure ? 'rollback-failed' : 'rolled-back',
    });
    if (rollbackFailure) throw failure('CUTOVER_FAILED_ROLLBACK_UNHEALTHY', details);
    throw failure('CUTOVER_FAILED_AND_ROLLED_BACK', details);
  }
  timings.total = Date.now() - started;
  return {
    mode: resumingCurrent ? 'resumed-cutover' : 'activated',
    alreadyCurrent: false,
    ...activatedReleases,
    runtime: await pointer(root, 'runtime'),
    service: context.deployment.restart,
    serviceStatus: await processState(context.deployment.restart),
    restart: activationRestart,
    readiness,
    cutoverMs: timings.cutover + timings.restart + timings.health + timings.isolation,
    timings,
    targetProcess: { before: targetProcessBefore, after: await processId(context.deployment.restart) },
    protectedProcesses: { before: protectedBefore, after: protectedAfter },
    receipt: await deploymentReceipt(context, manifest, {
      pointersBefore,
      rollbackPoint,
      capacity,
      caddyBefore,
      caddyAfter: await caddySemanticEvidence(context.policy),
      readiness,
      targetProcessBefore,
      targetProcessAfter: await processId(context.deployment.restart),
      protectedBefore,
      protectedAfter,
      databaseMigration,
      finalStatus: 'success',
    }),
  };
}

async function verifyInstalledCandidate(context, candidate) {
  const root = context.deployment.pointerRoot;
  const pointers = await observePointerPair(root);
  if (pointers[0]?.target !== candidate) return null;
  const running = await observeProcess(context);
  if (await observeCutover(context, pointers, running)) return null;
  if (context.target === 'storefront') {
    const expected = await storefrontPublicEnvironment(context, candidate);
    if (Object.keys(expected).length > 0) {
      const source = await readFile(nodeRuntimeDestinations(context).environment, 'utf8');
      const current = new Map();
      for (const line of source.split(/\r?\n/)) {
        const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
        if (match) current.set(match[1], match[2]);
      }
      if (Object.entries(expected).some(([key, value]) => {
        const raw = current.get(key);
        return raw !== value && raw !== `'${value}'` && `${key}=${raw}` !== environmentAssignment(key, value);
      })) return null;
    }
  }

  const readiness = await waitForReadiness(context, { candidateDir: candidate, currentDir: candidate, ...contextSummary(context) });
  const after = await observeProcess(context);
  if (stableJson(running) !== stableJson(after) ||
      stableJson(pointers) !== stableJson(await observePointerPair(root)) ||
      await hasActiveCutover(root)) return null;
  return { readiness, releases: await releasePointersForStatus(root, pointers.map((entry) => entry?.target ?? null)) };
}

async function preflight(context) {
  const root = context.deployment.pointerRoot;
  assertAllowedRoot(context.policy, root);
  const candidate = await pointer(root, 'candidate');
  assert(candidate, 'CANDIDATE_MISSING');
  const manifest = JSON.parse(await readFile(join(candidate, 'AI_DELIVERY_ARTIFACT.json'), 'utf8'));
  const started = performance.now();
  await runChecks(context.deployment.candidateChecks ?? [], { candidateDir: candidate, currentDir: (await pointer(root, 'current')) ?? '', ...contextSummary(context) });
  return {
    candidate,
    artifact: artifactSummary(manifest),
    capacity: await capacityEvidence(context, manifest.archive?.bytes ?? manifest.totalBytes ?? 0),
    rollbackPoint: { pointers: await pointerSnapshot(root), targetProcess: await processId(context.deployment.restart), protectedProcesses: await protectedProcessSnapshot(context) },
    caddySemantic: await caddySemanticEvidence(context.policy),
    durationMs: elapsedMs(started),
  };
}

async function initializeNodeIngress(context, candidate, artifact) {
  const setup = context.deployment.databaseMigration.initialize.ingress;
  const root = join('/opt/sfl/nodes', context.node);
  const runtime = join(root, 'runtime');
  const bootstrap = join(candidate, 'database/bootstrap');
  const credentials = parseEnvironmentFile(await readFile(join(root, 'database/postgres.env'), 'utf8'));
  const nodeManifest = await readJson(join(candidate, 'node-runtime/manifest.json'));
  const apiToken = context.cloudflare?.apiToken?.trim();
  if (!apiToken) throw new Error('CLOUDFLARE_INGRESS_CREDENTIALS_MISSING');
  await mkdir('/opt/sfl/control/autonode', { recursive: true, mode: 0o750 });
  await writeFile('/opt/sfl/control/autonode/cloudflare-token', apiToken, { mode: 0o600 });
  const zoneResponse = await fetch(`https://api.cloudflare.com/client/v4/zones?per_page=50`, {
    headers: { authorization: `Bearer ${apiToken}` }, signal: AbortSignal.timeout(30000),
  });
  const zone = await zoneResponse.json();
  if (!zoneResponse.ok || !zone.success) throw new Error(`CLOUDFLARE_ZONE_FAILED:${zoneResponse.status}:${JSON.stringify(zone.errors)}`);
  const zones = [...zone.result];
  for (let page = 2; page <= (zone.result_info?.total_pages ?? 1); page++) {
    const response = await fetch(`https://api.cloudflare.com/client/v4/zones?per_page=50&page=${page}`, {
      headers: { authorization: `Bearer ${apiToken}` }, signal: AbortSignal.timeout(30000),
    });
    const payload = await response.json();
    if (!response.ok || !payload.success) throw new Error(`CLOUDFLARE_ZONE_FAILED:${response.status}`);
    zones.push(...payload.result);
  }
  const zoneFor = (host) => zones.filter((item) => host === item.name || host.endsWith(`.${item.name}`))
    .sort((a, b) => b.name.length - a.name.length)[0];
  const primaryHost = nodeManifest.domain_bindings.find((item) => item.surface_ref === 'surface:storefront').host;
  const matchedZone = zoneFor(primaryHost);
  if (!matchedZone) throw new Error(`CLOUDFLARE_ZONE_NOT_FOUND:${primaryHost}`);
  const zoneId = matchedZone.id;
  const { AutoNodeCloudflareClient } = await import(pathToFileURL(join(bootstrap, 'autonode-cloudflare.mjs')).href);
  const { gatewayConfiguration } = await import(pathToFileURL(join(bootstrap, 'generate-sfl-node-gateway.mjs')).href);
  const client = new AutoNodeCloudflareClient({ accountId: matchedZone.account.id, zoneId, apiToken });
  const secret = createHash('sha256').update(`${credentials.POSTGRES_PASSWORD}\0LK_TUNNEL:${context.node}`).digest('base64');
  const tunnel = await client.ensureTunnel(setup.tunnelName, secret);
  await recordNodeResources(context, { cloudflare: { accountId: matchedZone.account.id, tunnelId: tunnel.id } });
  const tunnelDirectory = join(root, 'tunnel');
  await mkdir(tunnelDirectory, { recursive: true, mode: 0o750 });
  const credentialFile = join(tunnelDirectory, 'credentials.json');
  await writeFile(credentialFile, JSON.stringify({ AccountTag: matchedZone.account.id, TunnelSecret: secret, TunnelID: tunnel.id }), { mode: 0o640 });
  const hosts = nodeManifest.domain_bindings.map((binding) => binding.host);
  const ingress = hosts.map((hostname) => ({ hostname, service: `http://127.0.0.1:${setup.ports.gateway}` }));
  ingress.push({ service: 'http_status:404' });
  await writeFile(join(runtime, 'cloudflared.yml'), JSON.stringify({ tunnel: tunnel.id, 'credentials-file': credentialFile,
    'no-autoupdate': true, metrics: `127.0.0.1:${setup.metricsPort}`, ingress }, null, 2) + '\n', { mode: 0o640 });
  await writeFile(join(runtime, 'api-gateway.Caddyfile'), gatewayConfiguration(nodeManifest, root, setup.ports, { httpLoopback: true }), { mode: 0o640 });
  for (const directory of ['caddy-data', 'caddy-config']) await mkdir(join(runtime, directory), { recursive: true, mode: 0o750 });
  await command(['chown', '-R', 'zhudatuan:zhudatuan', tunnelDirectory, runtime]);
  if (!(await exists('/usr/local/bin/cloudflared'))) {
    if (await exists('/usr/bin/cloudflared')) await symlink('/usr/bin/cloudflared', '/usr/local/bin/cloudflared');
    else {
      const architecture = (await command(['uname', '-m'])).stdout.trim();
      const binary = architecture === 'aarch64' ? 'arm64' : 'amd64';
      await command(['curl', '-fL', '--retry', '2', '-o', '/usr/local/bin/cloudflared', `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${binary}`], { timeoutMs: 120000 });
      await chmod('/usr/local/bin/cloudflared', 0o755);
    }
  }
  for (const unit of ['sfl-api-gateway@.service', 'sfl-cloudflared@.service']) {
    await copyFile(join(bootstrap, 'systemd', unit), join('/etc/systemd/system', unit));
  }
  const dropIn = join('/etc/systemd/system', `sfl-api-gateway@${context.node}.service.d`);
  await mkdir(dropIn, { recursive: true });
  await writeFile(join(dropIn, 'instance.conf'), `[Unit]\nWants=\nWants=network-online.target\nAfter=\nAfter=network-online.target\nConditionPathExists=\n[Service]\nExecStartPre=\n`);
  await command(['systemctl', 'daemon-reload']);
  const services = [`sfl-api-gateway@${context.node}.service`, `sfl-cloudflared@${context.node}.service`];
  for (const service of services) {
    await command(['systemctl', 'enable', service]);
    await command(['systemctl', 'restart', service]);
  }
  const records = [];
  for (const host of hosts) {
    const hostZone = zoneFor(host);
    if (!hostZone) throw new Error(`CLOUDFLARE_ZONE_NOT_FOUND:${host}`);
    const dnsClient = new AutoNodeCloudflareClient({ accountId: hostZone.account.id, zoneId: hostZone.id, apiToken });
    const record = await dnsClient.ensureCname(host, `${tunnel.id}.cfargotunnel.com`, `LK ${context.node}`);
    records.push(record);
    await recordNodeResources(context, { dnsRecord: { zoneId: hostZone.id, id: record.id, name: host } });
  }
  if (context.domainSwitch) {
    const inventoryFile = join('/var/lib/sfl-autonode-control/resources', `${context.node}.json`);
    const inventory = await readJson(inventoryFile);
    for (const record of inventory?.dnsRecords ?? []) {
      if (hosts.includes(record.name)) continue;
      const dnsClient = new AutoNodeCloudflareClient({ accountId: matchedZone.account.id, zoneId: record.zoneId, apiToken });
      await dnsClient.deleteDnsRecord(record.id);
    }
    if (inventory) {
      inventory.dnsRecords = inventory.dnsRecords.filter((record) => hosts.includes(record.name));
      await writeFile(inventoryFile, JSON.stringify(inventory, null, 2) + '\n', { mode: 0o600 });
    }
    const configurationFile = '/opt/sfl/control/autonode/instances.json';
    const configuration = await readJson(configurationFile);
    const instance = configuration?.instances.find((item) => item.instance === context.node);
    if (instance) {
      instance.sourceSha = artifact.sourceSha;
      instance.access_entries = nodeManifest.domain_bindings.filter((binding) =>
        ['surface:console', 'surface:storefront'].includes(binding.surface_ref))
        .map((binding) => ({ surface_ref: binding.surface_ref, url: `https://${binding.host}` }));
      await writeFile(configurationFile, JSON.stringify(configuration, null, 2) + '\n', { mode: 0o600 });
    }
  }
  const serviceState = (await command(['systemctl', 'is-active', ...services])).stdout.trim().split(/\s+/);
  const apiHost = nodeManifest.domain_bindings.find((binding) => binding.surface_ref === 'surface:api').host;
  const localResponse = await command(['curl', '--fail', '--silent', '--show-error', '--max-time', '10', '-H', `Host: ${apiHost}`, `http://127.0.0.1:${setup.ports.gateway}/health/gateway`]);
  return { schema: 'ai.delivery.database-migration-result.v1', sourceSha: artifact.sourceSha, status: 'initialized', node: context.node,
    ingress: { tunnelId: tunnel.id, records, services: services.map((name, index) => ({ name, state: serviceState[index] })),
      gateway: JSON.parse(localResponse.stdout), applicationActivation: 'pending' }, migrationsApplied: false, credentialsReported: false };
}

async function initializeNodeDatabase(context, candidate, manifest) {
  const setup = context.deployment.databaseMigration.initialize;
  if (setup.ingress && !setup.applyBusiness) return initializeNodeIngress(context, candidate, manifest);
  const root = join('/opt/sfl/nodes', context.node);
  const runtime = join(root, 'runtime');
  const database = join(root, 'database');
  await mkdir(runtime, { recursive: true, mode: 0o750 });
  await mkdir(database, { recursive: true, mode: 0o750 });
  await chmod(root, 0o755);
  const credentialFile = join(database, 'postgres.env');
  let credentials;
  if (await exists(credentialFile)) credentials = parseEnvironmentFile(await readFile(credentialFile, 'utf8'));
  else {
    credentials = { POSTGRES_DB: 'zhudatuan_registration', POSTGRES_USER: 'zhudatuanroot' };
    for (const key of ['POSTGRES_PASSWORD','SHOPAPP_PASSWORD','SHOPJOB_PASSWORD','SHOPMIGRATION_PASSWORD','SHOPREAD_PASSWORD',
      'ZHUDATUANBOOTSTRAP_PASSWORD','DATABASE_SENTINEL','ZHUDATUAN_IDENTITY_API_PASSWORD','ZHUDATUAN_WEB_API_PASSWORD','ZHUDATUAN_PURCHASE_API_PASSWORD']) {
      credentials[key] = randomBytes(36).toString('base64url');
    }
    await writeFile(credentialFile, environmentText(credentials), { mode: 0o600 });
  }
  if (!credentials.ZHUDATUAN_PURCHASE_API_PASSWORD) {
    credentials.ZHUDATUAN_PURCHASE_API_PASSWORD = randomBytes(36).toString('base64url');
    await writeFile(credentialFile, environmentText(credentials), { mode: 0o600 });
  }
  const bootstrap = join(candidate, 'database/bootstrap');
  const initFile = join(database, 'postgres-init.sh');
  await copyFile(join(bootstrap, 'postgres-init.sh'), initFile);
  await chmod(initFile, 0o644);
  const container = `${context.node}-postgres`;
  await recordNodeResources(context, { database: { container, dataDirectory: join(database, 'data') } });
  const composeFile = join(database, 'compose.yml');
  const compose = (await readFile(join(bootstrap, 'registration-compose.yml'), 'utf8'))
    .replace('name: zhudatuan-registration', `name: ${context.node}`)
    .replace('container_name: zhudatuan-registration-postgres', `container_name: ${container}`)
    .replace('/opt/zhudatuan/shared/postgres.env', credentialFile)
    .replace('127.0.0.1:55432:5432', `127.0.0.1:${setup.port}:5432`)
    .replace('/var/lib/zhudatuan/postgres', join(database, 'data'))
    .replace('/opt/zhudatuan/current/02_platform_pingtai/infrastructure/zhudatuan/aliyun/postgres-init-registration.sh', initFile);
  await writeFile(composeFile, compose);
  try {
    await command(['docker', 'version', '--format', '{{.Client.Version}}']);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const installOptions = { timeoutMs: 240_000, env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' } };
    await command(['apt-get', 'update'], installOptions);
    try { await command(['apt-get','install','-y','docker.io','docker-compose-v2'], installOptions); }
    catch { await command(['apt-get','install','-y','docker.io','docker-compose'], installOptions); }
    await command(['systemctl','start','docker']);
  }
  let composeCommand = ['docker','compose'];
  try { await command([...composeCommand,'version']); }
  catch { composeCommand = ['docker-compose']; }
  await command([...composeCommand, '-f', composeFile, 'up', '-d'], { timeoutMs: 240_000 });
  const deadline = Date.now() + 60_000;
  while (true) {
    try {
      await command(['docker','exec',container,'pg_isready','-h','127.0.0.1','-U',credentials.POSTGRES_USER,'-d',credentials.POSTGRES_DB], { timeoutMs: 5000 });
      break;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await delay(1000);
    }
  }
  // The existing initializer creates these runtime roles without passwords for local use.
  // This instance consumes them over its own loopback database connection.
  const roleSql = `alter role zhudatuanidentityapi login password '${credentials.ZHUDATUAN_IDENTITY_API_PASSWORD}';
alter role zhudatuanwebapi login password '${credentials.ZHUDATUAN_WEB_API_PASSWORD}';
alter role zhudatuanpurchaseapi login password '${credentials.ZHUDATUAN_PURCHASE_API_PASSWORD}';
`;
  await command(['docker','exec','-i',container,'psql','-X','-v','ON_ERROR_STOP=1','-U',credentials.POSTGRES_USER,'-d',credentials.POSTGRES_DB], { input: roleSql });
  const sourceRoot = join('/opt/sfl/nodes', setup.environmentSource, 'runtime');
  const inputs = {};
  for (const target of ['identity-api','web-api','purchase-api','storefront']) {
    const inputFile = target === 'purchase-api' && await exists(join(runtime, `${target}.env`))
      ? join(runtime, `${target}.env`) : join(sourceRoot, `${target}.env`);
    inputs[target] = parseEnvironmentFile(await readFile(inputFile, 'utf8'));
  }
  const prefix = setup.secretPrefix;
  const secretsFile = join(runtime, 'secrets.json');
  let secrets = await readJson(secretsFile) ?? {};
  for (const [target, role, password] of [
    ['identity-api','zhudatuanidentityapi',credentials.ZHUDATUAN_IDENTITY_API_PASSWORD],
    ['web-api','zhudatuanwebapi',credentials.ZHUDATUAN_WEB_API_PASSWORD],
    ['purchase-api','zhudatuanpurchaseapi',credentials.ZHUDATUAN_PURCHASE_API_PASSWORD]]) {
    secrets[`${prefix}/database/${target}`] = `postgresql://${role}:${password}@127.0.0.1:${setup.port}/${credentials.POSTGRES_DB}`;
  }
  for (const key of ['identity/session','identity/index','purchase/checkout/quote']) secrets[`${prefix}/${key}`] ??= randomBytes(36).toString('base64url');
  await writeFile(secretsFile, JSON.stringify(secrets, null, 2) + '\n', { mode: 0o640 });
  const nodeManifest = await readJson(join(candidate, 'node-runtime/manifest.json'));
  const origins = { ...setup.origins };
  for (const [key, surface] of [['identity','identity'], ['console','console'], ['storefront','storefront']]) {
    const binding = nodeManifest?.domain_bindings.find((entry) => entry.surface_ref === `surface:${surface}`);
    if (binding) origins[key] = `https://${binding.host}`;
  }
  if (nodeManifest) {
    await copyFile(join(candidate, 'node-runtime/manifest.json'), join(root, 'manifest.json'));
  }
  for (const [target, env] of Object.entries(inputs)) {
    if (nodeManifest) Object.assign(env, {
      NODE_MANIFEST_PATH: join(root, 'manifest.json'), NODE_MANIFEST_ID: nodeManifest.manifest_id,
      NODE_MANIFEST_DIGEST: nodeManifest.manifest_digest, NODE_RUNTIME_INSTANCE_ID: nodeManifest.runtime_instance_id,
      NODE_RUNTIME_CONFIG_REF: nodeManifest.runtime_config_ref.ref,
      NODE_RESOURCE_BINDING_VERSION: nodeManifest.resource_binding_set_ref.version,
      NODE_RELEASE_POINTER_REF: nodeManifest.release_pointer_ref.ref,
    });
    if (target !== 'storefront') {
      env.API_PORT = String(setup.servicePorts[target] ?? (target === 'purchase-api' ? setup.ingress?.ports?.purchase : undefined));
      env.API_ALLOWED_ORIGINS = [origins.identity, origins.console, origins.storefront].filter(Boolean).join(',');
      env.DATABASE_API_CONNECTION_REF = `${prefix}/database/${target}`;
      env.DATABASE_API_ROLE = target === 'identity-api' ? 'zhudatuanidentityapi' : target === 'purchase-api' ? 'zhudatuanpurchaseapi' : 'zhudatuanwebapi';
      env.SECRET_STORE_ENDPOINT = `https://127.0.0.1:${setup.secretPort}`;
      if (target === 'identity-api') env.OBJECT_STORE_ENDPOINT = `https://127.0.0.1:${setup.objectPort}`;
    } else {
      env.STOREFRONT_PORT = String(setup.servicePorts.storefront);
      env.STOREFRONT_HOST = '127.0.0.1';
    }
    if (target === 'identity-api') {
      env.NODE_IDENTITY_RUNTIME_PATH = join(runtime, 'identity-runtime.json');
      env.SESSION_KEY_REF = `${prefix}/identity/session`;
      env.IDENTITY_KEY_REF = `${prefix}/identity/index`;
      // WeChat configuration remains unset until this instance has its own application.
      delete env.WECHAT_APPLICATION_CONFIG_REF;
      delete env.WECHAT_IDENTITY_CONFIG_REF;
    }
    if (target === 'purchase-api') {
      env.QUOTE_KEY_REF = `${prefix}/purchase/checkout/quote`;
      env.API_ALLOWED_ORIGINS = nodeManifest.domain_bindings.filter((binding) => binding.surface_ref === 'surface:storefront').map((binding) => `https://${binding.host}`).join(',');
      // Each instance supplies its own payment merchant configuration.
      if (!(await exists(join(runtime, 'purchase-api.env')))) {
        for (const key of ['KMS_ENDPOINT', 'KMS_BEARER_TOKEN', 'WECHAT_APPLICATION_CONFIG_REF', 'WECHAT_PAYMENT_CONFIG_REF']) delete env[key];
      }
    }
    if (target === 'web-api') {
      env.PUBLIC_MALL_SLUG = setup.application;
      env.PUBLIC_MALL_HOST_MAPPINGS = `${new URL(origins.storefront).hostname}=${setup.application}`;
    }
    await writeFile(join(runtime, `${target}.env`), environmentText(env), { mode: 0o640 });
  }
  const objectEnvironment = parseEnvironmentFile(await readFile(join(sourceRoot, 'object-store.env'), 'utf8'));
  if (nodeManifest) Object.assign(objectEnvironment, {
    NODE_MANIFEST_PATH: join(root, 'manifest.json'), NODE_MANIFEST_ID: nodeManifest.manifest_id,
    NODE_MANIFEST_DIGEST: nodeManifest.manifest_digest, NODE_RUNTIME_INSTANCE_ID: nodeManifest.runtime_instance_id,
    NODE_RUNTIME_CONFIG_REF: nodeManifest.runtime_config_ref.ref,
    NODE_RESOURCE_BINDING_VERSION: nodeManifest.resource_binding_set_ref.version,
    NODE_RELEASE_POINTER_REF: nodeManifest.release_pointer_ref.ref,
  });
  objectEnvironment.LOCAL_OBJECTS_PORT = String(setup.objectPort);
  objectEnvironment.LOCAL_OBJECTS_DIRECTORY = join(root, 'objects');
  await mkdir(objectEnvironment.LOCAL_OBJECTS_DIRECTORY, { recursive: true, mode: 0o750 });
  await writeFile(join(runtime, 'object-store.env'), environmentText(objectEnvironment), { mode: 0o640 });
  const shared = parseEnvironmentFile(await readFile('/opt/zhudatuan/shared/runtime.env', 'utf8'));
  const secretEnvironment = {
    LOCAL_TLS_KEY_FILE: shared.LOCAL_TLS_KEY_FILE ?? objectEnvironment.LOCAL_TLS_KEY_FILE,
    LOCAL_TLS_CERT_FILE: shared.LOCAL_TLS_CERT_FILE ?? objectEnvironment.LOCAL_TLS_CERT_FILE,
    LOCAL_SECRETS_FILE: secretsFile,
    LOCAL_SECRETS_PORT: String(setup.secretPort),
    LOCAL_SECRET_STORE_BEARER_TOKEN: inputs['identity-api'].SECRET_STORE_BEARER_TOKEN,
  };
  await writeFile(join(runtime, 'secret-store.env'), environmentText(secretEnvironment), { mode: 0o640 });
  await copyFile('/opt/zhudatuan/shared/migration.env', join(runtime, 'migration.env'));
  await command(['chown','-R','zhudatuan:zhudatuan',runtime,objectEnvironment.LOCAL_OBJECTS_DIRECTORY]);
  // Install the existing unit definitions; application activation is a later release.
  const units = join(bootstrap, 'systemd');
  for (const name of ['sfl-storefront@.service','sfl-identity-api@.service','sfl-web-api@.service','sfl-purchase-api@.service','sfl-catalog-object-store@.service','sfl-secret-store@.service']) {
    await copyFile(join(units, name), join('/etc/systemd/system', name));
  }
  if (!(await exists(join(root, 'current')))) await symlink('/opt/zhudatuan/current', join(root, 'current'));
  const dropIn = join('/etc/systemd/system', `sfl-secret-store@${context.node}.service.d`);
  await mkdir(dropIn, { recursive: true });
  await writeFile(join(dropIn, 'instance.conf'), `[Service]
WorkingDirectory=/opt/zhudatuan/current
EnvironmentFile=${runtime}/secret-store.env
ExecStart=
ExecStart=/usr/bin/node /opt/zhudatuan/current/01_core_hexin/services/commerce/dist/LocalSecretsMain.js
ExecStartPost=
ExecStartPost=/usr/bin/curl --fail --silent --show-error --max-time 10 --cacert /opt/zhudatuan/shared/tls/internal-ca.crt https://127.0.0.1:${setup.secretPort}/health/ready
`);
  await command(['systemctl','daemon-reload']);
  return {
    schema: 'ai.delivery.database-migration-result.v1', sourceSha: manifest.sourceSha,
    status: 'initialized', node: context.node,
    database: { container, name: credentials.POSTGRES_DB, port: setup.port, dataDirectory: join(database,'data') },
    environmentFiles: Object.keys(inputs).map((target) => join(runtime, `${target}.env`)),
    migrationsApplied: false, credentialsReported: false,
  };
}

function environmentText(values) {
  return Object.entries(values).filter(([,value]) => value !== undefined)
    .map(([key,value]) => `${key}=${JSON.stringify(String(value))}`).join('\n') + '\n';
}

async function executeDatabaseMigration(context, candidate, manifest) {
  if (context.domainSwitch) {
    const nodeManifest = await readJson(join(candidate, 'node-runtime/manifest.json'));
    const projection = await readJson(join(candidate, 'node-runtime/identity-node-projection.json'));
    const root = join('/opt/sfl/nodes', context.node);
    const previousManifest = await readJson(join(root, 'manifest.json'));
    const replacements = (previousManifest?.domain_bindings ?? []).map((binding) => [binding.host,
      nodeManifest.domain_bindings.find((next) => next.surface_ref === binding.surface_ref)?.host]).filter(([, host]) => host);
    for (const target of ['identity-api', 'web-api', 'purchase-api', 'storefront', 'object-store']) {
      const file = join(root, 'runtime', `${target}.env`);
      if (!(await exists(file))) continue;
      const env = parseEnvironmentFile(await readFile(file, 'utf8'));
      for (const key of Object.keys(env)) {
        if (!/(ORIGIN|HOST|URL)/.test(key) || key === 'IDENTITY_CONTROLLER_ORIGIN') continue;
        for (const [before, after] of replacements) env[key] = env[key].split(before).join(after);
      }
      const applicationManifest = await readJson(join(root, 'targets', target, 'current', 'node-runtime', 'manifest.json'));
      const runtimeManifest = applicationManifest ?? nodeManifest;
      Object.assign(env, { NODE_MANIFEST_DIGEST: runtimeManifest.manifest_digest,
        NODE_RESOURCE_BINDING_VERSION: runtimeManifest.resource_binding_set_ref.version });
      await writeFile(file, environmentText(env), { mode: 0o640 });
    }
    await copyFile(join(candidate, 'node-runtime/manifest.json'), join(root, 'manifest.json'));
    const node = projection.nodes.find((item) => item.nodeId === nodeManifest.node_id);
    const credentials = parseEnvironmentFile(await readFile(context.deployment.databaseMigration.credentialFile, 'utf8'));
    const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
    const realm = literal(node.realmId);
    const hosts = new Set(node.entries.map((entry) => entry.host));
    const statements = ['begin;', `delete from identity.realmentry where realm_id=${realm}
      and host not in (${[...hosts].map(literal).join(',')});`];
    for (const entry of node.entries) statements.push(`insert into identity.realmentry(host,realm_id,kind,status,created_at)
      values(${literal(entry.host)},${realm},${literal(entry.kind)},${literal(entry.status)},now())
      on conflict(host) do update set kind=excluded.kind,status=excluded.status where identity.realmentry.realm_id=excluded.realm_id;`);
    for (const target of node.targets) statements.push(`update identity.realmtarget set return_origin=${literal(target.returnOrigin)}
      where realm_id=${realm} and target=${literal(target.target)};`);
    statements.push('commit;');
    await command(['docker','exec','-i',`${context.node}-postgres`,'psql','-X','-v','ON_ERROR_STOP=1',
      '-U',credentials.POSTGRES_USER,'-d',credentials.POSTGRES_DB], { input: statements.join('\n') });
    const ingress = await initializeNodeIngress(context, candidate, manifest);
    return { ...ingress, status: 'domain-updated', realmId: node.realmId,
      restart: restartEvidence(context.deployment.restart, false) };
  }
  if (context.deployment.databaseMigration.initialize && !context.deployment.databaseMigration.initialize.applyBusiness) {
    const result = await initializeNodeDatabase(context, candidate, manifest);
    return { ...result, restart: restartEvidence(context.deployment.restart, false) };
  }
  const definition = context.deployment.databaseMigration;
  if (definition.initialize?.applyBusiness) {
    await initializeNodeDatabase(context, candidate, manifest);
    const nodeRoot = join('/opt/sfl/nodes',context.node);
    const credentials = parseEnvironmentFile(await readFile(definition.credentialFile,'utf8'));
    await command(['chgrp',definition.runtimeGroup,join(nodeRoot,'database')]);
    await chmod(join(nodeRoot,'database'),0o750);
    const container = `${context.node}-postgres`;
    const hostNetwork = `${context.node}-database-link`;
    const containerState = JSON.parse((await command(['docker','inspect',container])).stdout)[0];
    if (!containerState.NetworkSettings.Networks[hostNetwork]) {
      try { await command(['docker','network','inspect',hostNetwork]); }
      catch { await command(['docker','network','create',hostNetwork]); }
      await command(['docker','network','connect',hostNetwork,container]);
    }
    const composeFile = join(nodeRoot,'database/compose.yml');
    let compose = await readFile(composeFile,'utf8');
    if (!compose.includes('host_link:')) {
      compose = compose.replace('      - registration','      - registration\n      - host_link')
        + `\n  host_link:\n    external: true\n    name: ${hostNetwork}\n`;
      await writeFile(composeFile,compose);
    }

    const sql = `do $roles$ begin
      if not exists(select 1 from pg_roles where rolname='shopread') then create role shopread nologin; end if;
      if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
      if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
      if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
    end $roles$;
    alter role anon noinherit;
    alter role authenticated noinherit;
    alter role service_role noinherit;
    alter role shopread noinherit;
    grant shopapp,shopjob to shopmigration;
    alter database "${credentials.POSTGRES_DB}" owner to shopmigration;
    `;
    await command(['docker','exec','-i',`${context.node}-postgres`,'psql','-U',credentials.POSTGRES_USER,'-d',credentials.POSTGRES_DB,'-v','ON_ERROR_STOP=1'],{input:sql});
  }
  const executionRoot = resolve(required(definition.executionRoot, 'DATABASE_MIGRATION_EXECUTION_ROOT_REQUIRED'));
  const environmentFile = resolve(required(definition.environmentFile, 'DATABASE_MIGRATION_ENVIRONMENT_FILE_REQUIRED'));
  const credentialFile = definition.credentialFile === undefined ? null : resolve(definition.credentialFile);
  assertAllowedRoot(context.policy, executionRoot);
  assertAllowedRoot(context.policy, environmentFile);
  if (credentialFile !== null) assertAllowedRoot(context.policy, credentialFile);
  const releaseName = `${manifest.sourceSha}-database-migration-${manifest.treeDigest.slice(7, 19)}`;
  const executionDirectory = join(executionRoot, releaseName);
  const temporary = join(executionRoot, `.${releaseName}.${process.pid}.${Date.now()}`);
  await mkdir(executionRoot, { recursive: true, mode: 0o755 });
  if (!(await exists(executionDirectory))) {
    try {
      await cp(candidate, temporary, { recursive: true, dereference: false, errorOnExist: true });
      await rename(temporary, executionDirectory);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  } else {
    const existing = await readJson(join(executionDirectory, 'AI_DELIVERY_ARTIFACT.json'));
    assert(existing?.sourceSha === manifest.sourceSha && existing?.treeDigest === manifest.treeDigest && existing?.manifestDigest === manifest.manifestDigest, 'DATABASE_MIGRATION_EXECUTION_RELEASE_MISMATCH', { executionDirectory });
  }
  await chmod(executionDirectory, 0o755);
  if (definition.initialize?.applyBusiness) await command(['chown','-R',`${definition.runtimeUser}:${definition.runtimeGroup}`,executionDirectory]);
  if (definition.initialize?.applyBusiness) {
    const setup = definition.initialize;
    const nodeRoot = join('/opt/sfl/nodes', context.node);
    const runtime = join(nodeRoot, 'runtime');
    const internal = join(runtime, 'internal');
    await atomicPointer(internal, join(executionDirectory, 'executor'));
    for (const name of ['sfl-secret-store', 'sfl-catalog-object-store']) {
      let unit = await readFile(join(candidate, 'database/bootstrap/systemd', `${name}@.service`), 'utf8');
      unit = unit.replaceAll('/opt/sfl/nodes/%i/current', '/opt/sfl/nodes/%i/runtime/internal')
        .replaceAll('01_core_hexin/services/commerce/dist/', '');
      await writeFile(join('/etc/systemd/system', `${name}@${context.node}.service`), unit);
    }
    const dropIn = join('/etc/systemd/system', `sfl-secret-store@${context.node}.service.d/instance.conf`);
    let secretOverride = await readFile(dropIn, 'utf8');
    secretOverride = secretOverride.replaceAll('/opt/zhudatuan/current/01_core_hexin/services/commerce/dist/LocalSecretsMain.js', join(internal, 'LocalSecretsMain.js'))
      .replaceAll('/opt/zhudatuan/current', internal);
    if (!secretOverride.includes('--retry-connrefused')) secretOverride = secretOverride.replace('--max-time 10', '--retry 20 --retry-connrefused --retry-delay 1 --max-time 10');
    await writeFile(dropIn, secretOverride);
    const objectFile = join(runtime, 'object-store.env');
    const objectStats = await lstat(objectFile);
    const objectEnv = parseEnvironmentFile(await readFile(objectFile, 'utf8'));
    const nodeManifest = await readJson(join(executionDirectory, 'node-runtime/manifest.json'));
    objectEnv.LOCAL_OBJECTS_DIRECTORY = '/var/lib/sfl-' + context.node + '-objects';
    Object.assign(objectEnv, {
      NODE_MANIFEST_PATH: join(executionDirectory, 'node-runtime/manifest.json'), NODE_MANIFEST_ID: nodeManifest.manifest_id,
      NODE_MANIFEST_DIGEST: nodeManifest.manifest_digest, NODE_RUNTIME_INSTANCE_ID: nodeManifest.runtime_instance_id,
      NODE_RUNTIME_CONFIG_REF: nodeManifest.runtime_config_ref.ref,
      NODE_RESOURCE_BINDING_VERSION: nodeManifest.resource_binding_set_ref.version,
      NODE_RELEASE_POINTER_REF: nodeManifest.release_pointer_ref.ref,
    });
    await writeFile(objectFile, environmentText(objectEnv));
    await chmod(objectFile, objectStats.mode & 0o777);
    await command(['chown', `${objectStats.uid}:${objectStats.gid}`, objectFile]);
    await command(['systemctl', 'daemon-reload']);
    for (const name of ['sfl-secret-store', 'sfl-catalog-object-store']) {
      const service = `${name}@${context.node}.service`;
      await command(['systemctl', 'enable', service]);
      await restart({kind:'systemd',name:service});
    }
  }
  const runner = resolve(executionDirectory, definition.runner);
  const migrationDirectory = resolve(executionDirectory, definition.migrationDirectory);
  assert(runner.startsWith(`${executionDirectory}/`) && migrationDirectory.startsWith(`${executionDirectory}/`), 'DATABASE_MIGRATION_EXECUTION_PATH_UNSAFE', { runner, migrationDirectory });
  const environment = {
    PATH: process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    NODE_ENV: 'production',
    ...parseEnvironmentFile(await readFile(environmentFile, 'utf8')),
    ...(credentialFile === null ? {} : parseEnvironmentFile(await readFile(credentialFile, 'utf8'))),
    APP_ENV: 'production',
    REGISTRATION_MIGRATION_PROFILE: 'registration-only',
    MIGRATION_DIRECTORY: migrationDirectory,
    AI_DELIVERY_SOURCE_SHA: manifest.sourceSha,
    AI_DELIVERY_TREE_DIGEST: manifest.treeDigest,
    NODE_BOOTSTRAP_MANIFEST_FILE: join(executionDirectory,'node-runtime/manifest.json'),
    NODE_BOOTSTRAP_IDENTITY_FILE: join(executionDirectory,'node-runtime/identity-node-projection.json'),
    DATABASE_MIGRATION_EXECUTION_MODE: definition.initialize?.applyBusiness ? 'node-registration' : definition.executionMode ?? 'migration-role',
    ...(definition.ownerDatabaseHost === undefined ? {} : { MIGRATION_OWNER_DATABASE_HOST: definition.ownerDatabaseHost }),
    ...(definition.ownerDatabasePort === undefined ? {} : { MIGRATION_OWNER_DATABASE_PORT: String(definition.ownerDatabasePort) }),
  };
  const identity = await runtimeIdentity(definition);
  try {
    const executed = await command([definition.nodeBinary ?? '/usr/bin/node', runner], {
      cwd: executionDirectory,
      env: environment,
      uid: identity.uid,
      gid: identity.gid,
      timeoutMs: definition.timeoutMs ?? 300_000,
    });
    const result = parseJsonOutput(executed.stdout);
    assert(result?.schema === 'ai.delivery.database-migration-result.v1' && result.sourceSha === manifest.sourceSha, 'DATABASE_MIGRATION_RESULT_INVALID', { executionDirectory });
    assert(['applied', 'noop'].includes(result.status), 'DATABASE_MIGRATION_RESULT_FAILED', { databaseMigration: result });
    return { ...result, executionDirectory, credentialSources: [environmentFile, ...(credentialFile === null ? [] : [credentialFile])], restart: restartEvidence(context.deployment.restart, false) };
  } catch (error) {
    const reported = parseJsonOutput(error?.details?.outputTail ?? '', false);
    const databaseMigration =
      reported?.schema === 'ai.delivery.database-migration-result.v1'
        ? { ...reported, executionDirectory, credentialSources: [environmentFile, ...(credentialFile === null ? [] : [credentialFile])], restart: restartEvidence(context.deployment.restart, false) }
        : {
            schema: 'ai.delivery.database-migration-result.v1',
            sourceSha: manifest.sourceSha,
            status: 'failed',
            selectionStatus: 'unavailable',
            selected: null,
            ledgerBefore: null,
            ledgerAfter: null,
            applied: null,
            error: errorEvidence(error),
            executionDirectory,
            credentialSources: [environmentFile, ...(credentialFile === null ? [] : [credentialFile])],
            restart: restartEvidence(context.deployment.restart, false),
          };
    throw failure('DATABASE_MIGRATION_EXECUTOR_FAILED', { databaseMigration });
  }
}

async function recordNodeResources(context, update) {
  const directory = '/var/lib/sfl-autonode-control/resources';
  const file = join(directory, `${context.node}.json`);
  const stored = await readJson(file);
  const previous = stored?.state === 'DELETED' ? {} : stored ?? {};
  const nodeRoot = join('/opt/sfl/nodes', context.node);
  const services = ['storefront', 'identity-api', 'web-api', 'catalog-api', 'purchase-api',
    'payment-webhook-api', 'catalog-jobs', 'payment-jobs', 'catalog-object-store',
    'secret-store', 'api-gateway', 'cloudflared'].map((name) => `sfl-${name}@${context.node}.service`);
  const dnsRecords = [...(previous.dnsRecords ?? [])];
  if (update.dnsRecord && !dnsRecords.some((entry) => entry.zoneId === update.dnsRecord.zoneId && entry.id === update.dnsRecord.id)) {
    dnsRecords.push(update.dnsRecord);
  }
  const { dnsRecord, ...fields } = update;
  const resource = {
    database: { container: `${context.node}-postgres`, dataDirectory: join(nodeRoot, 'database/data') },
    ...previous, ...fields, state: 'PROVISIONED', node: context.node, nodeRoot, services, dnsRecords,
    objectDirectory: `/var/lib/sfl-${context.node}-objects`,
    networks: [`${context.node}_registration`, `${context.node}-database-link`],
    updatedAt: new Date().toISOString(),
  };
  await mkdir(directory, { recursive: true, mode: 0o750 });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(resource, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

function parseEnvironmentFile(source) {
  const environment = {};
  for (const [index, raw] of source.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    assert(match, 'DATABASE_MIGRATION_ENVIRONMENT_LINE_INVALID', { line: index + 1 });
    const value = match[2].trim();
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
      environment[match[1]] = value.slice(1, -1);
    } else {
      environment[match[1]] = value;
    }
  }
  return environment;
}

async function runtimeIdentity(definition) {
  if (!definition.runtimeUser && !definition.runtimeGroup) return { uid: undefined, gid: undefined };
  const user = safeName(required(definition.runtimeUser, 'DATABASE_MIGRATION_RUNTIME_USER_REQUIRED'));
  const group = safeName(required(definition.runtimeGroup, 'DATABASE_MIGRATION_RUNTIME_GROUP_REQUIRED'));
  const uidResult = await command(['id', '-u', user]);
  const groupResult = await command(['id', '-gn', user]);
  assert(groupResult.stdout.trim() === group, 'DATABASE_MIGRATION_RUNTIME_GROUP_INVALID', { user, group });
  const gidResult = await command(['id', '-g', user]);
  const uid = Number(uidResult.stdout.trim());
  const gid = Number(gidResult.stdout.trim());
  assert(Number.isInteger(uid) && uid >= 0 && Number.isInteger(gid) && gid >= 0, 'DATABASE_MIGRATION_RUNTIME_ID_INVALID', { user, group });
  return { uid, gid };
}

function parseJsonOutput(output, requiredOutput = true) {
  for (const line of String(output).trim().split('\n').reverse()) {
    try {
      return JSON.parse(line);
    } catch {}
  }
  assert(!requiredOutput, 'DATABASE_MIGRATION_RESULT_MISSING');
  return null;
}

function databaseRecoveryEvidence(definition) {
  return {
    mode: definition.recovery?.mode ?? 'forward-only',
    snapshot: definition.recovery?.snapshot ?? 'not-captured-by-delivery-engine',
    databaseRollback: 'not-performed',
  };
}

async function rollback(context, { requestId, controlSha } = {}) {
  const root = context.deployment.pointerRoot;
  assertAllowedRoot(context.policy, root);
  if (context.deployment.databaseMigration) {
    throw failure('DATABASE_ROLLBACK_UNSUPPORTED', {
      recovery: databaseRecoveryEvidence(context.deployment.databaseMigration),
      pointerAction: 'not-performed',
      current: await pointer(root, 'current'),
      previous: await pointer(root, 'previous'),
    });
  }
  const records = await rollbackRequestRecords(context, requestId);
  const { intentPath, receipt } = records;
  let { request, receiptId, receiptPath } = records;
  if (receipt) return { ...receipt, replayed: true };

  let { pair, observed, pointerStates } = await observeRollbackPlacement(root);
  if (intentPath && !request) request = await readRollbackRecord(intentPath);
  const pending = request ? null : await unfinishedRollback(context, pair, observed, pointerStates);
  if (intentPath && !request) {
    request = await claimRollbackRecord(intentPath, {
      plan: pending?.plan ?? observed,
      pair,
      pointerStates,
      startedAt: pending?.startedAt ?? Date.now(),
      receiptId: pending?.requestId ?? requestId,
      ...(pending?.pointerJournal ? { pointerJournal: pending.pointerJournal } : {}),
      ...(pending && !pending.pointerJournal ? { legacyResume: true } : {}),
      ...(pending?.ordinaryRuntime ? { ordinaryRuntime: pending.ordinaryRuntime } : {}),
    });
  }
  if (request) {
    receiptId = request.receiptId;
    receiptPath = rollbackRecordPath(context, receiptId, 'receipt');
    const saved = await followRollbackExecution(context, receiptId, receiptPath);
    if (saved) return { ...saved, replayed: true };
    ({ pair, observed, pointerStates } = await observeRollbackPlacement(root));
  }
  const plan = request?.plan ?? pending?.plan ?? observed;
  const pointerJournal = request?.pointerJournal ?? pending?.pointerJournal ?? (receiptId
    ? rollbackRecordPath(context, receiptId, 'pointer-generations')
    : join(root, 'state', 'cutovers', `rollback-${randomBytes(12).toString('hex')}.pointers.json`));
  let journal = await readRollbackRecord(pointerJournal);
  let progress = journal ? rollbackJournalProgress(journal, pointerStates) : 0;
  const sameStart = !request || (stableJson(request.pair) === stableJson(pair) &&
    (!request.pointerStates || stableJson(request.pointerStates) === stableJson(pointerStates)));
  const adoptedLegacy = Boolean(pending && !pending.pointerJournal || request?.legacyResume && sameStart);
  if ((journal && (progress < 0 || stableJson(journal.plan) !== stableJson(plan))) ||
      (!journal && (!sameStart || (!adoptedLegacy && stableJson(plan) !== stableJson(observed))))) {
    await reportRollbackEvidence(context, observed, 'The pointer generations no longer match the original rollback request.');
  }
  const resumed = progress > 0 || adoptedLegacy || journal?.resuming === true;
  const { current, previous: requestedPrevious, runtime: currentRuntime, previousRuntime } = plan;
  assert(requestedPrevious, 'ROLLBACK_POINTER_MISSING');
  const previous = await verifiedRollbackTarget(context, requestedPrevious, observed, journal?.target);
  if (journal?.restart?.systemdClient && journal.target !== previous &&
      await readRollbackSystemdJob(context, pointerJournal, journal, observed)) {
    await reportRollbackEvidence(context, observed, 'The original restart already ran against a different release copy.',
      { restart: rollbackRestartReceipt(context.deployment.restart, journal) });
  }
  const continueRestart = journal?.target === previous && Boolean(journal.restart);
  let resumedProcess = continueRestart ? await observeRollbackRestart(context, pointerJournal, journal, progress, observed) : null;
  const runtimeRecordPath = receiptId && rollbackRecordPath(context, receiptId, 'ordinary-runtime');
  const savedRuntime = runtimeRecordPath ? await readRollbackRecord(runtimeRecordPath) : null;
  const recordedRuntime = savedRuntime ?? request?.ordinaryRuntime ?? pending?.ordinaryRuntime;
  const ordinaryRuntime = continueRestart ? null : await rollbackOrdinaryRuntime(context, current, previous, observed, recordedRuntime);
  if (!continueRestart) await ensureTraversablePointerRoot(context);
  const protectedBefore = await protectedProcessSnapshot(context);
  const started = performance.now();
  const timings = { pointer: 0, restart: 0, readiness: 0, isolation: 0, total: 0 };
  const live = await observeRollbackPlacement(root);
  const finishedRequest = receiptPath && await readRollbackRecord(receiptPath);
  if (finishedRequest) return { ...finishedRequest, replayed: true };
  if (stableJson(live.pair) !== stableJson(pair) || stableJson(live.pointerStates) !== stableJson(pointerStates)) {
    await reportRollbackEvidence(context, live.observed, 'The placement pointers changed while the rollback was being resolved.');
  }
  if (ordinaryRuntime && runtimeRecordPath && !savedRuntime) {
    const saved = await claimRollbackRecord(runtimeRecordPath, ordinaryRuntime.evidence);
    if (stableJson(saved) !== stableJson(ordinaryRuntime.evidence)) {
      await reportRollbackEvidence(context, observed, 'The original rollback request recorded a different ordinary runtime backup.');
    }
  }
  if (!journal || journal.target !== previous) {
    const superseded = journal ? [...(journal.superseded ?? []), ...journal.steps.slice(progress)] : [];
    journal = await createRollbackPointerJournal(root, pointerJournal, plan, pointerStates, previous, resumed, superseded);
    progress = 0;
  }
  if (journal.superseded?.length) {
    await discardSupersededRollbackStages(root, journal.superseded);
    delete journal.superseded;
    await writeAtomicJson(pointerJournal, journal);
  }
  await markCutover(root, {
    rollback: plan, rollbackStartedAt: request?.startedAt ?? pending?.startedAt ?? Date.now(), rollbackRequestId: receiptId,
    pointerJournal,
    ...(ordinaryRuntime || recordedRuntime ? { ordinaryRuntime: ordinaryRuntime?.evidence ?? recordedRuntime } : {}),
  }, { required: true });
  let restartOperation;
  try {
    let processBeforeRestart;
    let processBefore;
    if (!continueRestart) {
      await chmod(previous, 0o755);
      const pointerStarted = performance.now();
      const runtimeTransition = await captureRuntimeTransition(context, current, previous, {
        capture: !resumed, ...(ordinaryRuntime ? { fromSnapshot: true } : {}),
      });
      await applyRollbackPointerJournal(root, journal, progress);
      if (ordinaryRuntime) {
        await applyNodeRuntime(ordinaryRuntime.entries);
      } else if (runtimeTransition) {
        const restored = await restoreNodeRuntime(installedNodeRuntimePath(context, previous));
        if (restored && context.target === 'storefront') {
          await restoreStorefrontPublicEnvironment(context, previous);
        } else if (!restored && !(await installNodeRuntime(context, previous))) {
          await restoreOrdinaryRuntime(context, current, runtimeTransition, previous);
        }
      }
      timings.pointer = elapsedMs(pointerStarted);
    }
    if (resumedProcess) {
      restartOperation = { ...rollbackRestartReceipt(context.deployment.restart, journal), reusedRunningProcess: true };
    } else {
      processBeforeRestart = await cutoverProcess(context);
      processBefore = processBeforeRestart?.process ?? await observeProcess(context);
      const restartStarted = performance.now();
      ({ operation: restartOperation, before: processBefore, reused: resumedProcess } =
        await restartRollbackProcess(context, pointerJournal, journal, processBefore));
      if (!resumedProcess || restartOperation.commandCount > 0) timings.restart = elapsedMs(restartStarted);
    }
    const readiness = await waitForReadiness(context, { candidateDir: previous, currentDir: previous, ...contextSummary(context) });
    timings.readiness = readiness.durationMs;
    const running = resumedProcess
      ? await verifyResumedRollbackProcess(context, previous, resumedProcess)
      : await verifyCutoverProcess(context, previous, processBefore);
    const isolationStarted = performance.now();
    const protectedAfter = await assertProtectedUnchanged(context, protectedBefore);
    timings.isolation = elapsedMs(isolationStarted);
    timings.total = elapsedMs(started);
    const { pair: finishedPointers, observed: finished, pointerStates: finishedStates } = await observeRollbackPlacement(root);
    const { runtime: finishedRuntime, previousRuntime: finishedPreviousRuntime } = finished;
    const releases = await releasePointersForStatus(root, finishedPointers.map((entry) => entry?.target ?? null));
    if (releases.current !== previous || releases.previous !== current ||
        finishedRuntime !== previousRuntime || finishedPreviousRuntime !== currentRuntime ||
        rollbackJournalProgress(journal, finishedStates) !== journal.steps.length ||
        (processBeforeRestart && stableJson(finishedPointers) !== stableJson(processBeforeRestart.pointers))) {
      throw failure('CUTOVER_SUPERSEDED', releases);
    }
    const completion = {
      pointers: finishedPointers,
      process: running,
      confirmedAt: Date.now(),
      closedMarkers: [cutoverMarker, ...(pending?.markers ?? [])].filter(Boolean).map((marker) => basename(marker)),
    };
    const result = { ...releases, controlSha, remoteAgent: fileURLToPath(import.meta.url), resumed: resumed || continueRestart, runtime: finishedRuntime, previousRuntime: finishedPreviousRuntime, completion, restart: restartOperation, readiness, timings, rollbackMs: timings.total, protectedProcesses: { before: protectedBefore, after: protectedAfter } };
    if (receiptPath) {
      const recorded = await claimRollbackRecord(receiptPath, result);
      if (recorded !== result) return { ...recorded, replayed: true };
    }
    if (await recordConfirmedCutover(root, completion) && pending) {
      await Promise.all(pending.markers.map((marker) => rm(marker, { force: true }).catch(() => {})));
    }
    return result;
  } catch (error) {
    const restart = error?.details?.restart ?? restartOperation ??
      (journal.restart?.job ? rollbackRestartReceipt(context.deployment.restart, journal) : null);
    if (error?.code === 'ROLLBACK_EVIDENCE_INSUFFICIENT') {
      if (restart) error.details.restart = restart;
      throw error;
    }
    const observations = await Promise.allSettled([
      pointer(root, 'current'), pointer(root, 'previous'), pointer(root, 'runtime'), pointer(root, 'previous-runtime'), processState(context.deployment.restart),
    ]);
    const observed = (index) => observations[index].status === 'fulfilled' ? observations[index].value : { error: errorEvidence(observations[index].reason) };
    const [currentArtifact, previousArtifact] = await Promise.all([observed(0), observed(1)].map((release) =>
      typeof release === 'string' ? artifactForStatus(root, release).catch(() => null) : null));
    throw failure('ROLLBACK_FAILED', {
      rollbackFailure: errorEvidence(error),
      ...(restart ? { restart } : {}),
      pointerJournal,
      originalCurrent: current,
      attemptedCurrent: requestedPrevious,
      selectedCurrent: previous,
      current: observed(0),
      currentArtifact,
      previous: observed(1),
      previousArtifact,
      runtime: observed(2),
      previousRuntime: observed(3),
      serviceStatus: observed(4),
      timings: { ...timings, total: elapsedMs(started) },
      nextAction: 'Run status or retry rollback for this target and physical node to finish the recorded rollback.',
    });
  }
}

function rollbackRecordPath(context, requestId, kind) {
  const key = createHash('sha256').update(stableJson({ ...contextSummary(context), requestId })).digest('hex');
  return join(context.deployment.pointerRoot, 'state', 'rollback-requests', `${key}-${kind}.json`);
}

async function rollbackRequestRecords(context, requestId) {
  const intentPath = requestId && rollbackRecordPath(context, requestId, 'intent');
  const request = intentPath ? await readRollbackRecord(intentPath) : null;
  const receiptId = request?.receiptId ?? requestId;
  const receiptPath = receiptId && rollbackRecordPath(context, receiptId, 'receipt');
  const receipt = receiptPath ? await readRollbackRecord(receiptPath) : null;
  return { intentPath, request, receiptId, receiptPath, receipt };
}

async function observeRollbackPlacement(root) {
  const [pair, pointerStates] = await Promise.all([
    observePointerPair(root), observePointerPair(root, ROLLBACK_POINTER_NAMES, { stableAcrossRename: true }),
  ]);
  const [current, previous, runtime, previousRuntime] = pointerStates.map((entry) => entry?.target ?? null);
  return { pair, pointerStates, observed: { current, previous, runtime, previousRuntime } };
}

async function createRollbackPointerJournal(root, path, plan, before, target, resuming, superseded) {
  const destinations = [target, plan.current, plan.previousRuntime, plan.runtime];
  const nonce = randomBytes(12).toString('hex');
  const steps = [];
  try {
    for (const [index, name] of ROLLBACK_POINTER_NAMES.entries()) {
      const destination = destinations[index];
      if ((before[index]?.target ?? null) === destination) continue;
      if (!destination) {
        steps.push({ index, staged: null, next: null });
        continue;
      }
      const staged = `.rollback-${nonce}-${name}`;
      await symlink(destination, join(root, staged));
      steps.push({ index, staged, next: null });
      [steps.at(-1).next] = await observePointerPair(root, [staged], { stableAcrossRename: true });
      assert(steps.at(-1).next?.target === destination, 'ROLLBACK_STAGED_POINTER_UNAVAILABLE', { name });
    }
    const journal = { plan, before, target, steps, resuming, ...(superseded.length ? { superseded } : {}) };
    await writeAtomicJson(path, journal);
    return journal;
  } catch (error) {
    await Promise.all(steps.filter(({ staged }) => staged).map(({ staged }) => rm(join(root, staged), { force: true }).catch(() => {})));
    throw error;
  }
}

function rollbackJournalProgress(journal, pointers) {
  if (!Array.isArray(journal.before) || !Array.isArray(journal.steps)) return -1;
  const state = [...journal.before];
  const observed = stableJson(pointers);
  if (stableJson(state) === observed) return 0;
  for (const [index, step] of journal.steps.entries()) {
    if (!step || !ROLLBACK_POINTER_NAMES[step.index]) return -1;
    state[step.index] = step.next;
    if (stableJson(state) === observed) return index + 1;
  }
  return -1;
}

function rollbackStagedPointerName(index, staged) {
  const name = ROLLBACK_POINTER_NAMES[index];
  return Boolean(name && new RegExp(`^\\.rollback-[a-f0-9]{24}-${name}$`).test(staged));
}

async function discardSupersededRollbackStages(root, steps) {
  for (const { index, staged, next } of steps) {
    if (!staged || !next || !rollbackStagedPointerName(index, staged)) continue;
    const [state] = await observePointerPair(root, [staged], { stableAcrossRename: true });
    if (stableJson(state) !== stableJson(next)) continue;
    await rm(join(root, staged)).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

async function applyRollbackPointerJournal(root, journal, progress) {
  const remaining = journal.steps.slice(progress);
  for (const { index, staged, next } of remaining) {
    const name = ROLLBACK_POINTER_NAMES[index];
    if (!name || (staged ? !rollbackStagedPointerName(index, staged) || !next : next !== null)) {
      throw failure('ROLLBACK_POINTER_JOURNAL_INVALID', { name, pointerAction: 'not-performed' });
    }
    if (staged) {
      const [state] = await observePointerPair(root, [staged], { stableAcrossRename: true });
      assert(stableJson(state) === stableJson(next), 'ROLLBACK_STAGED_POINTER_UNAVAILABLE', { name, pointerAction: 'not-performed' });
    }
  }
  const current = await observePointerPair(root, ROLLBACK_POINTER_NAMES, { stableAcrossRename: true });
  assert(rollbackJournalProgress(journal, current) === progress, 'ROLLBACK_POINTER_GENERATION_CHANGED', { pointerAction: 'not-performed' });
  for (const { index, staged } of remaining) {
    const path = join(root, ROLLBACK_POINTER_NAMES[index]);
    if (staged) await rename(join(root, staged), path);
    else await rm(path, { force: true });
  }
}

async function observeRollbackRestart(context, path, journal, progress, observed, { requireJob = false } = {}) {
  if (progress !== journal.steps.length) {
    return reportRollbackEvidence(context, observed, 'The restart record no longer matches the final rollback pointer generations.');
  }
  const job = await readRollbackSystemdJob(context, path, journal, observed, { executed: requireJob });
  if (requireJob && !job) {
    return reportRollbackEvidence(context, observed, 'The restart client did not leave evidence of the original systemd job.',
      { restart: rollbackRestartReceipt(context.deployment.restart, journal) });
  }
  const { service, running } = await settledRollbackService(context, observed, path, journal);
  const boot = await rollbackBootId();
  const live = await observeRollbackPlacement(context.deployment.pointerRoot);
  if (rollbackJournalProgress(journal, live.pointerStates) !== journal.steps.length) {
    return reportRollbackEvidence(context, live.observed, 'The pointer generations changed while waiting for the recorded restart.');
  }
  return classifyRollbackRestart(context, journal, live.observed, service, running, boot, job);
}

async function classifyRollbackRestart(context, journal, observed, service, running, boot, job) {
  const saved = journal.restart;
  const sameProcess = boot === saved.boot && running.pid === saved.before.pid && running.started === saved.before.started;
  const release = await processRelease(context.deployment.pointerRoot, journal.target, running.cwd);
  const onTarget = running.started && !sameProcess && release === 'current';
  if (job && onTarget && service.activeState === 'active') return running;
  if (!job && service.kind !== 'systemd' && onTarget) return running;
  const stopped = service.pid === '0' && ['inactive', 'failed'].includes(service.activeState);
  const unchangedRunningProcess = sameProcess && running.started && service.activeState === 'active';
  const unchangedService = saved.service && stableJson(saved.service) === stableJson(service);
  const oldProcessStillRunning = unchangedRunningProcess && release === 'other';
  if (job || saved.clientTimedOut || saved.jobObserved || (service.kind === 'systemd' && (onTarget || saved.failed))) {
    return reportRollbackEvidence(context, observed, job
      ? 'The original systemd job finished, but the target release is not confirmed in the running process.'
      : 'The original systemd job ID and final result could not be confirmed.',
    { restart: rollbackRestartReceipt(context.deployment.restart, journal) });
  }
  if (!saved.jobObserved && service.kind === 'systemd' && sameProcess &&
      (saved.service ? unchangedService && (stopped || unchangedRunningProcess) : oldProcessStillRunning)) return null;
  if (saved.failed && !saved.jobObserved && (stopped || oldProcessStillRunning)) return null;
  return reportRollbackEvidence(context, observed, 'The running process does not confirm the recorded rollback restart.');
}

async function restartRollbackProcess(context, path, journal, before) {
  const definition = context.deployment.restart;
  if (restartEvidence(definition).kind === 'none') return { operation: restartEvidence(definition), before };
  const root = context.deployment.pointerRoot;
  const { observed } = await observeRollbackPlacement(root);
  const job = await readRollbackSystemdJob(context, path, journal, observed);
  const { service, running } = await settledRollbackService(context, observed, path, journal);
  const boot = await rollbackBootId();
  const { pointerStates } = await observeRollbackPlacement(root);
  assert(rollbackJournalProgress(journal, pointerStates) === journal.steps.length,
    'ROLLBACK_POINTER_GENERATION_CHANGED', { pointerAction: 'not-performed' });
  if (journal.restart) {
    const reused = await classifyRollbackRestart(context, journal, observed, service, running, boot, job);
    if (reused) return { operation: { ...rollbackRestartReceipt(definition, journal), reusedRunningProcess: true }, before: running, reused };
  }
  journal.restart = { before: running, boot, service };
  if (definition.kind === 'systemd') journal.restart.systemdClient = randomBytes(12).toString('hex');
  await writeAtomicJson(path, journal);
  if (definition.kind === 'systemd') {
    await runRollbackSystemdClient(path, journal.restart.systemdClient, definition);
    const reused = await observeRollbackRestart(context, path, journal, journal.steps.length, observed, { requireJob: true });
    return { operation: rollbackRestartReceipt(definition, journal, true), before: running, reused };
  }
  try {
    return { operation: await restart(definition, rollbackPlacementFd), before: running };
  } catch (error) {
    journal.restart.failed = true;
    await writeAtomicJson(path, journal);
    throw error;
  }
}

function rollbackRestartReceipt(definition, journal, executed = false) {
  const operation = restartEvidence(definition, executed);
  const saved = journal.restart;
  if (saved?.systemdClient && executed) operation.commands = [rollbackSystemdCommand(definition)];
  if (operation.kind !== 'systemd') return operation;
  return {
    ...operation,
    clientTimedOut: saved?.job ? saved.job.clientTimedOut ?? null : (saved?.clientTimedOut ? true : null),
    jobId: saved?.job?.id ?? null,
    jobResult: saved?.job?.result ?? null,
  };
}

function rollbackSystemdCommand(definition) {
  const [command, ...args] = restartEvidence(definition, true).commands[0];
  return [command, '--show-transaction', ...args];
}

function rollbackSystemdClientFiles(journalPath, attempt) {
  assert(/^[a-f0-9]{24}$/.test(attempt), 'ROLLBACK_SYSTEMD_CLIENT_RECORD_INVALID', { pointerAction: 'not-performed' });
  const prefix = `${journalPath}.restart-${attempt}`;
  return { log: `${prefix}.log`, exit: `${prefix}.exit` };
}

async function runRollbackSystemdClient(journalPath, attempt, definition) {
  const { log, exit } = rollbackSystemdClientFiles(journalPath, attempt);
  const script = `umask 077
log=$1
outcome=$2
shift 2
read -r started ignored < /proc/uptime || exit 1
printf 'started %s\\n' "$started" > "$log" || exit 1
LC_ALL=C SYSTEMD_LOG_LEVEL=debug SYSTEMD_LOG_TARGET=console SYSTEMD_LOG_LOCATION=0 SYSTEMD_COLORS=0 "$@" >> "$log" 2>&1
status=$?
read -r finished ignored < /proc/uptime || exit 1
printf '%s %s\\n' "$status" "$finished" > "$outcome.tmp" || exit 1
mv -- "$outcome.tmp" "$outcome"`;
  // Keep the original systemctl client listening for JobRemoved after the normal client deadline.
  await new Promise((resolvePromise, reject) => {
    const child = spawn('sh', ['-c', script, 'rollback-systemd', log, exit, ...rollbackSystemdCommand(definition)], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore', rollbackPlacementFd],
    });
    child.once('error', reject);
    child.once('close', resolvePromise);
  });
}

async function readRollbackSystemdJob(context, journalPath, journal, observed, { executed = false } = {}) {
  const saved = journal.restart;
  if (!saved?.systemdClient) return null;
  const definition = context.deployment.restart;
  if (!saved.job) {
    const { log, exit } = rollbackSystemdClientFiles(journalPath, saved.systemdClient);
    const [logRecord, exitRecord] = await Promise.allSettled([log, exit].map((file) => readFile(file, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    })));
    if (logRecord.status === 'rejected' || (logRecord.value === null && exitRecord.status === 'rejected')) {
      return reportRollbackEvidence(context, observed, 'The original systemd job record could not be read.',
        { restart: rollbackRestartReceipt(definition, journal, executed) });
    }
    const output = logRecord.value;
    const finished = exitRecord.status === 'fulfilled' ? exitRecord.value : null;
    if (output === null && finished === null) return null;
    const unit = definition.name;
    const lines = output?.split(/\r?\n/) ?? [];
    const watches = lines.map((line) => /^Adding \/org\/freedesktop\/systemd1\/job\/([1-9]\d*) to the set\.?$/.exec(line)).filter(Boolean);
    const anchors = lines.map((line) => /^Enqueued anchor job ([1-9]\d*) ([^\s/]+)\/[a-z-]+\.$/.exec(line)).filter(Boolean);
    const results = lines.map((line) => /^Got result ([a-z-]+)\/.* for job (\S+)$/.exec(line)).filter(Boolean);
    const startedAt = /^started (\d+(?:\.\d+)?)$/.exec(lines[0])?.[1];
    const completion = /^(\d+)(?:[ \t]+(\S+))?$/.exec(finished?.trim() ?? '');
    const id = watches.length === 1 ? watches[0][1] : null;
    const result = results.length === 1 && [unit, `${unit}.`].includes(results[0][2]) ? results[0][1] : null;
    const finishedAt = completion?.[2];
    const durationMs = startedAt && /^\d+(?:\.\d+)?$/.test(finishedAt ?? '')
      ? Math.round((Number(finishedAt) - Number(startedAt)) * 1000) : null;
    const clientTimedOut = Number.isFinite(durationMs) && durationMs >= 0 ? durationMs >= RESTART_CLIENT_TIMEOUT_MS : null;
    const bound = id && (anchors.length === 0 || anchors.length === 1 && anchors[0][1] === id && anchors[0][2] === unit);
    if (!bound || !result) {
      return reportRollbackEvidence(context, observed, 'The original systemd job ID and final result could not be confirmed.',
        { restart: { ...rollbackRestartReceipt(definition, journal, executed), jobId: bound ? Number(id) : null,
          clientTimedOut } });
    }
    saved.job = { id: Number(id), result, exitCode: completion ? Number(completion[1]) : null, clientTimedOut };
    await writeAtomicJson(journalPath, journal);
  }
  const restart = rollbackRestartReceipt(definition, journal, executed);
  if (saved.job.result === 'skipped' || (saved.job.result === 'done' && saved.job.exitCode != null && saved.job.exitCode !== 0)) {
    return reportRollbackEvidence(context, observed, 'The original systemd job did not confirm a completed restart.', { restart });
  }
  if (saved.job.result !== 'done') {
    const releases = await releasePointersForStatus(context.deployment.pointerRoot, [observed.current, observed.previous]);
    throw failure('RESTART_COMMAND_FAILED', { ...observed, ...releases, restart, pointerAction: 'not-performed' });
  }
  return saved.job;
}

async function settledRollbackService(context, observed, path, journal) {
  const definition = context.deployment.restart;
  const timeoutMs = readinessSettings(context).timeoutMs;
  let deadline = performance.now() + timeoutMs;
  for (;;) {
    const service = await processState(definition, { includeRestartState: true }).catch(() => null);
    if (!service) return reportRollbackEvidence(context, observed, 'The selected service restart state could not be read.');
    if (service.kind === 'systemd' && (service.loadState !== 'loaded' || service.job === null ||
        !/^\d+$/.test(service.pid ?? '') || !/^\d+$/.test(service.stateChange ?? '') ||
        !/^(?:[a-f0-9]{32})?$/.test(service.invocation ?? '-'))) {
      return reportRollbackEvidence(context, observed, 'Systemd did not report the selected service job and invocation state.');
    }
    const pending = service.kind === 'systemd' &&
      (Boolean(service.job) || ['activating', 'deactivating', 'reloading', 'refreshing'].includes(service.activeState) ||
        service.subState === 'auto-restart' || service.subState === 'auto-restart-queued');
    if (pending) {
      if (journal.restart?.job) {
        return reportRollbackEvidence(context, observed, 'A separate service transition started after the original systemd job finished.',
          { restart: rollbackRestartReceipt(definition, journal) });
      }
      deadline = performance.now() + timeoutMs;
      if (journal.restart && !journal.restart.jobObserved) {
        journal.restart.jobObserved = true;
        await writeAtomicJson(path, journal);
      }
    } else {
      const running = await observeProcess(context);
      const confirmed = await processState(definition, { includeRestartState: true }).catch(() => null);
      if (service.pid === running.pid && stableJson(service) === stableJson(confirmed)) return { service, running };
    }
    if (performance.now() >= deadline) {
      return reportRollbackEvidence(context, observed, 'The selected service restart is still in progress or its state is changing.');
    }
    await delay(Math.min(500, Math.max(1, deadline - performance.now())));
  }
}

async function verifyResumedRollbackProcess(context, release, before) {
  const running = await observeProcess(context);
  if (running.pid !== before.pid || running.started !== before.started ||
      await processRelease(context.deployment.pointerRoot, release, running.cwd) !== 'current') {
    throw failure('RUNNING_RELEASE_UNCONFIRMED', { current: release, before, process: running });
  }
  return running;
}

async function rollbackBootId() {
  return (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
}

async function followRollbackExecution(context, receiptId, receiptPath) {
  const started = await processStartToken(process.pid);
  if (!started) throw failure('ROLLBACK_EXECUTION_IDENTITY_UNAVAILABLE', { requestId: receiptId });
  const boot = await rollbackBootId();
  const execution = { pid: process.pid, started, boot, id: randomBytes(12).toString('hex') };
  let kind = 'execution';
  while (true) {
    const receipt = await readRollbackRecord(receiptPath);
    if (receipt) return receipt;

    const path = rollbackRecordPath(context, receiptId, kind);
    let owner = await readRollbackRecord(path);
    if (!owner) {
      if (kind !== 'execution' || !(await activeRollbackMarker(context.deployment.pointerRoot, receiptId))) {
        owner = await claimRollbackRecord(path, execution);
        if (owner === execution) return await readRollbackRecord(receiptPath);
      }
    }
    // Every contender follows the same successor record when an execution exits without a receipt.
    if (owner && (owner.boot !== boot || await processStartToken(owner.pid) !== owner.started)) {
      kind = `execution-${owner.id}`;
      continue;
    }
    await delay(1_000);
  }
}

async function activeRollbackMarker(root, receiptId) {
  for (const { marker, pid, started } of await cutoverEntries(root)) {
    const record = await readJson(marker);
    if (record?.rollbackRequestId === receiptId && await processStartToken(pid) === started) return true;
  }
  return false;
}

async function readRollbackRecord(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function claimRollbackRecord(path, record) {
  // Linking the complete file lets repeat callers share a single immutable plan or receipt.
  const staged = `${path}.${process.pid}.${randomBytes(6).toString('hex')}`;
  try {
    await writeAtomicJson(staged, record);
    try {
      await link(staged, path);
      return record;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      return await readRollbackRecord(path);
    }
  } finally {
    await rm(staged, { force: true }).catch(() => {});
  }
}

async function status(context, releases, layers) {
  const root = context.deployment.pointerRoot;
  const candidate = await statusPointer(root, 'candidate');
  return {
    pointerRoot: root,
    candidate,
    candidateArtifact: await artifactForStatus(root, candidate),
    ...(releases ?? await releasePointersForStatus(root)),
    runtime: layers ? layers[0]?.target ?? null : await statusPointer(root, 'runtime'),
    previousRuntime: layers ? layers[1]?.target ?? null : await statusPointer(root, 'previous-runtime'),
    restart: context.deployment.restart,
  };
}

async function releasePointersForStatus(root, pointers = null) {
  const [current, previous] = pointers ?? await Promise.all([statusPointer(root, 'current'), statusPointer(root, 'previous')]);
  const [currentArtifact, previousArtifact] = await Promise.all([artifactForStatus(root, current), artifactForStatus(root, previous)]);
  return { current, currentArtifact, previous, previousArtifact };
}

function nodeRuntimeRecoveryPath(context, release) {
  if (!release) return null;
  const key = createHash('sha256').update(canonicalArtifactPath(release)).digest('hex');
  return join(context.deployment.pointerRoot, 'state', 'node-runtime', key);
}

function nodeRuntimeDestinations(context) {
  const nodeRoot = join('/opt/sfl/nodes', context.node);
  const runtimeRoot = join(nodeRoot, 'runtime');
  const environment = ['identity-api', 'web-api', 'purchase-api', 'storefront'].includes(context.target)
    ? join(runtimeRoot, `${context.target}.env`) : null;
  const centralFile = context.target === 'console' ? 'console-runtime.json'
    : context.target === 'auth-web' ? 'identity-runtime.json' : null;
  return { environment, centralFile, central: centralFile ? join(runtimeRoot, centralFile) : null };
}

async function readNodeRuntimeManifest(release) {
  if (!release) return null;
  return readJson(join(release, 'node-runtime', 'manifest.json'));
}

function installedNodeRuntimePath(context, release) {
  return release ? join(nodeRuntimeRecoveryPath(context, release), 'installed') : null;
}

function ordinaryNodeRuntimePath(context) {
  return join(context.deployment.pointerRoot, 'state', 'node-runtime', 'ordinary');
}

async function captureRuntimeTransition(context, current, next, { capture = true, fromSnapshot: knownSnapshot } = {}) {
  const [fromSnapshot, toSnapshot] = await Promise.all([
    knownSnapshot ?? readNodeRuntimeManifest(current), readNodeRuntimeManifest(next),
  ]);
  if (!fromSnapshot && !toSnapshot) return null;
  if (!capture) return { fromSnapshot: Boolean(fromSnapshot) };
  const outgoing = installedNodeRuntimePath(context, current) ?? nodeRuntimeRecoveryPath(context, next);
  await captureNodeRuntime(context, outgoing);
  if (!fromSnapshot) await captureNodeRuntime(context, ordinaryNodeRuntimePath(context));
  return { outgoing, fromSnapshot: Boolean(fromSnapshot) };
}

async function restoreOrdinaryRuntime(context, current, transition, previous) {
  if (!transition?.fromSnapshot || await restoreNodeRuntime(ordinaryNodeRuntimePath(context))) return;
  // Before per-release snapshots, the snapshot install saved the ordinary config under its own release path.
  if (!(await readNodeRuntimeManifest(previous))) await restoreNodeRuntime(nodeRuntimeRecoveryPath(context, current));
}

async function rollbackOrdinaryRuntime(context, current, previous, observed, saved) {
  if (!saved && (!current || await readNodeRuntimeManifest(previous))) return null;
  const destinations = nodeRuntimeDestinations(context);
  const paths = [destinations.environment, destinations.central].filter(Boolean);
  if (!paths.length) return null;
  const root = context.deployment.pointerRoot;
  const currentDirectory = resolve(root, current);
  const artifact = await artifactForStatus(root, currentDirectory);
  const { manifestDigest, ...unsigned } = artifact ?? {};
  const contentAddressed = canonicalArtifactPath(currentDirectory) === (artifact?.engineVersion === 2 &&
    /^[a-f0-9]{40}$/.test(artifact.sourceSha ?? '') && /^sha256:[a-f0-9]{64}$/.test(artifact.treeDigest ?? '') &&
    /^sha256:[a-f0-9]{64}$/.test(manifestDigest ?? '') ? releasePath(context, artifact) : null);
  const trustedManifest = artifact?.project === context.project && artifact.target === context.target &&
    manifestDigest === digest(unsigned) && (artifact.engineVersion === 1 || contentAddressed);
  const recordedSnapshot = trustedManifest && artifact.entries?.some((entry) => entry.path === 'node-runtime/manifest.json');
  const runtimePath = join(root, 'current', 'node-runtime');
  const selectsSnapshot = (environment, central) => {
    const manifestPath = environment.match(/^[ \t]*(?:export[ \t]+)?NODE_MANIFEST_PATH[ \t]*=[ \t]*["']?([^"' \t\r\n#]+)/m)?.[1];
    return manifestPath === join(runtimePath, 'manifest.json') ||
      Boolean(central && destinations.centralFile && resolve(dirname(destinations.central), central) === join(runtimePath, destinations.centralFile));
  };
  try {
    const backups = [
      installedNodeRuntimePath(context, previous), ordinaryNodeRuntimePath(context), nodeRuntimeRecoveryPath(context, currentDirectory),
    ];
    const target = canonicalArtifactPath(previous);
    if (saved) {
      if (saved.target === target && backups.includes(saved.directory)) {
        const backup = await readOrdinaryRuntimeBackup(saved.directory, paths);
        if (backup && backup.digest === saved.backupDigest) return { entries: backup.entries, evidence: saved };
      }
      return reportRollbackEvidence(context, observed, 'The ordinary runtime backup recorded for this rollback is missing or has changed.');
    }
    const nodeRuntime = await readNodeRuntimeManifest(currentDirectory);
    if (!recordedSnapshot && !/^[a-f0-9]{40}$/.test(nodeRuntime?.release_pointer_ref?.source_sha ?? '')) {
      const activeEnvironment = destinations.environment && await lstatOrNull(destinations.environment)
        ? await readFile(destinations.environment, 'utf8') : '';
      const activeCentral = destinations.central && (await lstatOrNull(destinations.central))?.isSymbolicLink()
        ? await readlink(destinations.central) : null;
      if (!selectsSnapshot(activeEnvironment, activeCentral)) {
        if (trustedManifest || (!artifact && await releaseSourceSha(context, currentDirectory).catch(() => null))) return null;
        return reportRollbackEvidence(context, observed, 'The outgoing release and active runtime do not identify which configuration must be restored.');
      }
    }
    for (const directory of backups) {
      const backup = await readOrdinaryRuntimeBackup(directory, paths);
      if (!backup) continue;
      const environment = backup.entries.find((entry) => entry.path === destinations.environment);
      const central = backup.entries.find((entry) => entry.path === destinations.central);
      if (selectsSnapshot(environment?.body?.toString('utf8') ?? '', central?.target)) continue;
      return { entries: backup.entries, evidence: { target, directory, backupDigest: backup.digest } };
    }
  } catch (error) {
    return reportRollbackEvidence(context, observed, `The ordinary runtime backup could not be read (${error.code ?? 'unreadable'}).`);
  }
  return reportRollbackEvidence(context, observed, 'No complete ordinary runtime backup matches the rollback target.');
}

async function readOrdinaryRuntimeBackup(directory, paths) {
  const entries = await readJson(join(directory, 'before.json'));
  if (!Array.isArray(entries) || entries.length !== paths.length || paths.some((path) => !entries.some((entry) => entry?.path === path))) return null;
  if (entries.some((entry) => !['missing', 'link', 'file'].includes(entry.kind) ||
    (entry.kind === 'link' && typeof entry.target !== 'string') ||
    (entry.kind === 'file' && (!/^\d+$/.test(entry.backup ?? '') || ![entry.mode, entry.uid, entry.gid].every(Number.isInteger))))) return null;
  try {
    const backup = await Promise.all(entries.map(async (entry) => entry.kind === 'file'
      ? { ...entry, body: await readFile(join(directory, entry.backup)) } : entry));
    return { entries: backup, digest: digest(backup.map(({ body, ...entry }) =>
      body ? { ...entry, sha256: createHash('sha256').update(body).digest('hex') } : entry)) };
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
    throw error;
  }
}

async function captureNodeRuntime(context, directory) {
  const destinations = nodeRuntimeDestinations(context);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const entries = [];
  for (const path of [destinations.environment, destinations.central].filter(Boolean)) {
    const stats = await lstatOrNull(path);
    const entry = { path, kind: stats === null ? 'missing' : stats.isSymbolicLink() ? 'link' : 'file' };
    if (entry.kind === 'link') entry.target = await readlink(path);
    if (entry.kind === 'file') {
      entry.mode = stats.mode & 0o777;
      entry.uid = stats.uid;
      entry.gid = stats.gid;
      entry.backup = String(entries.length);
      await writeFile(join(directory, entry.backup), await readFile(path), { mode: 0o600 });
      await chmod(join(directory, entry.backup), 0o600);
    }
    entries.push(entry);
  }
  await writeAtomicJson(join(directory, 'before.json'), entries);
  return directory;
}

async function installNodeRuntime(context, release) {
  const manifest = await readNodeRuntimeManifest(release);
  if (!manifest) return false;
  const destinations = nodeRuntimeDestinations(context);
  const activeRuntime = join(context.deployment.pointerRoot, 'current', 'node-runtime');
  if (destinations.environment) {
    const path = destinations.environment;
    const stats = await lstat(path);
    const before = await readFile(path, 'utf8');
    const updates = {
      SERVICE_VERSION: manifest.release_pointer_ref.source_sha,
      NODE_MANIFEST_PATH: join(activeRuntime, 'manifest.json'),
      NODE_MANIFEST_ID: manifest.manifest_id,
      NODE_MANIFEST_DIGEST: manifest.manifest_digest,
      NODE_RUNTIME_INSTANCE_ID: manifest.runtime_instance_id,
      NODE_RUNTIME_CONFIG_REF: manifest.runtime_config_ref.ref,
      NODE_RESOURCE_BINDING_VERSION: manifest.resource_binding_set_ref.version,
      NODE_RELEASE_POINTER_REF: manifest.release_pointer_ref.ref,
    };
    if (['identity-api', 'web-api'].includes(context.target)) {
      const origins = manifest.domain_bindings.filter((binding) => binding.surface_ref !== 'surface:api').map((binding) => 'https://' + binding.host);
      const controllerOrigin = parseEnvironmentFile(before).IDENTITY_CONTROLLER_ORIGIN;
      if (context.target === 'identity-api' && controllerOrigin) origins.push(new URL(controllerOrigin).origin);
      updates.API_ALLOWED_ORIGINS = [...new Set(origins)].join(',');
    }
    if (context.target === 'purchase-api') {
      updates.API_ALLOWED_ORIGINS = manifest.domain_bindings.filter((binding) => binding.surface_ref === 'surface:storefront').map((binding) => `https://${binding.host}`).join(',');
    }
    if (context.target === 'web-api') {
      const projection = await readJson(join(release, 'node-runtime', 'identity-node-projection.json'));
      const node = projection?.nodes?.find((entry) => entry.nodeId === manifest.node_id);
      const storefrontTarget = node?.targets?.find((entry) => entry.surface === 'consumer');
      if (storefrontTarget?.application) {
        updates.PUBLIC_MALL_SLUG = storefrontTarget.application;
        updates.PUBLIC_MALL_HOST_MAPPINGS = `${new URL(node.storefrontOrigin).hostname}=${storefrontTarget.application}`;
      }
    }
    if (context.target === 'identity-api' && await exists(join(release, 'node-runtime', 'identity-runtime.json'))) {
      updates.NODE_IDENTITY_RUNTIME_PATH = join(activeRuntime, 'identity-runtime.json');
    }
    if (context.target === 'storefront') {
      const identity = await readJson(join(release, 'node-runtime', 'identity-runtime.json'));
      const node = identity?.identity_node_registry?.nodes?.find((entry) => entry.nodeId === manifest.node_id);
      if (node) {
        const registry = JSON.stringify(identity.identity_node_registry);
        const publicUpdates = {
          NEXT_PUBLIC_API_BASE_URL: node.apiOrigin,
          NEXT_PUBLIC_AUTH_ORIGIN: node.accountsOrigin,
          NEXT_PUBLIC_CLIENT_VERSION: `0.0.0-g${manifest.release_pointer_ref.source_sha}`,
          NEXT_PUBLIC_STOREFRONT_HOSTNAME: new URL(node.storefrontOrigin).hostname,
          NEXT_PUBLIC_STOREFRONT_APPLICATION: node.consumerApplication,
          NEXT_PUBLIC_IDENTITY_NODE_REGISTRY: registry,
          SFL_STOREFRONT_HOSTNAME: new URL(node.storefrontOrigin).hostname,
          SFL_STOREFRONT_APPLICATION: node.consumerApplication,
          SFL_STOREFRONT_IDENTITY_NODE_REGISTRY: registry,
        };
        const existingKeys = new Set(before.split(/\r?\n/).map((line) =>
          /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=/.exec(line)?.[1]));
        for (const [key, value] of Object.entries(publicUpdates)) {
          if (existingKeys.has(key)) updates[key] = value;
        }
      }
      Object.assign(updates, await storefrontPublicEnvironment(context, release));
    }
    const removed = context.target === 'web-api' ? ['OBJECT_STORE_ENDPOINT', 'OBJECT_STORE_BEARER_TOKEN'] : [];
    await updateNodeRuntimeEnvironment(path, before, stats, updates, removed);
  }
  if (destinations.central && await exists(join(release, 'node-runtime', destinations.centralFile))) {
    await atomicPointer(destinations.central, join(activeRuntime, destinations.centralFile));
  }
  return true;
}

async function storefrontPublicEnvironment(context, release) {
  const packaged = await readJson(join(release, 'node-runtime', 'storefront-public.json'));
  // Older immutable archives can keep their original digest and use the snapshot captured with their pin.
  const snapshot = packaged ?? await readJson(join(nodeRuntimeRecoveryPath(context, release), 'storefront-public.json'));
  const keys = ['NEXT_PUBLIC_API_BASE_URL', 'NEXT_PUBLIC_AUTH_ORIGIN', 'NEXT_PUBLIC_CLIENT_VERSION', 'NEXT_PUBLIC_STOREFRONT_HOSTNAME'];
  const environment = Object.fromEntries(keys.filter((key) => typeof snapshot?.[key] === 'string').map((key) => [key, snapshot[key]]));
  if (Object.hasOwn(environment, 'NEXT_PUBLIC_STOREFRONT_HOSTNAME')) {
    environment.SFL_STOREFRONT_HOSTNAME = environment.NEXT_PUBLIC_STOREFRONT_HOSTNAME;
  }
  return environment;
}

async function restoreStorefrontPublicEnvironment(context, release) {
  const updates = await storefrontPublicEnvironment(context, release);
  if (Object.keys(updates).length === 0) return;
  const path = nodeRuntimeDestinations(context).environment;
  const [stats, before] = await Promise.all([lstat(path), readFile(path, 'utf8')]);
  await updateNodeRuntimeEnvironment(path, before, stats, updates);
}

async function updateNodeRuntimeEnvironment(path, before, stats, updates, removed = []) {
  const pending = new Set(Object.keys(updates));
  const lines = before.split(/\r?\n/).map((line) => {
    const key = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=/.exec(line)?.[1];
    if (removed.includes(key)) return null;
    if (!Object.hasOwn(updates, key ?? '')) return line;
    pending.delete(key);
    return environmentAssignment(key, updates[key]);
  }).filter((line) => line !== null);
  while (lines.at(-1) === '') lines.pop();
  for (const key of pending) lines.push(environmentAssignment(key, updates[key]));
  await writeNodeRuntimeFile(path, `${lines.join('\n')}\n`, stats);
}

function environmentAssignment(key, value) {
  const escaped = String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
  return `${key}="${escaped}"`;
}

async function writeNodeRuntimeFile(path, contents, stats) {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}`);
  try {
    await writeFile(temporary, contents, { mode: stats.mode & 0o777 });
    await chown(temporary, stats.uid, stats.gid);
    await chmod(temporary, stats.mode & 0o777);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function restoreNodeRuntime(directory) {
  if (!directory) return false;
  const entries = await readJson(join(directory, 'before.json'));
  if (!entries) return false;
  await applyNodeRuntime(entries, directory);
  return true;
}

async function applyNodeRuntime(entries, directory) {
  for (const entry of entries) {
    if (entry.kind === 'missing') await rm(entry.path, { force: true });
    else if (entry.kind === 'link') await atomicPointer(entry.path, entry.target);
    else await writeNodeRuntimeFile(entry.path, entry.body ?? await readFile(join(directory, entry.backup)), entry);
  }
}

async function observeMany(targetIds, makeContext) {
  const targets = await Promise.all(targetIds.map(async (target) => {
    let targetStatus;
    try {
      const context = makeContext(target);
      const root = context.deployment.pointerRoot;
      const layerNames = ['runtime', 'previous-runtime'];
      const [before, beforeLayers] = await Promise.all([observePointerPair(root), observePointerPair(root, layerNames)]);
      const processBefore = before[0]?.target ? await observeProcess(context) : null;
      const cutover = await observeCutover(context, before, processBefore, beforeLayers);
      if (cutover?.code === 'OBSERVATION_CHANGED') return changingObservation(target);
      const releases = await releasePointersForStatus(root, before.map((pointer) => pointer?.target ?? null));
      targetStatus = await status(context, releases, beforeLayers);
      let verification = null;
      let error = null;
      if (!cutover || cutover.code === 'RUNNING_RELEASE_UNCONFIRMED') {
        try {
          verification = await verifyCurrent(context, releases);
        } catch (failure) {
          error = errorEvidence(failure);
        }
      }
      const processAfter = processBefore ? await observeProcess(context) : null;
      const [after, afterLayers] = await Promise.all([observePointerPair(root), observePointerPair(root, layerNames)]);
      if (JSON.stringify(before) !== JSON.stringify(after) ||
          JSON.stringify(beforeLayers) !== JSON.stringify(afterLayers) ||
          JSON.stringify(processBefore) !== JSON.stringify(processAfter) ||
          await hasActiveCutover(root)) return changingObservation(target);
      if (cutover && (cutover.code !== 'RUNNING_RELEASE_UNCONFIRMED' || !error)) {
        return { target, status: targetStatus, process: processAfter, verification: null, error: cutover };
      }
      if (verification) verification.targetProcess = processAfter?.pid ?? null;
      return { target, status: targetStatus, process: processAfter, verification, ...(error ? { error } : {}) };
    } catch (error) {
      return { target, status: null, verification: null, error: errorEvidence(error) };
    }
  }));
  return { targets };
}

function changingObservation(target) {
  return { target, status: null, verification: null, error: { code: 'OBSERVATION_CHANGED', message: 'The release is changing during observation.' } };
}

function observePointerPair(root, names = ['current', 'previous'], { stableAcrossRename = false } = {}) {
  return Promise.all(names.map(async (name) => {
    const path = join(root, name);
    try {
      const stat = await lstat(path, { bigint: true });
      if (!stat.isSymbolicLink()) return null;
      // Renaming a staged pointer changes ctime, while its symlink identity and creation data stay the same.
      const generation = stableAcrossRename
        ? `${stat.dev}:${stat.ino}:${stat.birthtimeNs}:${stat.mtimeNs}`
        : `${stat.dev}:${stat.ino}:${stat.ctimeNs}`;
      return { target: await readlink(path), generation };
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'EINVAL') return null;
      throw error;
    }
  }));
}

async function observeProcess(context) {
  const pid = await processId(context.deployment.restart);
  if (!/^[1-9]\d*$/.test(pid)) return { pid, started: null, cwd: null };
  const started = await processStartToken(pid);
  const cwd = await readlink(`/proc/${pid}/cwd`).catch((error) => {
    if (['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(error.code)) return null;
    throw error;
  });
  return { pid, started, cwd };
}

async function verifyCutoverProcess(context, release, before) {
  const running = await observeProcess(context);
  if (running.pid === 'none') return running;
  if (!running.started || (running.pid === before.pid && running.started === before.started)) {
    throw failure('TARGET_PROCESS_NOT_RESTARTED', { current: release, before, process: running });
  }
  if (await processRelease(context.deployment.pointerRoot, release, running.cwd) === 'other') {
    throw failure('TARGET_PROCESS_RELEASE_MISMATCH', { current: release, process: running });
  }
  return running;
}

async function processStartToken(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    // The process name may contain spaces. Start time is field 22.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return ['Z', 'X'].includes(fields[0]) ? null : fields[19] ?? null;
  } catch (error) {
    if (['ENOENT', 'ESRCH', 'EACCES'].includes(error.code)) return null;
    throw error;
  }
}

async function markCutover(root, intent = {}, { required: mustRecord = false } = {}) {
  try {
    const started = await processStartToken(process.pid);
    if (!started) {
      if (mustRecord) throw failure('ROLLBACK_EXECUTION_IDENTITY_UNAVAILABLE');
      return;
    }
    const directory = join(root, 'state', 'cutovers');
    await mkdir(directory, { recursive: true });
    const marker = join(directory, `${process.pid}-${started}`);
    await writeAtomicJson(marker, { before: await observePointerPair(root), ...intent });
    cutoverMarker = marker;
  } catch (error) {
    if (mustRecord) throw error;
    process.stderr.write(`REMOTE_OBSERVATION_WARNING=${JSON.stringify(errorEvidence(error))}\n`);
  }
}

async function cutoverProcess(context) {
  if (!cutoverMarker) return null;
  try {
    const pointers = await observePointerPair(context.deployment.pointerRoot);
    return { pointers, process: await observeProcess(context) };
  } catch (error) {
    process.stderr.write(`REMOTE_OBSERVATION_WARNING=${JSON.stringify(errorEvidence(error))}\n`);
    return null;
  }
}

async function recordConfirmedCutover(root, completion) {
  try {
    await writeAtomicJson(join(root, 'state', 'cutovers', 'confirmed.json'), completion);
  } catch (error) {
    process.stderr.write(`REMOTE_OBSERVATION_WARNING=${JSON.stringify(errorEvidence(error))}\n`);
    return false;
  }
  if (cutoverMarker) {
    await rm(cutoverMarker, { force: true }).catch((error) => {
      process.stderr.write(`REMOTE_OBSERVATION_WARNING=${JSON.stringify(errorEvidence(error))}\n`);
    });
    cutoverMarker = null;
  }
  return true;
}

async function cutoverEntries(root) {
  const directory = join(root, 'state', 'cutovers');
  const entries = await readdir(directory).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  return entries.flatMap((name) => {
    const match = /^(\d+)-(\d+)$/.exec(name);
    return match ? [{ marker: join(directory, name), pid: match[1], started: match[2] }] : [];
  });
}

async function hasActiveCutover(root) {
  for (const entry of await cutoverEntries(root)) {
    if (await processStartToken(entry.pid) === entry.started) return true;
  }
  return false;
}

async function unfinishedRollback(context, pair, observed, pointerStates) {
  const root = context.deployment.pointerRoot;
  const confirmed = await readJson(join(root, 'state', 'cutovers', 'confirmed.json'));
  if (stableJson(confirmed?.pointers) === stableJson(pair)) return null;
  const { latest: audit, completed } = await latestCutoverAudit(context);
  if (completed && matchesRollbackCompletion(completed, pair, observed)) return null;
  let confirmedAt = Math.max(confirmed?.confirmedAt ?? 0, completed?.confirmedAt ?? 0);
  const closedMarkers = new Set([...(confirmed?.closedMarkers ?? []), ...(completed?.result.completion?.closedMarkers ?? [])]);

  const entries = await cutoverEntries(root);
  const matches = [];
  const unresolved = [];
  const requestReceipts = new Map();
  for (const { marker } of entries) {
    if (closedMarkers.has(basename(marker))) continue;
    const record = await readJson(marker);
    if (record?.rollback) {
      if (record.rollbackRequestId) {
        const id = record.rollbackRequestId;
        if (!requestReceipts.has(id)) {
          requestReceipts.set(id, await readRollbackRecord(rollbackRecordPath(context, id, 'receipt')));
        }
        const receipt = requestReceipts.get(id);
        if (receipt) {
          const recordedAt = receipt.completion.confirmedAt;
          if (matchesRollbackCompletion({ result: receipt, confirmedAt: recordedAt }, pair, observed)) return null;
          confirmedAt = Math.max(confirmedAt, recordedAt);
          continue;
        }
      }
      const plan = record.rollback;
      if (!Number.isFinite(record.rollbackStartedAt) || record.rollbackStartedAt < confirmedAt) continue;
      if (!record.pointerJournal) {
        if (!rollbackReachedCurrent(plan, observed)) continue;
        unresolved.push({ marker, original: plan, recordedAt: record.rollbackStartedAt });
        continue;
      }
      const journal = await readRollbackRecord(record.pointerJournal);
      if (!journal) {
        if (rollbackReachedCurrent(plan, observed)) unresolved.push({ marker, original: plan, recordedAt: record.rollbackStartedAt });
        continue;
      }
      const progress = rollbackJournalProgress(journal, pointerStates);
      if (stableJson(journal.plan) !== stableJson(plan) || progress < 0 || (progress === 0 && !journal.resuming)) continue;
      matches.push({ marker, plan, startedAt: record.rollbackStartedAt, requestId: record.rollbackRequestId,
        ordinaryRuntime: record.ordinaryRuntime, pointerJournal: record.pointerJournal });
      continue;
    }
    if (record && (!Array.isArray(record.before) || stableJson(record.before) === stableJson(pair))) continue;
    const original = record ? { current: record.before[0]?.target ?? null, previous: record.before[1]?.target ?? null } : null;
    if (original && !rollbackReachedCurrent(original, observed)) continue;
    const stamp = await lstatOrNull(marker);
    if (stamp && stamp.mtimeMs >= confirmedAt) {
      unresolved.push({ marker, original, recordedAt: stamp.mtimeMs });
    }
  }
  const openMatches = matches.filter(({ startedAt }) => startedAt >= confirmedAt)
    .sort((left, right) => right.startedAt - left.startedAt || Number(Boolean(right.ordinaryRuntime)) - Number(Boolean(left.ordinaryRuntime)));
  const latest = openMatches[0];
  if (latest) return {
    plan: latest.plan,
    requestId: latest.requestId,
    startedAt: latest.startedAt,
    ordinaryRuntime: latest.ordinaryRuntime,
    pointerJournal: latest.pointerJournal,
    markers: openMatches.filter(({ startedAt, plan }) =>
      startedAt === latest.startedAt && stableJson(plan) === stableJson(latest.plan)).map(({ marker }) => marker),
  };
  return recoverLegacyRollback(context, pair, observed, unresolved.filter(({ recordedAt }) => recordedAt >= confirmedAt), confirmedAt, audit);
}

function completedRollbackAudit(audit) {
  if (audit?.action !== 'rollback' || audit.error || !audit.result?.current) return null;
  const result = audit.result;
  const confirmedAt = result.completion?.confirmedAt ?? Date.parse(audit.completedAt ?? '');
  return Number.isFinite(confirmedAt) ? { result, confirmedAt } : null;
}

function matchesRollbackCompletion({ result, confirmedAt }, pair, observed) {
  if (result.current !== observed.current || result.previous !== observed.previous ||
      result.runtime !== observed.runtime ||
      (Object.hasOwn(result, 'previousRuntime') && result.previousRuntime !== observed.previousRuntime)) return false;
  if (result.completion?.pointers) return stableJson(result.completion.pointers) === stableJson(pair);
  // Old successful receipts contain release paths, but no recorded pointer generations.
  return !pointersChangedAfter(pair, confirmedAt);
}

function pointersChangedAfter(pair, timestamp) {
  return pair.some((entry) => entry &&
    BigInt(entry.generation.split(':').at(-1)) >= BigInt(timestamp + 1) * 1_000_000n);
}

function rollbackReachedCurrent(original, observed) {
  return Boolean(original.previous) && original.current !== original.previous &&
    observed.current !== original.current && canonicalArtifactPath(observed.current) === canonicalArtifactPath(original.previous) &&
    [original.current, original.previous].includes(observed.previous);
}

async function recoverLegacyRollback(context, pair, observed, unresolved, confirmedAt, audit) {
  const failed = audit?.action === 'rollback' && audit.error?.code === 'ROLLBACK_FAILED' ? audit.error.details : null;
  const receipt = failed?.pointerJournal ? null : failed;
  const failedAt = Date.parse(audit?.failedAt ?? '');
  const original = receipt && { current: receipt.originalCurrent, previous: receipt.attemptedCurrent };
  const failureMatches = original && failedAt >= confirmedAt && rollbackReachedCurrent(original, observed);
  if (!failureMatches && unresolved.length === 0) return null;

  const markers = failureMatches ? unresolved.filter(({ original: recorded, recordedAt }) =>
    recordedAt < failedAt + 1 && (!recorded ||
      (recorded.current === original.current && recorded.previous === original.previous))) : [];
  if (failureMatches && (unresolved.length === 0 || markers.length > 0) &&
      !pointersChangedAfter(pair, failedAt - 1) &&
      ['current', 'previous', 'runtime', 'previousRuntime'].every((key) => receipt[key] === observed[key])) {
    const runtime = await recoverLegacyRuntime(context, original, observed, receipt);
    if (runtime) return { plan: { ...original, ...runtime }, startedAt: Math.floor(markers[0]?.recordedAt ?? failedAt), markers: markers.map(({ marker }) => marker) };
  }

  return reportRollbackEvidence(context, observed,
    failureMatches ? 'Legacy rollback runtime or pointer evidence is incomplete or inconsistent.' : 'No matching failed rollback receipt for this placement.');
}

async function reportRollbackEvidence(context, observed, reason, details = {}) {
  const releases = await releasePointersForStatus(context.deployment.pointerRoot, [observed.current, observed.previous]);
  throw failure('ROLLBACK_EVIDENCE_INSUFFICIENT', {
    ...releases,
    runtime: observed.runtime,
    previousRuntime: observed.previousRuntime,
    ...details,
    pointerAction: 'not-performed',
    reason,
    nextAction: 'Inspect the recorded release paths and failed rollback receipt for this target and physical node.',
  });
}

async function verifiedRollbackTarget(context, requested, observed, preferred) {
  const root = resolve(context.deployment.pointerRoot);
  const path = resolve(root, requested);
  const canonical = canonicalArtifactPath(path);
  const identityMatch = /^([a-f0-9]{40})-([a-f0-9]{64})-([a-f0-9]{64})$/.exec(basename(canonical));
  if (identityMatch && canonical === join(root, 'releases', basename(canonical))) {
    const [, sourceSha, treeDigest, manifestDigest] = identityMatch;
    // The manifest digest in the recorded release path also commits to the archive digest.
    const identity = { project: context.project, target: context.target, sourceSha,
      treeDigest: `sha256:${treeDigest}`, manifestDigest: `sha256:${manifestDigest}` };
    const stored = await locateStoredRelease(context, identity, [preferred, requested, ...await placementReleasePointers(root)]);
    if (stored.manifest) return stored.release;
    return reportRollbackEvidence(context, observed, `No verified copy matched the rollback target manifest ${identity.manifestDigest}.`);
  }
  // Seeded releases and imported baselines predate content-addressed archives.
  try {
    if (await releaseSourceSha(context, path)) return path;
  } catch (error) {
    return reportRollbackEvidence(context, observed, `The recorded rollback target could not be verified (${error.code ?? 'unreadable'}).`);
  }
  return reportRollbackEvidence(context, observed, 'No verified artifact or baseline matched the recorded rollback target.');
}

async function latestCutoverAudit(context) {
  const actions = ['rollback', 'activate', 'activate-direct', 'deploy-oss-direct', 'deploy-oss-direct-v2', 'baseline', 'seed'];
  let latest = null;
  for await (const record of placementAudit(context)) {
    if (!actions.includes(record.action) || record.error?.code === 'ROLLBACK_EVIDENCE_INSUFFICIENT') continue;
    latest ??= record;
    const completed = completedRollbackAudit(record);
    if (completed) return { latest, completed };
  }
  return { latest, completed: null };
}

async function* placementAudit(context) {
  const root = context.policy.auditRoot ?? '/var/log/ai-delivery';
  let file;
  try {
    file = await open(join(root, `${safeName(context.project)}.jsonl`), 'r');
    let position = (await file.stat()).size;
    let partialLine = Buffer.alloc(0);
    while (position > 0) {
      const block = Buffer.alloc(Math.min(position, 64 * 1024));
      position -= block.length;
      const { bytesRead } = await file.read(block, 0, block.length, position);
      const chunk = Buffer.concat([block.subarray(0, bytesRead), partialLine]);
      const firstNewline = position === 0 ? -1 : chunk.indexOf(10);
      partialLine = firstNewline < 0 ? chunk : chunk.subarray(0, firstNewline);
      if (position > 0 && firstNewline < 0) continue;
      const lines = chunk.subarray(firstNewline + 1).toString('utf8').split('\n');
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        let record;
        try { record = JSON.parse(lines[index]); } catch { continue; }
        if (record?.project === context.project && record.node === context.node && record.target === context.target) yield record;
      }
    }
  } catch {
    // Older placements may no longer have the corresponding audit file.
  } finally {
    await file?.close().catch(() => {});
  }
}

async function recoverLegacyRuntime(context, original, observed, receipt) {
  // Before previous moves, neither runtime pointer has been written.
  if (observed.previous === original.previous) return { runtime: observed.runtime, previousRuntime: observed.previousRuntime };
  const failureCode = receipt.rollbackFailure?.code;
  if (receipt.timings?.pointer > 0 || receipt.timings?.restart > 0 ||
      ['RESTART_COMMAND_FAILED', 'READINESS_HARD_FAILURE', 'READINESS_TIMEOUT', 'TARGET_PROCESS_NOT_RESTARTED', 'TARGET_PROCESS_RELEASE_MISMATCH'].includes(failureCode)) {
    return { runtime: observed.previousRuntime, previousRuntime: observed.runtime };
  }

  const root = context.deployment.pointerRoot;
  const [from, to] = await Promise.all([original.current, original.previous].map(async (release) => {
    if (!release) return null;
    const manifest = await artifactForStatus(root, release);
    return manifest?.dependencyLayer
      ? dependencyLayerPath(context, manifest.dependencyLayer).catch(() => undefined) : undefined;
  }));
  // Equal live links can also mean only the first runtime link was updated.
  if (observed.runtime === observed.previousRuntime && from === undefined) return null;
  const possibilities = [
    { runtime: observed.runtime, previousRuntime: observed.previousRuntime },
    { runtime: observed.previousRuntime, previousRuntime: observed.runtime },
    ...(observed.runtime === observed.previousRuntime && from !== undefined
      ? [{ runtime: from, previousRuntime: observed.runtime }] : []),
  ].filter(({ runtime, previousRuntime }) =>
    (from === undefined || from === runtime) && (to === undefined || to === previousRuntime));
  const unique = new Map(possibilities.map((runtime) => [stableJson(runtime), runtime]));
  return unique.size === 1 ? unique.values().next().value : null;
}

async function observeCutover(context, pointers, running, layers) {
  const root = context.deployment.pointerRoot;
  const pending = await cutoverEntries(root);
  const generation = stableJson(pointers);
  let confirmed = await readJson(join(root, 'state', 'cutovers', 'confirmed.json'));
  let generationConfirmed = stableJson(confirmed?.pointers) === generation;
  const interrupted = [];
  for (const entry of pending) {
    if (confirmed?.closedMarkers?.includes(basename(entry.marker))) continue;
    if (await processStartToken(entry.pid) === entry.started) return { code: 'OBSERVATION_CHANGED' };
    if (!generationConfirmed) {
      const record = await readJson(entry.marker);
      if (record?.rollbackRequestId) {
        const receipt = await readRollbackRecord(rollbackRecordPath(context, record.rollbackRequestId, 'receipt'));
        if (receipt) {
          if (stableJson(receipt.completion.pointers) === generation) {
            confirmed = receipt.completion;
            generationConfirmed = true;
          }
          continue;
        }
      }
      if (!record || stableJson(record.before) === generation) continue;
      const recordedAt = record.rollbackStartedAt ?? (await lstatOrNull(entry.marker))?.mtimeMs;
      if (recordedAt >= (confirmed?.confirmedAt ?? 0)) interrupted.push({ marker: basename(entry.marker), recordedAt });
    }
  }
  if (interrupted.length) {
    const { completed } = await latestCutoverAudit(context);
    if (completed) {
      const [runtime, previousRuntime] = layers ? layers.map((entry) => entry?.target ?? null)
        : await Promise.all([pointer(root, 'runtime'), pointer(root, 'previous-runtime')]);
      if (stableJson(await observePointerPair(root)) !== generation) return { code: 'OBSERVATION_CHANGED' };
      if (matchesRollbackCompletion(completed, pointers, {
        current: pointers[0]?.target ?? null, previous: pointers[1]?.target ?? null, runtime, previousRuntime,
      })) {
        confirmed = completed.result.completion;
        generationConfirmed = true;
      }
    }
    if (!generationConfirmed && interrupted.some(({ marker, recordedAt }) =>
      !completed?.result.completion?.closedMarkers?.includes(marker) && recordedAt >= (completed?.confirmedAt ?? 0))) return {
      code: 'CUTOVER_INCOMPLETE',
      message: 'The cutover stopped after the release pointers changed.',
      details: { current: pointers[0]?.target ?? null, previous: pointers[1]?.target ?? null, process: running },
    };
  }
  if (!running || running.pid === 'none') return null;
  const release = await processRelease(root, pointers[0].target, running.cwd);
  const processConfirmed = generationConfirmed && running.started && confirmed?.process?.pid === running.pid && confirmed.process.started === running.started;
  if (release === 'current' || (release !== 'other' && processConfirmed)) return null;
  return {
    code: release === 'other' ? 'RUNNING_RELEASE_MISMATCH' : 'RUNNING_RELEASE_UNCONFIRMED',
    message: release === 'other' ? 'The service process is running a different release.' : 'The running release could not be identified.',
    details: { current: pointers[0].target, previous: pointers[1]?.target ?? null, process: running },
  };
}

async function processRelease(root, current, cwd) {
  if (!cwd || !current) return 'unknown';
  const release = await realpath(resolve(root, current)).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!release) return 'unknown';
  if (cwd === release || cwd.startsWith(`${release}/`)) return 'current';
  const releases = await realpath(join(root, 'releases')).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  return releases && cwd.startsWith(`${releases}/`) ? 'other' : 'unknown';
}

async function artifactForStatus(root, release) {
  return release ? await readJson(join(resolve(root, release), 'AI_DELIVERY_ARTIFACT.json')) : null;
}

async function verifyCurrent(context, observedRelease = null) {
  const root = context.deployment.pointerRoot;
  const current = observedRelease ? observedRelease.current : await pointer(root, 'current');
  assert(current, 'CURRENT_POINTER_MISSING', { root });
  const readiness = await waitForReadiness(context, { candidateDir: '', currentDir: resolve(root, current), ...contextSummary(context) });
  return {
    current,
    currentArtifact: observedRelease ? observedRelease.currentArtifact : await artifactForStatus(root, current),
    ...(observedRelease ? {} : { targetProcess: await processId(context.deployment.restart) }),
    checks: readiness.checks,
    readiness,
    protectedProcesses: {},
  };
}

async function verifyDependencyLayer(context, layer) {
  const path = await dependencyLayerPath(context, layer);
  if (!path) return null;
  const ready = JSON.parse(await readFile(join(path, 'AI_DELIVERY_LAYER.json'), 'utf8'));
  assert(ready.schema === 'ai.delivery.dependency-layer.v1', 'DEPENDENCY_LAYER_MANIFEST_INVALID');
  assert(ready.digest === layer.digest && ready.runtime === layer.runtime, 'DEPENDENCY_LAYER_IDENTITY_MISMATCH');
  return path;
}

async function dependencyLayerLookup(context, options) {
  const layer = requestedDependencyLayer(context, options);
  const path = join(layer.productionRoot, layer.digest.slice(7));
  if (!(await exists(path))) return { exists: false, path, digest: layer.digest, runtime: layer.runtime };
  const ready = JSON.parse(await readFile(join(path, 'AI_DELIVERY_LAYER.json'), 'utf8'));
  assert(ready.schema === 'ai.delivery.dependency-layer.v1', 'DEPENDENCY_LAYER_MANIFEST_INVALID');
  assert(ready.digest === layer.digest && ready.runtime === layer.runtime, 'DEPENDENCY_LAYER_IDENTITY_MISMATCH');
  return { exists: true, path, digest: layer.digest, runtime: layer.runtime };
}

async function stageDependencyLayer(context, options) {
  const layer = requestedDependencyLayer(context, options);
  const archive = resolve(required(options.archive, 'DEPENDENCY_LAYER_ARCHIVE_REQUIRED'));
  assertIncomingPath(context.policy, archive);
  const archiveStats = await lstat(archive);
  assert(archiveStats.isFile() && archiveStats.size <= MAX_DEPENDENCY_LAYER_ARCHIVE_BYTES, 'DEPENDENCY_LAYER_ARCHIVE_SIZE_INVALID', { bytes: archiveStats.size, limitBytes: MAX_DEPENDENCY_LAYER_ARCHIVE_BYTES });
  assert(/^[a-f0-9]{64}$/.test(options.sha256), 'DEPENDENCY_LAYER_ARCHIVE_HASH_INVALID');
  assert((await hashFile(archive)) === options.sha256, 'DEPENDENCY_LAYER_ARCHIVE_HASH_MISMATCH');
  const destination = join(layer.productionRoot, layer.digest.slice(7));
  if (await exists(destination)) {
    const reused = await dependencyLayerLookup(context, options);
    await rm(archive, { force: true });
    return { ...reused, reused: true };
  }
  await mkdir(layer.productionRoot, { recursive: true, mode: 0o755 });
  const temporary = join(layer.productionRoot, `.staging-${layer.digest.slice(7)}-${process.pid}-${Date.now()}`);
  await mkdir(temporary, { recursive: true, mode: 0o755 });
  try {
    await verifyDependencyLayerArchiveEntries(archive);
    await command(['tar', '-xzf', archive, '-C', temporary], { timeoutMs: 1_200_000 });
    const ready = JSON.parse(await readFile(join(temporary, 'AI_DELIVERY_LAYER.json'), 'utf8'));
    assert(ready.schema === 'ai.delivery.dependency-layer.v1', 'DEPENDENCY_LAYER_MANIFEST_INVALID');
    assert(ready.project === context.project && ready.target === context.target, 'DEPENDENCY_LAYER_SCOPE_MISMATCH');
    assert(ready.digest === layer.digest && ready.runtime === layer.runtime, 'DEPENDENCY_LAYER_IDENTITY_MISMATCH');
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { recursive: true, force: true });
    await rm(archive, { force: true });
  }
  return { exists: true, path: destination, digest: layer.digest, runtime: layer.runtime, reused: false };
}

function requestedDependencyLayer(context, options) {
  const configured = context.deployment.seedDependencyLayer;
  const productionRoot = required(options.productionRoot, 'DEPENDENCY_LAYER_ROOT_REQUIRED');
  const digestValue = required(options.digest, 'DEPENDENCY_LAYER_DIGEST_REQUIRED');
  const runtime = required(options.runtime, 'DEPENDENCY_LAYER_RUNTIME_REQUIRED');
  assert((context.policy.allowedDependencyRoots ?? []).includes(productionRoot), 'DEPENDENCY_LAYER_ROOT_NOT_ALLOWED', { productionRoot });
  assert(/^sha256:[a-f0-9]{64}$/.test(digestValue), 'DEPENDENCY_LAYER_DIGEST_INVALID');
  if (configured) {
    assert(configured.productionRoot === productionRoot && configured.runtime === runtime, 'DEPENDENCY_LAYER_CONFIG_MISMATCH');
  }
  return { productionRoot, digest: digestValue, runtime };
}

async function verifyDependencyLayerArchiveEntries(archive) {
  const listing = await command(['tar', '-tzf', archive], { timeoutMs: 120_000 });
  for (const entry of listing.stdout.split('\n').filter(Boolean)) {
    const normalized = entry.replace(/^\.\//, '').replace(/\/$/, '');
    assert(!normalized.startsWith('/') && !normalized.split('/').includes('..'), 'DEPENDENCY_LAYER_ARCHIVE_PATH_UNSAFE', { entry });
    if (normalized) assert(normalized === 'AI_DELIVERY_LAYER.json' || normalized === 'node_modules' || normalized.startsWith('node_modules/'), 'DEPENDENCY_LAYER_ARCHIVE_ENTRY_INVALID', { entry });
  }
}

async function dependencyLayerPath(context, layer) {
  if (!layer) return null;
  const root = required(layer.productionRoot, 'DEPENDENCY_LAYER_ROOT_REQUIRED');
  assert((context.policy.allowedDependencyRoots ?? []).includes(root), 'DEPENDENCY_LAYER_ROOT_NOT_ALLOWED', { root });
  assert(/^sha256:[a-f0-9]{64}$/.test(layer.digest), 'DEPENDENCY_LAYER_DIGEST_INVALID');
  const path = join(root, layer.digest.slice(7));
  assert(await exists(path), 'DEPENDENCY_LAYER_MISSING', { path, digest: layer.digest });
  return path;
}

async function pointerSnapshot(root) {
  return Object.fromEntries(await Promise.all(['candidate', 'current', 'previous', 'runtime', 'previous-runtime'].map(async (name) => [name, await pointer(root, name)])));
}

async function capacityEvidence(context, artifactBytes) {
  try {
    const stats = await statfs(context.deployment.pointerRoot).catch(() => statfs(dirname(context.deployment.pointerRoot)));
    return { status: 'observed', freeBytes: Number(stats.bavail) * Number(stats.bsize), artifactBytes };
  } catch (error) {
    return { status: 'unavailable', artifactBytes, error: errorEvidence(error) };
  }
}

async function caddySemanticEvidence(policy) {
  return { status: 'not-required-for-target-deploy', digest: null, config: policy.caddyConfig ?? null };
}

function artifactSummary(manifest) {
  return { sourceSha: manifest.sourceSha, treeDigest: manifest.treeDigest, manifestDigest: manifest.manifestDigest,
    archiveSha256: manifest.archive?.sha256 ?? null, archiveBytes: manifest.archive?.bytes ?? null,
    ...(Object.hasOwn(manifest, 'instanceCacheKey') ? { instanceCacheKey: manifest.instanceCacheKey } : {}) };
}

async function deploymentReceipt(context, manifest, evidence) {
  const pointersAfter = await pointerSnapshot(context.deployment.pointerRoot);
  return {
    schema: 'ai.delivery.receipt.v1',
    version: `${manifest.sourceSha}-${manifest.treeDigest.slice(7, 19)}`,
    sourceSha: manifest.sourceSha,
    ...(context.controlPlane ? { controlPlane: context.controlPlane } : {}),
    ...contextSummary(context),
    artifact: artifactSummary(manifest),
    pointers: { before: evidence.pointersBefore, after: pointersAfter },
    rollbackPoint: evidence.rollbackPoint,
    targetProcess: { before: evidence.targetProcessBefore, after: evidence.targetProcessAfter },
    nonTargetProcesses: { before: evidence.protectedBefore, after: evidence.protectedAfter, unchanged: Object.keys(evidence.protectedBefore ?? {}).length ? stableJson(evidence.protectedBefore) === stableJson(evidence.protectedAfter) : null },
    capacity: evidence.capacity,
    ready: evidence.readiness,
    caddySemantic: { status: 'not-part-of-target-release', before: evidence.caddyBefore, after: evidence.caddyAfter, unchanged: null },
    automaticCleanup: { status: 'not-observed-by-target-release' },
    databaseMigration: evidence.databaseMigration ?? null,
    databaseRecovery: context.deployment.databaseMigration ? databaseRecoveryEvidence(context.deployment.databaseMigration) : null,
    restart: context.deployment.databaseMigration ? restartEvidence(context.deployment.restart, false) : undefined,
    finalStatus: evidence.finalStatus,
    completedAt: new Date().toISOString(),
  };
}

async function protectedProcessSnapshot(context) {
  const own = context.deployment.restart;
  const protectedProcesses = (context.policy.protectedProcesses ?? []).filter((item) => !(own && item.kind === own.kind && item.name === own.name));
  return Object.fromEntries(await Promise.all(protectedProcesses.map(async (item) => [`${item.kind}:${item.name}`, await processId(item).catch(() => 'unavailable')])));
}

async function assertProtectedUnchanged(context, before) {
  const after = {};
  for (const key of Object.keys(before)) {
    const [kind, ...name] = key.split(':');
    const newPid = await processId({ kind, name: name.join(':') }).catch(() => 'unavailable');
    after[key] = newPid;
  }
  return after;
}

async function processId(processDefinition) {
  if (processDefinition.kind === 'systemd') {
    const result = await command(['systemctl', 'show', '--property=MainPID', '--value', processDefinition.name], { acceptExitCodes: [0, 3] });
    return result.stdout.trim() || '0';
  }
  if (processDefinition.kind === 'pm2') {
    const result = await command(['pm2', 'pid', processDefinition.name], { acceptExitCodes: [0, 1] });
    return result.stdout.trim() || '0';
  }
  if (processDefinition.kind === 'none') return 'none';
  throw failure('PROCESS_KIND_INVALID', processDefinition);
}

function restartEvidence(definition = { kind: 'none', name: 'none' }, executed = false) {
  const normalized = definition ?? { kind: 'none', name: 'none' };
  let argv = [];
  if (normalized.kind === 'systemd') argv = ['systemctl', `--job-mode=${normalized.jobMode ?? 'replace'}`, 'restart', normalized.name];
  else if (normalized.kind === 'pm2') argv = ['pm2', 'restart', normalized.name, '--update-env'];
  else if (normalized.kind !== 'none') throw failure('RESTART_KIND_INVALID', normalized);
  return {
    kind: normalized.kind,
    target: normalized.name,
    commandCount: executed && argv.length > 0 ? 1 : 0,
    commands: executed && argv.length > 0 ? [argv] : [],
  };
}

async function restart(definition = { kind: 'none', name: 'none' }, inheritedFd) {
  const evidence = restartEvidence(definition, true);
  const restartAt = new Date().toISOString();
  if (evidence.commandCount === 0) return evidence;
  try {
    const argv = inheritedFd === undefined ? evidence.commands[0]
      : ['sh', '-c', '"$@"; exit "$?"', 'rollback-restart', ...evidence.commands[0]];
    await command(argv, { timeoutMs: RESTART_CLIENT_TIMEOUT_MS, inheritedFd });
  } catch (error) {
    let serviceError = null;
    if (evidence.kind === 'systemd' && !(inheritedFd !== undefined && error.details?.timedOut)) {
      try {
        const journal = await command(['journalctl','-u',evidence.target,'--since',restartAt,'-n','80','--no-pager','-o','cat']);
        serviceError = journal.stdout.split('\n').filter((line) => /Error|Warning|curl:|unsettled|_TIMEOUT|_MISMATCH|_MISSING|_INVALID|_REQUIRED/i.test(line)).slice(-3).join('\n');
      } catch {}
    }
    throw failure('RESTART_COMMAND_FAILED', { restart: evidence, cause: errorEvidence(error), serviceError });
  }
  return evidence;
}

async function resetFailureState(definition = { kind: 'none', name: 'none' }) {
  if (definition?.kind === 'systemd') {
    await command(['systemctl', 'reset-failed', definition.name], { timeoutMs: 10_000 });
  }
}

async function runChecks(checks, values) {
  for (const check of checks) {
    assert(Array.isArray(check.argv) && check.argv.length > 0, 'CHECK_COMMAND_INVALID', check);
    const argv = check.argv.map((entry) => expand(entry, values));
    await command(argv, { timeoutMs: check.timeoutMs ?? 30_000 });
  }
}

async function waitForReadiness(context, values) {
  const checks = context.deployment.healthChecks ?? [];
  const settings = readinessSettings(context);
  const started = performance.now();
  if (checks.length === 0) {
    return { status: 'not-checked', attempts: 0, durationMs: 0, timeoutMs: settings.timeoutMs, intervalMs: settings.intervalMs, lastError: null, checks: [] };
  }
  const deadline = started + settings.timeoutMs;
  let attempts = 0;
  let lastError = null;
  let lastProcessState = null;
  let zeroPidSince = null;
  const ensureProcessViable = async () => {
    const observedAt = performance.now();
    lastProcessState = await processState(context.deployment.restart);
    if (lastProcessState.pid === '0') zeroPidSince ??= observedAt;
    else zeroPidSince = null;
    const explicitFailure = lastProcessState.activeState === 'failed';
    const missingProcess = zeroPidSince !== null && observedAt - zeroPidSince >= settings.hardFailureGraceMs;
    if (explicitFailure || missingProcess) {
      lastError = {
        code: explicitFailure ? 'READINESS_PROCESS_FAILED' : 'READINESS_PROCESS_MISSING',
        message: explicitFailure ? 'READINESS_PROCESS_FAILED' : 'READINESS_PROCESS_MISSING',
        details: { processState: lastProcessState },
      };
      const evidence = readinessEvidence('hard-failure', attempts, started, settings, lastError, lastProcessState, []);
      confirmReadinessFailure(evidence, true);
      throw failure('READINESS_HARD_FAILURE', evidence);
    }
    return lastProcessState.pid !== '0';
  };
  while (true) {
    if (attempts > 0 && performance.now() >= deadline) {
      const evidence = readinessEvidence('timeout', attempts, started, settings, lastError, lastProcessState, []);
      confirmReadinessFailure(evidence);
      throw failure('READINESS_TIMEOUT', evidence);
    }
    attempts += 1;
    const processAvailable = await ensureProcessViable();
    let successfulChecks = null;
    if (processAvailable) {
      try {
        successfulChecks = await runReadinessAttempt(checks, values, settings, deadline);
      } catch (error) {
        if (error?.code === 'REMOTE_COMMAND_INTERRUPTED') throw error;
        lastError = errorEvidence(error);
      }
    } else {
      lastError = { code: 'READINESS_PROCESS_STARTING', message: 'READINESS_PROCESS_STARTING', details: { processState: lastProcessState } };
    }
    if (successfulChecks) {
      const processStillAvailable = await ensureProcessViable();
      if (processStillAvailable) {
        return {
          status: 'ready',
          attempts,
          durationMs: elapsedMs(started),
          timeoutMs: settings.timeoutMs,
          intervalMs: settings.intervalMs,
          lastError,
          processState: lastProcessState,
          checks: successfulChecks,
        };
      }
    }
    await ensureProcessViable();
    const observedAt = performance.now();
    if (observedAt >= deadline) {
      const evidence = readinessEvidence('timeout', attempts, started, settings, lastError, lastProcessState, []);
      confirmReadinessFailure(evidence);
      throw failure('READINESS_TIMEOUT', evidence);
    }
    await delay(Math.max(1, Math.min(settings.intervalMs, deadline - observedAt)));
  }
}

async function runReadinessAttempt(checks, values, settings, deadline) {
  const results = [];
  for (const check of checks) {
    const remainingMs = Math.floor(deadline - performance.now());
    assert(remainingMs > 0, 'READINESS_ATTEMPT_DEADLINE');
    const argv = check.argv.map((entry) => expand(entry, values));
    const result = await command(argv, { timeoutMs: Math.max(1, Math.min(check.timeoutMs ?? settings.attemptTimeoutMs, remainingMs)) });
    results.push({ argv, durationMs: result.durationMs });
  }
  return results;
}

async function processState(definition = { kind: 'none', name: 'none' }, { includeRestartState = false } = {}) {
  if (!definition || definition.kind === 'none') return { kind: 'none', name: 'none', pid: 'none', activeState: 'unmonitored' };
  if (definition.kind === 'pm2') {
    const pid = await processId(definition);
    return { kind: 'pm2', name: definition.name, pid, activeState: pid === '0' ? 'inactive' : 'active' };
  }
  if (definition.kind === 'systemd') {
    const evidence = includeRestartState ? ['--all', '--property=LoadState', '--property=Job',
      '--property=InvocationID', '--property=StateChangeTimestampMonotonic'] : [];
    const result = await command(['systemctl', 'show', '--property=ActiveState', '--property=SubState',
      '--property=Result', '--property=MainPID', ...evidence, definition.name], { acceptExitCodes: [0, 3], timeoutMs: 2_000 });
    const properties = Object.fromEntries(
      result.stdout
        .split('\n')
        .filter((line) => line.includes('='))
        .map((line) => line.split(/=(.*)/s).slice(0, 2))
    );
    return {
      kind: 'systemd',
      name: definition.name,
      pid: includeRestartState ? properties.MainPID : properties.MainPID || '0',
      activeState: properties.ActiveState || 'unknown',
      subState: properties.SubState || 'unknown',
      result: properties.Result || 'unknown',
      ...(includeRestartState ? {
        loadState: properties.LoadState,
        job: /^\d*$/.test(properties.Job ?? '-') ? Number(properties.Job) : null,
        invocation: properties.InvocationID,
        stateChange: properties.StateChangeTimestampMonotonic,
      } : {}),
    };
  }
  throw failure('PROCESS_KIND_INVALID', definition);
}

function readinessSettings(context) {
  return { ...DEFAULT_READINESS, ...(context.policy.readiness ?? {}), ...(context.deployment.readiness ?? {}) };
}

function readinessEvidence(status, attempts, started, settings, lastError, lastProcessState, checks) {
  return {
    status,
    attempts,
    durationMs: elapsedMs(started),
    timeoutMs: settings.timeoutMs,
    intervalMs: settings.intervalMs,
    lastError,
    processState: lastProcessState,
    checks,
  };
}

function confirmReadinessFailure(evidence, hardFailure = false) {
  evidence.failureConfirmedAt = new Date().toISOString();
  evidence.failureConfirmedMs = evidence.durationMs;
  if (hardFailure) evidence.hardFailureDetectedMs = evidence.durationMs;
}

function errorEvidence(error) {
  return { code: error?.code ?? 'REMOTE_COMMAND_FAILED', message: error?.message ?? String(error), details: error?.details ?? {} };
}

function elapsedMs(started) {
  return Math.max(0, Math.round(performance.now() - started));
}

async function command(argv, options = {}) {
  const started = Date.now();
  const chunks = [];
  let interruptedSignal = null;
  let timedOut = false;
  const result = await new Promise((resolvePromise, reject) => {
    const useProcessGroup = process.platform !== 'win32';
    let escalation;
    let closedResult;
    const child = spawn(argv[0], argv.slice(1), {
      shell: false,
      detached: useProcessGroup,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe',
        ...(options.inheritedFd === undefined ? [] : [options.inheritedFd])],
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: options.env } : {}),
      ...(options.uid === undefined ? {} : { uid: options.uid }),
      ...(options.gid === undefined ? {} : { gid: options.gid }),
    });
    const terminate = (signal) => {
      if (useProcessGroup && child.pid) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch (error) {
          if (error?.code === 'ESRCH') return;
        }
      }
      child.kill(signal);
    };
    const forwardedSignals = process.platform === 'win32' ? ['SIGINT', 'SIGTERM'] : ['SIGHUP', 'SIGINT', 'SIGTERM'];
    const signalHandlers = new Map(forwardedSignals.map((signal) => [signal, () => {
      interruptedSignal ??= signal;
      terminate(signal);
      if (escalation) return;
      escalation = setTimeout(() => {
        terminate('SIGKILL');
        if (closedResult) resolvePromise(closedResult);
      }, 2_000);
      escalation.unref();
    }]));
    for (const [signal, handler] of signalHandlers) process.on(signal, handler);
    const removeSignalHandlers = () => {
      for (const [signal, handler] of signalHandlers) process.off(signal, handler);
    };
    if (options.input !== undefined) {
      child.stdin.on('error', reject);
      child.stdin.end(options.input);
    }
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => chunks.push(chunk));
    child.on('error', (error) => {
      removeSignalHandlers();
      reject(error);
    });
    const timer = options.timeoutMs === null ? null : setTimeout(() => {
      timedOut = true;
      terminate('SIGKILL');
    }, options.timeoutMs ?? 30_000);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      removeSignalHandlers();
      const completed = { code, signal };
      if (escalation && useProcessGroup && processGroupExists(child.pid)) {
        closedResult = completed;
        escalation.ref();
        return;
      }
      if (escalation) clearTimeout(escalation);
      resolvePromise(completed);
    });
  });
  const stdout = Buffer.concat(chunks).toString('utf8');
  if (interruptedSignal) throw failure('REMOTE_COMMAND_INTERRUPTED', { argv, signal: interruptedSignal, outputTail: stdout.slice(-3000) });
  const accepted = options.acceptExitCodes ?? [0];
  assert(accepted.includes(result.code), 'REMOTE_COMMAND_FAILED', {
    argv, code: result.code, signal: result.signal, ...(timedOut ? { timedOut: true } : {}), outputTail: stdout.slice(-3000),
  });
  return { stdout, durationMs: Date.now() - started };
}

function processGroupExists(pid) {
  if (!pid) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function treeEvidence(root, ignored = new Set()) {
  const entries = [];
  await walk(root, '', entries, ignored);
  return {
    treeDigest: digest(entries),
    fileCount: entries.filter((entry) => entry.type === 'file').length,
    entryCount: entries.length,
    totalBytes: entries.filter((entry) => entry.type === 'file').reduce((total, entry) => total + entry.bytes, 0),
    entries,
  };
}

async function walk(root, path, entries, ignored) {
  const names = await readdir(join(root, path));
  names.sort();
  for (const name of names) {
    const child = path ? `${path}/${name}` : name;
    if (ignored.has(child)) continue;
    assertArtifactPath(child);
    const absolute = join(root, child);
    const stats = await lstat(absolute);
    if (stats.isDirectory()) {
      entries.push({ path: `${child}/`, type: 'directory', mode: stats.mode & 0o777 });
      await walk(root, child, entries, ignored);
    } else if (stats.isSymbolicLink()) {
      const target = await readlink(absolute);
      const resolvedTarget = resolve(dirname(absolute), target);
      assert(resolvedTarget === resolve(root) || resolvedTarget.startsWith(`${resolve(root)}/`), 'ARTIFACT_SYMLINK_UNSAFE', { child, target });
      entries.push({ path: child, type: 'symlink', target });
    } else if (stats.isFile()) {
      entries.push({ path: child, type: 'file', bytes: stats.size, mode: stats.mode & 0o777, sha256: await hashFile(absolute) });
    }
  }
}

function artifactIdentity(context, options) {
  const sourceSha = required(options.sourceSha, 'LOOKUP_SOURCE_SHA_REQUIRED');
  const treeDigest = required(options.treeDigest, 'LOOKUP_TREE_DIGEST_REQUIRED');
  const manifestDigest = required(options.manifestDigest, 'LOOKUP_MANIFEST_DIGEST_REQUIRED');
  const archiveSha256 = required(options.sha256, 'LOOKUP_ARCHIVE_DIGEST_REQUIRED');
  assert(/^[a-f0-9]{40}$/.test(sourceSha), 'LOOKUP_SOURCE_SHA_INVALID');
  assert(/^sha256:[a-f0-9]{64}$/.test(treeDigest), 'LOOKUP_TREE_DIGEST_INVALID');
  assert(/^sha256:[a-f0-9]{64}$/.test(manifestDigest), 'LOOKUP_MANIFEST_DIGEST_INVALID');
  assert(/^[a-f0-9]{64}$/.test(archiveSha256), 'LOOKUP_ARCHIVE_DIGEST_INVALID');
  return { project: context.project, target: context.target, sourceSha, treeDigest, manifestDigest, archiveSha256 };
}

function releasePath(context, identity) {
  return resolve(context.deployment.pointerRoot, 'releases', `${identity.sourceSha}-${identity.treeDigest.slice(7)}-${identity.manifestDigest.slice(7)}`);
}

function repairRecordPath(context, identity) {
  return join(context.deployment.pointerRoot, 'state', 'repaired-artifacts', `${identity.manifestDigest.slice(7)}.json`);
}

function placementReleasePointers(root) {
  return Promise.all(['current', 'previous', 'candidate'].map((name) => pointer(root, name)));
}

function canonicalArtifactPath(path) {
  return path?.replace(/(\/[a-f0-9]{40}-[a-f0-9]{64}-[a-f0-9]{64})\.repair-[a-f0-9]{16}$/, '$1') ?? null;
}

async function* storedReleasePaths(context, identity, pointers) {
  const root = context.deployment.pointerRoot;
  const canonical = releasePath(context, identity);
  const repair = await readJson(repairRecordPath(context, identity));
  const paths = [...(pointers ?? await placementReleasePointers(root)), canonical, repair?.release];
  const seen = new Set(paths.filter((path) => typeof path === 'string' && path).map((path) => resolve(root, path)));
  for (const path of seen) {
    if (canonicalArtifactPath(path) === canonical) yield path;
  }
  const directory = dirname(canonical);
  let names;
  try {
    names = await readdir(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const prefix = `${basename(canonical)}.repair-`;
  for (const name of names.sort()) {
    if (!name.startsWith(prefix) || !/^[a-f0-9]{16}$/.test(name.slice(prefix.length))) continue;
    const path = join(directory, name);
    if (!seen.has(path)) yield path;
  }
}

async function locateStoredRelease(context, identity, pointers) {
  const damage = [];
  for await (const release of storedReleasePaths(context, identity, pointers)) {
    try {
      if (!(await exists(release))) continue;
      return { release, manifest: await verifyStoredRelease(context, release, identity), damage };
    } catch (error) {
      if (!isStoredArtifactDamage(error)) throw error;
      damage.push({ release, error });
    }
  }
  return { release: releasePath(context, identity), manifest: null, damage };
}

function isStoredArtifactDamage(error) {
  return /^(EXISTING_RELEASE_|ARTIFACT_|CRITICAL_FILE_)/.test(error.code ?? '') ||
    ['CURRENT_RELEASE_TREE_MISMATCH', 'ENOENT', 'ENOTDIR'].includes(error.code);
}

async function verifyStoredRelease(context, release, identity) {
  const manifest = await readJson(join(release, 'AI_DELIVERY_ARTIFACT.json'));
  assert(manifest?.schema === 'ai.delivery.artifact.v1' && manifest.engineVersion === 2, 'EXISTING_RELEASE_MANIFEST_INVALID', { release });
  assert(manifest.project === identity.project && manifest.target === identity.target, 'EXISTING_RELEASE_SCOPE_MISMATCH', { release });
  assert(manifest.sourceSha === identity.sourceSha && manifest.treeDigest === identity.treeDigest && manifest.manifestDigest === identity.manifestDigest, 'EXISTING_RELEASE_IDENTITY_MISMATCH', { release });
  assert(/^sha256:[a-f0-9]{64}$/.test(manifest.archive?.sha256 ?? '') &&
    (!identity.archiveSha256 || manifest.archive.sha256 === `sha256:${identity.archiveSha256}`),
  'EXISTING_RELEASE_ARCHIVE_MISMATCH', { release });
  const claimedDigest = manifest.manifestDigest;
  const unsigned = { ...manifest };
  delete unsigned.manifestDigest;
  assert(claimedDigest === digest(unsigned), 'EXISTING_RELEASE_MANIFEST_DIGEST_MISMATCH', { release });
  assertManifestEntries(manifest);
  const evidence = await treeEvidence(release, new Set(['AI_DELIVERY_ARTIFACT.json']));
  assertCurrentTreeMatchesManifest(evidence, manifest, release);
  await verifyCriticalFiles(release, manifest.criticalFiles ?? []);
  return manifest;
}

function assertManifestEntries(manifest) {
  assert(Array.isArray(manifest.entries), 'ARTIFACT_FILE_LIST_REQUIRED');
  for (const entry of manifest.entries) {
    assert(entry && typeof entry.path === 'string' && ['directory', 'file', 'symlink'].includes(entry.type), 'ARTIFACT_FILE_LIST_INVALID', { entry });
    assertArtifactPath(entry.path);
  }
  assert(digest(manifest.entries) === manifest.treeDigest, 'ARTIFACT_FILE_LIST_DIGEST_MISMATCH');
  assert(manifest.entryCount === manifest.entries.length, 'ARTIFACT_ENTRY_COUNT_MISMATCH');
  assert(manifest.fileCount === manifest.entries.filter((entry) => entry.type === 'file').length, 'ARTIFACT_FILE_COUNT_MISMATCH');
  const totalBytes = manifest.entries.filter((entry) => entry.type === 'file').reduce((total, entry) => total + entry.bytes, 0);
  assert(manifest.totalBytes === totalBytes, 'ARTIFACT_TOTAL_BYTES_MISMATCH', { expected: manifest.totalBytes, actual: totalBytes });
}

function assertTreeMatchesManifest(evidence, manifest) {
  assert(evidence.treeDigest === manifest.treeDigest, 'ARTIFACT_TREE_HASH_MISMATCH', evidence);
  assert(evidence.fileCount === manifest.fileCount && evidence.entryCount === manifest.entryCount && evidence.totalBytes === manifest.totalBytes, 'ARTIFACT_TREE_SIZE_MISMATCH', evidence);
  assert(stableJson(evidence.entries) === stableJson(manifest.entries), 'ARTIFACT_FILE_LIST_MISMATCH');
}

function assertCurrentTreeMatchesManifest(evidence, manifest, release) {
  if (evidence.treeDigest === manifest.treeDigest) {
    assertTreeMatchesManifest(evidence, manifest);
    return;
  }
  assert(manifest.targetKind === 'frontend' && legacyReadableModesMatch(evidence, manifest), 'CURRENT_RELEASE_TREE_MISMATCH', { release });
}

function legacyReadableModesMatch(evidence, manifest) {
  if (evidence.fileCount !== manifest.fileCount || evidence.entryCount !== manifest.entryCount || evidence.totalBytes !== manifest.totalBytes) return false;
  if (evidence.entries.length !== manifest.entries.length) return false;
  return manifest.entries.every((expected, index) => {
    const actual = evidence.entries[index];
    const expectedWithoutMode = { ...expected };
    const actualWithoutMode = { ...actual };
    delete expectedWithoutMode.mode;
    delete actualWithoutMode.mode;
    if (stableJson(expectedWithoutMode) !== stableJson(actualWithoutMode)) return false;
    if (actual.mode === expected.mode) return true;
    if (expected.type === 'directory') return expected.mode === 0o700 && actual.mode === 0o755;
    if (expected.type === 'file') return [0o600, 0o700].includes(expected.mode) && actual.mode === 0o644;
    return false;
  });
}

function assertArtifactPath(path) {
  const normalized = path.replace(/\/+$/, '');
  const segments = normalized.split('/').filter(Boolean);
  const forbiddenDirectory = segments.find((segment) => FORBIDDEN_DIRECTORIES.has(segment));
  assert(!forbiddenDirectory, 'ARTIFACT_FORBIDDEN_PATH', { path, forbiddenDirectory });
  assert(!segments.some((segment, index) => segment === '.next' && segments[index + 1] === 'cache'), 'ARTIFACT_FORBIDDEN_PATH', { path, forbiddenDirectory: '.next/cache' });
  const leaf = segments.at(-1) ?? '';
  assert(!/\.(?:log|tmp|swp)$/i.test(leaf), 'ARTIFACT_FORBIDDEN_PATH', { path });
}

async function verifyCriticalFiles(root, criticalFiles) {
  for (const expected of criticalFiles) {
    const path = resolve(root, expected.path);
    assert(path.startsWith(`${resolve(root)}/`), 'CRITICAL_FILE_PATH_UNSAFE', expected);
    const stats = await lstat(path);
    assert(stats.isFile() && stats.size === expected.bytes && `sha256:${await hashFile(path)}` === expected.sha256, 'CRITICAL_FILE_INVALID', expected);
  }
}

async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function digest(value) {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`;
}

function stableJson(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortValue(value[key])])
    );
  }
  return value;
}

async function atomicPointer(link, target) {
  const temporary = join(dirname(link), `.${basename(link)}.${process.pid}.${Date.now()}`);
  await mkdir(dirname(link), { recursive: true });
  await symlink(target, temporary);
  await rename(temporary, link);
}

async function writeAtomicJson(path, value) {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}`);
  await mkdir(dirname(path), { recursive: true, mode: 0o755 });
  try {
    await writeFile(temporary, `${stableJson(value)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function restoreOptionalPointer(link, target) {
  if (target) await atomicPointer(link, target);
  else await rm(link, { force: true });
}

async function ensureTraversablePointerRoot(context) {
  const root = resolve(context.deployment.pointerRoot);
  const anchor = [...(context.policy.allowedRoots ?? [])]
    .map((entry) => resolve(entry))
    .filter((entry) => root === entry || root.startsWith(`${entry}/`))
    .sort((left, right) => right.length - left.length)[0];
  assert(anchor, 'POINTER_ROOT_NOT_ALLOWED', { root });
  const suffix = relative(anchor, root);
  assert(suffix !== '..' && !suffix.startsWith('../') && !suffix.startsWith('..\\'), 'POINTER_ROOT_NOT_ALLOWED', { root });
  let directory = anchor;
  for (const segment of suffix.split(/[\\/]/).filter(Boolean)) {
    directory = join(directory, segment);
    await mkdir(directory, { recursive: true, mode: 0o755 });
    const stats = await lstat(directory);
    assert(stats.isDirectory(), 'POINTER_DIRECTORY_INVALID', { directory });
    await chmod(directory, 0o755);
  }
}

async function pointer(root, name) {
  try {
    return await readlink(join(root, name));
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'EINVAL') return null;
    throw error;
  }
}

async function statusPointer(root, name) {
  const path = join(root, name);
  try {
    if (!(await lstat(path)).isSymbolicLink()) return null;
    return await readlink(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function assertAllowedRoot(policy, path) {
  assert(path.startsWith('/') && path !== '/', 'POINTER_ROOT_UNSAFE', { path });
  assert(
    (policy.allowedRoots ?? []).some((root) => path === root || path.startsWith(`${root}/`)),
    'POINTER_ROOT_NOT_ALLOWED',
    { path }
  );
}

function assertIncomingPath(policy, path) {
  const root = required(policy.incomingRoot, 'INCOMING_ROOT_REQUIRED');
  assert(path.startsWith(`${root}/`) && !path.includes('/../'), 'INCOMING_PATH_NOT_ALLOWED', { path, root });
}

function validatePolicy(policy, project, selectedNode, selectedTargets, action) {
  const recoveryOrObservation = ['status', 'observe', 'rollback', 'artifact-pin'].includes(action);
  assert(policy?.schema === 'ai.delivery.remote-policy.v1' && policy.project === project, 'POLICY_INVALID');
  assert(Array.isArray(policy.allowedRoots) && policy.allowedRoots.length > 0, 'POLICY_ALLOWED_ROOTS_REQUIRED');
  for (const root of policy.allowedRoots) assert(typeof root === 'string' && root.startsWith('/') && root !== '/', 'POLICY_ALLOWED_ROOT_INVALID', { root });
  if (!recoveryOrObservation) {
    assert(typeof policy.incomingRoot === 'string' && policy.incomingRoot.startsWith('/'), 'POLICY_INCOMING_ROOT_INVALID');
    validateReadiness(policy.readiness, 'policy');
  }
  assert(policy.nodes && typeof policy.nodes === 'object', 'POLICY_NODES_REQUIRED');
  const pointerRoots = new Set();
  for (const [node, nodePolicy] of Object.entries(policy.nodes)) {
    if (node !== selectedNode) continue;
    assert(nodePolicy?.deployments && typeof nodePolicy.deployments === 'object', 'POLICY_DEPLOYMENTS_REQUIRED', { node });
    for (const [target, deployment] of Object.entries(nodePolicy.deployments)) {
      if (!selectedTargets.includes(target)) continue;
      assert(typeof deployment.pointerRoot === 'string', 'POLICY_POINTER_ROOT_REQUIRED', { node, target });
      assertAllowedRoot(policy, deployment.pointerRoot);
      assert(!pointerRoots.has(deployment.pointerRoot), 'POLICY_POINTER_ROOT_DUPLICATE', { node, target, pointerRoot: deployment.pointerRoot });
      pointerRoots.add(deployment.pointerRoot);
      if (action === 'rollback') {
        assert(['none', 'systemd', 'pm2'].includes(deployment.restart?.kind) && typeof deployment.restart?.name === 'string', 'POLICY_RESTART_INVALID', { node, target });
      }
      if (recoveryOrObservation) continue;
      assert(['none', 'systemd', 'pm2'].includes(deployment.restart?.kind), 'POLICY_RESTART_INVALID', { node, target });
      assert(typeof deployment.restart?.name === 'string', 'POLICY_RESTART_NAME_REQUIRED', { node, target });
      if (deployment.restart?.kind === 'systemd') {
        assert(['replace', 'ignore-dependencies'].includes(deployment.restart.jobMode ?? 'replace'), 'POLICY_RESTART_JOB_MODE_INVALID', { node, target });
      } else {
        assert(deployment.restart?.jobMode === undefined, 'POLICY_RESTART_JOB_MODE_UNSUPPORTED', { node, target });
      }
      if (deployment.databaseMigration) {
        const migration = deployment.databaseMigration;
        assert(deployment.restart?.kind === 'none', 'POLICY_DATABASE_MIGRATION_RESTART_FORBIDDEN', { node, target });
        assert(typeof migration.executionRoot === 'string' && typeof migration.environmentFile === 'string', 'POLICY_DATABASE_MIGRATION_SOURCE_REQUIRED', { node, target });
        assertAllowedRoot(policy, migration.executionRoot);
        assertAllowedRoot(policy, migration.environmentFile);
        if (migration.executionMode === 'database-owner') {
          assert(typeof migration.credentialFile === 'string', 'POLICY_DATABASE_MIGRATION_OWNER_CREDENTIAL_REQUIRED', { node, target });
          assertAllowedRoot(policy, migration.credentialFile);
          assert(migration.ownerDatabaseHost === '127.0.0.1' && Number.isInteger(migration.ownerDatabasePort) && migration.ownerDatabasePort > 0 && migration.ownerDatabasePort <= 65535, 'POLICY_DATABASE_MIGRATION_OWNER_ENDPOINT_INVALID', {
            node,
            target,
          });
        } else {
          assert(migration.executionMode === undefined || migration.executionMode === 'migration-role', 'POLICY_DATABASE_MIGRATION_EXECUTION_MODE_INVALID', { node, target });
          assert(migration.credentialFile === undefined && migration.ownerDatabaseHost === undefined && migration.ownerDatabasePort === undefined, 'POLICY_DATABASE_MIGRATION_OWNER_CONFIGURATION_UNEXPECTED', { node, target });
        }
        assert(safeRelative(migration.runner) && safeRelative(migration.migrationDirectory), 'POLICY_DATABASE_MIGRATION_PATH_INVALID', { node, target });
        assert(migration.nodeBinary === undefined || (typeof migration.nodeBinary === 'string' && migration.nodeBinary.startsWith('/')), 'POLICY_DATABASE_MIGRATION_NODE_INVALID', { node, target });
        assert(Number.isInteger(migration.timeoutMs) && migration.timeoutMs > 0, 'POLICY_DATABASE_MIGRATION_TIMEOUT_INVALID', { node, target });
        assert((migration.runtimeUser === undefined) === (migration.runtimeGroup === undefined), 'POLICY_DATABASE_MIGRATION_IDENTITY_INCOMPLETE', { node, target });
        if (migration.runtimeUser) {
          safeName(migration.runtimeUser);
          safeName(migration.runtimeGroup);
        }
        assert(migration.recovery?.mode === 'forward-only' && typeof migration.recovery.snapshot === 'string', 'POLICY_DATABASE_MIGRATION_RECOVERY_INVALID', { node, target });
      }
      if (deployment.allowBaselineImport !== undefined) assert(typeof deployment.allowBaselineImport === 'boolean', 'POLICY_BASELINE_IMPORT_INVALID', { node, target });
      if (deployment.baselineStrategy !== undefined) assert(deployment.baselineStrategy === 'register-current', 'POLICY_BASELINE_STRATEGY_INVALID', { node, target });
      for (const input of deployment.seedInputs ?? []) {
        assert(safeRelative(input.source) && safeRelative(input.destination), 'POLICY_SEED_PATH_INVALID', { node, target, input });
      }
      if (deployment.seedDependencyLayer) {
        const layer = deployment.seedDependencyLayer;
        assert(safeRelative(layer.source) && typeof layer.runtime === 'string' && layer.runtime.length > 0, 'POLICY_SEED_LAYER_INVALID', { node, target });
        assert(Array.isArray(layer.keyFiles) && layer.keyFiles.length > 0 && layer.keyFiles.every(safeRelative), 'POLICY_SEED_LAYER_KEYS_INVALID', { node, target });
        assert((policy.allowedDependencyRoots ?? []).includes(layer.productionRoot), 'POLICY_SEED_LAYER_ROOT_INVALID', { node, target });
      }
      if ((deployment.seedInputs ?? []).length > 0) {
        assert(typeof nodePolicy.legacyRoot === 'string', 'POLICY_LEGACY_ROOT_REQUIRED', { node, target });
        assertAllowedRoot(policy, nodePolicy.legacyRoot);
      }
      validateReadiness(deployment.readiness, `${node}/${target}`);
      for (const check of [...(deployment.candidateChecks ?? []), ...(deployment.healthChecks ?? [])]) {
        assert(Array.isArray(check.argv) && check.argv.length > 0 && check.argv.every((value) => typeof value === 'string' && value.length > 0), 'POLICY_CHECK_INVALID', { node, target });
      }
    }
  }
}

function validateReadiness(readiness, scope) {
  if (readiness === undefined) return;
  assert(readiness && typeof readiness === 'object' && !Array.isArray(readiness), 'POLICY_READINESS_INVALID', { scope });
  const settings = { ...DEFAULT_READINESS, ...readiness };
  for (const key of ['timeoutMs', 'intervalMs', 'attemptTimeoutMs']) {
    assert(Number.isInteger(settings[key]) && settings[key] > 0, 'POLICY_READINESS_VALUE_INVALID', { scope, key, value: settings[key] });
  }
  assert(Number.isInteger(settings.hardFailureGraceMs) && settings.hardFailureGraceMs >= 0, 'POLICY_READINESS_VALUE_INVALID', { scope, key: 'hardFailureGraceMs', value: settings.hardFailureGraceMs });
  assert(settings.intervalMs <= settings.timeoutMs && settings.attemptTimeoutMs <= settings.timeoutMs && settings.hardFailureGraceMs <= settings.timeoutMs, 'POLICY_READINESS_WINDOW_INVALID', { scope, settings });
}

function safeRelative(value) {
  return typeof value === 'string' && value.length > 0 && !value.startsWith('/') && !value.split('/').includes('..');
}

function parseOptions(tokens) {
  const result = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const token = tokens[index];
    const value = tokens[index + 1];
    assert(token?.startsWith('--') && value !== undefined, 'OPTION_INVALID', { token });
    result[token.slice(2).replace(/-([a-z])/g, (_, character) => character.toUpperCase())] = value;
  }
  return result;
}

function contextSummary(context) {
  return { project: context.project, node: context.node, target: context.target };
}

async function preparedControlPlane(options, policyBody) {
  const sourceSha = required(options.controlSha, 'CONTROL_PLANE_SHA_REQUIRED');
  const runId = required(options.githubRunId, 'CONTROL_PLANE_RUN_ID_REQUIRED');
  const runAttempt = required(options.githubRunAttempt, 'CONTROL_PLANE_RUN_ATTEMPT_REQUIRED');
  assert(/^[a-f0-9]{40}$/.test(sourceSha), 'CONTROL_PLANE_SHA_INVALID');
  assert(/^[1-9][0-9]*$/.test(runId), 'CONTROL_PLANE_RUN_ID_INVALID');
  assert(/^[1-9][0-9]*$/.test(runAttempt), 'CONTROL_PLANE_RUN_ATTEMPT_INVALID');
  return {
    sourceSha,
    github: { runId, runAttempt },
    remoteAgentSha256: `sha256:${await hashFile(fileURLToPath(import.meta.url))}`,
    remotePolicySha256: `sha256:${createHash('sha256').update(policyBody).digest('hex')}`,
  };
}

function expand(value, values) {
  return String(value).replace(/\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g, (_, key) => {
    assert(key in values, 'CHECK_TEMPLATE_UNKNOWN', { key });
    return String(values[key]);
  });
}

async function audit(policy, record) {
  const auditRoot = policy.auditRoot ?? '/var/log/ai-delivery';
  await mkdir(auditRoot, { recursive: true });
  await appendFile(join(auditRoot, `${safeName(policy.project)}.jsonl`), `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function lstatOrNull(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function safeName(value) {
  assert(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value), 'IDENTIFIER_UNSAFE', { value });
  return value;
}

function required(value, code) {
  if (!value) throw failure(code);
  return value;
}

function assert(condition, code, details = {}) {
  if (!condition) throw failure(code, details);
}

function failure(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  return error;
}
