import { readFile } from 'node:fs/promises';

import { resolvePackageArtifactPaths } from './artifact.mjs';
import { DeliveryError, invariant } from './errors.mjs';
import { digest, prettyStableJson, sha256 } from './stable.mjs';

export const SIMPLE_RELEASE_SCHEMA = 'ai.delivery.simple-release.v1';
const UNAVAILABLE_ARTIFACT_CODES = new Set([
  'SIMPLE_ARTIFACT_NOT_FOUND', 'SIMPLE_ARTIFACT_INVALID', 'SIMPLE_ARTIFACT_SCHEMA_INVALID',
  'SIMPLE_ARTIFACT_SCOPE_MISMATCH', 'SIMPLE_ARTIFACT_DESCRIPTOR_INVALID',
]);

export function simpleReleaseObject(project, target, sourceSha, instanceCacheKey) {
  return `${project}/${target}/${sourceSha}/runner-1.6/${instanceCacheKey ? `instances/${instanceCacheKey}/` : ''}release.json`;
}

export function installedReleaseDescriptor(adapter, manifest, manifestSha256 = sha256(prettyStableJson(manifest))) {
  const { project, target, sourceSha, treeDigest, manifestDigest, archive } = manifest;
  const descriptor = simpleReleaseObject(project, target, sourceSha, adapter.instanceCacheKey);
  const root = descriptor.slice(0, -'release.json'.length);
  const value = {
    schema: SIMPLE_RELEASE_SCHEMA,
    project,
    target,
    sourceSha,
    artifact: { object: `${root}artifacts/${archive.sha256.slice(7)}.tar.gz`, sha256: archive.sha256, bytes: archive.bytes, treeDigest },
    runtimeManifest: { object: `${root}manifests/${manifestSha256}.json`, sha256: `sha256:${manifestSha256}`, manifestDigest },
  };
  return { ...value, releaseDigest: digest(value) };
}

export async function publishSimpleArtifacts(adapter, packagePath, client, targets) {
  const packageSet = await resolvePackageArtifactPaths(packagePath, JSON.parse(await readFile(packagePath, 'utf8')));
  invariant(packageSet.project === adapter.project, 'SIMPLE_PACKAGE_PROJECT_MISMATCH', 'Package belongs to another project');
  const published = [];
  for (const artifact of packageSet.artifacts) {
    const target = artifact.target;
    if (targets && !targets.includes(target)) continue;
    const sourceSha = packageSet.sourceSha;
    const archive = await readFile(artifact.archive.path);
    const manifestBody = await readFile(artifact.manifestPath);
    invariant(`sha256:${sha256(archive)}` === artifact.archive.sha256, 'SIMPLE_ARCHIVE_DIGEST_MISMATCH', 'Built archive digest differs');
    const root = `${adapter.project}/${target}/${sourceSha}/runner-1.6${adapter.instanceCacheKey ? `/instances/${adapter.instanceCacheKey}` : ''}`;
    const archiveObject = `${root}/artifacts/${artifact.archive.sha256.slice(7)}.tar.gz`;
    const manifestObject = `${root}/manifests/${sha256(manifestBody)}.json`;
    const objects = [await client.putContent(archiveObject, archive, 'application/gzip'), await client.putContent(manifestObject, manifestBody, 'application/json')];
    const value = {
      schema: SIMPLE_RELEASE_SCHEMA,
      project: adapter.project,
      target,
      sourceSha,
      artifact: { object: archiveObject, sha256: artifact.archive.sha256, bytes: archive.byteLength, treeDigest: artifact.treeDigest },
      runtimeManifest: { object: manifestObject, sha256: `sha256:${sha256(manifestBody)}`, manifestDigest: artifact.manifestDigest },
      updatedAt: new Date().toISOString(),
    };
    const release = { ...value, releaseDigest: digest(value) };
    await client.putObject(simpleReleaseObject(adapter.project, target, sourceSha, adapter.instanceCacheKey), prettyStableJson(release), 'application/json');
    published.push({ target, sourceSha, cacheStatus: objects.every((item) => item.status === 'reused') ? 'reused' : 'built', release, runtimeManifest: JSON.parse(manifestBody.toString('utf8')) });
  }
  return published;
}

