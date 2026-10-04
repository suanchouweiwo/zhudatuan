import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { migrationEnvironment, processEnvironment } from '@shop/config/server';

import { KmsClient } from '../../../../01_core_hexin/services/commerce/src/foundation/infrastructure/KmsClient.ts';
import { RegistrationMigrationRunner } from '../../../../01_core_hexin/services/commerce/src/foundation/infrastructure/RegistrationMigrationRunner.ts';
import { identityNodeRegistryFromManifest } from '@shop/sdk/identity-node';
import { expectedIdentityNodeDatabaseManifest } from '../../../../01_core_hexin/services/commerce/src/bootstrap/IdentityNodeManifestRuntime.ts';
import { MigrationRunner } from '../../../../01_core_hexin/services/commerce/src/foundation/infrastructure/MigrationRunner.ts';
import { WorkloadSecretStore } from '../../../../01_core_hexin/services/commerce/src/foundation/infrastructure/SecretStore.ts';
import { createPool } from '../../../../01_core_hexin/services/commerce/src/foundation/persistence/Pool.ts';

const MIGRATION_FILE = /^\d{14}_[a-z0-9_]+\.sql$/;
const sourceSha = process.env.AI_DELIVERY_SOURCE_SHA;
if (!/^[a-f0-9]{40}$/.test(sourceSha ?? '')) throw new Error('DATABASE_MIGRATION_SOURCE_SHA_INVALID');

const environment = migrationEnvironment(processEnvironment());
if (!/^[a-z0-9][a-z0-9/._:-]{7,511}$/i.test(environment.snapshotRef)) throw new Error('MIGRATION_SOURCE_SNAPSHOT_REF_INVALID');
const secrets = new WorkloadSecretStore(environment.secretStoreEndpoint, environment.secretStoreBearerToken);
const nodeRegistration = process.env.DATABASE_MIGRATION_EXECUTION_MODE === 'node-registration';
const ownerExecution = process.env.DATABASE_MIGRATION_EXECUTION_MODE === 'database-owner';
const connection = ownerExecution || nodeRegistration ? ownerConnection(process.env) : await secrets.read(environment.databaseConnectionRef);
const pool = createPool(connection, 'migration');
const files = await migrationFiles(environment.directory);
const ledgerBefore = await ledgerEvidence(pool);
const appliedBefore = new Set(ledgerBefore.versions);
const selected = files.filter((file) => !appliedBefore.has(file.version));
const Runner = nodeRegistration ? RegistrationMigrationRunner : MigrationRunner;
const runner = new Runner(pool, new KmsClient(environment.kmsEndpoint, environment.kmsBearerToken), environment.directory, {
  distributorKeyRef: environment.distributorKeyRef,
  identityKeyRef: environment.identityKeyRef,
  partnerKeyRef: environment.partnerKeyRef,
  voucherKeyRef: environment.voucherKeyRef,
}, ownerExecution || nodeRegistration ? { kind: 'database-owner', role: required(process.env.POSTGRES_USER, 'MIGRATION_OWNER_ROLE_MISSING') } : undefined);

let result;
try {
  await runner.run();
  if (nodeRegistration) await initializeNodeBusiness();
  const ledgerAfter = await ledgerEvidence(pool);
  const appliedAfter = new Set(ledgerAfter.versions);
  const missing = selected.filter((file) => !appliedAfter.has(file.version));
  if (missing.length > 0) throw evidenceError('DATABASE_MIGRATION_LEDGER_INCOMPLETE', { missing });
  result = migrationResult(selected.length === 0 ? 'noop' : 'applied', ledgerBefore, ledgerAfter, selected);
} catch (error) {
  const ledgerAfter = await ledgerEvidence(pool).catch(() => null);
  result = migrationResult('failed', ledgerBefore, ledgerAfter, selected, error);
  process.exitCode = 1;
} finally {
  await pool.end();
}

process.stdout.write(`${JSON.stringify(result)}\n`);

