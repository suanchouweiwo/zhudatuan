import { describe, expect, it, vi } from 'vitest';
import type { OperationDatabase } from '../../foundation/application/ModuleOperations';
import { presentIdentityDisplays } from './IdentityDisplayPresenter';

describe('identity display presenter', () => {
  it('allocates a batch without per-membership queries', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ mapping: 'identity_display.code_mapping' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const result = await presentIdentityDisplays({ query } as unknown as OperationDatabase, 'mall:one', 'operator', [
      { membershipId: 'membership:one', maskedMobile: '134****7586' },
      { membershipId: 'membership:two', maskedMobile: '192****7586' },
    ]);
    expect(query).toHaveBeenCalledTimes(6);
    expect(result.get('membership:one')).toMatchObject({ kind: 'operator', label: '管理身份', maskedMobile: '134****7586' });
    expect(result.get('membership:two')?.code).toMatch(/^OP-[2-9A-HJKMNP-Z]{4}$/);
    expect(result.get('membership:one')?.code).not.toBe(result.get('membership:two')?.code);
  });

  it('omits the optional projection when its repository is unavailable', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error('mapping unavailable'))
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const database = { query } as unknown as OperationDatabase;
    await expect(presentIdentityDisplays(database, 'mall:one', 'member', [
      { membershipId: 'membership:one' },
    ])).resolves.toEqual(new Map());
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      'savepoint identity_display_projection',
      "select to_regclass('identity_display.code_mapping')::text mapping",
      'rollback to savepoint identity_display_projection',
      'release savepoint identity_display_projection',
    ]);
  });

  it('restores the transaction after an optional projection query fails', async () => {
    let aborted = false;
    const query = vi.fn(async (sql: string) => {
      if (sql === 'savepoint identity_display_projection') return { rows: [] };
      if (sql.startsWith('select to_regclass')) {
        aborted = true;
        throw new Error('permission denied for schema identity_display');
      }
      if (sql === 'rollback to savepoint identity_display_projection') aborted = false;
      if (aborted) throw new Error('current transaction is aborted');
      return { rows: [] };
    });
    const database = { query } as unknown as OperationDatabase;
    await expect(presentIdentityDisplays(database, 'mall:one', 'operator', [
      { membershipId: 'membership:one' },
    ])).resolves.toEqual(new Map());
    await expect(database.query('select 1')).resolves.toEqual({ rows: [] });
  });

  it('keeps standalone read callers working without a transaction', async () => {
    const query = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('no transaction'), { code: '25P01' }))
      .mockResolvedValueOnce({ rows: [] });
    const database = { query } as unknown as OperationDatabase;
    await expect(presentIdentityDisplays(database, 'mall:one', 'member', [
      { membershipId: 'membership:one' },
    ])).resolves.toEqual(new Map());
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      'savepoint identity_display_projection',
      "select to_regclass('identity_display.code_mapping')::text mapping",
    ]);
  });
});
