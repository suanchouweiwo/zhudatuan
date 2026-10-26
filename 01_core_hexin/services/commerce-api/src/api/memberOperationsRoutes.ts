import { PERMISSIONS } from '@smart-wing/api-contract';
import { authorize } from './auth';
import { sha256 } from './crypto';
import { apiError, json, methodNotAllowed } from './http';
import { hashPassword, normalizeLocalUsername, validRegistrationPassword } from './registrationSecurity';
import { authorizationEvidence, invalidBody, readJsonBody } from './routerSupport';
import { callRpc } from './postgresRpc';
import type { AuthorizationContext, WorkerEnv } from './types';

type ImportRow = { rowNumber: number; username: string; password: string; displayName: string; employeeNo?: string; email?: string; departmentId?: string };
type ImportError = { rowNumber: number; code: string; message: string; input: Record<string, unknown> };

export async function handleMemberOperations(request: Request, env: WorkerEnv, authorization: AuthorizationContext, requestId: string): Promise<Response> {
  if (request.method !== 'GET') return methodNotAllowed(['GET'], requestId);
  if (!authorize(authorization, PERMISSIONS.memberRead).allowed) return apiError(403, 'FORBIDDEN', '没有查看会员运营中心的权限', requestId);
  const data = await callRpc<Record<string, unknown> | null>(env, 'api_member_operations_center', {
    ...scope(authorization),
    p_include_pii: authorize(authorization, PERMISSIONS.memberPiiRead).allowed,
    p_include_history: authorize(authorization, PERMISSIONS.auditRead).allowed,
    p_include_import_errors: authorize(authorization, PERMISSIONS.memberImport).allowed,
  });
  return data ? json({ ...data, requestId }) : apiError(403, 'FORBIDDEN', '当前身份不能查看该会员范围', requestId);
}

export async function handleCreateMemberInvite(request: Request, env: WorkerEnv, authorization: AuthorizationContext, requestId: string): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed(['POST'], requestId);
  const decision = authorize(authorization, PERMISSIONS.memberInvite);
  if (!decision.allowed) return denied(decision.reason === 'STEP_UP_REQUIRED', '没有创建邀请码的权限', requestId);
  if (!hasFreshStepUp(authorization.stepUpAt)) return denied(true, '', requestId);
  const parsed = await objectBody(request, requestId);
  if (parsed instanceof Response) return parsed;
  const label = string(parsed.label, 80);
  const maxUses = integer(parsed.maxUses, 1, 500);
  const expiresAt = date(parsed.expiresAt);
  if (!label || label.length < 2 || !maxUses || !expiresAt || expiresAt.getTime() <= Date.now() + 10 * 60_000 || expiresAt.getTime() > Date.now() + 90 * 86_400_000) {
    return apiError(422, 'INVALID_INVITATION_INPUT', '邀请码名称、次数或有效期无效', requestId);
  }
  const code = generateInviteCode();
  const result = await callRpc<Record<string, unknown>>(env, 'api_create_membership_invite', {
    ...mutationScope(authorization),
    p_label: label,
    p_code_hash: await sha256(code),
    p_max_uses: maxUses,
    p_expires_at: expiresAt.toISOString(),
    ...audit(request, requestId, authorization, decision),
  });
  return json({ ...result, code, requestId }, { status: 201 });
}

export async function handleDisableMemberInvite(request: Request, env: WorkerEnv, authorization: AuthorizationContext, inviteId: string, requestId: string): Promise<Response> {
  if (request.method !== 'PUT') return methodNotAllowed(['PUT'], requestId);
  const decision = authorize(authorization, PERMISSIONS.memberInvite);
  if (!decision.allowed) return denied(decision.reason === 'STEP_UP_REQUIRED', '没有停用邀请码的权限', requestId);
  if (!hasFreshStepUp(authorization.stepUpAt)) return denied(true, '', requestId);
  const parsed = await objectBody(request, requestId);
  if (parsed instanceof Response) return parsed;
  const reason = string(parsed.reason, 500);
  if (!reason || reason.length < 4) return apiError(422, 'CHANGE_REASON_REQUIRED', '请输入至少4个字的停用原因', requestId);
  const result = await callRpc<Record<string, unknown>>(env, 'api_disable_membership_invite', {
    ...mutationScope(authorization),
    p_invite_id: inviteId,
    p_reason: reason,
    ...audit(request, requestId, authorization, decision),
  });
  return json({ ...result, requestId });
}

