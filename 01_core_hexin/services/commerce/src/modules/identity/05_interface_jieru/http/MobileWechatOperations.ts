import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { canonicalFinancialActionRequest, requiresFinancialActionProof, requiresFinancialExpectedVersion, type OperationId } from '@shop/contract';
import { operationLifecycle, reject, requireAccess, rowResult, type OperationActions } from '../../../../foundation/application/ModuleOperations';
import { bodyRecord, textField } from '../../../../foundation/interface/Validation';
import { requireGovernanceContext } from '../../../../foundation/security/AccessContext';
import { completeWechatBinding, prepareWechatBinding, publishIdentityEvent, tokenHash } from '../../04_adapters_shixian/persistence_cunchu/IdentityPersistence';
import { consumeChallenge, sessionCookies } from './IdentitySecurity';
import { memberPort } from '../../../member';
import { canonicalMobile } from '../../02_domain_yewu/models_moxing/IdentitySubject';
import { resolveBoundMobileAccount } from '../../03_application_yingyong/services_fuwu/SmsLogin';
import { currentRealmAccount } from '../../03_application_yingyong/services_fuwu/RealmAccount';
import { maskMobile, type RealmOperationContext } from './RealmOperationContext';

export const MOBILE_WECHAT_OPERATION_IDS = Object.freeze([
  'identity.mobile.challenge',
  'identity.mobile.manage',
  'identity.stepup.start',
  'identity.stepup.complete',
] as const satisfies readonly OperationId[]);

