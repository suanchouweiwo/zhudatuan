import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadEnv } from 'vite';

import { MINIAPP_ENVIRONMENT_SCHEMA, miniappEnvironment } from '../../01_core_hexin/packages/config/src/MiniappEnvironment.ts';
import { nodeDomainBinding, nodeManifestDeclaration } from '../../01_core_hexin/packages/config/src/SflNodeRegistry.ts';

const root = resolve(import.meta.dirname, '../..');
const instanceOption = process.argv.indexOf('--instance-root');
const instancePath = instanceOption === -1 ? process.env.LK_INSTANCE_ROOT?.trim() : process.argv[instanceOption + 1];

if (instancePath) {
  const instanceRoot = resolve(instancePath);
  const registry = JSON.parse(readFileSync(join(instanceRoot, 'sfl-node-registry.declaration.json'), 'utf8'));
  const binding = registry.node_bindings[0];
  const manifest = nodeManifestDeclaration(binding.node_id, registry);
  const api = nodeDomainBinding(binding.node_id, binding.consumer_api_binding_ref, registry);
  const environment = { ...loadEnv('production', instanceRoot, ''), ...process.env };
  const runtime = miniappEnvironment({
    apiBaseUrl: environment.VITE_API_BASE_URL ?? `https://${api.host}`,
    mallId: manifest.mall_id,
    clientVersion: environment.VITE_CLIENT_VERSION,
  });
  const destination = join(instanceRoot, 'dist/config/miniapp-environment.json');
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, `${JSON.stringify(runtime, null, 2)}\n`, 'utf8');
  console.log(`Miniapp instance environment generated: ${destination}`);
} else {
const target = join(root, '01_core_hexin/apps/miniapp/miniprogram/config/Environment.js');
const schema = JSON.stringify(MINIAPP_ENVIRONMENT_SCHEMA, null, 2);
const output = `// Generated from @shop/config MiniappEnvironment. Do not edit.\nconst schema = ${schema};\n\n/** @typedef {{apiBaseUrl: string, mallId: string, clientVersion: string}} MiniappEnvironment */\n/** @param {Readonly<Record<string, unknown>>} source @returns {Readonly<MiniappEnvironment>} */\nfunction environment(source) {\n  const values = /** @type {Record<string, string>} */ ({});\n  for (const field of schema) {\n    const value = source[field.key];\n    if (typeof value !== 'string' || !new RegExp(field.pattern, 'i').test(value)) throw new Error(field.code);\n    values[field.key] = value;\n  }\n  return Object.freeze({ apiBaseUrl: String(values.apiBaseUrl).replace(/\\\/$/, ''), mallId: String(values.mallId), clientVersion: String(values.clientVersion) });\n}\n\nmodule.exports = { environment };\n`;
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== output) throw new Error('MINIAPP_ENVIRONMENT_GENERATED_DRIFT');
} else { mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, output, 'utf8'); }
}
