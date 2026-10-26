import { authorize } from './auth';
import { sha256 } from './crypto';
import { apiError, json, methodNotAllowed } from './http';
import { authorizationEvidence, authorizationScope, invalidBody, loadResourceScope, readJsonBody } from './routerSupport';
import { callRpc } from './postgresRpc';
import { parseSimulationBenefitInput, parseSimulationMixedPaymentInput, parseSimulationRechargeInput } from './validation';
import { PERMISSIONS } from '@smart-wing/api-contract';
import type { AuthorizationContext, WorkerEnv } from './types';

/**
 * The simulation surface is deliberately opt-in and environment-gated. It is
 * not a payment-provider integration and it cannot be enabled in production.
 */
export function isPaymentSimulationEnabled(env: WorkerEnv): boolean {
  return (env.APP_ENV === 'test' && env.AUTH_MODE === 'test') || (env.APP_ENV === 'development' && env.AUTH_MODE === 'development');
}

function simulationDisabled(requestId: string): Response {
  return apiError(404, 'SIMULATION_NOT_AVAILABLE', '测试资金接口仅在测试环境可用', requestId);
}

function idempotencyKey(request: Request, requestId: string): string | Response {
  const key = request.headers.get('idempotency-key');
  return key && key.length <= 120 ? key : apiError(400, 'IDEMPOTENCY_KEY_REQUIRED', '测试资金操作必须提供 Idempotency-Key', requestId);
}

export async function handleSimulationWallet(request: Request, env: WorkerEnv, authorization: AuthorizationContext, requestId: string): Promise<Response> {
  if (request.method !== 'GET') return methodNotAllowed(['GET'], requestId);
  if (!isPaymentSimulationEnabled(env)) return simulationDisabled(requestId);
  const wallet = await callRpc<Record<string, unknown>>(env, 'api_simulation_wallet', authorizationScope(authorization, true));
  return json({ ...wallet, requestId });
}

export async function handleSimulationRecharge(request: Request, env: WorkerEnv, authorization: AuthorizationContext, requestId: string): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed(['POST'], requestId);
  if (!isPaymentSimulationEnabled(env)) return simulationDisabled(requestId);
  const decision = authorize(authorization, PERMISSIONS.orderCreate);
  if (!decision.allowed) return apiError(403, 'FORBIDDEN', '没有为本人测试账户充值的权限', requestId);
  const key = idempotencyKey(request, requestId);
  if (typeof key !== 'string') return key;
  const body = await readJsonBody(request);
  if (!body.ok) return invalidBody(body.tooLarge, requestId);
  const input = parseSimulationRechargeInput(body.value);
  if (!input) return apiError(422, 'INVALID_SIMULATION_RECHARGE', '测试充值参数无效', requestId);
  const result = await callRpc<Record<string, unknown>>(env, 'api_simulate_recharge', {
    ...authorizationScope(authorization, true),
    p_account_type: input.accountType,
    p_channel: input.channel,
    p_amount_cents: input.amountCents,
    p_idempotency_key: key,
    p_request_hash: await sha256(JSON.stringify(input)),
    p_request_id: requestId,
    p_user_agent: (request.headers.get('user-agent') ?? '').slice(0, 300),
    p_membership_id: authorization.membership.id,
    p_granted_via: authorizationEvidence(authorization, decision),
  });
  return json({ ...result, requestId }, { status: 201 });
}

export async function handleSimulationBenefitIssue(request: Request, env: WorkerEnv, authorization: AuthorizationContext, requestId: string): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed(['POST'], requestId);
  if (!isPaymentSimulationEnabled(env)) return simulationDisabled(requestId);
  const decision = authorize(authorization, PERMISSIONS.financeReconcile);
  if (!decision.allowed) return apiError(403, 'FORBIDDEN', '没有发放测试点券或代金券的权限', requestId);
  const key = idempotencyKey(request, requestId);
  if (typeof key !== 'string') return key;
  const body = await readJsonBody(request);
  if (!body.ok) return invalidBody(body.tooLarge, requestId);
  const input = parseSimulationBenefitInput(body.value);
  if (!input) return apiError(422, 'INVALID_SIMULATION_BENEFIT', '测试点券或代金券参数无效', requestId);
  const result = await callRpc<Record<string, unknown>>(env, 'api_simulate_issue_benefit', {
    ...authorizationScope(authorization),
    p_operator_user_id: authorization.userId,
    p_target_user_id: input.targetUserId,
    p_instrument_type: input.instrumentType,
    p_amount: input.amount,
    p_idempotency_key: key,
    p_request_hash: await sha256(JSON.stringify(input)),
    p_request_id: requestId,
    p_user_agent: (request.headers.get('user-agent') ?? '').slice(0, 300),
    p_membership_id: authorization.membership.id,
    p_granted_via: authorizationEvidence(authorization, decision),
  });
  return json({ ...result, requestId }, { status: 201 });
}

export async function handleSimulationMixedPayment(request: Request, env: WorkerEnv, authorization: AuthorizationContext, orderId: string, requestId: string): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed(['POST'], requestId);
  if (!isPaymentSimulationEnabled(env)) return simulationDisabled(requestId);
  const orderScope = await loadResourceScope(env, 'api_order_authorization_scope', orderId);
  const decision = orderScope ? authorize(authorization, PERMISSIONS.orderCreate, orderScope) : null;
  if (!decision?.allowed) return apiError(403, 'FORBIDDEN', '没有支付该测试订单的权限', requestId);
  const key = idempotencyKey(request, requestId);
  if (typeof key !== 'string') return key;
  const body = await readJsonBody(request);
  if (!body.ok) return invalidBody(body.tooLarge, requestId);
  const input = parseSimulationMixedPaymentInput(body.value);
  if (!input) return apiError(422, 'INVALID_SIMULATION_PAYMENT', '混合支付参数无效', requestId);
  const result = await callRpc<Record<string, unknown>>(env, 'api_simulate_mixed_payment', {
    ...authorizationScope(authorization, true),
    p_order_id: orderId,
    p_welfare_cents: input.welfareCents,
    p_meal_cents: input.mealCents,
    p_voucher_id: input.voucherId,
    p_voucher_cents: input.voucherCents,
    p_points_cents: input.pointsCents,
    p_external_channel: input.externalChannel,
    p_external_cents: input.externalCents,
    p_idempotency_key: key,
    p_request_hash: await sha256(JSON.stringify({ orderId, ...input })),
    p_request_id: requestId,
    p_user_agent: (request.headers.get('user-agent') ?? '').slice(0, 300),
    p_membership_id: authorization.membership.id,
    p_granted_via: authorizationEvidence(authorization, decision),
  });
  return json({ ...result, requestId }, { status: 201 });
}
