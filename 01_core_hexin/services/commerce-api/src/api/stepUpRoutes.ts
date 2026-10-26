import { sha256 } from './crypto';
import { getDemoAccounts, isDemoAuthEnabled, verifyDemoPassword } from './demoAuth';
import { verifyMemberPasswordState } from './credentialAuth';
import { apiError, json, methodNotAllowed } from './http';
import { readTrustedClientIp } from './loginRateLimitBypass';
import { readJsonBody } from './routerSupport';
import { createTrackedSessionCookie, readSession } from './session';
import { callRpc } from './postgresRpc';
import type { AuthorizationContext, WorkerEnv } from './types';

export async function handleStepUp(request: Request, env: WorkerEnv, authorization: AuthorizationContext, requestId: string): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed(['POST'], requestId);
  const body = await readJsonBody(request);
  if (!body.ok || typeof (body.value as { password?: unknown })?.password !== 'string') return apiError(400, 'INVALID_STEP_UP_INPUT', '二次验证信息不完整', requestId);
  const clientIp = readTrustedClientIp(request);
  const ipHash = await sha256(`${clientIp ?? 'unknown'}:${env.SESSION_SIGNING_KEY ?? ''}`);
  const allowed = await callRpc<boolean>(env, 'api_login_allowed', { p_ip_hash: ipHash });
  if (!allowed) return apiError(429, 'STEP_UP_RATE_LIMITED', '验证尝试过多，请15分钟后重试', requestId);
  const password = (body.value as { password: string }).password;
  const localPassword = await verifyMemberPasswordState(env, authorization.membership.memberId, password);
  const account = localPassword.configured
    ? null
    : getDemoAccounts(env).find(
        (candidate) => candidate.employeeNo === authorization.employeeNo && (authorization.membership.target === 'admin' ? candidate.adminMembershipId : candidate.storefrontMembershipId) === authorization.membership.id
      );
  const demoPasswordValid = Boolean(account && isDemoAuthEnabled(env) && (await verifyDemoPassword(password, account.password)));
  if (!localPassword.valid && !demoPasswordValid) {
    await callRpc<string | null>(env, 'api_record_login_failure', { p_ip_hash: ipHash });
    return apiError(401, 'STEP_UP_FAILED', '当前密码不正确', requestId);
  }
  await callRpc<boolean>(env, 'api_record_step_up', {
    p_actor_membership_id: authorization.membership.id,
    p_actor_user_id: authorization.userId,
    p_tenant_id: authorization.tenantId,
    p_enterprise_id: authorization.enterpriseId,
    p_mall_id: authorization.mallId,
    p_request_id: requestId,
    p_user_agent: (request.headers.get('user-agent') ?? '').slice(0, 300),
  });
  await callRpc<boolean>(env, 'api_clear_login_failures', { p_ip_hash: ipHash });
  const verifiedAt = Math.floor(Date.now() / 1_000);
  const currentSession = await readSession(request, env);
  if (currentSession) await callRpc<boolean>(env, 'api_revoke_auth_session', { p_actor_member_id: currentSession.memberId, p_session_id: currentSession.sessionId, p_reason: 'step_up_replaced' });
  const cookie = await createTrackedSessionCookie(request, env, authorization.employeeNo, authorization.mallCode, {
    target: authorization.membership.target,
    memberId: authorization.membership.memberId,
    membershipId: authorization.membership.id,
    authzVersion: authorization.membership.authzVersion,
    stepUpAt: verifiedAt,
  });
  return json({ verified: true, verifiedAt: new Date(verifiedAt * 1_000).toISOString(), requestId }, { headers: { 'set-cookie': cookie } });
}
