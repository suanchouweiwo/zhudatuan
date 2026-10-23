import {
  parseHostedMallOpeningRequest,
  parseHostedMallOpeningResult,
  parseSovereignUpgradeRequest,
  parseSovereignUpgradeResult,
  parseMemberNodeRegistrationRequest,
  parseMemberNodeRegistrationResult,
  type HostedMallOpeningRequest,
  type HostedMallOpeningResult,
  type SovereignUpgradeRequest,
  type SovereignUpgradeResult,
  type MemberNodeRegistrationRequest,
  type MemberNodeRegistrationResult,
} from '@shop/config/sfl-node-kernel';
import type { OperationDatabase } from '../../../foundation/application/ModuleOperations';
import {
  changeMemberMobile,
  createMemberProfile,
  ensureImportedMemberProfile,
  readSecurityProfile,
  readCurrentMemberProfile,
} from '../04_adapters_shixian/persistence/MemberProfileRepository';

export interface MemberInvite {
  readonly id: string;
  readonly organization_id: string;
  readonly created_by: string;
  readonly role_id: string;
  readonly target_client: 'storefront' | 'operator';
  readonly terms_hash: string;
  readonly storefront_organization_id: string | null;
  readonly storefront_role_id: string;
  readonly governance_level: 'administrator' | 'senior_administrator' | null;
}

export interface StorefrontRegistrationContext {
  readonly application_id: string;
  readonly application_slug: string;
  readonly organization_id: string;
  readonly organization_name: string;
  readonly role_id: string;
  readonly terms_title: string;
  readonly terms_body: string;
  readonly privacy_title: string;
  readonly privacy_body: string;
  readonly terms_hash: string;
}

export interface MemberProfile {
  readonly member: string;
  readonly principal: string;
  readonly display: string;
  readonly status: 'active' | 'pending';
  readonly mobileCiphertext?: string;
  readonly mobileFingerprint?: string;
  readonly mobileMasked?: string;
}

export interface HostedMallOpeningAuthority {
  readonly principal_id: string;
  readonly membership_id: string;
  readonly realm_id: string;
  readonly node_id: string;
}

export type SovereignUpgradeAuthority = HostedMallOpeningAuthority;

export class MemberPort {
  async storefrontRegistration(database: OperationDatabase, applicationSlug: string): Promise<StorefrontRegistrationContext | undefined> {
    const result = await database.query<StorefrontRegistrationContext>(`select application.id application_id,
      application.public_slug application_slug,binding.mall_id organization_id,organization.name organization_name,
      role.id role_id,policy.terms_title,policy.terms_body,policy.privacy_title,policy.privacy_body,policy.terms_hash
      from experience.application application
      join experience.binding binding on binding.application_id=application.id and binding.domain=application.public_slug
      join organization.organization organization on organization.id=binding.mall_id
        and organization.kind='mall' and organization.status='active'
      join access.role role on role.scope_id=binding.mall_id and role.name='商城会员' and role.status='active'
      cross join lateral(select registration.terms_title,registration.terms_body,registration.privacy_title,
        registration.privacy_body,registration.terms_hash from identity.registrationpolicy registration
        where registration.effective_at<=clock_timestamp()
          and (registration.retired_at is null or registration.retired_at>clock_timestamp())
        order by registration.version desc limit 1) policy
      where application.public_slug=$1 and application.status='active'
        and exists(select 1 from experience.release release where release.application_id=application.id
          and release.state='active' and release.effective_at<=clock_timestamp()
          and (release.retired_at is null or release.retired_at>clock_timestamp()))
      order by application.updated_at desc,application.id limit 1`, [applicationSlug]);
    return result.rows[0];
  }

  async currentProfile(database: OperationDatabase, membership: string) {
    return (await readCurrentMemberProfile(database, membership)).rows[0];
  }

  async securityProfile(database: OperationDatabase, principal: string): Promise<Readonly<{ displayName: string | null; mobileCiphertext: string | null }>> {
    return readSecurityProfile(database, principal);
  }

  async sessionSecurityProjection(database: OperationDatabase, account: string, realm: string, principal: string): Promise<Readonly<{
    displayName: string | null;
    hasLocalCredential: boolean;
    phoneMasked: string | null;
    passwordChangedAt: Date | null;
  }> | null> {
    const result = await database.query<{ display_name: string | null; has_local_credential: boolean;
      mobile_masked: string | null; rotated_at: Date | null }>(`select profile.display_name,
      credential.id is not null has_local_credential,account.mobile_masked,credential.rotated_at
      from identity.account account
      left join lateral(select profile.display_name from member.profile profile
        where profile.principal_id=$3 and profile.status='active' limit 1) profile on true
      left join lateral(select credential.id,credential.rotated_at from identity.credential credential
        where credential.account_id=account.id and credential.realm_id=account.realm_id
          and credential.provider='password' and credential.status='active'
        order by credential.created_at desc limit 1) credential on true
      where account.id=$1 and account.realm_id=$2 and account.legacy_principal_id=$3 and account.status='active'`,
    [account, realm, principal]);
    const found = result.rows[0];
    return found === undefined ? null : Object.freeze({ displayName: found.display_name,
      hasLocalCredential: found.has_local_credential, phoneMasked: found.mobile_masked,
      passwordChangedAt: found.rotated_at });
  }

