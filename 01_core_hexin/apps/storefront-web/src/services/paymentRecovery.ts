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
  readonly orderId: string | null;
  readonly paymentId: string | null;
  readonly amountMinor: number;
  readonly currency: string;
  readonly mallName: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly idempotencyKey: string;
  readonly cartFingerprint: string;
  readonly checkoutAddressId?: string;
  readonly cartItemIds: readonly string[];
  readonly stage: PaymentFlowStage;
  readonly checkoutFailure?: 'cart-changed';
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
  readonly checkoutAddressId?: string;
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
const STAGES: ReadonlySet<PaymentFlowStage> = new Set([
  'validating', 'creating-order', 'creating-payment', 'opening-wechat', 'wechat-active',
  'verifying', 'captured', 'cancelled', 'recovery', 'failed', 'expired',
]);
let volatileRecord: PaymentRecoveryRecord | null = null;

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
  const existing = loadPaymentRecovery(input.scope, options.storage);
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
    ...(input.checkoutAddressId === undefined ? {} : { checkoutAddressId: input.checkoutAddressId }),
    cartItemIds: Object.freeze([...input.cartItemIds]),
    stage: 'validating',
    retryCount: 0,
  });
  return persist(record, options.storage);
}

export function resumeOrderPaymentRecovery(input: Pick<PaymentRecoveryRecord, 'scope' | 'amountMinor' | 'currency' | 'mallName'> & {
  readonly orderId: string;
}): PaymentRecoveryRecord {
  const now = new Date().toISOString();
  return persist(Object.freeze({
    schema: 'storefront.payment-recovery.v1',
    ...input,
    paymentId: null,
    createdAt: now,
    updatedAt: now,
    idempotencyKey: `resume:${input.orderId}`,
    cartFingerprint: '',
    cartItemIds: [],
    stage: 'recovery',
    retryCount: 0,
  }));
}

export function updatePaymentRecovery(
  current: PaymentRecoveryRecord,
  patch: Partial<Pick<PaymentRecoveryRecord, 'orderId' | 'paymentId' | 'amountMinor' | 'currency' | 'stage' | 'retryCount' | 'checkoutFailure'>>,
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
  let value: unknown = volatileRecord;
  try {
    const source = storage?.getItem(STORAGE_KEY);
    if (source) value = JSON.parse(source);
  } catch {
    value = volatileRecord;
  }
  const record = parseRecord(value);
  return record?.scope === scope ? record : null;
}

export function clearPaymentRecovery(scope: string, storage: StorageLike | null = browserStorage()): void {
  if (volatileRecord?.scope === scope) volatileRecord = null;
  try {
    const stored = storage?.getItem(STORAGE_KEY);
    if (!stored || parseRecord(JSON.parse(stored))?.scope === scope) storage?.removeItem(STORAGE_KEY);
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
  volatileRecord = record;
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(record));
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
    || !(typeof record.orderId === 'string' || record.orderId === null)
    || !(typeof record.paymentId === 'string' || record.paymentId === null)
    || !Number.isSafeInteger(record.amountMinor) || Number(record.amountMinor) < 0
    || typeof record.currency !== 'string' || typeof record.mallName !== 'string'
    || typeof record.createdAt !== 'string' || typeof record.updatedAt !== 'string'
    || typeof record.idempotencyKey !== 'string' || typeof record.cartFingerprint !== 'string'
    || (record.checkoutAddressId !== undefined && typeof record.checkoutAddressId !== 'string')
    || (record.checkoutFailure !== undefined && record.checkoutFailure !== 'cart-changed')
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
