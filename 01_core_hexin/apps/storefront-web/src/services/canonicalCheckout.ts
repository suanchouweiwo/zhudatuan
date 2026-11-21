import { canonicalCall, canonicalClient, sessionContext } from './canonicalApiClient';
import { nonNegativeInteger, record, records, text, version } from './canonicalShape';
import { ProductionApiError } from './productionApi.error';
import { requestWechatJsapiPayment, type WechatJsapiPaymentOutcome } from './wechatJsapiPayment';

export interface CanonicalPaymentProgress {
  readonly stage: 'creating-payment' | 'opening-wechat' | 'wechat-active' | 'verifying' | 'recovery' | 'captured';
  readonly orderId: string;
  readonly paymentId: string | null;
  readonly amountMinor: number;
  readonly currency: string;
}

export interface CanonicalCheckoutInput {
  readonly addressId: string;
  readonly items: readonly Readonly<{ listingId: string; quantity: number }>[];
  readonly idempotencyKey: string;
  readonly onPaymentProgress?: (progress: CanonicalPaymentProgress) => void | Promise<void>;
}

export interface CanonicalCheckoutResult {
  readonly orderId: string;
  readonly paymentId: string;
  readonly paymentState: 'captured' | 'authorizing' | 'reconciling';
  readonly wechatOutcome?: WechatJsapiPaymentOutcome;
}

export interface CanonicalPaymentContinuationInput {
  readonly orderId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly idempotencyKey: string;
  readonly onPaymentProgress?: CanonicalCheckoutInput['onPaymentProgress'];
}

export async function checkoutWithCanonicalPayment(input: CanonicalCheckoutInput): Promise<CanonicalCheckoutResult> {
  const client = canonicalClient();
  const [cartValue, accountValue] = await Promise.all([
    canonicalCall(() => client.cart.currentRead({}, sessionContext())),
    canonicalCall(() => client.benefit.accountsRead({ query: { limit: 100 } }, sessionContext())),
  ]);
  const cart = record(cartValue, 'cart.current');
  assertCartMatches(records(cart.items ?? [], 'cart.current.items'), input.items);
  const benefits = benefitChoices(accountValue);
  const quoteValue = await canonicalCall(() => client.checkout.quoteCreate({
    body: { address: input.addressId, invoice: null, delivery: {}, vouchers: [], benefits, items: input.items },
  }, sessionContext({ write: true, idempotencyKey: `${input.idempotencyKey}:quote`, expectedVersion: version(cart.version ?? 0, 'cart.current.version') })));
  const quoteEnvelope = record(quoteValue, 'checkout.quote');
  const quote = record(quoteEnvelope.quote, 'checkout.quote.quote');
  const rejections = records(quote.rejections ?? [], 'checkout.quote.rejections');
  if (rejections.length > 0) {
    throw new ProductionApiError('购物车中存在后端拒绝结算的商品，请刷新后重试', 409, 'CHECKOUT_REJECTED');
  }
  assertCartMatches(records(quote.lines, 'checkout.quote.lines'), input.items, true);
  const personalMinor = nonNegativeInteger(quote.personalMinor, 'checkout.quote.personalMinor');

  const orderValue = await canonicalCall(() => client.order.ordersCreate({ body: { quote: text(quote.id, 'checkout.quote.id') } }, sessionContext({
    write: true,
    idempotencyKey: `${input.idempotencyKey}:order`,
  })));
  const order = record(orderValue, 'order.create');
  const paymentPlan = record(order.payment, 'order.create.payment');
  if (nonNegativeInteger(paymentPlan.personalMinor, 'order.create.payment.personalMinor') !== personalMinor) {
    throw new ProductionApiError('订单支付计划与报价不一致，请刷新后重试', 409, 'PAYMENT_PLAN_CHANGED');
  }
  const orderId = text(order.id, 'order.create.id');
  await notify(input.onPaymentProgress, { stage: 'creating-payment', orderId, paymentId: null, amountMinor: personalMinor, currency: 'CNY' });
  const paymentValue = await canonicalCall(() => client.payment.intentsCreate({ body: { order: orderId, scene: 'jsapi' } }, sessionContext({
    write: true,
    idempotencyKey: `${input.idempotencyKey}:payment`,
  })));
  return resolvePaymentIntent(paymentValue, {
    orderId, amountMinor: personalMinor, currency: 'CNY', onPaymentProgress: input.onPaymentProgress,
  });
}

