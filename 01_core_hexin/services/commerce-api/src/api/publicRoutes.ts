import { sha256 } from './crypto';
import { getDemoAccounts, isDemoAuthEnabled, resolveDemoMembership, verifyDemoPassword } from './demoAuth';
import { apiError, json, methodNotAllowed } from './http';
import { isTestLoginRateLimitBypassed, readTrustedClientIp } from './loginRateLimitBypass';
import { resolveMembershipRuntimeByIds, type MembershipRuntime } from './membershipContext';
import { localPhoneSubject } from './registrationRoutes';
import { hashPassword, normalizeChineseMobile, normalizeLocalUsername, PASSWORD_POLICY_MESSAGE, validRegistrationPassword, verifyPassword } from './registrationSecurity';
import { readJsonBody } from './routerSupport';
import { clearSessionCookie, createTrackedSessionCookie, readSession, targetForRequest } from './session';
import { callRpc, isPostgresConfigured } from './postgresRpc';
import type { AuthorizationContext, WorkerEnv } from './types';

interface CatalogRow {
  id: string;
  sku_id: string;
  name: string;
  name_en: string | null;
  name_zh: string | null;
  subtitle: string | null;
  subtitle_en: string | null;
  subtitle_zh: string | null;
  category_code: string;
  taxonomy_l1: string | null;
  taxonomy_l2: string | null;
  taxonomy_l3: string | null;
  classification_status: string;
  cover_url: string | null;
  price_cents: number;
  market_price_cents: number | null;
  available_stock: number;
  supplier_name: string;
  is_test: boolean;
  purchasable: boolean;
  qualification: Record<string, unknown>;
}

export async function handleHealth(request: Request, env: WorkerEnv, requestId: string): Promise<Response> {
  if (request.method !== 'GET') return methodNotAllowed(['GET'], requestId);
  let health = { databaseReady: false, tableCount: 0 };
  if (isPostgresConfigured(env)) {
    health = await callRpc<typeof health>(env, 'api_health');
  }
  const authReady = Boolean(env.SESSION_SIGNING_KEY && env.ADMIN_SESSION_SIGNING_KEY && (env.AUTH_MODE === 'membership' || isDemoAuthEnabled(env)));
  const piiReady = Boolean(env.PII_ENCRYPTION_KEY);
  const status = health.databaseReady && authReady && piiReady ? 'ok' : 'degraded';
  return json({
    service: 'smart-wing-production-mvp',
    status,
    checks: {
      database: health.databaseReady ? 'ready' : 'configuration_required',
      authentication: authReady ? 'mvp_session_ready' : 'awaiting_enterprise_provider',
      piiEncryption: piiReady ? 'configured' : 'required_for_orders',
    },
    database: { provider: 'PostgreSQL', region: env.DATABASE_REGION ?? 'unconfigured' },
    requestId,
  });
}

