import { SystemClock } from '@shop/kernel';
import type { Telemetry } from '@shop/telemetry';
import type { OperationId } from '@shop/contract';
import {
  CONTRACT_SCHEMA_HEAD,
  RUNTIME_CONTRACT_CHECKSUM,
  TARGET_SCHEMA_HEAD,
  type MallProvisioningApiEnvironment,
} from '@shop/config/server';
import type { OperationHandler } from '../foundation/application/OperationHandler';
import { AUDIT_SINK } from '../foundation/application/AuditSink';
import { WorkloadSecretStore } from '../foundation/infrastructure/SecretStore';
import { OPERATION_AUTHORIZER, OPERATION_HANDLERS } from '../foundation/interface/OperationController';
import { createPool, DATABASE_POOL, type DatabasePool } from '../foundation/persistence/Pool';
import { AccessPipeline } from '../foundation/security/AccessPipeline';
import { NodeOperationAvailabilityResolver } from '../foundation/security/OperationAvailability';
import {
  PgAccessVersionResolver,
  PgCapabilityResolver,
  PgMembershipResolver,
  PgScopeResolver,
  PgSessionResolver,
} from '../foundation/security/PgAccessResolvers';
import { PgGovernanceResolver } from '../foundation/security/GovernanceResolver';
import { PipelineAuthorizer } from '../foundation/security/PipelineAuthorizer';
import { DECISION_SINK } from '../foundation/security/DecisionSink';
import { RISK_GATE } from '../foundation/security/RiskGate';
import { commerceTelemetry } from '../foundation/telemetry/Telemetry';
import { PgDecisionSink } from '../modules/access/04_adapters_shixian/persistence/PgDecisionSink';
import { RecordAudit } from '../modules/audit/03_application_yingyong/command/RecordAudit';
import { PgAuditRepository } from '../modules/audit/04_adapters_shixian/persistence/PgAuditRepository';
import { RiskCheckAdapter } from '../modules/risk';
import type { Container } from './Container';
import { bindServerNodeManifestRegistry } from './ApiBootstrap';
import { ExtensionRegistry } from './ExtensionRegistry';
import { AUTONODE_CONTROL_CLIENT, AutoNodeControlClient } from '../modules/provisioning/04_adapters_shixian/AutoNodeControlClient';

export const MALL_PROVISIONING_SCHEMA_VERSION = '20260914090000' as const;
export const MALL_PROVISIONING_SCHEMA_CHECKSUM = '241214fa70737025d993740f79c59bca7867d6f4540da0041c863b0d45916594' as const;

interface CompatibilityRow {
  readonly current_user: string;
  readonly session_user: string;
  readonly role_safe: boolean;
  readonly writable: boolean;
  readonly schema: boolean;
  readonly contract: boolean;
  readonly provisioning: boolean;
  readonly relations: boolean;
  readonly functions: boolean;
  readonly selected_writes: boolean;
  readonly forbidden_privileges: boolean;
}

export interface MallProvisioningApiRuntime {
  readonly pool: DatabasePool;
  readonly extensions: ExtensionRegistry;
  readonly telemetry: Telemetry;
  readonly configure: (container: Container) => void;
  close(): Promise<void>;
}

