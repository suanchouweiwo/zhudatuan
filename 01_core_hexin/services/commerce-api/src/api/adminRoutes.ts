import { PERMISSIONS } from '@smart-wing/api-contract';
import { authorize } from './auth';
import { sha256 } from './crypto';
import { apiError, json, methodNotAllowed } from './http';
import { authorizationEvidence, authorizationScope, invalidBody, loadResourceScope, readJsonBody } from './routerSupport';
import { callRpc } from './postgresRpc';
import type { AuthorizationContext, WorkerEnv } from './types';

export async function handleAdminCatalog(request: Request, env: WorkerEnv, authorization: AuthorizationContext, requestId: string): Promise<Response> {
  if (request.method !== 'GET') return methodNotAllowed(['GET'], requestId);
  if (!authorize(authorization, PERMISSIONS.catalogRead).allowed) return apiError(403, 'FORBIDDEN', '没有查看商品目录的权限', requestId);
  const items = await callRpc<Array<Record<string, unknown>>>(env, 'api_admin_catalog', {
    p_tenant_id: authorization.tenantId,
    p_mall_id: authorization.mallId,
    p_limit: 100,
  });
  return json({ items, requestId });
}

/** Session proof and first-paint dashboard data are returned together to avoid serial cross-region requests. */
export async function handleAdminOverview(request: Request, env: WorkerEnv, authorization: AuthorizationContext, requestId: string): Promise<Response> {
  if (request.method !== 'GET') return methodNotAllowed(['GET'], requestId);
  if (authorization.membership.target !== 'admin') return apiError(403, 'FORBIDDEN', '该身份不能访问运营后台', requestId);
  if (!authorize(authorization, PERMISSIONS.catalogRead).allowed || !authorize(authorization, PERMISSIONS.orderRead).allowed) {
    return apiError(403, 'FORBIDDEN', '该身份缺少后台概览权限', requestId);
  }
  const broadScope = authorization.membership.scopeBindings.some((binding) => binding.kind !== 'self');
  const scopedOrderParams = { ...authorizationScope(authorization), p_user_id: broadScope ? null : authorization.userId };
  const [products, orders, afterSaleCount] = await Promise.all([
    callRpc<Array<Record<string, unknown>>>(env, 'api_admin_catalog', { p_tenant_id: authorization.tenantId, p_mall_id: authorization.mallId, p_limit: 100 }),
    callRpc<Array<Record<string, unknown>>>(env, 'api_order_views_scoped', scopedOrderParams),
    callRpc<number>(env, 'api_after_sale_count_scoped', scopedOrderParams),
  ]);
  return json({
    authenticated: true,
    authorization: {
      memberId: authorization.membership.memberId,
      membershipId: authorization.membership.id,
      target: authorization.membership.target,
      employeeNo: authorization.employeeNo,
      roles: authorization.roles,
      permissions: authorization.permissions,
    },
    products,
    orders,
    summary: {
      catalogCount: products.length,
      availableStock: products.reduce((total, product) => total + (typeof product.availableStock === 'number' ? product.availableStock : 0), 0),
      orderCount: orders.length,
      afterSaleCount,
    },
    requestId,
  });
}

export async function handleSetProductStatus(request: Request, env: WorkerEnv, authorization: AuthorizationContext, productId: string, requestId: string): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed(['POST'], requestId);
  // Fail closed on the coarse grant before touching the database. The resource
  // scope is still loaded below for the final, resource-specific decision.
  if (!authorize(authorization, PERMISSIONS.productPublish).allowed) return apiError(403, 'FORBIDDEN', '没有变更商品发布状态的权限', requestId);
  const scope = await loadResourceScope(env, 'api_product_authorization_scope', productId);
  const decision = scope ? authorize(authorization, PERMISSIONS.productPublish, scope) : null;
  if (!decision?.allowed) return apiError(403, 'FORBIDDEN', '没有变更该商品发布状态的权限', requestId);
  const idempotencyKey = request.headers.get('idempotency-key');
  if (!idempotencyKey || idempotencyKey.length > 120) return apiError(400, 'IDEMPOTENCY_KEY_REQUIRED', '变更商品状态必须提供 Idempotency-Key', requestId);
  const body = await readJsonBody(request);
  if (!body.ok) return invalidBody(body.tooLarge, requestId);
  const status = typeof (body.value as { status?: unknown })?.status === 'string' ? (body.value as { status: string }).status : '';
  if (status !== 'active' && status !== 'inactive') return apiError(422, 'INVALID_PRODUCT_STATUS_INPUT', '商品状态参数无效', requestId);
  const response = await callRpc<Record<string, unknown>>(env, 'api_set_product_status', {
    p_tenant_id: authorization.tenantId,
    p_mall_id: authorization.mallId,
    p_operator_user_id: authorization.userId,
    p_product_id: productId,
    p_status: status,
    p_idempotency_key: idempotencyKey,
    p_request_hash: await sha256(JSON.stringify({ productId, status })),
    p_request_id: requestId,
    p_user_agent: (request.headers.get('user-agent') ?? '').slice(0, 300),
    p_membership_id: authorization.membership.id,
    p_granted_via: authorizationEvidence(authorization, decision),
  });
  return json(response, { status: 201 });
}
