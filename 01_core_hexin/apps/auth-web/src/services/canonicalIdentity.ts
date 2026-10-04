import { PASSWORD_POLICY_MESSAGE } from '@shop/contract/password-policy';
import { createResourceCache } from '@shop/interaction';
import { beginBrowserAuthorization } from '@shop/sdk/browser-authorization';
import { createSecureId } from '@shop/sdk/context';
import { z } from 'zod';
import type { Membership, PreAuthContext } from '../types';
import { currentIdentityNode, currentLoginIntent } from './identityNodeEnvironment';

const DEVICE_KEY = 'zhudatuan:identity:device:v1';
const storefrontSessionCache = createResourceCache<string | null>({
  namespace: 'auth-session',
  schema: 'v1',
  validate: (value): value is string | null => value === null || typeof value === 'string',
});

const MembershipSelectionSchema = z.strictObject({
  principal: z.string().min(1),
  memberships: z.array(z.strictObject({
    id: z.string().min(1),
    client: z.enum(['console', 'storefront', 'store', 'supplier']),
  })),
});

const SessionCreatedSchema = z.object({
  session: z.string().min(1),
  csrf: z.string().min(16),
  expiresIn: z.number().int().positive(),
  membership: z.string().min(1),
  target: z.enum(['console', 'storefront', 'store', 'supplier']),
  callback: z.strictObject({
    ticket: z.string().min(64).max(128),
    state: z.string().min(32).max(128),
  }),
});

const LoginResultSchema = z.union([MembershipSelectionSchema, SessionCreatedSchema]);

const TicketExchangeSchema = z.strictObject({
  returnTarget: z.strictObject({
    url: z.url(),
    proof: z.string().min(16),
    expiresAt: z.iso.datetime(),
  }),
  expiresIn: z.number().int().positive(),
});

const LoginChallengeSchema = z.strictObject({
  id: z.string().min(1),
  purpose: z.literal('login'),
  expires_at: z.iso.datetime(),
});

const PasswordResetChallengeSchema = z.strictObject({
  id: z.string().min(1),
  purpose: z.literal('password_reset'),
  expires_at: z.iso.datetime(),
});

const CurrentStorefrontSessionSchema = z.object({
  target: z.literal('storefront'),
  governance: z.object({ organization: z.string().min(1) }),
});

export type CanonicalConsoleLoginResult =
  | Readonly<{ kind: 'selection'; context: PreAuthContext }>
  | Readonly<{ kind: 'authenticated'; membership: string; redirectUrl: string }>;

export type CanonicalStorefrontLoginResult = Readonly<{
  membership: string;
  redirectUrl: string;
}>;

export interface CanonicalAuthorization {
  readonly request: Readonly<{ state: string; nonce: string; challenge: string }>;
  readonly secret: Readonly<{ nonce: string; verifier: string }>;
}

export interface CanonicalSessionCallback {
  readonly ticket: string;
  readonly state: string;
}

export interface CanonicalLoginChallenge {
  readonly challengeId: string;
  readonly expiresAt: string;
}

export interface CanonicalPasswordResetChallenge {
  readonly challengeId: string;
  readonly expiresAt: string;
}

export async function currentCanonicalStorefrontOrganization(signal?: AbortSignal): Promise<string | null> {
  const request = storefrontSessionCache.revalidate('current', async (requestSignal) => {
    const response = await fetch(new URL('/api/v1/identity/session', storefrontApiOrigin()), {
      method: 'GET',
      credentials: 'include',
      redirect: 'error',
      headers: {
        accept: 'application/json',
        'x-client-version': clientVersion(),
        'x-device-id': deviceId(),
        'x-request-id': createSecureId(),
      },
      signal: requestSignal,
    });
    if (!response.ok) return null;
    const parsed = CurrentStorefrontSessionSchema.safeParse(await response.json().catch(() => null));
    return parsed.success ? parsed.data.governance.organization : null;
  });
  return waitForSharedRequest(request, signal);
}

