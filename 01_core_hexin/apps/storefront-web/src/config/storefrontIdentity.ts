import {
  identityNodeForStorefrontHost,
  parseIdentityNodeRegistry,
  PRODUCTION_IDENTITY_NODE_REGISTRY_SOURCE,
  type IdentityNodeDefinition,
  type IdentityNodeRegistry,
} from '@shop/sdk/identity-node';

import { canonicalizeProductBrand } from '../domain/brand/productBrand';

export interface StorefrontPresentationIdentity {
  readonly mallName: string;
  readonly brandName: string;
}

export function hbbtznH5Application(hostname: string): string | undefined {
  const level = /^h([6-9]|\d\d+)\.hbbtzn\.com$/i.exec(hostname.trim())?.[1];
  return level && `h${Number(level)}`;
}

function currentStorefrontHostname(): string {
  if (typeof window !== 'undefined' && window.location?.hostname) return window.location.hostname;
  const configured = (process.env.SFL_STOREFRONT_HOSTNAME ?? process.env.NEXT_PUBLIC_STOREFRONT_HOSTNAME)?.trim();
  if (!configured) throw new Error('商城身份节点主机缺失');
  return configured;
}

export function storefrontIdentityNodeRegistry(
  source?: string,
): IdentityNodeRegistry {
  const selected = source?.trim()
    || browserRuntimeRegistrySource()
    || process.env.SFL_STOREFRONT_IDENTITY_NODE_REGISTRY?.trim()
    || process.env.NEXT_PUBLIC_IDENTITY_NODE_REGISTRY?.trim()
    || PRODUCTION_IDENTITY_NODE_REGISTRY_SOURCE;
  if (!selected) throw new Error('IDENTITY_NODE_REGISTRY_MISSING');
  return parseIdentityNodeRegistry(selected);
}

export function resolveStorefrontNode(
  hostname?: string,
  registry: IdentityNodeRegistry = storefrontIdentityNodeRegistry(),
): IdentityNodeDefinition {
  const selectedHostname = hostname ?? currentStorefrontHostname();
  const node = identityNodeForStorefrontHost(registry, selectedHostname)
    ?? (hbbtznH5Application(selectedHostname) === undefined
      ? null
      : identityNodeForStorefrontHost(registry, 'hbbtzn.com'));
  if (node === null) throw new Error('商城身份节点无效');
  return node;
}

export function resolveStorefrontApplication(
  hostname?: string,
  configured?: string,
  registry: IdentityNodeRegistry = storefrontIdentityNodeRegistry(),
): string {
  const node = resolveStorefrontNode(hostname, registry);
  const hostApplication = hbbtznH5Application(hostname ?? currentStorefrontHostname());
  const explicit = configured?.trim() || (browserRuntimeRegistrySource() ? undefined
    : (process.env.SFL_STOREFRONT_APPLICATION ?? process.env.NEXT_PUBLIC_STOREFRONT_APPLICATION)?.trim());
  if (hostApplication === undefined && explicit !== undefined && explicit !== '' && explicit !== node.consumerApplication) {
    throw new Error('商城身份节点无效');
  }
  return hostApplication ?? node.consumerApplication;
}

export function resolveStorefrontAuthTarget(
  application: string = resolveStorefrontApplication(),
  hostname?: string,
  registry: IdentityNodeRegistry = storefrontIdentityNodeRegistry(),
): string {
  const node = resolveStorefrontNode(hostname, registry);
  if (application !== resolveStorefrontApplication(hostname, undefined, registry)) throw new Error('商城身份节点无效');
  return node.consumerTarget;
}

/** Keep the host's visible identity stable while the member scope hydrates. */
export function resolveStorefrontPresentationIdentity(
  hostname: string = currentStorefrontHostname(),
  configured?: string,
  registry: IdentityNodeRegistry = storefrontIdentityNodeRegistry(),
): StorefrontPresentationIdentity {
  const node = resolveStorefrontNode(hostname, registry);
  resolveStorefrontApplication(hostname, configured, registry);
  return { mallName: canonicalizeProductBrand(node.mallName), brandName: canonicalizeProductBrand(node.brandName) };
}

function browserRuntimeRegistrySource(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const value = (window as Window & { __SFL_STOREFRONT_IDENTITY_NODE_REGISTRY__?: unknown })
    .__SFL_STOREFRONT_IDENTITY_NODE_REGISTRY__;
  return value === undefined ? undefined : JSON.stringify(value);
}
