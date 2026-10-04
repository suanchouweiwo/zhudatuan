import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { identityNodeManifestProjection } from '@shop/config/identity-node-manifest';
import type { SflNodeRegistryDeclaration } from '@shop/config/sfl-node-registry';
import { PRODUCTION_IDENTITY_NODE_REGISTRY, identityNodeRegistryFromManifest } from '@shop/sdk/identity-node';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'path';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { validateAuthBuildEnvironment } from './src/buildEnvironment';

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
  let identityNodeRegistrySource = instanceNodes === undefined ? undefined : JSON.stringify(instanceNodes);
  if (command === 'build') {
    identityNodeRegistrySource = validateAuthBuildEnvironment({
      ...environment,
      ...(identityNodeRegistrySource === undefined ? {} : { VITE_IDENTITY_NODE_REGISTRY: identityNodeRegistrySource }),
    }, identityNodeRegistrySource).identityNodeRegistrySource;
  } else if (instanceNodes !== undefined) {
    identityNodeRegistrySource = JSON.stringify({
      ...instanceNodes,
      nodes: instanceNodes.nodes.map((node, index) => index === 0
        ? { ...node, accountsOrigin: 'http://127.0.0.1:3002' }
        : node),
    });
  }

  return {
    envDir: envDirectory,
    // Relative assets let the same reviewed dist run at a node identity host
    // and at the storefront's optional /login/ mount.
    base: command === 'build' ? './' : '/',
    plugins: [react(), tailwindcss(), identityInstancePresentation(instanceNodes?.nodes[0], command === 'build', instanceDeclaration)],
    ...(identityNodeRegistrySource === undefined ? {} : {
      define: {
        'import.meta.env.VITE_IDENTITY_NODE_REGISTRY': JSON.stringify(identityNodeRegistrySource),
      },
    }),
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      port: 3002,
      proxy: {
        '/api': {
          // Auth endpoints live on the storefront compatibility BFF, not the
          // canonical Commerce API (:3001).
          target: environment.AUTH_COMPAT_API_ORIGIN ?? 'http://127.0.0.1:3000',
          changeOrigin: false,
        },
      },
      // Keep the development server stable when a CI-like environment disables HMR.
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
    // Keep the explicit host allowlist; do not turn on allowHosts: true.
    preview: {
      allowedHosts: [...new Set((instanceNodes ?? PRODUCTION_IDENTITY_NODE_REGISTRY).nodes.flatMap((node) => [
        node.accountsHost,
        ...node.storefrontHosts,
        ...(node.adminOrigin === null ? [] : [new URL(node.adminOrigin).hostname]),
      ]))],
    },
  };
});

function identityInstancePresentation(
  node: typeof PRODUCTION_IDENTITY_NODE_REGISTRY.nodes[number] | undefined,
  isBuild: boolean,
  instanceDeclaration: SflNodeRegistryDeclaration | undefined,
): Plugin {
  let outputDirectory: string;
  const registryPath = path.resolve(__dirname, '../../../02_platform_pingtai/config/sfl-node-registry.declaration.json')
    .replaceAll('\\', '/').toLowerCase();
  return {
    name: 'identity-instance-presentation',
    enforce: 'pre',
    load(id) {
      if (instanceDeclaration === undefined) return null;
      const modulePath = path.resolve(id.split('?')[0]!).replaceAll('\\', '/').toLowerCase();
      return modulePath === registryPath ? JSON.stringify(instanceDeclaration) : null;
    },
    configResolved(config) {
      outputDirectory = path.resolve(config.root, config.build.outDir);
    },
    transformIndexHtml(html) {
      if (node === undefined) return html;
      const title = `统一账号认证｜${node.brandName}`;
      const description = `${node.brandName}统一身份认证入口。`;
      const metadata: Readonly<Record<string, string>> = {
        description,
        'og:site_name': node.brandName,
        'og:title': title,
        'og:description': description,
        'og:url': `${node.accountsOrigin}/`,
        'og:image': `${node.accountsOrigin}/brand/share-wechat.png`,
      };
      let result = html.replace(/<title>[^<]*<\/title>/, () => `<title>${htmlText(title)}</title>`)
        .replace(/(<link rel="canonical" href=")[^"]*(")/,
          (_, before, after) => `${before}${htmlText(`${node.accountsOrigin}/`)}${after}`);
      for (const [key, value] of Object.entries(metadata)) {
        result = result.replace(new RegExp(`(<meta (?:name|property)="${key}" content=")[^"]*(")`),
          (_, before, after) => `${before}${htmlText(value)}${after}`);
      }
      return result;
    },
    async closeBundle() {
      if (node === undefined || !isBuild) return;
      const manifestPath = path.join(outputDirectory, 'brand', 'site.webmanifest');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      manifest.name = `${node.brandName} 统一账号认证`;
      manifest.short_name = node.brandName;
      manifest.description = `${node.brandName}统一身份认证`;
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    },
  };
}

function htmlText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
