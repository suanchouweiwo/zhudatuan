export interface BenefitChoice {
  readonly account: string;
  readonly amountMinor: number;
}

interface CheckoutItemSelection {
  readonly listingId: string;
  readonly quantity: number;
}

export interface CheckoutSelection {
  readonly address: string | null;
  readonly invoice: string | null;
  readonly delivery: Readonly<Record<string, unknown>>;
  readonly vouchers: readonly string[];
  readonly benefits: readonly BenefitChoice[];
  readonly items?: readonly CheckoutItemSelection[];
}

export interface QuoteLine {
  readonly listing: string;
  readonly sku: string;
  readonly product: string;
  readonly productType: string;
  readonly category: string;
  readonly title: string;
  readonly quantity: number;
  readonly unitMinor: number;
  readonly totalMinor: number;
  readonly discountMinor: number;
  readonly payableMinor: number;
  readonly provider: string | null;
  readonly partner: string | null;
  readonly supplierRelationship: string | null;
  readonly contract: string | null;
  readonly contractHash: string | null;
  readonly fulfillmentParty: string | null;
  readonly settlementParty: string | null;
  readonly invoiceParty: string | null;
  readonly stockitem: string | null;
  readonly versions: Readonly<Record<string, string | number>>;
  readonly accepted: boolean;
  readonly reasons: readonly string[];
}

export interface TenderChoice {
  readonly kind: 'benefit' | 'voucher' | 'wechat';
  readonly reference: string | null;
  readonly amountMinor: number;
}

export interface CheckoutQuote {
  readonly cart: Readonly<{ id: string; member: string; mall: string; application: string; version: number }>;
  readonly selection: CheckoutSelection;
  readonly lines: readonly QuoteLine[];
  readonly subtotalMinor: number;
  readonly discountMinor: number;
  readonly payableMinor: number;
  readonly personalMinor: number;
  readonly currency: 'CNY';
  readonly tenders: readonly TenderChoice[];
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly rejections: readonly Readonly<{ listing: string; reasons: readonly string[] }>[];
}

export function checkoutSelection(body: Readonly<Record<string, unknown>>): CheckoutSelection {
  const address = optionalText(body.address, 'address');
  const invoice = optionalText(body.invoice, 'invoice');
  const vouchers = textList(body.vouchers, 'vouchers', 20).sort();
  const benefits = benefitChoices(body.benefits).sort((left, right) => left.account.localeCompare(right.account));
  const delivery = record(body.delivery, 'delivery');
  const items = body.items === undefined ? undefined : checkoutItems(body.items);
  return Object.freeze({ address, invoice, delivery: Object.freeze(delivery), vouchers: Object.freeze(vouchers), benefits: Object.freeze(benefits),
    ...(items === undefined ? {} : { items }) });
}

function checkoutItems(value: unknown): readonly CheckoutItemSelection[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('VALIDATION_FAILED:items');
  const items = value.map((entry) => {
    const item = record(entry, 'items');
    const listingId = requiredText(item.listingId, 'items.listingId');
    const quantity = item.quantity;
    if (typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity <= 0) throw new Error('VALIDATION_FAILED:items.quantity');
    return Object.freeze({ listingId, quantity });
  });
  if (new Set(items.map(({ listingId }) => listingId)).size !== items.length) throw new Error('VALIDATION_FAILED:items.duplicate');
  return Object.freeze(items.sort((left, right) => left.listingId.localeCompare(right.listingId)));
}

function benefitChoices(value: unknown): BenefitChoice[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 10) throw new Error('VALIDATION_FAILED:benefits');
  const result = value.map((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('VALIDATION_FAILED:benefits');
    const source = entry as Readonly<Record<string, unknown>>;
    const account = requiredText(source.account, 'benefits.account');
    const amountMinor = source.amountMinor;
    if (!Number.isSafeInteger(amountMinor) || (amountMinor as number) <= 0) throw new Error('VALIDATION_FAILED:benefits.amountMinor');
    return Object.freeze({ account, amountMinor: amountMinor as number });
  });
  if (new Set(result.map(({ account }) => account)).size !== result.length) throw new Error('VALIDATION_FAILED:benefits.duplicate');
  return result;
}

function textList(value: unknown, field: string, maximum: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`VALIDATION_FAILED:${field}`);
  const result = value.map((entry) => requiredText(entry, field));
  if (new Set(result).size !== result.length) throw new Error(`VALIDATION_FAILED:${field}.duplicate`);
  return result;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`VALIDATION_FAILED:${field}`);
  const result = value as Record<string, unknown>;
  if (JSON.stringify(result).length > 8_192) throw new Error(`VALIDATION_FAILED:${field}.size`);
  return { ...result };
}

function optionalText(value: unknown, field: string): string | null {
  return value === undefined || value === null || value === '' ? null : requiredText(value, field);
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 255) throw new Error(`VALIDATION_FAILED:${field}`);
  return value.trim();
}
