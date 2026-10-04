import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, cp, lstat, lutimes, mkdir, readFile, readdir, readlink, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

import { invariant } from './errors.mjs';
import { digest, prettyStableJson } from './stable.mjs';
import { runCommand } from './runner.mjs';

const MAX_ARTIFACT_BYTES = 150_000_000;
const FORBIDDEN_DIRECTORIES = new Set([
  '.git', '.npm', '.nyc_output', '.turbo', '_cacache',
  'coverage', 'logs', 'node_modules', 'playwright-report',
  'releases', 'test-results', 'tmp', 'temp',
]);

export async function materializeTarget(adapter, targetId, runDirectory, changes = []) {
  const target = adapter.targets[targetId];
  const buildRoot = resolve(runDirectory, 'build');
  const destination = resolve(buildRoot, targetId);
  invariant(pathIsWithin(buildRoot, destination), 'ARTIFACT_DESTINATION_UNSAFE', `Unsafe destination for ${targetId}`);
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  for (const input of target.artifactInputs) {
    const source = artifactInputSource(adapter, targetId, input.source);
    if (input.changedOnly) {
      const prefix = `${input.source.replace(/\/$/, '')}/`;
      const selected = changes.filter((change) => change.path === input.source || change.path.startsWith(prefix));
      for (const change of selected.filter((item) => !item.status.startsWith('D'))) {
        const { path } = change;
        const relativePath = path === input.source ? basename(path) : path.slice(prefix.length);
        const selectedSource = artifactInputSource(adapter, targetId, path);
        const output = resolve(destination, input.destination ?? '', relativePath);
        invariant(pathIsWithin(destination, output), 'ARTIFACT_DESTINATION_UNSAFE', `Unsafe destination for ${targetId}`);
        await mkdir(dirname(output), { recursive: true });
        await cp(selectedSource, output, { recursive: true, dereference: false, force: false, errorOnExist: true });
      }
    } else {
      const output = resolve(destination, input.destination ?? basename(input.source));
      invariant(pathIsWithin(destination, output, true), 'ARTIFACT_DESTINATION_UNSAFE', `Unsafe destination for ${targetId}`);
      await mkdir(dirname(output), { recursive: true });
      await cp(source, output, { recursive: true, dereference: false, force: false, errorOnExist: true });
    }
  }
  await materializeInstanceRuntime(adapter, targetId, destination);
  const deletions = changes
    .filter((change) => change.status.startsWith('D') || change.status.startsWith('R'))
    .flatMap((change) => target.artifactInputs
      .filter((input) => input.changedOnly)
      .map((input) => deletionForInput(input, change.sourcePath ?? change.path))
      .filter(Boolean));
  return { target: targetId, directory: destination, deletions: [...new Set(deletions)].sort(), ...(await treeEvidence(destination, target.criticalFiles ?? [])) };
}