export async function handleAdminCreateMember(request: Request, env: WorkerEnv, authorization: AuthorizationContext, requestId: string): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed(['POST'], requestId);
  const decision = authorize(authorization, PERMISSIONS.memberInvite);
  if (!decision.allowed) return denied(decision.reason === 'STEP_UP_REQUIRED', '没有创建会员的权限', requestId);
  if (!hasFreshStepUp(authorization.stepUpAt)) return denied(true, '', requestId);
  const parsed = await objectBody(request, requestId);
  if (parsed instanceof Response) return parsed;
  const input = memberInput(parsed);
  if (!input) return apiError(422, 'INVALID_MEMBER_INPUT', '会员账号、密码或资料无效', requestId);
  const result = await createMember(env, authorization, request, requestId, decision, input);
  return result.status === 'active'
    ? json({ ...result, requestId }, { status: 201 })
    : apiError(result.status === 'account_exists' ? 409 : 422, result.status === 'account_exists' ? 'USERNAME_UNAVAILABLE' : 'INVALID_MEMBER_INPUT', result.status === 'account_exists' ? '用户名或员工编号已存在' : '会员资料无效', requestId);
}

export async function handleUpdateMemberProfile(request: Request, env: WorkerEnv, authorization: AuthorizationContext, membershipId: string, requestId: string): Promise<Response> {
  if (request.method !== 'PUT') return methodNotAllowed(['PUT'], requestId);
  const decision = authorize(authorization, PERMISSIONS.memberUpdate);
  if (!decision.allowed) return denied(decision.reason === 'STEP_UP_REQUIRED', '没有编辑会员的权限', requestId);
  if (!hasFreshStepUp(authorization.stepUpAt)) return denied(true, '', requestId);
  const parsed = await objectBody(request, requestId);
  if (parsed instanceof Response) return parsed;
  const displayName = string(parsed.displayName, 60);
  const email = optionalString(parsed.email, 200);
  const departmentId = optionalString(parsed.departmentId, 160);
  const reason = string(parsed.reason, 500);
  if (!displayName || !reason || reason.length < 4 || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return apiError(422, 'INVALID_MEMBER_PROFILE', '会员资料或变更原因无效', requestId);
  const result = await callRpc<Record<string, unknown>>(env, 'api_update_member_profile', {
    ...mutationScope(authorization),
    p_target_membership_id: membershipId,
    p_display_name: displayName,
    p_email: email,
    p_department_id: departmentId,
    p_reason: reason,
    ...audit(request, requestId, authorization, decision),
  });
  return json({ ...result, requestId });
}

export async function handleMemberImport(request: Request, env: WorkerEnv, authorization: AuthorizationContext, requestId: string): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed(['POST'], requestId);
  const decision = authorize(authorization, PERMISSIONS.memberImport);
  if (!decision.allowed) return denied(decision.reason === 'STEP_UP_REQUIRED', '没有批量导入会员的权限', requestId);
  if (!hasFreshStepUp(authorization.stepUpAt)) return denied(true, '', requestId);
  const parsed = await importBody(request, requestId);
  if (parsed instanceof Response) return parsed;
  const sourceName = string(parsed.sourceName, 200);
  const rows = Array.isArray(parsed.rows) ? parsed.rows : [];
  if (!sourceName || rows.length < 1 || rows.length > 500) return apiError(422, 'INVALID_IMPORT_INPUT', '导入文件名称或行数无效', requestId);
  const errors: ImportError[] = [];
  let successRows = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const candidate = isRecord(rows[index]) ? { ...rows[index], rowNumber: index + 2 } : null;
    const input = candidate && memberInput(candidate);
    if (!input) {
      errors.push(errorRow(index + 2, 'INVALID_MEMBER_INPUT', '账号、密码或会员资料无效', candidate));
      continue;
    }
    const result = await createMember(env, authorization, request, `${requestId}:row:${index + 2}`, decision, input);
    if (result.status === 'active') successRows += 1;
    else errors.push(errorRow(index + 2, result.status === 'account_exists' ? 'USERNAME_UNAVAILABLE' : 'INVALID_MEMBER_INPUT', result.status === 'account_exists' ? '用户名或员工编号已存在' : '会员资料无效', candidate));
  }
  const jobId = crypto.randomUUID();
  const report = await callRpc<Record<string, unknown>>(env, 'api_record_member_import', {
    p_job_id: jobId,
    ...scope(authorization),
    p_source_name: sourceName,
    p_total_rows: rows.length,
    p_success_rows: successRows,
    p_errors: errors,
  });
  return json({ ...report, requestId }, { status: errors.length ? 207 : 201 });
}

