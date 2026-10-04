import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { PoolClient } from 'pg';

import { Semaphore } from '../performance/Semaphore';
import type { DatabasePool } from '../persistence/Pool';
import type { KmsClient } from './KmsClient';
import type { MigrationExecutionRole } from './MigrationRunner';
import {
  registrationMigrationExecution,
  registrationMigrationLedgerMatches,
  type RegistrationMigrationExecution,
  registrationMigrationTarget,
  type RegistrationMigrationTarget,
} from './RegistrationMigrationPlan';

interface HistoryContract {
  readonly algorithm: 'sha256';
  readonly count: number;
  readonly head: string;
  readonly migrations: readonly { readonly file: string; readonly sha256: string }[];
}

interface RegistrationMigrationSecrets {
  readonly distributorKeyRef: string;
  readonly identityKeyRef: string;
  readonly partnerKeyRef: string;
  readonly voucherKeyRef: string;
}

interface SourceSecret {
  readonly context: Readonly<Record<string, string>>;
  readonly createdAt: Date;
  readonly id: string;
  readonly keyRef: string;
  readonly plaintext: string;
  readonly target: 'distributor' | 'identity' | 'partner' | 'voucher';
  readonly union?: string;
}

interface LedgerRecord {
  readonly name: string | null;
  readonly statements: readonly string[] | null;
  readonly version: string;
}

const BACKFILL = '20260821026000_backfill_domain_data.sql';
const AUTONODE_IDENTITY_VERSION = '20260909062000';
const AUTONODE_IDENTITY_CHECKSUM = '3fd8550c8331373bce69345128c464f331fcc0ca57d873621091905641c1e638';
const L0_PUBLIC_DOMAIN_VERSION = '20260909203000';
const L0_PUBLIC_DOMAIN_CHECKSUM = '31ed21bd9351a3678742c2b0c10a1a2b725cbbfef09d5888b609569a2f3610ba';
const REGISTRATION_DATABASE = 'zhudatuan_registration';
const REGISTRATION_MIGRATION_ROLE = 'shopmigration';
const MIGRATION_FILE = /^\d{14}_[a-z0-9_]+\.sql$/;

/**
 * Dedicated runner for the isolated registration database only.
 *
 * Historical environment-only migrations and assertions are never silently
 * presented as original executions: their source digest, executed digest and
 * reason are recorded in the migration ledger under a registration-specific
 * name. The generic MigrationRunner remains unchanged for full/local systems.
 */
export class RegistrationMigrationRunner {
  constructor(
    private readonly pool: DatabasePool,
    private readonly kms: KmsClient,
    private readonly directory: string,
    private readonly secrets: RegistrationMigrationSecrets,
    private readonly executionRole: MigrationExecutionRole = { kind: 'migration-role' },
  ) {}

  async run(): Promise<void> {
    const client = await this.pool.connect();
    let locked = false;
    try {
      await this.assertIndependentBoundary(client);
      await client.query("select pg_advisory_lock(hashtext('zhudatuan:registration-migration:v1'))");
      locked = true;
      const files = (await readdir(this.directory)).filter((name) => MIGRATION_FILE.test(name)).sort();
      const targetFile = files.at(-1);
      if (targetFile === undefined) throw new Error('REGISTRATION_MIGRATION_TARGET_FILESET_INVALID');
      const target = registrationMigrationTarget(targetFile, await readFile(join(this.directory, targetFile), 'utf8'));
      await this.assertHistory(files);
      await this.assertFreshOrManagedState(client);
      await this.ensureLedger(client);
      const applied = await this.applied(client);
      for (const file of files) {
        const version = file.slice(0, 14);
        const source = await readFile(join(this.directory, file), 'utf8');
        const execution = registrationMigrationExecution(file, source);
        const existing = applied.get(version);
        if (existing) {
          this.assertLedgerRecord(existing, execution, file);
          continue;
        }
        if (version === AUTONODE_IDENTITY_VERSION
          && await this.deferMissingAutonodeIdentityLedgerToManagedRepair(client)) continue;
        if (version === L0_PUBLIC_DOMAIN_VERSION
          && await this.deferMissingL0PublicDomainLedgerToManagedRepair(client)) continue;
        if (file === BACKFILL) await this.stageSecrets(client);
        if (execution.sql !== null) await client.query(execution.sql);
        await client.query(
          'insert into supabase_migrations.schema_migrations(version,statements,name) values($1,$2,$3) on conflict(version) do nothing',
          [version, [...execution.ledgerStatements], execution.ledgerName],
        );
      }
      await this.assertTarget(client, target);
    } finally {
      if (locked) await client.query("select pg_advisory_unlock(hashtext('zhudatuan:registration-migration:v1'))").catch(() => undefined);
      client.release();
    }
  }

