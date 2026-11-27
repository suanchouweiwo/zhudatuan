import * as z from 'zod/mini';
import { DatabaseIntegerSchema } from '../../shared/schema/DatabaseInteger';

export const OrderFilterSchema = z.object({ order: z.string().check(z.trim(), z.maxLength(255)) });

export const OrderListFilterSchema = z.object({
  order: z.string().check(z.trim(), z.maxLength(255)),
  placed: z.enum(['', 'today', '7days', '30days']),
  lifecycle: z.enum(['', 'created', 'active', 'completed', 'cancelled', 'closed']),
  payment: z.enum(['', 'unpaid', 'authorizing', 'paid', 'partially_refunded', 'refunded', 'failed']),
  fulfillment: z.enum(['', 'unallocated', 'allocated', 'processing', 'shipped', 'delivered', 'cancelled', 'returned']),
  mall: z.string().check(z.trim(), z.maxLength(255)),
});

export const OrderViewSchema = z.enum(['all', 'unpaid', 'unshipped', 'active', 'completed', 'aftersale', 'exception']);
export const OrderDetailTabSchema = z.enum(['overview', 'products', 'payment', 'aftersale', 'operations']);

const PreviewMilestoneSchema = z.object({
  key: z.enum(['placed', 'paid', 'reserved', 'unshipped', 'shipping', 'completed']),
  label: z.string().check(z.minLength(1)),
  state: z.enum(['complete', 'current', 'pending', 'warning']),
  at: z.optional(z.string().check(z.minLength(1))),
});

const PreviewOperationSchema = z.object({
  id: z.string().check(z.minLength(1)),
  label: z.string().check(z.minLength(1)),
  status: z.enum(['succeeded', 'pending', 'failed']),
  at: z.string().check(z.minLength(1)),
});

const OrderPreviewSchema = z
  .object({
    source: z.enum(['local-preview']),
    memberName: z.string().check(z.minLength(1)),
    enterpriseName: z.string().check(z.minLength(1)),
    mallName: z.string().check(z.minLength(1)),
    paidMinor: DatabaseIntegerSchema,
    paymentMethod: z.string().check(z.minLength(1)),
    benefitMinor: DatabaseIntegerSchema,
    wechatMinor: DatabaseIntegerSchema,
    supplierName: z.string().check(z.minLength(1)),
    fulfillmentId: z.string().check(z.minLength(1)),
    slaMinutes: z.optional(DatabaseIntegerSchema),
    addressSummary: z.string().check(z.minLength(1)),
    summary: z.string().check(z.minLength(1)),
    milestones: z.array(PreviewMilestoneSchema),
    operation: z.optional(PreviewOperationSchema),
    exception: z.boolean(),
  })
  .check(z.refine((preview) => preview.benefitMinor + preview.wechatMinor === preview.paidMinor, { message: 'ORDER_PREVIEW_PAYMENT_SPLIT_MISMATCH' }));