function waitForSharedRequest<Value>(request: Promise<Value>, signal?: AbortSignal): Promise<Value> {
  if (!signal) return request;
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise<Value>((resolve, reject) => {
    const abort = () => reject(new DOMException('Aborted', 'AbortError'));
    const settle = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    request.then(
      (value) => {
        settle();
        resolve(value);
      },
      (reason: unknown) => {
        settle();
        reject(reason);
      },
    );
  });
}

type LoginCredential =
  | Readonly<{ provider: 'password'; subject: string; password: string }>
  | Readonly<{ provider: 'phone_otp'; subject: string; challenge: string; code: string }>;

export async function createCanonicalLoginChallenge(phone: string, signal?: AbortSignal): Promise<CanonicalLoginChallenge> {
  const response = await identityRequest('/api/v1/identity/challenges', {
    purpose: 'login',
    destination: canonicalMobile(phone),
  }, signal);
  void LoginChallengeSchema.safeParse(response);
  const output = response as z.infer<typeof LoginChallengeSchema>;
  return Object.freeze({ challengeId: output.id, expiresAt: output.expires_at });
}

export async function loginCanonicalConsole(
  subject: string,
  password: string,
  membership?: string,
  signal?: AbortSignal,
  options: CanonicalConsoleLoginOptions = {},
): Promise<CanonicalConsoleLoginResult> {
  return loginCanonicalConsoleWithCredential(
    { provider: 'password', subject: canonicalPasswordSubject(subject), password }, membership, signal, options,
  );
}

export interface CanonicalConsoleLoginOptions {
  readonly target?: string;
  readonly expectedOrigin?: string;
}

export async function loginCanonicalStorefront(
  subject: string,
  password: string,
  membership: string,
  application: string,
  signal?: AbortSignal,
): Promise<CanonicalStorefrontLoginResult> {
  const target = canonicalStorefrontAuthTarget(application);
  const result = await authorizeCanonicalCredential(
    { provider: 'password', subject: canonicalPasswordSubject(subject), password },
    target,
    membership,
    signal,
    { application: canonicalApplication(application), expectedSessionTarget: 'storefront' },
  );
  if (result.kind === 'selection') throw new Error('新注册的消费者身份未能直接进入商城，请重新登录');
  return Object.freeze({
    membership: result.session.membership,
    redirectUrl: approvedStorefrontDestination(result.exchange.returnTarget),
  });
}

export async function loginCanonicalStorefrontEntry(
  subject: string,
  password: string,
  application: string,
  signal?: AbortSignal,
  membership?: string,
): Promise<CanonicalStorefrontLoginResult | Readonly<{ kind: 'selection'; memberships: readonly string[] }>> {
  const target = canonicalStorefrontAuthTarget(application);
  const result = await authorizeCanonicalCredential(
    { provider: 'password', subject: canonicalPasswordSubject(subject), password },
    target,
    membership,
    signal,
    { application: canonicalApplication(application), expectedSessionTarget: 'storefront' },
  );
  if (result.kind === 'selection') {
    const memberships = result.selection.memberships.filter((item) => item.client === 'storefront').map((item) => item.id);
    if (memberships.length === 0) throw new Error('该手机号尚未开通当前商城，请先注册');
    return Object.freeze({ kind: 'selection', memberships });
  }
  return Object.freeze({
    membership: result.session.membership,
    redirectUrl: approvedStorefrontDestination(result.exchange.returnTarget),
  });
}

export async function exchangeCanonicalStorefrontSession(
  callback: CanonicalSessionCallback,
  secret: CanonicalAuthorization['secret'],
  signal?: AbortSignal,
): Promise<string> {
  const response = await identityRequest('/api/v1/identity/tickets/exchange', {
    ticket: callback.ticket,
    state: callback.state,
    nonce: secret.nonce,
    verifier: secret.verifier,
  }, signal, { origin: storefrontApiOrigin() });
  void TicketExchangeSchema.safeParse(response);
  const exchanged = response as z.infer<typeof TicketExchangeSchema>;
  return approvedStorefrontDestination(exchanged.returnTarget);
}

