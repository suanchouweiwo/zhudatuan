import type { AuthTarget } from '@shop/config/server';
import { reject, type OperationDatabase } from '../../../../foundation/application/ModuleOperations';
import { csrfCookieName, sessionCookieName } from '../../../../foundation/security/AuthSessionCookies';

export { authMembershipTarget, authTarget, SESSION_MAX_AGE_SECONDS } from '@shop/l-kernel/login';

export function sessionCookies(token: string, csrf: string, maxAge: number, target?: AuthTarget): Readonly<Record<string, string>> {
  const expiry = maxAge === 0 ? '; Expires=Thu, 01 Jan 1970 00:00:00 GMT' : '';
  const sessionName = target === undefined ? 'shop_session' : sessionCookieName(target);
  const csrfName = target === undefined ? 'shop_csrf' : csrfCookieName(target);
  return Object.freeze({
    'set-cookie': `${sessionName}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax${expiry}`,
    'x-set-cookie': `${csrfName}=${encodeURIComponent(csrf)}; Path=/; Max-Age=${maxAge}; Secure; SameSite=Strict${expiry}`,
  });
}

export async function consumeChallenge(database: OperationDatabase, challenge: string, code: string,
  digest: (id: string, code: string) => string, principal?: string,
  expected: Readonly<{ purpose?: string; destinationHash?: string; sessionHash?: string; realmId?: string; accountId?: string }> = {}
): Promise<{ principal_id: string | null; realm_id: string | null; account_id: string | null }> {
  const result = await database.query<{ principal_id: string | null; realm_id: string | null; account_id: string | null }>(`update identity.challenge set consumed_at=clock_timestamp(),attempts=attempts+1
    where id=$1 and code_hash=$2 and consumed_at is null and expires_at>clock_timestamp()
      and ($3::text is null or principal_id=$3)
      and ($4::text is null or purpose=$4)
      and ($5::text is null or destination_hash=$5)
      and ($6::text is null or session_hash=$6)
      and ($7::text is null or realm_id=$7)
      and ($8::text is null or account_id=$8)
    returning principal_id,realm_id,account_id`, [challenge, digest(challenge, code), principal ?? null, expected.purpose ?? null,
    expected.destinationHash ?? null, expected.sessionHash ?? null, expected.realmId ?? null, expected.accountId ?? null]);
  if (!result.rows[0]) {
    await database.query(`update identity.challenge set attempts=attempts+1
      where id=$1 and consumed_at is null
        and ($2::text is null or principal_id=$2)
        and ($3::text is null or purpose=$3)
        and ($4::text is null or destination_hash=$4)
        and ($5::text is null or session_hash=$5)
        and ($6::text is null or realm_id=$6)
        and ($7::text is null or account_id=$7)`, [challenge, principal ?? null, expected.purpose ?? null,
      expected.destinationHash ?? null, expected.sessionHash ?? null, expected.realmId ?? null, expected.accountId ?? null]);
    reject(400, 'CHALLENGE_INVALID');
  }
  return result.rows[0]!;
}
