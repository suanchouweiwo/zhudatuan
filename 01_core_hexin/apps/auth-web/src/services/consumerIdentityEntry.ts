import type { IdentityNodeDefinition, IdentityNodeRegistry } from '@shop/sdk/identity-node';
import { configuredIdentityNode, configuredIdentityNodeRegistry } from './identityNodeEnvironment';
export interface ConsumerIdentityEntry {
  readonly application: string;
  readonly target: string;
}

export type IdentityEntry =
  | Readonly<{
      kind: 'consumer';
      nodeId: string;
      application: string;
      target: string;
      storefrontOrigin: string;
      adminTarget: string;
    }>
  | Readonly<{
      kind: 'operator';
      nodeId: string;
      target: string;
      adminOrigin: string;
      displayName: string;
      consumerApplication: string;
      consumerTarget: string;
    }>;

export function resolveConsumerIdentityEntry(
  search: string,
  node: IdentityNodeDefinition,
): ConsumerIdentityEntry | null {
  const params = new URLSearchParams(search);
  if (params.get('application')?.trim() !== node.consumerApplication) return null;
  const target = params.get('target')?.trim();
  if (target !== node.consumerTarget && target !== `${node.nodeId}:${node.consumerTarget}`) return null;
  return Object.freeze({ application: node.consumerApplication, target: node.consumerTarget });
}

export function resolveIdentityEntry(
  search: string,
  hostname: string,
  registry: IdentityNodeRegistry = configuredIdentityNodeRegistry(),
): IdentityEntry | null {
  const node = configuredIdentityNode(hostname, registry);
  if (node === null) return null;

  const consumer = resolveConsumerIdentityEntry(search, node);
  if (consumer !== null) {
    return Object.freeze({
      kind: 'consumer', nodeId: node.nodeId, ...consumer, storefrontOrigin: node.storefrontOrigin,
      adminTarget: node.adminTarget,
    });
  }

  const params = new URLSearchParams(search);
  const target = params.get('target')?.trim() ?? '';
  const client = params.get('client')?.trim() ?? '';
  const application = params.get('application')?.trim() ?? '';
  const adminOrigin = params.get('admin_origin')?.trim() ?? '';
  const consumerIntent = application !== '' || params.get('surface') === 'web'
    || registry.nodes.some((candidate) => candidate.consumerTarget === target
      || `${candidate.nodeId}:${candidate.consumerTarget}` === target);
  if (consumerIntent) return null;
  if (node.nodeProfile !== 'operating_mall') return null;
  if ((target && target !== node.adminTarget && target !== `${node.nodeId}:${node.adminTarget}`)
    || (client && client !== node.adminTarget)
    || (adminOrigin && adminOrigin !== node.adminOrigin)) return null;
  return Object.freeze({
    kind: 'operator', nodeId: node.nodeId, target: node.adminTarget,
    adminOrigin: node.adminOrigin, displayName: node.displayName,
    consumerApplication: node.consumerApplication, consumerTarget: node.consumerTarget,
  });
}
