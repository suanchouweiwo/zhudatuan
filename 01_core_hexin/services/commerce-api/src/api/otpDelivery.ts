import { sendVerificationSms, SmsDeliveryError, smsProviderAvailable, type VerificationPurpose } from './smsProvider';
import { callRpc } from './postgresRpc';
import type { WorkerEnv } from './types';

export const OTP_RESEND_AFTER_SECONDS = 30 as const;

export interface OtpDelivery {
  debugCode?: string;
  provider: 'debug' | 'aliyun';
}

export function otpDeliveryAvailable(env: WorkerEnv): boolean {
  return smsProviderAvailable(env);
}

export async function deliverOtp(env: WorkerEnv, input: { mobile: string; code: string; challengeId: string; purpose: VerificationPurpose }): Promise<OtpDelivery> {
  try {
    const result = await sendVerificationSms(env, input);
    await recordDelivery(env, input.challengeId, true, result.providerMessageId ?? null, null);
    return { provider: result.provider, ...(result.debugCode ? { debugCode: result.debugCode } : {}) };
  } catch (error) {
    const code = error instanceof SmsDeliveryError ? error.code : 'SMS_DELIVERY_FAILED';
    await recordDelivery(env, input.challengeId, false, null, code).catch(() => undefined);
    throw error;
  }
}

async function recordDelivery(env: WorkerEnv, challengeId: string, succeeded: boolean, providerMessageId: string | null, errorCode: string | null) {
  return callRpc<boolean>(env, 'api_record_phone_challenge_delivery', {
    p_challenge_id: challengeId,
    p_succeeded: succeeded,
    p_provider_message_id: providerMessageId,
    p_error_code: errorCode,
  });
}