  private async assertIndependentBoundary(client: PoolClient): Promise<void> {
    const result = await client.query<{
      readonly database_name: string;
      readonly database_role: string;
      readonly role_safe: boolean;
      readonly sentinel: boolean;
    }>(`select current_database() database_name,current_user database_role,
      not exists(select 1 from pg_roles where rolname=current_user
        and (rolsuper or rolbypassrls or rolcreaterole or rolcreatedb or rolreplication)) role_safe,
      coalesce(deployment.is_independent_registration_database(),false) sentinel`);
    const row = result.rows[0];
    const roleMatches = this.executionRole.kind === 'database-owner'
      ? row?.database_role === this.executionRole.role
      : row?.database_role === REGISTRATION_MIGRATION_ROLE && row.role_safe === true;
    if (!row || row.database_name !== REGISTRATION_DATABASE || !roleMatches || row.sentinel !== true) throw new Error('REGISTRATION_MIGRATION_DATABASE_BOUNDARY_INVALID');
  }

  private async assertFreshOrManagedState(client: PoolClient): Promise<void> {
    const result = await client.query<{ readonly business_tables: number; readonly ledger_exists: boolean }>(`select
      (select count(*)::integer from pg_tables
        where schemaname not in('pg_catalog','information_schema','deployment','supabase_migrations')) business_tables,
      to_regclass('supabase_migrations.schema_migrations') is not null ledger_exists`);
    const row = result.rows[0];
    if (!row || (row.business_tables !== 0 && row.ledger_exists !== true)) {
      throw new Error('REGISTRATION_MIGRATION_UNMANAGED_DATABASE_NOT_EMPTY');
    }
  }

  private async ensureLedger(client: PoolClient): Promise<void> {
    await client.query('create schema if not exists supabase_migrations');
    await client.query(`create table if not exists supabase_migrations.schema_migrations(
      version text primary key,statements text[] not null default array[]::text[],name text not null
    )`);
  }

  private async applied(client: PoolClient): Promise<Map<string, LedgerRecord>> {
    const result = await client.query<LedgerRecord>('select version,name,statements from supabase_migrations.schema_migrations order by version');
    const records = new Map<string, LedgerRecord>();
    for (const row of result.rows) {
      if (!/^\d{14}$/.test(row.version) || records.has(row.version)) throw new Error('REGISTRATION_MIGRATION_LEDGER_INVALID');
      records.set(row.version, row);
    }
    return records;
  }

  private assertLedgerRecord(record: LedgerRecord, execution: RegistrationMigrationExecution, file: string): void {
    if (!registrationMigrationLedgerMatches(file, record.name ?? '', record.statements, execution)) {
      throw new Error(`REGISTRATION_MIGRATION_LEDGER_DRIFT:${file}`);
    }
  }

  private async deferMissingAutonodeIdentityLedgerToManagedRepair(client: PoolClient): Promise<boolean> {
    const result = await client.query<{
      readonly marker_exact: boolean;
      readonly marker_present: boolean;
      readonly recoverable: boolean;
    }>(`select
      exists(select 1 from runtime.schemaversion where version=$1) marker_present,
      exists(select 1 from runtime.schemaversion where version=$1 and checksum=$2) marker_exact,
      not exists(select 1 from runtime.schemaversion where version>$1)
        and to_regclass('identity.nodeprovisioning') is not null
        and to_regprocedure('identity.provision_node_realm(jsonb)') is not null
        and to_regprocedure('identity.disable_node_realm(text)') is not null
        and not has_function_privilege('public','identity.provision_node_realm(jsonb)','execute')
        and not has_function_privilege('public','identity.disable_node_realm(text)','execute')
        and has_function_privilege('zhudatuanprovisioningapi','identity.provision_node_realm(jsonb)','execute')
        and has_function_privilege('zhudatuanprovisioningapi','identity.disable_node_realm(text)','execute')
        and not has_table_privilege('zhudatuanprovisioningapi','identity.nodeprovisioning','select,insert,update,delete')
        and exists(select 1 from pg_class relation join pg_namespace namespace on namespace.oid=relation.relnamespace
          where namespace.nspname='identity' and relation.relname='nodeprovisioning' and relation.relrowsecurity)
        recoverable`, [AUTONODE_IDENTITY_VERSION, AUTONODE_IDENTITY_CHECKSUM]);
    const state = result.rows[0];
    if (state?.marker_present !== true) return false;
    if (state.marker_exact !== true || state.recoverable !== true) {
      throw new Error('REGISTRATION_MIGRATION_AUTONODE_LEDGER_RECOVERY_INVALID');
    }
    return true;
  }