export async function handleLogin(request: Request, env: WorkerEnv, requestId: string): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed(['POST'], requestId);
  if (!loginOriginAllowed(request, env)) {
    return apiError(403, 'LOGIN_ORIGIN_NOT_ALLOWED', '登录请求来源不在允许清单', requestId);
  }
  const registeredAuthEnabled = isPostgresConfigured(env);
  if (!registeredAuthEnabled && !isDemoAuthEnabled(env)) {
    return apiError(503, 'AUTH_PROVIDER_NOT_CONFIGURED', '生产环境仅接受已配置的企业身份提供方登录', requestId);
  }
  const input = await readLoginInput(request);
  if (!input) return apiError(400, 'INVALID_LOGIN_INPUT', '登录信息不完整', requestId);
  const username = typeof input.username === 'string' ? input.username : '';
  const password = typeof input.password === 'string' ? input.password : '';
  const clientIp = readTrustedClientIp(request);
  const ipHash = await sha256(`${clientIp ?? 'unknown'}:${env.SESSION_SIGNING_KEY ?? ''}`);
  const bypassRateLimit = isTestLoginRateLimitBypassed(clientIp, env);
  if (bypassRateLimit) {
    console.info(
      JSON.stringify({
        event: 'login_rate_limit_bypassed',
        requestId,
        ipHash,
        bypassFrom: env.TEST_LOGIN_RATE_LIMIT_BYPASS_FROM,
        bypassUntil: env.TEST_LOGIN_RATE_LIMIT_BYPASS_UNTIL,
      })
    );
  } else {
    const loginAllowed = await callRpc<boolean>(env, 'api_login_allowed', {
      p_ip_hash: ipHash,
    });
    if (!loginAllowed) {
      return apiError(429, 'LOGIN_RATE_LIMITED', '登录尝试过多，请15分钟后重试', requestId);
    }
  }

  if (username.trim() === '' || password.length === 0) {
    return apiError(400, 'INVALID_LOGIN_INPUT', '账号或密码缺失', requestId);
  }
  const target = targetForRequest(request);
  const localLogin = registeredAuthEnabled ? await authenticateLocalMember(username, password, target, env) : { runtime: null, credentialFound: false, mustResetPassword: false, passwordHash: null };
  if (localLogin.selectionRequired) {
    return apiError(409, 'MEMBERSHIP_SELECTION_REQUIRED', '该账号存在多个可用身份；服务端身份选择接通前不会建立会话', requestId);
  }
  const registeredRuntime = localLogin.runtime;
  const account = registeredRuntime || localLogin.credentialFound ? null : getDemoAccounts(env).find((candidate) => candidate.username.trim().toLowerCase() === username.trim().toLowerCase());
  const demoRuntime = account && (await verifyDemoPassword(password, account.password)) ? await resolveDemoMembership(env, account, target) : null;
  const runtime = registeredRuntime ?? demoRuntime;
  if (!runtime) {
    if (!bypassRateLimit) {
      await callRpc<string | null>(env, 'api_record_login_failure', {
        p_ip_hash: ipHash,
      });
    }
    return apiError(401, 'INVALID_USERNAME_PASSWORD', '账号或密码不正确', requestId);
  }
  if (registeredRuntime && localLogin.mustResetPassword) {
    return apiError(403, 'PASSWORD_RESET_REQUIRED', '首次登录必须先修改临时密码', requestId);
  }
  await callRpc<boolean>(env, 'api_clear_login_failures', { p_ip_hash: ipHash });
  const cookie = await createTrackedSessionCookie(request, env, runtime.authorization.employeeNo, runtime.authorization.mallCode, {
    target,
    memberId: runtime.membership.memberId,
    membershipId: runtime.membership.id,
    authzVersion: runtime.membership.authzVersion,
  });
  const redirect = safeLoginRedirect(request);
  if (redirect) {
    // A top-level form POST lets the destination host set its own host-only
    // cookie, then returns the browser to a site-local path. This is required
    // for both the standalone accounts site -> storefront flow and admin
    // login. No password or ticket is placed in the URL.
    return new Response(null, {
      status: 303,
      headers: { 'set-cookie': cookie, location: redirect },
    });
  }
  return json({ authenticated: true, authorization: publicAuthorization(runtime.authorization), requestId }, { headers: { 'set-cookie': cookie } });
}

