import vinext from 'vinext';
import { identityNodeManifestProjection } from '@shop/config/identity-node-manifest';
import type { SflNodeRegistryDeclaration } from '@shop/config/sfl-node-registry';
import { identityNodeRegistryFromManifest, PRODUCTION_IDENTITY_NODE_REGISTRY_SOURCE, parseIdentityNodeRegistry } from '@shop/sdk/identity-node';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv, type Plugin } from 'vite';

const localBindingConfig = {
  main: './worker/index.ts',
  compatibility_date: '2026-07-24',
  compatibility_flags: ['nodejs_compat'],
};

const productionDemoAuthModule = fileURLToPath(new URL('./src/config/productionDemoAuth.ts', import.meta.url));

export default defineConfig(async ({ command, mode }) => {
  const instanceRoot = process.env.LK_INSTANCE_ROOT?.trim();
  const envDirectory = instanceRoot ? path.resolve(instanceRoot) : __dirname;
  const environment = { ...loadEnv(mode, envDirectory, ''), ...process.env };
  const instanceDeclaration = instanceRoot
    ? JSON.parse(await readFile(path.join(envDirectory, 'sfl-node-registry.declaration.json'), 'utf8')) as SflNodeRegistryDeclaration
    : undefined;
  const instanceNodes = instanceDeclaration === undefined
    ? undefined
    : identityNodeRegistryFromManifest(identityNodeManifestProjection(instanceDeclaration));
  if (instanceNodes !== undefined) {
    const localNodes = command === 'build' ? instanceNodes : {
      ...instanceNodes,
      nodes: instanceNodes.nodes.map((node, index) => index === 0
        ? { ...node, storefrontHosts: [...new Set([...node.storefrontHosts, 'localhost', '127.0.0.1'])] }
        : node),
    };
    const node = instanceNodes.nodes[0]!;
    for (const [key, value] of Object.entries(environment)) {
      if (value !== undefined && process.env[key] === undefined) process.env[key] = value;
    }
    process.env.NEXT_PUBLIC_IDENTITY_NODE_REGISTRY = JSON.stringify(localNodes);
    process.env.NEXT_PUBLIC_STOREFRONT_HOSTNAME = environment.NEXT_PUBLIC_STOREFRONT_HOSTNAME ?? new URL(node.storefrontOrigin).hostname;
    process.env.NEXT_PUBLIC_STOREFRONT_APPLICATION = node.consumerApplication;
    process.env.NEXT_PUBLIC_API_BASE_URL = environment.NEXT_PUBLIC_API_BASE_URL ?? environment.VITE_API_BASE_URL ?? node.consumerApiOrigin ?? node.apiOrigin;
    process.env.NEXT_PUBLIC_AUTH_ORIGIN = environment.NEXT_PUBLIC_AUTH_ORIGIN ?? environment.VITE_AUTH_BASE_URL ?? node.accountsOrigin;
    process.env.NEXT_PUBLIC_CLIENT_VERSION = environment.NEXT_PUBLIC_CLIENT_VERSION ?? environment.VITE_CLIENT_VERSION ?? '0.0.0';
  }
  process.env.WRANGLER_WRITE_LOGS ??= 'false';
  process.env.WRANGLER_LOG_PATH ??= '.wrangler/logs';
  process.env.MINIFLARE_REGISTRY_PATH ??= '.wrangler/registry';
  if (command === 'build' && instanceNodes === undefined) {
    const configured = process.env.NEXT_PUBLIC_IDENTITY_NODE_REGISTRY?.trim();
    if (configured !== undefined
      && JSON.stringify(parseIdentityNodeRegistry(configured)) !== PRODUCTION_IDENTITY_NODE_REGISTRY_SOURCE) {
      throw new Error('STOREFRONT_IDENTITY_NODE_MANIFEST_DRIFT');
    }
    process.env.NEXT_PUBLIC_IDENTITY_NODE_REGISTRY = PRODUCTION_IDENTITY_NODE_REGISTRY_SOURCE;
  }

  const { cloudflare } = await import('@cloudflare/vite-plugin');

  return {
    envDir: envDirectory,
    plugins: [
      instanceNodeDeclaration(instanceDeclaration),
      {
        name: 'production-demo-auth-hard-cut',
        enforce: 'pre',
        resolveId(source: string, importer?: string) {
          if (command !== 'build' || source !== './demoAuth' || !importer?.includes('/services/commerce-api/src/api/')) return null;
          return productionDemoAuthModule;
        },
      },
      vinext(),
      cloudflare({
        viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] },
        config: localBindingConfig,
      }),
    ],
    build: {
      cssMinify: 'lightningcss' as const,
      cssTarget: 'chrome61',
    },
    server: {
      fs: {
        allow: ['..', '../..', '../../..'],
      },
    },
  };
});

function instanceNodeDeclaration(declaration: SflNodeRegistryDeclaration | undefined): Plugin {
  const registryPath = path.resolve(__dirname, '../../../02_platform_pingtai/config/sfl-node-registry.declaration.json')
    .replaceAll('\\', '/').toLowerCase();
  return {
    name: 'storefront-instance-node-registry',
    enforce: 'pre',
    load(id) {
      if (declaration === undefined) return null;
      const modulePath = path.resolve(id.split('?')[0]!).replaceAll('\\', '/').toLowerCase();
      return modulePath === registryPath ? JSON.stringify(declaration) : null;
    },
  };
}
