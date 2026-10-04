import type { IdentityDisplayHint } from '@shop/contract';
import type { OperationDatabase } from '../../foundation/application/ModuleOperations';
import { allocateMemberSuffixes, allocateStorefrontSegment } from './MemberIdentityCode';

interface MemberCodeRow {
  storefront_node_id: string;
  segment: string | null;
  code: `MB-${string}` | null;
}

/** Uses the public runtime's existing session projection without granting direct table access. */
export async function readWebMemberIdentityDisplay(
  database: OperationDatabase, membership: string, session: string,
): Promise<IdentityDisplayHint | undefined> {
  const segments = new Set<string>();
  const suffixes = new Set<string>();
  let segment: string | null = null;
  let suffix: string | null = null;
  for (;;) {
    const result: { rows: MemberCodeRow[] } = await database.query<MemberCodeRow>(
      'select * from access.web_member_identity_code($1,$2,$3,$4)', [membership, session, segment, suffix],
    );
    const row: MemberCodeRow | undefined = result.rows[0];
    if (!row) return undefined;
    if (row.code !== null) return { kind: 'member', code: row.code, label: '会员身份' };
    if (segment !== null && row.segment === null) segments.add(segment);
    if (suffix !== null && row.segment !== null) suffixes.add(suffix);
    segment = allocateStorefrontSegment(row.storefront_node_id, row.segment, segments);
    suffix = allocateMemberSuffixes(row.storefront_node_id, [membership], new Map(), suffixes).get(membership)!;
  }
}
