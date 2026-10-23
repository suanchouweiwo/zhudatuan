#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { cp, copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { serviceTargets } from '../../release-engine/adapters/zdt-next/service-targets.mjs';

const [releaseTarget, outputRoot, sourceSha] = process.argv.slice(2);
if (!['commerce-api', 'identity-api', 'workers', 'database-migrations', 'node-operations'].includes(releaseTarget)) {
  throw new Error(`RUNTIME_BUNDLE_TARGET_UNKNOWN:${releaseTarget}`);
}
if (!outputRoot) throw new Error('RUNTIME_BUNDLE_OUTPUT_REQUIRED');
if (!/^[a-f0-9]{40}$/.test(sourceSha ?? '')) throw new Error('RUNTIME_BUNDLE_SOURCE_SHA_INVALID');

const groups = Object.freeze({
  'commerce-api': [
    'mall-provisioning-api',
    'support-api',
    'purchase-api',
    'web-api',
    'catalog-api',
    'payment-webhook-api',
  ],
  'identity-api': ['identity-api'],
  workers: ['identity-notification-jobs', 'catalog-jobs', 'payment-jobs'],
});

await mkdir(outputRoot, { recursive: true });
if (releaseTarget === 'node-operations') {
  for (const file of [
    'autonode-operate.mjs',
    'autonode-operations-engine.mjs',
    'autonode-operations-provider.mjs',
    'autonode-control-main.mjs',
    'autonode-control-server.mjs',
    'autonode-task-engine.mjs',
    'autonode-task-executor.mjs',
    'autonode-administrator.mjs',
  ]) {
    await copy(
      `04_tools/scripts/provisioning/${file}`,
      join(outputRoot, `runtime/${file}`),
    );
  }
  await copy(
    '04_tools/scripts/release/sfl-autonode-control.service',
    join(outputRoot, 'systemd/sfl-autonode-control.service'),
  );
  await run('node_modules/.bin/esbuild', [
    '04_tools/scripts/provisioning/autonode-activate.mjs',
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--target=node22',
    `--outfile=${join(outputRoot, 'runtime/autonode-activate-runtime.mjs')}`,
  ]);
} else if (releaseTarget === 'database-migrations') {
  await run('node', ['04_tools/release-engine/adapters/zdt-next/build-database-migration.mjs']);
  await copy(
    '01_core_hexin/services/commerce/dist/DatabaseMigrationExecutor.js',
    join(outputRoot, 'executor/DatabaseMigrationExecutor.js'),
  );
  await copy(
    '01_core_hexin/services/commerce/dist/DatabaseMigrationExecutor.js.map',
    join(outputRoot, 'executor/DatabaseMigrationExecutor.js.map'),
  );
  await copy(
    '04_tools/scripts/release/run-database-migrations.mjs',
    join(outputRoot, 'executor/RunDatabaseMigrations.mjs'),
  );
  await mkdir(join(outputRoot, 'database/supabase'), { recursive: true });
  await cp(
    '02_platform_pingtai/database/supabase/migrations',
    join(outputRoot, 'database/supabase/migrations'),
    { recursive: true },
  );
  await copy(
    '02_platform_pingtai/database/contracts/history.json',
    join(outputRoot, 'database/contracts/history.json'),
  );
} else {
  for (const target of groups[releaseTarget]) {
    await run('node', ['04_tools/release-engine/adapters/zdt-next/build-commerce-service.mjs', target]);
    for (const entry of serviceTargets[target]) {
      await copy(
        `01_core_hexin/services/commerce/dist/${entry}.js`,
        join(outputRoot, `targets/${target}/service/${entry}.js`),
      );
      await copy(
        `01_core_hexin/services/commerce/dist/${entry}.js.map`,
        join(outputRoot, `targets/${target}/service/${entry}.js.map`),
      );
    }
  }
  if (releaseTarget === 'identity-api') {
    await copy(
      '02_platform_pingtai/config/node-manifests/hbbtzn-l1.json',
      join(outputRoot, 'targets/identity-api/node-manifest.json'),
    );
  }
}

await writeFile(
  join(outputRoot, 'release-version.json'),
  `${JSON.stringify({ target: releaseTarget, sourceSha, builtAt: new Date().toISOString() })}\n`,
);
process.stdout.write(`runtime bundle built: ${releaseTarget} ${sourceSha}\n`);

async function copy(source, destination) {
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`COMMAND_FAILED:${command}:${code ?? signal}`));
    });
  });
}
