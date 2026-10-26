import { verifyPassword } from './registrationSecurity';
import { callRpc } from './postgresRpc';
import type { WorkerEnv } from './types';

type Credential = { passwordHash?: string; credentialVersion?: number };

export async function verifyMemberPassword(env: WorkerEnv, memberId: string, supplied: string): Promise<boolean> {
  return (await verifyMemberPasswordState(env, memberId, supplied)).valid;
}

export async function verifyMemberPasswordState(env: WorkerEnv, memberId: string, supplied: string): Promise<{ configured: boolean; valid: boolean }> {
  const credential = await callRpc<Credential | null>(env, 'api_member_credential', { p_member_id: memberId });
  if (!credential?.passwordHash) return { configured: false, valid: false };
  return { configured: true, valid: await verifyPassword(supplied, credential.passwordHash) };
}
