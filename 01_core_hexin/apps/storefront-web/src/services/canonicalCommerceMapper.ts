import type { ApiAccount, ApiAccountLedger, ApiCartItem, ApiOrder, ApiOrderReturn } from './productionApi.types';
import { asDate, invalid, nextCursor, nonNegativeInteger, optionalText, pageItems, record, records, text, version } from './canonicalShape';

export function mapCanonicalAccounts(value: unknown): ApiAccount[] {
  return pageItems(value, 'benefit.accounts').flatMap((item) => {
    const kind = optionalText(item.kind);
    if ((kind !== 'welfare' && kind !== 'meal') || item.currency !== 'CNY') return [];
    return [{
      id: text(item.id, 'benefit.account.id'),
      type: kind,
      balanceCents: nonNegativeInteger(item.available_minor, 'benefit.account.available_minor'),
      status: optionalText(item.status) ?? 'available',
      updatedAt: optionalText(item.updated_at) ?? '',
    }];
  });
}

export function mapCanonicalLedgers(value: unknown, accounts: readonly ApiAccount[]): ApiAccountLedger[] {
  const running = new Map(accounts.map((account) => [account.id, account.balanceCents]));
  return pageItems(value, 'benefit.ledgers').flatMap((item) => {
    const kind = optionalText(item.kind);
    if ((kind !== 'welfare' && kind !== 'meal') || item.currency !== 'CNY') return [];
    const account = text(item.account, 'benefit.ledger.account');
    const signedAmount = signedInteger(item.amountMinor, 'benefit.ledger.amountMinor');
    const balanceAfterCents = running.get(account) ?? 0;
    running.set(account, balanceAfterCents - signedAmount);
    const referenceType = optionalText(item.referenceType) ?? 'benefit';
    const referenceId = optionalText(item.referenceId) ?? '';
    return [{
      id: text(item.id, 'benefit.ledger.id'),
      accountType: kind,
      direction: signedAmount >= 0 ? 'credit' : 'debit',
      amountCents: Math.abs(signedAmount),
      balanceAfterCents,
      businessType: referenceType,
      businessId: referenceId,
      orderNo: referenceType.includes('order') ? referenceId : null,
      createdAt: asDate(item.occurredAt),
    }];
  });
}

export function mapCanonicalCart(value: unknown): { items: ApiCartItem[]; version: number } {
  const source = record(value, 'cart.current');
  const cartVersion = source.version === undefined ? 0 : version(source.version, 'cart.current.version');
  const updatedAt = optionalText(source.updated_at) ?? '';
  const items = records(source.items ?? [], 'cart.current.items').map((item) => {
    const listing = text(item.listing, 'cart.item.listing');
    return {
      id: listing,
      skuId: text(item.sku, 'cart.item.sku'),
      productId: listing,
      quantity: nonNegativeInteger(item.quantity, 'cart.item.quantity'),
      selected: true,
      updatedAt,
      purchasable: true,
    } satisfies ApiCartItem;
  });
  return { items, version: cartVersion };
}

export function mapCanonicalOrders(value: unknown): { items: ApiOrder[]; nextCursor: string | null } {
  return {
    items: pageItems(value, 'order.orders').map((item) => mapOrder(item)),
    nextCursor: nextCursor(value),
  };
}

export function mapCanonicalOrderReturns(value: unknown, orderId: string): ApiOrderReturn[] {
  const order = pageItems(value, 'order.orders').find(({ id }) => id === orderId);
  if (!order) return [];
  const lines = records(order.lines ?? [], 'order.lines');
  const payment = order.payment_fact == null ? undefined : record(order.payment_fact, 'order.payment_fact');
  const refunds = records(payment?.refunds ?? [], 'order.payment_fact.refunds');
  return records(order.aftersales ?? [], 'order.aftersales').filter(({ kind }) => kind === 'return').map((sale) => {
    const id = text(sale.id, 'order.aftersale.id');
    const line = lines.find(({ id: lineId }) => lineId === sale.lineId);
    return {
      id,
      title: optionalText(line?.title) ?? (sale.lineId == null ? '整单退货' : '退货商品'),
      state: text(sale.state, 'order.aftersale.state'),
      refunds: refunds.filter((refund) => refund.aftersaleId === id && refund.state === 'succeeded').map((refund) => ({
        id: text(refund.id, 'order.refund.id'),
        amountMinor: nonNegativeInteger(refund.amountMinor, 'order.refund.amountMinor'),
        currency: text(refund.currency, 'order.refund.currency'),
      })),
    };
  });
}

