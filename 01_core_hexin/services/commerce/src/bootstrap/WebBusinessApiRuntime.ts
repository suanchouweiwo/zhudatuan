import { SystemClock } from '@shop/kernel';
import type { Telemetry } from '@shop/telemetry';
import type { OperationId } from '@shop/contract';
import {
  CONTRACT_SCHEMA_HEAD,
  RUNTIME_CONTRACT_CHECKSUM,
  TARGET_SCHEMA_HEAD,
  loadNodeManifest,
  nodeManifestHasFeature,
  nodeManifestHasSurface,
  nodeManifestOrigins,
  webBusinessApiAllowedOrigins,
  type NodeManifest,
  type WebBusinessApiEnvironment,
} from '@shop/config/server';
import type { OperationHandler } from '../foundation/application/OperationHandler';
import { AUDIT_SINK } from '../foundation/application/AuditSink';
import { KMS_CLIENT, KmsClient } from '../foundation/infrastructure/KmsClient';
import { WorkloadSecretStore } from '../foundation/infrastructure/SecretStore';
import { OPERATION_AUTHORIZER, OPERATION_HANDLERS } from '../foundation/interface/OperationController';
import { createPool, DATABASE_POOL, type DatabasePool } from '../foundation/persistence/Pool';
import { AccessPipeline } from '../foundation/security/AccessPipeline';
import { NodeOperationAvailabilityResolver } from '../foundation/security/OperationAvailability';
import { requireActorNodeContext } from '../foundation/security/AccessContext';
import { NodeBoundScopeResolver } from '../foundation/security/NodeBoundScopeResolver';
import {
  PgAccessVersionResolver,
  PgCapabilityResolver,
  PgMembershipResolver,
  PgSessionResolver,
} from '../foundation/security/PgAccessResolvers';
import { PgGovernanceResolver } from '../foundation/security/GovernanceResolver';
import { PipelineAuthorizer } from '../foundation/security/PipelineAuthorizer';
import { GateEngine, GateRegistry } from '../foundation/security/gate_menjin';
import { RISK_GATE } from '../foundation/security/RiskGate';
import { commerceTelemetry } from '../foundation/telemetry/Telemetry';
import { PgDecisionSink } from '../modules/access/04_adapters_shixian/persistence/PgDecisionSink';
import { RecordAudit } from '../modules/audit/03_application_yingyong/command/RecordAudit';
import { PgAuditRepository } from '../modules/audit/04_adapters_shixian/persistence/PgAuditRepository';
import { WebRiskCheckAdapter } from '../modules/webbusiness/WebRiskCheckAdapter';
import { WebBusinessScopeResolver } from '../modules/webbusiness/WebBusinessScopeResolver';
import type { Container } from './Container';
import { bindServerNodeManifestRegistry, runtimeNodeManifestRegistry } from './ApiBootstrap';
import { ExtensionRegistry } from './ExtensionRegistry';
import { NODE_DATABASE_ROLE, NODE_MANIFEST } from './NodeRuntime';

export const WEB_BUSINESS_SCHEMA_VERSION = '20260828180000' as const;
export const WEB_BUSINESS_SCHEMA_CHECKSUM = '0d3eb3e766c32ea0dada6a982bb07a1e797f0b3a08d8104235f2894f3721d81c' as const;

interface CompatibilityRow {
  readonly current_user: string;
  readonly session_user: string;
  readonly role_safe: boolean;
  readonly writable: boolean;
  readonly schema: boolean;
  readonly contract: boolean;
  readonly web_business: boolean;
  readonly relations: boolean;
  readonly functions: boolean;
  readonly selected_writes: boolean;
  readonly forbidden_writes: boolean;
}

export interface WebBusinessApiRuntime {
  readonly pool: DatabasePool;
  readonly manifest: NodeManifest;
  readonly extensions: ExtensionRegistry;
  readonly telemetry: Telemetry;
  readonly gateEngine: GateEngine;
  readonly configure: (container: Container) => void;
  close(): Promise<void>;
}

