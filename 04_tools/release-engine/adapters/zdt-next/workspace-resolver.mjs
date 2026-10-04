import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export async function workspaceResolver(projectRoot = process.cwd()) {
  const rootPackage = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
  const packages = new Map();
  for (const pattern of rootPackage.workspaces ?? []) {
    for (const directory of await expandWorkspacePattern(projectRoot, pattern)) {
      try {
        const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
        if (manifest.name) packages.set(manifest.name, { directory, manifest });
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  }
  const names = [...packages.keys()].sort((left, right) => right.length - left.length);
  return {
    name: 'ai-delivery-workspace-resolver',
    setup(build) {
      build.onResolve({ filter: /^@/ }, (args) => {
        const name = names.find((candidate) => args.path === candidate || args.path.startsWith(`${candidate}/`));
        if (!name) return null;
        const workspace = packages.get(name);
        const subpath = args.path === name ? '.' : `.${args.path.slice(name.length)}`;
        const exported = resolveExport(workspace.manifest.exports, subpath);
        if (!exported) return null;
        return { path: resolve(workspace.directory, exported) };
      });
    },
  };
}

export function instanceNodeRegistryPlugin(instanceRoot, projectRoot = process.cwd()) {
  if (!instanceRoot?.trim()) return null;
  const coreDeclaration = resolve(projectRoot, '02_platform_pingtai/config/sfl-node-registry.declaration.json');
  const instanceDeclaration = resolve(instanceRoot, 'sfl-node-registry.declaration.json');
  return {
    name: 'lk-instance-node-registry',
    setup(build) {
      build.onLoad({ filter: /sfl-node-registry\.declaration\.json$/ }, async (args) => {
        if (resolve(args.path) !== coreDeclaration) return null;
        return {
          contents: await readFile(instanceDeclaration, 'utf8'),
          loader: 'json',
          resolveDir: dirname(instanceDeclaration),
        };
      });
    },
  };
}

async function expandWorkspacePattern(projectRoot, pattern) {
  const star = pattern.indexOf('*');
  if (star < 0) return [resolve(projectRoot, pattern)];
  const parent = resolve(projectRoot, pattern.slice(0, star));
  const suffix = pattern.slice(star + 1).replace(/^\//, '');
  const entries = await readdir(parent, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => suffix ? join(parent, entry.name, suffix) : join(parent, entry.name));
}

function resolveExport(exports, subpath) {
  if (typeof exports === 'string') return subpath === '.' ? exports : null;
  const value = exports?.[subpath];
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return value.import ?? value.default ?? null;
  return null;
}
