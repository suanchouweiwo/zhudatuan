import { SystemClock } from '@shop/kernel';
import type { Telemetry } from '@shop/telemetry';
import type { OperationId } from '@shop/contract';
import type { IdentityNodeDefinition } from '@shop/sdk/identity-node';
import {
  CONTRACT_SCHEMA_HEAD,
  RUNTIME_CONTRACT_CHECKSUM,
  TARGET_SCHEMA_HEAD,
  WechatApplicationCatalog,
  identityRegistrationWechatEnabled,
  loadNodeManifest,
  nodeManifestHasFeature,
  nodeManifestHasSurface,
  type IdentityRegistrationApiEnvironment,
  type NodeManifest,
} from '@shop/config/server';
import type { OperationHandler } from '../foundation/application/OperationHandler';
import { AUDIT_SINK } from '../foundation/application/AuditSink';
import { KMS_CLIENT, KmsClient } from '../foundation/infrastructure/KmsClient';
import { HttpObjectStore, OBJECT_STORE } from '../foundation/infrastructure/ObjectStore';
import { IDENTITY_SECURITY_KEYS, SECRET_STORE, WorkloadSecretStore } from '../foundation/infrastructure/SecretStore';
import { OPERATION_AUTHORIZER, OPERATION_HANDLERS } from '../foundation/interface/OperationController';
import { createPool, DATABASE_POOL, type DatabasePool } from '../foundation/persistence/Pool';
import { AccessPipeline } from '../foundation/security/AccessPipeline';
import { NodeOperationAvailabilityResolver } from '../foundation/security/OperationAvailability';
import { PgAccessVersionResolver, PgCapabilityResolver, PgMembershipResolver, PgScopeResolver, PgSessionResolver } from '../foundation/security/PgAccessResolvers';
import { PgGovernanceResolver } from '../foundation/security/GovernanceResolver';
import { PipelineAuthorizer } from '../foundation/security/PipelineAuthorizer';
import { RISK_GATE } from '../foundation/security/RiskGate';
import { PgDecisionSink } from '../modules/access/04_adapters_shixian/persistence/PgDecisionSink';
import { AUDIT_PORT } from '../modules/audit/01_public_gongkai/AuditPort';
import { RecordAudit } from '../modules/audit/03_application_yingyong/command/RecordAudit';
import { PgAuditRepository } from '../modules/audit/04_adapters_shixian/persistence/PgAuditRepository';
import { RiskCheckAdapter } from '../modules/risk';
import { WECHAT_IDENTITY } from '../modules/identity/01_public_gongkai/ports_jiekou/WechatIdentity';
import { WechatIdentityGateway, type WechatIdentityConfiguration } from '../modules/identity/04_adapters_shixian/providers_waibu/WechatIdentityGateway';
import { commerceTelemetry } from '../foundation/telemetry/Telemetry';
import type { Container } from './Container';
import { bindServerNodeManifestRegistry, runtimeNodeManifestRegistry } from './ApiBootstrap';
import { ExtensionRegistry } from './ExtensionRegistry';
import { assertIdentityNodeManifestRuntime, loadIdentityNodeRuntimeDefinition } from './IdentityNodeManifestRuntime';
import { NODE_DATABASE_ROLE, NODE_MANIFEST } from './NodeRuntime';

interface CompatibilityRow {
  readonly current_user: string;
  readonly writable: boolean;
  readonly schema: boolean;
  readonly contract: boolean;
  readonly registration: boolean;
  readonly operator_invitation: boolean;
  readonly relations: boolean;
  readonly functions: boolean;
}

export interface IdentityRegistrationApiRuntime {
  readonly pool: DatabasePool;
  readonly manifest: NodeManifest;
  readonly extensions: ExtensionRegistry;
  readonly telemetry: Telemetry;
  readonly wechatIdentityEnabled: boolean;
  readonly configure: (container: Container) => void;
  close(): Promise<void>;
}

