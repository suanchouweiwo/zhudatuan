import {
  normalizeConsoleClientVersion,
  parseSflConsoleArtifact,
  parseSflConsoleNodeRuntime,
  resolveConsoleAppConfig,
  resolveConsoleNodeRuntimeConfig,
  type ConsoleAppConfig,
  type ConsoleRuntimeBinding,
} from '@shop/config/sfl-console-runtime';
import {
  generateNodeManifest,
  nodeContextOf,
  resolveNodeDomainBindingByHost,
  type NodeManifest,
  type NodeManifestSpec,
} from '@shop/config/sfl-node-kernel';

declare const __LK_INSTANCE_NODE_MANIFEST__: NodeManifest | undefined;
declare const __LK_INSTANCE_CONSOLE_RUNTIME_BINDINGS__: readonly ConsoleRuntimeBinding[] | undefined;

let installedConfig: ConsoleAppConfig | undefined;
let loadingConfig: Promise<ConsoleAppConfig> | undefined;

export function loadConsoleRuntimeConfig(): Promise<ConsoleAppConfig> {
  if (installedConfig !== undefined) return Promise.resolve(installedConfig);
  const hostname = browserHostname();
  loadingConfig ??= isLocalHostname(hostname)
    ? loadLocalConfig(hostname)
    : loadProductionConfig(hostname);
  return loadingConfig;
}

export function requireConsoleRuntimeConfig(): ConsoleAppConfig {
  if (installedConfig === undefined) throw new Error('CONSOLE_RUNTIME_CONFIG_NOT_READY');
  return installedConfig;
}

export async function loadProductionConfig(hostname: string, fetcher: typeof fetch = fetch): Promise<ConsoleAppConfig> {
  const request = {
    cache: 'no-store',
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
    redirect: 'error',
  } as const;
  // Most static deployments serve the SPA document for an absent runtime file.
  // Start the immutable artifact fallback immediately so that compatibility
  // detection never turns into a serial network wait.
  const nodeResponsePromise = fetcher('/console-runtime.json', request);
  const artifactResponsePromise = fetcher('/console-build.json', request);
  const nodeResponse = await nodeResponsePromise;
  const contentType = nodeResponse.headers.get('content-type')?.toLowerCase() ?? '';
  if (nodeResponse.ok && contentType.includes('json')) {
    void artifactResponsePromise.catch(() => undefined);
    const runtime = await parseSflConsoleNodeRuntime(await nodeResponse.json());
    return install(resolveConsoleNodeRuntimeConfig(runtime, hostname));
  }
  if (!nodeResponse.ok && nodeResponse.status !== 404) {
    void artifactResponsePromise.catch(() => undefined);
    throw new Error(`CONSOLE_NODE_RUNTIME_CONFIG_HTTP_${nodeResponse.status}`);
  }
  const response = await artifactResponsePromise;
  if (!response.ok) throw new Error(`CONSOLE_RUNTIME_CONFIG_HTTP_${response.status}`);
  const artifact = await parseSflConsoleArtifact(await response.json());
  return install(resolveConsoleAppConfig(artifact, hostname));
}