export async function createMallProvisioningApiRuntime(
  environment: MallProvisioningApiEnvironment,
): Promise<MallProvisioningApiRuntime> {
  const secrets = new WorkloadSecretStore(
    required(environment.SECRET_STORE_ENDPOINT, 'SECRET_STORE_ENDPOINT_MISSING'),
    required(environment.SECRET_STORE_BEARER_TOKEN, 'SECRET_STORE_BEARER_TOKEN_MISSING'),
  );
  const connection = await secrets.read(
    required(environment.DATABASE_API_CONNECTION_REF, 'DATABASE_API_CONNECTION_REF_MISSING'),
  );
  const pool = createPool(connection, 'api');
  try {
    await assertMallProvisioningRuntimeCompatibility(pool);
  } catch (cause) {
    await pool.end();
    throw cause;
  }
  const risk = new RiskCheckAdapter(pool);
  const decisions = new PgDecisionSink(pool);
  const audit = new RecordAudit(new PgAuditRepository());
  const access = new AccessPipeline(
    new PgSessionResolver(pool),
    new PgMembershipResolver(pool),
    new PgAccessVersionResolver(pool),
    new PgScopeResolver(pool),
    new PgCapabilityResolver(pool),
    new NodeOperationAvailabilityResolver(),
    new SystemClock(),
    risk,
    decisions,
    undefined,
    undefined,
    new PgGovernanceResolver(pool),
  );
  const handlers = new Map<OperationId, OperationHandler>();
  const extensions = new ExtensionRegistry({ verify: async () => false });
  const telemetry = commerceTelemetry();
  return Object.freeze({
    pool,
    extensions,
    telemetry,
    configure(container: Container) {
      bindServerNodeManifestRegistry(container);
      container.bind(OPERATION_HANDLERS, handlers);
      container.bind(OPERATION_AUTHORIZER, new PipelineAuthorizer(access));
      container.bind(DATABASE_POOL, pool);
      container.bind(RISK_GATE, risk);
      container.bind(DECISION_SINK, decisions);
      container.bind(AUDIT_SINK, audit);
      container.bind(AUTONODE_CONTROL_CLIENT, new AutoNodeControlClient(
        required(environment.SERVICE_VERSION, 'SERVICE_VERSION_MISSING'),
        environment.AUTONODE_CONTROL_ENDPOINT,
        undefined,
        environment.AUTONODE_BASE_DOMAIN,
      ));
    },
    async close() {
      await extensions.stop();
      await pool.end();
    },
  });
}

