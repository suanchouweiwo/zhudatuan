import { randomUUID } from 'node:crypto';
import type { DatabasePool } from '../../foundation/persistence/Pool';

const PUBLIC_CATALOG_PATH = '/api/v1/catalog/public/products';

interface CatalogRow {
  readonly id: string;
  readonly sku_id: string;
  readonly sku_code?: string;
  readonly name: string;
  readonly subtitle: string | null;
  readonly product_type: string;
  readonly cover_url: string | null;
  readonly amount_minor: string | number | null;
  readonly compare_minor: string | number | null;
  readonly available_stock: string | number;
  readonly supplier_name: string;
  readonly is_test: boolean;
}

export interface HttpRequestHandler {
  handle(request: Request): Promise<Response>;
}

export class PublicCatalogHttpHandler implements HttpRequestHandler {
  private readonly origins: ReadonlySet<string>;

  constructor(
    private readonly next: HttpRequestHandler,
    private readonly pool: DatabasePool,
    private readonly defaultApplicationSlug: string,
    allowedOrigins: readonly string[],
    private readonly applicationSlugByHost: Readonly<Record<string, string>> = {},
  ) {
    this.origins = new Set(allowedOrigins);
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== 'GET' || url.pathname !== PUBLIC_CATALOG_PATH) return this.next.handle(request);

    const requestId = request.headers.get('x-request-id') ?? randomUUID();
    const origin = request.headers.get('origin');
    if (origin && !this.origins.has(origin)) return response(403, { code: 'ORIGIN_DENIED', requestId }, requestId);
    const hostApplicationSlug = hbbtznH5Application(url.hostname)
      ?? this.applicationSlugByHost[url.hostname.toLowerCase()];
    const selectedApplicationSlug = hostApplicationSlug ?? this.defaultApplicationSlug;
    const requestedApplicationSlug = url.searchParams.get('mall')?.trim();
    const applicationSlug = requestedApplicationSlug || selectedApplicationSlug;
    if (!validPublicSlug(applicationSlug)) {
      return response(400, { code: 'PUBLIC_MALL_INVALID', requestId }, requestId, origin);
    }
    if (requestedApplicationSlug && requestedApplicationSlug !== selectedApplicationSlug) {
      return response(404, { code: 'PUBLIC_MALL_NOT_FOUND', requestId }, requestId, origin);
    }
    const limit = integer(url.searchParams.get('limit'), 24, 1, 100);
    const offset = integer(url.searchParams.get('cursor'), 0, 0, Number.MAX_SAFE_INTEGER);
    if (limit === null || offset === null) return response(400, { code: 'PAGINATION_INVALID', requestId }, requestId, origin);
    const category = url.searchParams.get('category')?.trim() || null;

    const searchQuery = url.searchParams.get('q')?.normalize('NFKC').trim();
    const database = this.pool.workload('query');
    const result = searchQuery
      ? await database.query<CatalogRow>(
        'select * from catalog.search_public_storefront_catalog($1,$2,$3,$4,$5)',
        [applicationSlug, limit, offset, category, searchQuery],
      )
      : await database.query<CatalogRow>(
        'select * from catalog.public_storefront_catalog($1,$2,$3,$4)',
        [applicationSlug, limit, offset, category],
      );
    const items = result.rows.map((row) => product(row));
    return response(200, {
      items,
      access: { mode: 'public', memberPricing: false, purchaseQualification: false },
      pagination: { nextCursor: items.length === limit ? String(offset + items.length) : null },
    }, requestId, origin, 'public, max-age=30');
  }
}

function hbbtznH5Application(hostname: string): string | undefined {
  const match = /^h([0-9]+)\.hbbtzn\.com$/i.exec(hostname.trim());
  if (!match || Number(match[1]) < 6) return undefined;
  return `h${Number(match[1])}`;
}

function validPublicSlug(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{2,47}$/.test(value) || /^h[0-9]+$/.test(value);
}

function product(row: CatalogRow) {
  const price = nonNegative(row.amount_minor);
  const stock = nonNegative(row.available_stock) ?? 0;
  return {
    id: row.id,
    skuId: row.sku_id,
    ...(row.sku_code ? { skuCode: row.sku_code } : {}),
    name: row.name,
    subtitle: row.subtitle,
    categoryCode: row.product_type === 'virtual' || row.product_type === 'voucher' ? 'virtual-card'
      : row.product_type === 'service' ? 'life' : 'welfare',
    coverUrl: row.cover_url,
    priceCents: price ?? 0,
    marketPriceCents: nonNegative(row.compare_minor),
    availableStock: stock,
    supplierName: row.supplier_name,
    isTest: row.is_test,
    purchasable: false,
    qualification: {
      visible: true,
      purchasable: false,
      visibilityReason: 'PUBLIC_CATALOG',
      purchaseReason: price === null ? 'PRICE_UNAVAILABLE' : stock === 0 ? 'OUT_OF_STOCK' : 'LOGIN_REQUIRED',
    },
  };
}

function integer(value: string | null, fallback: number, minimum: number, maximum: number): number | null {
  const candidate = value === null || value === '' ? fallback : Number(value);
  return Number.isSafeInteger(candidate) && candidate >= minimum && candidate <= maximum ? candidate : null;
}

function nonNegative(value: string | number | null): number | null {
  if (value === null || value === '') return null;
  const candidate = Number(value);
  return Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : null;
}

function response(status: number, body: unknown, requestId: string, origin?: string | null, cacheControl = 'no-store'): Response {
  return new Response(JSON.stringify(body), { status, headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': cacheControl,
    'x-request-id': requestId,
    'x-content-type-options': 'nosniff',
    ...(origin ? { 'access-control-allow-origin': origin, vary: 'origin' } : {}),
  } });
}
