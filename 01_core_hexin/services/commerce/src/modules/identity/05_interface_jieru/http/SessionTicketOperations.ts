import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { OperationId } from '@shop/contract';
import { operationLifecycle, pageResult, reject, requireAccess, type OperationActions } from '../../../../foundation/application/ModuleOperations';
import { bodyRecord, secretField, textField } from '../../../../foundation/interface/Validation';
import { requireAccessNodeContext, requireGovernanceContext } from '../../../../foundation/security/AccessContext';
import { LoginRejection, LoginSystem, sessionExpiresIn } from '@shop/l-kernel/login';
import { AuthTransaction } from '../../02_domain_yewu/models_moxing/AuthTransaction';
import { publishIdentityEvent, tokenHash } from '../../04_adapters_shixian/persistence_cunchu/IdentityPersistence';
import { authMembershipTarget, authTarget, SESSION_MAX_AGE_SECONDS, sessionCookies } from './IdentitySecurity';
import { requestCsrfCookie, requestSessionCookieCandidates } from '../../../../foundation/security/AuthSessionCookies';
import { memberPort } from '../../../member';
import { canonicalIdentitySubject, canonicalMobile } from '../../02_domain_yewu/models_moxing/IdentitySubject';
import { PgLoginStore } from '../../04_adapters_shixian/persistence_cunchu/PgLoginStore';
import { currentRealmAccount, resolveActiveMembershipContext, resolveRealmContext, resolveRealmNode } from '../../03_application_yingyong/services_fuwu/RealmAccount';
import type { RealmOperationContext } from './RealmOperationContext';

export const SESSION_TICKET_OPERATION_IDS = Object.freeze([
  'identity.sessions.create',
  'identity.loginintents.create',
  'identity.tickets.exchange',
  'identity.session.read',
  'identity.session.delete',
  'identity.sessions.read',
  'identity.sessions.revoke',
] as const satisfies readonly OperationId[]);

