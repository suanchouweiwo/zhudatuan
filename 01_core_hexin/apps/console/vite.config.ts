import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import {
  materializeSflConsoleArtifact,
  normalizeConsoleClientVersion,
} from '@shop/config/sfl-console-runtime';
import { materializeNodeManifestRegistryDeclaration } from '@shop/config/sfl-node-kernel';
import {
  consoleReleaseDeclarationOf,
  nodeManifestDeclaration,
  SFL_CONSOLE_RELEASE_DECLARATION,
  SFL_NODE_REGISTRY,
  type SflConsoleReleaseDeclaration,
  type SflNodeRegistryDeclaration,
} from '@shop/config/sfl-node-registry';
import { consoleImmutableArtifactDigest } from '../../../04_tools/scripts/release/console-digest.mjs';
import { createConsoleVersion } from './src/shared/config/ConsoleDeployment';

export default defineConfig(async ({ command, mode }) => {
  const instanceRoot = process.env.LK_INSTANCE_ROOT?.trim();
  const environmentDirectory = instanceRoot ? resolve(instanceRoot) : import.meta.dirname;
  const environment = { ...loadEnv(mode, environmentDirectory, ''), ...process.env };
  const instanceRegistry: SflNodeRegistryDeclaration | undefined = instanceRoot
    ? JSON.parse(readFileSync(join(environmentDirectory, 'sfl-node-registry.declaration.json'), 'utf8'))
    : undefined;
  const declaration = instanceRegistry === undefined
    ? SFL_CONSOLE_RELEASE_DECLARATION
    : consoleReleaseDeclarationOf(instanceRegistry);
  const instanceManifest = instanceRegistry === undefined ? undefined
    : (await materializeNodeManifestRegistryDeclaration({
      registry_version: instanceRegistry.registry_version,
      generated_at: instanceRegistry.generated_at,
      manifests: instanceRegistry.manifests,
    })).manifests[0];
  const apiOrigin = environment.COMMERCE_API_ORIGIN ?? 'http://127.0.0.1:3001';
  if (command === 'build') validateClientBuildEnvironment(environment);
  const build = buildDefinition(environment);
  const clientVersion = normalizeConsoleClientVersion(environment.VITE_CLIENT_VERSION);
  return {
    envDir: environmentDirectory,
    plugins: [react(), tailwindcss(), consoleRuntimeEvidence(build, clientVersion, declaration, instanceRegistry)],
    define: {
      __SHOP_BUILD_COMMIT__: JSON.stringify(build.commit),
      __SHOP_BUILD_BRANCH__: JSON.stringify(build.branch),
      __SHOP_BUILD_ID__: JSON.stringify(build.id),
      __SHOP_BUILD_DIRTY__: JSON.stringify(build.dirty),
      __SHOP_BUILD_AT__: JSON.stringify(build.builtAt),
      __LK_INSTANCE_NODE_MANIFEST__: instanceManifest === undefined ? 'undefined' : JSON.stringify(instanceManifest),
      __LK_INSTANCE_NODE_BINDINGS__: JSON.stringify((instanceRegistry ?? SFL_NODE_REGISTRY).node_bindings
        .map(({ node_id, brand_name, display_name }) => ({ node_id, brand_name, display_name }))),
      __LK_INSTANCE_CONSOLE_RUNTIME_BINDINGS__: instanceRegistry === undefined ? 'undefined' : JSON.stringify(declaration.runtime_bindings),
    },
    build: { manifest: true },
    server: {
      port: 5173,
      /**
       * Production serves node-specific API origins from the SFL runtime binding.
       * Development keeps API calls same-origin and proxies them to the local service.
       */
      proxy: {
        '/api': {
          target: apiOrigin,
          // HTTPS upstreams need their own Host/SNI; local HTTP keeps the original host.
          changeOrigin: new URL(apiOrigin).protocol === 'https:',
        },
      },
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});

const repositoryRoot = resolve(import.meta.dirname, '../../..');

interface BuildDefinition {
  readonly commit: string;
  readonly branch: string;
  readonly id: string;
  readonly dirty: boolean;
  readonly builtAt: string;
}

function consoleRuntimeEvidence(
  build: BuildDefinition,
  clientVersion: string,
  declaration: SflConsoleReleaseDeclaration,
  instanceRegistry: SflNodeRegistryDeclaration | undefined,
): Plugin {
  let outputDirectory = resolve(import.meta.dirname, 'dist');
  const nodeBinding = instanceRegistry?.node_bindings[0];
  const consoleHost = nodeBinding === undefined ? undefined
    : nodeManifestDeclaration(nodeBinding.node_id, instanceRegistry)
      .domain_bindings.find((domain) => domain.surface_ref === 'surface:console')?.host;
  const presentation = nodeBinding === undefined || consoleHost === undefined ? undefined : {
    brandName: nodeBinding.brand_name,
    consoleOrigin: `https://${consoleHost}`,
  };
  return {
    name: 'sfl-console-runtime-evidence',
    configResolved(config) {
      outputDirectory = isAbsolute(config.build.outDir)
        ? config.build.outDir
        : resolve(import.meta.dirname, config.build.outDir);
    },
    transformIndexHtml(html) {
      if (presentation === undefined) return html;
      const title = `运营管理后台｜${presentation.brandName}`;
      const description = `${presentation.brandName}运营、会员与业务管理后台。`;
      const metadata = {
        description,
        'og:site_name': presentation.brandName,
        'og:title': title,
        'og:description': description,
        'og:url': `${presentation.consoleOrigin}/`,
        'og:image': `${presentation.consoleOrigin}/brand/share-wechat.png`,
      };
      for (const [key, value] of Object.entries(metadata)) {
        html = html.replace(new RegExp(`(<meta (?:name|property)="${key}" content=")[^"]*(")`),
          (_, before, after) => `${before}${htmlText(value)}${after}`);
      }
      return html
        .replace(/<title>[^<]*<\/title>/, () => `<title>${htmlText(title)}</title>`)
        .replace(/(<link rel="canonical" href=")[^"]*(")/,
          (_, before, after) => `${before}${htmlText(`${presentation.consoleOrigin}/`)}${after}`);
    },
    async closeBundle() {
      if (presentation !== undefined) {
        const manifestPath = join(outputDirectory, 'brand/site.webmanifest');
        const webManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        writeFileSync(manifestPath, `${JSON.stringify({
          ...webManifest,
          name: `${presentation.brandName}运营后台`,
          short_name: presentation.brandName,
          description: `${presentation.brandName}运营、会员与业务管理后台`,
        }, null, 2)}\n`);
      }
      const version = createConsoleVersion({
        sourceBranch: build.branch,
        sourceSha: build.commit,
        builtAt: build.builtAt,
        sourceTree: build.dirty ? 'dirty' : 'clean',
        buildId: build.id,
      });
      writeFileSync(
        join(outputDirectory, 'console-version.json'),
        `${JSON.stringify(version, null, 2)}\n`,
      );
      const immutableArtifactDigest = consoleImmutableArtifactDigest(outputDirectory);
      const artifact = await materializeSflConsoleArtifact(declaration, {
        source_sha: build.commit,
        build_id: build.id,
        source_tree: build.dirty ? 'dirty' : 'clean',
        client_version: clientVersion,
        immutable_artifact_digest: immutableArtifactDigest,
      });
      writeFileSync(
        join(outputDirectory, 'console-build.json'),
        `${JSON.stringify(artifact, null, 2)}\n`,
      );
    },
  };
}

function htmlText(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
}

function buildDefinition(environment: Readonly<Record<string, string | undefined>>): BuildDefinition {
  const commit = environment.SHOP_BUILD_COMMIT?.trim() || git(['rev-parse', 'HEAD']);
  const branch = environment.SHOP_BUILD_BRANCH?.trim() || git(['branch', '--show-current']) || 'detached';
  const dirty = environment.SHOP_BUILD_DIRTY === undefined
    ? git(['status', '--porcelain', '--untracked-files=no']).length > 0
    : environment.SHOP_BUILD_DIRTY === 'true';
  const id = environment.SHOP_BUILD_ID?.trim() || `${commit.slice(0, 12)}${dirty ? '-dirty' : ''}`;
  const builtAt = environment.SHOP_BUILD_AT?.trim() || new Date().toISOString();
  return Object.freeze({ commit, branch, id, dirty, builtAt });
}

function git(arguments_: readonly string[]): string {
  return execFileSync('git', ['-C', repositoryRoot, ...arguments_], { encoding: 'utf8' }).trim();
}

function validateClientBuildEnvironment(source: Readonly<Record<string, string | undefined>>): void {
  const apiBaseUrl = requiredBuildValue(source.VITE_API_BASE_URL, 'CLIENT_API_BASE_URL_MISSING');
  const authBaseUrl = requiredBuildValue(source.VITE_AUTH_BASE_URL, 'CLIENT_AUTH_BASE_URL_MISSING');
  const clientVersion = requiredBuildValue(source.VITE_CLIENT_VERSION, 'CLIENT_VERSION_MISSING');
  if (!/^https:\/\//.test(apiBaseUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(apiBaseUrl)) {
    throw new Error('CLIENT_API_BASE_URL_INVALID');
  }
  if (!/^https:\/\//.test(authBaseUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(authBaseUrl)) {
    throw new Error('CLIENT_AUTH_BASE_URL_INVALID');
  }
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.]+)?$/i.test(clientVersion)) throw new Error('CLIENT_VERSION_INVALID');
}

function requiredBuildValue(value: string | undefined, code: string): string {
  if (!value?.trim()) throw new Error(code);
  return value.trim();
}