  invite(database: OperationDatabase, token: string) {
    return database.query(
      `select policy.terms_title,policy.terms_body,policy.privacy_title,policy.privacy_body,invite.terms_hash,
        invite.organization_id,organization.name organization_name,
        invite.target_client,invite.effective_at,invite.expires_at,
        case when invite.target_client='operator' and invite.role_id='role-senior-administrator-v1:'||invite.organization_id
          then 'senior_administrator' when invite.target_client='operator' then 'administrator' end governance_level
      from member.invite invite join identity.registrationpolicy policy on policy.id=invite.registration_policy_id
      join organization.organization organization on organization.id=invite.organization_id
      where invite.token_hash=$1 and invite.status='active' and invite.effective_at<=clock_timestamp()
        and invite.expires_at>clock_timestamp() and invite.use_count<invite.max_uses
        and ${registrationInviteBoundary()}
        and policy.effective_at<=clock_timestamp() and (policy.retired_at is null or policy.retired_at>clock_timestamp())
        and policy.terms_hash=invite.terms_hash`,
      [token]
    );
  }

  async assertRegistrationInvite(database: OperationDatabase, token: string, destinationHash: string): Promise<void> {
    const result = await database.query<{ id: string }>(`select invite.id from member.invite invite
      join identity.registrationpolicy policy on policy.id=invite.registration_policy_id
      join organization.organization organization on organization.id=invite.organization_id
      where invite.token_hash=$1 and invite.status='active' and invite.effective_at<=clock_timestamp()
        and invite.expires_at>clock_timestamp() and invite.use_count<invite.max_uses
        and (invite.allowed_destination_hash is null or invite.allowed_destination_hash=$2)
        and ${registrationInviteBoundary()}
        and policy.effective_at<=clock_timestamp() and (policy.retired_at is null or policy.retired_at>clock_timestamp())
        and policy.terms_hash=invite.terms_hash`, [token, destinationHash]);
    if (!result.rows[0]) throw new Error('INVITE_INVALID');
  }

  async registrationInvite(database: OperationDatabase, token: string, destinationHash: string): Promise<MemberInvite> {
    const result = await database.query<MemberInvite>(`select invite.id,invite.organization_id,invite.created_by,invite.role_id,
      invite.terms_hash,invite.target_client,invite.storefront_organization_id,
      case when invite.target_client='operator' then (select role.id from access.role role
        where role.scope_id=invite.storefront_organization_id and role.name='商城会员' and role.status='active'
        order by role.id limit 1) else invite.role_id end storefront_role_id,
      case when invite.target_client='operator' and invite.role_id='role-senior-administrator-v1:'||invite.organization_id
        then 'senior_administrator' when invite.target_client='operator' then 'administrator' end governance_level
      from member.invite invite
      join identity.registrationpolicy policy on policy.id=invite.registration_policy_id
      join organization.organization organization on organization.id=invite.organization_id
      where invite.token_hash=$1 and invite.status='active' and invite.effective_at<=clock_timestamp()
        and invite.expires_at>clock_timestamp() and invite.use_count<invite.max_uses
        and (invite.allowed_destination_hash is null or invite.allowed_destination_hash=$2)
        and ${registrationInviteBoundary()}
        and policy.effective_at<=clock_timestamp() and (policy.retired_at is null or policy.retired_at>clock_timestamp())
        and policy.terms_hash=invite.terms_hash`, [token, destinationHash]);
    const invitation = result.rows[0];
    if (!invitation) throw new Error('INVITE_INVALID');
    return invitation;
  }

  async registerHostedMemberNode(database: OperationDatabase,
    input: MemberNodeRegistrationRequest): Promise<MemberNodeRegistrationResult> {
    const request = parseMemberNodeRegistrationRequest(input);
    const result = await database.query<Record<string, unknown>>(
      'select * from organization.register_hosted_member_node($1::jsonb)',
      [JSON.stringify(request)],
    );
    const row = result.rows[0];
    if (!row) throw new Error('SFL_MEMBER_REGISTRATION_FAILED');
    return parseMemberNodeRegistrationResult(row);
  }

  async openHostedMall(
    database: OperationDatabase,
    authority: HostedMallOpeningAuthority,
    input: HostedMallOpeningRequest,
  ): Promise<HostedMallOpeningResult> {
    const request = parseHostedMallOpeningRequest(input);
    const result = await database.query<Record<string, unknown>>(
      'select * from organization.open_hosted_member_mall($1,$2,$3::jsonb)',
      [authority.membership_id, authority.node_id, JSON.stringify(request)],
    );
    const row = result.rows[0];
    if (!row) throw new Error('SFL_HOSTED_MALL_OPENING_FAILED');
    const opened = parseHostedMallOpeningResult(row);
    if (opened.principal_id !== authority.principal_id
      || opened.membership_id !== authority.membership_id
      || opened.realm_id !== authority.realm_id
      || opened.node_id !== authority.node_id) {
      throw new Error('SFL_HOSTED_MALL_OPENING_CONTEXT_MISMATCH');
    }
    return opened;
  }

