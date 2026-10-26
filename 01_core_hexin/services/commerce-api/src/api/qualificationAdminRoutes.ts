import { PERMISSIONS } from '@smart-wing/api-contract';
import type { Permission } from '@smart-wing/api-contract';
import { authorize } from './auth';
import { sha256 } from './crypto';
import { apiError, json, methodNotAllowed } from './http';
import { authorizationEvidence, invalidBody, readJsonBody } from './routerSupport';
import { callRpc } from './postgresRpc';
import type { AuthorizationContext, WorkerEnv } from './types';

export async function handleQualificationCenter(request: Request, env: WorkerEnv, authorization: AuthorizationContext, requestId: string): Promise<Response> {
  if (request.method !== 'GET') return methodNotAllowed(['GET'], requestId);
  if (authorization.membership.target !== 'admin') {
    return apiError(403, 'FORBIDDEN', '该身份不能访问员工资格中心', requestId);
  }
  const canReadEntitlements = authorize(authorization, PERMISSIONS.entitlementRead).allowed;
  const canReadLimits = authorize(authorization, PERMISSIONS.purchaseLimitRead).allowed;
  const canReadResources = authorize(authorization, PERMISSIONS.commercialResourceRead).allowed;
  const canManageEntitlements = manageAllowed(authorization, PERMISSIONS.entitlementManage);
  const canManageLimits = manageAllowed(authorization, PERMISSIONS.purchaseLimitManage);
  const canManageResources = manageAllowed(authorization, PERMISSIONS.commercialResourceManage);
  const canReadEmployees = authorize(authorization, PERMISSIONS.employeeQualificationRead).allowed;
  const canManageEmployees = manageAllowed(authorization, PERMISSIONS.employeeQualificationManage);
  const canApproveChanges = manageAllowed(authorization, PERMISSIONS.qualificationApprove);
  if (!canReadEntitlements && !canReadLimits && !canReadResources && !canManageEntitlements && !canManageLimits && !canManageResources && !canReadEmployees && !canManageEmployees && !canApproveChanges) {
    return apiError(403, 'FORBIDDEN', '没有查看商业资源或员工资格策略的权限', requestId);
  }
  const hasMallScope = authorization.membership.scopeBindings.some(
    (binding) =>
      (binding.kind === 'mall' && binding.resourceId === authorization.mallId) ||
      (binding.kind === 'enterprise' && binding.resourceId === authorization.enterpriseId) ||
      (binding.kind === 'tenant' && binding.resourceId === authorization.tenantId) ||
      binding.kind === 'platform' ||
      binding.kind === 'distributor'
  );
  if (!hasMallScope) return apiError(403, 'FORBIDDEN', '当前管理员的数据范围不包含该商城', requestId);

  const center = await callRpc<Record<string, unknown>>(env, 'api_qualification_center', {
    p_tenant_id: authorization.tenantId,
    p_mall_id: authorization.mallId,
  });
  const canSeeResources = canReadResources || canManageResources;
  const canSeeEntitlements = canReadEntitlements || canManageEntitlements;
  const canSeeLimits = canReadLimits || canManageLimits;
  const canSelectRuleTargets = canManageResources || canManageEntitlements || canManageLimits;
  const selectors = record(center.selectors);
  return json({
    ...center,
    catalogPools: canSeeResources || canManageEntitlements || canManageLimits ? center.catalogPools : [],
    cityZones: canSeeEntitlements || canManageLimits ? center.cityZones : [],
    policies: canSeeEntitlements ? center.policies : [],
    limitTemplates: canSeeLimits ? center.limitTemplates : [],
    commercialResources: canSeeResources ? center.commercialResources : { agreements: [], brands: [], stores: [] },
    commercialSummary: canSeeResources ? center.commercialSummary : { brands: 0, stores: 0, supplierAgreements: 0, brandAuthorizations: 0 },
    selectors: canSelectRuleTargets
      ? {
          enterprises: canManageEntitlements || canManageLimits ? (selectors.enterprises ?? []) : [],
          suppliers: canManageResources ? (selectors.suppliers ?? []) : [],
          products: selectors.products ?? [],
          skus: selectors.skus ?? [],
          departments: canManageEntitlements || canManageLimits ? (selectors.departments ?? []) : [],
          users: canManageEntitlements || canManageLimits ? (selectors.users ?? []) : [],
          memberships: canManageEntitlements || canManageLimits ? (selectors.memberships ?? []) : [],
        }
      : { enterprises: [], suppliers: [], products: [], skus: [], departments: [], users: [], memberships: [] },
    capabilities: {
      readCommercialResources: canReadResources,
      manageCommercialResources: canManageResources,
      readEntitlements: canReadEntitlements,
      manageEntitlements: canManageEntitlements,
      readPurchaseLimits: canReadLimits,
      managePurchaseLimits: canManageLimits,
      readEmployees: canReadEmployees,
      manageEmployees: canManageEmployees,
      approveChanges: canApproveChanges,
      simulate: canReadEmployees || canManageEmployees,
    },
    requestId,
  });
}

function manageAllowed(authorization: AuthorizationContext, permission: Permission): boolean {
  const decision = authorize(authorization, permission);
  return decision.allowed || decision.reason === 'STEP_UP_REQUIRED';
}

