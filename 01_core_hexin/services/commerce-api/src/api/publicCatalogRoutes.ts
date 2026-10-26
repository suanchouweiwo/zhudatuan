import { apiError, json, methodNotAllowed } from './http';
import { readCoreProjection, writeCoreProjection, type CoreProjectionMetadata } from './coreReadCache';
import { publicCatalogCoverUrl } from './publicCatalogImages';
import { callRpc } from './postgresRpc';
import type { WorkerEnv } from './types';

interface PublicCatalogRow {
  id: string;
  sku_id: string;
  name: string;
  name_en: string | null;
  name_zh: string | null;
  subtitle: string | null;
  subtitle_en: string | null;
  subtitle_zh: string | null;
  category_code: string;
  taxonomy_l1: string | null;
  taxonomy_l2: string | null;
  taxonomy_l3: string | null;
  classification_status: string;
  cover_url: string | null;
  price_cents: number;
  market_price_cents: number | null;
  available_stock: number;
  supplier_name: string;
  is_test: boolean;
}

const DEFAULT_PUBLIC_MALL_SLUG = 'smart-wing-demo';
const MALL_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;
const CATALOG_CACHE_TTL_MS = 60_000;
const SHARED_CACHE_FRESH_SECONDS = 5 * 60;
const SHARED_CACHE_STALE_SECONDS = 24 * 60 * 60;
const CATALOG_CACHE_MAX_ENTRIES = 32;
const CATALOG_RPC_PAGE_SIZE = 100;
const DEFAULT_PUBLIC_BATCH_SIZE = 24;

interface CatalogProjection extends CoreProjectionMetadata {
  rows: PublicCatalogRow[];
  storedAt: number;
}

interface CatalogResult {
  projection: CatalogProjection;
  hit: boolean;
  tier: 'memory' | 'shared' | 'stale' | 'source';
}

const catalogCache = new Map<string, { projection: CatalogProjection; expiresAt: number }>();
const catalogRefreshes = new Map<string, Promise<CatalogProjection>>();

export function clearPublicCatalogCache(): void {
  catalogCache.clear();
  catalogRefreshes.clear();
}

async function queryCatalogRows(env: WorkerEnv, mallSlug: string, category: string | null, limit: number, cursor: number): Promise<PublicCatalogRow[]> {
  const rows: PublicCatalogRow[] = [];
  while (rows.length < limit) {
    const pageLimit = Math.min(CATALOG_RPC_PAGE_SIZE, limit - rows.length);
    const rpcName = category ? 'api_catalog' : 'api_public_catalog_window';
    const args = category ? { p_mall_slug: mallSlug, p_category: category, p_limit: pageLimit, p_offset: cursor + rows.length } : { p_mall_slug: mallSlug, p_limit: pageLimit, p_offset: cursor + rows.length };
    const page = await callRpc<PublicCatalogRow[]>(env, rpcName, args);
    rows.push(...page);
    if (page.length < pageLimit) break;
  }
  return rows;
}

async function cachedCatalogRows(env: WorkerEnv, mallSlug: string, category: string | null, limit: number, cursor: number): Promise<CatalogResult> {
  const key = [env.DATABASE_URL, mallSlug, category ?? '', limit, cursor].join('|');
  const now = Date.now();
  const cached = catalogCache.get(key);
  if (cached && cached.expiresAt > now) return { projection: cached.projection, hit: true, tier: 'memory' };
  if (cached) catalogCache.delete(key);
  const sharedKey = await catalogSharedKey(mallSlug, category, limit, cursor);
  const shared = await readCoreProjection<PublicCatalogRow[]>(env, sharedKey);
  if ((shared.status === 'fresh' || shared.status === 'stale') && Array.isArray(shared.data)) {
    const projection: CatalogProjection = { rows: shared.data, storedAt: shared.storedAt, projectionVersion: shared.projectionVersion, sourceCursor: shared.sourceCursor, contentHash: shared.contentHash, generatedAt: shared.generatedAt };
    rememberRows(key, projection, shared.status === 'fresh' ? CATALOG_CACHE_TTL_MS : 5_000);
    if (shared.status === 'stale') void refreshCatalogRows(env, key, sharedKey, mallSlug, category, limit, cursor).catch(reportRefreshFailure);
    return { projection, hit: true, tier: shared.status === 'fresh' ? 'shared' : 'stale' };
  }
  const projection = await refreshCatalogRows(env, key, sharedKey, mallSlug, category, limit, cursor);
  return { projection, hit: false, tier: 'source' };
}

async function refreshCatalogRows(env: WorkerEnv, localKey: string, sharedKey: string, mallSlug: string, category: string | null, limit: number, cursor: number): Promise<CatalogProjection> {
  const active = catalogRefreshes.get(localKey);
  if (active) return active;
  const refresh = queryCatalogRows(env, mallSlug, category, limit, cursor)
    .then(async (rows) => {
      const projection = await createCatalogProjection(rows, cursor, limit);
      rememberRows(localKey, projection, CATALOG_CACHE_TTL_MS);
      void writeCoreProjection(env, sharedKey, rows, jitterSeconds(SHARED_CACHE_FRESH_SECONDS), SHARED_CACHE_STALE_SECONDS, projection);
      return projection;
    })
    .finally(() => catalogRefreshes.delete(localKey));
  catalogRefreshes.set(localKey, refresh);
  return refresh;
}

function jitterSeconds(base: number): number {
  return Math.max(1, Math.round(base * (0.9 + Math.random() * 0.2)));
}

