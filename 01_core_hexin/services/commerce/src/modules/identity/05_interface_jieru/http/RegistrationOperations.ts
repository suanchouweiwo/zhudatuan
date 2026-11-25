import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { OperationId } from '@shop/contract';
import { operationLifecycle, reject, type OperationActions } from '../../../../foundation/application/ModuleOperations';
import { bodyRecord, secretField, textField } from '../../../../foundation/interface/Validation';
import { AuthTransaction } from '../../02_domain_yewu/models_moxing/AuthTransaction';
import { atomicIdentityMutation, bindWechat, publishIdentityEvent, tokenHash } from '../../04_adapters_shixian/persistence_cunchu/IdentityPersistence';
import { authMembershipTarget, authTarget, consumeChallenge, SESSION_MAX_AGE_SECONDS, sessionCookies } from './IdentitySecurity';
import { accessPort } from '../../../access';
import { memberPort, type MemberInvite } from '../../../member';
import { organizationPort } from '../../../organization';
import { canonicalMobile } from '../../02_domain_yewu/models_moxing/IdentitySubject';
import { resolveBoundMobileAccount } from '../../03_application_yingyong/services_fuwu/SmsLogin';
import { resolveActiveMembershipContext, resolveRealmApplication, resolveRealmContext, resolveRealmNode } from '../../03_application_yingyong/services_fuwu/RealmAccount';
import {
  registrationReference,
  requireValidInvite,
  requireValidStorefront,
  type RealmOperationContext,
} from './RealmOperationContext';

export const REGISTRATION_OPERATION_IDS = Object.freeze([
  'identity.challenges.create',
  'identity.members.create',
] as const satisfies readonly OperationId[]);

