import { randomUUID } from 'node:crypto';
import type { OperationId } from '@shop/contract';
import { token } from '../../bootstrap/Container';
import type { ModuleContext } from '../../bootstrap/ModuleRegistry';
import type { OperationResult, OperationUsecase } from '../../foundation/application/OperationHandler';
import type { OperationAction } from '../../foundation/application/ModuleOperations';
import { AUDIT_SINK } from '../../foundation/application/AuditSink';
import { domainEvent } from '../../foundation/domain/DomainEvent';
import { appendOutbox } from '../../foundation/infrastructure/OutboxStore';
import { KMS_CLIENT } from '../../foundation/infrastructure/KmsClient';
import { ModuleOperations, requireAccess, type OperationDatabase } from '../../foundation/application/ModuleOperations';
import { bodyRecord, textField } from '../../foundation/interface/Validation';
import { DATABASE_POOL } from '../../foundation/persistence/Pool';
import { DECISION_SINK, type DecisionSink } from '../../foundation/security/DecisionSink';
import { assertRiskAllowed, RISK_GATE, type RiskGate } from '../../foundation/security/RiskGate';
import { CheckoutPort } from '../checkout_jiesuan';
import { QuoteReader } from '../checkout_jiesuan';
import type { CheckoutQuote } from '../checkout_jiesuan';
import { FulfillmentPort } from '../fulfillment';
import { InventoryPort } from '../inventory';
import { MarketingPort } from '../marketing';
import { applyAftersale, OrderPort, PlaceOrder } from '../order_dingdan';
import { PaymentSettlementCore } from '../payment_zhifu';
import { ExternalPaymentIntentOperations } from '../payment_zhifu';
import { paymentIntentReadOperations } from '../payment_zhifu';
import { PAYMENT_GATEWAY } from '../payment_zhifu';
import type { PaymentGateway } from '../payment_zhifu';
import { pricingPort } from '../pricing';
import { PurchaseBenefitGateway } from './PurchaseBenefitGateway';
import { DisabledPurchaseVoucherGateway } from './DisabledPurchaseVoucherGateway';
import { PurchaseCheckoutContext } from './PurchaseCheckoutContext';
import { PurchaseOrderQuoteStore } from './PurchaseOrderQuoteStore';
import { PurchasePaymentIntentContext } from './PurchasePaymentIntentContext';
import { PurchasePaymentRecoveryQueue } from './PurchasePaymentRecoveryQueue';
import {
  assertPurchaseQuote,
  assertInternalIntent,
  assertPurchaseAssurance,
  assertPurchaseTarget,
  type InternalIntent,
} from './PurchasePolicy';

export const PURCHASE_ORDER_OPERATION_IDS = Object.freeze([
  'order.orders.create',
  'order.aftersales.apply',
] as const satisfies readonly OperationId[]);

export const PURCHASE_OPERATION_IDS = Object.freeze([
  'checkout.quote.create',
  ...PURCHASE_ORDER_OPERATION_IDS,
  'payment.intents.create',
  'payment.intents.read',
] as const satisfies readonly OperationId[]);

export const PURCHASE_QUOTE_KEY = token<string>('purchase.quote-key');

export function purchaseCheckoutOperations(context: ModuleContext): ModuleOperations {
  const pool = context.container.get(DATABASE_POOL);
  const quoteKey = context.container.get(PURCHASE_QUOTE_KEY);
  return new ModuleOperations('checkout', pool, context.container.get(AUDIT_SINK), {
    'checkout.quote.create': async (request, database) => {
      const access = requireAccess(request);
      assertPurchaseTarget(access.actor.target);
      const voucher = new DisabledPurchaseVoucherGateway();
      const benefit = new PurchaseBenefitGateway(access.membership.id, access.actor.session);
      const checkout = new CheckoutPort(quoteKey, new QuoteReader(benefit, voucher, undefined,
        new PurchaseCheckoutContext(access.actor.session)));
      const selection = checkout.selection(bodyRecord(request));
      const quote = await checkout.read(database, access.membership.id, selection);
      assertPurchaseQuote(quote);
      if (request.input.expectedVersion !== undefined && request.input.expectedVersion !== quote.cart.version) {
        throw new Error('CHECKOUT_VERSION_CONFLICT:cart');
      }
      return saveQuote(request, database, checkout, quote);
    },
  }, ['checkout.quote.create']);
}

