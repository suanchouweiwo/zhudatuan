import { PERMISSIONS, type ScopeKind } from '@smart-wing/api-contract';
import { authorize } from './auth';
import { apiError, json, methodNotAllowed } from './http';
import { authorizationEvidence, invalidBody, readJsonBody } from './routerSupport';
import { callRpc } from './postgresRpc';
import type { AuthorizationContext, WorkerEnv } from './types';

// Parse every scope kind exposed by the shared contract. The database remains
// authoritative: api_update_membership_access validates the resource exists and
// api_actor_can_grant_scope prevents an actor from granting beyond their scope.
const SCOPE_KINDS = new Set<ScopeKind>(['platform', 'tenant', 'distributor', 'enterprise', 'mall', 'supplier', 'brand', 'store', 'department', 'self']);
type ScopeInput = { kind: ScopeKind; resourceId: string };
type AccessInput = { roleIds: string[]; scopes: ScopeInput[]; deniedPermissions: string[]; reason: string };

export async function handlePermissionCommandCenter(request: Request, env: WorkerEnv, authorization: AuthorizationContext, requestId: string): Promise<Response> {
  if (request.method !== 'GET') return methodNotAllowed(['GET'], requestId);
  if (!authorize(authorization, PERMISSIONS.memberRead).allowed || !authorize(authorization, PERMISSIONS.roleRead).allowed) {
    return apiError(403, 'FORBIDDEN', '没有查看会员权限中心的权限', requestId);
  }
  const data = await callRpc<Record<string, unknown> | null>(env, 'api_permission_command_center', {
    ...commandScope(authorization),
    p_include_pii: authorize(authorization, PERMISSIONS.memberPiiRead).allowed,
  });
  return data ? json({ ...data, requestId }) : apiError(403, 'FORBIDDEN', '当前身份不能查看该会员范围', requestId);
}

export async function handleMembershipAccess(request: Request, env: WorkerEnv, authorization: AuthorizationContext, membershipId: string, requestId: string): Promise<Response> {
  if (request.method !== 'PUT') return methodNotAllowed(['PUT'], requestId);
  const roleDecision = authorize(authorization, PERMISSIONS.roleGrant);
  const scopeDecision = authorize(authorization, PERMISSIONS.scopeGrant);
  if (!roleDecision.allowed || !scopeDecision.allowed) return decisionError(roleDecision.reason === 'STEP_UP_REQUIRED' || scopeDecision.reason === 'STEP_UP_REQUIRED', requestId);
  if (membershipId === authorization.membership.id) return apiError(409, 'SELF_ACCESS_MUTATION_FORBIDDEN', '不能修改自己的角色或数据范围', requestId);
  const body = await readJsonBody(request);
  if (!body.ok) return invalidBody(body.tooLarge, requestId);
  const input = parseAccessInput(body.value);
  if (!input) return apiError(422, 'INVALID_ACCESS_INPUT', '角色、数据范围或变更原因无效', requestId);
  const result = await callRpc<Record<string, unknown>>(env, 'api_update_membership_access', {
    ...mutationScope(authorization),
    p_target_membership_id: membershipId,
    p_role_ids: input.roleIds,
    p_scopes: input.scopes,
    p_denied_permission_codes: input.deniedPermissions,
    p_reason: input.reason,
    p_request_id: requestId,
    p_user_agent: userAgent(request),
    p_granted_via: authorizationEvidence(authorization, roleDecision),
  });
  return json({ ...result, requestId });
}

export async function handleMembershipStatus(request: Request, env: WorkerEnv, authorization: AuthorizationContext, membershipId: string, requestId: string): Promise<Response> {
  if (request.method !== 'PUT') return methodNotAllowed(['PUT'], requestId);
  if (membershipId === authorization.membership.id) return apiError(409, 'SELF_ACCESS_MUTATION_FORBIDDEN', '不能停用或移除自己的会员身份', requestId);
  const body = await readJsonBody(request);
  if (!body.ok) return invalidBody(body.tooLarge, requestId);
  const input = parseStatusInput(body.value);
  if (!input) return apiError(422, 'INVALID_MEMBERSHIP_STATUS_INPUT', '会员状态或变更原因无效', requestId);
  const permission = input.status === 'offboarded' ? PERMISSIONS.memberOffboard : PERMISSIONS.memberDisable;
  const decision = authorize(authorization, permission);
  if (!decision.allowed) return decisionError(decision.reason === 'STEP_UP_REQUIRED', requestId);
  const result = await callRpc<Record<string, unknown>>(env, 'api_update_membership_status', {
    ...mutationScope(authorization),
    p_target_membership_id: membershipId,
    p_status: input.status,
    p_reason: input.reason,
    p_request_id: requestId,
    p_user_agent: userAgent(request),
    p_granted_via: authorizationEvidence(authorization, decision),
  });
  return json({ ...result, requestId });
}

function parseAccessInput(value: unknown): AccessInput | null {
  if (!isRecord(value) || !isStringList(value.roleIds, 20) || !isStringList(value.deniedPermissions, 100) || !Array.isArray(value.scopes)) return null;
  const reason = trimmed(value.reason, 500);
  if (!reason || reason.length < 4 || value.scopes.length < 1 || value.scopes.length > 50) return null;
  const scopes: ScopeInput[] = [];
  for (const candidate of value.scopes) {
    if (!isRecord(candidate) || typeof candidate.kind !== 'string' || !SCOPE_KINDS.has(candidate.kind as ScopeKind)) return null;
    const resourceId = trimmed(candidate.resourceId, 160);
    if (!resourceId) return null;
    scopes.push({ kind: candidate.kind as ScopeKind, resourceId });
  }
  return { roleIds: unique(value.roleIds), scopes: uniqueScopes(scopes), deniedPermissions: unique(value.deniedPermissions), reason };
}

function parseStatusInput(value: unknown): { status: 'active' | 'suspended' | 'offboarded'; reason: string } | null {
  if (!isRecord(value) || !['active', 'suspended', 'offboarded'].includes(String(value.status))) return null;
  const reason = trimmed(value.reason, 500);
  return reason && reason.length >= 4 ? { status: value.status as 'active' | 'suspended' | 'offboarded', reason } : null;
}

function commandScope(context: AuthorizationContext) {
  return { p_actor_membership_id: context.membership.id, p_tenant_id: context.tenantId, p_enterprise_id: context.enterpriseId, p_mall_id: context.mallId };
}

function mutationScope(context: AuthorizationContext) {
  return { ...commandScope(context), p_actor_user_id: context.userId };
}

function decisionError(stepUp: boolean, requestId: string) {
  return stepUp ? apiError(403, 'STEP_UP_REQUIRED', '该操作需要重新验证身份', requestId) : apiError(403, 'FORBIDDEN', '没有变更会员权限的权限', requestId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isStringList(value: unknown, maximum: number): value is string[] {
  return Array.isArray(value) && value.length <= maximum && value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 160);
}
function trimmed(value: unknown, maximum: number): string | null {
  const result = typeof value === 'string' ? value.trim() : '';
  return result && result.length <= maximum ? result : null;
}
function unique(values: string[]): string[] {
  return [...new Set(values)];
}
function uniqueScopes(values: ScopeInput[]): ScopeInput[] {
  return [...new Map(values.map((scope) => [`${scope.kind}:${scope.resourceId}`, scope])).values()];
}
function userAgent(request: Request): string {
  return (request.headers.get('user-agent') ?? '').slice(0, 300);
}