function createMember(env: WorkerEnv, authorization: AuthorizationContext, request: Request, requestId: string, decision: ReturnType<typeof authorize>, input: Omit<ImportRow, 'rowNumber'>) {
  return hashPassword(input.password).then((passwordHash) =>
    callRpc<{ status?: string; membershipId?: string; employeeNo?: string; username?: string }>(env, 'api_admin_create_member', {
      ...mutationScope(authorization),
      p_username: input.username,
      p_password_hash: passwordHash,
      p_display_name: input.displayName,
      p_employee_no: input.employeeNo ?? null,
      p_email: input.email ?? null,
      p_department_id: input.departmentId ?? null,
      ...audit(request, requestId, authorization, decision),
    })
  );
}

function memberInput(value: Record<string, unknown>): Omit<ImportRow, 'rowNumber'> | null {
  const username = normalizeLocalUsername(value.username);
  const password = typeof value.password === 'string' ? value.password : '';
  const displayName = string(value.displayName, 60);
  const employeeNo = optionalString(value.employeeNo, 40)?.toUpperCase();
  const email = optionalString(value.email, 200);
  const departmentId = optionalString(value.departmentId, 160);
  if (!username || !validRegistrationPassword(password) || !displayName || (employeeNo && !/^[A-Z0-9_-]{2,40}$/.test(employeeNo)) || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return null;
  return { username, password, displayName, ...(employeeNo ? { employeeNo } : {}), ...(email ? { email } : {}), ...(departmentId ? { departmentId } : {}) };
}

async function objectBody(request: Request, requestId: string): Promise<Record<string, unknown> | Response> {
  const body = await readJsonBody(request);
  if (!body.ok) return invalidBody(body.tooLarge, requestId);
  return isRecord(body.value) ? body.value : apiError(422, 'INVALID_INPUT', '提交信息无效', requestId);
}
async function importBody(request: Request, requestId: string): Promise<Record<string, unknown> | Response> {
  const declared = Number.parseInt(request.headers.get('content-length') ?? '0', 10);
  if (declared > 1_000_000) return apiError(413, 'REQUEST_TOO_LARGE', '批量导入内容超过1MB', requestId);
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > 1_000_000) return apiError(413, 'REQUEST_TOO_LARGE', '批量导入内容超过1MB', requestId);
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : apiError(422, 'INVALID_IMPORT_INPUT', '批量导入内容无效', requestId);
  } catch {
    return apiError(400, 'INVALID_JSON', '批量导入内容不是有效 JSON', requestId);
  }
}
function scope(context: AuthorizationContext) {
  return { p_actor_membership_id: context.membership.id, p_tenant_id: context.tenantId, p_enterprise_id: context.enterpriseId, p_mall_id: context.mallId };
}
function mutationScope(context: AuthorizationContext) {
  return { ...scope(context), p_actor_user_id: context.userId };
}
function audit(request: Request, requestId: string, context: AuthorizationContext, decision: ReturnType<typeof authorize>) {
  return { p_request_id: requestId, p_user_agent: (request.headers.get('user-agent') ?? '').slice(0, 300), p_granted_via: authorizationEvidence(context, decision) };
}
function denied(stepUp: boolean, message: string, requestId: string) {
  return stepUp ? apiError(403, 'STEP_UP_REQUIRED', '该操作需要重新验证身份', requestId) : apiError(403, 'FORBIDDEN', message, requestId);
}
function hasFreshStepUp(stepUpAt: string | null) {
  if (!stepUpAt) return false;
  const timestamp = new Date(stepUpAt).getTime();
  return Number.isFinite(timestamp) && timestamp <= Date.now() && Date.now() - timestamp <= 15 * 60_000;
}
function generateInviteCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `SW-${Array.from(bytes, (byte) => byte.toString(36).padStart(2, '0'))
    .join('')
    .toUpperCase()}`;
}
function date(value: unknown) {
  const result = typeof value === 'string' ? new Date(value) : new Date(Number.NaN);
  return Number.isFinite(result.getTime()) ? result : null;
}
function integer(value: unknown, minimum: number, maximum: number) {
  return Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum ? Number(value) : null;
}
function string(value: unknown, maximum: number) {
  const result = typeof value === 'string' ? value.trim() : '';
  return result && result.length <= maximum ? result : null;
}
function optionalString(value: unknown, maximum: number) {
  if (value === undefined || value === null || value === '') return null;
  return string(value, maximum);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function errorRow(rowNumber: number, code: string, message: string, input: Record<string, unknown> | null): ImportError {
  const safe = input
    ? Object.fromEntries(
        Object.entries(input)
          .filter(([key]) => key !== 'password')
          .slice(0, 20)
      )
    : {};
  return { rowNumber, code, message, input: safe };
}
