import qrcode from 'qrcode-generator';
import { MEMBER_CODE_PROTOCOL, MEMBER_CODE_VALID_SECONDS, PERMISSIONS } from '@smart-wing/api-contract';
import { authorize } from './auth';
import { sha256 } from './crypto';
import { apiError, json, methodNotAllowed } from './http';
import { authorizationScope, invalidBody, readJsonBody } from './routerSupport';
import { callRpc } from './postgresRpc';
import type { AuthorizationContext, WorkerEnv } from './types';

interface IssueResult {
  issued: boolean;
  code?: string;
  challengeId?: string;
  issuedAt?: string;
  expiresAt?: string;
  validSeconds?: number;
}

interface VerifyResult {
  verified: boolean;
  code?: string;
  challengeId?: string;
  memberId?: string;
  membershipId?: string;
  consumedAt?: string;
}

export async function handleMemberCodeChallenge(request: Request, env: WorkerEnv, authorization: AuthorizationContext, requestId: string): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed(['POST'], requestId);
  const credential = randomCredential();
  const payload = `${MEMBER_CODE_PROTOCOL}${credential}`;
  const response = await callRpc<IssueResult>(env, 'api_issue_member_code_challenge', {
    ...authorizationScope(authorization, true),
    p_membership_id: authorization.membership.id,
    p_authz_version: authorization.membership.authzVersion,
    p_credential_hash: await sha256(credential),
  });
  if (!response.issued || !response.challengeId || !response.issuedAt || !response.expiresAt) {
    return issueFailure(response.code, requestId);
  }
  return json(
    {
      challengeId: response.challengeId,
      payload,
      matrix: createQrMatrix(payload),
      issuedAt: response.issuedAt,
      expiresAt: response.expiresAt,
      validSeconds: MEMBER_CODE_VALID_SECONDS,
      requestId,
    },
    { status: 201 }
  );
}

export async function handleRevokeMemberCodeChallenge(request: Request, env: WorkerEnv, authorization: AuthorizationContext, requestId: string): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed(['POST'], requestId);
  const body = await readJsonBody(request);
  if (!body.ok) return invalidBody(body.tooLarge, requestId);
  const challengeId = readUuid(body.value, 'challengeId');
  if (!challengeId) return apiError(422, 'INVALID_CHALLENGE_ID', '会员码凭证无效', requestId);
  const revoked = await callRpc<boolean>(env, 'api_revoke_member_code_challenge', {
    p_membership_id: authorization.membership.id,
    p_user_id: authorization.userId,
    p_challenge_id: challengeId,
  });
  return json({ revoked, requestId });
}

export async function handleVerifyMemberCodeChallenge(request: Request, env: WorkerEnv, authorization: AuthorizationContext, requestId: string): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed(['POST'], requestId);
  if (!authorize(authorization, PERMISSIONS.memberCodeVerify).allowed) {
    return apiError(403, 'FORBIDDEN', '没有核验会员码的权限', requestId);
  }
  const body = await readJsonBody(request);
  if (!body.ok) return invalidBody(body.tooLarge, requestId);
  const credential = readCredential(body.value);
  if (!credential) return apiError(422, 'INVALID_MEMBER_CODE', '会员码内容无效', requestId);
  const response = await callRpc<VerifyResult>(env, 'api_verify_member_code_challenge', {
    p_actor_membership_id: authorization.membership.id,
    p_actor_user_id: authorization.userId,
    p_credential_hash: await sha256(credential),
  });
  return json({ ...response, requestId });
}

function randomCredential(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function createQrMatrix(payload: string): boolean[][] {
  const code = qrcode(0, 'M');
  code.addData(payload, 'Byte');
  code.make();
  return Array.from({ length: code.getModuleCount() }, (_, row) => Array.from({ length: code.getModuleCount() }, (_, column) => code.isDark(row, column)));
}

function readCredential(value: unknown): string | null {
  if (!isRecord(value) || typeof value.payload !== 'string' || !value.payload.startsWith(MEMBER_CODE_PROTOCOL)) return null;
  const credential = value.payload.slice(MEMBER_CODE_PROTOCOL.length);
  return /^[0-9a-f]{64}$/.test(credential) ? credential : null;
}

function readUuid(value: unknown, key: string): string | null {
  if (!isRecord(value) || typeof value[key] !== 'string') return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value[key] as string) ? (value[key] as string) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function issueFailure(code: string | undefined, requestId: string): Response {
  if (code === 'PHONE_VERIFICATION_REQUIRED') return apiError(403, code, '完成手机认证后才能使用会员码', requestId);
  if (code === 'RATE_LIMITED') return apiError(429, code, '刷新过于频繁，请稍后再试', requestId);
  if (code === 'MEMBERSHIP_INACTIVE' || code === 'MEMBER_INACTIVE') return apiError(403, code, '当前会员身份不可用', requestId);
  return apiError(503, code ?? 'MEMBER_CODE_UNAVAILABLE', '会员码暂时不可用', requestId);
}