export async function packageTarget(adapter, plan, buildEvidence, runDirectory, artifactRoot) {
  const targetId = buildEvidence.target;
  const target = adapter.targets[targetId];
  await normalizeArtifactModes(buildEvidence.directory);
  const content = await treeEvidence(buildEvidence.directory, target.criticalFiles ?? []);
  assertArtifactSize(targetId, content.totalBytes, content.entries);
  const artifactId = `${adapter.project}-${targetId}-${content.treeDigest.slice(7, 19)}`;
  const directory = join(artifactRoot, targetId, content.treeDigest.slice(7), plan.to.sha, plan.planDigest.slice(7), 'v2');
  const archive = join(directory, `${targetId}.tar.gz`);
  const manifestPath = join(directory, `${targetId}.artifact.json`);
  const existing = await existingArtifact(manifestPath, archive, { adapter, plan, targetId, content });
  if (existing) return { ...existing, packageCache: 'hit_local' };

  const temporary = `${directory}.candidate-${process.pid}-${Date.now()}`;
  await mkdir(temporary, { recursive: true });
  const temporaryArchive = join(temporary, `${targetId}.tar.gz`);
  const temporaryTar = join(temporary, `${targetId}.tar`);
  await normalizeArtifactTimes(buildEvidence.directory, content.entries);
  const command = await runCommand({ name: `package:${targetId}`, argv: deterministicTarArgv(temporaryTar, buildEvidence.directory), timeoutMs: 10 * 60_000 }, {
    projectRoot: adapter.projectRoot,
    environment: {},
    changedFiles: [],
    logPath: join(runDirectory, 'logs', `package-${targetId}.log`),
  });
  await pipeline(createReadStream(temporaryTar), createGzip({ level: 9, mtime: 0 }), createWriteStream(temporaryArchive, { flags: 'wx' }));
  await rm(temporaryTar);
  const archiveSha256 = await hashFile(temporaryArchive);
  const archiveBytes = (await lstat(temporaryArchive)).size;
  assertArtifactSize(targetId, archiveBytes, content.entries, 'archive');
  const dependencyLayer = await dependencyLayerEvidence(adapter, target.dependencyLayer);
  const manifest = {
    schema: 'ai.delivery.artifact.v1',
    engineVersion: 2,
    artifactId,
    project: adapter.project,
    target: targetId,
    targetKind: target.kind,
    sourceSha: plan.to.sha,
    contractTransition: {
      mode: 'contract-pool-pending',
      legacyRuntimeAuthority: 'disabled',
      localContractAuthority: 'forbidden',
    },
    planDigest: plan.planDigest,
    treeDigest: content.treeDigest,
    fileCount: content.fileCount,
    entryCount: content.entryCount,
    totalBytes: content.totalBytes,
    entries: content.entries,
    criticalFiles: content.criticalFiles,
    deletions: buildEvidence.deletions ?? [],
    dependencyLayer,
    archive: { sha256: `sha256:${archiveSha256}`, bytes: archiveBytes },
  };
  manifest.manifestDigest = digest(manifest);
  const temporaryManifest = join(temporary, `${targetId}.artifact.json`);
  await writeFile(temporaryManifest, prettyStableJson(manifest), { flag: 'wx' });
  await mkdir(dirname(directory), { recursive: true });
  try {
    await rename(temporary, directory);
  } catch (error) {
    if (!['EEXIST', 'ENOTEMPTY'].includes(error?.code)) throw error;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  const committed = await existingArtifact(manifestPath, archive, { adapter, plan, targetId, content });
  invariant(Boolean(committed), 'ARTIFACT_IMMUTABLE_COMMIT_FAILED', `Artifact was not committed: ${targetId}`);
  return { ...committed, packageCache: 'miss' };
}

async function normalizeArtifactModes(root) {
  await chmod(root, 0o755);
  await normalizeDirectoryModes(root);
}

async function normalizeDirectoryModes(directory) {
  for (const name of (await readdir(directory)).sort()) {
    const absolute = join(directory, name);
    const stats = await lstat(absolute);
    if (stats.isSymbolicLink()) continue;
    if (stats.isDirectory()) {
      await chmod(absolute, 0o755);
      await normalizeDirectoryModes(absolute);
      continue;
    }
    if (stats.isFile()) await chmod(absolute, stats.mode & 0o111 ? 0o755 : 0o644);
  }
}

export async function resolvePackageArtifactPaths(packagePath, packageSet) {
  const portableRoot = resolve(dirname(packagePath), '..', '.ai-delivery', 'artifacts');
  const artifacts = [];
  for (const artifact of packageSet.artifacts ?? []) {
    artifacts.push({
      ...artifact,
      archive: {
        ...artifact.archive,
        path: await resolvePackageArtifactPath(artifact.archive?.path, portableRoot),
      },
      manifestPath: await resolvePackageArtifactPath(artifact.manifestPath, portableRoot),
    });
  }
  return { ...packageSet, artifacts };
}

async function resolvePackageArtifactPath(configuredPath, portableRoot) {
  invariant(typeof configuredPath === 'string' && configuredPath.length > 0,
    'PACKAGE_ARTIFACT_PATH_INVALID', 'Packaged artifact path is missing');
  try {
    const stats = await lstat(configuredPath);
    invariant(stats.isFile(), 'PACKAGE_ARTIFACT_PATH_INVALID', `Packaged artifact path is not a file: ${configuredPath}`);
    return configuredPath;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const normalized = configuredPath.replaceAll('\\', '/');
  const marker = '.ai-delivery/artifacts/';
  const markerIndex = normalized.lastIndexOf(marker);
  invariant(markerIndex >= 0, 'PACKAGE_ARTIFACT_PATH_MISSING', `Packaged artifact is unavailable: ${configuredPath}`);
  const candidate = resolve(portableRoot, normalized.slice(markerIndex + marker.length));
  invariant(pathIsWithin(portableRoot, candidate), 'PACKAGE_ARTIFACT_PATH_UNSAFE', `Packaged artifact path escapes its bundle: ${configuredPath}`);
  const stats = await lstat(candidate);
  invariant(stats.isFile(), 'PACKAGE_ARTIFACT_PATH_INVALID', `Packaged artifact path is not a file: ${candidate}`);
  return candidate;
}

function deterministicTarArgv(archive, source) {
  const ownership = process.platform === 'darwin'
    ? ['--uid', '0', '--gid', '0', '--uname', 'root', '--gname', 'root']
    : ['--owner=0', '--group=0', '--numeric-owner', '--sort=name', '--mtime=@0'];
  return ['tar', ...ownership, '-cf', archive, '-C', source, '.'];
}

async function normalizeArtifactTimes(root, entries) {
  const epoch = new Date(0);
  for (const entry of entries.filter((item) => item.type !== 'directory')) {
    const absolute = join(root, entry.path);
    if (entry.type === 'symlink') await lutimes(absolute, epoch, epoch);
    else await utimes(absolute, epoch, epoch);
  }
  for (const entry of entries.filter((item) => item.type === 'directory').reverse()) {
    await utimes(join(root, entry.path), epoch, epoch);
  }
  await utimes(root, epoch, epoch);
}

async function existingArtifact(manifestPath, archivePath, expected) {
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    invariant(manifest.project === expected.adapter.project, 'ARTIFACT_EXISTING_PROJECT_MISMATCH', 'Existing artifact belongs to another project');
    invariant(manifest.target === expected.targetId, 'ARTIFACT_EXISTING_TARGET_MISMATCH', 'Existing artifact belongs to another target');
    invariant(manifest.sourceSha === expected.plan.to.sha && manifest.planDigest === expected.plan.planDigest, 'ARTIFACT_EXISTING_PROVENANCE_MISMATCH', 'Existing artifact provenance differs');
    invariant(manifest.treeDigest === expected.content.treeDigest, 'ARTIFACT_EXISTING_TREE_MISMATCH', 'Existing artifact tree differs');
    invariant(Array.isArray(manifest.entries) && digest(manifest.entries) === manifest.treeDigest, 'ARTIFACT_EXISTING_ENTRIES_INVALID', 'Existing artifact file list differs');
    const stats = await lstat(archivePath);
    invariant(stats.isFile() && stats.size === manifest.archive.bytes, 'ARTIFACT_EXISTING_ARCHIVE_INVALID', 'Existing artifact archive size differs');
    invariant(`sha256:${await hashFile(archivePath)}` === manifest.archive.sha256, 'ARTIFACT_EXISTING_ARCHIVE_INVALID', 'Existing artifact archive hash differs');
    const unsigned = { ...manifest };
    delete unsigned.manifestDigest;
    invariant(digest(unsigned) === manifest.manifestDigest, 'ARTIFACT_EXISTING_MANIFEST_INVALID', 'Existing artifact manifest hash differs');
    return { ...manifest, archive: { ...manifest.archive, path: archivePath }, manifestPath };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function dependencyLayerEvidence(adapter, layer) {
  if (!layer) return null;
  const keyFiles = [];
  for (const path of layer.keyFiles ?? []) {
    const absolute = safeProjectPath(adapter.projectRoot, path);
    const stats = await lstat(absolute);
    invariant(stats.isFile(), 'DEPENDENCY_LAYER_KEY_INVALID', `Dependency layer key is not a file: ${path}`);
    keyFiles.push({ path, bytes: stats.size, sha256: `sha256:${await hashFile(absolute)}` });
  }
  const identity = { runtime: layer.runtime, keyFiles };
  return {
    strategy: layer.strategy,
    runtime: layer.runtime,
    digest: digest(identity),
    keyFiles,
    productionRoot: layer.productionRoot,
  };
}

export async function treeEvidence(root, criticalFiles = []) {
  const entries = [];
  let totalBytes = 0;
  await walk(root, '', entries, (size) => { totalBytes += size; });
  const treeDigest = digest(entries);
  const critical = [];
  for (const path of criticalFiles) {
    const absolute = resolve(root, path);
    invariant(pathIsWithin(root, absolute), 'CRITICAL_FILE_UNSAFE', `Unsafe critical file ${path}`);
    const stats = await lstat(absolute);
    invariant(stats.isFile(), 'CRITICAL_FILE_MISSING', `Critical file missing: ${path}`);
    critical.push({ path, sha256: `sha256:${await hashFile(absolute)}`, bytes: stats.size });
  }
  return {
    treeDigest,
    fileCount: entries.filter((entry) => entry.type === 'file').length,
    entryCount: entries.length,
    totalBytes,
    entries,
    criticalFiles: critical,
  };
}

async function walk(root, path, entries, onBytes) {
  const directory = join(root, path);
  const names = await readdir(directory);
  names.sort();
  for (const name of names) {
    const childPath = path ? `${path}/${name}` : name;
    assertArtifactPath(childPath);
    const absolute = join(root, childPath);
    const stats = await lstat(absolute);
    if (stats.isDirectory()) {
      entries.push({ path: `${childPath}/`, type: 'directory', mode: stats.mode & 0o777 });
      await walk(root, childPath, entries, onBytes);
    } else if (stats.isSymbolicLink()) {
      const target = await readlink(absolute);
      const resolvedTarget = resolve(dirname(absolute), target);
      invariant(pathIsWithin(root, resolvedTarget, true), 'ARTIFACT_SYMLINK_UNSAFE', `Symlink escapes artifact root: ${childPath}`);
      entries.push({ path: childPath, type: 'symlink', target });
    } else if (stats.isFile()) {
      onBytes(stats.size);
      entries.push({ path: childPath, type: 'file', bytes: stats.size, mode: stats.mode & 0o777, sha256: await hashFile(absolute) });
    }
  }
}

function assertArtifactPath(path) {
  const normalized = path.replace(/\/+$/, '');
  const segments = normalized.split('/').filter(Boolean);
  const forbiddenDirectory = segments.find((segment) => FORBIDDEN_DIRECTORIES.has(segment));
  invariant(!forbiddenDirectory, 'ARTIFACT_FORBIDDEN_PATH', `Forbidden artifact path: ${path}`, { path, forbiddenDirectory });
  invariant(!segments.some((segment, index) => segment === '.next' && segments[index + 1] === 'cache'), 'ARTIFACT_FORBIDDEN_PATH', `Forbidden artifact path: ${path}`, { path, forbiddenDirectory: '.next/cache' });
  const leaf = segments.at(-1) ?? '';
  invariant(!/\.(?:log|tmp|swp)$/i.test(leaf), 'ARTIFACT_FORBIDDEN_PATH', `Forbidden artifact file: ${path}`, { path });
}

function assertArtifactSize(target, bytes, entries, kind = 'uncompressed') {
  invariant(bytes <= MAX_ARTIFACT_BYTES, 'ARTIFACT_SIZE_LIMIT_EXCEEDED', `Artifact exceeds 150 MiB: ${target}`, {
    target,
    kind,
    bytes,
    limitBytes: MAX_ARTIFACT_BYTES,
    largestFiles: entries
      .filter((entry) => entry.type === 'file')
      .sort((left, right) => right.bytes - left.bytes)
      .slice(0, 20)
      .map(({ path, bytes: fileBytes }) => ({ path, bytes: fileBytes })),
  });
}

async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function safeProjectPath(projectRoot, path) {
  invariant(!isAbsolute(path), 'ARTIFACT_SOURCE_ABSOLUTE', `Artifact source must be project-relative: ${path}`);
  const absolute = resolve(projectRoot, path);
  invariant(pathIsWithin(projectRoot, absolute), 'ARTIFACT_SOURCE_UNSAFE', `Unsafe artifact source: ${path}`);
  return absolute;
}

function artifactInputSource(adapter, targetId, path) {
  if (adapter.instanceRoot) {
    const normalized = path.replaceAll('\\', '/');
    const clientDirectory = {
      '01_core_hexin/apps/auth-web/dist': 'auth-web',
      '01_core_hexin/apps/console/dist': 'console',
      '01_core_hexin/apps/storefront-web/dist': 'storefront-web',
    }[normalized];
    if (clientDirectory) return resolve(adapter.instanceRoot, 'dist', clientDirectory);
    const serviceFile = /^01_core_hexin\/services\/commerce\/dist\/([^/]+)$/.exec(normalized)?.[1];
    if (serviceFile && targetId !== 'database-migration') return resolve(adapter.instanceRoot, 'dist', 'services', targetId, serviceFile);
  }
  return safeProjectPath(adapter.projectRoot, path);
}

async function materializeInstanceRuntime(adapter, targetId, destination) {
  if (!adapter.instanceRoot || !['console', 'auth-web', 'storefront', 'identity-api', 'web-api', 'database-migration'].includes(targetId)) return;
  const configDirectory = resolve(adapter.instanceRoot, 'dist/config/targets', targetId);
  const declaration = JSON.parse(await readFile(resolve(adapter.instanceRoot, 'sfl-node-registry.declaration.json'), 'utf8'));
  const binding = declaration.node_bindings.find((entry) =>
    Object.values(adapter.nodes).some((node) => node.nodeId === entry.node_id && node.deployments[targetId]));
  if (!binding) return;
  const manifest = await readFile(resolve(configDirectory, 'node-manifests', binding.runtime_manifest_file)).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (manifest === null) return;
  const runtimeDirectory = join(destination, 'node-runtime');
  await mkdir(runtimeDirectory, { recursive: true });
  await writeFile(join(runtimeDirectory, 'manifest.json'), manifest);
  const files = ['identity-node-projection.json', ...(targetId === 'console' ? ['console-runtime.json']
    : ['auth-web', 'identity-api', 'storefront'].includes(targetId) ? ['identity-runtime.json'] : [])];
  for (const name of files) {
    const contents = await readFile(join(configDirectory, name)).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (contents !== null) await writeFile(join(runtimeDirectory, name), contents);
  }
}

function pathIsWithin(root, path, allowRoot = false) {
  const fromRoot = relative(resolve(root), resolve(path));
  return (allowRoot || fromRoot !== '') && fromRoot !== '..'
    && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

function deletionForInput(input, path) {
  const prefix = `${input.source.replace(/\/$/, '')}/`;
  if (path === input.source) return input.destination ?? basename(path);
  if (!path.startsWith(prefix)) return null;
  return join(input.destination ?? '', path.slice(prefix.length)).replaceAll('\\', '/');
}
