#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { cp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const appRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const distRoot = join(appRoot, 'dist');
const runtimeEntry = join(distRoot, 'start.mjs');
const runtimeManifest = join(distRoot, 'production-runtime.json');
const source = `
import { randomBytes, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startProdServer } from 'vinext/server/prod-server';

const port = Number.parseInt(process.env.STOREFRONT_PORT ?? process.env.PORT ?? '3000', 10);
const host = process.env.STOREFRONT_HOST ?? process.env.HOST ?? '127.0.0.1';
process.env.__VINEXT_DRAFT_SECRET ??= randomUUID();
process.env.__VINEXT_PRERENDER_SECRET ??= randomBytes(32).toString('hex');

await startProdServer({
  port,
  host,
  outDir: dirname(fileURLToPath(import.meta.url)),
});
`;

const result = await build({
  absWorkingDir: appRoot,
  stdin: {
    contents: source,
    loader: 'js',
    resolveDir: appRoot,
    sourcefile: 'storefront-production-entry.mjs',
  },
  outfile: runtimeEntry,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'bundle',
  sourcemap: false,
  legalComments: 'none',
  metafile: true,
  logLevel: 'warning',
});

const externalImports = [
  ...new Set(
    Object.values(result.metafile.outputs)
      .flatMap((output) => output.imports)
      .filter((entry) => entry.external)
      .map((entry) => entry.path)
  ),
].sort();
const unexpectedExternals = externalImports.filter((path) => !path.startsWith('node:'));
if (unexpectedExternals.length > 0) {
  throw new Error(`STOREFRONT_RUNTIME_EXTERNAL_DEPENDENCY:${unexpectedExternals.join(',')}`);
}

await normalizeVinextRuntimeSecrets();

const bundledPackages = [...new Set(Object.keys(result.metafile.inputs).map(packageNameFromInput).filter(Boolean))].sort();
const runtimeBytes = (await stat(runtimeEntry)).size;
const runtimeSha256 = createHash('sha256')
  .update(await readFile(runtimeEntry))
  .digest('hex');
const vinextEntry = fileURLToPath(import.meta.resolve('vinext'));
const vinextPackage = JSON.parse(await readFile(resolve(dirname(vinextEntry), '..', 'package.json'), 'utf8'));
const manifest = {
  schema: 'storefront.production-runtime.v1',
  entry: 'start.mjs',
  vinextVersion: vinextPackage.version,
  bundledPackages,
  externalImports,
  bytes: runtimeBytes,
  sha256: `sha256:${runtimeSha256}`,
};
await writeFile(runtimeManifest, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
process.stdout.write(`Storefront production runtime: ${runtimeBytes} bytes; bundled packages: ${bundledPackages.join(', ')}\n`);

const instanceRoot = process.env.LK_INSTANCE_ROOT?.trim();
if (instanceRoot) {
  const absoluteInstanceRoot = resolve(instanceRoot);
  const outputDirectory = resolve(absoluteInstanceRoot, 'dist', 'storefront-web');
  if (relative(absoluteInstanceRoot, outputDirectory) !== join('dist', 'storefront-web')) {
    throw new Error('Storefront output directory must remain inside the instance dist directory.');
  }
  await rm(outputDirectory, { recursive: true, force: true });
  await cp(distRoot, outputDirectory, { recursive: true });
  process.stdout.write(`Storefront instance output: ${outputDirectory}\n`);
}

async function normalizeVinextRuntimeSecrets() {
  const serverEntry = join(distRoot, 'server', 'index.js');
  const serverSource = await readFile(serverEntry, 'utf8');
  const draftPattern = /function getDraftSecret\(\) \{\s*return "[0-9a-f-]{36}";\s*\}/;
  if ((serverSource.match(new RegExp(draftPattern.source, 'g')) ?? []).length !== 1) {
    throw new Error('STOREFRONT_DRAFT_SECRET_SHAPE_CHANGED');
  }
  let normalizedServerSource = serverSource.replace(draftPattern, 'function getDraftSecret() {\n\treturn process.env.__VINEXT_DRAFT_SECRET;\n}');
  const generatedBuildId = normalizedServerSource.match(/get buildId\(\) \{\s*return "([0-9a-f-]{36})";\s*\}/)?.[1];
  if (!generatedBuildId || !normalizedServerSource.includes(`deploymentVersion: "${generatedBuildId}"`)) {
    throw new Error('STOREFRONT_BUILD_ID_SHAPE_CHANGED');
  }
  const buildIdSeed = normalizedServerSource.replaceAll(generatedBuildId, '00000000-0000-0000-0000-000000000000');
  const buildIdHex = createHash('sha256').update(buildIdSeed).digest('hex').slice(0, 32).replaceAll('a', 'b').replaceAll('d', 'e');
  const deterministicBuildId = [buildIdHex.slice(0, 8), buildIdHex.slice(8, 12), buildIdHex.slice(12, 16), buildIdHex.slice(16, 20), buildIdHex.slice(20)].join('-');
  normalizedServerSource = normalizedServerSource.replaceAll(generatedBuildId, deterministicBuildId);
  await writeFile(serverEntry, normalizedServerSource, 'utf8');

  const runtimeSource = await readFile(runtimeEntry, 'utf8');
  const prerenderPattern = /return readJsonFile\(([^;]+vinext-server\.json[^;]+)\)\?\.prerenderSecret;/;
  if ((runtimeSource.match(new RegExp(prerenderPattern.source, 'g')) ?? []).length !== 1) {
    throw new Error('STOREFRONT_PRERENDER_SECRET_SHAPE_CHANGED');
  }
  await writeFile(runtimeEntry, runtimeSource.replace(prerenderPattern, 'return process.env.__VINEXT_PRERENDER_SECRET ?? readJsonFile($1)?.prerenderSecret;'), 'utf8');

  const placeholder = '{"prerenderSecret":"injected-at-runtime"}';
  for (const manifest of [join(distRoot, 'server', 'vinext-server.json'), join(distRoot, 'server', 'ssr', 'vinext-server.json')]) {
    await writeFile(manifest, placeholder, 'utf8');
  }
}

function packageNameFromInput(path) {
  const normalized = path.replaceAll('\\', '/');
  const marker = '/node_modules/';
  const offset = normalized.lastIndexOf(marker);
  if (offset < 0) return null;
  const segments = normalized.slice(offset + marker.length).split('/');
  return segments[0]?.startsWith('@') ? `${segments[0]}/${segments[1]}` : segments[0];
}