export const CONFIG_PERMISSIONS: Record<QualificationConfigKind, Permission> = {
  catalog_pool: PERMISSIONS.commercialResourceManage,
  supplier_agreement: PERMISSIONS.commercialResourceManage,
  brand: PERMISSIONS.commercialResourceManage,
  store: PERMISSIONS.commercialResourceManage,
  city_zone: PERMISSIONS.entitlementManage,
  entitlement_policy: PERMISSIONS.entitlementManage,
  purchase_limit: PERMISSIONS.purchaseLimitManage,
};
export type QualificationConfigKind = 'catalog_pool' | 'supplier_agreement' | 'brand' | 'store' | 'city_zone' | 'entitlement_policy' | 'purchase_limit';
export type ConfigInput = { kind: QualificationConfigKind; entityId: string | null; expectedVersion: number; payload: Record<string, unknown>; reason: string };

export async function handleQualificationConfig(request: Request, env: WorkerEnv, authorization: AuthorizationContext, requestId: string): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed(['POST'], requestId);
  if (authorization.membership.target !== 'admin') return apiError(403, 'FORBIDDEN', '该身份不能配置员工资格', requestId);
  const body = await readJsonBody(request);
  if (!body.ok) return invalidBody(body.tooLarge, requestId);
  const input = parseConfigInput(body.value);
  if (!input) return apiError(422, 'QUALIFICATION_CONFIG_INVALID', '配置内容、版本或变更原因无效', requestId);
  const decision = authorize(authorization, CONFIG_PERMISSIONS[input.kind]);
  if (!decision.allowed) return apiError(403, decision.reason === 'STEP_UP_REQUIRED' ? 'STEP_UP_REQUIRED' : 'FORBIDDEN', decision.reason === 'STEP_UP_REQUIRED' ? '该操作需要重新验证身份' : '没有修改该类配置的权限', requestId);
  if (input.payload.status !== 'draft' && !hasFreshStepUp(authorization.stepUpAt)) {
    return apiError(403, 'STEP_UP_REQUIRED', '发布或停用资格规则前需要重新验证身份', requestId);
  }
  const idempotencyKey = request.headers.get('idempotency-key');
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 120) {
    return apiError(400, 'IDEMPOTENCY_KEY_REQUIRED', '保存配置必须提供有效的 Idempotency-Key', requestId);
  }
  const result = await persistQualificationConfig(request, env, authorization, requestId, input, decision, idempotencyKey);
  const approvalRequired = result.approvalRequired === true;
  return json({ ...result, requestId }, { status: approvalRequired ? 202 : input.entityId ? 200 : 201 });
}

export async function persistQualificationConfig(
  request: Request,
  env: WorkerEnv,
  authorization: AuthorizationContext,
  requestId: string,
  input: ConfigInput,
  decision = authorize(authorization, CONFIG_PERMISSIONS[input.kind]),
  idempotencyKey = request.headers.get('idempotency-key') ?? ''
): Promise<Record<string, unknown>> {
  const shared = {
    p_tenant_id: authorization.tenantId,
    p_enterprise_id: authorization.enterpriseId,
    p_mall_id: authorization.mallId,
    p_actor_user_id: authorization.userId,
    p_actor_membership_id: authorization.membership.id,
    p_kind: input.kind,
    p_entity_id: input.entityId ?? '',
    p_expected_version: input.expectedVersion,
    p_payload: input.payload,
    p_reason: input.reason,
  };
  const requestHash = await sha256(JSON.stringify(input));
  if (input.payload.status !== 'draft') {
    const preview = await callRpc<Record<string, unknown>>(env, 'api_qualification_change_preview', {
      p_tenant_id: authorization.tenantId,
      p_enterprise_id: authorization.enterpriseId,
      p_mall_id: authorization.mallId,
      p_kind: input.kind,
      p_entity_id: input.entityId ?? '',
      p_payload: input.payload,
    });
    if (preview.requiresApproval === true) {
      return callRpc<Record<string, unknown>>(env, 'api_request_qualification_change', {
        ...shared,
        p_idempotency_key: idempotencyKey,
        p_request_hash: requestHash,
        p_request_id: requestId,
        p_user_agent: (request.headers.get('user-agent') ?? '').slice(0, 300),
        p_granted_via: authorizationEvidence(authorization, decision),
      });
    }
  }
  return callRpc<Record<string, unknown>>(env, 'api_apply_qualification_config', {
    ...shared,
    p_idempotency_key: idempotencyKey,
    p_request_hash: requestHash,
    p_request_id: requestId,
    p_user_agent: (request.headers.get('user-agent') ?? '').slice(0, 300),
    p_granted_via: authorizationEvidence(authorization, decision),
  });
}

export function parseConfigInput(value: unknown): ConfigInput | null {
  if (!isRecord(value) || typeof value.kind !== 'string' || !(value.kind in CONFIG_PERMISSIONS) || !isRecord(value.payload)) return null;
  const expectedVersion = value.expectedVersion;
  const entityId = value.entityId == null ? null : typeof value.entityId === 'string' ? value.entityId.trim() : '';
  const reason = typeof value.reason === 'string' ? value.reason.trim() : '';
  const status = value.payload.status;
  if (!Number.isSafeInteger(expectedVersion) || (expectedVersion as number) < 0 || (entityId !== null && (!entityId || entityId.length > 180))) return null;
  if (reason.length < 4 || reason.length > 500 || !['draft', 'active', 'disabled'].includes(String(status))) return null;
  return { kind: value.kind as QualificationConfigKind, entityId, expectedVersion: expectedVersion as number, payload: value.payload, reason };
}

export function hasFreshStepUp(stepUpAt: string | null): boolean {
  if (!stepUpAt) return false;
  const timestamp = new Date(stepUpAt).getTime();
  return Number.isFinite(timestamp) && timestamp <= Date.now() && Date.now() - timestamp <= 15 * 60 * 1000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