function ownerConnection(source, migrationRole = false) {
  const host = required(source.MIGRATION_OWNER_DATABASE_HOST, 'MIGRATION_OWNER_DATABASE_HOST_MISSING');
  if (host !== '127.0.0.1') throw new Error('MIGRATION_OWNER_DATABASE_HOST_INVALID');
  const port = required(source.MIGRATION_OWNER_DATABASE_PORT, 'MIGRATION_OWNER_DATABASE_PORT_MISSING');
  if (!/^\d{2,5}$/.test(port)) throw new Error('MIGRATION_OWNER_DATABASE_PORT_INVALID');
  const user = migrationRole ? 'shopmigration' : required(source.POSTGRES_USER, 'MIGRATION_OWNER_ROLE_MISSING');
  const password = required(migrationRole ? source.SHOPMIGRATION_PASSWORD : source.POSTGRES_PASSWORD, 'MIGRATION_OWNER_PASSWORD_MISSING');
  const database = required(source.POSTGRES_DB, 'MIGRATION_OWNER_DATABASE_MISSING');
  if (!/^[a-z][a-z0-9_]{2,62}$/.test(user) || !/^[a-z][a-z0-9_]{2,62}$/.test(database)) {
    throw new Error('MIGRATION_OWNER_IDENTITY_INVALID');
  }
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}`;
}

function required(value, code) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(code);
  return value;
}

async function migrationFiles(directory) {
  const names = (await readdir(directory)).filter((name) => MIGRATION_FILE.test(name)).sort();
  return Promise.all(names.map(async (file) => ({
    file,
    version: file.slice(0, 14),
    sha256: createHash('sha256').update(await readFile(join(directory, file))).digest('hex'),
  })));
}

async function ledgerEvidence(database) {
  const client = await database.connect();
  try {
    const existence = await client.query("select to_regclass('supabase_migrations.schema_migrations') is not null as exists");
    const exists = existence.rows[0]?.exists === true;
    const records = exists
      ? (await client.query('select version,name,statements from supabase_migrations.schema_migrations order by version')).rows
        .map((row) => ({ version: row.version, name: row.name, statements: row.statements ?? [] }))
      : [];
    return {
      exists,
      count: records.length,
      head: records.at(-1)?.version ?? null,
      sha256: createHash('sha256').update(JSON.stringify(records)).digest('hex'),
      versions: records.map((record) => record.version),
    };
  } finally {
    client.release();
  }
}

function migrationResult(status, ledgerBefore, ledgerAfter, selected, error = null) {
  return {
    schema: 'ai.delivery.database-migration-result.v1',
    sourceSha,
    executionMode: nodeRegistration ? 'node-registration' : ownerExecution ? 'database-owner' : 'migration-role',
    status,
    selected,
    selectionStatus: 'determined',
    ledgerBefore: ledgerSummary(ledgerBefore),
    ledgerAfter: ledgerAfter === null ? null : ledgerSummary(ledgerAfter),
    applied: ledgerAfter === null ? [] : selected.filter((file) => ledgerAfter.versions.includes(file.version)),
    error: error === null ? null : { code: error.code ?? error.message ?? 'DATABASE_MIGRATION_FAILED', message: error.message ?? String(error) },
  };
}

function ledgerSummary({ versions: _versions, ...summary }) {
  return summary;
}

function evidenceError(code, details) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  return error;
}

async function initializeNodeBusiness() {
  const manifest = JSON.parse(await readFile(process.env.NODE_BOOTSTRAP_MANIFEST_FILE, 'utf8'));
  const projection = JSON.parse(await readFile(process.env.NODE_BOOTSTRAP_IDENTITY_FILE,'utf8'));
  const node = identityNodeRegistryFromManifest(projection).nodes.find((item) => item.nodeId === manifest.node_id);
  const projected = projection.nodes.find((item) => item.nodeId === manifest.node_id);
  const expected = { ...expectedIdentityNodeDatabaseManifest(manifest, node), targets: projected.targets.map((target) => ({
    realm_id:projected.realmId,surface:target.surface,target:target.target,membership_client:target.membershipClient,
    membership_organization_id:target.membershipOrganizationId,application_slug:target.application,return_origin:target.returnOrigin,node_profile:projected.nodeProfile
  })) };
  const tenant = expected.targets.find((target) => target.target === 'console')?.membership_organization_id ?? node.mallId;
  const enterprise = `enterprise-${manifest.node_id.split(':')[1]}`;
  const owner = createPool(ownerConnection(process.env), 'migration');
  const client = await owner.connect();
  try {
    await client.query('begin');
    for (const [id,kind,parent,name] of [[tenant,'tenant','organization-platform-root',node.displayName],
      [enterprise,'enterprise',tenant,node.displayName],[node.mallId,'mall',enterprise,node.mallName]]) {
      await client.query(`insert into organization.organization(id,kind,parent_id,name,timezone,status,version,created_at,updated_at)
        values($1,$2,$3,$4,'Asia/Shanghai','active',0,clock_timestamp(),clock_timestamp()) on conflict(id) do nothing`,[id,kind,parent,name]);
    }
    await client.query(`insert into organization.unitclosure(ancestor_id,descendant_id,depth)
      select ancestor,descendant,depth from (values
        ($1,$1,0),($2,$2,0),($3,$3,0),('organization-platform-root',$1,1),
        ($1,$2,1),($2,$3,1),('organization-platform-root',$2,2),($1,$3,2),('organization-platform-root',$3,3)
      ) t(ancestor,descendant,depth) on conflict do nothing`,[tenant,enterprise,node.mallId]);
    const role = `role-${manifest.node_id.split(':')[1]}-storefront-member`;
    await client.query(`insert into access.role(id,scope_id,name,status,version)
      select $1,$2,name,status,version from access.role where id='role-zhudatuan-storefront-member' on conflict(id) do nothing`,[role,node.mallId]);
    await client.query(`insert into access.rolepermission(role_id,permission_id,effect)
      select $1,permission_id,effect from access.rolepermission where role_id='role-zhudatuan-storefront-member' on conflict do nothing`,[role]);
    await client.query(`insert into catalog.pool(id,scope_id,kind,name,status,version)
      values($1,$2,'private',$3,'active',0) on conflict(id) do nothing`,[`pool:${node.mallId}`,node.mallId,node.mallName]);
    await client.query(`insert into catalog.poolbinding(mall_id,pool_id,listing_kind,status,effective_at,expires_at,created_at)
      values($1,$2,'selected','active',clock_timestamp(),null,clock_timestamp()) on conflict do nothing`,[node.mallId,`pool:${node.mallId}`]);
    const seedFile = '20260905203000_provision_zhudatuan_storefront_application.sql';
    const seed = (await readFile(join(environment.directory,seedFile),'utf8'))
      .replace(/^begin;\s*/,'').replace(/commit;\s*$/,'')
      .replaceAll('mall-zhudatuan',node.mallId).replaceAll('zhudatuan-storefront',node.consumerApplication)
      .replaceAll('ZHUDATUAN_STOREFRONT',`${manifest.node_id.split(':')[1].toUpperCase().replaceAll('-','_')}_STOREFRONT`)
      .replaceAll('主打团福利商城',node.mallName);
    const application = await client.query('select id from experience.application where public_slug=$1',[node.consumerApplication]);
    if (application.rowCount === 0) await client.query(seed);
    const targets = expected.targets.map((target) => target.target);
    await client.query('delete from identity.realmtarget where target=any($1) and realm_id<>$2',[targets,manifest.realm_ref.ref]);
    const fact = {schema_version:'sfl.autonode-identity-realm-fact.v1',activation_request_id:`activation:${manifest.node_id}:initial`,
      provisioning_request_id:`provisioning:${manifest.node_id}:initial`,manifest_id:manifest.manifest_id,
      manifest_digest:manifest.manifest_digest,realm:expected.realms[0],entries:expected.entries,targets:expected.targets};
    await client.query('select identity.provision_node_realm($1::jsonb)',[JSON.stringify(fact)]);
    await client.query('commit');
  } catch(error) { await client.query('rollback'); throw error; }
  finally { client.release(); await owner.end(); }
}
