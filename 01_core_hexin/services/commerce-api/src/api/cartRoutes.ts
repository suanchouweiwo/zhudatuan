import { can } from './auth';
import { PERMISSIONS } from '@smart-wing/api-contract';
import { apiError, json, methodNotAllowed } from './http';
import { authorizationScope, invalidBody, readJsonBody } from './routerSupport';
import { publicCatalogCoverUrl } from './publicCatalogImages';
import { callRpc } from './postgresRpc';
import type { AuthorizationContext, WorkerEnv } from './types';

export async function handleCart(request: Request, env: WorkerEnv, authorization: AuthorizationContext, requestId: string): Promise<Response> {
  if (!can(authorization, PERMISSIONS.orderCreate)) return apiError(403, 'FORBIDDEN', '没有管理购物车的权限', requestId);
  if (request.method === 'GET') {
    const rows = await callRpc<Array<Record<string, unknown>>>(env, 'api_cart_snapshot_qualified', {
      ...authorizationScope(authorization, true),
      p_membership_id: authorization.membership.id,
    });
    const items = await Promise.all(
      rows.map(async (row) => ({
        ...row,
        coverUrl: await publicCatalogCoverUrl(request, env, typeof row.productId === 'string' ? row.productId : '', typeof row.coverUrl === 'string' ? row.coverUrl : null),
      }))
    );
    return json({ items, requestId });
  }
  if (request.method !== 'PUT') return methodNotAllowed(['GET', 'PUT'], requestId);
  const body = await readJsonBody(request);
  if (!body.ok) return invalidBody(body.tooLarge, requestId);
  const input = parseCartInput(body.value);
  if (!input) return apiError(422, 'INVALID_CART_INPUT', '购物车商品或数量无效', requestId);
  const result = await callRpc<Record<string, unknown>>(env, 'api_upsert_cart_item_qualified', {
    ...authorizationScope(authorization, true),
    p_membership_id: authorization.membership.id,
    p_sku_id: input.skuId,
    p_quantity: input.quantity,
    p_selected: input.selected,
    p_request_id: requestId,
  });
  return json(result, { status: 200 });
}

export async function handleDeleteCartItem(request: Request, env: WorkerEnv, authorization: AuthorizationContext, itemId: string, requestId: string): Promise<Response> {
  if (request.method !== 'DELETE') return methodNotAllowed(['DELETE'], requestId);
  if (!can(authorization, PERMISSIONS.orderCreate)) return apiError(403, 'FORBIDDEN', '没有管理购物车的权限', requestId);
  const removed = await callRpc<boolean>(env, 'api_delete_cart_item', { ...authorizationScope(authorization, true), p_cart_item_id: itemId, p_request_id: requestId });
  return removed ? json({ removed: true, requestId }) : apiError(404, 'CART_ITEM_NOT_FOUND', '购物车商品不存在', requestId);
}

function parseCartInput(value: unknown): { skuId: string; quantity: number; selected: boolean } | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  return typeof input.skuId === 'string' &&
    input.skuId.length > 0 &&
    input.skuId.length <= 100 &&
    Number.isInteger(input.quantity) &&
    (input.quantity as number) >= 1 &&
    (input.quantity as number) <= 99 &&
    typeof input.selected === 'boolean'
    ? { skuId: input.skuId, quantity: input.quantity as number, selected: input.selected }
    : null;
}
