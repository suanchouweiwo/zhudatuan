import { encryptJson, sha256 } from './crypto';
import { verifyMemberPassword } from './credentialAuth';
import { apiError, json, methodNotAllowed } from './http';
import { readTrustedClientIp } from './loginRateLimitBypass';
import { resolveMembershipRuntime } from './membershipContext';
import { generateOtp, hashPassword, maskMobile, normalizeChineseMobile, PASSWORD_POLICY_MESSAGE, phoneLookupSubject, validRegistrationPassword, verificationCodeHash } from './registrationSecurity';
import { readJsonBody } from './routerSupport';
import { deliverOtp, otpDeliveryAvailable } from './otpDelivery';
import { SmsDeliveryError } from './smsProvider';
import { clearSessionCookie, readSession } from './session';
import { callRpc } from './postgresRpc';
import type { AuthorizationContext, WorkerEnv } from './types';

type ChallengePurpose = 'password_reset' | 'phone_change';

export async function handleSecurityCenter(request: Request, env: WorkerEnv, auth: AuthorizationContext, requestId: string): Promise<Response> {
  if (request.method !== 'GET') return methodNotAllowed(['GET'], requestId);
  const session = await readSession(request, env);
  if (!session) return apiError(401, 'AUTHENTICATION_REQUIRED', '当前会话已失效', requestId);
  const data = await callRpc<Record<string, unknown> | null>(env, 'api_account_security_center', { p_member_id: auth.membership.memberId, p_current_session_id: session.sessionId });
  return data ? json({ ...data, phoneVerificationAvailable: otpDeliveryAvailable(env), requestId }) : apiError(404, 'SECURITY_PROFILE_NOT_FOUND', '安全资料不存在', requestId);
}

export async function handleChangePassword(request: Request, env: WorkerEnv, auth: AuthorizationContext, requestId: string): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed(['POST'], requestId);
  const input = await objectBody(request);
  const currentPassword = stringValue(input?.currentPassword, 128);
  const newPassword = typeof input?.newPassword === 'string' ? input.newPassword : '';
  if (!currentPassword || !validRegistrationPassword(newPassword)) return apiError(422, 'INVALID_PASSWORD_CHANGE', PASSWORD_POLICY_MESSAGE, requestId);
  if (!(await verifyMemberPassword(env, auth.membership.memberId, currentPassword))) return apiError(401, 'CURRENT_PASSWORD_INVALID', '当前密码不正确', requestId);
  if (await verifyMemberPassword(env, auth.membership.memberId, newPassword)) return apiError(422, 'PASSWORD_REUSE_FORBIDDEN', '新密码不能与当前密码相同', requestId);
  const session = await readSession(request, env);
  if (!session) return apiError(401, 'AUTHENTICATION_REQUIRED', '当前会话已失效', requestId);
  const changed = await callRpc<boolean>(env, 'api_change_local_password', { p_member_id: auth.membership.memberId, p_current_session_id: session.sessionId, p_password_hash: await hashPassword(newPassword) });
  return changed ? json({ changed: true, otherSessionsRevoked: true, requestId }) : apiError(409, 'LOCAL_CREDENTIAL_REQUIRED', '该账号尚未启用本地密码', requestId);
}

export async function handleSecurityOtp(request: Request, env: WorkerEnv, requestId: string): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed(['POST'], requestId);
  if (!otpDeliveryAvailable(env)) return apiError(503, 'SMS_PROVIDER_NOT_CONFIGURED', '短信服务尚未配置', requestId);
  const input = await objectBody(request);
  const mobile = normalizeChineseMobile(input?.mobile);
  const purpose = input?.purpose === 'password_reset' || input?.purpose === 'phone_change' ? input.purpose : null;
  if (!mobile || !purpose) return apiError(422, 'INVALID_SECURITY_CHALLENGE', '手机号或验证用途无效', requestId);
  if (purpose === 'phone_change' && !(await resolveMembershipRuntime(request, env))) {
    return apiError(401, 'AUTHENTICATION_REQUIRED', '换绑手机号必须先登录当前账号', requestId);
  }
  if (!env.IDENTITY_LOOKUP_KEY || !env.SESSION_SIGNING_KEY) return apiError(503, 'IDENTITY_SECURITY_NOT_CONFIGURED', '身份安全配置尚未完成', requestId);
  const challengeId = crypto.randomUUID();
  const code = generateOtp();
  const subject = await phoneLookupSubject(mobile, env.IDENTITY_LOOKUP_KEY);
  const created = await callRpc<boolean>(env, 'api_create_security_challenge', {
    p_challenge_id: challengeId,
    p_phone_subject: subject,
    p_phone_masked: maskMobile(mobile),
    p_purpose: purpose,
    p_code_hash: await verificationCodeHash(purpose, challengeId, code, env.IDENTITY_LOOKUP_KEY),
    p_ip_hash: await sha256(`${readTrustedClientIp(request) ?? 'unknown'}:${env.SESSION_SIGNING_KEY}`),
    p_expires_at: new Date(Date.now() + 5 * 60 * 1_000).toISOString(),
  });
  if (!created) return apiError(429, 'OTP_RATE_LIMITED', '验证码发送过于频繁，请稍后重试', requestId);
  try {
    const delivery = await deliverOtp(env, { mobile, code, challengeId, purpose });
    return json({ challengeId, expiresInSeconds: 300, resendAfterSeconds: 60, ...(delivery.debugCode ? { debugCode: delivery.debugCode } : {}), requestId });
  } catch (error) {
    const providerCode = error instanceof SmsDeliveryError ? error.code : 'SMS_DELIVERY_FAILED';
    return apiError(providerCode === 'SMS_PROVIDER_NOT_CONFIGURED' ? 503 : 502, providerCode, '验证码发送失败，请稍后重试', requestId);
  }
}

