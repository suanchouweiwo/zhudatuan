import { readFile } from 'node:fs/promises';

import { resolvePackageArtifactPaths } from './artifact.mjs';
import { DeliveryError, invariant } from './errors.mjs';
import { digest, prettyStableJson, sha256 } from './stable.mjs';

export const SIMPLE_RELEASE_SCHEMA = 'ai.delivery.simple-release.v1';

export function simpleReleaseObject(project, target, sourceSha, instanceCacheKey) {
  return `${project}/${target}/${sourceSha}/runner-1.6/${instanceCacheKey ? `instances/${instanceCacheKey}/` : ''}release.json`;
}

export async function publishSimpleArtifacts(adapter, packagePath, client) {
  const packageSet = await resolvePackageArtifactPaths(packagePath, JSON.parse(await readFile(packagePath, 'utf8')));
  invariant(packageSet.project === adapter.project, 'SIMPLE_PACKAGE_PROJECT_MISMATCH', 'Package belongs to another project');
  const published = [];
  for (const artifact of packageSet.artifacts) {
    const target = artifact.target;
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
    published.push({ target, sourceSha, cacheStatus: objects.every((item) => item.status === 'reused') ? 'reused' : 'built', release });
  }
  return published;
}

export async function resolveSimpleArtifact(adapter, { target, sourceSha }, client) {
  invariant(Boolean(adapter.targets[target]), 'SIMPLE_TARGET_UNKNOWN', `Unknown target ${target}`);
  invariant(/^[a-f0-9]{40}$/.test(sourceSha ?? ''), 'SIMPLE_SOURCE_SHA_INVALID', 'Source SHA must be a full lowercase Git SHA');
  const object = simpleReleaseObject(adapter.project, target, sourceSha, adapter.instanceCacheKey);
  const body = await client.getObject(object, 'SIMPLE_ARTIFACT_NOT_FOUND');
  let release;
  try {
    release = JSON.parse(body.toString('utf8'));
  } catch {
    throw new DeliveryError('SIMPLE_ARTIFACT_INVALID', 'Artifact cache descriptor is not valid JSON', { object });
  }
  const claimedDigest = release.releaseDigest;
  const unsigned = { ...release };
  delete unsigned.releaseDigest;
  invariant(release.schema === SIMPLE_RELEASE_SCHEMA, 'SIMPLE_ARTIFACT_SCHEMA_INVALID', 'Artifact cache descriptor schema is unsupported', { object });
  invariant(release.project === adapter.project && release.target === target && release.sourceSha === sourceSha, 'SIMPLE_ARTIFACT_SCOPE_MISMATCH', 'Artifact cache descriptor identifies another release', { object });
  invariant(claimedDigest === digest(unsigned), 'SIMPLE_ARTIFACT_DESCRIPTOR_INVALID', 'Artifact cache descriptor is incomplete', { object });
  const [archive, manifest] = await Promise.all([client.headObject(release.artifact.object), client.getObject(release.runtimeManifest.object, 'SIMPLE_ARTIFACT_NOT_FOUND')]);
  invariant(archive.exists && archive.bytes === release.artifact.bytes, 'SIMPLE_ARTIFACT_NOT_FOUND', 'Artifact archive is missing or incomplete', { object: release.artifact.object });
  if (archive.sha256) invariant(`sha256:${archive.sha256}` === release.artifact.sha256, 'SIMPLE_ARTIFACT_INVALID', 'Artifact archive metadata differs', { object: release.artifact.object });
  invariant(`sha256:${sha256(manifest)}` === release.runtimeManifest.sha256, 'SIMPLE_ARTIFACT_INVALID', 'Artifact manifest content differs', { object: release.runtimeManifest.object });
  const runtimeManifest = JSON.parse(manifest.toString('utf8'));
  invariant(runtimeManifest.project === adapter.project && runtimeManifest.target === target && runtimeManifest.sourceSha === sourceSha, 'SIMPLE_ARTIFACT_INVALID', 'Runtime manifest identifies another release', {
    object: release.runtimeManifest.object,
  });
  return { object, release, runtimeManifest };
}

export async function inspectSimpleArtifact(adapter, identity, client) {
  try {
    const resolved = await resolveSimpleArtifact(adapter, identity, client);
    return { exists: true, cacheStatus: 'reused', ...resolved };
  } catch (error) {
    if (error instanceof SyntaxError) return { exists: false, cacheStatus: 'rebuild', reason: 'SIMPLE_ARTIFACT_INVALID' };
    if (error instanceof DeliveryError && ['SIMPLE_ARTIFACT_NOT_FOUND', 'SIMPLE_ARTIFACT_INVALID', 'SIMPLE_ARTIFACT_SCHEMA_INVALID', 'SIMPLE_ARTIFACT_SCOPE_MISMATCH', 'SIMPLE_ARTIFACT_DESCRIPTOR_INVALID'].includes(error.code))
      return { exists: false, cacheStatus: 'rebuild', reason: error.code };
    throw error;
  }
}
