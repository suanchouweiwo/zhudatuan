import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { PoolClient } from 'pg';
import { TARGET_SCHEMA_HEAD } from '@shop/config/server';

import { Semaphore } from '../performance/Semaphore';
import type { KmsClient } from './KmsClient';
import { genericMigrationSql } from './MigrationExecutionPlan';
import type { DatabasePool } from '../persistence/Pool';

interface HistoryContract {
  readonly algorithm: 'sha256';
  readonly count: number;
  readonly head: string;
  readonly migrations: readonly { readonly file: string; readonly sha256: string }[];
}

interface MigrationSecrets {
  readonly distributorKeyRef: string;
  readonly identityKeyRef: string;
  readonly partnerKeyRef: string;
  readonly voucherKeyRef: string;
}

export type MigrationExecutionRole =
  | { readonly kind: 'migration-role' }
  | { readonly kind: 'database-owner'; readonly role: string };

interface SourceSecret {
  readonly context: Readonly<Record<string, string>>;
  readonly createdAt: Date;
  readonly id: string;
  readonly keyRef: string;
  readonly plaintext: string;
  readonly target: 'distributor' | 'identity' | 'partner' | 'voucher';
  readonly union?: string;
}

const BACKFILL = '20260821026000_backfill_domain_data.sql';

export class MigrationRunner {
  constructor(
    private readonly pool: DatabasePool,
    private readonly kms: KmsClient,
    private readonly directory: string,
    private readonly secrets: MigrationSecrets,
    private readonly executionRole: MigrationExecutionRole = { kind: 'migration-role' },
  ) {}