export function registrationOperations(runtime: RealmOperationContext): OperationActions {
  const { codeDigest, digest, kms, notificationScope, passwords, registrationOnly, tickets } = runtime;
  return {
      'identity.challenges.create': operationLifecycle({
        prepare: async (request) => {
          const body = bodyRecord(request);
          const id = `challenge:${randomUUID()}`;
          const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
          const purpose = textField(body, 'purpose');
          if (registrationOnly && purpose !== 'registration' && purpose !== 'login' && purpose !== 'password_reset') reject(400, 'CHALLENGE_PURPOSE_INVALID');
          if (!['registration', 'login', 'password_reset', 'wechat_bind'].includes(purpose)) throw new Error('CHALLENGE_PURPOSE_INVALID');
          const requestedDestination = textField(body, 'destination').trim();
          const destination = purpose === 'registration' || purpose === 'login' || purpose === 'password_reset'
            ? canonicalMobile(requestedDestination) : requestedDestination;
          const destinationHash = digest(destination);
          const registration = purpose === 'registration' ? registrationReference(body) : undefined;
          const registrationHash = registration === undefined ? undefined
            : digest(registration.kind === 'invite' ? registration.value : `storefront:${registration.value}`);
          const resolvesBoundMobile = purpose === 'registration' || purpose === 'login' || purpose === 'password_reset';
          const legacyMobileToken = resolvesBoundMobile ? createHash('sha256').update(destination).digest('hex') : undefined;
          const [envelope, recipient, mobileLookup] = await Promise.all([
            kms.encrypt('identity/challenge', code, { challenge: id, purpose }),
            kms.encrypt('identity/destination', destination, { challenge: id, purpose }),
            resolvesBoundMobile ? kms.encrypt('identity/mobile', destination, { challenge: id, purpose }) : Promise.resolve(undefined),
          ]);
          return { body, id, code, purpose, destinationHash, registration, registrationHash, legacyMobileToken, envelope, recipient, mobileLookup };
        },
        execute: async (request, database, prepared) => {
          const { body, id, code, purpose, destinationHash, registration, registrationHash, legacyMobileToken, envelope, recipient, mobileLookup } = prepared;
          const realm = await resolveRealmNode(database, request.input.headers.host);
          if (purpose === 'registration') {
            if (!registration || !registrationHash) throw new Error('REGISTRATION_CONTEXT_INVALID');
            if (registration.kind === 'invite') {
              await requireValidInvite(memberPort.assertRegistrationInvite(database, registrationHash, destinationHash));
            } else {
              await requireValidStorefront(memberPort.storefrontRegistration(database, registration.value));
            }
          }
          let principal = typeof body.principal === 'string' ? body.principal : null;
          let account: string | null = null;
          let challengeRealmId = realm.realmId;
          if (purpose === 'registration' || purpose === 'login' || purpose === 'password_reset') {
            const bound = await resolveBoundMobileAccount(database, realm.realmId, [destinationHash, mobileLookup!.fingerprint, legacyMobileToken!]);
            principal = bound?.principal_id ?? null;
            account = bound?.account_id ?? null;
            challengeRealmId = bound?.realm_id ?? realm.realmId;
          }
          const result = await database.query(
            `with challenge as (
          insert into identity.challenge(id,principal_id,purpose,destination_hash,code_hash,attempts,expires_at,created_at,realm_id,account_id)
          values($1,$2,$3,$4,$5,0,clock_timestamp()+interval '10 minutes',clock_timestamp(),$10,$11) returning id,purpose,expires_at
        ), secret as (insert into identity.challengesecret(challenge_id,code_ciphertext,code_key_version,destination_ciphertext,destination_key_version,created_at)
          values($1,$6,$7,$8,$9,clock_timestamp())) select * from challenge`,
            [id, principal, purpose, destinationHash, codeDigest(id, registrationHash === undefined ? code : `${code}:${registrationHash}`), envelope.ciphertext, envelope.keyVersion, recipient.ciphertext, recipient.keyVersion, challengeRealmId, account]
          );
          await database.query(
            `insert into runtime.job(id,kind,owner,scope_id,payload,state,priority,available_at,created_at,updated_at)
          select $1,'identitynotification','identity',$2,jsonb_build_object('challenge',$3::text),'queued',1,clock_timestamp(),clock_timestamp(),clock_timestamp()
          where $4::text is not null`,
            [`job:notify:${id}`, notificationScope ?? realm.nodeId, id, purpose === 'login' ? principal : 'public-challenge']
          );
          await publishIdentityEvent(database, 'identity.challenge.started', id, 'identity', request.input.idempotency!, {
            challenge: id, destination: destinationHash, purpose, realm: challengeRealmId,
            entryRealm: realm.realmId, ...(account === null ? {} : { account }),
          });
          const saved = result.rows[0];
          if (!saved) throw new Error('CHALLENGE_CREATE_FAILED');
          return {
            status: 202,
            body: { ...saved, ...(purpose === 'registration' ? { identity_exists: account !== null } : {}) },
          };
        },
      }),
      'identity.members.create': operationLifecycle({
        prepare: async (request) => {
          const body = bodyRecord(request);
          const subject = canonicalMobile(textField(body, 'subject'));
          const principal = `principal:${randomUUID()}`;
          const requestedPassword = typeof body.password === 'string' && body.password.length > 0
            ? secretField(body, 'password', 128) : null;
          const [password, mobile] = await Promise.all([
            requestedPassword === null ? Promise.resolve(null) : passwords.hash(requestedPassword),
            kms.encrypt('identity/mobile', subject, { principal }),
          ]);
          const authorization = body.authorization === undefined ? null : AuthTransaction.start(body.authorization);
          const loginIntent = body.loginIntent === undefined ? undefined : secretField(body, 'loginIntent', 128);
          if (loginIntent !== undefined && (!/^[A-Za-z0-9_-]{64}$/.test(loginIntent) || authorization === null)) {
            throw new Error('LOGIN_INTENT_INVALID');
          }
          return {
            body,
            subject,
            password,
            principal,
            account: `account:${randomUUID()}`,
            mobile,
            authorization,
            loginIntent,
            assurance: `assurance:${randomUUID()}`,
            member: `member:${randomUUID()}`,
            membership: `membership:${randomUUID()}`,
            operatorMembership: `membership:${randomUUID()}`,
            credential: `credential:${randomUUID()}`,
            registration: `registration:${randomUUID()}`,
            registrationBusinessNumber: `SFLREG-${randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`,
            registrationNodeKey: `member-${randomUUID()}`,
            registrationRealm: `realm:member-${randomUUID()}`,
            scopes: [`scope:${randomUUID()}`, `scope:${randomUUID()}`, `scope:${randomUUID()}`, `scope:${randomUUID()}`, `scope:${randomUUID()}`, `scope:${randomUUID()}`] as const,
          };
        },
        execute: async (request, database, prepared) => atomicIdentityMutation(database, async () => {
          const { body, subject, password, principal, account, mobile, authorization, loginIntent, assurance, member, membership,
            operatorMembership, credential, registration: registrationId, registrationBusinessNumber, registrationNodeKey,
            registrationRealm, scopes } = prepared;
          const realm = await resolveRealmNode(database, request.input.headers.host);
          const requestedReturnTarget = authorization === null || typeof body.target !== 'string' ? undefined : authTarget(body.target);
          if (authorization !== null && (requestedReturnTarget === undefined || authMembershipTarget(requestedReturnTarget) !== 'storefront')) {
            throw new Error('AUTH_RETURN_TARGET_INVALID');
          }
          const subjectHash = digest(subject);
          await database.query('select pg_advisory_xact_lock(hashtext($1))', [`${realm.realmId}:${subjectHash}`]);
          const mobileTokens = [subjectHash, mobile.fingerprint, createHash('sha256').update(subject).digest('hex')];
          const boundAccount = await resolveBoundMobileAccount(database, realm.realmId, mobileTokens);
          let existing = await database.query<{
            account_id: string; realm_id: string; principal_id: string; credential_version: number; secret_hash: string | null;
          }>(
            `select account.id account_id,account.realm_id,account.legacy_principal_id principal_id,
              account.credential_version,credential.secret_hash
            from identity.credential credential join identity.account account
              on account.id=credential.account_id and account.realm_id=credential.realm_id
            where identity.realm_contains_account_realm($1,credential.realm_id)
              and credential.provider='password' and credential.subject_hash=$2
              and credential.status='active' and account.status='active'
            order by credential.created_at,credential.id limit 1 for update of credential,account`,
            [realm.realmId, subjectHash]
          );
          if (boundAccount !== null && existing.rows[0]?.account_id !== boundAccount.account_id) {
            existing = await database.query<{
              account_id: string; realm_id: string; principal_id: string; credential_version: number; secret_hash: string | null;
            }>(
              `select account.id account_id,account.realm_id,account.legacy_principal_id principal_id,account.credential_version
                ,credential.secret_hash
              from identity.account account join identity.credential credential
                on credential.account_id=account.id and credential.realm_id=account.realm_id
                and credential.provider='password' and credential.status='active'
              where account.id=$1
                and identity.realm_contains_account_realm($2,account.realm_id) and account.status='active'
              for update of account,credential`,
              [boundAccount.account_id, realm.realmId]
            );
            if (!existing.rows[0]) reject(409, 'IDENTITY_SUBJECT_EXISTS');
          }
          const registration = registrationReference(body);
          const registrationHash = digest(registration.kind === 'invite' ? registration.value : `storefront:${registration.value}`);
          const deferredPhoneVerification = registration.kind === 'storefront' && body.phoneVerification === 'checkout';
          if (!deferredPhoneVerification) {
            await consumeChallenge(database, textField(body, 'challenge'), textField(body, 'code'),
              (challenge, code) => codeDigest(challenge, `${code}:${registrationHash}`), undefined,
              { purpose: 'registration', destinationHash: subjectHash, realmId: existing.rows[0]?.realm_id ?? realm.realmId });
          }
          let registrationTarget: MemberInvite;
          let applicationReturnTarget: ReturnType<typeof authTarget> | undefined;
          if (registration.kind === 'invite') {
            registrationTarget = await requireValidInvite(memberPort.registrationInvite(database, registrationHash, subjectHash));
            if (registrationTarget.target_client === 'operator') {
              registrationTarget = await requireValidInvite(memberPort.consumeInvite(database, registrationHash, subjectHash, operatorMembership));
            }
          } else {
            const storefront = await requireValidStorefront(memberPort.storefrontRegistration(database, registration.value));
            const applicationRealm = await resolveRealmApplication(database, realm.realmId, storefront.application_slug);
            if (applicationRealm.membershipOrganizationId !== storefront.organization_id) throw new Error('AUTH_REALM_MISMATCH');
            applicationReturnTarget = applicationRealm.target;
            if (requestedReturnTarget !== undefined && requestedReturnTarget !== applicationReturnTarget) {
              throw new Error('AUTH_RETURN_TARGET_INVALID');
            }
            registrationTarget = {
              id: `storefront:${storefront.application_id}`,
              organization_id: storefront.organization_id,
              created_by: '',
              role_id: storefront.role_id,
              target_client: 'storefront',
              terms_hash: storefront.terms_hash,
              storefront_organization_id: null,
              storefront_role_id: storefront.role_id,
              governance_level: null,
            };
            await database.query(`select set_config('app.registration_mall_id',$1,true)`, [storefront.organization_id]);
            if (deferredPhoneVerification) {
              await database.query(`select set_config('app.registration_phone_verification','checkout',true)`);
            }
          }
          if (authorization !== null && registrationTarget.target_client !== 'storefront') throw new Error('AUTH_RETURN_TARGET_INVALID');
          if (existing.rows[0] && authorization === null && registrationTarget.target_client !== 'operator') {
            reject(409, 'IDENTITY_SUBJECT_EXISTS');
          }
          const organization = registrationTarget.organization_id;
          const operatorRealm = registrationTarget.target_client === 'operator'
            ? await resolveRealmContext(database, request.input.headers.host, 'console') : undefined;
          if (operatorRealm !== undefined && (operatorRealm.surface !== 'admin' || operatorRealm.membershipClient !== 'operator')) {
            throw new Error('AUTH_REALM_MISMATCH');
          }
          if (body.termsAccepted !== true || body.termsHash !== registrationTarget.terms_hash) throw new Error('TERMS_ACCEPTANCE_REQUIRED');
          const operatorDisplayName = registrationTarget.target_client === 'operator'
            ? textField(body, 'displayName') : undefined;
          let resolvedPrincipal = principal;
          let resolvedAccount = account;
          let resolvedMember = member;
          let credentialVersion = 1;
          let result: Readonly<Record<string, unknown>>;
          let memberNodeRegistration: Awaited<ReturnType<typeof memberPort.registerHostedMemberNode>> | null = null;
          let accountRealm = realm.realmId;
          const scopeKind = registrationTarget.target_client === 'storefront'
            ? await organizationPort.kind(database, organization) : 'tenant';
          if (existing.rows[0]) {
            const sourceAccount = existing.rows[0];
            resolvedPrincipal = sourceAccount.principal_id;
            resolvedAccount = sourceAccount.account_id;
            accountRealm = sourceAccount.realm_id;
            credentialVersion = sourceAccount.credential_version;
            const profile = await database.query<{ id: string }>(
              `select id from member.profile where principal_id=$1 and status='active' for update`,
              [resolvedPrincipal]
            );
            if (!profile.rows[0]) throw new Error('MEMBER_PROFILE_NOT_FOUND');
            resolvedMember = profile.rows[0].id;
            if (registrationTarget.target_client === 'operator') {
              const targetAccount = await database.query<{
                account_id: string; realm_id: string; credential_version: number;
              }>(`select account.id account_id,account.realm_id,account.credential_version
                from identity.account account join identity.credential credential
                  on credential.account_id=account.id and credential.realm_id=account.realm_id
                  and credential.provider='password' and credential.status='active'
                where account.realm_id=$1 and account.legacy_principal_id=$2 and account.status='active'
                for update of account,credential`, [operatorRealm!.realmId, resolvedPrincipal]);
              if (targetAccount.rows[0]) {
                resolvedAccount = targetAccount.rows[0].account_id;
                accountRealm = targetAccount.rows[0].realm_id;
                credentialVersion = targetAccount.rows[0].credential_version;
              } else {
                if (sourceAccount.secret_hash === null) throw new Error('CREDENTIAL_INVALID');
                accountRealm = operatorRealm!.realmId;
                resolvedAccount = account;
                credentialVersion = 1;
                await database.query(
                  `insert into identity.account(id,realm_id,legacy_principal_id,status,credential_version,assurance_level,
                    mobile_ciphertext,mobile_token,mobile_masked,phone_verified_at,created_at,updated_at)
                  values($1,$2,$3,'active',1,2,$4,$5,$6,clock_timestamp(),clock_timestamp(),clock_timestamp())`,
                  [resolvedAccount, accountRealm, resolvedPrincipal, mobile.ciphertext, mobile.fingerprint,
                    `${subject.slice(0, 3)}****${subject.slice(-4)}`]
                );
                await database.query(
                  `insert into identity.credential(id,principal_id,provider,subject_hash,secret_hash,status,created_at,realm_id,account_id)
                  values($1,$2,'password',$3,$4,'active',clock_timestamp(),$5,$6)`,
                  [credential, resolvedPrincipal, subjectHash, sourceAccount.secret_hash, accountRealm, resolvedAccount]
                );
                await database.query(
                  `insert into identity.assurance(id,principal_id,method,level,evidence_hash,verified_at,expires_at,realm_id,account_id)
                  values($1,$2,'phone_otp',2,$3,clock_timestamp(),clock_timestamp()+interval '365 days',$4,$5)`,
                  [assurance, resolvedPrincipal, subjectHash, accountRealm, resolvedAccount]
                );
              }
            }
            const current = registrationTarget.target_client === 'operator'
              ? await database.query<Record<string, unknown>>(
                  `select * from access.membership where member_id=$1 and organization_id=$2 and client='operator'
                    and realm_id=$3 and account_id=$4 and status<>'left'`,
                  [resolvedMember, operatorRealm!.membershipOrganizationId, accountRealm, resolvedAccount]
                )
              : await database.query<Record<string, unknown>>(
                  `select * from access.membership where member_id=$1 and organization_id=$2 and client='storefront'
                    and realm_id=$3 and account_id=$4`,
                  [resolvedMember, organization, accountRealm, resolvedAccount]
                );
            if (current.rows[0] && current.rows[0].status !== 'active') reject(403, 'MEMBERSHIP_INACTIVE');
            if (current.rows[0] && registrationTarget.target_client === 'operator') reject(409, 'IDENTITY_SUBJECT_EXISTS');
            result = current.rows[0] ?? (registrationTarget.target_client === 'operator'
              ? await accessPort.createOperatorRegistration(database, {
                  operatorMembership,
                  governanceParentMembership: registrationTarget.created_by,
                  member: resolvedMember,
                  principal: resolvedPrincipal,
                  realm: accountRealm,
                  account: resolvedAccount,
                  operatorOrganization: operatorRealm!.membershipOrganizationId,
                  managementOrganization: organization,
                  operatorRole: registrationTarget.role_id,
                  operatorDisplayName: operatorDisplayName!,
                  operatorScopes: [scopes[3], scopes[4]],
                })
              : await accessPort.createRegistration(database, {
                  membership,
                  member: resolvedMember,
                  principal: resolvedPrincipal,
                  organization,
                  realm: accountRealm,
                  account: resolvedAccount,
                  role: registrationTarget.role_id,
                  scopeKind,
                  scopes: [scopes[0], scopes[1], scopes[2]],
                }));
          } else {
            if (password === null) throw new Error('PASSWORD_POLICY_REJECTED');
            if (registrationTarget.target_client === 'storefront') {
              memberNodeRegistration = await requireValidInvite(memberPort.registerHostedMemberNode(database, {
                registration_id: registrationId,
                business_number: registrationBusinessNumber,
                idempotency_key: request.input.idempotency!,
                registration_origin: registration.kind === 'invite' ? 'invitation' : 'direct',
                registration_host_node_id: realm.nodeId,
                invitation_token_hash: registration.kind === 'invite' ? registrationHash : null,
                business_identity_hash: subjectHash,
                node_key: registrationNodeKey,
                realm_id: registrationRealm,
                membership_id: membership,
                requested_by: principal,
                trace_id: request.input.headers['x-request-id'] ?? `registration:${request.input.idempotency!}`,
              }));
              if (memberNodeRegistration.outcome === 'level_boundary') {
                return {
                  status: 409,
                  body: {
                    code: 'SFL_REGISTRATION_LEVEL_BOUNDARY',
                    outcome: memberNodeRegistration.outcome,
                    registration_id: memberNodeRegistration.registration_id,
                    business_number: memberNodeRegistration.business_number,
                    registration_origin: memberNodeRegistration.registration_origin,
                    registration_host_node_id: memberNodeRegistration.registration_host_node_id,
                    invitation_id: memberNodeRegistration.invitation_id,
                    inviter_node_id: memberNodeRegistration.inviter_node_id,
                    inviter_membership_id: memberNodeRegistration.inviter_membership_id,
                    line_id: memberNodeRegistration.line_id,
                    host_sovereign_node_id: memberNodeRegistration.host_sovereign_node_id,
                    request_hash: memberNodeRegistration.request_hash,
                    created_at: memberNodeRegistration.created_at,
                  },
                };
              }
              accountRealm = memberNodeRegistration.realm_id;
            }
            await database.query(`insert into identity.principal(id,status,created_at,updated_at) values($1,'active',clock_timestamp(),clock_timestamp())`, [principal]);
            await database.query(
              `insert into identity.account(id,realm_id,legacy_principal_id,status,credential_version,assurance_level,
                mobile_ciphertext,mobile_token,mobile_masked,phone_verified_at,created_at,updated_at)
              values($1,$2,$3,'active',1,$4,$5,$6,$7,$8,clock_timestamp(),clock_timestamp())`,
              [account, accountRealm, principal, deferredPhoneVerification ? 1 : 2, mobile.ciphertext, mobile.fingerprint,
                `${subject.slice(0, 3)}****${subject.slice(-4)}`, deferredPhoneVerification ? null : new Date()]
            );
            await database.query(
              `insert into identity.credential(id,principal_id,provider,subject_hash,secret_hash,status,created_at,realm_id,account_id)
            values($1,$2,'password',$3,$4,'active',clock_timestamp(),$5,$6)`,
              [credential, principal, subjectHash, password, accountRealm, account]
            );
            await memberPort.create(database, {
              member,
              principal,
              display: textField(body, 'displayName'),
              status: 'active',
              mobileCiphertext: mobile.ciphertext,
              mobileFingerprint: subjectHash,
              mobileMasked: `${subject.slice(0, 3)}****${subject.slice(-4)}`,
            });
            if (!deferredPhoneVerification) {
              await database.query(
                `insert into identity.assurance(id,principal_id,method,level,evidence_hash,verified_at,expires_at,realm_id,account_id)
                values($1,$2,'phone_otp',2,$3,clock_timestamp(),clock_timestamp()+interval '365 days',$4,$5)`,
                [assurance, principal, subjectHash, accountRealm, account]
              );
            }
            result = registrationTarget.target_client === 'operator'
              ? await accessPort.createOperatorRegistration(database, {
                  operatorMembership,
                  governanceParentMembership: registrationTarget.created_by,
                  member,
                  principal,
                  realm: accountRealm,
                  account,
                  operatorOrganization: operatorRealm!.membershipOrganizationId,
                  managementOrganization: organization,
                  operatorRole: registrationTarget.role_id,
                  operatorDisplayName: operatorDisplayName!,
                  operatorScopes: [scopes[3], scopes[4]],
                })
              : await accessPort.createRegistration(database, {
                  membership,
                  member,
                  principal,
                  organization,
                  realm: accountRealm,
                  account,
                  role: registrationTarget.role_id,
                  scopeKind,
                  scopes: [scopes[0], scopes[1], scopes[2]],
                });
          }
          const registeredMembership = String(result.id);
          const realmMemberships = [registeredMembership];
          const boundMemberships = await database.query<{ id: string }>(`select membership.id
            from access.membership membership join identity.realm realm
              on realm.id=membership.realm_id and realm.node_profile=membership.node_profile and realm.status='active'
            where membership.id=any($1::text[]) and membership.realm_id=$2 and membership.account_id=$3`,
            [realmMemberships, accountRealm, resolvedAccount]);
          if (boundMemberships.rows.length !== realmMemberships.length) throw new Error('MEMBERSHIP_REALM_BINDING_FAILED');
          const activeContext = await resolveActiveMembershipContext(
            database, realm.realmId, resolvedAccount, registeredMembership,
          );
          if (typeof body.wechatToken === 'string') {
            await bindWechat(database, tokenHash(body.wechatToken), resolvedPrincipal, registeredMembership, accountRealm, resolvedAccount);
          }
          await publishIdentityEvent(database, 'identity.member.registered', resolvedPrincipal, organization, request.input.idempotency!, {
            principal: resolvedPrincipal,
            account: resolvedAccount,
            realm: accountRealm,
            member: resolvedMember,
            membership: registeredMembership,
            ...(registrationTarget.target_client === 'operator' ? { operatorMembership } : {}),
            ...(registrationTarget.governance_level === null ? {} : { governanceLevel: registrationTarget.governance_level }),
          });
          const responseBody = {
            ...result,
            ...(memberNodeRegistration === null ? {} : memberNodeRegistration),
            active_context: activeContext,
            ...(registrationTarget.governance_level === null ? {} : { governanceLevel: registrationTarget.governance_level }),
          };
          if (authorization === null) return { status: 201, body: responseBody };
          const session = `session:${randomUUID()}`;
          const token = randomBytes(48).toString('base64url');
          const csrf = randomBytes(32).toString('base64url');
          const accessVersion = Number(result.access_version);
          if (!Number.isSafeInteger(accessVersion) || accessVersion < 1 || result.client !== 'storefront') throw new Error('MEMBERSHIP_INACTIVE');
          const sessionAssurance = deferredPhoneVerification ? 1 : 2;
          await database.query(
            `insert into identity.session(id,principal_id,membership_id,token_hash,credential_version,access_version,client,ip_hash,user_agent,device_label,
              assurance_level,realm_id,account_id,auth_target,expires_at,last_seen_at,created_at)
            values($1,$2,$3,$4,$5,$6,'storefront',$7,$8,$9,$10,$11,$12,$13,clock_timestamp()+interval '30 days',clock_timestamp(),clock_timestamp())`,
            [session, resolvedPrincipal, registeredMembership, tokenHash(token), credentialVersion, accessVersion,
              digest(request.input.headers['x-peer-address'] ?? 'unknown'), String(request.input.headers['user-agent'] ?? 'unknown').slice(0, 512),
              String(request.input.headers['x-device-id'] ?? 'browser').slice(0, 128), sessionAssurance,
              accountRealm, resolvedAccount, applicationReturnTarget ?? requestedReturnTarget!]
          );
          if (!deferredPhoneVerification) {
            await database.query(
              `insert into identity.assurance(id,principal_id,session_id,method,level,evidence_hash,verified_at,expires_at,realm_id,account_id)
              values($1,$2,$3,'phone_otp',2,$4,clock_timestamp(),clock_timestamp()+interval '12 hours',$5,$6)`,
              [`assurance:${randomUUID()}`, resolvedPrincipal, session, createHash('sha256').update(textField(body, 'challenge')).digest('hex'), accountRealm, resolvedAccount]
            );
          }
          const consumedIntent = loginIntent === undefined ? undefined : (await database.query<{
            login_intent_id: string;
            source_realm_id: string;
            source_node_id: string;
          }>('select * from identity.consume_login_intent($1,$2,$3,$4,$5,$6)', [
            tokenHash(loginIntent), realm.realmId, applicationReturnTarget ?? requestedReturnTarget!,
            registration.kind === 'storefront' ? registration.value : null, resolvedAccount, session,
          ])).rows[0];
          if (loginIntent !== undefined && consumedIntent === undefined) reject(403, 'LOGIN_INTENT_INVALID');
          await publishIdentityEvent(database, 'identity.session.created', session, registeredMembership, request.input.idempotency!, {
            principal: resolvedPrincipal,
            account: resolvedAccount,
            realm: accountRealm,
            entryRealm: realm.realmId,
            membership: registeredMembership,
            assurance: sessionAssurance,
            loginMethod: deferredPhoneVerification ? 'registration_password' : 'registration_otp',
            ...(consumedIntent === undefined ? {} : {
              loginIntent: consumedIntent.login_intent_id,
              sourceRealm: consumedIntent.source_realm_id,
              sourceNode: consumedIntent.source_node_id,
            }),
          });
          const callback = await tickets.issue(database, session, accountRealm, resolvedAccount,
            applicationReturnTarget ?? requestedReturnTarget!, authorization);
          return {
            status: 201,
            body: { ...responseBody, authentication: { session, csrf, expiresIn: SESSION_MAX_AGE_SECONDS, membership: registeredMembership, target: 'storefront', callback } },
            headers: sessionCookies(token, csrf, SESSION_MAX_AGE_SECONDS, 'storefront'),
          };
        }),
      }),
  };
}
