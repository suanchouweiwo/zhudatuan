import { PERMISSIONS, type Permission } from '@smart-wing/api-contract';
import { authorize } from './auth';
import { apiError, json, methodNotAllowed } from './http';
import { authorizationEvidence, invalidBody, readJsonBody } from './routerSupport';
import { callRpc } from './postgresRpc';
import type { AuthorizationContext, WorkerEnv } from './types';
import { CONFIG_PERMISSIONS, hasFreshStepUp, parseConfigInput, persistQualificationConfig, type QualificationConfigKind } from './qualificationAdminRoutes';

const READ_PERMISSIONS: Record<QualificationConfigKind, Permission> = {
  catalog_pool: PERMISSIONS.commercialResourceRead,
  supplier_agreement: PERMISSIONS.commercialResourceRead,
  brand: PERMISSIONS.commercialResourceRead,
  store: PERMISSIONS.commercialResourceRead,
  city_zone: PERMISSIONS.entitlementRead,
  entitlement_policy: PERMISSIONS.entitlementRead,
  purchase_limit: PERMISSIONS.purchaseLimitRead,
};

export async function handleQualificationGovernance(request: Request, env: WorkerEnv, authorization: AuthorizationContext, requestId: string): Promise<Response> {
  if (request.method !== 'GET') return methodNotAllowed(['GET'], requestId);
  if (!isAdmin(authorization)) return forbidden(requestId);
  const canReadEmployees = permitted(authorization, PERMISSIONS.employeeQualificationRead) || manageable(authorization, PERMISSIONS.employeeQualificationManage);
  const canManageEmployees = manageable(authorization, PERMISSIONS.employeeQualificationManage);
  const canApprove = manageable(authorization, PERMISSIONS.qualificationApprove);
  const canSeeRequests = canApprove || Object.values(CONFIG_PERMISSIONS).some((permission) => manageable(authorization, permission));
  if (!canReadEmployees && !canSeeRequests) return forbidden(requestId);
  const center = await callRpc<Record<string, unknown>>(env, 'api_qualification_governance_center', scope(authorization));
  return json({
    changeRequests: canSeeRequests ? (center.changeRequests ?? []) : [],
    employees: canReadEmployees ? (center.employees ?? []) : [],
    capabilities: { readEmployees: canReadEmployees, manageEmployees: canManageEmployees, approveChanges: canApprove, simulate: canReadEmployees },
    currentMembershipId: authorization.membership.id,
    requestId,
  });
}

export async function handleQualificationPreview(request: Request, env: WorkerEnv, authorization: AuthorizationContext, requestId: string): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed(['POST'], requestId);
  if (!isAdmin(authorization)) return forbidden(requestId);
  const body = await bodyOf(request, requestId);
  if (body instanceof Response) return body;
  const input = parseConfigInput(body);
  if (!input) return apiError(422, 'QUALIFICATION_CONFIG_INVALID', '配置内容、版本或变更原因无效', requestId);
  const decision = authorize(authorization, CONFIG_PERMISSIONS[input.kind]);
  if (!decision.allowed) return forbidden(requestId, '没有预览该类配置的权限');
  const preview = await callRpc<Record<string, unknown>>(env, 'api_qualification_change_preview', {
    ...scope(authorization),
    p_kind: input.kind,
    p_entity_id: input.entityId ?? '',
    p_payload: input.payload,
  });
  return json({ ...preview, requestId });
}

export async function handleQualificationReview(request: Request, env: WorkerEnv, authorization: AuthorizationContext, requestId: string): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed(['POST'], requestId);
  if (!isAdmin(authorization)) return forbidden(requestId);
  const body = await bodyOf(request, requestId);
  if (body instanceof Response) return body;
  const changeRequestId = string(body.changeRequestId, 180);
  const decisionValue = body.decision === 'approve' || body.decision === 'reject' ? body.decision : null;
  const reason = string(body.reason, 500);
  if (!changeRequestId || !decisionValue || !reason || reason.length < 4) return apiError(422, 'QUALIFICATION_REVIEW_INVALID', '审批决定或意见无效', requestId);
  const decision = authorize(authorization, PERMISSIONS.qualificationApprove);
  if (!decision.allowed) return forbidden(requestId, decision.reason === 'STEP_UP_REQUIRED' ? '审批前需要重新验证身份' : '没有资格审批权限', decision.reason === 'STEP_UP_REQUIRED');
  const result = await callRpc<Record<string, unknown>>(env, 'api_review_qualification_change', {
    ...actorScope(authorization),
    p_change_request_id: changeRequestId,
    p_decision: decisionValue,
    p_reason: reason,
    p_request_id: requestId,
    p_user_agent: userAgent(request),
    p_granted_via: authorizationEvidence(authorization, decision),
  });
  return json({ ...result, requestId });
}

