import type { Membership, ResourceScope, ScopeBinding } from '@smart-wing/api-contract';
import { readSession } from './session';
import { callRpc } from './postgresRpc';
import type { AuthorizationContext, WorkerEnv } from './types';

export interface MembershipRuntime {
  membership: Membership;
  authorization: AuthorizationContext;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stringList(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null;
}

function scopeBindings(value: unknown): ScopeBinding[] | null {
  if (!Array.isArray(value)) return null;
  const bindings: ScopeBinding[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    const kind = optionalString(item.kind);
    const resourceId = optionalString(item.resourceId);
    if (!kind || !resourceId || !['platform', 'tenant', 'distributor', 'enterprise', 'mall', 'supplier', 'brand', 'store', 'department', 'self'].includes(kind)) return null;
    bindings.push({ kind: kind as ScopeBinding['kind'], resourceId });
  }
  return bindings;
}

/**
 * Resolves the one membership referenced by the host-only signed cookie. This
 * is intentionally called on every request; permissions are never stored in a
 * cookie and a revoked membership is rejected immediately.
 */
export async function resolveMembershipContext(request: Request, env: WorkerEnv): Promise<Membership | null> {
  const runtime = await resolveMembershipRuntime(request, env);
  return runtime?.membership ?? null;
}

/**
 * Resolves the signed session to one Membership and the server-derived RPC
 * scope projection it is allowed to operate in. Neither permissions nor
 * scope IDs originate from the browser.
 */
export async function resolveMembershipRuntime(request: Request, env: WorkerEnv): Promise<MembershipRuntime | null> {
  const session = await readSession(request, env);
  if (!session?.memberId || !session.membershipId) return null;
  const raw = await callRpc<unknown>(env, 'api_resolve_session_membership_context', {
    p_session_id: session.sessionId,
    p_member_id: session.memberId,
    p_membership_id: session.membershipId,
    p_target: session.target,
  });
  const membership = parseMembership(raw);
  const authorization = parseAuthorizationContext(raw, membership, session.stepUpAt);
  if (!membership || !authorization) return null;
  if (membership.authzVersion !== session.authzVersion || membership.memberId !== session.memberId || membership.id !== session.membershipId || membership.target !== session.target) return null;
  return { membership, authorization };
}

/** Used by the development-only test fixture before its signed cookie exists. */
export async function resolveMembershipRuntimeByIds(env: WorkerEnv, memberId: string, membershipId: string, target: 'storefront' | 'admin', expectedAuthzVersion?: number, stepUpAt?: number): Promise<MembershipRuntime | null> {
  const raw = await callRpc<unknown>(env, 'api_resolve_membership_context', {
    p_member_id: memberId,
    p_membership_id: membershipId,
    p_target: target,
  });
  const membership = parseMembership(raw);
  const authorization = parseAuthorizationContext(raw, membership, stepUpAt);
  if (!membership || !authorization || (expectedAuthzVersion !== undefined && membership.authzVersion !== expectedAuthzVersion) || membership.memberId !== memberId || membership.id !== membershipId || membership.target !== target) {
    return null;
  }
  return { membership, authorization };
}

/** Converts a row loaded by commerce-api into trusted authorization facts. */
export function resourceScopeFromDatabaseRow(row: unknown): ResourceScope | null {
  if (!isRecord(row)) return null;
  const tenantId = optionalString(row.tenant_id);
  if (!tenantId) return null;
  const path = scopeBindings(row.org_unit_path);
  return {
    tenantId,
    ...(optionalString(row.enterprise_id) ? { enterpriseId: optionalString(row.enterprise_id) } : {}),
    ...(optionalString(row.mall_id) ? { mallId: optionalString(row.mall_id) } : {}),
    ...(optionalString(row.supplier_id) ? { supplierId: optionalString(row.supplier_id) } : {}),
    ...(optionalString(row.distributor_id) ? { distributorId: optionalString(row.distributor_id) } : {}),
    ...(optionalString(row.brand_id) ? { brandId: optionalString(row.brand_id) } : {}),
    ...(optionalString(row.store_id) ? { storeId: optionalString(row.store_id) } : {}),
    ...(optionalString(row.department_id) ? { departmentId: optionalString(row.department_id) } : {}),
    ...(optionalString(row.user_id) ? { ownerUserId: optionalString(row.user_id) } : {}),
    ...(path ? { orgUnitPath: path } : {}),
  };
}

function parseMembership(value: unknown): Membership | null {
  if (!isRecord(value) || !isRecord(value.context)) return null;
  const id = optionalString(value.id);
  const memberId = optionalString(value.memberId);
  const target = optionalString(value.target);
  const status = optionalString(value.status);
  const tenantId = optionalString(value.context.tenantId);
  const roleIds = stringList(value.roleIds);
  const permissions = stringList(value.permissions);
  const deniedPermissions = value.deniedPermissions === undefined ? [] : stringList(value.deniedPermissions);
  const bindings = scopeBindings(value.scopeBindings);
  if (
    !id ||
    !memberId ||
    (target !== 'storefront' && target !== 'admin') ||
    !['invited', 'active', 'suspended', 'offboarded', 'expired'].includes(status ?? '') ||
    !tenantId ||
    !roleIds ||
    !permissions ||
    !deniedPermissions ||
    !bindings ||
    typeof value.authzVersion !== 'number'
  ) {
    return null;
  }
  return {
    id,
    memberId,
    target,
    status: status as Membership['status'],
    roleIds,
    permissions: permissions as Membership['permissions'],
    deniedPermissions: deniedPermissions as Membership['permissions'],
    context: {
      tenantId,
      ...(optionalString(value.context.enterpriseId) ? { enterpriseId: optionalString(value.context.enterpriseId) } : {}),
      ...(optionalString(value.context.mallId) ? { mallId: optionalString(value.context.mallId) } : {}),
      ...(optionalString(value.context.supplierId) ? { supplierId: optionalString(value.context.supplierId) } : {}),
      ...(optionalString(value.context.distributorId) ? { distributorId: optionalString(value.context.distributorId) } : {}),
      ...(optionalString(value.context.brandId) ? { brandId: optionalString(value.context.brandId) } : {}),
      ...(optionalString(value.context.storeId) ? { storeId: optionalString(value.context.storeId) } : {}),
      ...(optionalString(value.context.departmentId) ? { departmentId: optionalString(value.context.departmentId) } : {}),
      ...(optionalString(value.context.userId) ? { userId: optionalString(value.context.userId) } : {}),
    },
    scopeBindings: bindings,
    expiresAt: typeof value.expiresAt === 'string' ? value.expiresAt : null,
    authzVersion: value.authzVersion,
  };
}

function parseAuthorizationContext(value: unknown, membership: Membership | null, stepUpAt?: number): AuthorizationContext | null {
  if (!membership || !isRecord(value) || !isRecord(value.actor)) return null;
  const tenantId = optionalString(value.actor.tenantId);
  const enterpriseId = optionalString(value.actor.enterpriseId);
  const mallId = optionalString(value.actor.mallId);
  const mallCode = optionalString(value.actor.mallCode);
  const userId = optionalString(value.actor.userId);
  const employeeNo = optionalString(value.actor.employeeNo);
  if (!tenantId || !enterpriseId || !mallId || !mallCode || !userId || !employeeNo) return null;
  if (tenantId !== membership.context.tenantId || enterpriseId !== membership.context.enterpriseId || mallId !== membership.context.mallId || userId !== membership.context.userId) return null;
  return {
    tenantId,
    enterpriseId,
    mallId,
    mallCode,
    userId,
    employeeNo,
    roles: membership.roleIds,
    permissions: membership.permissions,
    membership,
    stepUpAt: stepUpAt ? new Date(stepUpAt * 1_000).toISOString() : null,
  };
}
