import type { WorkerEnv } from './types';
import { sha256 } from './crypto';
import { readTrustedClientIp } from './loginRateLimitBypass';
import { callRpc } from './postgresRpc';

export type SessionTarget = 'storefront' | 'admin';

const SESSION_SECONDS = 8 * 60 * 60;
const COOKIE_NAMES: Record<SessionTarget, string> = {
  storefront: '__Host-zhudatuan_store_session',
  admin: '__Host-zhudatuan_admin_session',
};

export interface SessionPayload {
  sessionId: string;
  employeeNo: string;
  mallCode: string;
  target: SessionTarget;
  membershipId: string;
  memberId: string;
  authzVersion: number;
  stepUpAt?: number;
  channel?: 'miniapp';
  expiresAt: number;
}

export interface SessionOptions {
  target?: SessionTarget;
  membershipId: string;
  memberId: string;
  authzVersion: number;
  stepUpAt?: number;
  sessionId?: string;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function targetForRequest(request: Request): SessionTarget {
  return new URL(request.url).hostname === 'console.zhudatuan.com' ? 'admin' : 'storefront';
}

function signingSecret(env: WorkerEnv, target: SessionTarget): string | undefined {
  return target === 'admin' ? env.ADMIN_SESSION_SIGNING_KEY : env.SESSION_SIGNING_KEY;
}

function miniappSigningSecret(env: WorkerEnv): string | undefined {
  return env.MINIAPP_SESSION_SIGNING_KEY;
}

async function signingKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

function cookieAttributes(maxAge: number): string {
  // __Host- cookies deliberately omit Domain and force host-only Path=/ scope.
  return `Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

export async function createSessionCookie(env: WorkerEnv, employeeNo: string, mallCode: string, options: SessionOptions): Promise<string> {
  const target = options.target ?? 'storefront';
  const secret = signingSecret(env, target);
  if (!secret || secret.length < 32) throw new Error('SESSION_SIGNING_KEY_NOT_CONFIGURED');

  const payload: SessionPayload = {
    sessionId: options.sessionId ?? crypto.randomUUID(),
    employeeNo,
    mallCode,
    target,
    membershipId: options.membershipId,
    memberId: options.memberId,
    authzVersion: options.authzVersion,
    ...(options.stepUpAt ? { stepUpAt: options.stepUpAt } : {}),
    expiresAt: Math.floor(Date.now() / 1000) + SESSION_SECONDS,
  };
  const encodedPayload = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign('HMAC', await signingKey(secret), new TextEncoder().encode(encodedPayload));
  return `${COOKIE_NAMES[target]}=${encodedPayload}.${toBase64Url(new Uint8Array(signature))}; ${cookieAttributes(SESSION_SECONDS)}`;
}

export async function createTrackedSessionCookie(request: Request, env: WorkerEnv, employeeNo: string, mallCode: string, options: SessionOptions): Promise<string> {
  const sessionId = crypto.randomUUID();
  const target = options.target ?? 'storefront';
  const userAgent = (request.headers.get('user-agent') ?? '').slice(0, 300);
  const clientIp = readTrustedClientIp(request);
  // Sign first so a signing-key error cannot leave an unreachable active row.
  const cookie = await createSessionCookie(env, employeeNo, mallCode, { ...options, target, sessionId });
  const created = await callRpc<boolean>(env, 'api_create_auth_session', {
    p_session_id: sessionId,
    p_member_id: options.memberId,
    p_membership_id: options.membershipId,
    p_target: target,
    p_ip_hash: await sha256(`${clientIp ?? 'unknown'}:${env.SESSION_SIGNING_KEY ?? ''}`),
    p_user_agent: userAgent,
    p_device_label: deviceLabel(userAgent),
    p_expires_at: new Date(Date.now() + SESSION_SECONDS * 1_000).toISOString(),
  });
  if (!created) throw new Error('AUTH_SESSION_CREATE_FAILED');
  return cookie;
}

export async function createTrackedMiniappSessionToken(request: Request, env: WorkerEnv, employeeNo: string, mallCode: string, options: Omit<SessionOptions, 'target'>): Promise<{ accessToken: string; expiresIn: number }> {
  const secret = miniappSigningSecret(env);
  if (!secret || secret.length < 32) throw new Error('MINIAPP_SESSION_SIGNING_KEY_NOT_CONFIGURED');
  const sessionId = crypto.randomUUID();
  const payload: SessionPayload = {
    sessionId,
    employeeNo,
    mallCode,
    target: 'storefront',
    membershipId: options.membershipId,
    memberId: options.memberId,
    authzVersion: options.authzVersion,
    ...(options.stepUpAt ? { stepUpAt: options.stepUpAt } : {}),
    channel: 'miniapp',
    expiresAt: Math.floor(Date.now() / 1000) + SESSION_SECONDS,
  };
  const encodedPayload = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign('HMAC', await signingKey(secret), new TextEncoder().encode(encodedPayload));
  const accessToken = `swm1.${encodedPayload}.${toBase64Url(new Uint8Array(signature))}`;
  const userAgent = (request.headers.get('user-agent') ?? 'WeChat Mini Program').slice(0, 300);
  const clientIp = readTrustedClientIp(request);
  const created = await callRpc<boolean>(env, 'api_create_auth_session', {
    p_session_id: sessionId,
    p_member_id: options.memberId,
    p_membership_id: options.membershipId,
    p_target: 'storefront',
    p_ip_hash: await sha256(`${clientIp ?? 'unknown'}:${secret}`),
    p_user_agent: userAgent,
    p_device_label: '微信小程序',
    p_expires_at: new Date(Date.now() + SESSION_SECONDS * 1_000).toISOString(),
  });
  if (!created) throw new Error('AUTH_SESSION_CREATE_FAILED');
  return { accessToken, expiresIn: SESSION_SECONDS };
}

function deviceLabel(userAgent: string): string {
  const browser = /Edg\//.test(userAgent) ? 'Edge' : /Chrome\//.test(userAgent) ? 'Chrome' : /Firefox\//.test(userAgent) ? 'Firefox' : /Safari\//.test(userAgent) ? 'Safari' : '未知浏览器';
  const system = /Windows/.test(userAgent) ? 'Windows' : /Android/.test(userAgent) ? 'Android' : /iPhone|iPad/.test(userAgent) ? 'iOS' : /Mac OS/.test(userAgent) ? 'macOS' : /Linux/.test(userAgent) ? 'Linux' : '未知设备';
  return `${browser} · ${system}`;
}

export function clearSessionCookie(request: Request): string {
  return `${COOKIE_NAMES[targetForRequest(request)]}=; ${cookieAttributes(0)}`;
}

export async function readSession(request: Request, env: WorkerEnv): Promise<SessionPayload | null> {
  const target = targetForRequest(request);
  const authorization = request.headers.get('authorization');
  if (authorization) {
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    return match ? readMiniappSessionToken(match[1], env, target) : null;
  }
  const secret = signingSecret(env, target);
  if (!secret) return null;
  const cookieName = COOKIE_NAMES[target];
  const cookie = request.headers
    .get('cookie')
    ?.split(';')
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${cookieName}=`));
  if (!cookie) return null;

  const [encodedPayload, encodedSignature] = cookie.slice(cookieName.length + 1).split('.');
  if (!encodedPayload || !encodedSignature) return null;
  try {
    const valid = await crypto.subtle.verify('HMAC', await signingKey(secret), Uint8Array.from(fromBase64Url(encodedSignature)).buffer, new TextEncoder().encode(encodedPayload));
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(encodedPayload))) as SessionPayload;
    if (
      typeof payload.sessionId !== 'string' ||
      typeof payload.employeeNo !== 'string' ||
      typeof payload.mallCode !== 'string' ||
      typeof payload.memberId !== 'string' ||
      typeof payload.membershipId !== 'string' ||
      !Number.isInteger(payload.authzVersion) ||
      payload.authzVersion < 1 ||
      payload.target !== target ||
      typeof payload.expiresAt !== 'number' ||
      payload.expiresAt <= Math.floor(Date.now() / 1000)
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

async function readMiniappSessionToken(token: string, env: WorkerEnv, target: SessionTarget): Promise<SessionPayload | null> {
  const secret = miniappSigningSecret(env);
  if (!secret || target !== 'storefront') return null;
  const [version, encodedPayload, encodedSignature, extra] = token.split('.');
  if (version !== 'swm1' || !encodedPayload || !encodedSignature || extra) return null;
  try {
    const valid = await crypto.subtle.verify('HMAC', await signingKey(secret), Uint8Array.from(fromBase64Url(encodedSignature)).buffer, new TextEncoder().encode(encodedPayload));
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(encodedPayload))) as SessionPayload;
    if (
      payload.channel !== 'miniapp' ||
      payload.target !== 'storefront' ||
      typeof payload.sessionId !== 'string' ||
      typeof payload.employeeNo !== 'string' ||
      typeof payload.mallCode !== 'string' ||
      typeof payload.memberId !== 'string' ||
      typeof payload.membershipId !== 'string' ||
      !Number.isInteger(payload.authzVersion) ||
      payload.authzVersion < 1 ||
      typeof payload.expiresAt !== 'number' ||
      payload.expiresAt <= Math.floor(Date.now() / 1000)
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}