export function purchaseOrderOperations(context: ModuleContext): ModuleOperations {
  const pool = context.container.get(DATABASE_POOL);
  const quoteKey = context.container.get(PURCHASE_QUOTE_KEY);
  return new ModuleOperations('order', pool, context.container.get(AUDIT_SINK), {
    'order.orders.create': async (request, database) => {
      const access = requireAccess(request);
      assertPurchaseTarget(access.actor.target);
      assertPurchaseAssurance(access.assurance.level);
      const quoteid = textField(bodyRecord(request), 'quote');
      const stored = await database.query<{ signed_payload: CheckoutQuote }>(`select quote.signed_payload from pricing.quote quote
        join checkout.session checkout on checkout.quote_id=quote.id and checkout.member_id=quote.member_id and checkout.mall_id=quote.mall_id
        where quote.id=$1 and access.purchase_member_mall_allowed(checkout.member_id,checkout.mall_id)
          and checkout.state='quoted' and checkout.expires_at>clock_timestamp() and quote.expires_at>clock_timestamp()`,
      [quoteid]);
      const quote = stored.rows[0]?.signed_payload;
      if (!quote) throw new Error('QUOTE_EXPIRED_OR_CONFLICT');
      assertPurchaseQuote(quote);
      const voucher = new DisabledPurchaseVoucherGateway();
      const benefit = new PurchaseBenefitGateway(access.membership.id, access.actor.session);
      const checkout = new CheckoutPort(quoteKey, new QuoteReader(benefit, voucher, undefined,
        new PurchaseCheckoutContext(access.actor.session)));
      const result = await new PlaceOrder(checkout, benefit, voucher,
        new PurchaseOrderQuoteStore(access.actor.session)).execute(request, database);
      return purchaseOrderResponse(result);
    },
    'order.aftersales.apply': applyAftersale,
  }, PURCHASE_ORDER_OPERATION_IDS);
}

interface InternalSettlement {
  capture: PaymentSettlementCore['capture'];
}

export type InternalSettlementFactory = (benefit: PurchaseBenefitGateway) => InternalSettlement;

export function purchasePaymentOperations(context: ModuleContext,
  settlementFactory: InternalSettlementFactory = internalSettlement): OperationUsecase {
  const pool = context.container.get(DATABASE_POOL);
  const gateway = context.container.get(PAYMENT_GATEWAY);
  const risk = context.container.get(RISK_GATE);
  const decisions = context.container.get(DECISION_SINK);
  const audit = context.container.get(AUDIT_SINK);
  const internal = new ModuleOperations('payment', pool, audit, {
    'payment.intents.create': purchasePaymentAction(gateway, risk, decisions, settlementFactory),
  }, ['payment.intents.create']);
  const read = paymentIntentReadOperations(context);
  const external = new ExternalPaymentIntentOperations(pool.workload('command'), gateway, context.container.get(KMS_CLIENT), audit,
    new PurchasePaymentIntentContext(), new PurchasePaymentRecoveryQueue());
  return {
    async invoke(request) {
      if (request.type === 'payment.intents.read') return read.invoke(request);
      try {
        return await external.invoke(request);
      } catch (cause) {
        if (!(cause instanceof Error) || cause.message !== 'PAYMENT_EXTERNAL_TENDER_REQUIRED') throw cause;
        return internal.invoke(request);
      }
    },
  };
}

