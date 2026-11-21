import { createSecureId } from '@shop/sdk/context';

export type PaymentFlowStage =
  | 'validating'
  | 'creating-order'
  | 'creating-payment'
  | 'opening-wechat'
  | 'wechat-active'
  | 'verifying'
  | 'captured'
  | 'cancelled'
  | 'recovery'
  | 'failed'
  | 'expired';

export interface PaymentRecoveryRecord {
  readonly schema: 'storefront.payment-recovery.v1';
  readonly scope: string;
  readonly source?: 'order';
  readonly orderId: string | null;
  readonly paymentId: string | null;
  readonly amountMinor: number;
  readonly currency: string;
  readonly mallName: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly idempotencyKey: string;
  readonly cartFingerprint: string;
  readonly cartItemIds: readonly string[];
  readonly stage: PaymentFlowStage;
  readonly retryCount: number;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface BeginPaymentRecoveryInput {
  readonly scope: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly mallName: string;
  readonly cartFingerprint: string;
  readonly cartItemIds: readonly string[];
}

interface PaymentRecoveryOptions {
  readonly storage?: StorageLike | null;
  readonly now?: () => Date;
  readonly createId?: () => string;
}

interface PaymentSubmissionLock {
  current: boolean;
}

const STORAGE_KEY = 'zdt:storefront:payment-recovery:v1';
const ORDER_STORAGE_KEY = 'zdt:storefront:order-payment-recovery:v1';
const STAGES: ReadonlySet<PaymentFlowStage> = new Set([
  'validating', 'creating-order', 'creating-payment', 'opening-wechat', 'wechat-active',
  'verifying', 'captured', 'cancelled', 'recovery', 'failed', 'expired',
]);
const volatileRecords = new Map<string, PaymentRecoveryRecord>();

export function paymentRecoveryScope(memberId: string, mallId: string): string {
  return `${memberId.trim()}:${mallId.trim()}`;
}

export function paymentRetryIdempotencyKey(record: Pick<PaymentRecoveryRecord, 'idempotencyKey' | 'paymentId'>): string {
  return `${record.idempotencyKey}:retry-after:${record.paymentId ?? 'initial'}`;
}

export function paymentCartFingerprint(
  addressId: string,
  items: readonly Readonly<{ cartItemId: string; listingId: string; quantity: number }>[],
): string {
  const source = `${addressId}|${items.map((item) => `${item.cartItemId}:${item.listingId}:${item.quantity}`).sort().join('|')}`;
  let hash = 2_166_136_261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `cart-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function beginPaymentRecovery(input: BeginPaymentRecoveryInput, options: PaymentRecoveryOptions = {}): PaymentRecoveryRecord {
  const existing = loadCartPaymentRecovery(input.scope, options.storage);
  if (existing && existing.stage !== 'captured') return existing;
  const now = (options.now ?? (() => new Date()))().toISOString();
  const record: PaymentRecoveryRecord = Object.freeze({
    schema: 'storefront.payment-recovery.v1',
    scope: input.scope,
    orderId: null,
    paymentId: null,
    amountMinor: input.amountMinor,
    currency: input.currency,
    mallName: input.mallName,
    createdAt: now,
    updatedAt: now,
    idempotencyKey: `checkout-${(options.createId ?? createSecureId)()}`,
    cartFingerprint: input.cartFingerprint,
    cartItemIds: Object.freeze([...input.cartItemIds]),
    stage: 'validating',
    retryCount: 0,
  });
  return persist(record, options.storage);
}

export function beginOrderPaymentRecovery(input: {
  scope: string; orderId: string; paymentId: string | null; amountMinor: number; currency: string; mallName: string;
}): PaymentRecoveryRecord {
  const stored = [loadCartPaymentRecovery(input.scope), readRecovery(input.scope, ORDER_STORAGE_KEY, browserStorage())]
    .find((record) => record?.orderId === input.orderId && record.stage !== 'captured');
  if (stored) return updatePaymentRecovery(stored, { paymentId: stored.paymentId ?? input.paymentId, amountMinor: input.amountMinor, currency: input.currency });
  const now = new Date().toISOString();
  return persist(Object.freeze({ ...input, schema: 'storefront.payment-recovery.v1', source: 'order', createdAt: now, updatedAt: now,
    idempotencyKey: `order-payment:${input.orderId}`, cartFingerprint: '', cartItemIds: Object.freeze([]), stage: 'recovery', retryCount: 0 }));
}

export function updatePaymentRecovery(
  current: PaymentRecoveryRecord,
  patch: Partial<Pick<PaymentRecoveryRecord, 'orderId' | 'paymentId' | 'amountMinor' | 'currency' | 'stage' | 'retryCount'>>,
  options: Pick<PaymentRecoveryOptions, 'storage' | 'now'> = {},
): PaymentRecoveryRecord {
  const record: PaymentRecoveryRecord = Object.freeze({
    ...current,
    ...patch,
    updatedAt: (options.now ?? (() => new Date()))().toISOString(),
  });
  return persist(record, options.storage);
}

export function loadPaymentRecovery(scope: string, storage: StorageLike | null = browserStorage()): PaymentRecoveryRecord | null {
  const cart = loadCartPaymentRecovery(scope, storage);
  const order = readRecovery(scope, ORDER_STORAGE_KEY, storage);
  return order && (!cart || order.updatedAt >= cart.updatedAt) ? order : cart;
}

export function loadCartPaymentRecovery(scope: string, storage: StorageLike | null = browserStorage()): PaymentRecoveryRecord | null {
  return readRecovery(scope, STORAGE_KEY, storage);
}

function readRecovery(scope: string, key: string, storage: StorageLike | null): PaymentRecoveryRecord | null {
  const volatile = volatileRecords.get(key);
  let value: unknown = volatile;
  try {
    const source = storage?.getItem(key);
    if (source) value = JSON.parse(source);
  } catch {
    value = volatile;
  }
  const record = parseRecord(value);
  return record?.scope === scope ? record : null;
}

export function clearPaymentRecovery(scope: string, storage: StorageLike | null = browserStorage()): void {
  removeRecovery(scope, STORAGE_KEY, storage);
}

export function clearOrderPaymentRecovery(scope: string): void {
  removeRecovery(scope, ORDER_STORAGE_KEY, browserStorage());
}

function removeRecovery(scope: string, key: string, storage: StorageLike | null): void {
  if (volatileRecords.get(key)?.scope === scope) volatileRecords.delete(key);
  try {
    const stored = storage?.getItem(key);
    if (!stored || parseRecord(JSON.parse(stored))?.scope === scope) storage?.removeItem(key);
  } catch {
    // The in-memory copy is already cleared; storage can recover on the next successful write.
  }
}

export function isPaymentRecoveryPending(record: PaymentRecoveryRecord | null): record is PaymentRecoveryRecord {
  if (record === null || record.stage === 'captured') return false;
  return record.orderId !== null || !['failed', 'expired', 'cancelled'].includes(record.stage);
}

export function tryBeginPaymentSubmission(lock: PaymentSubmissionLock): boolean {
  if (lock.current) return false;
  lock.current = true;
  return true;
}

export function finishPaymentSubmission(lock: PaymentSubmissionLock): void {
  lock.current = false;
}

function persist(record: PaymentRecoveryRecord, storage: StorageLike | null = browserStorage()): PaymentRecoveryRecord {
  const key = record.source === 'order' ? ORDER_STORAGE_KEY : STORAGE_KEY;
  volatileRecords.set(key, record);
  try {
    storage?.setItem(key, JSON.stringify(record));
  } catch {
    // Volatile recovery still protects repeated clicks during this page lifetime.
  }
  return record;
}

function parseRecord(value: unknown): PaymentRecoveryRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schema !== 'storefront.payment-recovery.v1'
    || typeof record.scope !== 'string'
    || (record.source !== undefined && record.source !== 'order')
    || !(typeof record.orderId === 'string' || record.orderId === null)
    || !(typeof record.paymentId === 'string' || record.paymentId === null)
    || !Number.isSafeInteger(record.amountMinor) || Number(record.amountMinor) < 0
    || typeof record.currency !== 'string' || typeof record.mallName !== 'string'
    || typeof record.createdAt !== 'string' || typeof record.updatedAt !== 'string'
    || typeof record.idempotencyKey !== 'string' || typeof record.cartFingerprint !== 'string'
    || !Array.isArray(record.cartItemIds) || record.cartItemIds.some((item) => typeof item !== 'string')
    || typeof record.stage !== 'string' || !STAGES.has(record.stage as PaymentFlowStage)
    || !Number.isSafeInteger(record.retryCount) || Number(record.retryCount) < 0) return null;
  return Object.freeze({ ...record, cartItemIds: Object.freeze([...record.cartItemIds]) }) as unknown as PaymentRecoveryRecord;
}

function browserStorage(): StorageLike | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
