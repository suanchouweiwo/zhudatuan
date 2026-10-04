import { configuredIdentityNodeRegistry } from './identityNodeEnvironment';

interface OriginPolicy {
  readonly allowLocalDevelopment: boolean;
  readonly canonicalOrigin: string;
  readonly configuredOrigin?: string;
  readonly deniedMessage: string;
  readonly invalidMessage: string;
  readonly stagingOrigin?: string;
}

export function resolveAdminLoginOrigin(configuredOrigin?: string, allowLocalDevelopment = false): string {
  const nodes = operatingNodes();
  return resolveCredentialTargetOrigin(
    configuredOrigin,
    nodes[0]!.adminOrigin,
    '后台',
    allowLocalDevelopment,
    nodes.slice(1).map((node) => node.adminOrigin),
  );
}

export function resolveStorefrontLoginOrigin(configuredOrigin?: string, allowLocalDevelopment = false): string {
  const nodes = operatingNodes();
  return resolveCredentialTargetOrigin(
    configuredOrigin,
    nodes[0]!.storefrontOrigin,
    '商城',
    allowLocalDevelopment,
    nodes.slice(1).map((node) => node.storefrontOrigin),
  );
}

export function resolveBuildTimeOrigin(policy: OriginPolicy): string {
  const canonical = exactHttpsOrigin(policy.canonicalOrigin, policy.invalidMessage);
  const staging = optionalStagingOrigin(policy.stagingOrigin, policy.invalidMessage);
  const selected = parseOrigin(policy.configuredOrigin?.trim() || canonical, policy.invalidMessage);
  const local = policy.allowLocalDevelopment
    && selected.protocol === 'http:'
    && (selected.hostname === '127.0.0.1' || selected.hostname === 'localhost');
  if (!originOnly(selected)) throw new Error(policy.invalidMessage);
  if (!local && selected.protocol !== 'https:') throw new Error(policy.deniedMessage);
  if (!local && selected.origin !== canonical && selected.origin !== staging) throw new Error(policy.deniedMessage);
  return selected.origin;
}

function resolveCredentialTargetOrigin(
  configuredOrigin: string | undefined,
  canonicalOrigin: string,
  targetLabel: string,
  allowLocalDevelopment: boolean,
  compatibleOrigins: readonly string[] = [],
): string {
  let parsed: URL;
  try {
    parsed = new URL(configuredOrigin?.trim() || canonicalOrigin);
  } catch {
    throw new Error(`${targetLabel}登录目标配置无效，已停止提交账号凭证`);
  }

  const isCanonical = parsed.origin === canonicalOrigin || compatibleOrigins.includes(parsed.origin);
  const isLocalDevelopment = allowLocalDevelopment
    && parsed.protocol === 'http:'
    && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost');
  if ((!isCanonical && !isLocalDevelopment) || parsed.username || parsed.password) {
    throw new Error(`${targetLabel}登录目标不在允许清单，已停止提交账号凭证`);
  }

  return parsed.origin;
}

function optionalStagingOrigin(value: string | undefined, message: string): string | undefined {
  const selected = value?.trim();
  return selected ? exactHttpsOrigin(selected, message) : undefined;
}

function exactHttpsOrigin(value: string, message: string): string {
  const parsed = parseOrigin(value, message);
  if (parsed.protocol !== 'https:' || !originOnly(parsed)) throw new Error(message);
  return parsed.origin;
}

function parseOrigin(value: string, message: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error(message);
  }
}

function originOnly(value: URL): boolean {
  return !value.username && !value.password && (value.pathname === '/' || value.pathname === '') && !value.search && !value.hash;
}

function operatingNodes() {
  const nodes = configuredIdentityNodeRegistry().nodes.filter((node) => node.nodeProfile === 'operating_mall');
  if (nodes.length === 0) throw new Error('IDENTITY_OPERATING_NODE_MISSING');
  return nodes;
}
