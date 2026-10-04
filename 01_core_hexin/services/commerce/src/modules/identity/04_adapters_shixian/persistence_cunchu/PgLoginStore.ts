import { randomUUID } from 'node:crypto';
import type { IdentityRealmContext } from '@shop/config/server';
import type { ActiveRealmMembershipContext } from '@shop/config/sfl-node-kernel';
import type { LoginAccount, LoginSessionRecord, LoginStore } from '@shop/l-kernel/login';
import type { OperationDatabase } from '../../../../foundation/application/ModuleOperations';
import { memberPort } from '../../../member';
import {
  consumeSmsLoginChallenge, recordInvalidSmsLoginChallenge, resolveMembershipAccount,
  resolvePasswordLoginCredential, verifySmsLoginChallenge,
} from '../../03_application_yingyong/services_fuwu/SmsLogin';
import { resolveActiveMembershipContext } from '../../03_application_yingyong/services_fuwu/RealmAccount';
import { requireValidStorefront } from '../../05_interface_jieru/http/RealmOperationContext';
import { publishIdentityEvent, tokenHash } from './IdentityPersistence';

export class PgLoginStore implements LoginStore<ActiveRealmMembershipContext> {
  constructor(private readonly database: OperationDatabase, private readonly realm: IdentityRealmContext,
    private readonly idempotency: string) {}

  passwordCredential(subjectHash: string, mobileTokens?: readonly string[]) {
    return resolvePasswordLoginCredential(this.database, {
      realmId: this.realm.realmId, subjectHash,
      ...(mobileTokens === undefined ? {} : { mobileTokens }),
      membershipClient: this.realm.membershipClient,
      membershipOrganizationId: this.realm.membershipOrganizationId,
    });
  }

  verifySmsChallenge(input: Readonly<{ id: string; codeHash: string; destinationHash: string }>) {
    return verifySmsLoginChallenge(this.database, { realmId: this.realm.realmId, ...input });
  }

  recordInvalidSmsChallenge(id: string, destinationHash: string) {
    return recordInvalidSmsLoginChallenge(this.database, id, destinationHash);
  }

  membershipAccount(principalId: string) {
    return resolveMembershipAccount(this.database, {
      entryRealmId: this.realm.realmId, principalId,
      membershipClient: this.realm.membershipClient,
      membershipOrganizationId: this.realm.membershipOrganizationId,
    });
  }

  async memberships(account: LoginAccount) {
    const memberships = await this.database.query<{ id: string; access_version: number; client: string; organization_id: string }>(
      `select membership.id,membership.access_version,membership.client,membership.organization_id from access.membership membership
          where membership.account_id=$1 and membership.realm_id=$2 and membership.status='active'
            and membership.client=$3 and membership.organization_id=$4
          order by membership.id`,
      [account.account_id, account.realm_id, this.realm.membershipClient, this.realm.membershipOrganizationId]
    );
    return memberships.rows;
  }

  storefront(application: string) {
    return requireValidStorefront(memberPort.storefrontRegistration(this.database, application));
  }

  activeMembershipContext(accountId: string, membershipId: string) {
    return resolveActiveMembershipContext(this.database, this.realm.realmId, accountId, membershipId);
  }

  consumeSmsChallenge(input: Readonly<{ id: string; codeHash: string; account: string; realmId: string; destinationHash: string }>) {
    return consumeSmsLoginChallenge(this.database, input);
  }

  async createSession({ id, account, membership, token, ipHash, userAgent, deviceLabel, assurance }: LoginSessionRecord) {
    await this.database.query(
      `insert into identity.session(id,principal_id,membership_id,token_hash,credential_version,access_version,client,ip_hash,user_agent,device_label,
              assurance_level,realm_id,account_id,auth_target,expires_at,last_seen_at,created_at)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,clock_timestamp()+interval '30 days',clock_timestamp(),clock_timestamp())`,
      [id, account.principal_id, membership.id, tokenHash(token), account.credential_version,
        membership.access_version, membership.client, ipHash, userAgent, deviceLabel, assurance,
        account.realm_id, account.account_id, this.realm.target]
    );
  }

  async createSmsAssurance(input: Readonly<{ account: LoginAccount; sessionId: string; evidenceHash: string }>) {
    await this.database.query(
      `insert into identity.assurance(id,principal_id,session_id,method,level,evidence_hash,verified_at,expires_at,realm_id,account_id)
              values($1,$2,$3,'phone_otp',2,$4,clock_timestamp(),clock_timestamp()+interval '12 hours',$5,$6)`,
      [`assurance:${randomUUID()}`, input.account.principal_id, input.sessionId, input.evidenceHash,
        input.account.realm_id, input.account.account_id]
    );
  }

  async consumeLoginIntent(token: string, accountId: string, sessionId: string) {
    return (await this.database.query<{
      login_intent_id: string; source_realm_id: string; source_node_id: string;
      source_account_id: string; source_session_id: string; target_node_id: string;
    }>(`select * from identity.consume_login_intent($1,$2,$3,$4,$5,$6)`, [
      tokenHash(token), this.realm.realmId, this.realm.target, this.realm.application ?? null, accountId, sessionId,
    ])).rows[0];
  }

  publishSessionCreated(sessionId: string, membershipId: string, payload: Readonly<Record<string, unknown>>) {
    return publishIdentityEvent(this.database, 'identity.session.created', sessionId, membershipId, this.idempotency, payload);
  }
}
