import { PAYMENT_STATUS, PERMISSIONS, toPaymentStatus } from '@smart-wing/api-contract';
import { authorize, can } from './auth';
import { sha256 } from './crypto';
import { apiError, json, methodNotAllowed } from './http';
import { requirePhoneVerified } from './identityAssurance';
import { authorizationEvidence, authorizationScope, loadResourceScope } from './routerSupport';
import { callRpc } from './postgresRpc';
import type { AuthorizationContext, WorkerEnv } from './types';
import { createJsapiPrepay, queryWechatPayTransaction } from './wechatPayClient';
import { loadWechatPayConfig, WechatPayConfigurationError } from './wechatPayConfig';
import { createMiniappPaymentParameters, sha256Hex } from './wechatPayCrypto';
import { createWechatPayDescription, WechatPayProtocolError, type WechatPayTransaction } from './wechatPayModels';

const PREPAY_LIFETIME_MS = 2 * 60 * 60 * 1_000;

interface PrepayAttempt {
  attemptId: string;
  paymentId: string;
  orderId: string;
  orderNo: string;
  totalCents: number;
  openid: string;
  productNames: string[];
  description: string;
  existingPrepayId: string | null;
  existingExpiresAt: string | null;
  status: string;
}

interface StoredPaymentStatus extends Record<string, unknown> {
  orderId: string;
  orderNo: string;
  orderStatus: string;
  paymentStatus: string;
  needsQuery: boolean;
}

export async function handleOrderByNumber(request: Request, env: WorkerEnv, authorization: AuthorizationContext, orderNo: string, requestId: string): Promise<Response> {
  if (request.method !== 'GET') return methodNotAllowed(['GET'], requestId);
  if (!can(authorization, PERMISSIONS.orderRead)) {
    return apiError(403, 'FORBIDDEN', '没有查看订单的权限', requestId);
  }
  if (!isOrderNumber(orderNo)) return apiError(422, 'INVALID_ORDER_NO', '订单编号无效', requestId);
  const detail = await callRpc<Record<string, unknown> | null>(env, 'api_order_detail_by_no', {
    ...authorizationScope(authorization, true),
    p_membership_id: authorization.membership.id,
    p_order_no: orderNo,
  });
  if (!detail) return apiError(404, 'ORDER_NOT_FOUND', '订单不存在', requestId);
  const payment = isRecord(detail.wechatPayment) ? detail.wechatPayment : null;
  return json({
    order: {
      ...detail,
      paymentStatus: toPaymentStatus(payment?.status, detail.status),
    },
    requestId,
  });
}

