import type { OperationId } from '@shop/contract';

export const WEB_ORGANIZATION_OPERATION_IDS = Object.freeze([
  'organization.layers.read',
] as const satisfies readonly OperationId[]);

export const WEB_MEMBER_OPERATION_IDS = Object.freeze([
  'member.profile.read',
  'member.malls.open',
  'member.sovereignty.upgrade',
  'member.addresses.read',
  'member.addresses.manage',
] as const satisfies readonly OperationId[]);

export const WEB_CATALOG_OPERATION_IDS = Object.freeze([
  'catalog.listings.read',
] as const satisfies readonly OperationId[]);

export const WEB_PRICING_OPERATION_IDS = Object.freeze([
  'pricing.offers.read',
] as const satisfies readonly OperationId[]);

export const WEB_INVENTORY_OPERATION_IDS = Object.freeze([
  'inventory.availability.read',
] as const satisfies readonly OperationId[]);

export const WEB_REPORTING_OPERATION_IDS = Object.freeze([
  'reporting.dashboard.read',
] as const satisfies readonly OperationId[]);

export const WEB_CART_OPERATION_IDS = Object.freeze([
  'cart.current.read',
  'cart.items.put',
  'cart.items.batch',
] as const satisfies readonly OperationId[]);

export const WEB_ORDER_OPERATION_IDS = Object.freeze([
  'order.orders.read',
] as const satisfies readonly OperationId[]);

export const WEB_FULFILLMENT_OPERATION_IDS = Object.freeze([
  'fulfillment.shipments.create',
] as const satisfies readonly OperationId[]);

export const WEB_BENEFIT_OPERATION_IDS = Object.freeze([
  'benefit.accounts.read',
  'benefit.ledgers.read',
] as const satisfies readonly OperationId[]);

export const WEB_BUSINESS_OPERATION_IDS = Object.freeze([
  ...WEB_ORGANIZATION_OPERATION_IDS,
  ...WEB_MEMBER_OPERATION_IDS,
  ...WEB_CATALOG_OPERATION_IDS,
  ...WEB_PRICING_OPERATION_IDS,
  ...WEB_INVENTORY_OPERATION_IDS,
  ...WEB_REPORTING_OPERATION_IDS,
  ...WEB_CART_OPERATION_IDS,
  ...WEB_ORDER_OPERATION_IDS,
  ...WEB_FULFILLMENT_OPERATION_IDS,
  ...WEB_BENEFIT_OPERATION_IDS,
] as const satisfies readonly OperationId[]);