export async function handleQualificationHistory(request: Request, env: WorkerEnv, authorization: AuthorizationContext, requestId: string): Promise<Response> {
  if (request.method !== 'GET') return methodNotAllowed(['GET'], requestId);
  if (!isAdmin(authorization)) return forbidden(requestId);
  const url = new URL(request.url);
  const kind = configKind(url.searchParams.get('kind'));
  const entityId = string(url.searchParams.get('entityId'), 180);
  if (!kind || !entityId) return apiError(422, 'QUALIFICATION_HISTORY_INVALID', '历史查询参数无效', requestId);
  if (!readable(authorization, kind)) return forbidden(requestId, '没有查看该配置历史的权限');
  const history = await callRpc<unknown[]>(env, 'api_qualification_history', { p_tenant_id: authorization.tenantId, p_mall_id: authorization.mallId, p_kind: kind, p_entity_id: entityId });
  return json({ history, requestId });
}

export async function handleQualificationRollback(request: Request, env: WorkerEnv, authorization: AuthorizationContext, requestId: string): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed(['POST'], requestId);
  if (!isAdmin(authorization)) return forbidden(requestId);
  const body = await bodyOf(request, requestId);
  if (body instanceof Response) return body;
  const kind = configKind(body.kind);
  const entityId = string(body.entityId, 180);
  const auditId = string(body.auditId, 180);
  const expectedVersion = Number(body.expectedVersion);
  const reason = string(body.reason, 500);
  if (!kind || !entityId || !auditId || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || !reason || reason.length < 4) return apiError(422, 'QUALIFICATION_ROLLBACK_INVALID', '回滚参数或原因无效', requestId);
  const decision = authorize(authorization, CONFIG_PERMISSIONS[kind]);
  if (!decision.allowed) return forbidden(requestId, '没有回滚该类配置的权限');
  if (!hasFreshStepUp(authorization.stepUpAt)) return forbidden(requestId, '回滚前需要重新验证身份', true);
  const idempotencyKey = request.headers.get('idempotency-key') ?? '';
  if (idempotencyKey.length < 8 || idempotencyKey.length > 120) return apiError(400, 'IDEMPOTENCY_KEY_REQUIRED', '回滚必须提供有效的 Idempotency-Key', requestId);
  const payload = await callRpc<Record<string, unknown>>(env, 'api_qualification_rollback_snapshot', { p_tenant_id: authorization.tenantId, p_mall_id: authorization.mallId, p_kind: kind, p_entity_id: entityId, p_audit_id: auditId });
  const result = await persistQualificationConfig(request, env, authorization, requestId, { kind, entityId, expectedVersion, payload, reason: `回滚历史版本：${reason}` }, decision, idempotencyKey);
  return json({ ...result, requestId }, { status: result.approvalRequired === true ? 202 : 200 });
}

export async function handleQualificationSimulation(request: Request, env: WorkerEnv, authorization: AuthorizationContext, requestId: string): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed(['POST'], requestId);
  if (!isAdmin(authorization)) return forbidden(requestId);
  if (!permitted(authorization, PERMISSIONS.employeeQualificationRead) && !manageable(authorization, PERMISSIONS.employeeQualificationManage)) return forbidden(requestId, '没有运行员工资格模拟的权限');
  const body = await bodyOf(request, requestId);
  if (body instanceof Response) return body;
  const userId = string(body.userId, 180),
    membershipId = string(body.membershipId, 180),
    skuId = string(body.skuId, 180);
  const quantity = Number(body.quantity ?? 1),
    cityCode = optionalString(body.cityCode, 80),
    cityName = optionalString(body.cityName, 80);
  if (!userId || !membershipId || !skuId || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 99) return apiError(422, 'QUALIFICATION_SIMULATION_INVALID', '员工、商品或数量无效', requestId);
  const result = await callRpc<Record<string, unknown>>(env, 'api_employee_sku_qualification', {
    ...scope(authorization),
    p_user_id: userId,
    p_membership_id: membershipId,
    p_sku_id: skuId,
    p_quantity: quantity,
    p_city_code: cityCode,
    p_city_name: cityName,
    p_order_items: null,
  });
  return json({ ...result, requestId });
}