export const OrderSchema = z.object({
  id: z.string().check(z.minLength(1)),
  order_number: z.string().check(z.minLength(1)),
  scope_id: z.optional(z.string().check(z.minLength(1))),
  member_id: z.optional(z.string().check(z.minLength(1))),
  mall_id: z.optional(z.string().check(z.minLength(1))),
  transaction_id: z.optional(z.nullable(z.string().check(z.minLength(1)))),
  correlation_id: z.optional(z.nullable(z.string().check(z.minLength(1)))),
  operating_node_id: z.optional(z.nullable(z.string().check(z.minLength(1)))),
  operating_line_id: z.optional(z.nullable(z.string().check(z.minLength(1)))),
  participant_node_id: z.optional(z.nullable(z.string().check(z.minLength(1)))),
  participant_membership_id: z.optional(z.nullable(z.string().check(z.minLength(1)))),
  participant_realm_id: z.optional(z.nullable(z.string().check(z.minLength(1)))),
  participant_account_id: z.optional(z.nullable(z.string().check(z.minLength(1)))),
  participant_snapshot: z.optional(z.nullable(z.record(z.string(), z.unknown()))),
  total_minor: DatabaseIntegerSchema,
  currency: z.string().check(z.minLength(3), z.maxLength(3)),
  payment_state: z.enum(['unpaid', 'authorizing', 'paid', 'partially_refunded', 'refunded', 'failed']),
  fulfillment_state: z.enum(['unallocated', 'allocated', 'processing', 'shipped', 'delivered', 'cancelled', 'returned']),
  aftersale_state: z.enum(['none', 'requested', 'processing', 'resolved', 'rejected']),
  lifecycle_state: z.enum(['created', 'active', 'completed', 'cancelled', 'closed']),
  created_at: z.string().check(z.minLength(1)),
  updated_at: z.string().check(z.minLength(1)),
  version: DatabaseIntegerSchema,
  lines: z.optional(
    z.array(
      z.object({
        id: z.string().check(z.minLength(1)),
        sku: z.string().check(z.minLength(1)),
        listing: z.string().check(z.minLength(1)),
        title: z.string().check(z.minLength(1)),
        quantity: DatabaseIntegerSchema,
        unitMinor: DatabaseIntegerSchema,
        totalMinor: DatabaseIntegerSchema,
        discountMinor: DatabaseIntegerSchema,
        payableMinor: DatabaseIntegerSchema,
        provider: z.optional(z.nullable(z.string())),
        partner: z.optional(z.nullable(z.string())),
        product: z.optional(z.nullable(z.string())),
        routeId: z.optional(z.nullable(z.string())),
        routeVersion: z.optional(z.nullable(DatabaseIntegerSchema)),
        operatingNodeId: z.optional(z.nullable(z.string())),
        participantNodeId: z.optional(z.nullable(z.string())),
        participantMembershipId: z.optional(z.nullable(z.string())),
        supplierId: z.optional(z.nullable(z.string())),
        supplierRelationshipId: z.optional(z.nullable(z.string())),
        contractId: z.optional(z.nullable(z.string())),
        contractHash: z.optional(z.nullable(z.string())),
        fulfillmentPartyId: z.optional(z.nullable(z.string())),
        settlementPartyId: z.optional(z.nullable(z.string())),
        invoicePartyId: z.optional(z.nullable(z.string())),
        routeSnapshot: z.optional(z.nullable(z.record(z.string(), z.unknown()))),
      })
    )
  ),
  economic_legs: z.optional(z.array(z.object({
    id: z.string().check(z.minLength(1)),
    routeId: z.nullable(z.string()),
    routeVersion: z.nullable(DatabaseIntegerSchema),
    supplierId: z.nullable(z.string()),
    supplierRelationshipId: z.nullable(z.string()),
    contractId: z.nullable(z.string()),
    fulfillmentPartyId: z.nullable(z.string()),
    settlementPartyId: z.nullable(z.string()),
    invoicePartyId: z.nullable(z.string()),
    amountMinor: z.nullable(DatabaseIntegerSchema),
    state: z.string(),
  }))),
  inventory_reservations: z.optional(
    z.array(
      z.object({
        id: z.string().check(z.minLength(1)),
        stockItem: z.string().check(z.minLength(1)),
        quantity: DatabaseIntegerSchema,
        state: z.string().check(z.minLength(1)),
        expiresAt: z.nullable(z.string()),
      })
    )
  ),
  aftersales: z.optional(
    z.array(
      z.object({
        id: z.string().check(z.minLength(1)),
        lineId: z.nullable(z.string()),
        kind: z.enum(['cancel', 'return', 'refund', 'exchange', 'claim']),
        state: z.enum(['requested', 'approved', 'rejected', 'processing', 'completed', 'cancelled']),
        quantity: z.nullable(DatabaseIntegerSchema),
        amountMinor: z.nullable(DatabaseIntegerSchema),
        reason: z.string(),
        requestedAt: z.string().check(z.minLength(1)),
        updatedAt: z.string().check(z.minLength(1)),
        routeSnapshot: z.optional(z.nullable(z.record(z.string(), z.unknown()))),
      })
    )
  ),
  fulfillments: z.optional(z.array(z.object({
    id: z.string(), suborderId: z.string(), provider: z.nullable(z.string()), partnerId: z.nullable(z.string()),
    storeId: z.nullable(z.string()), kind: z.string(), state: z.string(), externalReference: z.nullable(z.string()),
    paymentId: z.nullable(z.string()), amountMinor: z.nullable(DatabaseIntegerSchema), createdAt: z.nullable(z.string()),
    updatedAt: z.nullable(z.string()), lines: z.array(z.object({ lineId: z.string(), quantity: DatabaseIntegerSchema })),
    milestones: z.array(z.object({
      id: z.string(), kind: z.string(), state: z.string(), occurredAt: z.string(), tracking: z.optional(z.nullable(z.string())),
    })),
  }))),
  payment_fact: z.optional(z.nullable(z.object({
    intentId: z.string(), intentState: z.string(), amountMinor: DatabaseIntegerSchema, currency: z.string(),
    paymentId: z.nullable(z.string()), paymentState: z.nullable(z.string()), capturedMinor: z.nullable(DatabaseIntegerSchema),
    refundedMinor: z.nullable(DatabaseIntegerSchema),
    allocations: z.array(z.object({ targetType: z.string(), targetId: z.string(), amountMinor: DatabaseIntegerSchema, currency: z.string() })),
    refunds: z.array(z.object({ id: z.string(), aftersaleId: z.nullable(z.string()), state: z.string(), amountMinor: DatabaseIntegerSchema,
      currency: z.string(), reason: z.string() })),
  }))),
  finance_facts: z.optional(z.array(z.object({
    id: z.string(), referenceType: z.string(), referenceId: z.string(), state: z.string(), currency: z.string(),
    postedAt: z.nullable(z.string()), entries: z.array(z.object({ accountId: z.string(), side: z.string(), amountMinor: DatabaseIntegerSchema })),
  }))),
  operations: z.optional(z.array(z.object({
    id: z.string().check(z.minLength(1)),
    kind: z.enum(['placed', 'shipment', 'aftersale_request', 'aftersale_approved', 'aftersale_rejected']),
    actor_id: z.nullable(z.string()),
    actor_name: z.nullable(z.string()),
    membership_id: z.nullable(z.string()),
    occurred_at: z.string().check(z.minLength(1)),
    result: z.string().check(z.minLength(1)),
  }))),
  preview: z.optional(OrderPreviewSchema),
});

