import type { IdentityDisplayHint } from '@shop/contract';
import type { OperationDatabase } from '../../foundation/application/ModuleOperations';
import { allocateIdentityCodes, identityCodeCandidate, type IdentityCode, type IdentityCodeKind } from './IdentityCode';

interface IdentityDisplaySource {
  readonly membershipId: string;
  readonly maskedMobile?: string | null;
}

interface StoredCode {
  readonly membership_id: string;
  readonly code: IdentityCode;
}

export async function presentIdentityDisplays(
  database: OperationDatabase,
  contextId: string,
  kind: IdentityCodeKind,
  sources: readonly IdentityDisplaySource[],
): Promise<ReadonlyMap<string, IdentityDisplayHint>> {
  if (sources.length === 0) return new Map();
  return optionalProjection<ReadonlyMap<string, IdentityDisplayHint>>(
    database, new Map(), () => assignDisplays(database, contextId, kind, sources));
}

export async function resolveIdentityDisplayMembership(
  database: OperationDatabase,
  contextId: string,
  kind: IdentityCodeKind,
  code: string,
): Promise<string | undefined> {
  if (!/^(?:OP-[2-9A-HJKMNP-Z]{4}|MB-[2-9A-HJKMNP-Z]{6})$/i.test(code)) return undefined;
  return optionalProjection(database, undefined, async () => {
    if (!await identityDisplayRepositoryAvailable(database)) return undefined;
    const result = await database.query<{ readonly membership_id: string }>(`select membership_id
      from identity_display.code_mapping where context_id=$1 and kind=$2 and code=$3`,
    [contextId, kind, code.toUpperCase()]);
    return result.rows[0]?.membership_id;
  });
}

async function optionalProjection<T>(database: OperationDatabase, fallback: T, action: () => Promise<T>): Promise<T> {
  try {
    await database.query('savepoint identity_display_projection');
  } catch (error) {
    if ((error as { readonly code?: unknown })?.code !== '25P01') throw error;
    try {
      return await action();
    } catch {
      return fallback;
    }
  }
  let result: T;
  try {
    result = await action();
  } catch {
    await database.query('rollback to savepoint identity_display_projection');
    await database.query('release savepoint identity_display_projection');
    return fallback;
  }
  await database.query('release savepoint identity_display_projection');
  return result;
}

async function assignDisplays(
  database: OperationDatabase,
  contextId: string,
  kind: IdentityCodeKind,
  sources: readonly IdentityDisplaySource[],
): Promise<ReadonlyMap<string, IdentityDisplayHint>> {
  if (!await identityDisplayRepositoryAvailable(database)) return new Map();
  const membershipIds = [...new Set(sources.map(({ membershipId }) => membershipId))];
  const candidates = membershipIds.flatMap((membershipId) =>
    Array.from({ length: 64 }, (_, attempt) => identityCodeCandidate(contextId, kind, membershipId, attempt)));
  await database.query('select pg_advisory_xact_lock(hashtext($1))', [`identity-display:${contextId}:${kind}`]);
  const stored = await database.query<StoredCode>(`select membership_id,code
    from identity_display.code_mapping
    where context_id=$1 and kind=$2 and (membership_id=any($3::text[]) or code=any($4::text[]))`,
  [contextId, kind, membershipIds, candidates]);
  const existing = new Map(stored.rows
    .filter(({ membership_id }) => membershipIds.includes(membership_id))
    .map(({ membership_id, code }) => [membership_id, code]));
  const assigned = allocateIdentityCodes(
    membershipIds,
    existing,
    new Set(stored.rows.map(({ code }) => code)),
    (membershipId, attempt) => identityCodeCandidate(contextId, kind, membershipId, attempt),
  );
  const missing = membershipIds.filter((membershipId) => !existing.has(membershipId));
  if (missing.length > 0) {
    await database.query(`insert into identity_display.code_mapping(context_id,kind,membership_id,code)
      select $1,$2,membership_id,code from unnest($3::text[],$4::text[]) assigned(membership_id,code)
      on conflict do nothing`, [contextId, kind, missing, missing.map((membershipId) => assigned.get(membershipId)!) ]);
  }
  const sourceById = new Map(sources.map((source) => [source.membershipId, source]));
  return new Map([...assigned].map(([membershipId, code]) => {
    const mobile = sourceById.get(membershipId)?.maskedMobile;
    const hint: IdentityDisplayHint = kind === 'operator'
      ? { kind, code: code as `OP-${string}`, label: '管理身份', ...(mobile == null ? {} : { maskedMobile: mobile }) }
      : { kind, code: code as `MB-${string}`, label: '会员身份', ...(mobile == null ? {} : { maskedMobile: mobile }) };
    return [membershipId, hint];
  }));
}

async function identityDisplayRepositoryAvailable(database: OperationDatabase): Promise<boolean> {
  const result = await database.query<{ readonly mapping: string | null }>(
    "select to_regclass('identity_display.code_mapping')::text mapping",
  );
  return result.rows[0]?.mapping === 'identity_display.code_mapping';
}