export async function handleResetPassword(request: Request, env: WorkerEnv, requestId: string): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed(['POST'], requestId);
  const input = await objectBody(request);
  const mobile = normalizeChineseMobile(input?.mobile),
    challengeId = stringValue(input?.challengeId, 80),
    code = stringValue(input?.code, 6);
  const password = typeof input?.newPassword === 'string' ? input.newPassword : '';
  if (!mobile || !challengeId || !/^\d{6}$/.test(code ?? '') || !validRegistrationPassword(password) || !env.IDENTITY_LOOKUP_KEY) return apiError(422, 'INVALID_PASSWORD_RESET', '密码重置信息无效', requestId);
  const subject = await phoneLookupSubject(mobile, env.IDENTITY_LOOKUP_KEY);
  const result = await callRpc<string>(env, 'api_reset_local_password', {
    p_challenge_id: challengeId,
    p_phone_subject: subject,
    p_code_hash: await verificationCodeHash('password_reset', challengeId, code!, env.IDENTITY_LOOKUP_KEY),
    p_password_hash: await hashPassword(password),
  });
  return result === 'changed' ? json({ changed: true, allSessionsRevoked: true, requestId }) : apiError(422, 'INVALID_OTP', '验证码不正确、已失效或尝试次数过多', requestId);
}

export async function handleChangePhone(request: Request, env: WorkerEnv, auth: AuthorizationContext, requestId: string): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed(['POST'], requestId);
  const input = await objectBody(request);
  const mobile = normalizeChineseMobile(input?.newMobile),
    challengeId = stringValue(input?.challengeId, 80),
    code = stringValue(input?.code, 6),
    password = stringValue(input?.currentPassword, 128);
  if (!mobile || !challengeId || !/^\d{6}$/.test(code ?? '') || !password || !env.IDENTITY_LOOKUP_KEY || !env.PII_ENCRYPTION_KEY) return apiError(422, 'INVALID_PHONE_CHANGE', '手机号变更信息无效', requestId);
  if (!(await verifyMemberPassword(env, auth.membership.memberId, password))) return apiError(401, 'CURRENT_PASSWORD_INVALID', '当前密码不正确', requestId);
  const session = await readSession(request, env);
  if (!session) return apiError(401, 'AUTHENTICATION_REQUIRED', '当前会话已失效', requestId);
  const subject = await phoneLookupSubject(mobile, env.IDENTITY_LOOKUP_KEY);
  const result = await callRpc<string>(env, 'api_change_local_phone', {
    p_member_id: auth.membership.memberId,
    p_challenge_id: challengeId,
    p_phone_subject: subject,
    p_code_hash: await verificationCodeHash('phone_change', challengeId, code!, env.IDENTITY_LOOKUP_KEY),
    p_phone_masked: maskMobile(mobile),
    p_phone_cipher: JSON.parse(await encryptJson({ mobile }, env.PII_ENCRYPTION_KEY)),
    p_current_session_id: session.sessionId,
  });
  if (result === 'phone_exists') return apiError(409, 'PHONE_ALREADY_REGISTERED', '该手机号已绑定其他账号', requestId);
  return result === 'changed' ? json({ changed: true, otherSessionsRevoked: true, requestId }) : apiError(422, 'INVALID_OTP', '验证码不正确、已失效或尝试次数过多', requestId);
}

export async function handleRevokeSession(request: Request, env: WorkerEnv, auth: AuthorizationContext, sessionId: string, requestId: string): Promise<Response> {
  if (request.method !== 'DELETE') return methodNotAllowed(['DELETE'], requestId);
  const current = await readSession(request, env);
  const revoked = await callRpc<boolean>(env, 'api_revoke_auth_session', { p_actor_member_id: auth.membership.memberId, p_session_id: sessionId, p_reason: 'user_revoked' });
  const headers = current?.sessionId === sessionId ? { 'set-cookie': clearSessionCookie(request) } : undefined;
  return revoked ? json({ revoked: true, currentSession: current?.sessionId === sessionId, requestId }, { headers }) : apiError(404, 'SESSION_NOT_FOUND', '登录设备不存在', requestId);
}
export async function handleRevokeOtherSessions(request: Request, env: WorkerEnv, auth: AuthorizationContext, requestId: string): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed(['POST'], requestId);
  const current = await readSession(request, env);
  if (!current) return apiError(401, 'AUTHENTICATION_REQUIRED', '当前会话已失效', requestId);
  const count = await callRpc<number>(env, 'api_revoke_other_auth_sessions', { p_actor_member_id: auth.membership.memberId, p_current_session_id: current.sessionId, p_reason: 'user_revoked_others' });
  return json({ revokedCount: count, requestId });
}
async function objectBody(request: Request) {
  const body = await readJsonBody(request);
  return body.ok && typeof body.value === 'object' && body.value !== null && !Array.isArray(body.value) ? (body.value as Record<string, unknown>) : null;
}
function stringValue(value: unknown, max: number) {
  const result = typeof value === 'string' ? value.trim() : '';
  return result && result.length <= max ? result : null;
}