export async function handleWechatPrepay(request: Request, env: WorkerEnv, authorization: AuthorizationContext, orderId: string, requestId: string): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed(['POST'], requestId);
  const assuranceError = await requirePhoneVerified(env, authorization, requestId);
  if (assuranceError) return assuranceError;
  const idempotencyKey = request.headers.get('idempotency-key')?.trim() ?? '';
  if (idempotencyKey.length < 8 || idempotencyKey.length > 120) {
    return apiError(400, 'IDEMPOTENCY_KEY_REQUIRED', '支付必须提供有效的 Idempotency-Key', requestId);
  }

  let config;
  try {
    config = loadWechatPayConfig(env);
  } catch (error) {
    return paymentFailure(error, requestId);
  }

  const orderScope = await loadResourceScope(env, 'api_order_authorization_scope', orderId);
  const decision = orderScope ? authorize(authorization, PERMISSIONS.orderCreate, orderScope) : null;
  if (!decision?.allowed) return apiError(403, 'FORBIDDEN', '没有支付该订单的权限', requestId);

  const requestHash = await sha256(JSON.stringify({ orderId, appId: config.appId, mchId: config.mchId }));
  const rawAttempt = await callRpc<unknown>(env, 'api_create_wechat_prepay_attempt', {
    ...authorizationScope(authorization, true),
    p_order_id: orderId,
    p_app_id: config.appId,
    p_mch_id: config.mchId,
    p_idempotency_key: idempotencyKey,
    p_request_hash: requestHash,
    p_request_id: requestId,
    p_user_agent: (request.headers.get('user-agent') ?? '').slice(0, 300),
    p_membership_id: authorization.membership.id,
    p_granted_via: authorizationEvidence(authorization, decision),
  });
  const attempt = parsePrepayAttempt(rawAttempt);
  if (!attempt) return apiError(502, 'WECHAT_PAY_STATE_INVALID', '支付状态异常，系统已阻止发起支付', requestId);
  if (attempt.status === 'succeeded') return apiError(409, 'ORDER_ALREADY_PAID', '订单已经支付', requestId);

  try {
    const reusable = reusablePrepayId(attempt);
    const provider = reusable
      ? { prepayId: reusable, providerRequestId: null }
      : await createJsapiPrepay(config, {
          description: attempt.description || createWechatPayDescription(attempt.productNames),
          outTradeNo: attempt.orderNo,
          totalCents: attempt.totalCents,
          payerOpenid: attempt.openid,
        });
    const expiresAt = reusable && attempt.existingExpiresAt ? attempt.existingExpiresAt : new Date(Date.now() + PREPAY_LIFETIME_MS).toISOString();
    if (!reusable) {
      await callRpc(env, 'api_record_wechat_prepay_result', {
        p_attempt_id: attempt.attemptId,
        p_prepay_id: provider.prepayId,
        p_expires_at: expiresAt,
        p_provider_request_id: provider.providerRequestId ?? '',
      });
    }
    const parameters = await createMiniappPaymentParameters(config, provider.prepayId);
    return json(
      {
        orderId: attempt.orderId,
        orderNo: attempt.orderNo,
        paymentId: attempt.paymentId,
        status: PAYMENT_STATUS.pending,
        expiresAt,
        ...parameters,
        requestId,
      },
      { status: reusable ? 200 : 201 }
    );
  } catch (error) {
    const code = safeProviderErrorCode(error);
    await callRpc(env, 'api_mark_wechat_prepay_failed', {
      p_attempt_id: attempt.attemptId,
      p_error_code: code,
      p_request_id: requestId,
    }).catch(() => undefined);
    return paymentFailure(error, requestId);
  }
}

export async function handleWechatPaymentStatus(request: Request, env: WorkerEnv, authorization: AuthorizationContext, orderId: string, requestId: string): Promise<Response> {
  if (request.method !== 'GET') return methodNotAllowed(['GET'], requestId);
  if (!can(authorization, PERMISSIONS.orderRead)) {
    return apiError(403, 'FORBIDDEN', '没有查看订单支付状态的权限', requestId);
  }
  let state = await loadPaymentStatus(env, authorization, orderId);
  if (!state) return apiError(404, 'ORDER_NOT_FOUND', '订单不存在', requestId);

  let providerSync: 'not_needed' | 'confirmed' | 'deferred' = 'not_needed';
  if (state.needsQuery && isOrderNumber(state.orderNo)) {
    try {
      const config = loadWechatPayConfig(env);
      const result = await queryWechatPayTransaction(config, state.orderNo);
      await recordProviderQuery(env, result.transaction, requestId);
      state = (await loadPaymentStatus(env, authorization, orderId)) ?? state;
      providerSync = 'confirmed';
    } catch {
      // The database remains authoritative while provider reconciliation retries later.
      providerSync = 'deferred';
    }
  }

  return json({
    ...state,
    status: toPaymentStatus(state.paymentStatus, state.orderStatus),
    providerSync,
    requestId,
  });
}

async function loadPaymentStatus(env: WorkerEnv, authorization: AuthorizationContext, orderId: string): Promise<StoredPaymentStatus | null> {
  const value = await callRpc<unknown>(env, 'api_wechat_payment_status', {
    ...authorizationScope(authorization, true),
    p_membership_id: authorization.membership.id,
    p_order_id: orderId,
  });
  if (!isRecord(value) || typeof value.orderId !== 'string' || typeof value.orderNo !== 'string' || typeof value.orderStatus !== 'string') return null;
  return {
    ...value,
    orderId: value.orderId,
    orderNo: value.orderNo,
    orderStatus: value.orderStatus,
    paymentStatus: typeof value.paymentStatus === 'string' ? value.paymentStatus : 'not_started',
    needsQuery: value.needsQuery === true,
  };
}