  async run(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await this.assertRole(client);
      await client.query("select pg_advisory_lock(hashtext('shop-domain-hard-cut'))");
      const files = (await readdir(this.directory)).filter((name) => /^\d{14}_[a-z0-9_]+\.sql$/.test(name)).sort();
      await this.assertHistory(files);
      let applied = await this.applied(client);
      for (const file of files) {
        const version = file.slice(0, 14);
        if (applied.has(version)) continue;
        if (file === BACKFILL) await this.stageSecrets(client);
        const sql = genericMigrationSql(file, await readFile(join(this.directory, file), 'utf8'));
        await client.query(sql);
        await client.query(
          'insert into supabase_migrations.schema_migrations(version,statements,name) values($1,$2,$3) on conflict(version) do nothing',
          [version, [], file],
        );
        applied = await this.applied(client);
      }
      const result = await client.query<{ readonly valid: boolean }>(
        `select exists(select 1 from runtime.schemaversion where version=$1) and not exists(select 1 from pg_tables where schemaname='public') valid`,
        [TARGET_SCHEMA_HEAD],
      );
      if (result.rows[0]?.valid !== true) throw new Error('MIGRATION_TARGET_INVALID');
    } finally {
      await client.query("select pg_advisory_unlock(hashtext('shop-domain-hard-cut'))").catch(() => undefined);
      client.release();
    }
  }

  private async assertRole(client: PoolClient): Promise<void> {
    const result = await client.query<{ readonly current_role: string; readonly allowed: boolean; readonly bypass: boolean; readonly superuser: boolean }>(
      `select pg_has_role(current_user,'shopmigration','member') allowed,
        current_user current_role,
        coalesce((select rolbypassrls from pg_roles where rolname=current_user),false) bypass,
        coalesce((select rolsuper from pg_roles where rolname=current_user),false) superuser`,
    );
    const role = result.rows[0];
    if (this.executionRole.kind === 'database-owner') {
      if (role?.current_role !== this.executionRole.role || role.superuser !== true) throw new Error('MIGRATION_OWNER_ROLE_INVALID');
      return;
    }
    if (role?.allowed !== true || role.bypass) throw new Error('MIGRATION_ROLE_INVALID');
  }

  private async assertHistory(files: readonly string[]): Promise<void> {
    const contract = JSON.parse(await readFile(join(this.directory, '..', '..', 'contracts', 'history.json'), 'utf8')) as HistoryContract;
    if (contract.algorithm !== 'sha256' || contract.count !== 94 || contract.migrations.length !== 94) throw new Error('MIGRATION_HISTORY_CONTRACT_INVALID');
    const historical = files.filter((file) => file.slice(0, 14) <= contract.head);
    if (historical.join('\n') !== contract.migrations.map((migration) => migration.file).join('\n')) throw new Error('MIGRATION_HISTORY_FILESET_DRIFT');
    for (const migration of contract.migrations) {
      const digest = createHash('sha256').update(await readFile(join(this.directory, migration.file))).digest('hex');
      if (digest !== migration.sha256) throw new Error(`MIGRATION_HISTORY_HASH_DRIFT:${basename(migration.file)}`);
    }
  }

  private async applied(client: PoolClient): Promise<Set<string>> {
    const result = await client.query<{ readonly version: string }>('select version from supabase_migrations.schema_migrations');
    return new Set(result.rows.map((row) => row.version));
  }

  private async stageSecrets(client: PoolClient): Promise<void> {
    const sources = await this.secretSources(client);
    const semaphore = new Semaphore(8);
    const envelopes = await Promise.all(sources.map((source) => semaphore.use(async () => ({
      envelope: await this.kms.encrypt(source.keyRef, source.plaintext, source.context),
      source,
      unionToken: source.union === undefined ? null : (await this.kms.encrypt(source.keyRef, source.union, { ...source.context, value: 'union' })).fingerprint,
    }))));
    await client.query('begin');
    try {
      for (const { envelope, source, unionToken } of envelopes) {
        if (source.target === 'voucher') {
          await client.query(`insert into runtime.vouchersecretstage(voucher_id,code_ciphertext,code_fingerprint,key_version,staged_at)
            values($1,$2,$3,$4,$5) on conflict(voucher_id) do update set code_ciphertext=excluded.code_ciphertext,
            code_fingerprint=excluded.code_fingerprint,key_version=excluded.key_version,staged_at=excluded.staged_at`,
          [source.id, envelope.ciphertext, envelope.fingerprint, envelope.keyVersion, source.createdAt]);
        } else if (source.target === 'identity') {
          await client.query(`insert into runtime.wechatidentitystage(identity_id,subject_ciphertext,subject_token,union_token,key_version,staged_at)
            values($1,$2,$3,$4,$5,$6) on conflict(identity_id) do update set subject_ciphertext=excluded.subject_ciphertext,
            subject_token=excluded.subject_token,union_token=excluded.union_token,key_version=excluded.key_version,staged_at=excluded.staged_at`,
          [source.id, envelope.ciphertext, envelope.fingerprint, unionToken, envelope.keyVersion, source.createdAt]);
        } else if (source.target === 'partner') {
          await client.query(`insert into runtime.partneraddressstage(store_id,address_ciphertext,address_token,key_version,staged_at)
            values($1,$2,$3,$4,$5) on conflict(store_id) do update set address_ciphertext=excluded.address_ciphertext,
            address_token=excluded.address_token,key_version=excluded.key_version,staged_at=excluded.staged_at`,
          [source.id, envelope.ciphertext, envelope.fingerprint, envelope.keyVersion, source.createdAt]);
        } else {
          await client.query(`insert into runtime.distributorcontactstage(distributor_id,contact_ciphertext,contact_token,key_version,staged_at)
            values($1,$2,$3,$4,$5) on conflict(distributor_id) do update set contact_ciphertext=excluded.contact_ciphertext,
            contact_token=excluded.contact_token,key_version=excluded.key_version,staged_at=excluded.staged_at`,
          [source.id, envelope.ciphertext, envelope.fingerprint, envelope.keyVersion, source.createdAt]);
        }
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  }

  private async secretSources(client: PoolClient): Promise<SourceSecret[]> {
    const [vouchers, stores, distributors, identities] = await Promise.all([
      client.query<{ id: string; plaintext: string; created_at: Date }>('select id,voucher_code plaintext,created_at from public.vouchers order by id'),
      client.query<{ id: string; plaintext: string; created_at: Date }>('select id,address_text plaintext,created_at from public.stores where address_text is not null order by id'),
      client.query<{ id: string; plaintext: string; created_at: Date }>("select id,contact_json::text plaintext,created_at from public.distributors where contact_json<>'{}'::jsonb order by id"),
      client.query<{ id: string; plaintext: string; union_id: string | null; created_at: Date }>('select id::text id,open_id plaintext,union_id,created_at from public.member_wechat_identities order by id'),
    ]);
    return [
      ...vouchers.rows.map((row) => ({ context: { domain: 'voucher', voucherId: row.id }, createdAt: row.created_at, id: row.id, keyRef: this.secrets.voucherKeyRef, plaintext: row.plaintext, target: 'voucher' as const })),
      ...stores.rows.map((row) => ({ context: { domain: 'partner', storeId: row.id }, createdAt: row.created_at, id: row.id, keyRef: this.secrets.partnerKeyRef, plaintext: row.plaintext, target: 'partner' as const })),
      ...distributors.rows.map((row) => ({ context: { distributorId: row.id, domain: 'channel' }, createdAt: row.created_at, id: row.id, keyRef: this.secrets.distributorKeyRef, plaintext: row.plaintext, target: 'distributor' as const })),
      ...identities.rows.map((row) => ({ context: { domain: 'identity', identity: row.id }, createdAt: row.created_at, id: row.id,
        keyRef: this.secrets.identityKeyRef, plaintext: row.plaintext, target: 'identity' as const, ...(row.union_id === null ? {} : { union: row.union_id }) })),
    ];
  }
}
