import * as z from 'zod/mini';
import { DatabaseIntegerSchema } from '../../shared/schema/DatabaseInteger';

export const ProductFilterSchema = z.object({
  q: z.string().check(z.trim(), z.maxLength(200)),
  category: z.string().check(z.trim(), z.maxLength(200)),
  supplier: z.string().check(z.trim(), z.maxLength(200)),
  mall: z.string().check(z.trim(), z.maxLength(200)),
  status: z.string().check(z.trim(), z.maxLength(40)),
});

const ProductPreviewMallSchema = z.object({
  id: z.string().check(z.minLength(1)),
  name: z.string().check(z.minLength(1)),
  status: z.string().check(z.minLength(1)),
  priceCents: z.optional(z.nullable(DatabaseIntegerSchema)),
});

const ProductPreviewChangeSchema = z.object({
  id: z.string().check(z.minLength(1)),
  at: z.string().check(z.minLength(1)),
  title: z.string().check(z.minLength(1)),
  actor: z.string().check(z.minLength(1)),
  operationId: z.string().check(z.minLength(1)),
  outcome: z.string().check(z.minLength(1)),
});

const ProductPreviewBlockerSchema = z.object({
  code: z.string().check(z.minLength(1)),
  title: z.string().check(z.minLength(1)),
  description: z.string().check(z.minLength(1)),
  actionLabel: z.string().check(z.minLength(1)),
});

const ProductListingPreviewSchema = z.object({
  kind: z.string().check(z.minLength(1)),
  spu: z.string().check(z.minLength(1)),
  barcode: z.string().check(z.minLength(1)),
  categoryId: z.string().check(z.minLength(1)),
  categoryName: z.string().check(z.minLength(1)),
  supplier: z.object({ id: z.string().check(z.minLength(1)), name: z.string().check(z.minLength(1)) }),
  skuCount: z.int().check(z.nonnegative()),
  skuTotal: z.int().check(z.nonnegative()),
  mallCount: z.int().check(z.nonnegative()),
  mallTotal: z.int().check(z.nonnegative()),
  priceCents: z.nullable(DatabaseIntegerSchema),
  inventory: z.nullable(DatabaseIntegerSchema),
  lastSyncedAt: z.string().check(z.minLength(1)),
  operationId: z.string().check(z.minLength(1)),
  tone: z.string().check(z.minLength(1)),
  blocker: z.optional(z.nullable(ProductPreviewBlockerSchema)),
  malls: z.array(ProductPreviewMallSchema),
  changes: z.array(ProductPreviewChangeSchema),
});

export const ProductSelectionPreviewSchema = z.object({
  kind: z.literal('selection-center-v1'),
  categoryId: z.nullable(z.string()),
  categoryName: z.string().check(z.minLength(1)),
  supplierId: z.nullable(z.string()),
  supplierName: z.string().check(z.minLength(1)),
  brandId: z.nullable(z.string()),
  brandName: z.string().check(z.minLength(1)),
  sourceChannel: z.string().check(z.minLength(1)),
  supplyPriceMinor: z.nullable(DatabaseIntegerSchema),
  suggestedRetailMinor: z.nullable(DatabaseIntegerSchema),
  availableStock: z.nullable(DatabaseIntegerSchema),
  marketSales30d: z.optional(z.nullable(DatabaseIntegerSchema)),
  peerLowestPriceMinor: z.optional(z.nullable(DatabaseIntegerSchema)),
  mallSales30d: z.optional(z.nullable(DatabaseIntegerSchema)),
  clickThroughRateBps: z.optional(z.nullable(DatabaseIntegerSchema)),
  recommendationScore: z.optional(z.nullable(DatabaseIntegerSchema)),
  salesGrowthBps: z.optional(z.nullable(DatabaseIntegerSchema)),
  selected: z.boolean(),
});

export const ProductManagementStatusSchema = z.enum(['needs_attention', 'pending_review', 'published', 'unpublished']);