export async function createIdentityRegistrationApiRuntime(
  environment: IdentityRegistrationApiEnvironment,
): Promise<IdentityRegistrationApiRuntime> {
  const manifest = await loadNodeManifest(required(environment.NODE_MANIFEST_PATH, 'NODE_MANIFEST_PATH_MISSING'), {
    manifestId: required(environment.NODE_MANIFEST_ID, 'NODE_MANIFEST_ID_MISSING'),
    manifestDigest: required(environment.NODE_MANIFEST_DIGEST, 'NODE_MANIFEST_DIGEST_MISSING'),
    runtimeInstanceId: required(environment.NODE_RUNTIME_INSTANCE_ID, 'NODE_RUNTIME_INSTANCE_ID_MISSING'),
    runtimeConfigRef: required(environment.NODE_RUNTIME_CONFIG_REF, 'NODE_RUNTIME_CONFIG_REF_MISSING'),
    resourceBindingVersion: required(environment.NODE_RESOURCE_BINDING_VERSION, 'NODE_RESOURCE_BINDING_VERSION_MISSING'),
    releasePointerRef: required(environment.NODE_RELEASE_POINTER_REF, 'NODE_RELEASE_POINTER_REF_MISSING'),
  });
  assertIdentityRegistrationNodeManifest(manifest, environment);
  const identityNode = await loadIdentityNodeRuntimeDefinition(environment.NODE_IDENTITY_RUNTIME_PATH, manifest);
  const secrets = new WorkloadSecretStore(
    required(environment.SECRET_STORE_ENDPOINT, 'SECRET_STORE_ENDPOINT_MISSING'),
    required(environment.SECRET_STORE_BEARER_TOKEN, 'SECRET_STORE_BEARER_TOKEN_MISSING'),
  );
  const [connection, sessionKey, identityKey] = await Promise.all([
    secrets.read(required(environment.DATABASE_API_CONNECTION_REF, 'DATABASE_API_CONNECTION_REF_MISSING')),
    secrets.read(required(environment.SESSION_KEY_REF, 'SESSION_KEY_REF_MISSING')),
    secrets.read(required(environment.IDENTITY_KEY_REF, 'IDENTITY_KEY_REF_MISSING')),
  ]);
  const wechatIdentityEnabled = identityRegistrationWechatEnabled(environment);
  const wechatSources = wechatIdentityEnabled ? await Promise.all([
    secrets.read(required(environment.WECHAT_APPLICATION_CONFIG_REF, 'WECHAT_APPLICATION_CONFIG_REF_MISSING')),
    secrets.read(required(environment.WECHAT_IDENTITY_CONFIG_REF, 'WECHAT_IDENTITY_CONFIG_REF_MISSING')),
  ]) : null;
  const wechatIdentity = wechatSources === null ? null : new WechatIdentityGateway(
    WechatApplicationCatalog.parse(parseSecret(wechatSources[0], 'WECHAT_APPLICATION_CONFIG_INVALID')),
    parseSecret(wechatSources[1], 'WECHAT_IDENTITY_CONFIG_INVALID') as unknown as WechatIdentityConfiguration,
  );
  const pool = createPool(connection, 'api');
  const objects = new HttpObjectStore(
    required(environment.OBJECT_STORE_ENDPOINT, 'OBJECT_STORE_ENDPOINT_MISSING'),
    required(environment.OBJECT_STORE_BEARER_TOKEN, 'OBJECT_STORE_BEARER_TOKEN_MISSING'),
  );
  const databaseRole = required(environment.DATABASE_API_ROLE, 'DATABASE_API_ROLE_MISSING');
  try {
    await assertIdentityRegistrationRuntimeCompatibility(pool, databaseRole, manifest, identityNode);
    await objects.find('catalog/readiness-probe');
  } catch (cause) {
    await pool.end();
    throw cause;
  }
  const risk = new RiskCheckAdapter(pool);
  const auditRepository = new PgAuditRepository();
  const audit = new RecordAudit(auditRepository);
  const access = new AccessPipeline(
    new PgSessionResolver(pool),
    new PgMembershipResolver(pool),
    new PgAccessVersionResolver(pool),
    new PgScopeResolver(pool),
    new PgCapabilityResolver(pool),
    new NodeOperationAvailabilityResolver(),
    new SystemClock(),
    risk,
    new PgDecisionSink(pool),
    undefined,
    undefined,
    new PgGovernanceResolver(pool),
  );
  const handlers = new Map<OperationId, OperationHandler>();
  const extensions = new ExtensionRegistry({ verify: async () => false });
  const telemetry = commerceTelemetry();
  return Object.freeze({
    pool,
    manifest,
    extensions,
    telemetry,
    wechatIdentityEnabled,
    configure(container: Container) {
      bindServerNodeManifestRegistry(container, runtimeNodeManifestRegistry(manifest));
      container.bind(OPERATION_HANDLERS, handlers);
      container.bind(OPERATION_AUTHORIZER, new PipelineAuthorizer(access));
      container.bind(DATABASE_POOL, pool);
      container.bind(RISK_GATE, risk);
      container.bind(AUDIT_SINK, audit);
      container.bind(AUDIT_PORT, auditRepository);
      container.bind(SECRET_STORE, secrets);
      container.bind(IDENTITY_SECURITY_KEYS, Object.freeze({ session: sessionKey, identity: identityKey }));
      container.bind(KMS_CLIENT, new KmsClient(
        required(environment.KMS_ENDPOINT, 'KMS_ENDPOINT_MISSING'),
        required(environment.KMS_BEARER_TOKEN, 'KMS_BEARER_TOKEN_MISSING'),
      ));
      container.bind(OBJECT_STORE, objects);
      if (wechatIdentity !== null) container.bind(WECHAT_IDENTITY, wechatIdentity);
      container.bind(NODE_MANIFEST, manifest);
      container.bind(NODE_DATABASE_ROLE, databaseRole);
    },
    async close() {
      await extensions.stop();
      await pool.end();
    },
  });
}

