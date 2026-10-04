#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, chmod, copyFile, cp, link, lstat, mkdir, readFile, readlink, readdir, realpath, rename, rm, statfs, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

let actionName = 'unknown';
let loadedPolicy = null;
let loadedContext = null;

const FORBIDDEN_DIRECTORIES = new Set(['.git', '.npm', '.nyc_output', '.turbo', '_cacache', 'coverage', 'logs', 'node_modules', 'playwright-report', 'releases', 'test-results', 'tmp', 'temp']);
const MAX_ARTIFACT_BYTES = 150_000_000;
const MAX_DEPENDENCY_LAYER_ARCHIVE_BYTES = 1_500_000_000;
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
  const policyRoot = process.env.AI_DELIVERY_POLICY_ROOT ?? '/etc/ai-delivery/projects';
  const project = safeName(required(options.project, 'PROJECT_REQUIRED'));
  const policyPath = join(policyRoot, `${project}.json`);
  const policyBody = await readFile(policyPath);
  const policy = JSON.parse(policyBody.toString('utf8'));
  loadedPolicy = policy;
  validatePolicy(policy, project);
  const nodeKey = safeName(required(options.node, 'NODE_REQUIRED'));
  const nodePolicy = policy.nodes?.[nodeKey];
  assert(nodePolicy, 'NODE_NOT_ALLOWED');
  const preparedActions = new Set(['deploy-oss-direct', 'validate-oss-candidate', 'deploy-oss-direct-v2', 'validate-oss-candidate-v2', 'validate-oss-candidate-v3']);
  const controlPlane = preparedActions.has(action) ? await preparedControlPlane(options, policyBody) : null;
  const makeContext = (targetId) => {
    const deployment = nodePolicy.deployments?.[targetId];
    assert(deployment, 'DEPLOYMENT_NOT_ALLOWED', { node: nodeKey, target: targetId });
    return { project, node: nodeKey, target: targetId, deployment, nodePolicy, policy, controlPlane };
  };
  const targetId = action === 'observe' ? null : safeName(required(options.target, 'TARGET_REQUIRED'));
  const context = targetId ? makeContext(targetId) : null;
  loadedContext = context;
  if (preparedActions.has(action) && (action.endsWith('-v2') || action.endsWith('-v3'))) assertExpectedPreparedControlPlane(controlPlane, options);

  let result;
  if (action === 'observe') {
    const targetIds = required(options.targets, 'TARGETS_REQUIRED').split(',').map((target) => safeName(target));
    assert(targetIds.length > 0 && new Set(targetIds).size === targetIds.length, 'TARGETS_INVALID');
    result = await observeMany(targetIds.map(makeContext));
  } else if (action === 'lookup') result = await lookup(context, options);
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
  else if (action === 'rollback') result = await rollback(context);
  else if (action === 'verify') result = await verifyCurrent(context);
  else if (action === 'status') result = await status(context);
  else throw failure('ACTION_UNKNOWN', { action });

  if (action !== 'status' && action !== 'observe') await audit(policy, { action, ...contextSummary(context), result, completedAt: new Date().toISOString() });
  process.stdout.write(`${JSON.stringify({ ok: true, action, result }, null, 2)}\n`);
} catch (error) {
  if (actionName !== 'status' && actionName !== 'observe' && loadedPolicy && loadedContext) {
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

async function stage(context, options, direct = false) {
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
  const release = join(releases, `${manifest.sourceSha}-${manifest.treeDigest.slice(7)}-${claimedDigest.slice(7)}`);
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
    cacheStatus: 'miss',
    artifactBytes: manifest.archive.bytes,
    uploadedBytes: manifest.archive.bytes,
    reusedBytes: 0,
    timings,
  };
}

async function deployOssDirect(context, options) {
  const started = Date.now();
  const prepared = await prepareOssCandidate(context, options, true);
  const activation = await activateDirect(context, options);
  return {
    ...prepared,
    schema: 'ai.delivery.oss-direct.v1',
    activation,
    timings: { ...prepared.timings, total: Date.now() - started },
  };
}

async function validateOssCandidate(context, options) {
  return prepareOssCandidate(context, options, false);
}

async function prepareOssCandidate(context, options, direct) {
  const started = Date.now();
  const identity = artifactIdentity(context, options);
  const found = await lookup(context, options);
  const ingressPayload = context.deployment.databaseMigration?.initialize?.ingress && !context.deployment.databaseMigration.initialize.applyBusiness ? await readStdinJson() : null;
  if (ingressPayload) context.cloudflare = ingressPayload.cloudflare;
  let staged;
  let downloadedBytes = 0;
  let downloadMs = 0;
  if (found.exists) {
    staged = await reuse(context, options, direct);
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
      staged = await stage(context, { ...options, archive, manifest }, direct);
    } finally {
      await Promise.all([rm(archive, { force: true }), rm(manifest, { force: true })]);
    }
  }
  const currentAfter = await pointer(context.deployment.pointerRoot, 'current');
  assert(currentAfter === found.current, 'CANDIDATE_VALIDATION_MOVED_CURRENT', { before: found.current, after: currentAfter });
  const currentSourceSha = await releaseSourceSha(context, currentAfter);
  return {
    schema: 'ai.delivery.oss-candidate.v1',
    sourceSha: identity.sourceSha,
    artifactSha256: `sha256:${identity.archiveSha256}`,
    controlPlane: context.controlPlane,
    cacheStatus: found.exists ? found.status : 'miss',
    downloadedBytes,
    reusedBytes: found.exists ? found.artifactBytes : 0,
    staged,
    current: { before: found.current, after: currentAfter, sourceSha: currentSourceSha, unchanged: true },
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

async function readStdinJson() {
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
  assert(typeof payload.artifactUrl === 'string' && typeof payload.manifestUrl === 'string', 'OSS_DOWNLOAD_URL_REQUIRED');
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

async function lookup(context, options) {
  const started = Date.now();
  const identity = artifactIdentity(context, options);
  const release = releasePath(context, identity);
  const candidate = await pointer(context.deployment.pointerRoot, 'candidate');
  const current = await pointer(context.deployment.pointerRoot, 'current');
  if (!(await exists(release))) {
    return { status: 'miss', exists: false, release, candidate, current, artifactLookupMs: Date.now() - started };
  }
  const manifest = await verifyStoredRelease(context, release, identity);
  const status = candidate === release ? 'hit_candidate' : current === release ? 'hit_current' : 'hit_release';
  return {
    status,
    exists: true,
    release,
    candidate,
    current,
    sourceSha: manifest.sourceSha,
    treeDigest: manifest.treeDigest,
    artifactBytes: manifest.archive.bytes,
    uploadedBytes: 0,
    reusedBytes: manifest.archive.bytes,
    artifactLookupMs: Date.now() - started,
  };
}

async function reuse(context, options, direct = false) {
  const started = Date.now();
  const found = await lookup(context, options);
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
  if (found.candidate !== found.release) await atomicPointer(join(context.deployment.pointerRoot, 'candidate'), found.release);
  const pointerMs = Date.now() - pointerStarted;
  return {
    ...found,
    status: found.candidate === found.release ? 'hit_candidate' : 'hit_release',
    candidate: found.release,
    cacheStatus: found.status,
    timings: { artifactLookup: found.artifactLookupMs, candidateChecks, pointer: pointerMs, total: Date.now() - started },
  };
}

async function activateDirect(context, options) {
  const root = context.deployment.pointerRoot;
  assertAllowedRoot(context.policy, root);
  const candidate = await pointer(root, 'candidate');
  assert(candidate, 'CANDIDATE_MISSING');
  const manifest = JSON.parse(await readFile(join(candidate, 'AI_DELIVERY_ARTIFACT.json'), 'utf8'));
  const sourceSha = required(options.sourceSha, 'DIRECT_SOURCE_SHA_REQUIRED');
  assert(manifest.sourceSha === sourceSha, 'DIRECT_SOURCE_SHA_MISMATCH', { expected: sourceSha, actual: manifest.sourceSha });
  const previousCurrent = await pointer(root, 'current');
  const activated = await activate(context, {
    ...options,
    approval: `${context.project}:${sourceSha}`,
    expectedCurrent: previousCurrent ?? 'none',
  });
  return {
    ...activated,
    direct: true,
    mode: activated.alreadyCurrent ? 'direct-verify-only' : 'direct-activated',
  };
}

async function activate(context, options) {
  const started = Date.now();
  const timings = { candidate: 0, snapshot: 0, cutover: 0, restart: 0, health: 0, isolation: 0 };
  const root = context.deployment.pointerRoot;
  assertAllowedRoot(context.policy, root);
  const candidate = await pointer(root, 'candidate');
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
  assert(previousCurrent === expectedCurrent, 'CURRENT_POINTER_CHANGED', { expected: expectedCurrent, actual: previousCurrent });
  assert(previousCurrent || context.deployment.allowFirstActivation === true, 'CURRENT_POINTER_REQUIRED_FOR_ROLLBACK', { root });
  const targetProcessBefore = await processId(context.deployment.restart);
  const previousRuntime = await pointer(root, 'runtime');
  const candidateRuntime = await dependencyLayerPath(context, manifest.dependencyLayer);
  const caddyBefore = await caddySemanticEvidence(context.policy);
  if (options.expectedCaddySemantic) assert(caddyBefore?.digest === options.expectedCaddySemantic, 'CADDY_SEMANTIC_CHANGED_BEFORE_CUTOVER', { expected: options.expectedCaddySemantic, actual: caddyBefore?.digest });
  const rollbackPoint = context.deployment.databaseMigration
    ? { status: 'not-applicable', reason: 'database-migrations-are-forward-only', recovery: databaseRecoveryEvidence(context.deployment.databaseMigration), pointers: pointersBefore }
    : previousCurrent === candidate
      ? { status: 'not-required', reason: 'candidate-is-already-current', pointers: pointersBefore }
      : await recordRollbackPoint(context, manifest, pointersBefore, caddyBefore);
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
  if (previousCurrent === candidate && targetProcessBefore !== '0') {
    const readiness = await waitForReadiness(context, { candidateDir: candidate, currentDir: candidate, ...contextSummary(context) });
    timings.health = readiness.durationMs;
    const isolationStarted = Date.now();
    const protectedAfter = await assertProtectedUnchanged(context, protectedBefore);
    const caddyAfter = await caddySemanticEvidence(context.policy);
    assert(caddyAfter?.digest === caddyBefore?.digest, 'CADDY_SEMANTIC_CHANGED', { before: caddyBefore?.digest, after: caddyAfter?.digest });
    timings.isolation = Date.now() - isolationStarted;
    timings.total = Date.now() - started;
    return {
      mode: 'verify-only',
      alreadyCurrent: true,
      current: candidate,
      runtime: await pointer(root, 'runtime'),
      previous: await pointer(root, 'previous'),
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
  let protectedAfter = null;
  try {
    const cutoverStarted = Date.now();
    if (previousCurrent && previousCurrent !== candidate) await atomicPointer(join(root, 'previous'), previousCurrent);
    if (previousRuntime) await atomicPointer(join(root, 'previous-runtime'), previousRuntime);
    if (candidateRuntime) await atomicPointer(join(root, 'runtime'), candidateRuntime);
    await atomicPointer(join(root, 'current'), candidate);
    timings.cutover = Date.now() - cutoverStarted;
    const restartStarted = Date.now();
    activationRestart = await restart(context.deployment.restart);
    timings.restart = Date.now() - restartStarted;
    readiness = await waitForReadiness(context, { candidateDir: candidate, currentDir: candidate, ...contextSummary(context) });
    timings.health = readiness.durationMs;
    const targetProcessAfter = await processId(context.deployment.restart);
    if (context.deployment.restart?.kind !== 'none') {
      assert(targetProcessAfter !== '0' && targetProcessAfter !== targetProcessBefore, 'TARGET_PROCESS_NOT_RESTARTED', { before: targetProcessBefore, after: targetProcessAfter });
    }
    const isolationStarted = Date.now();
    protectedAfter = await assertProtectedUnchanged(context, protectedBefore);
    timings.isolation = Date.now() - isolationStarted;
    const caddyAfter = await caddySemanticEvidence(context.policy);
    assert(caddyAfter?.digest === caddyBefore?.digest, 'CADDY_SEMANTIC_CHANGED', { before: caddyBefore?.digest, after: caddyAfter?.digest });
    const currentAfterHealth = await pointer(root, 'current');
    assert(currentAfterHealth === candidate, 'CUTOVER_SUPERSEDED', { candidate, current: currentAfterHealth, previousCurrent });
  } catch (candidateError) {
    const currentAtFailure = await pointer(root, 'current');
    if (currentAtFailure !== candidate && currentAtFailure !== previousCurrent) {
      throw failure('CUTOVER_SUPERSEDED', {
        candidate,
        current: currentAtFailure,
        previousCurrent,
        candidateFailure: errorEvidence(candidateError),
        recovery: 'not-performed-because-a-newer-cutover-owns-current',
      });
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
      await chmod(previousCurrent, 0o755);
      const pointerStarted = performance.now();
      rollback.startedAt = new Date().toISOString();
      rollback.triggerDelayMs = elapsedMs(failureDetectedAt);
      await atomicPointer(join(root, 'current'), previousCurrent);
      await restoreOptionalPointer(join(root, 'runtime'), previousRuntime);
      rollback.pointerRestoreMs = elapsedMs(pointerStarted);
      const restartStarted = performance.now();
      rollback.restart = await restart(context.deployment.restart);
      rollback.restartMs = elapsedMs(restartStarted);
      const failureResetStarted = performance.now();
      await resetFailureState(context.deployment.restart);
      rollback.failureResetMs = elapsedMs(failureResetStarted);
      const rollbackReadiness = await waitForReadiness(context, { candidateDir: previousCurrent, currentDir: previousCurrent, ...contextSummary(context) });
      rollback.readiness = rollbackReadiness;
      rollback.readinessMs = rollbackReadiness.durationMs;
      protectedAfter = await assertProtectedUnchanged(context, protectedBefore);
      rollback.finalCurrent = await pointer(root, 'current');
      rollback.finalRuntime = await pointer(root, 'runtime');
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
    mode: 'activated',
    alreadyCurrent: false,
    current: candidate,
    runtime: await pointer(root, 'runtime'),
    previous: await pointer(root, 'previous'),
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
  const nodeManifest = await readJson(join(root, 'manifest.json'));
  const apiToken = context.cloudflare?.apiToken?.trim();
  if (!apiToken) throw new Error('CLOUDFLARE_INGRESS_CREDENTIALS_MISSING');
  const zoneResponse = await fetch(`https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(setup.zoneName)}`, {
    headers: { authorization: `Bearer ${apiToken}` }, signal: AbortSignal.timeout(30000),
  });
  const zone = await zoneResponse.json();
  if (!zoneResponse.ok || !zone.success) throw new Error(`CLOUDFLARE_ZONE_FAILED:${zoneResponse.status}:${JSON.stringify(zone.errors)}`);
  const matchedZone = zone.result.find((item) => item.name === setup.zoneName);
  if (!matchedZone) throw new Error(`CLOUDFLARE_ZONE_NOT_FOUND:${setup.zoneName}`);
  const zoneId = matchedZone.id;
  const { AutoNodeCloudflareClient } = await import(pathToFileURL(join(bootstrap, 'autonode-cloudflare.mjs')).href);
  const { gatewayConfiguration } = await import(pathToFileURL(join(bootstrap, 'generate-sfl-node-gateway.mjs')).href);
  const client = new AutoNodeCloudflareClient({ accountId: matchedZone.account.id, zoneId, apiToken });
  const secret = createHash('sha256').update(`${credentials.POSTGRES_PASSWORD}\0LK_TUNNEL:${context.node}`).digest('base64');
  const tunnel = await client.ensureTunnel(setup.tunnelName, secret);
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
  for (const host of hosts) records.push(await client.ensureCname(host, `${tunnel.id}.cfargotunnel.com`, `LK ${context.node}`));
  const serviceState = (await command(['systemctl', 'is-active', ...services])).stdout.trim().split(/\s+/);
  const apiHost = nodeManifest.domain_bindings.find((binding) => binding.surface_ref === 'surface:api').host;
  const localResponse = await command(['curl', '--fail', '--silent', '--show-error', '--max-time', '10', '-H', `Host: ${apiHost}`, `http://127.0.0.1:${setup.ports.gateway}/health/gateway`]);
  return { schema: 'ai.delivery.database-migration-result.v1', sourceSha: artifact.sourceSha, status: 'initialized', node: context.node,
    ingress: { tunnelId: tunnel.id, records, services: services.map((name, index) => ({ name, state: serviceState[index] })),
      gateway: JSON.parse(localResponse.stdout), applicationActivation: 'pending' }, migrationsApplied: false, credentialsReported: false };
}

async function initializeNodeDatabase(context, candidate, manifest) {
  const setup = context.deployment.databaseMigration.initialize;
  if (setup.ingress) return initializeNodeIngress(context, candidate, manifest);
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
      'ZHUDATUANBOOTSTRAP_PASSWORD','DATABASE_SENTINEL','ZHUDATUAN_IDENTITY_API_PASSWORD','ZHUDATUAN_WEB_API_PASSWORD']) {
      credentials[key] = randomBytes(36).toString('base64url');
    }
    await writeFile(credentialFile, environmentText(credentials), { mode: 0o600 });
  }
  const bootstrap = join(candidate, 'database/bootstrap');
  const initFile = join(database, 'postgres-init.sh');
  await copyFile(join(bootstrap, 'postgres-init.sh'), initFile);
  await chmod(initFile, 0o644);
  const container = `${context.node}-postgres`;
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
`;
  await command(['docker','exec','-i',container,'psql','-X','-v','ON_ERROR_STOP=1','-U',credentials.POSTGRES_USER,'-d',credentials.POSTGRES_DB], { input: roleSql });
  const sourceRoot = join('/opt/sfl/nodes', setup.environmentSource, 'runtime');
  const inputs = {};
  for (const target of ['identity-api','web-api','storefront']) {
    inputs[target] = parseEnvironmentFile(await readFile(join(sourceRoot, `${target}.env`), 'utf8'));
  }
  const prefix = setup.secretPrefix;
  const secretsFile = join(runtime, 'secrets.json');
  let secrets = await readJson(secretsFile) ?? {};
  for (const [target, role, password] of [
    ['identity-api','zhudatuanidentityapi',credentials.ZHUDATUAN_IDENTITY_API_PASSWORD],
    ['web-api','zhudatuanwebapi',credentials.ZHUDATUAN_WEB_API_PASSWORD]]) {
    secrets[`${prefix}/database/${target}`] = `postgresql://${role}:${password}@127.0.0.1:${setup.port}/${credentials.POSTGRES_DB}`;
  }
  for (const key of ['identity/session','identity/index']) secrets[`${prefix}/${key}`] ??= randomBytes(36).toString('base64url');
  await writeFile(secretsFile, JSON.stringify(secrets, null, 2) + '\n', { mode: 0o640 });
  const origins = setup.origins;
  const nodeManifest = await readJson(join(candidate, 'node-runtime/manifest.json'));
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
      env.API_PORT = String(setup.servicePorts[target]);
      env.API_ALLOWED_ORIGINS = [origins.identity, origins.console, origins.storefront].filter(Boolean).join(',');
      env.DATABASE_API_CONNECTION_REF = `${prefix}/database/${target}`;
      env.DATABASE_API_ROLE = target === 'identity-api' ? 'zhudatuanidentityapi' : 'zhudatuanwebapi';
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
  for (const name of ['sfl-storefront@.service','sfl-identity-api@.service','sfl-web-api@.service','sfl-catalog-object-store@.service','sfl-secret-store@.service']) {
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
  if (context.deployment.databaseMigration.initialize && !context.deployment.databaseMigration.initialize.applyBusiness) {
    const result = await initializeNodeDatabase(context, candidate, manifest);
    return { ...result, restart: restartEvidence(context.deployment.restart, false) };
  }
  const definition = context.deployment.databaseMigration;
  if (definition.initialize?.applyBusiness) {
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

async function rollback(context) {
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
  const [current, previous, currentRuntime, previousRuntime] = await Promise.all([pointer(root, 'current'), pointer(root, 'previous'), pointer(root, 'runtime'), pointer(root, 'previous-runtime')]);
  assert(previous, 'ROLLBACK_POINTER_MISSING');
  await ensureTraversablePointerRoot(context);
  const protectedBefore = await protectedProcessSnapshot(context);
  const started = performance.now();
  const timings = { pointer: 0, restart: 0, readiness: 0, isolation: 0, total: 0 };
  await chmod(previous, 0o755);
  const pointerStarted = performance.now();
  await atomicPointer(join(root, 'current'), previous);
  if (current) await atomicPointer(join(root, 'previous'), current);
  await restoreOptionalPointer(join(root, 'runtime'), previousRuntime);
  await restoreOptionalPointer(join(root, 'previous-runtime'), currentRuntime);
  timings.pointer = elapsedMs(pointerStarted);
  const restartStarted = performance.now();
  const restartOperation = await restart(context.deployment.restart);
  timings.restart = elapsedMs(restartStarted);
  const readiness = await waitForReadiness(context, { candidateDir: previous, currentDir: previous, ...contextSummary(context) });
  timings.readiness = readiness.durationMs;
  const isolationStarted = performance.now();
  const protectedAfter = await assertProtectedUnchanged(context, protectedBefore);
  timings.isolation = elapsedMs(isolationStarted);
  timings.total = elapsedMs(started);
  return { current: previous, previous: current, runtime: previousRuntime, restart: restartOperation, readiness, timings, rollbackMs: timings.total, protectedProcesses: { before: protectedBefore, after: protectedAfter } };
}

async function status(context) {
  const root = context.deployment.pointerRoot;
  const candidate = await statusPointer(root, 'candidate');
  const current = await statusPointer(root, 'current');
  const previous = await statusPointer(root, 'previous');
  return {
    pointerRoot: root,
    candidate,
    candidateArtifact: await artifactForStatus(candidate),
    current,
    currentArtifact: await artifactForStatus(current),
    previous,
    previousArtifact: await artifactForStatus(previous),
    runtime: await statusPointer(root, 'runtime'),
    previousRuntime: await statusPointer(root, 'previous-runtime'),
    restart: context.deployment.restart,
  };
}

async function observeMany(contexts) {
  const targets = await Promise.all(contexts.map(async (context) => {
    let targetStatus;
    try {
      targetStatus = await status(context);
      const verification = await verifyCurrent(context);
      return { target: context.target, status: targetStatus, verification };
    } catch (error) {
      return { target: context.target, status: targetStatus ?? null, verification: null, error: errorEvidence(error) };
    }
  }));
  return { targets };
}

async function artifactForStatus(release) {
  return release ? await readJson(join(release, 'AI_DELIVERY_ARTIFACT.json')) : null;
}

async function verifyCurrent(context) {
  const root = context.deployment.pointerRoot;
  const current = await pointer(root, 'current');
  assert(current, 'CURRENT_POINTER_MISSING', { root });
  const readiness = await waitForReadiness(context, { candidateDir: '', currentDir: current, ...contextSummary(context) });
  const protectedProcesses = {};
  for (const definition of context.policy.protectedProcesses ?? []) {
    protectedProcesses[`${definition.kind}:${definition.name}`] = await processId(definition);
  }
  return {
    current,
    currentArtifact: await readJson(join(current, 'AI_DELIVERY_ARTIFACT.json')),
    targetProcess: await processId(context.deployment.restart),
    checks: readiness.checks,
    readiness,
    protectedProcesses,
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
  return Object.fromEntries(await Promise.all(['candidate', 'current', 'previous', 'rollback', 'runtime', 'previous-runtime'].map(async (name) => [name, await pointer(root, name)])));
}

async function capacityEvidence(context, artifactBytes) {
  const stats = await statfs(context.deployment.pointerRoot).catch(() => statfs(dirname(context.deployment.pointerRoot)));
  const freeBytes = Number(stats.bavail) * Number(stats.bsize);
  const minimumFreeBytes = context.policy.minimumFreeBytes ?? 15 * 1024 ** 3;
  assert(freeBytes - artifactBytes >= minimumFreeBytes, 'CAPACITY_CHECK_FAILED', { freeBytes, artifactBytes, minimumFreeBytes });
  return { status: 'passed', freeBytes, artifactBytes, minimumFreeBytes };
}

async function caddySemanticEvidence(policy) {
  if (!policy.caddyConfig) return { status: 'not-configured', digest: null, config: null };
  const adapted = await command(['caddy', 'adapt', '--config', policy.caddyConfig, '--adapter', 'caddyfile'], { timeoutMs: 30_000 });
  return { status: 'unchanged', digest: digest(adapted.stdout), config: policy.caddyConfig };
}

async function recordRollbackPoint(context, manifest, pointers, caddySemantic) {
  const root = context.policy.rollbackRoot ?? join(context.deployment.pointerRoot, 'rollback-points');
  assertAllowedRoot(context.policy, root);
  const id = `${Date.now()}-${safeName(context.node)}-${safeName(context.target)}-${manifest.sourceSha.slice(0, 12)}`;
  const directory = join(root, safeName(context.project), id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let caddyBackup = null;
  if (context.policy.caddyConfig) {
    caddyBackup = join(directory, 'Caddyfile');
    await copyFile(context.policy.caddyConfig, caddyBackup);
    await chmod(caddyBackup, 0o600);
  }
  const evidence = { id, directory, pointers, caddyBackup, caddySemantic, createdAt: new Date().toISOString() };
  await writeFile(join(directory, 'rollback-point.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  return evidence;
}

function artifactSummary(manifest) {
  return { sourceSha: manifest.sourceSha, treeDigest: manifest.treeDigest, manifestDigest: manifest.manifestDigest, archiveSha256: manifest.archive?.sha256 ?? null, archiveBytes: manifest.archive?.bytes ?? null };
}

async function deploymentReceipt(context, manifest, evidence) {
  const pointersAfter = await pointerSnapshot(context.deployment.pointerRoot);
  const lifecycle = await lifecycleEvidence(context.policy);
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
    nonTargetProcesses: { before: evidence.protectedBefore, after: evidence.protectedAfter, unchanged: stableJson(evidence.protectedBefore) === stableJson(evidence.protectedAfter) },
    capacity: evidence.capacity,
    ready: evidence.readiness,
    caddySemantic: { before: evidence.caddyBefore, after: evidence.caddyAfter, unchanged: evidence.caddyBefore?.digest === evidence.caddyAfter?.digest },
    automaticCleanup: lifecycle,
    databaseMigration: evidence.databaseMigration ?? null,
    databaseRecovery: context.deployment.databaseMigration ? databaseRecoveryEvidence(context.deployment.databaseMigration) : null,
    restart: context.deployment.databaseMigration ? restartEvidence(context.deployment.restart, false) : undefined,
    finalStatus: evidence.finalStatus,
    completedAt: new Date().toISOString(),
  };
}

async function lifecycleEvidence(policy) {
  const units = policy.lifecycleUnits ?? [];
  if (units.length === 0) return { mode: 'existing-lifecycle', status: 'not-configured', units: [] };
  const states = [];
  for (const unit of units) {
    const active = await command(['systemctl', 'is-active', unit], { timeoutMs: 10_000, acceptExitCodes: [0, 3] });
    states.push({ unit, active: active.stdout.trim() });
  }
  return { mode: 'existing-lifecycle', status: states.every((item) => item.active === 'active') ? 'armed' : 'degraded', units: states };
}

async function protectedProcessSnapshot(context) {
  const own = context.deployment.restart;
  const protectedProcesses = (context.policy.protectedProcesses ?? []).filter((item) => !(own && item.kind === own.kind && item.name === own.name));
  return Object.fromEntries(await Promise.all(protectedProcesses.map(async (item) => [`${item.kind}:${item.name}`, await processId(item)])));
}

async function assertProtectedUnchanged(context, before) {
  const after = {};
  for (const [key, oldPid] of Object.entries(before)) {
    const [kind, ...name] = key.split(':');
    const newPid = await processId({ kind, name: name.join(':') });
    after[key] = newPid;
    assert(newPid === oldPid, 'PROTECTED_PROCESS_CHANGED', { process: key, before: oldPid, after: newPid });
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

async function restart(definition = { kind: 'none', name: 'none' }) {
  const evidence = restartEvidence(definition, true);
  if (evidence.commandCount === 0) return evidence;
  try {
    await command(evidence.commands[0], { timeoutMs: 45_000 });
  } catch (error) {
    let serviceError = null;
    if (evidence.kind === 'systemd') {
      try {
        const journal = await command(['journalctl','-u',evidence.target,'-n','80','--no-pager','-o','cat']);
        serviceError = journal.stdout.split('\n').filter((line) => /Error:|"error":|^error:|_TIMEOUT|_MISMATCH|_MISSING|_INVALID|_REQUIRED/i.test(line)).slice(-3).join('\n');
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
    return { status: 'ready', attempts: 0, durationMs: 0, timeoutMs: settings.timeoutMs, intervalMs: settings.intervalMs, lastError: null, checks: [] };
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

async function processState(definition = { kind: 'none', name: 'none' }) {
  if (!definition || definition.kind === 'none') return { kind: 'none', name: 'none', pid: 'none', activeState: 'unmonitored' };
  if (definition.kind === 'pm2') {
    const pid = await processId(definition);
    return { kind: 'pm2', name: definition.name, pid, activeState: pid === '0' ? 'inactive' : 'active' };
  }
  if (definition.kind === 'systemd') {
    const result = await command(['systemctl', 'show', '--property=ActiveState', '--property=SubState', '--property=Result', '--property=MainPID', definition.name], { acceptExitCodes: [0, 3], timeoutMs: 2_000 });
    const properties = Object.fromEntries(
      result.stdout
        .split('\n')
        .filter((line) => line.includes('='))
        .map((line) => line.split(/=(.*)/s).slice(0, 2))
    );
    return {
      kind: 'systemd',
      name: definition.name,
      pid: properties.MainPID || '0',
      activeState: properties.ActiveState || 'unknown',
      subState: properties.SubState || 'unknown',
      result: properties.Result || 'unknown',
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
  const result = await new Promise((resolvePromise, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      shell: false,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: options.env } : {}),
      ...(options.uid === undefined ? {} : { uid: options.uid }),
      ...(options.gid === undefined ? {} : { gid: options.gid }),
    });
    if (options.input !== undefined) {
      child.stdin.on('error', reject);
      child.stdin.end(options.input);
    }
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => chunks.push(chunk));
    child.on('error', reject);
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 30_000);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal });
    });
  });
  const stdout = Buffer.concat(chunks).toString('utf8');
  const accepted = options.acceptExitCodes ?? [0];
  assert(accepted.includes(result.code), 'REMOTE_COMMAND_FAILED', { argv, code: result.code, signal: result.signal, outputTail: stdout.slice(-3000) });
  return { stdout, durationMs: Date.now() - started };
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
  return join(context.deployment.pointerRoot, 'releases', `${identity.sourceSha}-${identity.treeDigest.slice(7)}-${identity.manifestDigest.slice(7)}`);
}

async function verifyStoredRelease(context, release, identity) {
  const manifest = await readJson(join(release, 'AI_DELIVERY_ARTIFACT.json'));
  assert(manifest?.schema === 'ai.delivery.artifact.v1' && manifest.engineVersion === 2, 'EXISTING_RELEASE_MANIFEST_INVALID', { release });
  assert(manifest.project === identity.project && manifest.target === identity.target, 'EXISTING_RELEASE_SCOPE_MISMATCH', { release });
  assert(manifest.sourceSha === identity.sourceSha && manifest.treeDigest === identity.treeDigest && manifest.manifestDigest === identity.manifestDigest, 'EXISTING_RELEASE_IDENTITY_MISMATCH', { release });
  assert(manifest.archive?.sha256 === `sha256:${identity.archiveSha256}`, 'EXISTING_RELEASE_ARCHIVE_MISMATCH', { release });
  const claimedDigest = manifest.manifestDigest;
  const unsigned = { ...manifest };
  delete unsigned.manifestDigest;
  assert(claimedDigest === digest(unsigned), 'EXISTING_RELEASE_MANIFEST_DIGEST_MISMATCH', { release });
  assertManifestEntries(manifest);
  const evidence = await treeEvidence(release, new Set(['AI_DELIVERY_ARTIFACT.json']));
  assertTreeMatchesManifest(evidence, manifest);
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

function validatePolicy(policy, project) {
  assert(policy?.schema === 'ai.delivery.remote-policy.v1' && policy.project === project, 'POLICY_INVALID');
  assert(Array.isArray(policy.allowedRoots) && policy.allowedRoots.length > 0, 'POLICY_ALLOWED_ROOTS_REQUIRED');
  for (const root of policy.allowedRoots) assert(typeof root === 'string' && root.startsWith('/') && root !== '/', 'POLICY_ALLOWED_ROOT_INVALID', { root });
  assert(typeof policy.incomingRoot === 'string' && policy.incomingRoot.startsWith('/'), 'POLICY_INCOMING_ROOT_INVALID');
  validateReadiness(policy.readiness, 'policy');
  assert(policy.nodes && typeof policy.nodes === 'object', 'POLICY_NODES_REQUIRED');
  const pointerRoots = new Set();
  for (const [node, nodePolicy] of Object.entries(policy.nodes)) {
    assert(nodePolicy?.deployments && typeof nodePolicy.deployments === 'object', 'POLICY_DEPLOYMENTS_REQUIRED', { node });
    for (const [target, deployment] of Object.entries(nodePolicy.deployments)) {
      assert(typeof deployment.pointerRoot === 'string', 'POLICY_POINTER_ROOT_REQUIRED', { node, target });
      assertAllowedRoot(policy, deployment.pointerRoot);
      assert(!pointerRoots.has(deployment.pointerRoot), 'POLICY_POINTER_ROOT_DUPLICATE', { node, target, pointerRoot: deployment.pointerRoot });
      pointerRoots.add(deployment.pointerRoot);
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

function assertExpectedPreparedControlPlane(controlPlane, options) {
  const expectedAgentSha256 = required(options.expectedRemoteAgentSha256, 'EXPECTED_REMOTE_AGENT_SHA256_REQUIRED');
  const expectedPolicySha256 = required(options.expectedRemotePolicySha256, 'EXPECTED_REMOTE_POLICY_SHA256_REQUIRED');
  assert(/^sha256:[a-f0-9]{64}$/.test(expectedAgentSha256), 'EXPECTED_REMOTE_AGENT_SHA256_INVALID');
  assert(/^sha256:[a-f0-9]{64}$/.test(expectedPolicySha256), 'EXPECTED_REMOTE_POLICY_SHA256_INVALID');
  assert(controlPlane.remoteAgentSha256 === expectedAgentSha256, 'REMOTE_AGENT_SHA256_MISMATCH', {
    expected: expectedAgentSha256,
    actual: controlPlane.remoteAgentSha256,
  });
  assert(controlPlane.remotePolicySha256 === expectedPolicySha256, 'REMOTE_POLICY_SHA256_MISMATCH', {
    expected: expectedPolicySha256,
    actual: controlPlane.remotePolicySha256,
  });
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
