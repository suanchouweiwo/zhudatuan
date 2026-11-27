import { createHash, createHmac } from 'node:crypto';
import type { ModuleContext } from '../../../../bootstrap/ModuleRegistry';
import { NODE_MANIFEST } from '../../../../bootstrap/NodeRuntime';
import { AUDIT_SINK } from '../../../../foundation/application/AuditSink';
import { reject } from '../../../../foundation/application/ModuleOperations';
import { KMS_CLIENT } from '../../../../foundation/infrastructure/KmsClient';
import { IDENTITY_SECURITY_KEYS } from '../../../../foundation/infrastructure/SecretStore';
import { DATABASE_POOL } from '../../../../foundation/persistence/Pool';
import { textField } from '../../../../foundation/interface/Validation';
import { PasswordPolicy } from '../../02_domain_yewu/policies_guize/PasswordPolicy';
import { StepupPolicy } from '../../../../foundation/security/StepupPolicy';
import { PgAuthTicket } from '../../04_adapters_shixian/persistence_cunchu/PgAuthTicket';
import { ReturnTargetSigner } from '../../04_adapters_shixian/providers_waibu/ReturnTargetSigner';

export function createRealmOperationContext(context: ModuleContext, registrationOnly: boolean) {
  const keys = context.container.get(IDENTITY_SECURITY_KEYS);
  const manifest = context.container.has(NODE_MANIFEST) ? context.container.get(NODE_MANIFEST) : undefined;
  return Object.freeze({
    pool: context.container.get(DATABASE_POOL),
    audit: context.container.get(AUDIT_SINK),
    keys,
    kms: context.container.get(KMS_CLIENT),
    passwords: new PasswordPolicy(),
    stepup: new StepupPolicy(),
    tickets: new PgAuthTicket(new ReturnTargetSigner(keys.session)),
    registrationOnly,
    notificationScope: manifest?.node_id,
    digest: (value: string) => createHmac('sha256', keys.identity).update(value.trim().toLowerCase()).digest('hex'),
    codeDigest: (challenge: string, code: string) => createHmac('sha256', keys.session).update(`${challenge}:${code}`).digest('hex'),
    sessionDigest: (session: string) => createHash('sha256').update(session).digest('hex'),
  });
}

export type RealmOperationContext = ReturnType<typeof createRealmOperationContext>;

export async function requireValidInvite<T>(operation: Promise<T>): Promise<T> {
  try {
    return await operation;
  } catch (cause) {
    if (cause instanceof Error && cause.message === 'INVITE_INVALID') reject(400, 'INVITE_INVALID');
    throw cause;
  }
}

export type RegistrationReference = Readonly<{ kind: 'invite' | 'storefront'; value: string }>;

export function registrationReference(body: Readonly<Record<string, unknown>>): RegistrationReference {
  const hasInvite = typeof body.invite === 'string' && body.invite.trim().length > 0;
  const hasStorefront = typeof body.application === 'string' && body.application.trim().length > 0;
  if (hasInvite === hasStorefront) throw new Error('REGISTRATION_CONTEXT_INVALID');
  if (hasInvite) return Object.freeze({ kind: 'invite', value: textField(body, 'invite') });
  return Object.freeze({ kind: 'storefront', value: storefrontSlug(body) });
}

export function storefrontSlug(body: Readonly<Record<string, unknown>>): string {
  const value = textField(body, 'application', 48).trim();
  if (!/^[a-z0-9][a-z0-9-]{2,47}$/.test(value) && !/^h[0-9]+$/.test(value)) throw new Error('STOREFRONT_NOT_FOUND');
  return value;
}

export async function requireValidStorefront<T>(operation: Promise<T | undefined>): Promise<T> {
  const storefront = await operation;
  if (storefront === undefined) reject(404, 'STOREFRONT_NOT_FOUND');
  return storefront;
}

export function maskMobile(value: string): string {
  return `${value.slice(0, 3)}****${value.slice(-4)}`;
}

export function maskInvitationMobile(value: string): string {
  return maskMobile(/^\+86(1[3-9][0-9]{9})$/.exec(value)?.[1] ?? value);
}
