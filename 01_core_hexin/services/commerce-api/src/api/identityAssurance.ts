import { apiError } from './http';
import { callRpc } from './postgresRpc';
import type { AuthorizationContext, WorkerEnv } from './types';

export interface MemberAssurance {
  level: 'account' | 'phone';
  accountAuthenticated: boolean;
  accountAuthenticatedAt: string;
  phoneVerified: boolean;
  phoneVerifiedAt: string | null;
  phoneVerificationMethod: string | null;
  paymentEligible: boolean;
  restrictedCapabilities: string[];
}

export async function loadMemberAssurance(env: WorkerEnv, memberId: string): Promise<MemberAssurance | null> {
  return callRpc<MemberAssurance | null>(env, 'api_member_assurance', {
    p_member_id: memberId,
  });
}

export async function requirePhoneVerified(env: WorkerEnv, authorization: AuthorizationContext, requestId: string): Promise<Response | null> {
  const assurance = await loadMemberAssurance(env, authorization.membership.memberId);
  if (assurance?.phoneVerified && assurance.paymentEligible) return null;
  return apiError(403, 'PHONE_VERIFICATION_REQUIRED', '当前账号已认证，但手机尚未验证；完成短信验证后才能提交订单和付款', requestId);
}
