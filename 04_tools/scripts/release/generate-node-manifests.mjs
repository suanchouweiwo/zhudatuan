// Declaration projection:
//   node --import tsx 04_tools/scripts/release/generate-node-manifests.mjs [--check]
// Instance declaration projection (outputs into the instance's dist/config/node-manifests):
//   node --import tsx 04_tools/scripts/release/generate-node-manifests.mjs --instance-root <dir>
// Public release input snapshot and reuse of existing local outputs:
//   node --import tsx 04_tools/scripts/release/generate-node-manifests.mjs \
//     --instance-root <dir> --release-input-output <dir> --assemble-output <dir>
// Runtime release evidence:
//   node --import tsx 04_tools/scripts/release/generate-node-manifests.mjs \
//     --release-output <dir> --source-sha <git-sha> --artifact-digest <sha256:...> \
//     --build-id <id> --generated-at <ISO-8601>

import { copyFile, cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  materializeNodeManifestRegistryDeclaration,
  materializeNodeManifestRegistryRelease,
} from '../../../01_core_hexin/packages/config/src/SflNodeKernel.ts';
import {
  SFL_NODE_MANIFEST_REGISTRY_DECLARATION,
  SFL_NODE_REGISTRY,
} from '../../../01_core_hexin/packages/config/src/SflNodeRegistry.ts';
import { identityNodeManifestProjection } from '../../../01_core_hexin/packages/config/src/IdentityNodeManifest.ts';
import { identityNodeRegistryFromManifest } from '../../../01_core_hexin/packages/sdk/src/IdentityNodeRegistry.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const options = parseArguments(process.argv.slice(2));
const instanceRegistry = options.instanceRoot === null ? SFL_NODE_REGISTRY
  : JSON.parse(await readFile(resolve(options.instanceRoot, 'sfl-node-registry.declaration.json'), 'utf8'));
const declaration = options.instanceRoot === null ? SFL_NODE_MANIFEST_REGISTRY_DECLARATION : {
  registry_version: instanceRegistry.registry_version,
  generated_at: instanceRegistry.generated_at,
  manifests: instanceRegistry.manifests,
};
const outputDirectory = options.releaseOutput ?? (options.instanceRoot === null
  ? resolve(root, '02_platform_pingtai/config/node-manifests')
  : resolve(options.instanceRoot, 'dist/config/node-manifests'));
const checking = options.checking;
const consoleArtifact = options.instanceRoot === null ? null
  : await optionalJson(resolve(options.instanceRoot, 'dist/console/console-build.json'));
const matchingConsoleArtifact = consoleArtifact !== null && (options.releaseEvidence === null
  || consoleArtifact.source_sha === options.releaseEvidence.source_sha) ? consoleArtifact : null;
const releaseEvidence = options.releaseEvidence === null || matchingConsoleArtifact === null
  ? options.releaseEvidence : {
    ...options.releaseEvidence,
    build_id: matchingConsoleArtifact.build_id,
    immutable_artifact_digest: matchingConsoleArtifact.immutable_artifact_digest,
  };
const registry = options.releaseEvidence === null
  ? await materializeNodeManifestRegistryDeclaration(declaration)
  : await materializeNodeManifestRegistryRelease(declaration, releaseEvidence);
const fileByNode = new Map(instanceRegistry.node_bindings
  .map((binding) => [binding.node_id, binding.runtime_manifest_file]));
const expectedFiles = new Set(fileByNode.values());

if (fileByNode.size !== registry.manifests.length) throw new Error('NODE_MANIFEST_FILE_BINDING_MISMATCH');

for (const manifest of registry.manifests) {
  const file = fileByNode.get(manifest.node_id);
  if (file === undefined) throw new Error(`NODE_MANIFEST_FILE_BINDING_MISSING:${manifest.node_id}`);
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  const destination = resolve(outputDirectory, file);
  if (checking) {
    const existing = await readFile(destination, 'utf8').catch(() => '');
    if (existing !== serialized) throw new Error(`NODE_MANIFEST_GENERATED_DRIFT:${file}`);
  } else {
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(destination, serialized);
  }
}

const unexpected = (await readdir(outputDirectory).catch(() => []))
  .filter((file) => file.endsWith('.json') && !expectedFiles.has(file));
if (unexpected.length > 0) throw new Error(`NODE_MANIFEST_UNDECLARED_FILES:${unexpected.sort().join(',')}`);