export async function handleRegisteredCredentialDiscovery(request: Request, env: WorkerEnv, requestId: string): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed(['POST'], requestId);
  if (!loginOriginAllowed(request, env)) {
    return apiError(403, 'LOGIN_ORIGIN_NOT_ALLOWED', '登录请求来源不在允许清单', requestId);
  }
  if (!isPostgresConfigured(env)) {
    return apiError(503, 'AUTH_PROVIDER_NOT_CONFIGURED', '会员账号服务尚未配置', requestId);
  }
  const input = await readLoginInput(request);
  const username = typeof input?.username === 'string' ? input.username : '';
  const password = typeof input?.password === 'string' ? input.password : '';
  if (!username || !password) return apiError(400, 'INVALID_LOGIN_INPUT', '登录信息不完整', requestId);

  const clientIp = readTrustedClientIp(request);
  const ipHash = await sha256(`${clientIp ?? 'unknown'}:${env.SESSION_SIGNING_KEY ?? ''}`);
  const bypassRateLimit = isTestLoginRateLimitBypassed(clientIp, env);
  if (!bypassRateLimit) {
    const loginAllowed = await callRpc<boolean>(env, 'api_login_allowed', { p_ip_hash: ipHash });
    if (!loginAllowed) return apiError(429, 'LOGIN_RATE_LIMITED', '登录尝试过多，请15分钟后重试', requestId);
  }

  const localLogin = await authenticateLocalMember(username, password, undefined, env);
  if (localLogin.selectionRequired) {
    return apiError(409, 'MEMBERSHIP_SELECTION_REQUIRED', '该账号存在多个可用身份；服务端身份选择接通前不会建立会话', requestId);
  }
  const demoAccount = localLogin.credentialFound ? null : getDemoAccounts(env).find((candidate) => candidate.username.trim().toLowerCase() === username.trim().toLowerCase());
  const demoTarget = demoAccount?.adminMembershipId ? 'admin' : 'storefront';
  const demoRuntime = demoAccount && (await verifyDemoPassword(password, demoAccount.password)) ? await resolveDemoMembership(env, demoAccount, demoTarget) : null;
  const runtime = localLogin.runtime ?? demoRuntime;
  if (!runtime) {
    if (!bypassRateLimit) await callRpc<string | null>(env, 'api_record_login_failure', { p_ip_hash: ipHash });
    return apiError(401, 'INVALID_USERNAME_PASSWORD', '账号或密码不正确', requestId);
  }
  await callRpc<boolean>(env, 'api_clear_login_failures', { p_ip_hash: ipHash });
  return json({ authenticated: true, requiresPasswordReset: localLogin.mustResetPassword, authorization: publicAuthorization(runtime.authorization), requestId });
}

export async function handleInitialPasswordChange(request: Request, env: WorkerEnv, requestId: string): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed(['POST'], requestId);
  if (!loginOriginAllowed(request, env)) {
    return apiError(403, 'LOGIN_ORIGIN_NOT_ALLOWED', '登录请求来源不在允许清单', requestId);
  }
  const input = await readLoginInput(request);
  const username = typeof input?.username === 'string' ? input.username : '';
  const currentPassword = typeof input?.password === 'string' ? input.password : '';
  const newPassword = typeof input?.newPassword === 'string' ? input.newPassword : '';
  if (!username || !currentPassword || !validRegistrationPassword(newPassword)) return apiError(422, 'INVALID_PASSWORD_CHANGE', PASSWORD_POLICY_MESSAGE, requestId);
  const clientIp = readTrustedClientIp(request);
  const ipHash = await sha256(`${clientIp ?? 'unknown'}:${env.SESSION_SIGNING_KEY ?? ''}`);
  if (!(await callRpc<boolean>(env, 'api_login_allowed', { p_ip_hash: ipHash }))) return apiError(429, 'LOGIN_RATE_LIMITED', '登录尝试过多，请15分钟后重试', requestId);
  const localLogin = await authenticateLocalMember(username, currentPassword, undefined, env);
  if (!localLogin.runtime || !localLogin.mustResetPassword || !localLogin.passwordHash) {
    await callRpc<string | null>(env, 'api_record_login_failure', { p_ip_hash: ipHash });
    return apiError(401, 'INVALID_USERNAME_PASSWORD', '账号或临时密码不正确', requestId);
  }
  if (await verifyPassword(newPassword, localLogin.passwordHash)) return apiError(422, 'PASSWORD_REUSE_FORBIDDEN', '新密码不能与临时密码相同', requestId);
  const changed = await callRpc<boolean>(env, 'api_initial_change_local_password', {
    p_member_id: localLogin.runtime.membership.memberId,
    p_password_hash: await hashPassword(newPassword),
    p_request_id: requestId,
    p_user_agent: (request.headers.get('user-agent') ?? '').slice(0, 300),
  });
  if (!changed) return apiError(409, 'PASSWORD_RESET_STATE_CHANGED', '初始密码状态已变化，请重新登录', requestId);
  await callRpc<boolean>(env, 'api_clear_login_failures', { p_ip_hash: ipHash });
  return json({ changed: true, loginRequired: true, requestId });
}

