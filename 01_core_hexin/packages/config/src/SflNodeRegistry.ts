import registryDeclaration from '../../../../02_platform_pingtai/config/sfl-node-registry.declaration.json' with { type: 'json' };

import type {
  DomainBindingRef,
  NodeManifestDeclaration,
  NodeManifestRegistryDeclaration,
  ResourceBindingSetRef,
} from '@shop/config/sfl-node-kernel';

export const SFL_NODE_REGISTRY_DECLARATION_SCHEMA_VERSION = 'sfl.node-registry-declaration.v1' as const;

export type SflIdentitySurface = 'admin' | 'consumer';
export type SflIdentityMembershipClient = 'operator' | 'storefront' | 'store' | 'supplier';
export type SflConsoleScopeKind = 'platform' | 'mall';

export interface SflIdentityTargetBinding {
  readonly surface: SflIdentitySurface;
  readonly target: string;
  readonly membership_client: SflIdentityMembershipClient;
  readonly membership_organization_id: string;
  readonly application: string | null;
  readonly return_binding_ref: string;
  readonly return_path: string;
}

export interface SflNodeResourceBinding {
  readonly node_id: string;
  readonly runtime_manifest_file: string;
  readonly display_name: string;
  readonly mall_name: string;
  readonly brand_name: string;
  readonly primary_storefront_binding_ref: string;
  readonly consumer_api_binding_ref: string;
  readonly purchase_origin_binding_refs: readonly string[];
  readonly identity_entry_binding_refs: readonly string[];
  readonly targets: readonly SflIdentityTargetBinding[];
  readonly console: Readonly<{
    api_binding_ref: string;
    identity_binding_ref: string;
    identity_target: string;
    scope_kind: SflConsoleScopeKind;
  }>;
}

export interface SflNodeRegistryDeclaration extends NodeManifestRegistryDeclaration {
  readonly schema_version: typeof SFL_NODE_REGISTRY_DECLARATION_SCHEMA_VERSION;
  readonly node_bindings: readonly SflNodeResourceBinding[];
}

export interface SflConsoleReleaseDeclaration extends NodeManifestRegistryDeclaration {
  readonly schema_version: 'sfl.console-release-declaration.v1';
  readonly runtime_bindings: readonly Readonly<{
    resource_binding_set_ref: ResourceBindingSetRef;
    api_base_url: string;
    identity_entry_url: string;
    scope_kind: SflConsoleScopeKind;
  }>[];
}

export const SFL_NODE_REGISTRY = validateRegistryDeclaration(
  registryDeclaration as unknown as SflNodeRegistryDeclaration,
);

export const SFL_NODE_MANIFEST_REGISTRY_DECLARATION: NodeManifestRegistryDeclaration = Object.freeze({
  registry_version: SFL_NODE_REGISTRY.registry_version,
  generated_at: SFL_NODE_REGISTRY.generated_at,
  manifests: SFL_NODE_REGISTRY.manifests,
});

export const SFL_CONSOLE_RELEASE_DECLARATION = consoleReleaseDeclarationOf(SFL_NODE_REGISTRY);

export function consoleReleaseDeclarationOf(registry: SflNodeRegistryDeclaration): SflConsoleReleaseDeclaration {
  return Object.freeze({
    schema_version: 'sfl.console-release-declaration.v1',
    registry_version: registry.registry_version,
    generated_at: registry.generated_at,
    manifests: registry.manifests,
    runtime_bindings: Object.freeze(registry.node_bindings.map((binding) => {
      const manifest = nodeManifestDeclaration(binding.node_id, registry);
      const api = nodeDomainBinding(binding.node_id, binding.console.api_binding_ref, registry);
      const identity = nodeDomainBinding(binding.node_id, binding.console.identity_binding_ref, registry);
      const identityEntry = new URL(`https://${identity.host}`);
      identityEntry.searchParams.set('target', binding.console.identity_target);
      return Object.freeze({
        resource_binding_set_ref: manifest.resource_binding_set_ref,
        api_base_url: `https://${api.host}`,
        identity_entry_url: identityEntry.toString(),
        scope_kind: binding.console.scope_kind,
      });
    })),
  });
}

export function nodeManifestDeclaration(
  nodeId: string,
  registry: SflNodeRegistryDeclaration = SFL_NODE_REGISTRY,
): NodeManifestDeclaration {
  const matches = registry.manifests.filter((manifest) => manifest.node_id === nodeId);
  if (matches.length !== 1) throw new Error(`SFL_NODE_DECLARATION_UNKNOWN:${nodeId}`);
  return matches[0]!;
}

export function nodeManifestDeclarationByManifestId(manifestId: string): NodeManifestDeclaration {
  const matches = SFL_NODE_REGISTRY.manifests.filter((manifest) => manifest.manifest_id === manifestId);
  if (matches.length !== 1) throw new Error(`SFL_NODE_MANIFEST_DECLARATION_UNKNOWN:${manifestId}`);
  return matches[0]!;
}

export function nodeResourceBinding(nodeId: string): SflNodeResourceBinding {
  const matches = SFL_NODE_REGISTRY.node_bindings.filter((binding) => binding.node_id === nodeId);
  if (matches.length !== 1) throw new Error(`SFL_NODE_RESOURCE_BINDING_UNKNOWN:${nodeId}`);
  return matches[0]!;
}

