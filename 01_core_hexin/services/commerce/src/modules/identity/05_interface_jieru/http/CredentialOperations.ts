import { randomUUID } from 'node:crypto';
import type { OperationId } from '@shop/contract';
import { operationLifecycle, reject, requireAccess, rowResult, type OperationActions } from '../../../../foundation/application/ModuleOperations';
import { bodyRecord, secretField, textField } from '../../../../foundation/interface/Validation';
import { requireGovernanceContext } from '../../../../foundation/security/AccessContext';
import { atomicIdentityMutation, publishIdentityEvent } from '../../04_adapters_shixian/persistence_cunchu/IdentityPersistence';
import { consumeChallenge, sessionCookies } from './IdentitySecurity';
import { currentRealmAccount, resolveRealmNode } from '../../03_application_yingyong/services_fuwu/RealmAccount';
import type { RealmOperationContext } from './RealmOperationContext';

export const CREDENTIAL_OPERATION_IDS = Object.freeze([
  'identity.members.reset',
  'identity.password.change',
  'identity.password.verify',
  'identity.password.reset',
] as const satisfies readonly OperationId[]);

export function credentialOperations(runtime: RealmOperationContext): OperationActions {
  const { codeDigest, digest, passwords, sessionDigest } = runtime;
  return {
      'identity.members.reset': async (request, database) => {
        const access = requireAccess(request);
        const governance = requireGovernanceContext(access);
        const reason = textField(bodyRecord(request), 'reason', 500).trim();
        if (reason.length < 4) reject(422, 'CHANGE_REASON_REQUIRED');
        const expectedVersion = request.input.expectedVersion;
        if (expectedVersion === undefined) reject(400, 'EXPECTED_VERSION_REQUIRED');

        if (!governance.isExactOwner) reject(403, 'PERMISSION_DENIED');

        const actorAccount = await currentRealmAccount(database, access.membership.id, access.actor.id);
        const target = await database.query<{
          member_id: string; account_id: string; realm_id: string; principal_id: string;
          account_status: string; account_version: number; organization_id: string;
        }>(`select membership.member_id,account.id account_id,account.realm_id,
          account.legacy_principal_id principal_id,account.status account_status,
          account.version account_version,membership.organization_id
          from access.membership membership
          join identity.account account on account.id=membership.account_id and account.realm_id=membership.realm_id
          where membership.id=$1 and access.scope_allowed(membership.organization_id)
          for update of membership,account`, [request.input.path.membershipid!]);
        const selected = target.rows[0];
        if (!selected) reject(404, 'MEMBERSHIP_NOT_FOUND');
        if (selected.account_id === actorAccount.accountId) reject(409, 'OWNER_MEMBERSHIP_PROTECTED');
        if (Number(selected.account_version) !== expectedVersion) reject(409, 'VERSION_CONFLICT');

        const protectedOwner = await database.query(`select 1 from access.membership owner_membership
          where owner_membership.id=$1 and owner_membership.member_id=$2 and owner_membership.status='active'`,
        [governance.ownerMembershipId ?? null, selected.member_id]);
        if (protectedOwner.rows[0]) reject(409, 'OWNER_MEMBERSHIP_PROTECTED');

        const memberships = await database.query<{ id: string; organization_id: string }>(
          `select id,organization_id from access.membership where account_id=$1 and realm_id=$2 for update`,
          [selected.account_id, selected.realm_id]
        );
        if (memberships.rows.length === 0) reject(404, 'MEMBERSHIP_NOT_FOUND');
        const outsideScope = await database.query(`select 1 from access.membership
          where account_id=$1 and realm_id=$2 and not access.scope_allowed(organization_id) limit 1`,
        [selected.account_id, selected.realm_id]);
        if (outsideScope.rows[0]) reject(409, 'IDENTITY_RESET_SCOPE_CONFLICT');

        const reauthenticated = await database.query(`select 1 from identity.assurance
          where account_id=$1 and realm_id=$2 and session_id=$3 and method='password' and level>=2
            and verified_at>clock_timestamp()-interval '10 minutes'
            and (expires_at is null or expires_at>clock_timestamp()) limit 1`,
        [actorAccount.accountId, actorAccount.realmId, access.actor.session]);
        if (!reauthenticated.rows[0]) reject(403, 'IDENTITY_REAUTH_REQUIRED');

        const credentials = await database.query<{ id: string; provider: string; status: string; subject_hash: string }>(
          `select id,provider,status,subject_hash from identity.credential where account_id=$1 and realm_id=$2 for update`,
          [selected.account_id, selected.realm_id]
        );
        const activePassword = credentials.rows.filter((credential) => credential.provider === 'password' && credential.status === 'active');
        if (selected.account_status !== 'active' || activePassword.length === 0) reject(409, 'IDENTITY_ACCOUNT_ALREADY_RELEASED');
        for (const credential of activePassword) {
          await database.query('select pg_advisory_xact_lock(hashtext($1))', [`${selected.realm_id}:${credential.subject_hash}`]);
        }

        const reset = `reset:${randomUUID()}`;
        const membershipIds = memberships.rows.map(({ id }) => id);
        await database.query(`update identity.authticket set consumed_at=coalesce(consumed_at,clock_timestamp())
          where session_id in(select session.id from identity.session session join access.membership membership
            on membership.id=session.membership_id where membership.account_id=$1 and membership.realm_id=$2)`,
        [selected.account_id, selected.realm_id]);
        await database.query(`update identity.session session set revoked_at=coalesce(session.revoked_at,clock_timestamp()),
          revoked_reason=coalesce(session.revoked_reason,'identity_reset') where exists(select 1 from access.membership membership
            where membership.id=session.membership_id and membership.account_id=$1 and membership.realm_id=$2)`,
        [selected.account_id, selected.realm_id]);
        await database.query(`update identity.assurance set expires_at=case when expires_at is null or expires_at>clock_timestamp()
          then clock_timestamp() else expires_at end where account_id=$1 and realm_id=$2`, [selected.account_id, selected.realm_id]);
        await database.query(`delete from identity.challengesecret secret using identity.challenge challenge
          where secret.challenge_id=challenge.id and challenge.realm_id=$1
            and (challenge.account_id=$2 or challenge.destination_hash::text=any($3::text[]))`,
        [selected.realm_id, selected.account_id, activePassword.map(({ subject_hash }) => subject_hash)]);
        await database.query(`update identity.challenge set consumed_at=coalesce(consumed_at,clock_timestamp())
          where realm_id=$1 and (account_id=$2 or destination_hash::text=any($3::text[]))`,
        [selected.realm_id, selected.account_id, activePassword.map(({ subject_hash }) => subject_hash)]);
        await database.query(`delete from identity.loginattempt where realm_id=$1 and subject_hash::text=any($2::text[])`,
          [selected.realm_id, activePassword.map(({ subject_hash }) => subject_hash)]);

        const federated = await database.query<{ id: string }>(`select id from identity.federatedidentity
          where account_id=$1 and realm_id=$2 for update`, [selected.account_id, selected.realm_id]);
        for (const identity of federated.rows) {
          await database.query(`update identity.federatedidentity set status='revoked',subject_hash=$2,union_hash=null,
            revoked_at=coalesce(revoked_at,clock_timestamp()),updated_at=clock_timestamp() where id=$1`,
          [identity.id, digest(`${reset}:federated:${identity.id}`)]);
        }
        for (const credential of credentials.rows) {
          await database.query(`update identity.credential set status='revoked',subject_hash=$2,subject_ciphertext=null,
            subject_key_version=null,secret_hash=null,encrypted_secret=null,rotated_at=clock_timestamp() where id=$1`,
          [credential.id, digest(`${reset}:credential:${credential.id}`)]);
        }

        await database.query(`update access.membershiprole set expires_at=clock_timestamp()
          where membership_id=any($1::text[]) and (expires_at is null or expires_at>clock_timestamp())`, [membershipIds]);
        await database.query(`update access.scopegrant set expires_at=clock_timestamp()
          where membership_id=any($1::text[]) and (expires_at is null or expires_at>clock_timestamp())`, [membershipIds]);
        await database.query(`update access.membershipoverride set revoked_at=coalesce(revoked_at,clock_timestamp())
          where membership_id=any($1::text[])`, [membershipIds]);
        await database.query(`update member.invite set status='disabled'
          where created_by=any($1::text[]) and status='active'`, [membershipIds]);
        await database.query(`update access.membership set status='left',access_version=access_version+1,
          employee_no=null,left_at=coalesce(left_at,clock_timestamp()) where id=any($1::text[])`, [membershipIds]);
        await database.query(`update member.profile set display_name='已重置成员 · '||right(id,8),mobile_ciphertext=null,
          mobile_token=null,email_ciphertext=null,email_token=null,status='disabled',version=version+1,updated_at=clock_timestamp()
          where id=$1 and not exists(select 1 from identity.account account
            where account.legacy_principal_id=$2 and account.id<>$3 and account.status='active')`,
        [selected.member_id, selected.principal_id, selected.account_id]);
        const result = await database.query<{ version: number }>(`update identity.account set status='disabled',
          mobile_ciphertext=null,mobile_token=null,mobile_masked=null,phone_verified_at=null,
          credential_version=credential_version+1,version=version+1,updated_at=clock_timestamp()
          where id=$1 and realm_id=$2 returning version`, [selected.account_id, selected.realm_id]);
        await database.query(`update identity.principal set status='disabled',credential_version=credential_version+1,
          version=version+1,updated_at=clock_timestamp() where id=$1 and not exists(select 1 from identity.account account
            where account.legacy_principal_id=$1 and account.status='active')`, [selected.principal_id]);
        const version = Number(result.rows[0]?.version);
        if (!Number.isSafeInteger(version)) throw new Error('IDENTITY_RESET_FAILED');
        await publishIdentityEvent(database, 'identity.member.reset', selected.principal_id, selected.organization_id,
          request.input.idempotency!, { principal: selected.principal_id, account: selected.account_id,
            realm: selected.realm_id, memberships: membershipIds, reason });
        return { status: 200, body: { principal_id: selected.principal_id, account_id: selected.account_id,
          status: 'reset', login_identity_released: true, history_retained: true, version } };
      },
      'identity.password.change': operationLifecycle({
        prepare: async (request) => {
          const access = requireAccess(request);
          const body = bodyRecord(request);
          const currentPassword = secretField(body, 'currentPassword', 128);
          const hash = await passwords.hash(secretField(body, 'newPassword', 128));
          return { access, currentPassword, hash };
        },
        execute: async (_request, database, { access, currentPassword, hash }) => {
          await database.query("select pg_advisory_xact_lock(hashtext('zhudatuan:platform-owner-transfer:v1'))");
          const account = await currentRealmAccount(database, access.membership.id, access.actor.id);
          const credential = await database.query<{ id: string; secret_hash: string }>(`select id,secret_hash from identity.credential
            where account_id=$1 and realm_id=$2 and provider='password' and status='active' for update`, [account.accountId, account.realmId]);
          const found = credential.rows[0];
          if (!found || !(await passwords.verify(currentPassword, found.secret_hash))) throw new Error('CREDENTIAL_INVALID');
          const evidenceHash = sessionDigest(access.actor.session);
          await database.query(`insert into identity.assurance(id,principal_id,method,level,evidence_hash,verified_at,expires_at,realm_id,account_id)
            values($1,$2,'password',2,$3,clock_timestamp(),clock_timestamp()+interval '10 minutes',$4,$5)`,
          [`assurance:${randomUUID()}`, access.actor.id, evidenceHash, account.realmId, account.accountId]);
          const ownerRotation = await database.query<{ result: Readonly<Record<string, unknown>> | null }>(
            `select identity.rotate_zhudatuan_owner_password($1,$2,null::text,$3,'credential_changed') result`,
            [access.actor.id, access.actor.session, hash]
          );
          const ownerResult = ownerRotation.rows[0]?.result;
          if (ownerResult) return { status: 200, body: ownerResult, headers: sessionCookies('', '', 0, access.actor.target) };
          await database.query('update identity.credential set secret_hash=$2,rotated_at=clock_timestamp() where id=$1', [found.id, hash]);
          const result = await database.query(`update identity.account set credential_version=credential_version+1,
            updated_at=clock_timestamp(),version=version+1 where id=$1 and realm_id=$2 returning credential_version,version`,
          [account.accountId, account.realmId]);
          await database.query(`update identity.session session set revoked_at=clock_timestamp(),revoked_reason='credential_changed'
            where session.id<>$2 and session.revoked_at is null and exists(select 1 from access.membership membership
              where membership.id=session.membership_id and membership.account_id=$1)`, [account.accountId, access.actor.session]);
          return rowResult(result);
        },
      }),
      'identity.password.verify': async (request, database) => {
        const access = requireAccess(request);
        const account = await currentRealmAccount(database, access.membership.id, access.actor.id);
        const password = secretField(bodyRecord(request), 'password', 128);
        const credential = await database.query<{ secret_hash: string | null }>(
          `select secret_hash from identity.credential
        where account_id=$1 and realm_id=$2 and provider='password' and status='active'`,
          [account.accountId, account.realmId]
        );
        if (!(await passwords.verify(password, credential.rows[0]?.secret_hash ?? null))) reject(401, 'CREDENTIAL_INVALID');
        const verifiedAt = new Date().toISOString();
        await database.query(
          `insert into identity.assurance(id,principal_id,session_id,method,level,evidence_hash,verified_at,expires_at,realm_id,account_id)
        values($1,$2,$3,'password',2,$4,$5::timestamptz,$5::timestamptz+interval '10 minutes',$6,$7)`,
          [`assurance:${randomUUID()}`, access.actor.id, access.actor.session, sessionDigest(access.actor.session), verifiedAt, account.realmId, account.accountId]
        );
        await database.query(
          `update identity.session set assurance_level=greatest(assurance_level,2),last_seen_at=clock_timestamp()
        where id=$1 and principal_id=$2 and account_id=$3 and realm_id=$4 and revoked_at is null`,
          [access.actor.session, access.actor.id, account.accountId, account.realmId]
        );
        return { status: 200, body: { verified: true, verifiedAt } };
      },
      'identity.password.reset': operationLifecycle({
        prepare: async (request) => {
          const body = bodyRecord(request);
          const challenge = textField(body, 'challenge');
          const hash = await passwords.hash(secretField(body, 'newPassword', 128));
          return { body, challenge, hash };
        },
        execute: async (request, database, { body, challenge, hash }) => atomicIdentityMutation(database, async () => {
          const entryRealm = await resolveRealmNode(database, request.input.headers.host);
          const { principal_id: principal, account_id: account, realm_id: accountRealmId } =
            await consumeChallenge(database, challenge, textField(body, 'code'), codeDigest, undefined,
              { purpose: 'password_reset', entryRealmId: entryRealm.realmId });
          if (!principal || !account || !accountRealmId) reject(400, 'CHALLENGE_PRINCIPAL_MISSING');
          const ownerRotation = await database.query<{ result: Readonly<Record<string, unknown>> | null }>(
            `select identity.rotate_zhudatuan_owner_password($1,null::text,$2,$3,'credential_reset') result`,
            [principal, challenge, hash]
          );
          const ownerResult = ownerRotation.rows[0]?.result;
          if (ownerResult) return { status: 200, body: ownerResult, headers: sessionCookies('', '', 0) };
          await database.query("update identity.credential set secret_hash=$3,rotated_at=clock_timestamp() where account_id=$1 and realm_id=$2 and provider='password' and status='active'", [account, accountRealmId, hash]);
          const result = await database.query(`update identity.account set credential_version=credential_version+1,
            updated_at=clock_timestamp(),version=version+1 where id=$1 and realm_id=$2 returning credential_version,version`, [account, accountRealmId]);
          await database.query(`update identity.session session set revoked_at=clock_timestamp(),revoked_reason='credential_reset'
            where session.revoked_at is null and exists(select 1 from access.membership membership
              where membership.id=session.membership_id and membership.account_id=$1 and membership.realm_id=$2)`, [account, accountRealmId]);
          return rowResult(result);
        }),
      }),
  };
}