export async function continueWithCanonicalPayment(input: CanonicalPaymentContinuationInput): Promise<CanonicalCheckoutResult> {
  const paymentValue = await canonicalCall(() => canonicalClient().payment.intentsCreate({
    body: { order: input.orderId, scene: 'jsapi' },
  }, sessionContext({ write: true, idempotencyKey: input.idempotencyKey })));
  return resolvePaymentIntent(paymentValue, input);
}

async function resolvePaymentIntent(
  paymentValue: unknown,
  input: Readonly<{
    orderId: string;
    amountMinor: number;
    currency: string;
    onPaymentProgress?: CanonicalCheckoutInput['onPaymentProgress'];
  }>,
): Promise<CanonicalCheckoutResult> {
  const payment = record(paymentValue, 'payment.intent');
  const paymentId = text(payment.intent, 'payment.intent.id');
  if (payment.state === 'captured') {
    await notify(input.onPaymentProgress, { ...input, stage: 'captured', paymentId });
    return Object.freeze({ orderId: input.orderId, paymentId, paymentState: 'captured' });
  }
  if (payment.parameters !== undefined) {
    await notify(input.onPaymentProgress, { ...input, stage: 'opening-wechat', paymentId });
    const wechatOutcome = await requestWechatJsapiPayment(payment.parameters, {
      onInvoked: () => notify(input.onPaymentProgress, { ...input, stage: 'wechat-active', paymentId }),
    });
    return Object.freeze({ orderId: input.orderId, paymentId, paymentState: 'authorizing', wechatOutcome });
  }
  if (payment.state === 'authorizing' || payment.state === 'reconciling') {
    await notify(input.onPaymentProgress, {
      ...input,
      stage: payment.state === 'reconciling' ? 'recovery' : 'verifying',
      paymentId,
    });
    return Object.freeze({ orderId: input.orderId, paymentId, paymentState: payment.state });
  }
  const state = typeof payment.state === 'string' ? payment.state : 'unknown';
  throw new ProductionApiError(`支付未完成，服务端状态为 ${state}`, 409, 'PAYMENT_NOT_STARTED');
}

async function notify(
  listener: CanonicalCheckoutInput['onPaymentProgress'],
  progress: CanonicalPaymentProgress,
): Promise<void> {
  await listener?.(Object.freeze(progress));
}

function assertCartMatches(
  serverItems: readonly Record<string, unknown>[],
  expectedItems: CanonicalCheckoutInput['items'],
  exact = false,
): void {
  const quantities = new Map(serverItems.map((item) => [
    text(item.listing, 'cart.item.listing'), nonNegativeInteger(item.quantity, 'cart.item.quantity'),
  ]));
  if ((exact && serverItems.length !== expectedItems.length) || expectedItems.some(({ listingId, quantity }) => quantities.get(listingId) !== quantity)) {
    throw new ProductionApiError('购物车已发生变化，请刷新后重新结算', 409, 'CART_CHANGED');
  }
}

function benefitChoices(value: unknown): Array<{ account: string; amountMinor: number }> {
  const source = record(value, 'benefit.accounts');
  return records(source.items ?? [], 'benefit.accounts.items').flatMap((item) => {
    const kind = typeof item.kind === 'string' ? item.kind : '';
    const amountMinor = nonNegativeInteger(item.available_minor, 'benefit.account.available_minor');
    if (!['welfare', 'meal', 'allowance'].includes(kind) || item.currency !== 'CNY' || amountMinor === 0) return [];
    return [{ account: text(item.id, 'benefit.account.id'), amountMinor }];
  });
}
