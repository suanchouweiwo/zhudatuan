import {
  PRODUCTION_IDENTITY_NODE_REGISTRY_SOURCE,
  parseIdentityNodeRegistry,
  type IdentityNodeRegistry,
} from '@shop/sdk/identity-node';

export interface AuthBuildEnvironment {
  readonly identityNodes: IdentityNodeRegistry;
  readonly identityNodeRegistrySource: string;
  readonly clientVersion: string;
}

export function validateAuthBuildEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  productionRegistrySource: string = PRODUCTION_IDENTITY_NODE_REGISTRY_SOURCE,
): AuthBuildEnvironment {
  const registrySource = source.VITE_IDENTITY_NODE_REGISTRY?.trim() || productionRegistrySource;
  const identityNodes = parseIdentityNodeRegistry(registrySource);
  if (identityNodes.nodes.some((node) => [node.accountsOrigin, node.apiOrigin, node.consumerApiOrigin,
    node.storefrontOrigin, ...(node.adminOrigin === null ? [] : [node.adminOrigin])]
    .some((origin) => !origin.startsWith('https://')))) {
    throw new Error('AUTH_CLIENT_IDENTITY_NODE_ORIGIN_INVALID');
  }
  const clientVersion = required(source.VITE_CLIENT_VERSION, 'AUTH_CLIENT_VERSION_MISSING');
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.]+)?$/i.test(clientVersion)) throw new Error('AUTH_CLIENT_VERSION_INVALID');
  const mode = source.VITE_IDENTITY_NODE_REGISTRY_MODE?.trim();
  if (mode !== undefined && mode !== '' && mode !== 'staging') throw new Error('AUTH_CLIENT_IDENTITY_NODE_MODE_INVALID');
  if (mode === 'staging') {
    if (!clientVersion.endsWith('-staging')) throw new Error('AUTH_CLIENT_IDENTITY_NODE_MODE_INVALID');
  } else if (JSON.stringify(identityNodes) !== productionRegistrySource) {
    throw new Error('AUTH_CLIENT_IDENTITY_NODE_MANIFEST_DRIFT');
  }
  return Object.freeze({ identityNodes, identityNodeRegistrySource: JSON.stringify(identityNodes), clientVersion });
}

function required(value: string | undefined, code: string): string {
  if (!value?.trim()) throw new Error(code);
  return value.trim();
}