  async upgradeHostedMallToSovereign(
    database: OperationDatabase,
    authority: SovereignUpgradeAuthority,
    input: SovereignUpgradeRequest,
  ): Promise<SovereignUpgradeResult> {
    const request = parseSovereignUpgradeRequest(input);
    const result = await database.query<Record<string, unknown>>(
      'select * from organization.upgrade_hosted_mall_to_sovereign($1,$2,$3::jsonb)',
      [authority.membership_id, authority.node_id, JSON.stringify(request)],
    );
    const row = result.rows[0];
    if (!row) throw new Error('SFL_SOVEREIGN_UPGRADE_FAILED');
    const upgraded = parseSovereignUpgradeResult(row);
    if (upgraded.principal_id !== authority.principal_id
      || upgraded.membership_id !== authority.membership_id
      || upgraded.realm_id !== authority.realm_id
      || upgraded.node_id !== authority.node_id) {
      throw new Error('SFL_SOVEREIGN_UPGRADE_CONTEXT_MISMATCH');
    }
    return upgraded;
  }

  async consumeInvite(database: OperationDatabase, token: string, destinationHash: string,
    acceptedOperatorMembershipId: string): Promise<MemberInvite> {
    const result = await database.query<MemberInvite>(`with candidate as materialized(
      select invite.id,invite.organization_id,invite.created_by,invite.role_id,invite.terms_hash,invite.target_client,invite.storefront_organization_id,
        case when invite.target_client='operator' then (select role.id from access.role role
          where role.scope_id=invite.storefront_organization_id and role.name='商城会员' and role.status='active'
          order by role.id limit 1) else invite.role_id end storefront_role_id,
        case when invite.target_client='operator' and invite.role_id='role-senior-administrator-v1:'||invite.organization_id
          then 'senior_administrator' when invite.target_client='operator' then 'administrator' end governance_level
      from member.invite invite
      join identity.registrationpolicy policy on policy.id=invite.registration_policy_id
      join organization.organization organization on organization.id=invite.organization_id
      where invite.token_hash=$1 and invite.status='active' and invite.effective_at<=clock_timestamp()
        and invite.expires_at>clock_timestamp() and invite.use_count<invite.max_uses
        and (invite.allowed_destination_hash is null or invite.allowed_destination_hash=$2)
        and ${registrationInviteBoundary()}
        and policy.effective_at<=clock_timestamp() and (policy.retired_at is null or policy.retired_at>clock_timestamp())
        and policy.terms_hash=invite.terms_hash for update of invite
    ), consumed as(update member.invite invite set use_count=invite.use_count+1,
      accepted_at=case when invite.use_count+1=invite.max_uses then clock_timestamp() else invite.accepted_at end,
      accepted_membership_id=case when candidate.target_client='operator' then $3 else invite.accepted_membership_id end,
      version=invite.version+1
      from candidate where invite.id=candidate.id
      returning candidate.id,candidate.organization_id,candidate.created_by,candidate.role_id,candidate.terms_hash,candidate.target_client,
        candidate.storefront_organization_id,candidate.storefront_role_id,candidate.governance_level)
      select id,organization_id,created_by,role_id,terms_hash,target_client,storefront_organization_id,storefront_role_id,governance_level
      from consumed where storefront_role_id is not null`,
    [token, destinationHash, acceptedOperatorMembershipId]);
    const invitation = result.rows[0];
    if (!invitation) throw new Error('INVITE_INVALID');
    return invitation;
  }

  async create(database: OperationDatabase, input: MemberProfile): Promise<void> {
    await createMemberProfile(database, input);
  }

  async ensureImported(database: OperationDatabase, input: MemberProfile): Promise<void> {
    await ensureImportedMemberProfile(database, input);
  }

  async changeMobile(database: OperationDatabase, principal: string, ciphertext: string, fingerprint: string, masked: string): Promise<Readonly<Record<string, unknown>>> {
    return changeMemberMobile(database, principal, ciphertext, fingerprint, masked);
  }
}

export const memberPort = new MemberPort();

function registrationInviteBoundary(): string {
  return `(access.registration_invite_role_allowed(invite.role_id,invite.organization_id,invite.target_client)
    and organization.status='active' and (
    (invite.target_client='storefront' and invite.storefront_organization_id is null and organization.kind='mall')
    or (invite.target_client='operator'
      and invite.storefront_organization_id is not null and organization.kind='tenant'
      and exists(select 1 from organization.organization storefront
        join organization.unitclosure closure on closure.descendant_id=storefront.id
        where storefront.id=invite.storefront_organization_id and storefront.kind='mall' and storefront.status='active'
          and closure.ancestor_id=organization.id))
  ))`;
}
