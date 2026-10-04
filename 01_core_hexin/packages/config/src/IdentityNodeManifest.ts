import {
  SFL_NODE_REGISTRY,
  nodeDomainBinding,
  nodeOriginForBinding,
  type SflIdentityMembershipClient,
  type SflIdentitySurface,
  type SflNodeRegistryDeclaration,
} from '@shop/config/sfl-node-registry';

export type IdentityNodeManifestProfile = 'operating_mall' | 'consumer';
export type IdentityNodeManifestEntryKind = 'accounts' | 'api' | 'storefront';
export type IdentityNodeManifestSurface = SflIdentitySurface;
export type IdentityNodeManifestMembershipClient = SflIdentityMembershipClient;

export interface IdentityNodeManifestEntry {
  readonly host: string;
  readonly kind: IdentityNodeManifestEntryKind;
  readonly status: 'active' | 'disabled';
}

export interface IdentityNodeManifestTarget {
  readonly surface: IdentityNodeManifestSurface;
  readonly target: string;
  readonly membershipClient: IdentityNodeManifestMembershipClient;
  readonly membershipOrganizationId: string;
  readonly application: string | null;
  readonly returnOrigin: string;
}

export interface IdentityNodeManifestNode {
  readonly nodeId: string;
  readonly realmId: string;
  readonly status: 'active' | 'disabled';
  readonly nodeProfile: IdentityNodeManifestProfile;
  readonly mallId: string | null;
  readonly hostNodeId: string | null;
  readonly displayName: string;
  readonly mallName: string;
  readonly brandName: string;
  readonly accountsOrigin: string;
  readonly apiOrigin: string;
  readonly consumerApiOrigin: string;
  readonly adminOrigin: string | null;
  readonly storefrontOrigin: string;
  readonly storefrontHosts: readonly string[];
  readonly entries: readonly IdentityNodeManifestEntry[];
  readonly targets: readonly IdentityNodeManifestTarget[];
}

export interface IdentityNodeManifest {
  readonly schema: 'sfl.identity-node-projection.v1';
  readonly revision: string;
  readonly version: 2;
  readonly allowedBrowserOrigins: readonly string[];
  readonly nodes: readonly IdentityNodeManifestNode[];
}

export const IDENTITY_NODE_MANIFEST: IdentityNodeManifest = identityNodeManifestProjection();

export function identityNodeManifestProjection(
  registry: SflNodeRegistryDeclaration = SFL_NODE_REGISTRY,
): IdentityNodeManifest {
  const nodes = registry.manifests.map((manifest) => {
    const resources = registry.node_bindings.find((binding) => binding.node_id === manifest.node_id);
    if (resources === undefined) throw new Error(`SFL_IDENTITY_RESOURCE_BINDING_MISSING:${manifest.node_id}`);
    const bySurface = (surface: string) => manifest.domain_bindings.filter((binding) => binding.surface_ref === surface);
    const primary = (surface: string) => {
      const bindings = bySurface(surface);
      if (bindings.length !== 1 && surface !== 'surface:storefront') {
        throw new Error(`SFL_IDENTITY_PRIMARY_DOMAIN_INVALID:${manifest.node_id}:${surface}`);
      }
      return bindings[0]!;
    };
    const storefront = nodeDomainBinding(manifest.node_id, resources.primary_storefront_binding_ref, registry);
    const entries = resources.identity_entry_binding_refs.map((reference) => {
      const domain = nodeDomainBinding(manifest.node_id, reference, registry);
      const kind = domain.surface_ref === 'surface:identity'
        ? 'accounts'
        : domain.surface_ref === 'surface:api' ? 'api' : domain.surface_ref === 'surface:storefront' ? 'storefront' : null;
      if (kind === null) throw new Error(`SFL_IDENTITY_ENTRY_SURFACE_INVALID:${manifest.node_id}:${reference}`);
      return Object.freeze({ host: domain.host, kind, status: 'active' as const });
    });
    const targets = resources.targets.map((target) => Object.freeze({
      surface: target.surface,
      target: target.target,
      membershipClient: target.membership_client,
      membershipOrganizationId: target.membership_organization_id,
      application: target.application,
      returnOrigin: `${nodeOriginForBinding(manifest.node_id, target.return_binding_ref, registry)}${target.return_path}`,
    }));
    return Object.freeze({
      nodeId: manifest.node_id,
      realmId: manifest.realm_ref.ref,
      status: manifest.lifecycle_status === 'active' ? 'active' as const : 'disabled' as const,
      nodeProfile: manifest.node_profile!,
      mallId: manifest.mall_id,
      hostNodeId: manifest.host_node_id,
      displayName: resources.display_name,
      mallName: resources.mall_name,
      brandName: resources.brand_name,
      accountsOrigin: `https://${primary('surface:identity').host}`,
      apiOrigin: `https://${primary('surface:api').host}`,
      consumerApiOrigin: nodeOriginForBinding(manifest.node_id, resources.consumer_api_binding_ref, registry),
      adminOrigin: manifest.node_profile === 'operating_mall' ? `https://${primary('surface:console').host}` : null,
      storefrontOrigin: `https://${storefront.host}`,
      storefrontHosts: Object.freeze(bySurface('surface:storefront').map((binding) => binding.host)),
      entries: Object.freeze(entries),
      targets: Object.freeze(targets),
    });
  });
  const allowedBrowserOrigins = registry.manifests.flatMap((manifest) => manifest.domain_bindings
    .filter((binding) => binding.surface_ref !== 'surface:api')
    .map((binding) => `https://${binding.host}`));
  return Object.freeze({
    schema: 'sfl.identity-node-projection.v1',
    revision: `sfl-node-registry:${registry.registry_version}`,
    version: 2,
    allowedBrowserOrigins: Object.freeze([...new Set(allowedBrowserOrigins)].sort()),
    nodes: Object.freeze(nodes),
  });
}