function rememberRows(key: string, projection: CatalogProjection, ttlMs: number): void {
  if (catalogCache.size >= CATALOG_CACHE_MAX_ENTRIES) {
    const oldest = catalogCache.keys().next().value;
    if (oldest) catalogCache.delete(oldest);
  }
  catalogCache.set(key, { projection, expiresAt: Date.now() + ttlMs });
}

async function catalogSharedKey(mallSlug: string, category: string | null, limit: number, cursor: number): Promise<string> {
  const canonical = JSON.stringify({ mallSlug, category: category ?? '', limit, cursor });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  const shortHash = Array.from(new Uint8Array(digest).slice(0, 12), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `sw:v2:catalog:public:${mallSlug}:${shortHash}`;
}

async function createCatalogProjection(rows: PublicCatalogRow[], cursor: number, limit: number): Promise<CatalogProjection> {
  const storedAt = Date.now();
  const contentHash = await hashJson(rows);
  return {
    rows,
    storedAt,
    projectionVersion: `catalog.${contentHash.slice(7, 31)}`,
    sourceCursor: `cursor:${cursor}:limit:${limit}:items:${rows.length}`,
    contentHash,
    generatedAt: new Date(storedAt).toISOString(),
  };
}

async function hashJson(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function reportRefreshFailure(error: unknown): void {
  console.error(JSON.stringify({ level: 'error', event: 'catalog_cache_refresh_failed', message: error instanceof Error ? error.message : 'unknown' }));
}

/** Public browsing returns the same active SKU rows as the main Shop.
 * Membership-specific visibility, prices and purchase qualification stay on
 * the authenticated /products endpoint and are never inferred here.
 */
export async function handlePublicCatalog(request: Request, env: WorkerEnv, requestId: string): Promise<Response> {
  const startedAt = Date.now();
  if (request.method !== 'GET') return methodNotAllowed(['GET'], requestId);
  const url = new URL(request.url);
  const configuredMallSlug = env.PUBLIC_MALL_SLUG?.trim();
  if (env.APP_ENV === 'production' && !configuredMallSlug) return apiError(503, 'PUBLIC_CATALOG_NOT_CONFIGURED', '公开商城目录尚未正确配置', requestId);
  const mallSlug = configuredMallSlug || DEFAULT_PUBLIC_MALL_SLUG;
  if (!MALL_SLUG_PATTERN.test(mallSlug)) return apiError(503, 'PUBLIC_CATALOG_NOT_CONFIGURED', '公开商城目录尚未正确配置', requestId);
  const category = url.searchParams.get('category')?.slice(0, 80) ?? null;
  const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get('limit') ?? String(DEFAULT_PUBLIC_BATCH_SIZE), 10) || DEFAULT_PUBLIC_BATCH_SIZE, 1), 200);
  const cursor = Math.max(Number.parseInt(url.searchParams.get('cursor') ?? '0', 10) || 0, 0);
  const catalog = await cachedCatalogRows(env, mallSlug, category, limit, cursor);
  const rows = catalog.projection.rows;

  const items = await Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      skuId: row.sku_id,
      name: row.name,
      nameEn: row.name_en,
      nameZh: row.name_zh,
      subtitle: row.subtitle,
      subtitleEn: row.subtitle_en,
      subtitleZh: row.subtitle_zh,
      categoryCode: row.category_code,
      taxonomy: {
        l1: row.taxonomy_l1,
        l2: row.taxonomy_l2,
        l3: row.taxonomy_l3,
        status: row.classification_status,
      },
      coverUrl: await publicCatalogCoverUrl(request, env, row.id, row.cover_url),
      priceCents: Number(row.price_cents),
      marketPriceCents: row.market_price_cents === null ? null : Number(row.market_price_cents),
      availableStock: row.available_stock,
      supplierName: row.supplier_name,
      isTest: row.is_test,
      purchasable: false,
      qualification: {
        visible: true,
        purchasable: false,
        visibilityReason: 'PUBLIC_CATALOG',
        purchaseReason: 'LOGIN_REQUIRED',
      },
    }))
  );
  const contentHash = await hashJson(items);
  const catalogVersion = `catalog.${contentHash.slice(7, 31)}`;
  const etag = `"${catalogVersion}"`;
  const mirror = {
    schemaVersion: 2,
    catalogVersion,
    sourceCursor: catalog.projection.sourceCursor,
    contentHash,
    generatedAt: catalog.projection.generatedAt,
  };
  if (etagMatches(request.headers.get('if-none-match'), etag)) {
    return catalogResponseHeaders(new Response(null, { status: 304 }), catalog, etag, catalogVersion, Date.now() - startedAt);
  }
  const response = json({
    items,
    mirror,
    access: { mode: 'public', memberPricing: false, purchaseQualification: false },
    pagination: {
      cursor,
      nextCursor: rows.length === limit ? cursor + limit : null,
      limit,
    },
    requestId,
  });
  return catalogResponseHeaders(response, catalog, etag, catalogVersion, Date.now() - startedAt);
}

function catalogResponseHeaders(response: Response, catalog: CatalogResult, etag: string, catalogVersion: string, durationMs: number): Response {
  response.headers.set('cache-control', 'public, max-age=60, stale-while-revalidate=300');
  response.headers.set('etag', etag);
  response.headers.set('x-sw-catalog-version', catalogVersion);
  response.headers.set('x-sw-catalog-cache', catalog.hit ? 'hit' : 'miss');
  response.headers.set('x-sw-catalog-cache-tier', catalog.tier);
  response.headers.set('server-timing', `catalog;dur=${Math.max(0, durationMs)}`);
  return response;
}

function etagMatches(raw: string | null, etag: string): boolean {
  if (!raw) return false;
  return raw.split(',').some((candidate) => candidate.trim().replace(/^W\//, '') === etag || candidate.trim() === '*');
}
