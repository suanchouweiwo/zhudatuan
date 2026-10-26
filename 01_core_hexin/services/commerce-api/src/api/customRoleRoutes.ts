import { PERMISSIONS } from '@smart-wing/api-contract';
import { authorize } from './auth';
import { apiError, json, methodNotAllowed } from './http';
import { authorizationEvidence, invalidBody, readJsonBody } from './routerSupport';
import { callRpc } from './postgresRpc';
import type { AuthorizationContext, WorkerEnv } from './types';

type RoleInput = { code: string; name: string; description: string; permissionCodes: string[]; sourceRoleId: string | null; reason: string };

export async function handleCustomRoleCenter(request: Request, env: WorkerEnv, authorization: AuthorizationContext, requestId: string): Promise<Response> {
  if (request.method !== 'GET') return methodNotAllowed(['GET'], requestId);
  if (!authorize(authorization, PERMISSIONS.roleRead).allowed) return apiError(403, 'FORBIDDEN', '没有查看角色中心的权限', requestId);
  const result = await callRpc<Record<string, unknown> | null>(env, 'api_custom_role_center', {
    p_actor_membership_id: authorization.membership.id,
    p_tenant_id: authorization.tenantId,
  });
  return result ? json({ ...result, requestId }) : apiError(403, 'FORBIDDEN', '当前身份不能查看角色中心', requestId);
}

export async function handleCreateCustomRole(request: Request, env: WorkerEnv, authorization: AuthorizationContext, requestId: string): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed(['POST'], requestId);
  const decision = authorize(authorization, PERMISSIONS.roleCreate);
  if (!decision.allowed) return decisionError(decision.reason === 'STEP_UP_REQUIRED', '没有创建角色的权限', requestId);
  if (!hasFreshStepUp(authorization.stepUpAt)) return decisionError(true, '', requestId);
  const input = await roleBody(request, true, requestId);
  if (input instanceof Response) return input;
  const result = await callRpc<Record<string, unknown>>(env, 'api_create_custom_role', {
    ...mutationScope(authorization),
    p_code: input.code,
    p_name: input.name,
    p_description: input.description,
    p_permission_codes: input.permissionCodes,
    p_source_role_id: input.sourceRoleId,
    p_reason: input.reason,
    ...audit(request, requestId, authorization, decision),
  });
  return json({ ...result, requestId }, { status: 201 });
}

export async function handleUpdateCustomRole(request: Request, env: WorkerEnv, authorization: AuthorizationContext, roleId: string, requestId: string): Promise<Response> {
  if (request.method !== 'PUT') return methodNotAllowed(['PUT'], requestId);
  const decision = authorize(authorization, PERMISSIONS.roleUpdate);
  if (!decision.allowed) return decisionError(decision.reason === 'STEP_UP_REQUIRED', '没有编辑角色的权限', requestId);
  if (!hasFreshStepUp(authorization.stepUpAt)) return decisionError(true, '', requestId);
  const input = await roleBody(request, false, requestId);
  if (input instanceof Response) return input;
  const result = await callRpc<Record<string, unknown>>(env, 'api_update_custom_role', {
    ...mutationScope(authorization),
    p_role_id: roleId,
    p_name: input.name,
    p_description: input.description,
    p_permission_codes: input.permissionCodes,
    p_reason: input.reason,
    ...audit(request, requestId, authorization, decision),
  });
  return json({ ...result, requestId });
}

export async function handleSetCustomRoleStatus(request: Request, env: WorkerEnv, authorization: AuthorizationContext, roleId: string, requestId: string): Promise<Response> {
  if (request.method !== 'PUT') return methodNotAllowed(['PUT'], requestId);
  const body = await readJsonBody(request);
  if (!body.ok) return invalidBody(body.tooLarge, requestId);
  const value = isRecord(body.value) ? body.value : {};
  const status = value.status === 'active' || value.status === 'disabled' ? value.status : null;
  const reason = text(value.reason, 500);
  if (!status || !reason || reason.length < 4) return apiError(422, 'CUSTOM_ROLE_STATUS_INVALID', '角色状态或变更原因无效', requestId);
  const permission = status === 'disabled' ? PERMISSIONS.roleDelete : PERMISSIONS.roleUpdate;
  const decision = authorize(authorization, permission);
  if (!decision.allowed) return decisionError(decision.reason === 'STEP_UP_REQUIRED', '没有变更角色状态的权限', requestId);
  if (!hasFreshStepUp(authorization.stepUpAt)) return decisionError(true, '', requestId);
  const result = await callRpc<Record<string, unknown>>(env, 'api_set_custom_role_status', {
    ...mutationScope(authorization),
    p_role_id: roleId,
    p_status: status,
    p_reason: reason,
    ...audit(request, requestId, authorization, decision),
  });
  return json({ ...result, requestId });
}

async function roleBody(request: Request, includeCode: boolean, requestId: string): Promise<RoleInput | Response> {
  const body = await readJsonBody(request);
  if (!body.ok) return invalidBody(body.tooLarge, requestId);
  if (!isRecord(body.value)) return apiError(422, 'CUSTOM_ROLE_INPUT_INVALID', '角色资料无效', requestId);
  const code = includeCode ? (text(body.value.code, 40)?.toLowerCase() ?? '') : '';
  const name = text(body.value.name, 60);
  const description = optionalText(body.value.description, 300) ?? '';
  const reason = text(body.value.reason, 500);
  const sourceRoleId = includeCode ? optionalText(body.value.sourceRoleId, 160) : null;
  const permissionCodes = uniqueStrings(body.value.permissionCodes, 100, 120);
  if ((includeCode && !/^[a-z][a-z0-9_]{2,39}$/.test(code)) || !name || name.length < 2 || !reason || reason.length < 4 || permissionCodes === null || (sourceRoleId && permissionCodes.length > 0)) {
    return apiError(422, 'CUSTOM_ROLE_INPUT_INVALID', '角色名称、编码、权限或变更原因无效', requestId);
  }
  return { code, name, description, permissionCodes, sourceRoleId, reason };
}

function mutationScope(context: AuthorizationContext) {
  return { p_actor_membership_id: context.membership.id, p_actor_user_id: context.userId, p_tenant_id: context.tenantId, p_enterprise_id: context.enterpriseId, p_mall_id: context.mallId };
}
function audit(request: Request, requestId: string, context: AuthorizationContext, decision: ReturnType<typeof authorize>) {
  return { p_request_id: requestId, p_user_agent: (request.headers.get('user-agent') ?? '').slice(0, 300), p_granted_via: authorizationEvidence(context, decision) };
}
function decisionError(stepUp: boolean, message: string, requestId: string) {
  return stepUp ? apiError(403, 'STEP_UP_REQUIRED', '该操作需要重新验证身份', requestId) : apiError(403, 'FORBIDDEN', message, requestId);
}
function hasFreshStepUp(stepUpAt: string | null) {
  if (!stepUpAt) return false;
  const timestamp = new Date(stepUpAt).getTime();
  return Number.isFinite(timestamp) && timestamp <= Date.now() && Date.now() - timestamp <= 15 * 60_000;
}
function text(value: unknown, maximum: number) {
  const result = typeof value === 'string' ? value.trim() : '';
  return result && result.length <= maximum ? result : null;
}
function optionalText(value: unknown, maximum: number) {
  return value === undefined || value === null || value === '' ? null : text(value, maximum);
}
function uniqueStrings(value: unknown, maximumItems: number, maximumLength: number): string[] | null {
  if (!Array.isArray(value) || value.length > maximumItems || !value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= maximumLength)) return null;
  return [...new Set(value)];
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
