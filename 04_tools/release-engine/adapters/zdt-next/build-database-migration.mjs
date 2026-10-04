import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';

import { workspaceResolver } from './workspace-resolver.mjs';

const outfile = '01_core_hexin/services/commerce/dist/DatabaseMigrationExecutor.js';
await mkdir('01_core_hexin/services/commerce/dist', { recursive: true });
await build({
  banner: { js: "import { createRequire as __sflCreateRequire } from 'node:module'; const require = __sflCreateRequire(import.meta.url);" },
  bundle: true,
  entryPoints: {
    DatabaseMigrationExecutor: '04_tools/release-engine/adapters/zdt-next/database-migration-executor.mjs',
    LocalSecretsMain: '04_tools/tools/localsecrets/src/Main.ts',
    LocalObjectsMain: '04_tools/tools/localobjects/src/Main.ts',
    CatalogObjectStoreReadyMain: '01_core_hexin/services/commerce/src/entry/CatalogObjectStoreReadyMain.ts',
  },
  format: 'esm',
  outdir: '01_core_hexin/services/commerce/dist',
  packages: 'bundle',
  platform: 'node',
  plugins: [await workspaceResolver(process.cwd())],
  sourcemap: true,
});
console.log(`database migration executor build: ${outfile}`);