export const ListingSchema = z.object({
  id: z.string().check(z.minLength(1)),
  sku_id: z.string().check(z.minLength(1)),
  product_id: z.string().check(z.minLength(1)),
  title: z.string().check(z.minLength(1)),
  status: z.string().check(z.minLength(1)),
  version: DatabaseIntegerSchema,
  code: z.optional(z.nullable(z.string())),
  pool_id: z.optional(z.nullable(z.string())),
  product_type: z.optional(z.nullable(z.string())),
  subtitle: z.optional(z.nullable(z.string())),
  cover_url: z.optional(z.nullable(z.string())),
  effective_at: z.optional(z.nullable(z.string())),
  expires_at: z.optional(z.nullable(z.string())),
  cursor_sort: z.optional(z.string()),
  sku_count: z.optional(DatabaseIntegerSchema),
  management_status: z.optional(ProductManagementStatusSchema),
  preview: z.optional(ProductListingPreviewSchema),
  selection: z.optional(ProductSelectionPreviewSchema),
});

export const ProductSelectionReceiptSchema = z.object({
  action: z.literal('select'),
  count: DatabaseIntegerSchema,
  items: z.array(z.object({
    id: z.string().check(z.minLength(1)),
    status: z.string().check(z.minLength(1)),
    version: DatabaseIntegerSchema,
  })),
});

export const ListingPublicationReceiptSchema = z.object({
  id: z.string().check(z.minLength(1)),
  status: z.string().check(z.minLength(1)),
  version: DatabaseIntegerSchema,
});

export const ListingBatchPublicationReceiptSchema = z.object({
  id: z.string().check(z.minLength(1)),
  action: z.enum(['publish_ready', 'retry_failed']),
  state: z.optional(z.literal('queued')),
  items: z.array(ListingPublicationReceiptSchema),
  count: DatabaseIntegerSchema,
  parent_id: z.optional(z.string().check(z.minLength(1))),
});

export const CatalogPublicationFailureSchema = z.object({
  id: z.string().check(z.minLength(1)),
  sku_id: z.nullable(z.string()),
  title: z.nullable(z.string()),
  code: z.string().check(z.minLength(1)),
  message: z.string().check(z.minLength(1)),
  retryable: z.boolean(),
});

export const CatalogPublicationTaskSchema = z.object({
  id: z.nullable(z.string().check(z.minLength(1))),
  kind: z.literal('catalogpublication'),
  scope_id: z.nullable(z.string().check(z.minLength(1))),
  state: z.enum(['idle', 'queued', 'running', 'completed', 'failed', 'cancelled']),
  action: z.enum(['publish_ready', 'retry_failed']),
  phase: z.string().check(z.minLength(1)),
  total: z.nullable(DatabaseIntegerSchema),
  processed: DatabaseIntegerSchema,
  succeeded: DatabaseIntegerSchema,
  published: DatabaseIntegerSchema,
  failed: DatabaseIntegerSchema,
  skipped: DatabaseIntegerSchema,
  failures: z.array(CatalogPublicationFailureSchema),
  retryable_count: DatabaseIntegerSchema,
  parent_id: z.nullable(z.string()),
  idempotency_key: z.optional(z.nullable(z.string())),
  started_at: z.nullable(z.string()),
  created_at: z.nullable(z.string()),
  updated_at: z.nullable(z.string()),
  completed_at: z.nullable(z.string()),
}).check(
  z.refine((task) => task.processed === task.succeeded + task.failed + task.skipped,
    { message: 'CATALOG_PUBLICATION_PROGRESS_MISMATCH' }),
  z.refine((task) => task.total === null || task.processed <= task.total,
    { message: 'CATALOG_PUBLICATION_TOTAL_MISMATCH' }),
  z.refine((task) => task.failures.length === task.failed,
    { message: 'CATALOG_PUBLICATION_FAILURE_COUNT_MISMATCH' }),
  z.refine((task) => task.retryable_count === task.failures.filter(({ retryable }) => retryable).length,
    { message: 'CATALOG_PUBLICATION_RETRY_COUNT_MISMATCH' }),
);

export const CatalogImportCreateSchema = z.object({
  id: z.string().check(z.minLength(1)),
  state: z.string().check(z.minLength(1)),
  total_count: z.optional(z.nullable(DatabaseIntegerSchema)),
  cursor_value: z.optional(z.nullable(DatabaseIntegerSchema)),
  success_count: z.optional(z.nullable(DatabaseIntegerSchema)),
  failure_count: z.optional(z.nullable(DatabaseIntegerSchema)),
  duplicate: z.optional(z.boolean()),
  confirmed: z.optional(z.boolean()),
});