  private async deferMissingL0PublicDomainLedgerToManagedRepair(client: PoolClient): Promise<boolean> {
    const result = await client.query<{
      readonly marker_exact: boolean;
      readonly marker_present: boolean;
      readonly recoverable: boolean;
    }>(`select
      exists(select 1 from runtime.schemaversion where version=$1) marker_present,
      exists(select 1 from runtime.schemaversion where version=$1 and checksum=$2) marker_exact,
      (select count(*) from identity.realmentry where realm_id='realm:l0')=3
        and exists(select 1 from identity.realmentry where realm_id='realm:l0' and host='accounts.fufu.wang' and kind='accounts' and status='active')
        and exists(select 1 from identity.realmentry where realm_id='realm:l0' and host='api.fufu.wang' and kind='api' and status='active')
        and exists(select 1 from identity.realmentry where realm_id='realm:l0' and host='fufu.wang' and kind='storefront' and status='active')
        and (select count(*) from identity.realmtarget where realm_id='realm:l0')=4
        and exists(select 1 from identity.realmtarget where realm_id='realm:l0' and target='console' and return_origin='https://console.fufu.wang')
        and exists(select 1 from identity.realmtarget where realm_id='realm:l0' and target='store' and return_origin='https://console.fufu.wang/entrances/store')
        and exists(select 1 from identity.realmtarget where realm_id='realm:l0' and target='supplier' and return_origin='https://console.fufu.wang/entrances/supplier')
        and exists(select 1 from identity.realmtarget where realm_id='realm:l0' and target='storefront' and return_origin='https://fufu.wang')
        recoverable`, [L0_PUBLIC_DOMAIN_VERSION, L0_PUBLIC_DOMAIN_CHECKSUM]);
    const state = result.rows[0];
    if (state?.marker_present !== true) return false;
    if (state.marker_exact !== true || state.recoverable !== true) {
      throw new Error('REGISTRATION_MIGRATION_L0_PUBLIC_DOMAIN_LEDGER_RECOVERY_INVALID');
    }
    return true;
  }

  private async assertHistory(files: readonly string[]): Promise<void> {
    const contract = JSON.parse(await readFile(join(this.directory, '..', '..', 'contracts', 'history.json'), 'utf8')) as HistoryContract;
    if (contract.algorithm !== 'sha256' || contract.count !== 94 || contract.migrations.length !== 94) {
      throw new Error('REGISTRATION_MIGRATION_HISTORY_CONTRACT_INVALID');
    }
    const historical = files.filter((file) => file.slice(0, 14) <= contract.head);
    if (historical.join('\n') !== contract.migrations.map((migration) => migration.file).join('\n')) {
      throw new Error('REGISTRATION_MIGRATION_HISTORY_FILESET_DRIFT');
    }
    for (const migration of contract.migrations) {
      const digest = createHash('sha256').update(await readFile(join(this.directory, migration.file))).digest('hex');
      if (digest !== migration.sha256) throw new Error(`REGISTRATION_MIGRATION_HISTORY_HASH_DRIFT:${basename(migration.file)}`);
    }
  }

  private async assertTarget(client: PoolClient, target: RegistrationMigrationTarget): Promise<void> {
    const result = await client.query<{ readonly valid: boolean }>(`select
      exists(select 1 from runtime.schemaversion where version=$1 and checksum=$2)
      and not exists(select 1 from runtime.schemaversion where version>$1)
      and not exists(select 1 from pg_tables where schemaname='public')
      and exists(select 1 from supabase_migrations.schema_migrations where version=$1 and name=$3) valid`,
    [target.version, target.checksum, target.file]);
    if (result.rows[0]?.valid !== true) throw new Error('REGISTRATION_MIGRATION_TARGET_INVALID');
  }

  private async stageSecrets(client: PoolClient): Promise<void> {
    const sources = await this.secretSources(client);
    const semaphore = new Semaphore(8);
    const envelopes = await Promise.all(sources.map((source) => semaphore.use(async () => ({
      envelope: await this.kms.encrypt(source.keyRef, source.plaintext, source.context),
      source,
      unionToken: source.union === undefined ? null
        : (await this.kms.encrypt(source.keyRef, source.union, { ...source.context, value: 'union' })).fingerprint,
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
      ...vouchers.rows.map((row) => ({ context: { domain: 'voucher', voucherId: row.id }, createdAt: row.created_at,
        id: row.id, keyRef: this.secrets.voucherKeyRef, plaintext: row.plaintext, target: 'voucher' as const })),
      ...stores.rows.map((row) => ({ context: { domain: 'partner', storeId: row.id }, createdAt: row.created_at,
        id: row.id, keyRef: this.secrets.partnerKeyRef, plaintext: row.plaintext, target: 'partner' as const })),
      ...distributors.rows.map((row) => ({ context: { distributorId: row.id, domain: 'channel' }, createdAt: row.created_at,
        id: row.id, keyRef: this.secrets.distributorKeyRef, plaintext: row.plaintext, target: 'distributor' as const })),
      ...identities.rows.map((row) => ({ context: { domain: 'identity', identity: row.id }, createdAt: row.created_at,
        id: row.id, keyRef: this.secrets.identityKeyRef, plaintext: row.plaintext, target: 'identity' as const,
        ...(row.union_id === null ? {} : { union: row.union_id }) })),
    ];
  }
}
