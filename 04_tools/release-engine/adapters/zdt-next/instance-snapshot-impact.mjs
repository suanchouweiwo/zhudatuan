import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

import { git } from '../../src/git.mjs';
import { stableJson } from '../../src/stable.mjs';

const DIRECTORY = '02_platform_pingtai/config/release-inputs/zhudatuan-l0';
const DECLARATION = `${DIRECTORY}/sfl-node-registry.declaration.json`;
const ENV_FILES = ['.env', '.env.local', '.env.production', '.env.production.local'].map((file) => `${DIRECTORY}/${file}`);

export const L0_TARGETS = ['identity-api', 'web-api', 'purchase-api', 'storefront', 'auth-web', 'console'];

export function splitSnapshotChanges(changes) {
  const business = [];
  const snapshot = [];
  const isSnapshotPath = (path) => path.startsWith(`${DIRECTORY}/`);
  const add = (change) => (isSnapshotPath(change.path) ? snapshot : business).push(change);

  for (const change of changes) {
    const { path, sourcePath, status } = change;
    if (sourcePath && isSnapshotPath(sourcePath) !== isSnapshotPath(path)) {
      if (status.startsWith('R')) add({ path: sourcePath, sourcePath: null, status: 'D' });
      add({ path, sourcePath: null, status: 'A' });
    } else {
      add(change);
    }
  }
  return { business, snapshot };
}

export async function snapshotInstanceRoot(projectRoot) {
  const declaration = await stat(resolve(projectRoot, DECLARATION)).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  return declaration?.isFile() ? resolve(projectRoot, DIRECTORY) : undefined;
}

export function snapshotInputsChanged(changes) {
  return changes.some(({ path, sourcePath }) =>
    [path, sourcePath].some((name) => name === DECLARATION || ENV_FILES.includes(name)));
}

export async function resolveImpact({ adapter, changes, refs }) {
  if (refs.forcedSingleTarget || adapter.instanceRoot !== resolve(adapter.projectRoot, DIRECTORY) ||
      !snapshotInputsChanged(changes)) return { targets: [] };

  const [before, after] = await Promise.all(
    [refs.fromSha, refs.toSha].map((sha) => readSnapshot(adapter.projectRoot, sha))
  );
  if (stableJson(before.declaration) !== stableJson(after.declaration)) {
    return { targets: L0_TARGETS, reasons: ['ZhudaTuan L0 runtime declaration changed'] };
  }

  const previous = frontendInputs(before);
  const next = frontendInputs(after);
  const targets = Object.keys(next).filter((target) => stableJson(previous[target]) !== stableJson(next[target]));
  return { targets, reasons: targets.map((target) => `ZhudaTuan L0 ${target} build environment changed`) };
}

async function readSnapshot(projectRoot, sha) {
  const files = new Set((await git(projectRoot, ['ls-tree', '-r', '--name-only', '-z', sha, '--', DECLARATION, ...ENV_FILES])).split('\0'));
  const entries = await Promise.all([DECLARATION, ...ENV_FILES].map(async (path) => [
    path, files.has(path) ? await git(projectRoot, ['show', `${sha}:${path}`]) : '',
  ]));
  const contents = Object.fromEntries(entries);
  return {
    declaration: contents[DECLARATION] ? JSON.parse(contents[DECLARATION]) : null,
    environment: Object.assign({}, ...ENV_FILES.map((path) => parseEnv(contents[path]))),
  };
}

function frontendInputs({ declaration, environment }) {
  const manifest = declaration?.manifests?.[0];
  const bindings = manifest?.domain_bindings ?? [];
  const node = declaration?.node_bindings?.find((binding) => binding.node_id === manifest?.node_id);
  const apiHost = bindings.find((binding) => binding.surface_ref === 'surface:api')?.host;
  const identityHost = bindings.find((binding) => binding.surface_ref === 'surface:identity')?.host;
  const consumerApiHost = bindings.find((binding) => binding.binding_ref.ref === node?.consumer_api_binding_ref)?.host;
  const storefrontHost = bindings.find((binding) => binding.binding_ref.ref === node?.primary_storefront_binding_ref)?.host;
  const apiOrigin = apiHost ? `https://${apiHost}` : undefined;
  const identityOrigin = identityHost ? `https://${identityHost}` : undefined;
  const consumerApiOrigin = consumerApiHost ? `https://${consumerApiHost}` : apiOrigin;
  const storefront = { ...environment, ...process.env };
  return {
    console: [
      (environment.VITE_API_BASE_URL ?? apiOrigin) || process.env.VITE_API_BASE_URL,
      (environment.VITE_AUTH_BASE_URL ?? identityOrigin) || process.env.VITE_AUTH_BASE_URL,
    ],
    storefront: [
      storefront.NEXT_PUBLIC_API_BASE_URL ?? storefront.VITE_API_BASE_URL ?? consumerApiOrigin,
      storefront.NEXT_PUBLIC_AUTH_ORIGIN ?? storefront.VITE_AUTH_BASE_URL ?? identityOrigin,
      storefront.NEXT_PUBLIC_CLIENT_VERSION ?? storefront.VITE_CLIENT_VERSION ?? '0.0.0',
      storefront.NEXT_PUBLIC_STOREFRONT_HOSTNAME ?? storefrontHost,
    ],
  };
}
