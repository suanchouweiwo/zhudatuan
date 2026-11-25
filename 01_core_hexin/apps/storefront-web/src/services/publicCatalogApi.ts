import { boolean, nonNegativeInteger, optionalText, pageItems, record, text } from './canonicalShape';
import { ProductionApiError } from './productionApi.error';
import type { ApiProduct } from './productionApi.types';

export type PublicCatalogOptions = { category?: string; cursor?: string; limit?: number; q?: string; signal?: AbortSignal };

declare global {
  interface Window {
    __SW_PUBLIC_CATALOG_RESPONSE__?: Promise<Response | null>;
  }
}

export async function listPublicProducts(options: PublicCatalogOptions = {}): Promise<{ items: ApiProduct[]; pagination: { nextCursor: string | null } }> {
  const query = new URLSearchParams({ limit: String(options.limit ?? 100) });
  if (options.cursor) query.set('cursor', options.cursor);
  if (options.category) query.set('category', options.category);
  if (options.q) query.set('q', options.q);
  const bootstrapResponse = takeBootstrapResponse(options);
  const response = await bootstrapResponse ?? await fetch(`/api/v1/catalog/public/products?${query}`, {
    method: 'GET',
    headers: { accept: 'application/json' },
    credentials: 'omit',
    redirect: 'error',
    signal: options.signal,
  });
  const value = await response.json().catch(() => null) as unknown;
  if (!response.ok) {
    const error = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const code = typeof error.code === 'string' ? error.code : 'PUBLIC_CATALOG_FAILED';
    throw new ProductionApiError('公开商品目录暂时不可用，请稍后重试', response.status, code, response.headers.get('x-request-id') ?? undefined);
  }
  const payload = record(value, 'catalog.public');
  const items = pageItems(payload, 'catalog.public').map(publicProduct);
  const pagination = record(payload.pagination, 'catalog.public.pagination');
  return { items, pagination: { nextCursor: typeof pagination.nextCursor === 'string' && pagination.nextCursor ? pagination.nextCursor : null } };
}

function takeBootstrapResponse(options: PublicCatalogOptions): Promise<Response | null> | null {
  if (typeof window === 'undefined' || options.cursor || options.category || options.q || (options.limit ?? 100) !== 100) return null;
  const response = window.__SW_PUBLIC_CATALOG_RESPONSE__ ?? null;
  delete window.__SW_PUBLIC_CATALOG_RESPONSE__;
  return response;
}

function publicProduct(item: Record<string, unknown>): ApiProduct {
  const qualification = record(item.qualification, 'catalog.public.qualification');
  return {
    id: text(item.id, 'catalog.public.id'),
    skuId: text(item.skuId, 'catalog.public.skuId'),
    name: text(item.name, 'catalog.public.name'),
    subtitle: optionalText(item.subtitle),
    categoryCode: text(item.categoryCode, 'catalog.public.categoryCode'),
    coverUrl: optionalText(item.coverUrl),
    priceCents: nonNegativeInteger(item.priceCents, 'catalog.public.priceCents'),
    marketPriceCents: item.marketPriceCents === null || item.marketPriceCents === undefined
      ? null : nonNegativeInteger(item.marketPriceCents, 'catalog.public.marketPriceCents'),
    availableStock: nonNegativeInteger(item.availableStock, 'catalog.public.availableStock'),
    supplierName: text(item.supplierName, 'catalog.public.supplierName'),
    isTest: boolean(item.isTest),
    purchasable: boolean(item.purchasable),
    qualification: {
      visible: boolean(qualification.visible),
      purchasable: boolean(qualification.purchasable),
      visibilityReason: text(qualification.visibilityReason, 'catalog.public.visibilityReason'),
      purchaseReason: text(qualification.purchaseReason, 'catalog.public.purchaseReason'),
    },
  };
}
