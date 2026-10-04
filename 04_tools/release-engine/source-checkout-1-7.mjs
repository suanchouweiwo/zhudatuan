import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Only exact commerce releases use this smaller checkout. Every other release
// keeps the existing full Source checkout and the same shared execution core.
const commercePaths = [
  '/package.json',
  '/package-lock.json',
  '/.npmrc',
  '/tsconfig.json',
  '/vitest.config.ts',
  '/eslint.config.mjs',
  '/L-kernel/',
  '/01_core_hexin/services/commerce/',
  '/01_core_hexin/packages/',
  '/01_core_hexin/extensions/',
  '/01_core_hexin/apps/*/package.json',
  '/01_core_hexin/apps/*/tsconfig.json',
  '/01_core_hexin/services/*/package.json',
  '/01_core_hexin/services/*/tsconfig.json',
  '/02_platform_pingtai/',
  '/03_quality_ceshi/',
  '/04_tools/release-engine/',
  '/04_tools/scripts/provisioning/autonode-cloudflare.mjs',
  '/04_tools/scripts/release/generate-sfl-node-gateway.mjs',
  '/04_tools/scripts/release/generate-node-manifests.mjs',
  '/04_tools/tools/*/package.json',
];

export function sourceCheckoutPaths(target, targets, instancePath = '') {
  const requested = target.split(',');
  if (!requested.every((name) => (targets[name]?.buildWorkspace ?? targets[name]?.workspace) === '@shop/commerce')) return [];
  return instancePath ? [...commercePaths, `/${instancePath.replace(/^\/+|\/+$/g, '')}/`] : commercePaths;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [controlRoot, target, instancePath] = process.argv.slice(2);
  const project = JSON.parse(await readFile(join(controlRoot, '02_platform_pingtai/infrastructure/release/zdt-next.release.json'), 'utf8'));
  const paths = sourceCheckoutPaths(target, project.targets, instancePath);
  if (paths.length) process.stdout.write(`paths<<RUNNER_SOURCE_PATHS\n${paths.join('\n')}\nRUNNER_SOURCE_PATHS\n`);
  else process.stdout.write('paths=\n');
}