export async function createCanonicalPasswordResetChallenge(
  phone: string,
  signal?: AbortSignal,
): Promise<CanonicalPasswordResetChallenge> {
  const response = await identityRequest('/api/v1/identity/challenges', {
    purpose: 'password_reset',
    destination: canonicalMobile(phone),
  }, signal, { credentials: 'omit', action: '密码找回' });
  void PasswordResetChallengeSchema.safeParse(response);
  const output = response as z.infer<typeof PasswordResetChallengeSchema>;
  return Object.freeze({ challengeId: output.id, expiresAt: output.expires_at });
}

export async function resetCanonicalPassword(
  challenge: string,
  code: string,
  newPassword: string,
  signal?: AbortSignal,
): Promise<void> {
  const normalizedChallenge = challenge.trim();
  const normalizedCode = code.trim();
  if (!/^challenge:[A-Za-z0-9:-]{16,128}$/.test(normalizedChallenge)) throw new Error('请先获取短信验证码');
  if (!/^\d{6}$/.test(normalizedCode)) throw new Error('请输入 6 位短信验证码');
  await identityRequest('/api/v1/identity/password/reset', {
    challenge: normalizedChallenge,
    code: normalizedCode,
    newPassword,
  }, signal, { credentials: 'omit', action: '密码重置' });
}

export async function loginCanonicalConsoleWithOtp(
  phone: string,
  challenge: string,
  code: string,
  membership?: string,
  signal?: AbortSignal,
): Promise<CanonicalConsoleLoginResult> {
  const normalizedChallenge = challenge.trim();
  const normalizedCode = code.trim();
  if (!/^challenge:[A-Za-z0-9:-]{16,128}$/.test(normalizedChallenge)) throw new Error('请先获取短信验证码');
  if (!/^\d{6}$/.test(normalizedCode)) throw new Error('请输入 6 位短信验证码');
  return loginCanonicalConsoleWithCredential({
    provider: 'phone_otp',
    subject: canonicalMobile(phone),
    challenge: normalizedChallenge,
    code: normalizedCode,
  }, membership, signal);
}

async function loginCanonicalConsoleWithCredential(
  credential: LoginCredential,
  membership?: string,
  signal?: AbortSignal,
  options: CanonicalConsoleLoginOptions = {},
): Promise<CanonicalConsoleLoginResult> {
  const entryTarget = options.target ?? 'console';
  const result = await authorizeCanonicalCredential(credential, entryTarget, membership, signal, { expectedSessionTarget: 'console' });
  if (result.kind === 'selection') {
    const context: PreAuthContext = {
      identifier: credential.subject,
      loginMethod: credential.provider === 'phone_otp' ? 'otp' : 'password',
      memberships: result.selection.memberships.map(consoleMembership),
    };
    return Object.freeze({
      kind: 'selection',
      context,
    });
  }

  const redirectUrl = approvedConsoleDestination(result.exchange.returnTarget, options.expectedOrigin);
  return Object.freeze({ kind: 'authenticated', membership: result.session.membership, redirectUrl });
}

type CanonicalTarget = z.infer<typeof SessionCreatedSchema>['target'];
type CanonicalAuthTarget = string;

type AuthorizedCredential =
  | Readonly<{ kind: 'selection'; selection: z.infer<typeof MembershipSelectionSchema> }>
  | Readonly<{
      kind: 'authenticated';
      session: z.infer<typeof SessionCreatedSchema>;
      exchange: z.infer<typeof TicketExchangeSchema>;
    }>;

