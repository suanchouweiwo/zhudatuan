import { can } from './auth';
import { PERMISSIONS } from '@smart-wing/api-contract';
import { decryptJson, encryptJson } from './crypto';
import { apiError, json, methodNotAllowed } from './http';
import { authorizationScope, invalidBody, readJsonBody } from './routerSupport';
import { callRpc } from './postgresRpc';
import type { AuthorizationContext, WorkerEnv } from './types';

type Address = { id?: string; name: string; phone: string; province: string; city: string; district: string; detail: string; tag?: string; isDefault: boolean };

export async function handleAddresses(request: Request, env: WorkerEnv, authorization: AuthorizationContext, requestId: string): Promise<Response> {
  if (!can(authorization, PERMISSIONS.orderCreate)) return apiError(403, 'FORBIDDEN', '没有管理地址簿的权限', requestId);
  if (!env.PII_ENCRYPTION_KEY) return apiError(503, 'PII_ENCRYPTION_NOT_CONFIGURED', '地址簿加密密钥尚未配置', requestId);
  if (request.method === 'GET') {
    const rows = await callRpc<Array<{ id: string; recipient_cipher: unknown; tag: string | null; is_default: boolean }>>(env, 'api_delivery_addresses', authorizationScope(authorization, true));
    const items = await Promise.all(
      rows.map(async (row) => ({ ...(await decryptJson<Omit<Address, 'id' | 'tag' | 'isDefault'>>(row.recipient_cipher, env.PII_ENCRYPTION_KEY!)), id: row.id, tag: row.tag ?? undefined, isDefault: row.is_default }))
    );
    return json({ items, requestId });
  }
  if (request.method !== 'PUT') return methodNotAllowed(['GET', 'PUT'], requestId);
  const body = await readJsonBody(request);
  if (!body.ok) return invalidBody(body.tooLarge, requestId);
  const input = parseAddress(body.value);
  if (!input) return apiError(422, 'INVALID_ADDRESS_INPUT', '收货地址信息不完整', requestId);
  const recipientCipher = JSON.parse(await encryptJson({ name: input.name, phone: input.phone, province: input.province, city: input.city, district: input.district, detail: input.detail }, env.PII_ENCRYPTION_KEY));
  const result = await callRpc<Record<string, unknown>>(env, 'api_upsert_delivery_address', {
    ...authorizationScope(authorization, true),
    p_address_id: input.id ?? '',
    p_recipient_cipher: recipientCipher,
    p_tag: input.tag ?? '',
    p_is_default: input.isDefault,
    p_request_id: requestId,
  });
  return json({ ...result, requestId });
}

export async function handleDeleteAddress(request: Request, env: WorkerEnv, authorization: AuthorizationContext, addressId: string, requestId: string): Promise<Response> {
  if (request.method !== 'DELETE') return methodNotAllowed(['DELETE'], requestId);
  if (!can(authorization, PERMISSIONS.orderCreate)) return apiError(403, 'FORBIDDEN', '没有管理地址簿的权限', requestId);
  const removed = await callRpc<boolean>(env, 'api_delete_delivery_address', { ...authorizationScope(authorization, true), p_address_id: addressId, p_request_id: requestId });
  return removed ? json({ removed: true, requestId }) : apiError(404, 'ADDRESS_NOT_FOUND', '地址信息不存在', requestId);
}

function parseAddress(value: unknown): Address | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const fields = ['name', 'phone', 'province', 'city', 'district', 'detail'] as const;
  if (!fields.every((field) => typeof input[field] === 'string' && input[field].trim().length > 0 && input[field].trim().length <= 200) || !/^1\d{10}$/.test(input.phone as string) || typeof input.isDefault !== 'boolean') return null;
  return {
    id: typeof input.id === 'string' ? input.id : undefined,
    name: (input.name as string).trim(),
    phone: input.phone as string,
    province: (input.province as string).trim(),
    city: (input.city as string).trim(),
    district: (input.district as string).trim(),
    detail: (input.detail as string).trim(),
    tag: typeof input.tag === 'string' ? input.tag.trim().slice(0, 30) : undefined,
    isDefault: input.isDefault,
  };
}