type RegisteredCandidate = {
  memberId?: string;
  membershipId?: string;
  target?: 'storefront' | 'admin';
  passwordHash?: string;
  mustResetPassword?: boolean;
  entrances?: unknown[];
};
type LocalLogin = {
  runtime: MembershipRuntime | null;
  credentialFound: boolean;
  mustResetPassword: boolean;
  passwordHash: string | null;
  selectionRequired?: boolean;
};
const DUMMY_PASSWORD_HASH = `pbkdf2-sha256$310000$AAAAAAAAAAAAAAAAAAAAAA==$${'A'.repeat(43)}=`;

export async function authenticateLocalMember(identifier: string, password: string, target: 'storefront' | 'admin' | undefined, env: WorkerEnv): Promise<LocalLogin> {
  const mobile = normalizeChineseMobile(identifier);
  const username = normalizeLocalUsername(identifier);
  const normalizedIdentifier = identifier.trim().toLowerCase();
  const demoAlias = isDemoAuthEnabled(env) && getDemoAccounts(env).some((candidate) => candidate.username.trim().toLowerCase() === normalizedIdentifier);
  const provider = mobile ? 'local_phone' : demoAlias ? 'test' : username ? 'local_username' : isDemoAuthEnabled(env) ? 'test' : null;
  const subject = mobile ? await localPhoneSubject(mobile, env) : (username ?? identifier.trim().toLowerCase());
  if (!provider || !subject) return { runtime: null, credentialFound: false, mustResetPassword: false, passwordHash: null };
  const candidate = await callRpc<RegisteredCandidate | null>(env, 'api_local_login_candidate', {
    p_provider: provider,
    p_subject: subject,
    p_target: target ?? null,
  });
  if (!candidate?.memberId || !candidate.membershipId || !candidate.passwordHash) {
    await verifyPassword(password, DUMMY_PASSWORD_HASH);
    return { runtime: null, credentialFound: false, mustResetPassword: false, passwordHash: null };
  }
  if (!(await verifyPassword(password, candidate.passwordHash))) return { runtime: null, credentialFound: true, mustResetPassword: false, passwordHash: null };
  const selectionRequired = env.AUTH_MODE === 'membership' && (!Array.isArray(candidate.entrances) || candidate.entrances.length !== 1);
  if (selectionRequired) {
    return {
      runtime: null,
      credentialFound: true,
      mustResetPassword: candidate.mustResetPassword === true,
      passwordHash: candidate.passwordHash,
      selectionRequired: true,
    };
  }
  const resolvedTarget = candidate.target ?? target;
  if (!resolvedTarget) return { runtime: null, credentialFound: true, mustResetPassword: false, passwordHash: null };
  return {
    runtime: await resolveMembershipRuntimeByIds(env, candidate.memberId, candidate.membershipId, resolvedTarget),
    credentialFound: true,
    mustResetPassword: candidate.mustResetPassword === true,
    passwordHash: candidate.passwordHash,
    selectionRequired: false,
  };
}

async function readLoginInput(request: Request): Promise<Record<string, unknown> | null> {
  if (request.headers.get('content-type')?.toLowerCase().startsWith('application/x-www-form-urlencoded')) {
    const raw = await request.text();
    if (raw.length > 32 * 1024) return null;
    const form = new URLSearchParams(raw);
    return { username: form.get('username') ?? '', password: form.get('password') ?? '' };
  }

  const body = await readJsonBody(request);
  return body.ok && typeof body.value === 'object' && body.value !== null ? (body.value as Record<string, unknown>) : null;
}

function safeLoginRedirect(request: Request): string | null {
  const requestUrl = new URL(request.url);
  const requested = requestUrl.searchParams.get('redirect');
  if (!requested) return null;
  let decoded = requested;
  try {
    // Decode twice so encoded path separators or controls cannot become an
    // unsafe second-stage Location after an intermediary normalization.
    decoded = decodeURIComponent(decoded);
    decoded = decodeURIComponent(decoded);
  } catch {
    return null;
  }
  if (!decoded.startsWith('/') || decoded.startsWith('//') || decoded.includes('\\') || /[\u0000-\u001f\u007f]/.test(decoded)) return null;
  try {
    const destination = new URL(requested, requestUrl);
    const location = `${destination.pathname}${destination.search}${destination.hash}`;
    if (destination.origin !== requestUrl.origin || !location.startsWith('/') || location.startsWith('//') || location.includes('\\') || /[\u0000-\u001f\u007f]/.test(location)) return null;
    return location;
  } catch {
    return null;
  }
}