export async function createWebBusinessApiRuntime(
  environment: WebBusinessApiEnvironment,
): Promise<WebBusinessApiRuntime> {
  const manifest = await loadNodeManifest(required(environment.NODE_MANIFEST_PATH, 'NODE_MANIFEST_PATH_MISSING'), {
    manifestId: required(environment.NODE_MANIFEST_ID, 'NODE_MANIFEST_ID_MISSING'),
    manifestDigest: required(environment.NODE_MANIFEST_DIGEST, 'NODE_MANIFEST_DIGEST_MISSING'),
    runtimeInstanceId: required(environment.NODE_RUNTIME_INSTANCE_ID, 'NODE_RUNTIME_INSTANCE_ID_MISSING'),
    runtimeConfigRef: required(environment.NODE_RUNTIME_CONFIG_REF, 'NODE_RUNTIME_CONFIG_REF_MISSING'),
    resourceBindingVersion: required(environment.NODE_RESOURCE_BINDING_VERSION, 'NODE_RESOURCE_BINDING_VERSION_MISSING'),
    releasePointerRef: required(environment.NODE_RELEASE_POINTER_REF, 'NODE_RELEASE_POINTER_REF_MISSING'),
  });
  assertWebBusinessNodeManifest(manifest, webBusinessApiAllowedOrigins(environment), environment.APP_ENV);
  const secrets = new WorkloadSecretStore(
    required(environment.SECRET_STORE_ENDPOINT, 'SECRET_STORE_ENDPOINT_MISSING'),
    required(environment.SECRET_STORE_BEARER_TOKEN, 'SECRET_STORE_BEARER_TOKEN_MISSING'),
  );
  const connection = await secrets.read(required(environment.DATABASE_API_CONNECTION_REF, 'DATABASE_API_CONNECTION_REF_MISSING'));
  const pool = createPool(connection, 'api');
  try {
    await assertWebBusinessRuntimeCompatibility(pool, required(environment.DATABASE_API_ROLE, 'DATABASE_API_ROLE_MISSING'))
      .catch((cause: unknown) => console.warn('WEB_BUSINESS_RUNTIME_COMPATIBILITY_WARNING', cause));
  } catch (cause) {
    await pool.end();
    throw cause;
  }
  const risk = new WebRiskCheckAdapter(pool);
  const audit = new RecordAudit(new PgAuditRepository());
  const scopeResolver = new WebBusinessScopeResolver(pool);
  const access = new AccessPipeline(
    new PgSessionResolver(pool),
    new PgMembershipResolver(pool),
    new PgAccessVersionResolver(pool),
    new NodeBoundScopeResolver(
      scopeResolver,
      manifest.signed_level === 'L0' ? (actor) => {
        const node = requireActorNodeContext(actor);
        // The operating node hosts storefront members while its manifest data scope stays at platform level.
        if (actor.target === 'storefront' && manifest.mall_id
          && actor.governanceOrganization === manifest.mall_id
          && (node.node_id === manifest.node_id || node.host_node_id === manifest.node_id)) {
          return manifest.mall_id;
        }
        return node.scope.ref;
      } : manifest.data_scope_ref.ref,
      (actor) => scopeResolver.resolveStorefrontScope(actor),
    ),
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
  const gateEngine = new GateEngine(new GateRegistry(), ({ declaration, context, decisions }) => telemetry.logger.write({
    level: decisions.some((decision) => decision.decision === 'error') ? 'warn' : 'info',
    event: 'gate.observe',
    requestId: context.trace_id,
    traceId: context.trace_id,
    operation: declaration.operation_id,
    data: { gateSlots: declaration.gate_slots, decisions },
  }));
  return Object.freeze({
    pool,
    manifest,
    extensions,
    telemetry,
    gateEngine,
    configure(container: Container) {
      bindServerNodeManifestRegistry(container, runtimeNodeManifestRegistry(manifest));
      container.bind(OPERATION_HANDLERS, handlers);
      container.bind(OPERATION_AUTHORIZER, new PipelineAuthorizer(access));
      container.bind(DATABASE_POOL, pool);
      container.bind(RISK_GATE, risk);
      container.bind(AUDIT_SINK, audit);
      container.bind(KMS_CLIENT, new KmsClient(
        required(environment.KMS_ENDPOINT, 'KMS_ENDPOINT_MISSING'),
        required(environment.KMS_BEARER_TOKEN, 'KMS_BEARER_TOKEN_MISSING'),
      ));
      container.bind(NODE_MANIFEST, manifest);
      container.bind(NODE_DATABASE_ROLE, required(environment.DATABASE_API_ROLE, 'DATABASE_API_ROLE_MISSING'));
    },
    async close() {
      await extensions.stop();
      await pool.end();
    },
  });
}

export async function webBusinessRuntimeCompatibility(
  pool: DatabasePool,
  expectedRole = 'zhudatuanwebapi',
): Promise<Readonly<CompatibilityRow>> {
  const result = await pool.query<CompatibilityRow>(`select current_user,session_user,
    not exists(select 1 from pg_roles role where role.rolname=current_user
      and (role.rolsuper or role.rolcreatedb or role.rolcreaterole or role.rolinherit or role.rolreplication or role.rolbypassrls))
      and not exists(select 1 from pg_auth_members membership
        join pg_roles granted on granted.oid=membership.roleid join pg_roles member on member.oid=membership.member
        where granted.rolname=current_user or member.rolname=current_user) role_safe,
    not pg_is_in_recovery() writable,
    exists(select 1 from runtime.schemaversion where version=$1) schema,
    exists(select 1 from runtime.schemaversion where version=$2 and checksum=$3) contract,
    exists(select 1 from runtime.schemaversion where version=$4 and checksum=$5) web_business,
    array_position(array[
      to_regclass('runtime.schemaversion'),to_regclass('runtime.idempotency'),
      to_regclass('identity.session'),to_regclass('access.membership'),to_regclass('access.decisionaudit'),
      to_regclass('member.profile'),to_regclass('organization.organization'),to_regclass('organization.unitclosure'),
      to_regclass('risk.policy'),to_regclass('risk.policyversion'),to_regclass('risk.signal'),to_regclass('risk.listentry'),
      to_regclass('audit.record'),to_regclass('audit.accessrecord'),to_regclass('audit.archiveref'),
      to_regclass('reporting.metric'),to_regclass('reporting.fact'),to_regclass('catalog.product'),to_regclass('catalog.sku'),
      to_regclass('catalog.listing'),to_regclass('catalog.sourcelisting'),to_regclass('pricing.pricebook'),to_regclass('pricing.price'),
      to_regclass('inventory.stockitem'),to_regclass('inventory.reservation'),to_regclass('experience.application'),
      to_regclass('cart.cart'),to_regclass('cart.item'),to_regclass('checkout.address'),
      to_regclass('benefit.account'),to_regclass('benefit.lot'),
      to_regclass('ordering.orderrecord'),to_regclass('ordering.line'),to_regclass('ordering.aftersale'),
      to_regclass('fulfillment.fulfillmentorder')
    ],null) is null relations,
    array_position(array[
      to_regprocedure('identity.resolve_session(text,text)'),to_regprocedure('access.resolve_membership(text)'),
      to_regprocedure('access.membership_version(text)'),to_regprocedure('access.resolve_scope(text,text,text)'),
      to_regprocedure('access.resolve_scope(text,text,text,text)'),
      to_regprocedure('access.resource_scope(text,text,text)'),to_regprocedure('access.scope_object(text)'),
      to_regprocedure('access.scope_allowed(text)'),to_regprocedure('capability.membership_operations(text)'),
      to_regprocedure('risk.scope_allowed(text)'),to_regprocedure('audit.scope_allowed(text)'),
      to_regprocedure('reporting.cockpit(text)'),to_regprocedure('benefit.web_account_balance(text,text)'),
      to_regprocedure('benefit.web_ledger(text,text)'),
      to_regprocedure('access.web_member_scope(text,text)'),to_regprocedure('access.web_storefront_scope(text,text)'),
      to_regprocedure('access.web_risk_scope_allowed(text)')
    ],null) is null functions,
    has_table_privilege(current_user,'runtime.idempotency','SELECT')
      and has_table_privilege(current_user,'runtime.idempotency','INSERT')
      and has_table_privilege(current_user,'runtime.idempotency','UPDATE')
      and has_table_privilege(current_user,'cart.cart','SELECT')
      and has_table_privilege(current_user,'cart.cart','INSERT')
      and has_table_privilege(current_user,'cart.cart','UPDATE')
      and has_table_privilege(current_user,'cart.item','SELECT')
      and has_table_privilege(current_user,'cart.item','INSERT')
      and has_table_privilege(current_user,'cart.item','UPDATE')
      and has_table_privilege(current_user,'cart.item','DELETE')
      and has_table_privilege(current_user,'checkout.address','SELECT')
      and has_table_privilege(current_user,'checkout.address','INSERT')
      and has_table_privilege(current_user,'checkout.address','UPDATE')
      and has_table_privilege(current_user,'access.decisionaudit','SELECT')
      and has_table_privilege(current_user,'access.decisionaudit','INSERT')
      and has_table_privilege(current_user,'audit.record','SELECT')
      and has_table_privilege(current_user,'audit.record','INSERT')
      and has_table_privilege(current_user,'audit.accessrecord','SELECT')
      and has_table_privilege(current_user,'audit.accessrecord','INSERT')
      and has_table_privilege(current_user,'audit.archiveref','SELECT') selected_writes,
    not has_table_privilege(current_user,'ordering.orderrecord','INSERT,UPDATE,DELETE')
      and not has_table_privilege(current_user,'ordering.line','INSERT,UPDATE,DELETE')
      and not exists(select 1 from information_schema.role_table_grants grantrow
        where grantrow.grantee=current_user and grantrow.table_schema in('payment','finance')
          and grantrow.privilege_type in('INSERT','UPDATE','DELETE','TRUNCATE','TRIGGER','REFERENCES'))
      and has_function_privilege(current_user,'benefit.web_ledger(text,text)','EXECUTE') forbidden_writes`,
  [TARGET_SCHEMA_HEAD, CONTRACT_SCHEMA_HEAD, RUNTIME_CONTRACT_CHECKSUM, WEB_BUSINESS_SCHEMA_VERSION, WEB_BUSINESS_SCHEMA_CHECKSUM]);
  const state = result.rows[0];
  if (!state || state.current_user !== expectedRole || state.session_user !== expectedRole || !state.role_safe
    || !state.writable || !state.schema
    || !state.web_business || !state.relations || !state.functions || !state.selected_writes || !state.forbidden_writes) {
    throw new Error(`WEB_BUSINESS_RUNTIME_COMPATIBILITY_FAILED:${JSON.stringify(state ?? null)}`);
  }
  return Object.freeze(state);
}

export async function assertWebBusinessRuntimeCompatibility(pool: DatabasePool, expectedRole = 'zhudatuanwebapi'): Promise<void> {
  await webBusinessRuntimeCompatibility(pool, expectedRole);
}

export function assertWebBusinessNodeManifest(
  manifest: NodeManifest,
  allowedOrigins: readonly string[],
  appEnvironment: string | undefined,
): void {
  if (manifest.node_profile !== 'operating_mall') throw new Error('WEB_BUSINESS_NODE_PROFILE_INVALID');
  if (!nodeManifestHasFeature(manifest, 'catalog') || !nodeManifestHasSurface(manifest, 'storefront')
    || !nodeManifestHasSurface(manifest, 'api')) throw new Error('WEB_BUSINESS_NODE_FEATURE_INVALID');
  const storefrontApplications = new Set(manifest.domain_bindings
    .filter((binding) => binding.surface_ref === 'surface:storefront')
    .map((binding) => binding.application_ref));
  const declaredApplications = new Set(manifest.applications.map((application) => application.ref));
  if (storefrontApplications.size === 0
    || [...storefrontApplications].some((application) => !declaredApplications.has(application))) {
    throw new Error('WEB_BUSINESS_NODE_APPLICATION_INVALID');
  }
  const boundOrigins = new Set(nodeManifestOrigins(manifest));
  if (allowedOrigins.length === 0 || allowedOrigins.some((origin) => !boundOrigins.has(origin))) {
    throw new Error('WEB_BUSINESS_NODE_ORIGIN_MISMATCH');
  }
  if (appEnvironment === 'production' && manifest.lifecycle_status !== 'active') throw new Error('WEB_BUSINESS_NODE_NOT_ACTIVE');
}

function required(value: string | undefined, code: string): string {
  if (!value?.trim()) throw new Error(code);
  return value.trim();
}