async function loadLocalConfig(hostname: string): Promise<ConsoleAppConfig> {
  const consoleOrigin = browserOrigin(hostname);
  const instanceManifest = typeof __LK_INSTANCE_NODE_MANIFEST__ === 'undefined'
    ? undefined
    : __LK_INSTANCE_NODE_MANIFEST__;
  const instanceBindings = typeof __LK_INSTANCE_CONSOLE_RUNTIME_BINDINGS__ === 'undefined'
    ? undefined : __LK_INSTANCE_CONSOLE_RUNTIME_BINDINGS__;
  const instanceRuntime = instanceBindings?.find((binding) =>
    binding.resource_binding_set_ref.ref === instanceManifest?.resource_binding_set_ref.ref
      && binding.resource_binding_set_ref.version === instanceManifest?.resource_binding_set_ref.version);
  const identityOrigin = instanceManifest === undefined
    ? 'http://127.0.0.1:3002'
    : import.meta.env.VITE_AUTH_BASE_URL?.trim()
      || (instanceRuntime === undefined ? 'http://127.0.0.1:3002' : new URL(instanceRuntime.identity_entry_url).origin);
  const identityEntry = new URL(instanceRuntime?.identity_entry_url ?? `${identityOrigin}/?target=console`);
  const configuredIdentity = new URL(identityOrigin);
  identityEntry.protocol = configuredIdentity.protocol;
  identityEntry.host = configuredIdentity.host;
  const immutableArtifactDigest = `sha256:${'0'.repeat(64)}` as const;
  const defaultManifestSpec: NodeManifestSpec = {
    manifest_id: 'manifest:local-development:console',
    manifest_revision: 0,
    generated_at: '2026-09-08T00:00:00.000Z',
    lifecycle_status: 'provisioning',
    line_id: 'line:local-development',
    node_id: 'node:local-development:l0',
    parent_node_id: null,
    signed_level: 'L0',
    node_profile: 'operating_mall',
    mall_id: 'mall:local-development',
    host_node_id: null,
    domain_bindings: [{
      host: hostname,
      binding_ref: { ref: 'domain:local-development:console', version: '1' },
      application_ref: 'application:console',
      surface_ref: 'surface:console',
    }],
    brand_ref: { ref: 'brand:local-development', version: '1' },
    applications: [{ ref: 'application:console', version: '1' }],
    surfaces: [{ ref: 'surface:console', version: '1' }],
    enabled_features: [{ ref: 'feature:console', version: '1' }],
    api_contract_refs: [{ ref: 'contract:commerce-api', version: '1.0.0' }],
    realm_ref: { ref: 'realm:local-development', version: '1' },
    data_scope_ref: { ref: 'organization-platform-root', version: '1' },
    resource_binding_set_ref: { ref: 'resource-binding:local-development:console', version: '1' },
    secret_binding_set_ref: { ref: 'secret-binding:local-development', version: '1' },
    payment_binding_refs: [],
    callback_binding_refs: [],
    runtime_instance_id: 'runtime:local-development:console',
    runtime_config_ref: { ref: 'runtime-config:local-development:console', version: '1' },
    release_pointer_ref: {
      ref: 'release:local-development:console',
      version: '1',
      source_sha: '0'.repeat(40),
      build_id: 'local-development',
      build_count: 1,
      immutable_artifact_digest: immutableArtifactDigest,
    },
  };
  const nodeManifest = await generateNodeManifest(instanceManifest === undefined ? defaultManifestSpec : {
    ...instanceManifest,
    manifest_revision: Number(instanceManifest.manifest_version.split('.')[2]),
    domain_bindings: instanceManifest.domain_bindings.map((binding) => binding.surface_ref === 'surface:console'
      ? { ...binding, host: hostname }
      : binding),
    release_pointer_ref: {
      ...defaultManifestSpec.release_pointer_ref,
      ref: instanceManifest.release_pointer_ref.ref,
      version: instanceManifest.release_pointer_ref.version,
    },
  });
  return install(Object.freeze({
    apiBaseUrl: consoleOrigin,
    identityOrigin,
    identityEntryUrl: identityEntry.toString(),
    consoleOrigin,
    clientVersion: normalizeConsoleClientVersion(import.meta.env.VITE_CLIENT_VERSION),
    scope: Object.freeze({
      kind: instanceRuntime?.scope_kind ?? (nodeManifest.signed_level === 'L0' ? 'platform' : 'mall'),
      id: nodeManifest.data_scope_ref.ref,
    }),
    nodeManifest,
    nodeContext: nodeContextOf(nodeManifest),
    domainBinding: resolveNodeDomainBindingByHost(nodeManifest, hostname),
    sourceSha: nodeManifest.release_pointer_ref.source_sha,
    buildId: nodeManifest.release_pointer_ref.build_id,
    buildCount: 1,
    immutableArtifactDigest,
  }));
}

function install(config: ConsoleAppConfig): ConsoleAppConfig {
  installedConfig = config;
  return config;
}

function browserHostname(): string {
  return typeof window === 'undefined' ? 'localhost' : window.location.hostname.toLowerCase();
}

function browserOrigin(hostname: string): string {
  if (typeof window !== 'undefined' && window.location.origin !== 'null') return window.location.origin;
  return `http://${hostname}`;
}

function isLocalHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1';
}
