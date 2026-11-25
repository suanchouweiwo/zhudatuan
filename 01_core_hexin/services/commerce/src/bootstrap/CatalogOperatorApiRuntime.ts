import { SystemClock } from '@shop/kernel';
import type { Telemetry } from '@shop/telemetry';
import type { OperationId } from '@shop/contract';
import {
  CONTRACT_SCHEMA_HEAD,
  RUNTIME_CONTRACT_CHECKSUM,
  TARGET_SCHEMA_HEAD,
  catalogOperatorApiAllowedOrigins,
  loadNodeManifest,
  nodeManifestHasFeature,
  nodeManifestHasSurface,
  nodeManifestOrigins,
  type CatalogOperatorApiEnvironment,
  type NodeManifest,
} from '@shop/config/server';
import type { OperationHandler } from '../foundation/application/OperationHandler';
import { AUDIT_SINK } from '../foundation/application/AuditSink';
import { HttpObjectStore, OBJECT_STORE } from '../foundation/infrastructure/ObjectStore';
import { SECRET_STORE, WorkloadSecretStore } from '../foundation/infrastructure/SecretStore';
import { OPERATION_AUTHORIZER, OPERATION_HANDLERS } from '../foundation/interface/OperationController';
import { createPool, DATABASE_POOL, type DatabasePool } from '../foundation/persistence/Pool';
import { AccessPipeline } from '../foundation/security/AccessPipeline';
import { NodeOperationAvailabilityResolver } from '../foundation/security/OperationAvailability';
import { requireActorNodeContext } from '../foundation/security/AccessContext';
import { NodeBoundScopeResolver } from '../foundation/security/NodeBoundScopeResolver';
import { PgAccessVersionResolver, PgCapabilityResolver, PgMembershipResolver, PgScopeResolver, PgSessionResolver } from '../foundation/security/PgAccessResolvers';
import { PgGovernanceResolver } from '../foundation/security/GovernanceResolver';
import { PipelineAuthorizer } from '../foundation/security/PipelineAuthorizer';
import { RISK_GATE } from '../foundation/security/RiskGate';
import { PgDecisionSink } from '../modules/access/04_adapters_shixian/persistence/PgDecisionSink';
import { RecordAudit } from '../modules/audit/03_application_yingyong/command/RecordAudit';
import { PgAuditRepository } from '../modules/audit/04_adapters_shixian/persistence/PgAuditRepository';
import { RiskCheckAdapter } from '../modules/risk';
import { commerceTelemetry } from '../foundation/telemetry/Telemetry';
import type { Container } from './Container';
import { bindServerNodeManifestRegistry, runtimeNodeManifestRegistry } from './ApiBootstrap';
import { ExtensionRegistry } from './ExtensionRegistry';
import { NODE_DATABASE_ROLE, NODE_MANIFEST } from './NodeRuntime';

interface CompatibilityRow {
  readonly current_user: string;
  readonly writable: boolean;
  readonly schema: boolean;
  readonly contract: boolean;
  readonly relations: boolean;
  readonly functions: boolean;
  readonly writes: boolean;
}

export interface CatalogOperatorApiRuntime {
  readonly pool: DatabasePool;
  readonly manifest: NodeManifest;
  readonly extensions: ExtensionRegistry;
  readonly telemetry: Telemetry;
  readonly configure: (container: Container) => void;
  close(): Promise<void>;
}

export function bindCatalogOperatorNodeManifest(container: Container, manifest: NodeManifest): void {
  bindServerNodeManifestRegistry(container, runtimeNodeManifestRegistry(manifest));
}