export async function identityRegistrationRuntimeCompatibility(
  pool: DatabasePool,
  expectedRole = 'zhudatuanidentityapi',
): Promise<Readonly<CompatibilityRow>> {
  const result = await pool.query<CompatibilityRow>(`select current_user,
    not pg_is_in_recovery() writable,
    exists(select 1 from runtime.schemaversion where version=$1) schema,
    exists(select 1 from runtime.schemaversion where version=$2 and checksum=$3) contract,
    exists(select 1 from runtime.schemaversion where version='20260828170000'
      and checksum='5cf87482ba3d0db32500809d28a77973ac285657aeb9c14612ba3dc525a2965e') registration,
    exists(select 1 from runtime.schemaversion where version='20260829060000'
      and checksum='b1e238eb8de569b0de9d1d2766620e1f661268d2f9260e646208d4f24715b37a') operator_invitation,
    array_position(array[
      to_regprocedure('access.resolve_scope(text,text,text,text)'),
      to_regprocedure('identity.resolve_storefront_member_context(text,text)'),
      to_regprocedure('access.resolve_session_membership(text,text,text,text)'),
      to_regprocedure('access.session_membership_version(text,text,text,text)'),
      to_regprocedure('access.resolve_session_scope(text,text,text,text,text,text,text)'),
      to_regprocedure('capability.session_membership_operations(text,text,text,text)')
    ],null) is null functions,
    array_position(array[
      to_regclass('runtime.idempotency'),to_regclass('runtime.job'),to_regclass('runtime.outbox'),
      to_regclass('identity.principal'),to_regclass('identity.credential'),to_regclass('identity.session'),
      to_regclass('identity.authticket'),to_regclass('identity.challenge'),to_regclass('identity.challengesecret'),
      to_regclass('identity.registrationpolicy'),to_regclass('member.invite'),to_regclass('member.profile'),
      to_regclass('access.membership'),to_regclass('access.membershiprole'),to_regclass('access.scopegrant'),
      to_regclass('organization.organization'),to_regclass('audit.record'),to_regclass('audit.accessrecord')
    ],null) is null relations`,
  [TARGET_SCHEMA_HEAD, CONTRACT_SCHEMA_HEAD, RUNTIME_CONTRACT_CHECKSUM]);
  const state = result.rows[0];
  if (!state || state.current_user !== expectedRole || !state.writable || !state.schema
    || !state.registration || !state.operator_invitation
    || !state.relations || !state.functions) {
    throw new Error(`IDENTITY_REGISTRATION_RUNTIME_COMPATIBILITY_FAILED:${JSON.stringify(state ?? null)}`);
  }
  return Object.freeze(state);
}

export async function assertIdentityRegistrationRuntimeCompatibility(
  pool: DatabasePool,
  expectedRole = 'zhudatuanidentityapi',
  manifest?: NodeManifest,
  identityNode?: IdentityNodeDefinition,
): Promise<void> {
  await identityRegistrationRuntimeCompatibility(pool, expectedRole);
  await assertIdentityNodeManifestRuntime(pool, manifest, identityNode);
}

export function assertIdentityRegistrationNodeManifest(
  manifest: NodeManifest,
  environment: IdentityRegistrationApiEnvironment,
): void {
  if (manifest.node_profile !== 'operating_mall') throw new Error('IDENTITY_NODE_PROFILE_INVALID');
  if (!nodeManifestHasFeature(manifest, 'identity') || !nodeManifestHasSurface(manifest, 'identity')
    || !nodeManifestHasSurface(manifest, 'api')) throw new Error('IDENTITY_NODE_FEATURE_INVALID');
  const expectedOrigins = manifest.domain_bindings
    .filter((binding) => binding.surface_ref !== 'surface:api')
    .map((binding) => `https://${binding.host}`)
    .sort();
  const actualOrigins = required(environment.API_ALLOWED_ORIGINS, 'API_ALLOWED_ORIGINS_MISSING')
    .split(',').map((origin) => origin.trim()).filter(Boolean).sort();
  if (expectedOrigins.join(',') !== actualOrigins.join(',')) throw new Error('IDENTITY_NODE_ORIGIN_MISMATCH');
  const references = [
    environment.DATABASE_API_CONNECTION_REF,
    environment.SESSION_KEY_REF,
    environment.IDENTITY_KEY_REF,
  ];
  if (identityRegistrationWechatEnabled(environment)) references.push(
    environment.WECHAT_APPLICATION_CONFIG_REF,
    environment.WECHAT_IDENTITY_CONFIG_REF,
  );
  assertSecretReferences(manifest, references);
  if (environment.APP_ENV === 'production' && manifest.lifecycle_status !== 'active') throw new Error('IDENTITY_NODE_NOT_ACTIVE');
}

function assertSecretReferences(manifest: NodeManifest, references: readonly (string | undefined)[]): void {
  const binding = manifest.secret_binding_set_ref.ref;
  const prefix = binding.endsWith('/secrets') ? binding.slice(0, -'secrets'.length) : `${binding}/`;
  if (references.some((reference) => !reference?.startsWith(prefix))) throw new Error('IDENTITY_NODE_SECRET_BINDING_MISMATCH');
}

function required(value: string | undefined, code: string): string {
  if (!value?.trim()) throw new Error(code);
  return value.trim();
}

function parseSecret(value: string, code: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error(code); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(code);
  return parsed as Record<string, unknown>;
}