if (options.instanceRoot !== null && !checking) {
  const configDirectory = options.releaseOutput === null
    ? resolve(options.instanceRoot, 'dist/config') : dirname(outputDirectory);
  const identityOutput = resolve(configDirectory, 'identity-node-projection.json');
  const identityProjection = identityNodeManifestProjection(instanceRegistry);
  await mkdir(dirname(identityOutput), { recursive: true });
  await writeJson(identityOutput, identityProjection);
  await writeInstanceRuntime(configDirectory, identityProjection);
  if (options.releaseInputOutput !== null) {
    await writeReleaseInputs(options.releaseInputOutput);
  }
  if (options.assembleOutput !== null) {
    await assembleExistingOutputs(configDirectory);
  }
}

console.log(`SFL NodeManifest ${options.releaseEvidence === null ? 'declaration projection' : 'release evidence'} verified: ${registry.manifests.length} nodes, registry ${registry.registry_version}.`);

function parseArguments(values) {
  const optionalArguments = new Map([
    ['--instance-root', 'instanceRoot'],
    ['--release-input-output', 'releaseInputOutput'],
    ['--assemble-output', 'assembleOutput'],
    ['--control-root', 'controlRoot'],
  ]);
  const options = { instanceRoot: null, releaseInputOutput: null, assembleOutput: null, controlRoot: root };
  const manifestArguments = [];
  const seen = new Set();
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    const option = optionalArguments.get(key);
    if (option === undefined) {
      manifestArguments.push(key);
      continue;
    }
    const value = values[++index];
    if (typeof value !== 'string' || value.startsWith('--') || seen.has(key)) {
      throw new Error('NODE_MANIFEST_ARGUMENT_INVALID');
    }
    seen.add(key);
    options[option] = resolve(value);
  }
  return Object.freeze({ ...parseManifestArguments(manifestArguments), ...options });
}

async function writeInstanceRuntime(configDirectory, identityProjection) {
  const artifact = matchingConsoleArtifact;
  const release = artifact === null ? releaseEvidence === null ? null : {
    source_sha: releaseEvidence.source_sha,
    build_id: releaseEvidence.build_id,
    build_count: 1,
    immutable_artifact_digest: releaseEvidence.immutable_artifact_digest,
  } : {
    source_sha: artifact.source_sha,
    build_id: artifact.build_id,
    build_count: artifact.build_count,
    immutable_artifact_digest: artifact.immutable_artifact_digest,
  };
  if (release === null) return;
  await writeJson(resolve(configDirectory, 'identity-runtime.json'), {
    schema_version: 'sfl.identity-node-runtime.v1',
    ...release,
    identity_node_registry: identityNodeRegistryFromManifest(identityProjection),
  });
  if (artifact === null) {
    if (releaseEvidence !== null) await rm(resolve(configDirectory, 'console-runtime.json'), { force: true });
    return;
  }
  const manifest = artifact.node_manifest_registry?.manifests
    ?.find((candidate) => instanceRegistry.manifests.some((declared) => declared.node_id === candidate.node_id));
  const binding = artifact.runtime_bindings?.find((candidate) =>
    candidate.resource_binding_set_ref?.ref === manifest?.resource_binding_set_ref.ref
    && candidate.resource_binding_set_ref?.version === manifest?.resource_binding_set_ref.version);
  if (manifest === undefined || binding === undefined) return;
  await writeJson(resolve(configDirectory, 'console-runtime.json'), {
    schema_version: 'sfl.console-node-runtime.v1',
    ...release,
    source_tree: artifact.source_tree,
    client_version: artifact.client_version,
    node_manifest: manifest,
    runtime_binding: binding,
  });
}

async function writeReleaseInputs(outputDirectory) {
  const { loadEnv } = await import('vite');
  const environment = { ...loadEnv('production', options.instanceRoot, ''), ...process.env };
  const publicKeys = [
    'VITE_API_BASE_URL', 'VITE_AUTH_BASE_URL', 'VITE_CLIENT_VERSION', 'COMMERCE_API_ORIGIN',
    'NEXT_PUBLIC_API_BASE_URL', 'NEXT_PUBLIC_AUTH_ORIGIN', 'NEXT_PUBLIC_CLIENT_VERSION',
    'NEXT_PUBLIC_STOREFRONT_HOSTNAME', 'NEXT_PUBLIC_STOREFRONT_APPLICATION',
  ];
  const lines = publicKeys.filter((key) => typeof environment[key] === 'string')
    .map((key) => `${key}=${JSON.stringify(environment[key])}`);
  await mkdir(outputDirectory, { recursive: true });
  await writeJson(resolve(outputDirectory, 'sfl-node-registry.declaration.json'), instanceRegistry);
  await writeFile(resolve(outputDirectory, '.env.local'), `${lines.join('\n')}\n`);
}