export async function createCatalogOperatorApiRuntime(
  environment: CatalogOperatorApiEnvironment,
): Promise<CatalogOperatorApiRuntime> {
  const manifest = await loadNodeManifest(required(environment.NODE_MANIFEST_PATH, 'NODE_MANIFEST_PATH_MISSING'), {
    manifestId: required(environment.NODE_MANIFEST_ID, 'NODE_MANIFEST_ID_MISSING'),
    manifestDigest: required(environment.NODE_MANIFEST_DIGEST, 'NODE_MANIFEST_DIGEST_MISSING'),
    runtimeInstanceId: required(environment.NODE_RUNTIME_INSTANCE_ID, 'NODE_RUNTIME_INSTANCE_ID_MISSING'),
    runtimeConfigRef: required(environment.NODE_RUNTIME_CONFIG_REF, 'NODE_RUNTIME_CONFIG_REF_MISSING'),
    resourceBindingVersion: required(environment.NODE_RESOURCE_BINDING_VERSION, 'NODE_RESOURCE_BINDING_VERSION_MISSING'),
    releasePointerRef: required(environment.NODE_RELEASE_POINTER_REF, 'NODE_RELEASE_POINTER_REF_MISSING'),
  });
  assertCatalogNodeManifest(manifest, catalogOperatorApiAllowedOrigins(environment), environment.APP_ENV);
  const secrets = new WorkloadSecretStore(
    required(environment.SECRET_STORE_ENDPOINT, 'SECRET_STORE_ENDPOINT_MISSING'),
    required(environment.SECRET_STORE_BEARER_TOKEN, 'SECRET_STORE_BEARER_TOKEN_MISSING'),
  );
  const connection = await secrets.read(required(environment.DATABASE_API_CONNECTION_REF, 'DATABASE_API_CONNECTION_REF_MISSING'));
  const pool = createPool(connection, 'api');
  const objects = new HttpObjectStore(
    required(environment.OBJECT_STORE_ENDPOINT, 'OBJECT_STORE_ENDPOINT_MISSING'),
    required(environment.OBJECT_STORE_BEARER_TOKEN, 'OBJECT_STORE_BEARER_TOKEN_MISSING'),
  );
  try {
    await catalogOperatorRuntimeCompatibility(pool, required(environment.DATABASE_API_ROLE, 'DATABASE_API_ROLE_MISSING'));
    await objects.find('catalog/readiness-probe');
  } catch (cause) {
    await pool.end();
    throw cause;
  }
  const risk = new RiskCheckAdapter(pool);
  const audit = new RecordAudit(new PgAuditRepository());
  const access = new AccessPipeline(
    new PgSessionResolver(pool),
    new PgMembershipResolver(pool),
    new PgAccessVersionResolver(pool),
    new NodeBoundScopeResolver(new PgScopeResolver(pool),
      manifest.signed_level === 'L0' ? (actor, scope) => {
        const node = requireActorNodeContext(actor);
        // The L0 manifest identifies both the platform data scope and its own storefront mall.
        if (actor.target === 'console' && scope.kind === 'mall' && scope.id === node.mall_id) return scope.id;
        return node.scope.ref;
      } : manifest.data_scope_ref.ref),
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
    configure(container: Container) {
      bindCatalogOperatorNodeManifest(container, manifest);
      container.bind(OPERATION_HANDLERS, handlers);
      container.bind(OPERATION_AUTHORIZER, new PipelineAuthorizer(access));
      container.bind(DATABASE_POOL, pool);
      container.bind(RISK_GATE, risk);
      container.bind(AUDIT_SINK, audit);
      container.bind(SECRET_STORE, secrets);
      container.bind(OBJECT_STORE, objects);
      container.bind(NODE_MANIFEST, manifest);
      container.bind(NODE_DATABASE_ROLE, required(environment.DATABASE_API_ROLE, 'DATABASE_API_ROLE_MISSING'));
    },
    async close() {
      await extensions.stop();
      await pool.end();
    },
  });
}

export function assertCatalogNodeManifest(
  manifest: NodeManifest,
  allowedOrigins: readonly string[],
  appEnvironment: string | undefined,
): void {
  if (manifest.node_profile !== 'operating_mall') throw new Error('CATALOG_NODE_PROFILE_INVALID');
  if (!nodeManifestHasFeature(manifest, 'catalog')) throw new Error('CATALOG_NODE_FEATURE_DISABLED');
  if (!nodeManifestHasSurface(manifest, 'console') || !nodeManifestHasSurface(manifest, 'api')) {
    throw new Error('CATALOG_NODE_SURFACE_MISSING');
  }
  const consoleOrigin = nodeManifestOrigins(manifest, 'console')[0];
  if (!consoleOrigin || allowedOrigins.length !== 1 || allowedOrigins[0] !== consoleOrigin) {
    throw new Error('CATALOG_NODE_ORIGIN_MISMATCH');
  }
  if (appEnvironment === 'production' && manifest.lifecycle_status !== 'active') throw new Error('CATALOG_NODE_NOT_ACTIVE');
}

export async function catalogOperatorRuntimeCompatibility(
  pool: DatabasePool,
  expectedRole: string,
): Promise<Readonly<CompatibilityRow>> {
  const result = await pool.query<CompatibilityRow>(`select current_user,
    not pg_is_in_recovery() writable,
    exists(select 1 from runtime.schemaversion where version=$1) schema,
    exists(select 1 from runtime.schemaversion where version=$2 and checksum=$3) contract,
    array_position(array[
      to_regclass('runtime.idempotency'),to_regclass('runtime.job'),to_regclass('catalog.importjob'),
      to_regclass('catalog.importrow'),to_regclass('catalog.importerror'),to_regclass('catalog.listing'),
      to_regclass('audit.record'),to_regclass('audit.accessrecord')
    ],null) is null relations,
    to_regprocedure('access.resolve_scope(text,text,text,text)') is not null functions,
    has_table_privilege(current_user,'catalog.importjob','SELECT')
      and has_table_privilege(current_user,'catalog.importjob','INSERT')
      and has_table_privilege(current_user,'catalog.importjob','UPDATE')
      and has_table_privilege(current_user,'catalog.importrow','SELECT')
      and has_table_privilege(current_user,'catalog.importerror','SELECT')
      and has_table_privilege(current_user,'catalog.listing','SELECT')
      and has_table_privilege(current_user,'catalog.listing','UPDATE')
      and has_table_privilege(current_user,'runtime.job','INSERT') writes`,
  [TARGET_SCHEMA_HEAD, CONTRACT_SCHEMA_HEAD, RUNTIME_CONTRACT_CHECKSUM]);
  const state = result.rows[0];
  if (!state || state.current_user !== expectedRole || !state.writable || !state.schema
    || !state.relations || !state.functions || !state.writes) {
    throw new Error(`CATALOG_OPERATOR_RUNTIME_COMPATIBILITY_FAILED:${JSON.stringify(state ?? null)}`);
  }
  return Object.freeze(state);
}

function required(value: string | undefined, code: string): string {
  if (!value?.trim()) throw new Error(code);
  return value.trim();
}