export function mobileWechatOperations(runtime: RealmOperationContext): OperationActions {
  const { codeDigest, digest, kms, notificationScope, sessionDigest, stepup } = runtime;
  return {
      'identity.mobile.challenge': operationLifecycle({
        prepare: async (request) => {
          const access = requireAccess(request);
          const body = bodyRecord(request);
          const id = `challenge:${randomUUID()}`;
          const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
          const mobile = canonicalMobile(textField(body, 'destination', 32));
          const destinationHash = digest(mobile);
          const [envelope, recipient] = await Promise.all([
            kms.encrypt('identity/challenge', code, { challenge: id, purpose: 'phone_change' }),
            kms.encrypt('identity/destination', mobile, { challenge: id, purpose: 'phone_change' }),
          ]);
          return { access, id, code, destinationHash, envelope, recipient };
        },
        execute: async (request, database, prepared) => {
          const { access, id, code, destinationHash, envelope, recipient } = prepared;
          const account = await currentRealmAccount(database, access.membership.id, access.actor.id);
          const result = await database.query(
            `with challenge as (
          insert into identity.challenge(id,principal_id,purpose,destination_hash,code_hash,session_hash,attempts,expires_at,created_at,realm_id,account_id)
          values($1,$2,'phone_change',$3,$4,$5,0,clock_timestamp()+interval '10 minutes',clock_timestamp(),$10,$11) returning id,purpose,expires_at
        ), secret as (insert into identity.challengesecret(challenge_id,code_ciphertext,code_key_version,destination_ciphertext,destination_key_version,created_at)
          values($1,$6,$7,$8,$9,clock_timestamp())) select * from challenge`,
            [id, access.actor.id, destinationHash, codeDigest(id, code), sessionDigest(access.actor.session),
              envelope.ciphertext, envelope.keyVersion, recipient.ciphertext, recipient.keyVersion, account.realmId, account.accountId]
          );
          await database.query(`insert into runtime.job(id,kind,owner,scope_id,payload,state,priority,available_at,created_at,updated_at)
          values($1,'identitynotification','identity',$2,jsonb_build_object('challenge',$3::text),'queued',1,clock_timestamp(),clock_timestamp(),clock_timestamp())`,
          [`job:notify:${id}`, notificationScope ?? access.scope.id, id]);
          await publishIdentityEvent(database, 'identity.challenge.started', id, access.scope.id, request.input.idempotency!,
            { challenge: id, destination: destinationHash, purpose: 'phone_change' });
          return rowResult(result, 202);
        },
      }),
      'identity.mobile.manage': operationLifecycle({
        prepare: async (request) => {
          const access = requireAccess(request);
          const body = bodyRecord(request);
          const mobile = canonicalMobile(textField(body, 'mobile', 32));
          const envelope = await kms.encrypt('identity/mobile', mobile, { principal: access.actor.id });
          return { access, body, mobile, envelope };
        },
        execute: async (_request, database, { access, body, mobile, envelope }) => {
          const governance = access.actor.target === 'storefront' ? access.governance : requireGovernanceContext(access);
          await database.query("select pg_advisory_xact_lock(hashtext('zhudatuan:platform-owner-transfer:v1'))");
          const account = await currentRealmAccount(database, access.membership.id, access.actor.id);
          const destinationHash = digest(mobile);
          await database.query('select pg_advisory_xact_lock(hashtext($1))', [`${account.realmId}:${destinationHash}`]);
          const accountState = await database.query<{ mobile_ciphertext: string | null }>(
            `select mobile_ciphertext from identity.account where id=$1 and realm_id=$2 and status='active' for update`,
            [account.accountId, account.realmId]);
          const current = accountState.rows[0];
          if (!current) reject(404, 'RESOURCE_NOT_FOUND');
          if (current.mobile_ciphertext === null) {
            const passwordEvidence = await database.query(`select 1 from identity.assurance where account_id=$1 and realm_id=$2 and method='password' and level=2
              and evidence_hash=$3 and verified_at>=clock_timestamp()-interval '10 minutes'
              and expires_at>clock_timestamp() limit 1`, [account.accountId, account.realmId, sessionDigest(access.actor.session)]);
            if (!passwordEvidence.rows[0]) reject(403, 'MOBILE_ENROLLMENT_PASSWORD_REQUIRED');
          } else if (!stepup.accepts(true, access.assurance, new Date())) reject(403, 'MOBILE_CHANGE_STEP_UP_REQUIRED');
          const boundAccount = await resolveBoundMobileAccount(database, account.realmId,
            [destinationHash, envelope.fingerprint, createHash('sha256').update(mobile).digest('hex')]);
          if (boundAccount !== null && boundAccount.account_id !== account.accountId) reject(409, 'IDENTITY_SUBJECT_EXISTS');
          await consumeChallenge(database, textField(body, 'challenge'), textField(body, 'code'), codeDigest, access.actor.id,
            { purpose: 'phone_change', destinationHash, sessionHash: sessionDigest(access.actor.session),
              realmId: account.realmId, accountId: account.accountId });
          if (governance?.isExactOwner) {
            const changed = await database.query<{ profile: Readonly<Record<string, unknown>> }>(
              `select access.change_zhudatuan_owner_mobile($1,$2,$3,$4,$5,$6,$7,$8,$9) profile`,
              [access.actor.id, access.actor.session, textField(body, 'challenge'), envelope.ciphertext,
                destinationHash, envelope.fingerprint, maskMobile(mobile), sessionDigest(access.actor.session), sessionDigest(access.actor.session)]);
            const result = changed.rows[0]?.profile;
            if (!result) throw new Error('MEMBER_PROFILE_NOT_FOUND');
            return { status: 200, body: result, headers: { ...sessionCookies('', '', 0, access.actor.target), etag: `\"${String(result.version)}\"` } };
          }
          const credential = await database.query<{ id: string }>(`select id from identity.credential
            where account_id=$1 and realm_id=$2 and provider='password' and status='active' for update`, [account.accountId, account.realmId]);
          if (!credential.rows[0]) throw new Error('CREDENTIAL_NOT_FOUND');
          await database.query(`update identity.credential set subject_hash=$2,rotated_at=clock_timestamp()
            where id=$1 and account_id=$3 and realm_id=$4 and provider='password' and status='active'`,
          [credential.rows[0].id, destinationHash, account.accountId, account.realmId]);
          const result = await memberPort.changeMobile(database, access.actor.id, envelope.ciphertext, envelope.fingerprint, maskMobile(mobile));
          await database.query(`update identity.assurance set expires_at=least(coalesce(expires_at,clock_timestamp()),clock_timestamp())
            where account_id=$1 and realm_id=$2 and method='phone_otp' and (expires_at is null or expires_at>clock_timestamp())`,
          [account.accountId, account.realmId]);
          await database.query(`insert into identity.assurance(id,principal_id,method,level,evidence_hash,verified_at,expires_at,realm_id,account_id)
            values($1,$2,'phone_otp',2,$3,clock_timestamp(),clock_timestamp()+interval '365 days',$4,$5)`,
          [`assurance:${randomUUID()}`, access.actor.id, digest(mobile), account.realmId, account.accountId]);
          await database.query(`update identity.account set mobile_ciphertext=$3,mobile_token=$4,mobile_masked=$5,
            phone_verified_at=clock_timestamp(),credential_version=credential_version+1,assurance_level=greatest(assurance_level,2),
            version=version+1,updated_at=clock_timestamp() where id=$1 and realm_id=$2`,
          [account.accountId, account.realmId, envelope.ciphertext, envelope.fingerprint, maskMobile(mobile)]);
          await database.query(`update identity.session session set revoked_at=clock_timestamp(),revoked_reason='mobile_changed'
            where session.revoked_at is null and exists(select 1 from access.membership membership
              where membership.id=session.membership_id and membership.account_id=$1 and membership.realm_id=$2)`,
          [account.accountId, account.realmId]);
          return { status: 200, body: result, headers: { ...sessionCookies('', '', 0, access.actor.target), etag: `\"${String(result.version)}\"` } };
        },
      }),
      'identity.stepup.start': operationLifecycle({
        prepare: async (request) => {
          const access = requireAccess(request);
          const id = `challenge:${randomUUID()}`;
          const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
          if (Object.hasOwn(bodyRecord(request), 'destination')) reject(400, 'STEP_UP_DESTINATION_FORBIDDEN');
          return { access, id, code };
        },
        execute: async (request, database, { access, id, code }) => {
          const account = await currentRealmAccount(database, access.membership.id, access.actor.id);
          const accountState = await database.query<{ mobile_ciphertext: string | null }>(
            `select mobile_ciphertext from identity.account where id=$1 and realm_id=$2 and status='active'`, [account.accountId, account.realmId]);
          const ciphertext = accountState.rows[0]?.mobile_ciphertext;
          if (!ciphertext) throw new Error('STEP_UP_DESTINATION_MISSING');
          const destination = await kms.decrypt('identity/mobile', ciphertext, { principal: access.actor.id });
          const [envelope, recipient] = await Promise.all([kms.encrypt('identity/challenge', code, { challenge: id, purpose: 'stepup' }), kms.encrypt('identity/destination', destination, { challenge: id, purpose: 'stepup' })]);
          const result = await database.query(
            `with challenge as (insert into identity.challenge(id,principal_id,purpose,destination_hash,code_hash,session_hash,attempts,expires_at,created_at,realm_id,account_id)
        values($1,$2,'stepup',$3,$4,$5,0,clock_timestamp()+interval '5 minutes',clock_timestamp(),$10,$11) returning id,purpose,expires_at),
        secret as (insert into identity.challengesecret(challenge_id,code_ciphertext,code_key_version,destination_ciphertext,destination_key_version,created_at)
          values($1,$6,$7,$8,$9,clock_timestamp())) select * from challenge`,
            [id, access.actor.id, digest(destination), codeDigest(id, code), sessionDigest(access.actor.session),
              envelope.ciphertext, envelope.keyVersion, recipient.ciphertext, recipient.keyVersion, account.realmId, account.accountId]
          );
          await database.query(
            `insert into runtime.job(id,kind,owner,scope_id,payload,state,priority,available_at,created_at,updated_at)
          values($1,'identitynotification','identity',$2,jsonb_build_object('challenge',$3::text),'queued',1,clock_timestamp(),clock_timestamp(),clock_timestamp())`,
            [`job:notify:${id}`, notificationScope ?? access.scope.id, id]
          );
          await publishIdentityEvent(database, 'identity.challenge.started', id, access.scope.id, request.input.idempotency!, { challenge: id, purpose: 'stepup' });
          return rowResult(result, 202);
        },
      }),
      'identity.stepup.complete': async (request, database) => {
        const access = requireAccess(request);
        const body = bodyRecord(request);
        const account = await currentRealmAccount(database, access.membership.id, access.actor.id);
        const action = financialActionRequest(body.action);
        const bindingToken = body.bindingToken === undefined ? null : textField(body, 'bindingToken', 1024);
        if (action !== null && bindingToken !== null) reject(400, 'OPERATION_INPUT_INVALID');
        const wechatBinding = bindingToken === null ? null
          : await prepareWechatBinding(database, tokenHash(bindingToken), access.actor.id, account.realmId, account.accountId);
        const challenge = textField(body, 'challenge');
        const accountState = await database.query<{ mobile_ciphertext: string | null }>(
          `select mobile_ciphertext from identity.account where id=$1 and realm_id=$2 and status='active' for update`, [account.accountId, account.realmId]);
        const ciphertext = accountState.rows[0]?.mobile_ciphertext;
        if (!ciphertext) throw new Error('STEP_UP_DESTINATION_MISSING');
        const destination = await kms.decrypt('identity/mobile', ciphertext, { principal: access.actor.id });
        await consumeChallenge(database, challenge, textField(body, 'code'), codeDigest, access.actor.id,
          { purpose: 'stepup', destinationHash: digest(destination), sessionHash: sessionDigest(access.actor.session),
            realmId: account.realmId, accountId: account.accountId });
        await database.query(
          `insert into identity.assurance(id,principal_id,method,level,evidence_hash,verified_at,expires_at,realm_id,account_id)
          values($1,$2,'phone_otp',2,$3,clock_timestamp(),clock_timestamp()+interval '365 days',$4,$5)`,
          [`assurance:${randomUUID()}`, access.actor.id, digest(destination), account.realmId, account.accountId]
        );
        const assurance = `assurance:${randomUUID()}`;
        if (action === null) {
          await database.query(
            `insert into identity.assurance(id,principal_id,session_id,method,level,evidence_hash,verified_at,expires_at,realm_id,account_id)
          values($1,$2,$3,'otp',3,$4,clock_timestamp(),clock_timestamp()+interval '15 minutes',$5,$6)`,
            [assurance, access.actor.id, access.actor.session, sessionDigest(access.actor.session), account.realmId, account.accountId]
          );
        } else {
          await database.query(
            `insert into identity.assurance(id,principal_id,session_id,method,level,evidence_hash,verified_at,expires_at,realm_id,account_id)
          values($1,$2,$3,'otp',3,$4,clock_timestamp(),clock_timestamp()+interval '15 minutes',$5,$6)`,
            [assurance, access.actor.id, access.actor.session, digest(challenge), account.realmId, account.accountId]
          );
        }
        const result = await database.query(
          `update identity.session set assurance_level=3,last_seen_at=clock_timestamp()
        where id=$1 and principal_id=$2 and account_id=$3 and realm_id=$4 and revoked_at is null returning id,assurance_level`,
          [access.actor.session, access.actor.id, account.accountId, account.realmId]
        );
        const session = result.rows[0];
        if (!session) throw new Error('AUTHENTICATION_REQUIRED');
        if (wechatBinding !== null) {
          const identity = await completeWechatBinding(database, wechatBinding, access.actor.id, access.membership.id, account.realmId, account.accountId);
          return { status: 200, body: { ...session, wechat: { identity, status: 'active' } } };
        }
        if (action === null) return rowResult(result);
        const proof = randomBytes(48).toString('base64url');
        const issued = await database.query<{ scope_id: string; resource_id: string; expires_at: Date }>('select scope_id,resource_id,expires_at from access.issue_action_proof($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [
          createHash('sha256').update(proof).digest('hex'),
          access.actor.id,
          access.actor.session,
          access.membership.id,
          assurance,
          action.operation,
          action.resource,
          action.idempotencyKey,
          action.expectedVersion,
          action.requestHash,
        ]);
        const binding = issued.rows[0];
        if (!binding) throw new Error('ACTION_PROOF_REQUIRED');
        return {
          status: 200,
          body: {
            ...session,
            actionProof: {
              proof,
              operation: action.operation,
              resource: binding.resource_id,
              scope: binding.scope_id,
              idempotencyKey: action.idempotencyKey,
              expectedVersion: action.expectedVersion,
              requestHash: action.requestHash,
              expiresAt: binding.expires_at.toISOString(),
            },
          },
        };
      },
  };
}

