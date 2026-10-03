import { COMMERCE_EVENTS, OperationCatalog } from '@shop/contract';
import { CONTRACT_SCHEMA_HEAD, RUNTIME_CONTRACT_CHECKSUM, TARGET_SCHEMA_HEAD } from '@shop/config/server';
import { JOB_CATALOG } from '../app/jobs';
import type { CacheState } from '../foundation/cache/Cache';
import type { DatabasePool } from '../foundation/persistence/Pool';
import type { ExtensionRegistry } from './ExtensionRegistry';

interface DatabaseCompatibility {
  readonly writable: boolean;
  readonly schema: boolean;
  readonly contract: boolean;
  readonly scope_resolver: boolean;
  readonly operations: number;
  readonly capabilities: number;
  readonly events: number;
}

export interface RuntimeCompatibilityState {
  readonly healthy: boolean;
  readonly contract: Readonly<{ checksum: string; matches: boolean }>;
  readonly schema: Readonly<{ version: string; matches: boolean }>;
  readonly registries: Readonly<{ operations: number; events: number; jobs: number }>;
  readonly cache: CacheState;
  readonly database: DatabaseCompatibility;
  readonly extensions: Awaited<ReturnType<ExtensionRegistry['healthAll']>>;
}

export async function runtimeCompatibility(pool: DatabasePool, extensions: ExtensionRegistry, workload: 'api' | 'jobs' = 'api',
  cache: CacheState = Object.freeze({ available: false, reason: 'CACHE_STATE_UNAVAILABLE' })): Promise<RuntimeCompatibilityState> {
  const statement = 'select not pg_is_in_recovery() writable,'
    + 'exists(select 1 from runtime.schemaversion where version=$1) schema,'
    + 'exists(select 1 from runtime.schemaversion where version=$2 and checksum=$3) contract,'
    + "to_regprocedure('access.resolve_scope(text,text,text,text)') is not null scope_resolver,"
    + '(select count(*)::integer from runtime.operation) operations,'
    + '(select count(*)::integer from capability.operation) capabilities,'
    + '(select count(*)::integer from runtime.event) events';
  const client = await pool.connect();
  let result;
  try {
    await client.query('begin');
    await client.query("select set_config('app.workload',$1,true)", [workload]);
    result = await client.query<DatabaseCompatibility>(statement, [TARGET_SCHEMA_HEAD, CONTRACT_SCHEMA_HEAD, RUNTIME_CONTRACT_CHECKSUM]);
    await client.query('commit');
  } catch (cause) {
    await client.query('rollback').catch(() => undefined);
    throw cause;
  } finally {
    client.release();
  }
  const database = result.rows[0]!;
  const health = await extensions.healthAll();
  const registries = Object.freeze({
    operations: OperationCatalog.all().length,
    events: COMMERCE_EVENTS.length,
    jobs: JOB_CATALOG.length,
  });
  const healthy = database.writable
    && database.schema
    && database.scope_resolver
    && (workload !== 'jobs' || cache.available)
    && health.every(({ state }) => state === 'healthy');
  return Object.freeze({
    healthy,
    contract: Object.freeze({ checksum: RUNTIME_CONTRACT_CHECKSUM, matches: database.contract }),
    schema: Object.freeze({ version: TARGET_SCHEMA_HEAD, matches: database.schema }),
    registries,
    cache: Object.freeze({ ...cache }),
    database,
    extensions: health,
  });
}

export async function assertRuntimeCompatibility(pool: DatabasePool, extensions: ExtensionRegistry, workload: 'api' | 'jobs',
  cache?: CacheState): Promise<RuntimeCompatibilityState> {
  const state = await runtimeCompatibility(pool, extensions, workload, cache);
  if (!state.healthy) throw new Error('RUNTIME_COMPATIBILITY_FAILED:' + JSON.stringify(state));
  return state;
}