async function authorizeCanonicalCredential(
  credential: LoginCredential,
  target: CanonicalAuthTarget,
  membership?: string,
  signal?: AbortSignal,
  context: Readonly<{ application?: string; expectedSessionTarget?: CanonicalTarget }> = {},
): Promise<AuthorizedCredential> {
  const authorization = await beginCanonicalAuthorization();
  const loginIntent = currentLoginIntent();
  const origin = context.expectedSessionTarget === 'storefront' ? storefrontApiOrigin() : apiOrigin();
  const sessionResponse = await identityRequest('/api/v1/identity/sessions', {
    ...credential,
    target,
    ...(membership === undefined ? {} : { membership }),
    ...(context.application === undefined ? {} : { application: context.application }),
    ...(loginIntent === undefined ? {} : { loginIntent }),
    authorization: authorization.request,
  }, signal, { origin });
  void LoginResultSchema.safeParse(sessionResponse);
  const output = sessionResponse as z.infer<typeof LoginResultSchema>;
  if ('memberships' in output) return Object.freeze({ kind: 'selection', selection: output });
  const expectedSessionTarget = context.expectedSessionTarget ?? target;
  if (output.target !== expectedSessionTarget) {
    throw new Error(expectedSessionTarget === 'storefront' ? '登录身份不属于消费者商城' : '登录身份不属于运营后台');
  }
  const exchangeResponse = await identityRequest('/api/v1/identity/tickets/exchange', {
    ticket: output.callback.ticket,
    state: output.callback.state,
    nonce: authorization.secret.nonce,
    verifier: authorization.secret.verifier,
  }, signal, { origin });
  void TicketExchangeSchema.safeParse(exchangeResponse);
  const exchange = exchangeResponse as z.infer<typeof TicketExchangeSchema>;
  return Object.freeze({ kind: 'authenticated', session: output, exchange });
}

function canonicalApplication(value: string): string {
  const application = value.trim();
  if (!/^[a-z0-9][a-z0-9-]{2,47}$/.test(application)) throw new Error('商城登录入口无效');
  return application;
}

function canonicalMobile(value: string): string {
  const mobile = value.trim().replace(/[\s()-]/g, '');
  if (/^1[3-9]\d{9}$/.test(mobile)) return `+86${mobile}`;
  if (/^\+861[3-9]\d{9}$/.test(mobile)) return mobile;
  throw new Error('请输入有效的手机号');
}

function canonicalPasswordSubject(value: string): string {
  const subject = value.trim();
  const compact = subject.replace(/[\s()-]/g, '');
  return /^(?:\+86)?1[3-9]\d{9}$/.test(compact) ? canonicalMobile(compact) : subject;
}

function consoleMembership(value: z.infer<typeof MembershipSelectionSchema>['memberships'][number]): Membership {
  if (value.client !== 'console') throw new Error('后台登录返回了错误的会员入口');
  return {
    id: value.id,
    target: 'admin',
    status: 'active',
    enterpriseName: '已授权企业',
    storeName: '主打团运营后台',
    roleName: '运营会员',
    dataScope: '按权限系统授权范围',
    subjectScope: '企业',
    requiresStepUp: false,
  };
}

async function identityRequest(
  path: string,
  body: Readonly<Record<string, unknown>>,
  signal?: AbortSignal,
  options: Readonly<{ credentials?: RequestCredentials; action?: string; origin?: string }> = {},
): Promise<unknown> {
  const credentials = options.credentials ?? 'include';
  const csrf = credentials === 'include' ? csrfToken() : null;
  const request = () => fetch(new URL(path, options.origin ?? apiOrigin()), {
    method: 'POST',
    credentials,
    headers: {
      'content-type': 'application/json',
      'idempotency-key': createSecureId(),
      'x-client-version': clientVersion(),
      'x-device-id': deviceId(),
      'x-request-id': createSecureId(),
      ...(csrf === null ? {} : { 'x-csrf-token': csrf }),
    },
    body: JSON.stringify(body),
    signal,
  });
  let response = await request();
  let payload = await response.json().catch(() => null);
  if (credentials === 'include' && responseCode(payload, response.status) === 'CSRF_TOKEN_INVALID') {
    response = await request();
    payload = await response.json().catch(() => null);
  }
  if (!response.ok) throw new Error(identityError(payload, response.status, options.action ?? '登录'));
  return payload;
}

function csrfToken(): string | null {
  if (typeof document === 'undefined') return null;
  const item = document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith('shop_csrf='));
  if (!item) return null;
  try {
    return decodeURIComponent(item.slice('shop_csrf='.length));
  } catch {
    return null;
  }
}

export async function beginCanonicalAuthorization(): Promise<CanonicalAuthorization> {
  return beginBrowserAuthorization();
}