export async function resolveSimpleArtifact(adapter, { target, sourceSha }, client, pinnedRelease, manifestBody) {
  invariant(Boolean(adapter.targets[target]), 'SIMPLE_TARGET_UNKNOWN', `Unknown target ${target}`);
  invariant(/^[a-f0-9]{40}$/.test(sourceSha ?? ''), 'SIMPLE_SOURCE_SHA_INVALID', 'Source SHA must be a full lowercase Git SHA');
  const object = simpleReleaseObject(adapter.project, target, sourceSha, adapter.instanceCacheKey);
  let release = pinnedRelease;
  if (!release) {
    const body = await client.getObject(object, 'SIMPLE_ARTIFACT_NOT_FOUND');
    try {
      release = JSON.parse(body.toString('utf8'));
    } catch {
      throw new DeliveryError('SIMPLE_ARTIFACT_INVALID', 'Artifact cache descriptor is not valid JSON', { object });
    }
  }
  assertReleaseDescriptor(adapter, { target, sourceSha }, release, object);
  const [archive, manifest] = await Promise.all([
    client.headObject(release.artifact.object),
    manifestBody ?? client.getObject(release.runtimeManifest.object, 'SIMPLE_ARTIFACT_NOT_FOUND'),
  ]);
  invariant(archive.exists && archive.bytes === release.artifact.bytes, 'SIMPLE_ARTIFACT_NOT_FOUND', 'Artifact archive is missing or incomplete', { object: release.artifact.object });
  if (archive.sha256) invariant(`sha256:${archive.sha256}` === release.artifact.sha256, 'SIMPLE_ARTIFACT_INVALID', 'Artifact archive metadata differs', { object: release.artifact.object });
  invariant(`sha256:${sha256(manifest)}` === release.runtimeManifest.sha256, 'SIMPLE_ARTIFACT_INVALID', 'Artifact manifest content differs', { object: release.runtimeManifest.object });
  const runtimeManifest = JSON.parse(manifest.toString('utf8'));
  assertReleaseManifest(adapter, { target, sourceSha }, release, runtimeManifest);
  return { object, release, runtimeManifest };
}

export async function recoverArchivedArtifact(adapter, identity, client, original, { classifyOtherVariant = false } = {}) {
  const { target, sourceSha } = identity;
  const ordinaryDescriptor = simpleReleaseObject(adapter.project, target, sourceSha);
  const root = ordinaryDescriptor.slice(0, -'release.json'.length);
  const namespaces = [...new Set([adapter.instanceCacheKey, adapter.legacyInstanceCacheKey ?? adapter.instanceCacheKey])].map((instanceCacheKey) => {
    const scoped = { ...adapter, instanceCacheKey };
    const descriptorKey = simpleReleaseObject(adapter.project, target, sourceSha, instanceCacheKey);
    const prefix = descriptorKey.slice(0, -'release.json'.length) + 'manifests/';
    return { scoped, descriptorKey, prefix };
  });
  const unavailable = [];
  let identified = false;
  let otherStorefrontVariant = false;
  const inspect = async (scoped, object) => {
    const body = await getStoredObject(client, object);
    if (!body || !object.endsWith(`/${sha256(body)}.json`)) return null;
    const manifest = parseStoredJson(body);
    if (!matchesOriginalManifest(scoped, identity, original, manifest)) return null;
    const storefrontMatches = legacyStorefrontMatches(scoped, target, original, manifest);
    if (storefrontMatches === false) otherStorefrontVariant = true;
    if (storefrontMatches !== true) return null;
    identified = true;
    return resolveArchivedManifest(scoped, identity, client, manifest, body);
  };
  for (const { scoped, descriptorKey, prefix } of namespaces) {
    try {
      const descriptor = parseStoredJson(await getStoredObject(client, descriptorKey));
      if (descriptor?.artifact?.sha256 !== original.archiveSha256 || descriptor.artifact.treeDigest !== original.treeDigest ||
          descriptor.runtimeManifest?.manifestDigest !== original.manifestDigest) continue;
      const object = descriptor.runtimeManifest.object;
      if (!isManifestObject(prefix, object)) continue;
      const resolved = await inspect(scoped, object);
      if (resolved) return resolved;
    } catch (error) {
      unavailable.push(error);
    }
  }
  for (const { scoped, prefix } of namespaces) {
    try {
      for await (const object of client.listObjects(prefix)) {
        if (!isManifestObject(prefix, object)) continue;
        try {
          const resolved = await inspect(scoped, object);
          if (resolved) return resolved;
        } catch (error) {
          unavailable.push(error);
        }
      }
    } catch (error) {
      unavailable.push(error);
    }
  }
  if (!identified && classifyOtherVariant) {
    if (otherStorefrontVariant) return null;
    if (!Object.hasOwn(original, 'instanceCacheKey')) {
      try {
        if (await archivedOtherVariant(adapter, identity, client, original, root, ordinaryDescriptor)) return null;
      } catch (error) {
        unavailable.push(error);
      }
    }
  }
  const failure = unavailable[0];
  throw new DeliveryError(failure?.code ?? 'ARTIFACT_PIN_UNRESOLVED', failure?.message ?? 'The original artifact could not be recovered', {
    ...failure?.details,
    ...identity, manifestDigest: original.manifestDigest, pointerAction: 'not-performed',
    reason: identified ? 'The original manifest matched but its archive could not be recovered.'
      : 'The original archive, tree and manifest digests could not be matched to this artifact variant.',
  });
}