function loginOriginAllowed(request: Request, env: WorkerEnv): boolean {
  const requestOrigin = new URL(request.url).origin;
  const suppliedOrigin = request.headers.get('origin');
  const fetchSite = request.headers.get('sec-fetch-site');
  const isExplicitDevelopment = env.APP_ENV === 'development' || env.APP_ENV === 'test';

  // Only an explicitly configured development/test runtime may accept a
  // same-site request without Origin. Missing production configuration must
  // fail closed instead of silently enabling the local compatibility path.
  if (!suppliedOrigin) return isExplicitDevelopment && fetchSite !== 'cross-site';

  const allowed = new Set(['https://zhudatuan.com', 'https://accounts.zhudatuan.com', 'https://console.zhudatuan.com']);
  if (isExplicitDevelopment) {
    allowed.add(requestOrigin);
    allowed.add('http://127.0.0.1:3002');
    allowed.add('http://localhost:3002');
  }
  return allowed.has(suppliedOrigin);
}

function publicAuthorization(context: import('./types').AuthorizationContext) {
  return {
    memberId: context.membership.memberId,
    membershipId: context.membership.id,
    target: context.membership.target,
    roles: context.roles,
    permissions: context.permissions,
  };
}

export async function handleLogout(request: Request, env: WorkerEnv, requestId: string): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed(['POST'], requestId);
  if (!loginOriginAllowed(request, env)) {
    return apiError(403, 'LOGIN_ORIGIN_NOT_ALLOWED', '退出请求来源不在允许清单', requestId);
  }
  const session = await readSession(request, env);
  if (session) await callRpc<boolean>(env, 'api_revoke_auth_session', { p_actor_member_id: session.memberId, p_session_id: session.sessionId, p_reason: 'logout' });
  return json({ authenticated: false, requestId }, { headers: { 'set-cookie': clearSessionCookie(request) } });
}

export async function handleProducts(request: Request, env: WorkerEnv, authorization: AuthorizationContext, requestId: string): Promise<Response> {
  if (request.method !== 'GET') return methodNotAllowed(['GET'], requestId);
  const url = new URL(request.url);
  const category = url.searchParams.get('category')?.slice(0, 80) ?? null;
  const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get('limit') ?? '24', 10) || 24, 1), 100);
  const cursor = Math.max(Number.parseInt(url.searchParams.get('cursor') ?? '0', 10) || 0, 0);
  const rows = await callRpc<CatalogRow[]>(env, 'api_catalog_qualified', {
    p_tenant_id: authorization.tenantId,
    p_enterprise_id: authorization.enterpriseId,
    p_mall_id: authorization.mallId,
    p_user_id: authorization.userId,
    p_membership_id: authorization.membership.id,
    p_category: category,
    p_limit: limit,
    p_offset: cursor,
  });
  return json({
    items: rows.map((row) => ({
      id: row.id,
      skuId: row.sku_id,
      name: row.name,
      nameEn: row.name_en,
      nameZh: row.name_zh,
      subtitle: row.subtitle,
      subtitleEn: row.subtitle_en,
      subtitleZh: row.subtitle_zh,
      categoryCode: row.category_code,
      taxonomy: {
        l1: row.taxonomy_l1,
        l2: row.taxonomy_l2,
        l3: row.taxonomy_l3,
        status: row.classification_status,
      },
      coverUrl: row.cover_url,
      priceCents: Number(row.price_cents),
      marketPriceCents: row.market_price_cents === null ? null : Number(row.market_price_cents),
      availableStock: row.available_stock,
      supplierName: row.supplier_name,
      isTest: row.is_test,
      purchasable: row.purchasable,
      qualification: row.qualification,
    })),
    pagination: {
      cursor,
      nextCursor: rows.length === limit ? cursor + limit : null,
      limit,
    },
    requestId,
  });
}