function approvedConsoleDestination(value: z.infer<typeof TicketExchangeSchema>['returnTarget'], expectedOrigin?: string): string {
  const expiry = Date.parse(value.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= Date.now()) throw new Error('登录回跳授权已经过期');
  let destination: URL;
  try {
    destination = new URL(value.url);
  } catch {
    throw new Error('登录回跳地址无效');
  }
  const approvedOrigin = adminOriginForIdentityHost(expectedOrigin);
  if (destination.origin !== approvedOrigin || destination.username || destination.password || destination.hash) {
    throw new Error('登录回跳地址不在后台允许清单');
  }
  return destination.toString();
}

function adminOriginForIdentityHost(expectedOrigin?: string): string {
  const node = currentIdentityNode();
  if (node.nodeProfile !== 'operating_mall') throw new Error('消费者节点不提供运营后台');
  const approved = node.adminOrigin;
  if (expectedOrigin !== undefined && exactOrigin(expectedOrigin) !== approved) {
    throw new Error('后台登录目标与当前身份节点不匹配');
  }
  return approved;
}

function approvedStorefrontDestination(value: z.infer<typeof TicketExchangeSchema>['returnTarget']): string {
  const expiry = Date.parse(value.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= Date.now()) throw new Error('登录回跳授权已经过期');
  let destination: URL;
  try {
    destination = new URL(value.url);
  } catch {
    throw new Error('登录回跳地址无效');
  }
  const approvedOrigin = currentIdentityNode().storefrontOrigin;
  if (destination.origin !== approvedOrigin || destination.username || destination.password || destination.hash) {
    throw new Error('登录回跳地址不在商城允许清单');
  }
  return destination.toString();
}

export function canonicalStorefrontAuthTarget(application?: string): string {
  const node = currentIdentityNode();
  if (application !== undefined && application !== node.consumerApplication) throw new Error('商城身份节点无效');
  return node.consumerTarget;
}

function apiOrigin(): string {
  return currentIdentityNode().apiOrigin;
}

function storefrontApiOrigin(): string {
  return currentIdentityNode().consumerApiOrigin;
}

function exactOrigin(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password || parsed.search || parsed.hash
      || (parsed.pathname !== '/' && parsed.pathname !== '')) throw new Error('invalid');
    return parsed.origin;
  } catch {
    throw new Error('后台登录目标配置无效，已停止提交账号凭证');
  }
}

function clientVersion(): string {
  const value = import.meta.env.VITE_CLIENT_VERSION?.trim() || (import.meta.env.DEV ? '0.0.0' : '');
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.]+)?$/i.test(value)) throw new Error('身份中心客户端版本无效');
  return value;
}

function deviceId(): string {
  const existing = window.sessionStorage.getItem(DEVICE_KEY);
  if (existing && /^[A-Za-z0-9_-]{32,128}$/.test(existing)) return existing;
  const value = randomToken(32);
  window.sessionStorage.setItem(DEVICE_KEY, value);
  return value;
}

function randomToken(bytes: number): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return base64url(value);
}

function base64url(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function identityError(value: unknown, status: number, action: string): string {
  const code = responseCode(value, status);
  return {
    CREDENTIAL_INVALID: '账号或密码不正确',
    MEMBERSHIP_INACTIVE: '该账号没有可用的后台会员身份',
    RATE_LIMITED: '登录尝试过多，请稍后再试',
    RISK_REVIEW_REQUIRED: '本次登录需要人工安全复核',
    AUTHENTICATION_REQUIRED: '登录会话未能建立，请重新登录',
    AUTH_TICKET_EXCHANGE_REJECTED: '一次性登录授权无效或已经使用',
    LOGIN_INTENT_INVALID: '跨节点登录凭证无效、已过期或已经使用，请从原节点重新发起',
    LOGIN_INTENT_TARGET_INVALID: '目标节点当前不接受该登录申请，请返回原节点',
    CHALLENGE_INVALID: '验证码错误或已经失效',
    CHALLENGE_PRINCIPAL_MISSING: '该手机号没有可重置的账号',
    PASSWORD_POLICY_REJECTED: PASSWORD_POLICY_MESSAGE,
  }[code] ?? `统一身份服务暂时无法完成${action}，请稍后重试`;
}

function responseCode(value: unknown, status: number): string {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && typeof Reflect.get(value, 'code') === 'string'
    ? String(Reflect.get(value, 'code')) : `HTTP_${status}`;
}
