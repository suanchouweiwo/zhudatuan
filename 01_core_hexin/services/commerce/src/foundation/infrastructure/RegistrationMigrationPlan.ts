import { createHash } from 'node:crypto';

export interface RegistrationMigrationExecution {
  readonly kind: 'original' | 'omitted' | 'transformed';
  readonly ledgerName: string;
  readonly ledgerStatements: readonly string[];
  readonly sql: string | null;
}

export interface RegistrationMigrationTarget {
  readonly checksum: string;
  readonly file: string;
  readonly version: string;
}

interface Transformation {
  readonly assertion: RegExp;
  readonly reason: string;
}

const PROFILE = 'registration-only/v1';
const RECONCILED_PROFILE = 'registration-reconciled/v1';
const IDENTITY_RUNTIME_REPAIR = '20260912180000_reconcile_identity_runtime_state.sql';
const RECONCILED_REASON = 'production runtime objects reconciled from verified existing state';
const HISTORY_HEAD = '20260820133000';
const LEGACY_GENERIC_LEDGER_SOURCES = new Map<string, string>([
  ['20260831150000_identity_experience_application_commands.sql', '4810ba8bc5cb49b67a648e788f70f5c0cc2b10910fb3d168a797a37806b0e3c7'],
  ['20260905010000_publish_runtime_catalog_alignment.sql', '8a463fab4e676ada72750ff449e66971e9ef095db64a1f7e23ba2d27002f739d'],
  ['20260905011000_expand_governance_store_scope.sql', 'ce286f1fbc37b2804cae61418ff9fb7854fc0b0688c847429cc62f840d179e0b'],
  ['20260905012000_honor_invitation_scope_hint.sql', '0dc53b18e12bd5a1478d339c21314a7d6a6db2c64e2a68172f47f716e5880860'],
  ['20260905013000_registration_invite_role_projection.sql', 'ab03873df52391ea3abb2b2376705166b9742471d3087a09bd144a6d2ec852d7'],
  ['20260905014000_bind_storefront_browse_scope.sql', '591b42a51455418e8c9224972453fc05e523fde7132e565aedfca4fe03a0dacf'],
  ['20260905203000_provision_zhudatuan_storefront_application.sql', 'eccaa52b4f52f7f66d6c5f64a7e8ad9541bd1781dcae55f176e2214e19af3da6'],
  ['20260909010000_bind_published_listings_to_storefront_pool.sql', 'e879110631a0dd4323218743c392240a398bb4f235d5972313d8d00eabf5b08b'],
  ['20260909061000_add_checkout_address_default.sql', '5caaab79f8e3159cfe410bde4a1dc86b9d355380ee5afb7fe64971ec4ea28f75'],
  ['20260912182000_create_storefront_member_node_projection.sql', '428c379ced8eb5396e28812be98acab2818433ce718bd29a99cbf8050b7892ea'],
  ['20260912183000_fix_storefront_member_node_projection.sql', 'f1504e5317bf77c4dcc47980533743469d7176a1a034a66e01e2e68322909206'],
]);
const OMITTED_MIGRATIONS = new Map<string, string>([
  ['20260817191000_bootstrap_ethan_platform_owner.sql', 'environment-specific Ethan platform owner fixture'],
  ['20260820132000_platform_owner_reconciliation.sql', 'environment-specific Ethan platform owner reconciliation'],
]);

const managedBackfill = (error: string): Transformation => ({
  assertion: new RegExp(`\\n  if exists\\(select 1 from runtime\\.schemaversion(?:(?!\\n  end if;)[\\s\\S])*?raise exception '${error}';\\n  end if;\\n`),
  reason: 'managed registration backfill preserves predecessor and state guards while later release ledger rows already exist',
});