async function assembleExistingOutputs(configDirectory) {
  const [{ loadAdapter }, { materializeTarget }] = await Promise.all([
    import(pathToFileURL(resolve(options.controlRoot, '04_tools/release-engine/src/adapter.mjs')).href),
    import(pathToFileURL(resolve(options.controlRoot, '04_tools/release-engine/src/artifact.mjs')).href),
  ]);
  const originalInstanceRoot = process.env.LK_INSTANCE_ROOT;
  let loaded;
  try {
    process.env.LK_INSTANCE_ROOT = options.instanceRoot;
    loaded = await loadAdapter(resolve(options.controlRoot,
      '02_platform_pingtai/infrastructure/release/zdt-next.release.json'), options.controlRoot);
  } finally {
    if (originalInstanceRoot === undefined) delete process.env.LK_INSTANCE_ROOT;
    else process.env.LK_INSTANCE_ROOT = originalInstanceRoot;
  }
  const adapter = { ...loaded, projectRoot: root, instanceRoot: options.instanceRoot };
  const outputDirectories = {
    console: 'console',
    'auth-web': 'auth-web',
    storefront: 'storefront-web',
    'identity-api': 'services/identity-api',
    'web-api': 'services/web-api',
  };
  for (const [target, directory] of Object.entries(outputDirectories)) {
    const output = resolve(options.instanceRoot, 'dist', directory);
    if (!(await fileExists(output)) || (await readdir(output)).length === 0) {
      console.log(`Existing output skipped: ${target}, instance output unavailable.`);
      continue;
    }
    const assembled = await materializeTarget(adapter, target, options.assembleOutput);
    console.log(`Existing output assembled: ${target}, ${assembled.fileCount} files, ${assembled.totalBytes} bytes, ${assembled.treeDigest}.`);
  }
  const outputConfig = resolve(options.assembleOutput, 'config');
  await mkdir(outputConfig, { recursive: true });
  const releaseInputs = options.releaseInputOutput ?? resolve(outputConfig, 'release-inputs');
  if (options.releaseInputOutput === null) await writeReleaseInputs(releaseInputs);
  for (const name of ['sfl-node-registry.declaration.json', '.env.local']) {
    await copyFile(resolve(releaseInputs, name), resolve(outputConfig, name));
  }
  for (const name of ['identity-node-projection.json', 'console-runtime.json', 'identity-runtime.json', 'miniapp-environment.json']) {
    const source = resolve(configDirectory, name);
    if (await fileExists(source)) await copyFile(source, resolve(outputConfig, name));
  }
  await cp(outputDirectory, join(outputConfig, 'node-manifests'), { recursive: true });
}

async function optionalJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function fileExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function parseManifestArguments(values) {
  if (values.length === 0) return Object.freeze({ checking: false, releaseOutput: null, releaseEvidence: null });
  if (values.length === 1 && values[0] === '--check') {
    return Object.freeze({ checking: true, releaseOutput: null, releaseEvidence: null });
  }
  const parsed = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (typeof key !== 'string' || typeof value !== 'string' || !key.startsWith('--') || parsed.has(key)) {
      throw new Error('NODE_MANIFEST_ARGUMENT_INVALID');
    }
    parsed.set(key, value);
  }
  const expected = ['--artifact-digest', '--build-id', '--generated-at', '--release-output', '--source-sha'];
  if (parsed.size !== expected.length || expected.some((key) => !parsed.has(key))) {
    throw new Error('NODE_MANIFEST_RELEASE_ARGUMENTS_REQUIRED');
  }
  const releaseOutput = resolve(parsed.get('--release-output'));
  if (releaseOutput === '/' || releaseOutput === root || releaseOutput === resolve(root, '02_platform_pingtai/config/node-manifests')) {
    throw new Error('NODE_MANIFEST_RELEASE_OUTPUT_INVALID');
  }
  return Object.freeze({
    checking: false,
    releaseOutput,
    releaseEvidence: Object.freeze({
      source_sha: parsed.get('--source-sha'),
      build_id: parsed.get('--build-id'),
      immutable_artifact_digest: parsed.get('--artifact-digest'),
      generated_at: parsed.get('--generated-at'),
    }),
  });
}
