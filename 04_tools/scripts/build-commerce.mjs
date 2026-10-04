import { build } from 'esbuild';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { instanceNodeRegistryPlugin } from '../release-engine/adapters/zdt-next/workspace-resolver.mjs';

const entryDirectory = '01_core_hexin/services/commerce/src/entry';
const entryPoints = Object.fromEntries((await readdir(entryDirectory))
  .filter((file) => file.endsWith('Main.ts'))
  .sort()
  .map((file) => [file.slice(0, -3), `${entryDirectory}/${file}`]));

Object.assign(entryPoints, {
  BootstrapOwner: '04_tools/tools/seed/src/BootstrapOwner.ts',
  BootstrapRegistration: '04_tools/tools/seed/src/BootstrapRegistration.ts',
  BootstrapStagingOwner: '04_tools/tools/seed/src/BootstrapStagingOwner.ts',
  InternalRuntimeMain: '04_tools/tools/localinfra/src/Run.ts',
  InternalRuntimeReadyMain: '04_tools/tools/localinfra/src/RegistrationReady.ts',
  LocalKmsMain: '04_tools/tools/localkms/src/Main.ts',
  LocalObjectsMain: '04_tools/tools/localobjects/src/Main.ts',
  LocalSecretsMain: '04_tools/tools/localsecrets/src/Main.ts',
  PostgresTlsProxyMain: '04_tools/tools/localinfra/src/PostgresTlsProxyMain.ts',
});

const instanceRoot = process.env.LK_INSTANCE_ROOT?.trim();
const instanceRegistry = instanceNodeRegistryPlugin(instanceRoot);
await build({
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  bundle: true,
  entryPoints,
  format: 'esm',
  outdir: instanceRoot ? resolve(instanceRoot, 'dist/services/commerce') : '01_core_hexin/services/commerce/dist',
  packages: 'bundle',
  platform: 'node',
  plugins: instanceRegistry === null ? [] : [instanceRegistry],
  sourcemap: true,
});