export async function handleEmployeeQualification(request: Request, env: WorkerEnv, authorization: AuthorizationContext, userId: string, requestId: string): Promise<Response> {
  if (request.method !== 'PUT') return methodNotAllowed(['PUT'], requestId);
  if (!isAdmin(authorization)) return forbidden(requestId);
  const decision = authorize(authorization, PERMISSIONS.employeeQualificationManage);
  if (!decision.allowed) return forbidden(requestId, '没有维护员工资格事实的权限');
  if (!hasFreshStepUp(authorization.stepUpAt)) return forbidden(requestId, '修改员工资格前需要重新验证身份', true);
  const body = await bodyOf(request, requestId);
  if (body instanceof Response) return body;
  const expectedVersion = Number(body.expectedVersion),
    status = body.status === 'active' || body.status === 'disabled' ? body.status : null;
  const reason = string(body.reason, 500),
    attributes = isRecord(body.attributes) ? body.attributes : null;
  const tags = parseTags(body.tags);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || !status || !reason || reason.length < 4 || !attributes || !tags) return apiError(422, 'EMPLOYEE_QUALIFICATION_INVALID', '员工资格内容、版本或变更原因无效', requestId);
  const result = await callRpc<Record<string, unknown>>(env, 'api_update_employee_qualification', {
    ...actorScope(authorization),
    p_user_id: userId,
    p_expected_version: expectedVersion,
    p_city_code: optionalString(body.cityCode, 80),
    p_city_name: optionalString(body.cityName, 80),
    p_status: status,
    p_attributes: attributes,
    p_tags: tags,
    p_reason: reason,
    p_request_id: requestId,
    p_user_agent: userAgent(request),
    p_granted_via: authorizationEvidence(authorization, decision),
  });
  return json({ ...result, requestId });
}

async function bodyOf(request: Request, requestId: string): Promise<Record<string, unknown> | Response> {
  const body = await readJsonBody(request);
  if (!body.ok) return invalidBody(body.tooLarge, requestId);
  return isRecord(body.value) ? body.value : apiError(400, 'INVALID_JSON', '请求内容不是有效对象', requestId);
}
const scope = (a: AuthorizationContext) => ({ p_tenant_id: a.tenantId, p_enterprise_id: a.enterpriseId, p_mall_id: a.mallId });
const actorScope = (a: AuthorizationContext) => ({ ...scope(a), p_actor_user_id: a.userId, p_actor_membership_id: a.membership.id });
const permitted = (a: AuthorizationContext, permission: Permission) => authorize(a, permission).allowed;
const manageable = (a: AuthorizationContext, permission: Permission) => {
  const decision = authorize(a, permission);
  return decision.allowed || decision.reason === 'STEP_UP_REQUIRED';
};
const readable = (a: AuthorizationContext, kind: QualificationConfigKind) => permitted(a, READ_PERMISSIONS[kind]) || manageable(a, CONFIG_PERMISSIONS[kind]);
const isAdmin = (a: AuthorizationContext) => a.membership.target === 'admin';
const forbidden = (requestId: string, message = '该身份不能访问员工资格治理', stepUp = false) => apiError(403, stepUp ? 'STEP_UP_REQUIRED' : 'FORBIDDEN', message, requestId);
const userAgent = (request: Request) => (request.headers.get('user-agent') ?? '').slice(0, 300);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const string = (value: unknown, max: number) => (typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max ? value.trim() : null);
const optionalString = (value: unknown, max: number) => (value == null || value === '' ? null : string(value, max));
const configKind = (value: unknown): QualificationConfigKind | null => (typeof value === 'string' && value in CONFIG_PERMISSIONS ? (value as QualificationConfigKind) : null);
function parseTags(value: unknown): Array<{ code: string; startsAt: string | null; endsAt: string | null }> | null {
  if (!Array.isArray(value) || value.length > 100) return null;
  const tags = value.map((tag) => (isRecord(tag) ? { code: string(tag.code, 64), startsAt: optionalString(tag.startsAt, 40), endsAt: optionalString(tag.endsAt, 40) } : null));
  return tags.every((tag) => tag?.code && !/[\s,]/.test(tag.code) && validTimestamp(tag.startsAt) && validTimestamp(tag.endsAt) && (!tag.startsAt || !tag.endsAt || new Date(tag.endsAt) > new Date(tag.startsAt)))
    ? (tags as Array<{ code: string; startsAt: string | null; endsAt: string | null }>)
    : null;
}
const validTimestamp = (value: string | null) => value === null || (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(new Date(value).getTime()));