async function recordProviderQuery(env: WorkerEnv, transaction: WechatPayTransaction, requestId: string): Promise<void> {
  const payerOpenidHash = transaction.payerOpenid ? await sha256Hex(transaction.payerOpenid) : null;
  await callRpc(env, 'api_apply_wechat_payment_query', {
    p_query_key: `${requestId}:${transaction.outTradeNo}`,
    p_app_id: transaction.appId,
    p_mch_id: transaction.mchId,
    p_out_trade_no: transaction.outTradeNo,
    p_transaction_id: transaction.transactionId ?? '',
    p_trade_state: transaction.tradeState,
    p_success_time: transaction.successTime,
    p_amount_total: transaction.amount.total,
    p_payer_openid_hash: payerOpenidHash,
    p_raw_summary: {
      outTradeNo: transaction.outTradeNo,
      transactionId: transaction.transactionId,
      tradeState: transaction.tradeState,
      successTime: transaction.successTime,
      totalCents: transaction.amount.total,
      currency: transaction.amount.currency,
    },
    p_request_id: requestId,
  });
}

function parsePrepayAttempt(value: unknown): PrepayAttempt | null {
  if (!isRecord(value)) return null;
  const productNames = Array.isArray(value.productNames) ? value.productNames.filter((name): name is string => typeof name === 'string') : [];
  if (
    typeof value.attemptId !== 'string' ||
    typeof value.paymentId !== 'string' ||
    typeof value.orderId !== 'string' ||
    typeof value.orderNo !== 'string' ||
    !Number.isSafeInteger(value.totalCents) ||
    (value.totalCents as number) <= 0 ||
    typeof value.openid !== 'string' ||
    typeof value.status !== 'string'
  ) {
    return null;
  }
  return {
    attemptId: value.attemptId,
    paymentId: value.paymentId,
    orderId: value.orderId,
    orderNo: value.orderNo,
    totalCents: value.totalCents as number,
    openid: value.openid,
    productNames,
    description: typeof value.description === 'string' ? value.description : '',
    existingPrepayId: typeof value.existingPrepayId === 'string' ? value.existingPrepayId : null,
    existingExpiresAt: typeof value.existingExpiresAt === 'string' ? value.existingExpiresAt : null,
    status: value.status,
  };
}

function reusablePrepayId(attempt: PrepayAttempt): string | null {
  if (!attempt.existingPrepayId || !attempt.existingExpiresAt || attempt.status !== 'prepay_ready') return null;
  const expiresAt = new Date(attempt.existingExpiresAt).getTime();
  return Number.isFinite(expiresAt) && expiresAt > Date.now() + 60_000 ? attempt.existingPrepayId : null;
}

function paymentFailure(error: unknown, requestId: string): Response {
  if (error instanceof WechatPayConfigurationError) {
    return apiError(503, 'WECHAT_PAYMENT_NOT_CONFIGURED', '微信支付商户配置尚未完成', requestId);
  }
  if (error instanceof WechatPayProtocolError) {
    return apiError(error.retryable ? 503 : 502, 'WECHAT_PAY_UNAVAILABLE', '微信支付暂时不可用，请稍后重试', requestId);
  }
  return apiError(502, 'WECHAT_PAY_UNAVAILABLE', '微信支付暂时不可用，请稍后重试', requestId);
}

function safeProviderErrorCode(error: unknown): string {
  const raw = error instanceof WechatPayProtocolError ? error.code : 'WECHAT_PAY_UNAVAILABLE';
  return raw.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 120) || 'WECHAT_PAY_UNAVAILABLE';
}

function isOrderNumber(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{5,63}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
