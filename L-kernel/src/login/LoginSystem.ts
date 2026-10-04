import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AuthTransaction } from './AuthTransaction.ts';
import type { AuthTarget } from './LoginTarget.ts';

// These ports bind the existing login transaction; they are not an HTTP contract.
export interface LoginRealm {
  readonly realmId: string;
  readonly target: AuthTarget;
  readonly surface: 'admin' | 'consumer';
  readonly membershipClient: string;
  readonly membershipOrganizationId: string;
  readonly application?: string;
}

export interface LoginAccount {
  readonly account_id: string;
  readonly realm_id: string;
  readonly principal_id: string;
  readonly credential_version: number;
}

export interface LoginMembership {
  readonly id: string;
  readonly access_version: number;
  readonly client: string;
  readonly organization_id: string;
}

interface SmsChallengeInput {
  readonly id: string;
  readonly codeHash: string;
  readonly destinationHash: string;
}

export interface LoginSessionRecord {
  readonly id: string;
  readonly account: LoginAccount;
  readonly membership: LoginMembership;
  readonly token: string;
  readonly ipHash: string;
  readonly userAgent: string;
  readonly deviceLabel: string;
  readonly assurance: number;
}

export interface LoginStore<ActiveContext extends Readonly<{ node_id: string }>> {
  passwordCredential(subjectHash: string, mobileTokens?: readonly string[]): Promise<(LoginAccount & { readonly secret_hash: string | null }) | undefined>;
  verifySmsChallenge(input: SmsChallengeInput): Promise<LoginAccount | undefined>;
  recordInvalidSmsChallenge(id: string, destinationHash: string): Promise<void>;
  membershipAccount(principalId: string): Promise<LoginAccount | undefined>;
  memberships(account: LoginAccount): Promise<readonly LoginMembership[]>;
  storefront(application: string): Promise<Readonly<{ application_slug: string; organization_id: string }>>;
  activeMembershipContext(accountId: string, membershipId: string): Promise<ActiveContext>;
  consumeSmsChallenge(input: SmsChallengeInput & Readonly<{ account: string; realmId: string }>): Promise<boolean>;
  createSession(input: LoginSessionRecord): Promise<void>;
  createSmsAssurance(input: Readonly<{ account: LoginAccount; sessionId: string; evidenceHash: string }>): Promise<void>;
  consumeLoginIntent(token: string, accountId: string, sessionId: string): Promise<Readonly<{
    login_intent_id: string; source_realm_id: string; source_node_id: string;
  }> | undefined>;
  publishSessionCreated(sessionId: string, membershipId: string, payload: Readonly<Record<string, unknown>>): Promise<void>;
}

export interface LoginProviders<ReturnTarget> {
  readonly passwords: Readonly<{ verify(password: string, encoded: string | null): Promise<boolean> }>;
  digest(value: string): string;
  codeDigest(challenge: string, code: string): string;
  issueTicket(sessionId: string, realmId: string, accountId: string, target: AuthTarget,
    authorization: AuthTransaction): Promise<Readonly<{ ticket: string; state: string }>>;
  consumeTicket(value: unknown, token: string, entryRealmId: string): Promise<Readonly<{
    returnTarget: ReturnTarget; sessionExpiresAt: Date;
  }>>;
}

export interface LoginInput {
  readonly realm: LoginRealm;
  readonly credential:
    | Readonly<{ provider: 'password'; password(): string }>
    | Readonly<{ provider: 'phone_otp'; challenge(): Readonly<{ id: string; code: string }> }>;
  readonly subjectHash: string;
  readonly mobileTokens?: readonly string[];
  readonly requestedMembership?: string;
  readonly authorization: AuthTransaction;
  readonly loginIntent?: string;
  readonly directExchange?: Readonly<{ nonce: string; verifier: string }>;
  readonly peerAddress: string;
  readonly userAgent: string;
  readonly deviceLabel: string;
}

export class LoginRejection extends Error {
  constructor(readonly status: number, code: string) { super(code); }
}

export class LoginSystem<ActiveContext extends Readonly<{ node_id: string }>, ReturnTarget> {
  constructor(private readonly store: LoginStore<ActiveContext>, private readonly providers: LoginProviders<ReturnTarget>) {}