async function archivedOtherVariant(adapter, identity, client, original, root, ordinaryDescriptor) {
  const ordinaryPrefix = `${root}manifests/`;
  const instancesPrefix = `${root}instances/`;
  const identifiesOtherVariant = async (object, instanceCacheKey) => {
    const body = await getStoredObject(client, object);
    if (!body || !object.endsWith(`/${sha256(body)}.json`)) return false;
    const manifest = parseStoredJson(body);
    if (!matchesOriginalManifestIdentity(adapter, identity, original, manifest)) return false;
    return Object.hasOwn(manifest, 'instanceCacheKey')
      ? (manifest.instanceCacheKey ?? undefined) === instanceCacheKey
      : (!adapter.instanceCacheKey || !instanceCacheKey) &&
        Boolean(instanceCacheKey) === Boolean(manifest.entries?.some((entry) => entry.path === 'node-runtime/manifest.json'));
  };
  let ordinaryError;
  if (adapter.instanceCacheKey) {
    try {
      const descriptor = parseStoredJson(await getStoredObject(client, ordinaryDescriptor));
      const object = descriptor?.runtimeManifest?.object;
      if (isManifestObject(ordinaryPrefix, object) && await identifiesOtherVariant(object, undefined)) return true;
    } catch (error) {
      ordinaryError = error;
    }
    try {
      for await (const key of client.listObjects(ordinaryPrefix)) {
        if (!isManifestObject(ordinaryPrefix, key)) continue;
        try {
          if (await identifiesOtherVariant(key, undefined)) return true;
        } catch (error) {
          ordinaryError ??= error;
        }
      }
    } catch (error) {
      ordinaryError ??= error;
    }
  }
  let instanceError;
  for await (const key of client.listObjects(instancesPrefix)) {
    if (!key.startsWith(instancesPrefix)) continue;
    const match = /^([a-f0-9]{64})\/manifests\/[a-f0-9]{64}\.json$/.exec(key.slice(instancesPrefix.length));
    if (!match || [adapter.instanceCacheKey, adapter.legacyInstanceCacheKey].includes(match[1])) continue;
    try {
      if (await identifiesOtherVariant(key, match[1])) return true;
    } catch (error) {
      instanceError ??= error;
    }
  }
  if (instanceError) throw instanceError;
  if (ordinaryError) throw ordinaryError;
  return false;
}

function isManifestObject(prefix, object) {
  return typeof object === 'string' && object.startsWith(prefix) && /^[a-f0-9]{64}\.json$/.test(object.slice(prefix.length));
}

async function resolveArchivedManifest(adapter, identity, client, manifest, body) {
  try {
    return await resolveSimpleArtifact(adapter, identity, client, installedReleaseDescriptor(adapter, manifest, sha256(body)), body);
  } catch (error) {
    if (error instanceof DeliveryError && UNAVAILABLE_ARTIFACT_CODES.has(error.code)) return null;
    throw error;
  }
}

function matchesOriginalManifestIdentity(adapter, { target, sourceSha }, original, manifest) {
  if (manifest?.schema !== 'ai.delivery.artifact.v1' || manifest.engineVersion !== 2 || manifest.project !== adapter.project ||
      manifest.target !== target || manifest.sourceSha !== sourceSha || manifest.treeDigest !== original.treeDigest ||
      manifest.manifestDigest !== original.manifestDigest || manifest.archive?.sha256 !== original.archiveSha256) return false;
  const { manifestDigest, ...unsigned } = manifest;
  return digest(unsigned) === manifestDigest;
}