export async function mallProvisioningRuntimeCompatibility(
  pool: DatabasePool,
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
    exists(select 1 from runtime.schemaversion where version=$4 and checksum=$5) provisioning,
    array_position(array[
      to_regclass('runtime.schemaversion'),to_regclass('runtime.idempotency'),to_regclass('runtime.outbox'),
      to_regclass('access.decisionaudit'),to_regclass('risk.policy'),to_regclass('risk.policyversion'),
      to_regclass('risk.signal'),to_regclass('risk.listentry'),to_regclass('risk.decision'),to_regclass('risk.case'),
      to_regclass('audit.record'),to_regclass('audit.accessrecord'),to_regclass('audit.archiveref'),
      to_regclass('access.mallowner'),
      to_regclass('organization.organization'),to_regclass('organization.unitclosure'),to_regclass('organization.sourcebinding'),
      to_regclass('catalog.pool'),to_regclass('catalog.poolbinding'),to_regclass('experience.application'),
      to_regclass('experience.version'),to_regclass('experience.binding')
    ],null) is null relations,
    array_position(array[
      to_regprocedure('identity.resolve_session(text,text)'),to_regprocedure('access.resolve_membership(text)'),
      to_regprocedure('access.membership_version(text)'),to_regprocedure('access.resolve_scope(text,text,text,text)'),
      to_regprocedure('capability.membership_operations(text)'),
      to_regprocedure('access.provision_mall_owner(text,text,text,text,text,text)'),
      to_regprocedure('access.read_provisioned_mall(text)')
    ],null) is null
      and has_function_privilege(current_user,'identity.resolve_session(text,text)','EXECUTE')
      and has_function_privilege(current_user,'access.resolve_membership(text)','EXECUTE')
      and has_function_privilege(current_user,'access.membership_version(text)','EXECUTE')
      and has_function_privilege(current_user,'access.resolve_scope(text,text,text,text)','EXECUTE')
      and has_function_privilege(current_user,'capability.membership_operations(text)','EXECUTE')
      and has_function_privilege(current_user,'access.provision_mall_owner(text,text,text,text,text,text)','EXECUTE')
      and has_function_privilege(current_user,'access.read_provisioned_mall(text)','EXECUTE') functions,
    has_table_privilege(current_user,'runtime.schemaversion','SELECT')
      and has_table_privilege(current_user,'runtime.idempotency','SELECT,INSERT,UPDATE')
      and has_table_privilege(current_user,'runtime.outbox','INSERT')
      and has_table_privilege(current_user,'access.decisionaudit','SELECT,INSERT')
      and has_table_privilege(current_user,'risk.policy','SELECT')
      and has_table_privilege(current_user,'risk.policyversion','SELECT')
      and has_table_privilege(current_user,'risk.signal','SELECT')
      and has_table_privilege(current_user,'risk.listentry','SELECT')
      and has_table_privilege(current_user,'risk.decision','SELECT,INSERT')
      and has_table_privilege(current_user,'risk.case','INSERT')
      and has_table_privilege(current_user,'audit.record','SELECT,INSERT')
      and has_table_privilege(current_user,'audit.accessrecord','SELECT')
      and has_table_privilege(current_user,'audit.archiveref','SELECT')
      and has_table_privilege(current_user,'organization.organization','SELECT,INSERT')
      and has_table_privilege(current_user,'organization.unitclosure','SELECT,INSERT')
      and has_table_privilege(current_user,'organization.sourcebinding','SELECT,INSERT')
      and has_table_privilege(current_user,'catalog.pool','INSERT')
      and has_table_privilege(current_user,'catalog.poolbinding','INSERT')
      and has_table_privilege(current_user,'experience.application','SELECT,INSERT')
      and has_column_privilege(current_user,'experience.application','head_version_id','UPDATE')
      and has_column_privilege(current_user,'experience.application','updated_at','UPDATE')
      and has_table_privilege(current_user,'experience.version','INSERT')
      and has_table_privilege(current_user,'experience.binding','INSERT') selected_writes,
    not has_table_privilege(current_user,'identity.session','SELECT,INSERT,UPDATE,DELETE')
      and not has_table_privilege(current_user,'access.membership','SELECT,INSERT,UPDATE,DELETE')
      and not has_table_privilege(current_user,'access.mallowner','SELECT,INSERT,UPDATE,DELETE')
      and not has_table_privilege(current_user,'organization.organization','UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      and not has_table_privilege(current_user,'organization.unitclosure','UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      and not has_table_privilege(current_user,'organization.sourcebinding','UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      and not has_table_privilege(current_user,'catalog.pool','SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      and not has_table_privilege(current_user,'catalog.poolbinding','SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      and not has_table_privilege(current_user,'experience.application','UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      and not has_column_privilege(current_user,'experience.application','scope_id','UPDATE')
      and not has_column_privilege(current_user,'experience.application','code','UPDATE')
      and not has_column_privilege(current_user,'experience.application','public_slug','UPDATE')
      and not has_table_privilege(current_user,'experience.version','SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      and not has_table_privilege(current_user,'experience.binding','SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      and not has_schema_privilege(current_user,'ordering','USAGE')
      and not has_schema_privilege(current_user,'inventory','USAGE')
      and not has_schema_privilege(current_user,'payment','USAGE')
      and not has_schema_privilege(current_user,'finance','USAGE') forbidden_privileges`,
  [TARGET_SCHEMA_HEAD, CONTRACT_SCHEMA_HEAD, RUNTIME_CONTRACT_CHECKSUM,
    MALL_PROVISIONING_SCHEMA_VERSION, MALL_PROVISIONING_SCHEMA_CHECKSUM]);
  const state = result.rows[0];
  if (!state || state.current_user !== 'zhudatuanprovisioningapi'
    || state.session_user !== 'zhudatuanprovisioningapi' || !state.role_safe || !state.writable
    || !state.schema || !state.provisioning || !state.relations || !state.functions
    || !state.selected_writes || !state.forbidden_privileges) {
    throw new Error(`MALL_PROVISIONING_RUNTIME_COMPATIBILITY_FAILED:${JSON.stringify(state ?? null)}`);
  }
  return Object.freeze(state);
}

export async function assertMallProvisioningRuntimeCompatibility(pool: DatabasePool): Promise<void> {
  await mallProvisioningRuntimeCompatibility(pool);
}

function required(value: string | undefined, code: string): string {
  if (!value?.trim()) throw new Error(code);
  return value.trim();
}