const TRANSFORMATIONS = new Map<string, Transformation>([
  ['20260829060000_zhudatuan_operator_invitation_registration.sql', managedBackfill('ZHUDATUAN_OPERATOR_INVITATION_FUTURE_HEAD_INVALID')],
  ['20260829210000_owner_operator_coverage.sql', managedBackfill('OWNER_OPERATOR_COVERAGE_FUTURE_HEAD_INVALID')],
  ['20260829211000_platform_owner_transfer.sql', managedBackfill('PLATFORM_OWNER_TRANSFER_FUTURE_HEAD_INVALID')],
  ['20260829212000_owner_runtime_boundary_hardening.sql', managedBackfill('OWNER_RUNTIME_BOUNDARY_FUTURE_HEAD_INVALID')],
  ['20260829213000_reconcile_contract_identity_checksum.sql', managedBackfill('CONTRACT_IDENTITY_CHECKSUM_FUTURE_HEAD_INVALID')],
  ['20260829214000_owner_personal_scope_and_invoice_scope.sql', managedBackfill('OWNER_PERSONAL_SCOPE_FUTURE_HEAD_INVALID')],
  ['20260829215000_restore_invoice_request_operator_boundary.sql', managedBackfill('INVOICE_REQUEST_OPERATOR_FUTURE_HEAD_INVALID')],
  ['20260829216000_owner_capability_exactness.sql', managedBackfill('OWNER_CAPABILITY_EXACTNESS_FUTURE_HEAD_INVALID')],
  ['20260829217000_scope_hint_resource_precedence.sql', managedBackfill('SCOPE_HINT_RESOURCE_PRECEDENCE_FUTURE_HEAD_INVALID')],
  ['20260821066000_resolve_invitation_scope.sql', {
    assertion: /\ndo \$assert\$ begin\n  if access\.resource_scope\('identity\.invitations\.create',null,[\s\S]*?\nend \$assert\$;\n/,
    reason: 'assertion requires the omitted platform owner membership',
  }],
  ['20260821069000_add_store_management.sql', {
    assertion: /\n  select id into membership from access\.membership where client='operator' and status='active' order by id limit 1;\n  if access\.resource_scope\('organization\.stores\.manage','store:new',membership\) is null\n    then raise exception 'STORE_CREATE_SCOPE_UNRESOLVED'; end if;\n/,
    reason: 'store scope assertion requires the omitted platform owner membership',
  }],
  ['20260821074000_grant_platform_owner_operations.sql', {
    assertion: /\ndo \$assert\$[\s\S]*?\n\$assert\$;\n/,
    reason: 'grant assertion addresses the intentionally omitted platform owner',
  }],
  ['20260821075000_grant_platform_cardlibrary_read.sql', {
    assertion: /\ndo \$assert\$ begin[\s\S]*?\nend \$assert\$;\n/,
    reason: 'grant assertion addresses the intentionally omitted platform owner',
  }],
  ['20260821076000_grant_platform_cockpit_reads.sql', {
    assertion: /\ndo \$assert\$[\s\S]*?\n\$assert\$;\n/,
    reason: 'grant assertion addresses the intentionally omitted platform owner',
  }],
  ['20260821078000_complete_experience_application.sql', {
    assertion: /\ndo \$assert\$[\s\S]*?\n\$assert\$;\n/,
    reason: 'grant assertion addresses the intentionally omitted platform owner',
  }],
]);

export function registrationMigrationExecution(file: string, source: string): RegistrationMigrationExecution {
  const sourceDigest = sha256(source);
  const omissionReason = OMITTED_MIGRATIONS.get(file);
  if (omissionReason) {
    const executedDigest = sha256('');
    return Object.freeze({
      kind: 'omitted',
      ledgerName: `registration-omitted:${file}`,
      ledgerStatements: Object.freeze(metadata(sourceDigest, executedDigest, omissionReason)),
      sql: null,
    });
  }
  const transformation = TRANSFORMATIONS.get(file);
  if (!transformation) {
    const postHistory = file.slice(0, 14) > HISTORY_HEAD;
    return Object.freeze({
      kind: 'original',
      ledgerName: file,
      ledgerStatements: Object.freeze(postHistory
        ? metadata(sourceDigest, sourceDigest, 'append-only post-history migration executed byte-for-byte')
        : []),
      sql: source,
    });
  }
  const matches = source.match(new RegExp(transformation.assertion.source, 'g'));
  if (matches?.length !== 1) throw new Error(`REGISTRATION_MIGRATION_TRANSFORM_DRIFT:${file}`);
  const sql = source.replace(transformation.assertion, '\n');
  if (sql === source) throw new Error(`REGISTRATION_MIGRATION_TRANSFORM_EMPTY:${file}`);
  return Object.freeze({
    kind: 'transformed',
    ledgerName: `registration-transformed:${file}`,
    ledgerStatements: Object.freeze(metadata(sourceDigest, sha256(sql), transformation.reason)),
    sql,
  });
}

export function registrationMigrationTarget(file: string, source: string): RegistrationMigrationTarget {
  const version = file.slice(0, 14);
  const marker = new RegExp(
    `insert\\s+into\\s+runtime\\.schemaversion\\s*\\(version,checksum\\)\\s*values\\s*\\(\\s*'${version}'\\s*,\\s*'([a-f0-9]{64})'\\s*\\)`,
    'gi',
  );
  const matches = [...source.matchAll(marker)];
  if (matches.length === 0) {
    const expression = new RegExp(
      `values\\s*\\(\\s*'${version}'\\s*,\\s*encode\\(public\\.digest\\('((?:[^']|'')*)'\\s*,\\s*'sha256'\\)\\s*,\\s*'hex'\\)\\)`, 'gi',
    );
    for (const computed of source.matchAll(expression)) {
      matches.push([computed[0], sha256(computed[1]!.replaceAll("''", "'"))] as RegExpMatchArray);
    }
  }
  if (matches.length !== 1 || matches[0]?.[1] === undefined) {
    throw new Error(`REGISTRATION_MIGRATION_TARGET_MARKER_INVALID:${file}`);
  }
  return Object.freeze({ checksum: matches[0][1], file, version });
}

export function registrationMigrationLedgerMatches(
  file: string,
  existingName: string,
  existingStatements: readonly string[] | null,
  execution: RegistrationMigrationExecution,
): boolean {
  const statements = existingStatements ?? [];
  if (existingName === `registration-reconciled:${file}` && execution.kind === 'original') {
    const sourceDigest = execution.ledgerStatements.find((statement) => statement.startsWith('source_sha256='));
    return sourceDigest !== undefined && JSON.stringify(statements) === JSON.stringify([
      `profile=${RECONCILED_PROFILE}`,
      sourceDigest,
      `repair=${IDENTITY_RUNTIME_REPAIR}`,
      `reason=${RECONCILED_REASON}`,
    ]);
  }
  if (existingName !== execution.ledgerName) return false;
  if (JSON.stringify(statements) === JSON.stringify(execution.ledgerStatements)) return true;
  const legacySourceDigest = LEGACY_GENERIC_LEDGER_SOURCES.get(file);
  return statements.length === 0 && legacySourceDigest !== undefined && execution.kind === 'original'
    && JSON.stringify(execution.ledgerStatements) === JSON.stringify(metadata(
      legacySourceDigest,
      legacySourceDigest,
      'append-only post-history migration executed byte-for-byte',
    ));
}

function metadata(sourceDigest: string, executedDigest: string, reason: string): string[] {
  return [
    `profile=${PROFILE}`,
    `source_sha256=${sourceDigest}`,
    `executed_sha256=${executedDigest}`,
    `reason=${reason}`,
  ];
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