function mapOrder(item: Record<string, unknown>): ApiOrder {
  const total = nonNegativeInteger(item.total_minor, 'order.total_minor');
  const paymentState = optionalText(item.payment_state) ?? 'unpaid';
  const lines = records(item.lines ?? [], 'order.lines');
  const benefitPaid = paymentState === 'paid' ? benefitTenderAmount(item.evidence, total) : 0;
  const benefitAllocations = paymentState === 'paid' ? paidBenefitAllocations(item.evidence) : undefined;
  const personalPayableCents = personalTenderAmount(item.evidence);
  const trackingNo = optionalText(item.tracking_no);
  return {
    id: text(item.id, 'order.id'),
    orderNo: text(item.order_number, 'order.order_number'),
    status: orderStatus(item),
    ...(typeof item.aftersale_state === 'string' && item.aftersale_state !== 'none' ? { hasAftersale: true } : {}),
    hasShipment: optionalText(item.fulfillment_state) === 'shipped' || Boolean(trackingNo),
    ...(trackingNo ? { trackingNo } : {}),
    goodsAmountCents: lines.reduce((sum, line) => sum + nonNegativeInteger(line.totalMinor, 'order.line.totalMinor'), 0),
    discountCents: lines.reduce((sum, line) => sum + nonNegativeInteger(line.discountMinor, 'order.line.discountMinor'), 0),
    payableCents: total,
    ...(personalPayableCents === undefined ? {} : { personalPayableCents }),
    paidCents: paymentState === 'paid' || paymentState.includes('refund') ? total : 0,
    welfarePaidCents: benefitPaid,
    mealPaidCents: 0,
    ...(benefitAllocations === undefined ? {} : { benefitAllocations }),
    createdAt: asDate(item.created_at),
    updatedAt: asDate(item.updated_at),
    items: lines.map((line) => ({
      productId: text(line.listing, 'order.line.listing'),
      productTitle: text(line.title, 'order.line.title'),
      productImage: optionalText(line.coverUrl),
      priceCents: nonNegativeInteger(line.unitMinor, 'order.line.unitMinor'),
      quantity: nonNegativeInteger(line.quantity, 'order.line.quantity'),
      specs: {},
      itemType: 'physical',
    })),
  };
}

function orderStatus(item: Record<string, unknown>): string {
  const aftersale = optionalText(item.aftersale_state) ?? 'none';
  if (!['none', 'resolved', 'rejected'].includes(aftersale)) return 'refund_pending';
  const lifecycle = optionalText(item.lifecycle_state) ?? 'created';
  if (lifecycle === 'cancelled' || lifecycle === 'closed') return 'cancelled';
  const payment = optionalText(item.payment_state) ?? 'unpaid';
  if (payment === 'unpaid' || payment === 'authorizing') return 'pending_payment';
  const fulfillment = optionalText(item.fulfillment_state) ?? 'unallocated';
  if (fulfillment === 'shipped') return 'shipped';
  if (fulfillment === 'delivered' || lifecycle === 'completed') return 'completed';
  return 'paid';
}

function personalTenderAmount(value: unknown): number | undefined {
  if (value === null || typeof value !== 'object' || !('tenders' in value)) return undefined;
  const tenders = value.tenders;
  if (!Array.isArray(tenders) || tenders.length === 0) return undefined;
  let total = 0;
  for (const tender of tenders) {
    if (tender?.kind !== 'wechat') continue;
    const amount = tender.amountMinor;
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0) return undefined;
    total += amount;
  }
  return Number.isSafeInteger(total) ? total : undefined;
}

function paidBenefitAllocations(value: unknown): ApiOrder['benefitAllocations'] {
  if (value === null || typeof value !== 'object') return undefined;
  const tenders = Reflect.get(value, 'tenders');
  if (!Array.isArray(tenders) || tenders.length === 0) return undefined;
  const allocations = [];
  for (const tender of tenders) {
    if (!tender || typeof tender.kind !== 'string') return undefined;
    if (tender.kind !== 'benefit') continue;
    const { reference, amountMinor } = tender;
    if (typeof reference !== 'string' || !reference || !Number.isSafeInteger(amountMinor) || amountMinor < 0) return undefined;
    allocations.push({ accountId: reference, amountCents: amountMinor });
  }
  return allocations;
}

function benefitTenderAmount(value: unknown, fallback: number): number {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fallback;
  const tenders = Reflect.get(value, 'tenders');
  if (!Array.isArray(tenders)) return fallback;
  return tenders.reduce((sum, raw) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || Reflect.get(raw, 'kind') !== 'benefit') return sum;
    const amount = Reflect.get(raw, 'amountMinor');
    return typeof amount === 'number' && Number.isSafeInteger(amount) && amount >= 0 ? sum + amount : sum;
  }, 0);
}

function signedInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) invalid(label);
  return value;
}