export function purchasePaymentAction(gateway: PaymentGateway, risk: RiskGate, decisions: DecisionSink,
  settlementFactory: InternalSettlementFactory = internalSettlement): OperationAction {
  return async (request, database) => {
      const access = requireAccess(request);
      assertPurchaseTarget(access.actor.target);
      assertPurchaseAssurance(access.assurance.level);
      const body = bodyRecord(request);
      const order = textField(body, 'order');
      const scene = textField(body, 'scene', 16);
      if (scene !== 'miniapp' && scene !== 'jsapi') throw new Error('PAYMENT_SCENE_INVALID');
      const selected = await database.query<InternalIntent>(`select intent.id intent,intent.order_id,orders.scope_id,orders.mall_id,orders.member_id,
        intent.currency,intent.amount_minor::float8 amount_minor,intent.state,
        (select count(*)::integer from payment.intenttender tender where tender.intent_id=intent.id) tender_count,
        (select coalesce(sum(tender.amount_minor),0)::float8 from payment.intenttender tender where tender.intent_id=intent.id) tender_total,
        (select count(*)::integer from payment.intenttender tender where tender.intent_id=intent.id
          and tender.kind<>'benefit') unsupported_tenders
        from ordering.orderrecord orders join payment.intent intent on intent.order_id=orders.id
        where orders.id=$1 and access.purchase_member_mall_allowed(orders.member_id,orders.mall_id)
          and orders.payment_state in('unpaid','authorizing') for update of orders,intent`,
      [order]);
      if (selected.rows.length !== 1) throw new Error('PAYMENT_INTENT_CARDINALITY_INVALID');
      const intent = selected.rows[0];
      assertInternalIntent(intent);
      const assessment = await risk.evaluate({ actor: access.actor, operation: request.type, scope: access.scope, trace: access.trace,
        resource: order, amountMinor: intent.amount_minor });
      await decisions.append({ actor: access.actor, operation: request.type, scope: access.scope, trace: access.trace, resource: order,
        outcome: assessment.outcome, reason: `AMOUNT_RISK_${assessment.outcome.toUpperCase()}_${assessment.safeReason.toUpperCase()}` });
      assertRiskAllowed(assessment.outcome);
      gateway.application(scene);
      const benefit = new PurchaseBenefitGateway(access.membership.id, access.actor.session, intent.intent);
      const payment = await settlementFactory(benefit).capture(database, {
        intent: intent.intent,
        order: intent.order_id,
        scope: intent.scope_id,
        mall: intent.mall_id,
        member: intent.member_id,
        amountMinor: intent.amount_minor,
        currency: intent.currency,
      }, 'internal');
      return { status: 200, body: { intent: intent.intent, payment, state: 'captured' } };
  };
}

export function purchaseOrderResponse(result: OperationResult): OperationResult {
  const source = object(result.body, 'order');
  const payment = object(source.payment, 'order.payment');
  return {
    status: result.status,
    body: {
      id: requiredText(source.id, 'order.id'),
      orderNumber: requiredText(source.order_number, 'order.order_number'),
      paymentState: requiredText(source.payment_state, 'order.payment_state'),
      fulfillmentState: requiredText(source.fulfillment_state, 'order.fulfillment_state'),
      aftersaleState: requiredText(source.aftersale_state, 'order.aftersale_state'),
      lifecycleState: requiredText(source.lifecycle_state, 'order.lifecycle_state'),
      version: nonnegativeInteger(source.version, 'order.version'),
      payment: {
        intent: requiredText(payment.intent, 'order.payment.intent'),
        personalMinor: nonnegativeInteger(payment.personalMinor, 'order.payment.personalMinor'),
        action: requiredText(payment.action, 'order.payment.action'),
      },
    },
    ...(result.headers === undefined ? {} : { headers: result.headers }),
  };
}