interface FinancialActionRequest {
  readonly operation: string;
  readonly resource: string | null;
  readonly idempotencyKey: string;
  readonly expectedVersion: number | null;
  readonly requestHash: string;
}

function financialActionRequest(value: unknown): FinancialActionRequest | null {
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('ACTION_PROOF_REQUIRED');
  const operation = Reflect.get(value, 'operation');
  const resourceValue = Reflect.get(value, 'resource');
  const idempotencyValue = Reflect.get(value, 'idempotencyKey');
  const expectedValue = Reflect.get(value, 'expectedVersion');
  const requestHashValue = Reflect.get(value, 'requestHash');
  const requestValue = Reflect.get(value, 'request');
  if (typeof operation !== 'string' || !requiresFinancialActionProof(operation)) throw new Error('ACTION_PROOF_REQUIRED');
  if (resourceValue !== undefined && (typeof resourceValue !== 'string' || resourceValue.length === 0 || resourceValue.length > 255)) {
    throw new Error('ACTION_PROOF_REQUIRED');
  }
  if (typeof idempotencyValue !== 'string' || idempotencyValue.length === 0 || idempotencyValue.length > 255) {
    throw new Error('IDEMPOTENCY_KEY_REQUIRED');
  }
  if (expectedValue !== undefined && (!Number.isSafeInteger(expectedValue) || (expectedValue as number) < 0)) {
    throw new Error('EXPECTED_VERSION_INVALID');
  }
  if (requiresFinancialExpectedVersion(operation) && expectedValue === undefined) throw new Error('EXPECTED_VERSION_REQUIRED');
  if (typeof requestHashValue !== 'string' || !/^[0-9a-f]{64}$/.test(requestHashValue) || requestValue === null || typeof requestValue !== 'object' || Array.isArray(requestValue)) {
    throw new Error('ACTION_PROOF_REQUIRED');
  }
  let authoritativeHash: string;
  try {
    authoritativeHash = createHash('sha256')
      .update(
        canonicalFinancialActionRequest({
          operation,
          path: Reflect.get(requestValue, 'path'),
          query: Reflect.get(requestValue, 'query'),
          body: Reflect.get(requestValue, 'body'),
        })
      )
      .digest('hex');
  } catch {
    throw new Error('ACTION_PROOF_REQUIRED');
  }
  if (requestHashValue !== authoritativeHash) throw new Error('ACTION_PROOF_REQUIRED');
  return {
    operation,
    resource: typeof resourceValue === 'string' ? resourceValue : null,
    idempotencyKey: idempotencyValue,
    expectedVersion: typeof expectedValue === 'number' ? expectedValue : null,
    requestHash: authoritativeHash,
  };
}
