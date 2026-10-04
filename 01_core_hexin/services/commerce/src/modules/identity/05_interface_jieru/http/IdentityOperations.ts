import type { OperationId } from '@shop/contract';
import type { ModuleContext } from '../../../../bootstrap/ModuleRegistry';
import { ModuleOperations, type OperationActions } from '../../../../foundation/application/ModuleOperations';
import type { OperationUsecase } from '../../../../foundation/application/OperationHandler';
import { createRealmOperationContext } from './RealmOperationContext';
import { credentialOperations } from './CredentialOperations';
import { membershipInvitationOperations } from './MembershipInvitationOperations';
import { mobileWechatOperations } from './MobileWechatOperations';
import { registrationOperations } from './RegistrationOperations';
import { sessionTicketOperations } from './SessionTicketOperations';

export const IDENTITY_CORE_OPERATION_IDS = Object.freeze([
  'identity.sessions.create',
  'identity.loginintents.create',
  'identity.tickets.exchange',
  'identity.session.read',
  'identity.session.delete',
  'identity.sessions.read',
  'identity.sessions.revoke',
  'identity.challenges.create',
  'identity.invitations.read',
  'identity.storefronts.read',
  'identity.invitations.create',
  'identity.invitations.revoke',
  'identity.members.create',
  'identity.members.manage',
  'identity.members.reset',
  'identity.password.change',
  'identity.password.verify',
  'identity.password.reset',
  'identity.mobile.challenge',
  'identity.mobile.manage',
  'identity.stepup.start',
  'identity.stepup.complete',
] as const satisfies readonly OperationId[]);

export const IDENTITY_REGISTRATION_CORE_OPERATION_IDS = Object.freeze([
  'identity.sessions.create',
  'identity.loginintents.create',
  'identity.tickets.exchange',
  'identity.session.read',
  'identity.session.delete',
  'identity.challenges.create',
  'identity.invitations.read',
  'identity.storefronts.read',
  'identity.invitations.create',
  'identity.invitations.revoke',
  'identity.members.create',
  'identity.password.reset',
  'identity.password.change',
  'identity.password.verify',
  'identity.mobile.challenge',
  'identity.mobile.manage',
  'identity.stepup.start',
  'identity.stepup.complete',
] as const satisfies readonly OperationId[]);

export const IDENTITY_REGISTRATION_OPERATION_IDS = Object.freeze([
  ...IDENTITY_REGISTRATION_CORE_OPERATION_IDS,
  'identity.wechat.session',
  'identity.wechat.bind',
] as const satisfies readonly OperationId[]);

export function identityRegistrationOperations(context: ModuleContext): OperationUsecase {
  return identityCoreOperations(context, IDENTITY_REGISTRATION_CORE_OPERATION_IDS, true);
}

export function identityOperations(context: ModuleContext): OperationUsecase {
  return identityCoreOperations(context, IDENTITY_CORE_OPERATION_IDS, false);
}

function identityCoreOperations(context: ModuleContext, ownedOperations: readonly OperationId[], registrationOnly: boolean): OperationUsecase {
  const runtime = createRealmOperationContext(context, registrationOnly);
  const actions: OperationActions = {
    ...sessionTicketOperations(runtime),
    ...registrationOperations(runtime),
    ...membershipInvitationOperations(runtime),
    ...credentialOperations(runtime),
    ...mobileWechatOperations(runtime),
  };
  const selected = Object.fromEntries(ownedOperations.map((operationId) => {
    const action = actions[operationId];
    if (!action) throw new Error(`IDENTITY_OPERATION_NOT_AVAILABLE:${operationId}`);
    return [operationId, action];
  })) as OperationActions;
  return new ModuleOperations('identity', runtime.pool, runtime.audit, selected, ownedOperations);
}