function internalSettlement(benefit: PurchaseBenefitGateway): InternalSettlement {
  const voucher = new DisabledPurchaseVoucherGateway();
  return new PaymentSettlementCore(
    benefit,
    voucher,
    new InventoryPort(),
    new MarketingPort(),
    new FulfillmentPort(),
    new OrderPort(),
  );
}

async function saveQuote(request: Parameters<ModuleOperations['invoke']>[0], database: OperationDatabase,
  checkout: CheckoutPort, quote: CheckoutQuote) {
  const access = requireAccess(request);
  const quoteid = `quote:${randomUUID()}`;
  const checkoutid = `checkout:${randomUUID()}`;
  const signature = checkout.sign(quote);
  const evidenceHash = checkout.digest(quote.evidence);
  const expires = new Date(Date.now() + 15 * 60_000).toISOString();
  await pricingPort.saveQuote(database, { id: quoteid, member: quote.cart.member, mall: quote.cart.mall, currency: quote.currency,
    subtotalMinor: quote.subtotalMinor, discountMinor: quote.discountMinor, payableMinor: quote.payableMinor, lines: quote.lines,
    evidenceHash, evidence: quote.evidence, payload: quote, signature, expiresAt: expires });
  const created = await database.query(`insert into checkout.session(id,cart_id,member_id,mall_id,application_id,quote_id,quote_hash,address_id,
    input,state,expires_at,created_at,version) values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,'quoted',$10,clock_timestamp(),0)
    returning id,quote_id,quote_hash,state,expires_at,version`, [checkoutid, quote.cart.id, quote.cart.member, quote.cart.mall,
    quote.cart.application, quoteid, signature, quote.selection.address, JSON.stringify(quote.selection), expires]);
  await saveEvidence(database, checkoutid, quote.evidence, expires, checkout);
  await appendOutbox(database, domainEvent({ event: `event:${randomUUID()}`, type: 'checkout.quote.created', version: 1,
    aggregate: { type: 'checkout', id: checkoutid }, tenant: quote.cart.mall, occurred: new Date().toISOString(), trace: access.trace,
    payload: { checkout: checkoutid, quote: quoteid, member: quote.cart.member, mall: quote.cart.mall, payableMinor: quote.payableMinor,
      personalMinor: quote.personalMinor, currency: quote.currency, expiresAt: expires, evidenceHash } }));
  return { status: 201, body: { ...created.rows[0], quote: { id: quoteid, subtotalMinor: quote.subtotalMinor,
    discountMinor: quote.discountMinor, payableMinor: quote.payableMinor, personalMinor: quote.personalMinor, currency: quote.currency,
    lines: quote.lines, tenders: quote.tenders, rejections: quote.rejections } }, headers: { etag: '"0"' } } as const;
}

async function saveEvidence(database: OperationDatabase, checkoutid: string, evidence: Readonly<Record<string, unknown>>,
  expires: string, checkout: CheckoutPort): Promise<void> {
  for (const [kind, value] of Object.entries(evidence).sort(([left], [right]) => left.localeCompare(right))) {
    const records = Array.isArray(value) ? value : value === null ? [] : [value];
    for (let index = 0; index < records.length; index += 1) {
      const payload = records[index];
      const record = payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
      const reference = typeof record.id === 'string' ? record.id : `${checkoutid}:${kind}:${index}`;
      const version = String(record.version ?? record.hash ?? '1');
      await database.query(`insert into checkout.evidence(checkout_id,kind,reference_id,version,payload_hash,expires_at)
        values($1,$2,$3,$4,$5,$6)`, [checkoutid, kind, reference, version, checkout.digest(payload), expires]);
    }
  }
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`PURCHASE_RESPONSE_INVALID:${field}`);
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`PURCHASE_RESPONSE_INVALID:${field}`);
  return value;
}

function nonnegativeInteger(value: unknown, field: string): number {
  const normalized = typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(normalized) || (normalized as number) < 0) throw new Error(`PURCHASE_RESPONSE_INVALID:${field}`);
  return normalized as number;
}
