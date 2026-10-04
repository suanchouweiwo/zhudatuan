import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { serviceEntryDirectory, serviceTargets } from './service-targets.mjs';
import { instanceNodeRegistryPlugin, workspaceResolver } from './workspace-resolver.mjs';

const target = process.argv[2];
const names = serviceTargets[target];
if (!names) throw new Error(`SERVICE_BUILD_TARGET_UNKNOWN:${target}`);
const entryPoints = Object.fromEntries(names.map((name) => [name, `${serviceEntryDirectory}/${name}.ts`]));
const instanceRoot = process.env.LK_INSTANCE_ROOT?.trim();
const outdir = instanceRoot
  ? resolve(instanceRoot, 'dist/services', target)
  : '01_core_hexin/services/commerce/dist';
const instanceRegistry = instanceNodeRegistryPlugin(instanceRoot);
await mkdir(outdir, { recursive: true });
await build({
  banner: { js: "import { createRequire as __sflCreateRequire } from 'node:module'; const require = __sflCreateRequire(import.meta.url);" },
  bundle: true,
  entryPoints,
  format: 'esm',
  outdir,
  packages: 'bundle',
  platform: 'node',
  plugins: [await workspaceResolver(process.cwd()), ...(instanceRegistry === null ? [] : [instanceRegistry])],
  sourcemap: true,
});
console.log(`service build: target=${target} entries=${names.join(',')}`);