  async createSession(input: LoginInput) {
    const { realm, credential, subjectHash } = input;
    const { passwords, codeDigest, digest } = this.providers;
    let found: LoginAccount | undefined;
    let challengeAccount: LoginAccount | undefined;
    let loginChallenge: string | undefined;
    let loginCode: string | undefined;
    if (credential.provider === 'password') {
      const credentialFound = await this.store.passwordCredential(subjectHash, input.mobileTokens);
      if (!(await passwords.verify(credential.password(), credentialFound?.secret_hash ?? null))) {
        throw new LoginRejection(401, 'CREDENTIAL_INVALID');
      }
      if (credentialFound) found = credentialFound;
    } else {
      const challenge = credential.challenge();
      loginChallenge = challenge.id;
      loginCode = challenge.code;
      challengeAccount = await this.store.verifySmsChallenge({
        id: loginChallenge, codeHash: codeDigest(loginChallenge, loginCode), destinationHash: subjectHash,
      });
      if (!challengeAccount) {
        await this.store.recordInvalidSmsChallenge(loginChallenge, subjectHash);
        throw new LoginRejection(401, 'CREDENTIAL_INVALID');
      }
      found = await this.store.membershipAccount(challengeAccount.principal_id);
    }
    if (!found) throw new LoginRejection(401, 'CREDENTIAL_INVALID');
    const memberships = await this.store.memberships(found);
    const candidates = memberships.filter((item) => item.client === realm.membershipClient
      && item.organization_id === realm.membershipOrganizationId);
    if (realm.surface === 'consumer') {
      const storefront = await this.store.storefront(realm.application!);
      if (storefront.application_slug !== realm.application
        || storefront.organization_id !== realm.membershipOrganizationId) throw new LoginRejection(400, 'AUTH_REALM_MISMATCH');
    }
    if (candidates.length === 0) throw new LoginRejection(403, 'REALM_MEMBERSHIP_NOT_FOUND');
    const requested = input.requestedMembership;
    const membership = requested ? candidates.find((item) => item.id === requested) : candidates.length === 1 ? candidates[0] : undefined;
    if (requested !== undefined && membership === undefined) throw new LoginRejection(403, 'MEMBERSHIP_INACTIVE');
    if (!membership) {
      return { kind: 'membership_selection' as const, principal: found.principal_id, memberships: candidates };
    }
    const activeContext = await this.store.activeMembershipContext(found.account_id, membership.id);
    if (credential.provider === 'phone_otp') {
      const consumed = await this.store.consumeSmsChallenge({
        id: loginChallenge!, codeHash: codeDigest(loginChallenge!, loginCode!),
        account: challengeAccount!.account_id, realmId: challengeAccount!.realm_id, destinationHash: subjectHash,
      });
      if (!consumed) throw new LoginRejection(401, 'CREDENTIAL_INVALID');
    }
    const token = randomBytes(48).toString('base64url');
    const id = `session:${randomUUID()}`;
    const assurance = credential.provider === 'phone_otp' ? 2 : 1;
    await this.store.createSession({ id, account: found, membership, token,
      ipHash: digest(input.peerAddress), userAgent: input.userAgent.slice(0, 512),
      deviceLabel: input.deviceLabel.slice(0, 128), assurance });
    if (credential.provider === 'phone_otp') {
      await this.store.createSmsAssurance({ account: found, sessionId: id,
        evidenceHash: createHash('sha256').update(loginChallenge!).digest('hex') });
    }
    const consumedIntent = input.loginIntent === undefined ? undefined
      : await this.store.consumeLoginIntent(input.loginIntent, found.account_id, id);
    if (input.loginIntent !== undefined && consumedIntent === undefined) throw new LoginRejection(403, 'LOGIN_INTENT_INVALID');
    await this.store.publishSessionCreated(id, membership.id, {
      principal: found.principal_id,
      account: found.account_id,
      membership: membership.id,
      realm: { entryRealmId: realm.realmId, currentRealmId: found.realm_id, nodeId: activeContext.node_id, surface: realm.surface },
      assurance,
      loginMethod: credential.provider,
      ...(consumedIntent === undefined ? {} : {
        loginIntent: consumedIntent.login_intent_id,
        sourceRealm: consumedIntent.source_realm_id,
        sourceNode: consumedIntent.source_node_id,
      }),
    });
    const csrf = randomBytes(32).toString('base64url');
    const callback = await this.providers.issueTicket(id, found.realm_id, found.account_id, realm.target, input.authorization);
    const direct = input.directExchange === undefined ? undefined
      : await this.providers.consumeTicket({ ...input.directExchange, ...callback }, token, realm.realmId);
    return { kind: 'session_created' as const, id, token, csrf, membership, target: realm.target, callback, activeContext, direct };
  }
}
