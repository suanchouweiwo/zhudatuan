import { Pool } from 'pg';
import type { WorkerEnv } from './types';

const pools = new Map<string, Pool>();

export function isPostgresConfigured(env: WorkerEnv): boolean {
  return Boolean(env.DATABASE_URL);
}

// Compatibility callers execute database functions locally; no hosted RPC or external auth.
export async function callRpc<T>(env: WorkerEnv, functionName: string, parameters: Record<string, unknown> = {}): Promise<T> {
  const connectionString = env.DATABASE_URL;
  if (!connectionString) throw new Error('POSTGRES_NOT_CONFIGURED');
  let pool = pools.get(connectionString);
  if (!pool) {
    pool = new Pool({ connectionString, max: 4 });
    pools.set(connectionString, pool);
  }
  const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
  const entries = Object.entries(parameters);
  const signature = await pool.query<{ proretset: boolean; typtype: string; typname: string }>(
    `select p.proretset,t.typtype,t.typname from pg_proc p
      join pg_namespace n on n.oid=p.pronamespace join pg_type t on t.oid=p.prorettype
      where n.nspname='public' and p.proname=$1
        and $2::text[] <@ coalesce(p.proargnames, array[]::text[])
        and p.pronargs-p.pronargdefaults <= $3 and p.pronargs >= $3`,
    [functionName, entries.map(([key]) => key), entries.length],
  );
  const shape = signature.rows[0];
  if (!shape) throw new Error(`POSTGRES_FUNCTION_NOT_AVAILABLE:${functionName}`);
  const args = entries.map(([key], index) => `${quote(key)} => $${index + 1}`).join(',');
  const result = await pool.query(`select * from public.${quote(functionName)}(${args})`, entries.map(([, value]) => value));
  if (shape.typname === 'void') return undefined as T;
  const rows = shape.typtype === 'c' || shape.typname === 'record'
    ? result.rows
    : result.rows.map(row => Object.values(row)[0]);
  return (shape.proretset ? rows : rows[0]) as T;
}