export const CatalogImportValidationSummarySchema = z.object({
  format: z.optional(z.string()),
  packageId: z.optional(z.string()),
  source: z.optional(z.unknown()),
  rows: z.optional(DatabaseIntegerSchema),
  validCount: z.optional(DatabaseIntegerSchema),
  errorCount: z.optional(DatabaseIntegerSchema),
  validationStartedAt: z.optional(z.string()),
  validationFinishedAt: z.optional(z.string()),
  saveRequestedAt: z.optional(z.string()),
});

export const CatalogImportPreviewRowsSchema = z.array(z.object({
  rowNumber: DatabaseIntegerSchema,
  title: z.optional(z.nullable(z.string())),
  sku: z.optional(z.nullable(z.string())),
  category: z.optional(z.nullable(z.string())),
  priceMinor: z.optional(z.nullable(z.string())),
  stock: z.optional(z.nullable(z.string())),
  status: z.optional(z.nullable(z.string())),
}));

const ProductPreviewFacetSchema = z.object({
  value: z.string().check(z.minLength(1)),
  label: z.string().check(z.minLength(1)),
  count: z.int().check(z.nonnegative()),
});

const ProductSupplierPreviewFacetSchema = z.object({
  value: z.string().check(z.minLength(1)),
  label: z.string().check(z.minLength(1)),
  count: z.int().check(z.nonnegative()),
  productCount: z.optional(DatabaseIntegerSchema),
  skuCount: z.optional(DatabaseIntegerSchema),
  trialProductCount: z.optional(DatabaseIntegerSchema),
  publishedCount: z.optional(DatabaseIntegerSchema),
  availableStock: z.optional(DatabaseIntegerSchema),
  inventoryValueMinor: z.optional(DatabaseIntegerSchema),
  minPriceMinor: z.optional(z.nullable(DatabaseIntegerSchema)),
  maxPriceMinor: z.optional(z.nullable(DatabaseIntegerSchema)),
  channel: z.optional(z.string().check(z.minLength(1))),
  settlementMode: z.optional(z.string().check(z.minLength(1))),
  agreementStatus: z.optional(z.string().check(z.minLength(1))),
  contractRef: z.optional(z.nullable(z.string())),
  capabilities: z.optional(z.array(z.string())),
  effectiveAt: z.optional(z.nullable(z.string())),
  lastSyncedAt: z.optional(z.nullable(z.string())),
});

const ProductPagePreviewSchema = z.object({
  kind: z.string().check(z.minLength(1)),
  totalCount: z.int().check(z.nonnegative()),
  asOf: z.string().check(z.minLength(1)),
  facets: z.object({
    categories: z.array(ProductPreviewFacetSchema),
    suppliers: z.array(ProductSupplierPreviewFacetSchema),
    malls: z.array(ProductPreviewFacetSchema),
    statuses: z.array(ProductPreviewFacetSchema),
  }),
});

export const ListingPageSchema = z.object({
  items: z.array(ListingSchema),
  count: z.int().check(z.nonnegative()),
  total_count: z.optional(DatabaseIntegerSchema),
  status_counts: z.optional(z.object({
    needs_attention: DatabaseIntegerSchema,
    pending_review: DatabaseIntegerSchema,
    published: DatabaseIntegerSchema,
    unpublished: DatabaseIntegerSchema,
  })),
  nextCursor: z.optional(z.string().check(z.minLength(1))),
  preview: z.optional(ProductPagePreviewSchema),
});

export type ProductFilter = z.infer<typeof ProductFilterSchema>;
export type Listing = z.infer<typeof ListingSchema>;
export type ProductSelectionPreview = z.infer<typeof ProductSelectionPreviewSchema>;
export type ProductSelectionReceipt = z.infer<typeof ProductSelectionReceiptSchema>;
export type ListingBatchPublicationReceipt = z.infer<typeof ListingBatchPublicationReceiptSchema>;
export type CatalogPublicationFailure = z.infer<typeof CatalogPublicationFailureSchema>;
export type CatalogPublicationTask = z.infer<typeof CatalogPublicationTaskSchema>;
export type ListingPage = z.infer<typeof ListingPageSchema>;
export type ProductListingPreview = z.infer<typeof ProductListingPreviewSchema>;
export type ProductPagePreview = z.infer<typeof ProductPagePreviewSchema>;