export function sessionTicketOperations(runtime: RealmOperationContext): OperationActions {
  const { codeDigest, digest, kms, passwords, tickets } = runtime;
  return {
      'identity.sessions.create': operationLifecycle({
        prepare: async (request) => {
          const body = bodyRecord(request);
          const requestedTarget = authTarget(textField(body, 'target', 32));
          const application = body.application === undefined ? undefined : textField(body, 'application', 48);
          const loginIntent = body.loginIntent === undefined ? undefined : secretField(body, 'loginIntent', 128);
          if (loginIntent !== undefined && !/^[A-Za-z0-9_-]{64}$/.test(loginIntent)) throw new Error('LOGIN_INTENT_INVALID');
          const authorization = AuthTransaction.start(body.authorization);
          const directExchange = directExchangeSecret(body.exchange);
          const provider = body.provider === undefined ? 'password' : textField(body, 'provider', 32);
          if (provider !== 'password' && provider !== 'phone_otp') throw new Error('CREDENTIAL_PROVIDER_INVALID');
          const normalizedSubject = provider === 'phone_otp'
            ? canonicalMobile(textField(body, 'subject', 32))
            : canonicalIdentitySubject(textField(body, 'subject'));
          const subject = digest(normalizedSubject);
          const passwordMobile = provider === 'password' && /^\+[1-9][0-9]{7,14}$/.test(normalizedSubject)
            ? normalizedSubject
            : undefined;
          const mobileTokens = passwordMobile === undefined
            ? undefined
            : kms.encrypt('identity/mobile', passwordMobile, { purpose: 'password_login' })
                .then((mobileLookup) => [subject, mobileLookup.fingerprint,
                  createHash('sha256').update(passwordMobile).digest('hex')]);
          return {
            body,
            provider,
            authorization,
            host: request.input.headers.host,
            requestedTarget,
            application,
            loginIntent,
            directExchange,
            subject,
            mobileTokens,
          };
        },
        execute: async (request, database, { body, provider, authorization, host, requestedTarget, application, loginIntent, directExchange, subject, mobileTokens }) => {
          const [realm, resolvedMobileTokens] = await Promise.all([
            resolveRealmContext(database, host, requestedTarget, application),
            mobileTokens,
          ]);
          const login = new LoginSystem(new PgLoginStore(database, realm, request.input.idempotency!), {
            passwords, digest, codeDigest,
            issueTicket: (sessionId, realmId, accountId, target: typeof realm.target, transaction) =>
              tickets.issue(database, sessionId, realmId, accountId, target, transaction),
            consumeTicket: (value, token, entryRealmId) => tickets.consume(database, value, token, entryRealmId),
          });
          const result = await login.createSession({
            realm,
            credential: provider === 'password'
              ? { provider, password: () => secretField(body, 'password', 128) }
              : { provider: 'phone_otp', challenge: () => ({
                  id: textField(body, 'challenge', 128), code: textField(body, 'code', 16),
                }) },
            subjectHash: subject,
            ...(resolvedMobileTokens === undefined ? {} : { mobileTokens: resolvedMobileTokens }),
            ...(typeof body.membership === 'string' ? { requestedMembership: body.membership } : {}),
            authorization,
            ...(loginIntent === undefined ? {} : { loginIntent }),
            ...(directExchange === undefined ? {} : { directExchange }),
            peerAddress: request.input.headers['x-peer-address'] ?? 'unknown',
            userAgent: String(request.input.headers['user-agent'] ?? 'unknown'),
            deviceLabel: String(request.input.headers['x-device-id'] ?? 'browser'),
          }).catch((cause: unknown) => {
            if (cause instanceof LoginRejection) reject(cause.status, cause.message);
            throw cause;
          });
          if (result.kind === 'membership_selection') {
            return { status: 200, body: { principal: result.principal,
              memberships: result.memberships.map(({ id, client }) => ({ id, client: authTarget(client) })) } };
          }
          const target = authMembershipTarget(result.target);
          const directExpiresIn = result.direct === undefined
            ? undefined
            : sessionExpiresIn(result.direct.sessionExpiresAt);
          return { status: 201, body: { session: result.id, csrf: result.csrf, expiresIn: SESSION_MAX_AGE_SECONDS,
            membership: result.membership.id, target, callback: result.callback, active_context: result.activeContext,
            ...(result.direct === undefined ? {} : { exchange: { returnTarget: result.direct.returnTarget, expiresIn: directExpiresIn } }) },
          headers: sessionCookies(result.token, result.csrf, SESSION_MAX_AGE_SECONDS, target) };
        },
      }),
      'identity.loginintents.create': async (request, database) => {
        const access = requireAccess(request);
        const sourceNode = requireAccessNodeContext(access);
        if (!access.actor.account || !access.actor.realm) throw new Error('AUTH_REALM_CONTEXT_MISSING');
        const body = bodyRecord(request);
        const targetNodeId = textField(body, 'targetNodeId', 96);
        if (!/^node:[a-z0-9][a-z0-9-]{0,62}:l[0-9]{1,3}$/.test(targetNodeId)) {
          throw new Error('LOGIN_INTENT_TARGET_NODE_INVALID');
        }
        const targetSurface = textField(body, 'targetSurface', 16);
        if (targetSurface !== 'admin' && targetSurface !== 'consumer') throw new Error('LOGIN_INTENT_TARGET_SURFACE_INVALID');
        const targetApplication = body.targetApplication === undefined
          ? undefined
          : textField(body, 'targetApplication', 48);
        if ((targetSurface === 'consumer') !== (targetApplication !== undefined)) {
          throw new Error('LOGIN_INTENT_TARGET_APPLICATION_INVALID');
        }
        if (targetNodeId === sourceNode.node_id) throw new Error('LOGIN_INTENT_CROSS_NODE_REQUIRED');
        const token = randomBytes(48).toString('base64url');
        const id = `loginintent:${randomUUID()}`;
        const issued = (await database.query<{
          target_realm_id: string;
          target_accounts_host: string;
          target_target: string;
          target_application: string | null;
          target_return_origin: string;
        }>('select * from identity.issue_login_intent($1,$2,$3,$4,$5,$6,$7,$8)', [
          id, tokenHash(token), access.actor.session, access.actor.account, access.actor.realm,
          targetNodeId, targetSurface, targetApplication ?? null,
        ])).rows[0];
        if (issued === undefined) reject(403, 'LOGIN_INTENT_TARGET_INVALID');
        const loginUrl = new URL(`https://${issued.target_accounts_host}`);
        loginUrl.searchParams.set('target', issued.target_target);
        if (targetSurface === 'consumer') loginUrl.searchParams.set('surface', 'web');
        if (issued.target_application !== null) loginUrl.searchParams.set('application', issued.target_application);
        loginUrl.searchParams.set('login_intent', token);
        return {
          status: 201,
          body: {
            loginIntent: id,
            sourceNode: sourceNode.node_id,
            targetNode: targetNodeId,
            targetRealm: issued.target_realm_id,
            targetSurface,
            returnOrigin: issued.target_return_origin,
            loginUrl: loginUrl.toString(),
            expiresIn: 300,
          },
        };
      },
      'identity.tickets.exchange': async (request, database) => {
        const currentTokens = requestSessionCookieCandidates(request.input.headers.cookie);
        if (currentTokens.length === 0) reject(401, 'AUTHENTICATION_REQUIRED');
        const realm = await resolveRealmNode(database, request.input.headers.host);
        const exchanged = await tickets.consume(database, request.input.body, currentTokens, realm.realmId);
        const expiresIn = sessionExpiresIn(exchanged.sessionExpiresAt);
        return {
          status: 200,
          body: { returnTarget: exchanged.returnTarget, expiresIn },
        };
      },
      'identity.session.read': async (request, database) => {
        const access = requireAccess(request);
        const governance = requireGovernanceContext(access);
        const permissions = [...new Set(access.membership.grants.flatMap((grant) => grant.permissions).filter((permission) => !access.membership.denies.includes(permission)))].sort();
        const scopes = [...new Map(access.membership.grants.map((grant) => [grant.scope.id, grant.scope] as const)).values()];
        const csrf = requestCsrfCookie(request.input.headers, access.actor.target);
        const realmAccount = access.actor.account !== undefined && access.actor.realm !== undefined
          ? { accountId: access.actor.account, realmId: access.actor.realm }
          : await currentRealmAccount(database, access.membership.id, access.actor.id);
        const entryRealmId = access.actor.nodeContext?.manifest.realm_ref.ref ?? realmAccount.realmId;
        const [activeContext, security] = await Promise.all([
          resolveActiveMembershipContext(database, entryRealmId, realmAccount.accountId, access.membership.id,
            { resolverKnownAvailable: true }),
          memberPort.sessionSecurityProjection(database, realmAccount.accountId, realmAccount.realmId, access.actor.id),
        ]);
        if (security === null) reject(403, 'REALM_ACCOUNT_INACTIVE');
        return {
          status: 200,
          body: {
            actor: access.actor.id,
            session: access.actor.session,
            membership: access.membership.id,
            active_context: activeContext,
            scope: access.scope,
            scopes,
            accessVersion: access.accessVersion,
            permissions,
            capabilities: access.capabilities,
            assurance: access.assurance,
            target: access.actor.target,
            governance: {
              level: governance.governanceLevel,
              exactOwner: governance.isExactOwner,
              organization: governance.organizationId,
            },
            ...(security.displayName === null ? {} : {
              profile: { display_name: security.displayName, employee_no: null },
            }),
            security: { hasLocalCredential: security.hasLocalCredential, phoneMasked: security.phoneMasked,
              passwordChangedAt: security.passwordChangedAt?.toISOString() ?? null },
            syncedAt: new Date().toISOString(),
            ...(csrf === undefined ? {} : { csrf }),
          },
        };
      },
      'identity.session.delete': async (request, database) => {
        const access = requireAccess(request);
        const account = await currentRealmAccount(database, access.membership.id, access.actor.id);
        const result = await database.query(`update identity.session set revoked_at=clock_timestamp(),revoked_reason='logout'
          where id=$1 and account_id=$2 and realm_id=$3 and revoked_at is null returning id,revoked_at`,
        [access.actor.session, account.accountId, account.realmId]);
        const sessions = result.rows.length === 0 ? [] : [access.actor.session];
        await publishIdentityEvent(database, 'identity.session.revoked', access.actor.session, access.membership.id, request.input.idempotency!, { sessions, reason: 'logout' });
        return {
          status: 200,
          body: { target: access.actor.session, revoked: sessions.length, sessions },
          headers: sessionCookies('', '', 0, access.actor.target),
        };
      },
      'identity.sessions.read': async (request, database) => {
        const access = requireAccess(request);
        const account = await currentRealmAccount(database, access.membership.id, access.actor.id);
        const result = await database.query(
          `select id,membership_id as membership,client,device_label as "deviceLabel",user_agent as "userAgent",
        assurance_level as assurance,created_at as "createdAt",last_seen_at as "lastSeenAt",expires_at as "expiresAt",id=$3 as current
        from identity.session where account_id=$1 and realm_id=$2 and revoked_at is null and expires_at>clock_timestamp()
        order by (id=$3) desc,last_seen_at desc,id limit 100`,
          [account.accountId, account.realmId, access.actor.session]
        );
        return pageResult(result);
      },
      'identity.sessions.revoke': async (request, database) => {
        const access = requireAccess(request);
        const account = await currentRealmAccount(database, access.membership.id, access.actor.id);
        const session = request.input.path.sessionid;
        if (!session) reject(404, 'RESOURCE_NOT_FOUND');
        const result =
          session === 'others'
            ? await database.query<{ id: string }>(
                `update identity.session set revoked_at=clock_timestamp(),revoked_reason='security_center'
            where account_id=$1 and realm_id=$2 and id<>$3 and revoked_at is null returning id`,
                [account.accountId, account.realmId, access.actor.session]
              )
            : await database.query<{ id: string }>(
                `update identity.session set revoked_at=clock_timestamp(),revoked_reason='security_center'
            where account_id=$1 and realm_id=$2 and id=$3 and revoked_at is null returning id`,
                [account.accountId, account.realmId, session]
              );
        if (session !== 'others' && result.rowCount === 0) {
          const owned = await database.query<{ revoked_at: Date | null }>(
            'select revoked_at from identity.session where account_id=$1 and realm_id=$2 and id=$3',
            [account.accountId, account.realmId, session]);
          if (!owned.rows[0]) reject(404, 'RESOURCE_NOT_FOUND');
        }
        const sessions = result.rows.map(({ id }) => id);
        if (sessions.length > 0) await publishIdentityEvent(database, 'identity.session.revoked', session, access.membership.id, request.input.idempotency!, { sessions, reason: 'security_center' });
        const response = { status: 200, body: { target: session, revoked: sessions.length, sessions } } as const;
        return session === access.actor.session ? { ...response, headers: sessionCookies('', '', 0, access.actor.target) } : response;
      },
  };
}

function directExchangeSecret(value: unknown): Readonly<{ nonce: string; verifier: string }> | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('AUTH_EXCHANGE_INVALID');
  const exchange = value as Readonly<Record<string, unknown>>;
  return Object.freeze({
    nonce: secretField(exchange, 'nonce', 128),
    verifier: secretField(exchange, 'verifier', 128),
  });
}