export const OrderPageSchema = z
  .object({
    items: z.array(OrderSchema).check(z.maxLength(50)),
    count: z.int().check(z.nonnegative()),
    nextCursor: z.optional(z.string().check(z.minLength(1))),
    preview: z.optional(
      z.object({
        source: z.enum(['local-preview']),
        total: z.int().check(z.nonnegative()),
        updatedAt: z.string().check(z.minLength(1)),
        page: z.int().check(z.positive()),
        previousCursor: z.optional(z.string().check(z.minLength(1))),
        counts: z.object({
          all: z.int().check(z.nonnegative()),
          unpaid: z.int().check(z.nonnegative()),
          unshipped: z.int().check(z.nonnegative()),
          active: z.int().check(z.nonnegative()),
          completed: z.int().check(z.nonnegative()),
          aftersale: z.int().check(z.nonnegative()),
          exception: z.int().check(z.nonnegative()),
        }),
      })
    ),
  })
  .check(
    z.refine((page) => page.count === page.items.length, { message: 'ORDER_PAGE_COUNT_MISMATCH' }),
    z.refine((page) => page.preview === undefined || page.preview.total >= page.count, { message: 'ORDER_PREVIEW_TOTAL_INVALID' })
  );

export type OrderFilter = z.infer<typeof OrderFilterSchema>;
export type OrderListFilter = z.infer<typeof OrderListFilterSchema>;
export type OrderView = z.infer<typeof OrderViewSchema>;
export type OrderDetailTab = z.infer<typeof OrderDetailTabSchema>;
export type OrderRecord = z.infer<typeof OrderSchema>;
export type OrderLine = NonNullable<OrderRecord['lines']>[number];
export type OrderInventoryReservation = NonNullable<OrderRecord['inventory_reservations']>[number];
export type OrderAftersale = NonNullable<OrderRecord['aftersales']>[number];
export type OrderEconomicLeg = NonNullable<OrderRecord['economic_legs']>[number];
export type OrderPage = z.infer<typeof OrderPageSchema>;