function matchesOriginalManifest(adapter, identity, original, manifest) {
  if (!matchesOriginalManifestIdentity(adapter, identity, original, manifest)) return false;
  if (Object.hasOwn(manifest, 'instanceCacheKey')) {
    if ((manifest.instanceCacheKey ?? undefined) !== adapter.instanceCacheKey) return false;
  } else if (Boolean(adapter.instanceCacheKey) !== Boolean(manifest.entries?.some((entry) => entry.path === 'node-runtime/manifest.json'))) {
    return false;
  }
  return true;
}

function legacyStorefrontMatches(adapter, target, original, manifest) {
  if (target !== 'storefront' || !adapter.instanceCacheKey || adapter.instanceCacheKey !== adapter.legacyInstanceCacheKey) return true;
  const packaged = manifest.entries?.find((entry) => entry.path === 'node-runtime/storefront-public.json');
  if (packaged) {
    if (!/^sha256:[a-f0-9]{64}$/.test(packaged.sha256 ?? '')) return null;
    return packaged.sha256 === `sha256:${sha256(prettyStableJson(adapter.storefrontEnvironment ?? {}))}`;
  }
  if (!original.storefrontEnvironmentDigest || !adapter.storefrontEnvironmentDigest) return null;
  return original.storefrontEnvironmentDigest === adapter.storefrontEnvironmentDigest;
}

async function getStoredObject(client, key) {
  try {
    return await client.getObject(key, 'SIMPLE_ARTIFACT_NOT_FOUND');
  } catch (error) {
    if (error.code === 'SIMPLE_ARTIFACT_NOT_FOUND') return null;
    throw error;
  }
}

function parseStoredJson(body) {
  if (!body) return null;
  try { return JSON.parse(body.toString('utf8')); } catch { return null; }
}

export function resolveInstalledArtifact(adapter, identity, release, runtimeManifest) {
  const object = simpleReleaseObject(adapter.project, identity.target, identity.sourceSha, adapter.instanceCacheKey);
  assertReleaseDescriptor(adapter, identity, release, object);
  assertReleaseManifest(adapter, identity, release, runtimeManifest);
  return { object, release, runtimeManifest, localOnly: true };
}

function assertReleaseManifest(adapter, identity, release, runtimeManifest) {
  invariant(runtimeManifest?.project === adapter.project && runtimeManifest.target === identity.target &&
    runtimeManifest.sourceSha === identity.sourceSha && runtimeManifest.treeDigest === release.artifact.treeDigest &&
    runtimeManifest.manifestDigest === release.runtimeManifest.manifestDigest &&
    runtimeManifest.archive?.sha256 === release.artifact.sha256 && runtimeManifest.archive?.bytes === release.artifact.bytes,
  'SIMPLE_ARTIFACT_INVALID', 'The artifact manifest does not match the original selection', { object: release.runtimeManifest.object });
}

function assertReleaseDescriptor(adapter, { target, sourceSha }, release, object) {
  const claimedDigest = release?.releaseDigest;
  const unsigned = { ...release };
  delete unsigned.releaseDigest;
  invariant(release?.schema === SIMPLE_RELEASE_SCHEMA, 'SIMPLE_ARTIFACT_SCHEMA_INVALID', 'Artifact cache descriptor schema is unsupported', { object });
  invariant(release.project === adapter.project && release.target === target && release.sourceSha === sourceSha, 'SIMPLE_ARTIFACT_SCOPE_MISMATCH', 'Artifact cache descriptor identifies another release', { object });
  invariant(claimedDigest === digest(unsigned), 'SIMPLE_ARTIFACT_DESCRIPTOR_INVALID', 'Artifact cache descriptor is incomplete', { object });
}

export async function inspectSimpleArtifact(adapter, identity, client) {
  try {
    const resolved = await resolveSimpleArtifact(adapter, identity, client);
    return { exists: true, cacheStatus: 'reused', ...resolved };
  } catch (error) {
    if (error instanceof SyntaxError) return { exists: false, cacheStatus: 'rebuild', reason: 'SIMPLE_ARTIFACT_INVALID' };
    if (error instanceof DeliveryError && UNAVAILABLE_ARTIFACT_CODES.has(error.code))
      return { exists: false, cacheStatus: 'rebuild', reason: error.code };
    throw error;
  }
}