export function nodeDomainBinding(
  nodeId: string,
  bindingRef: string,
  registry: SflNodeRegistryDeclaration = SFL_NODE_REGISTRY,
): DomainBindingRef {
  const manifest = nodeManifestDeclaration(nodeId, registry);
  const matches = manifest.domain_bindings.filter((binding) => binding.binding_ref.ref === bindingRef);
  if (matches.length !== 1) throw new Error(`SFL_NODE_DOMAIN_BINDING_UNKNOWN:${nodeId}:${bindingRef}`);
  return matches[0]!;
}

export function nodeOriginForBinding(
  nodeId: string,
  bindingRef: string,
  registry: SflNodeRegistryDeclaration = SFL_NODE_REGISTRY,
): string {
  return `https://${nodeDomainBinding(nodeId, bindingRef, registry).host}`;
}

export function purchaseBrowserOrigins(): readonly string[] {
  return Object.freeze(SFL_NODE_REGISTRY.node_bindings.flatMap((binding) =>
    binding.purchase_origin_binding_refs.map((reference) => nodeOriginForBinding(binding.node_id, reference))));
}

function validateRegistryDeclaration(value: SflNodeRegistryDeclaration): SflNodeRegistryDeclaration {
  if (value.schema_version !== SFL_NODE_REGISTRY_DECLARATION_SCHEMA_VERSION
    || value.registry_version !== '1.6.1'
    || !Array.isArray(value.manifests)
    || value.manifests.length === 0
    || !Array.isArray(value.node_bindings)) {
    throw new Error('SFL_NODE_REGISTRY_DECLARATION_INVALID');
  }
  const manifestsByNode = new Map<string, NodeManifestDeclaration>(
    value.manifests.map((manifest: NodeManifestDeclaration) => [manifest.node_id, manifest]),
  );
  if (manifestsByNode.size !== value.manifests.length || value.node_bindings.length !== value.manifests.length) {
    throw new Error('SFL_NODE_REGISTRY_NODE_BINDING_MISMATCH');
  }
  const allHosts = value.manifests.flatMap((manifest: NodeManifestDeclaration) =>
    manifest.domain_bindings.map((binding: DomainBindingRef) => binding.host));
  unique(allHosts, 'SFL_NODE_REGISTRY_HOST_AMBIGUOUS');
  unique(value.manifests.map((manifest: NodeManifestDeclaration) => manifest.realm_ref.ref), 'SFL_NODE_REGISTRY_REALM_AMBIGUOUS');
  unique(value.node_bindings.map((binding: SflNodeResourceBinding) => binding.runtime_manifest_file), 'SFL_NODE_REGISTRY_RUNTIME_FILE_AMBIGUOUS');
  for (const binding of value.node_bindings) {
    const manifest = manifestsByNode.get(binding.node_id);
    if (manifest === undefined) throw new Error(`SFL_NODE_REGISTRY_NODE_BINDING_UNKNOWN:${binding.node_id}`);
    const domains = new Map<string, DomainBindingRef>(manifest.domain_bindings
      .map((domain: DomainBindingRef) => [domain.binding_ref.ref, domain]));
    const requireDomain = (reference: string, surface?: string): DomainBindingRef => {
      const domain = domains.get(reference);
      if (domain === undefined || (surface !== undefined && domain.surface_ref !== surface)) {
        throw new Error(`SFL_NODE_REGISTRY_DOMAIN_BINDING_INVALID:${binding.node_id}:${reference}`);
      }
      return domain;
    };
    requireDomain(binding.primary_storefront_binding_ref, 'surface:storefront');
    requireDomain(binding.consumer_api_binding_ref);
    if (!Array.isArray(binding.purchase_origin_binding_refs) || binding.purchase_origin_binding_refs.length === 0) {
      throw new Error(`SFL_NODE_REGISTRY_PURCHASE_ORIGINS_MISSING:${binding.node_id}`);
    }
    binding.purchase_origin_binding_refs.forEach((reference: string) => requireDomain(reference, 'surface:storefront'));
    unique(binding.purchase_origin_binding_refs, `SFL_NODE_REGISTRY_PURCHASE_ORIGIN_AMBIGUOUS:${binding.node_id}`);
    binding.identity_entry_binding_refs.forEach((reference: string) => requireDomain(reference));
    unique(binding.targets.map((target: SflIdentityTargetBinding) => target.target),
      `SFL_NODE_REGISTRY_IDENTITY_TARGET_AMBIGUOUS:${binding.node_id}`);
    binding.targets.forEach((target: SflIdentityTargetBinding) => {
      requireDomain(target.return_binding_ref);
      if (target.return_path !== '' && !target.return_path.startsWith('/')) {
        throw new Error(`SFL_NODE_REGISTRY_RETURN_PATH_INVALID:${target.target}`);
      }
    });
    requireDomain(binding.console.api_binding_ref, 'surface:api');
    requireDomain(binding.console.identity_binding_ref, 'surface:identity');
    if (!binding.targets.some((target: SflIdentityTargetBinding) =>
      target.target === binding.console.identity_target && target.surface === 'admin')) {
      throw new Error(`SFL_NODE_REGISTRY_CONSOLE_TARGET_INVALID:${binding.node_id}`);
    }
  }
  return Object.freeze(value);
}

function unique(values: readonly string[], code: string): void {
  if (new Set(values).size !== values.length) throw new Error(code);
}
