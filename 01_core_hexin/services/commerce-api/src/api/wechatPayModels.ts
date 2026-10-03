const TRADE_STATES = ['SUCCESS', 'REFUND', 'NOTPAY', 'CLOSED', 'REVOKED', 'USERPAYING', 'PAYERROR', 'ACCEPT'] as const;

export type WechatPayTradeState = (typeof TRADE_STATES)[number];
export type LocalWechatPaymentStatus = 'pending' | 'paid' | 'closed' | 'failed' | 'refunded';

export interface WechatPayTransaction {
  appId: string;
  mchId: string;
  outTradeNo: string;
  transactionId: string | null;
  tradeType: string;
  tradeState: WechatPayTradeState;
  tradeStateDescription: string;
  successTime: string | null;
  payerOpenid: string | null;
  amount: {
    total: number;
    payerTotal: number | null;
    currency: 'CNY';
    payerCurrency: 'CNY' | null;
  };
}

export class WechatPayProtocolError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly providerRequestId: string | null;

  constructor(code: string, options: { retryable?: boolean; providerRequestId?: string | null } = {}) {
    super('WeChat Pay request could not be completed safely');
    this.name = 'WechatPayProtocolError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.providerRequestId = options.providerRequestId ?? null;
  }
}

export function parseWechatPayTransaction(value: unknown): WechatPayTransaction {
  const record = asRecord(value, 'WECHAT_PAY_TRANSACTION_INVALID');
  const amount = asRecord(record.amount, 'WECHAT_PAY_TRANSACTION_AMOUNT_INVALID');
  const tradeState = requiredString(record.trade_state, 'WECHAT_PAY_TRADE_STATE_INVALID');
  if (!isTradeState(tradeState)) throw new WechatPayProtocolError('WECHAT_PAY_TRADE_STATE_UNSUPPORTED');
  const total = requiredNonNegativeInteger(amount.total, 'WECHAT_PAY_TRANSACTION_TOTAL_INVALID');
  const currency = requiredString(amount.currency, 'WECHAT_PAY_TRANSACTION_CURRENCY_INVALID');
  if (currency !== 'CNY') throw new WechatPayProtocolError('WECHAT_PAY_TRANSACTION_CURRENCY_UNSUPPORTED');
  const payer = optionalRecord(record.payer);
  const payerCurrency = optionalString(amount.payer_currency);
  if (payerCurrency !== null && payerCurrency !== 'CNY') {
    throw new WechatPayProtocolError('WECHAT_PAY_PAYER_CURRENCY_UNSUPPORTED');
  }
  const transaction: WechatPayTransaction = {
    appId: requiredString(record.appid, 'WECHAT_PAY_TRANSACTION_APP_ID_INVALID'),
    mchId: requiredString(record.mchid, 'WECHAT_PAY_TRANSACTION_MCH_ID_INVALID'),
    outTradeNo: requiredString(record.out_trade_no, 'WECHAT_PAY_OUT_TRADE_NO_INVALID'),
    transactionId: optionalString(record.transaction_id),
    tradeType: requiredString(record.trade_type, 'WECHAT_PAY_TRADE_TYPE_INVALID'),
    tradeState,
    tradeStateDescription: requiredString(record.trade_state_desc, 'WECHAT_PAY_TRADE_STATE_DESCRIPTION_INVALID'),
    successTime: optionalString(record.success_time),
    payerOpenid: payer ? optionalString(payer.openid) : null,
    amount: {
      total,
      payerTotal: optionalNonNegativeInteger(amount.payer_total),
      currency: 'CNY',
      payerCurrency,
    },
  };
  if (!isWechatPayOutTradeNo(transaction.outTradeNo)) throw new WechatPayProtocolError('WECHAT_PAY_OUT_TRADE_NO_INVALID');
  if (transaction.tradeState === 'SUCCESS') assertSuccessfulTransaction(transaction);
  return transaction;
}

export function mapWechatPayTradeState(state: WechatPayTradeState): LocalWechatPaymentStatus {
  switch (state) {
    case 'SUCCESS':
      return 'paid';
    case 'REFUND':
      return 'refunded';
    case 'CLOSED':
    case 'REVOKED':
      return 'closed';
    case 'PAYERROR':
      return 'failed';
    case 'NOTPAY':
    case 'USERPAYING':
    case 'ACCEPT':
      return 'pending';
  }
}

export function createWechatPayDescription(productNames: readonly string[]): string {
  const normalized = productNames
    .map((name) =>
      name
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    )
    .filter(Boolean);
  const distinct = [...new Set(normalized)];
  const itemText = distinct.length === 0 ? '福利商品' : distinct.slice(0, 2).join('、');
  const suffix = distinct.length > 2 ? `等${distinct.length}种商品` : '';
  return truncateCodePoints(`MORVIA 主打团-${itemText}${suffix}`, 127);
}

export function isWechatPayOutTradeNo(value: string): boolean {
  return /^[A-Za-z0-9_\-|*]{6,32}$/.test(value);
}

function assertSuccessfulTransaction(transaction: WechatPayTransaction): void {
  if (!transaction.transactionId || !transaction.successTime || !transaction.payerOpenid || transaction.amount.total <= 0) {
    throw new WechatPayProtocolError('WECHAT_PAY_SUCCESS_TRANSACTION_INCOMPLETE');
  }
}

function isTradeState(value: string): value is WechatPayTradeState {
  return (TRADE_STATES as readonly string[]).includes(value);
}

function asRecord(value: unknown, code: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new WechatPayProtocolError(code);
  return value as Record<string, unknown>;
}

function optionalRecord(value: unknown): Record<string, unknown> | null {
  return value === undefined || value === null ? null : asRecord(value, 'WECHAT_PAY_TRANSACTION_PAYER_INVALID');
}

function requiredString(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) throw new WechatPayProtocolError(code);
  return value;
}

function optionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return requiredString(value, 'WECHAT_PAY_TRANSACTION_FIELD_INVALID');
}

function requiredNonNegativeInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new WechatPayProtocolError(code);
  return value as number;
}

function optionalNonNegativeInteger(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  return requiredNonNegativeInteger(value, 'WECHAT_PAY_TRANSACTION_AMOUNT_INVALID');
}

function truncateCodePoints(value: string, maximum: number): string {
  return Array.from(value).slice(0, maximum).join('');
}
