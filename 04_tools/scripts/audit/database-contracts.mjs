import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { Client } from 'pg';
import { parse } from 'yaml';
import { repositoryRoot } from '../lib/RepositoryRoot.mjs';

const ROOT = repositoryRoot;
const MIGRATIONS = join(ROOT, '02_platform_pingtai', 'database', 'supabase', 'migrations');
const HISTORY = join(ROOT, '02_platform_pingtai', 'database', 'contracts', 'history.json');
const OBJECTS = join(ROOT, '02_platform_pingtai', 'database', 'contracts', 'objects.yml');
const BOOTSTRAP = '20260817191000_bootstrap_ethan_platform_owner.sql';
const OWNER_RECONCILIATION = '20260820132000_platform_owner_reconciliation.sql';
const AUTONODE_IDENTITY_POST_HISTORY = '20260909062000_provision_autonode_identity_realm.sql';
const AUTONODE_IDENTITY_POST_HISTORY_STATEMENTS = Object.freeze([
  'profile=registration-only/v1',
  'source_sha256=64537e9bbe5e9fc9022fe76f9a34e03b273ab12be07ba7e94128adb72a8d452c',
  'executed_sha256=64537e9bbe5e9fc9022fe76f9a34e03b273ab12be07ba7e94128adb72a8d452c',
  'reason=append-only post-history migration executed byte-for-byte',
]);
const L0_PUBLIC_DOMAIN_POST_HISTORY = '20260909203000_switch_l0_public_domain_to_fufu.sql';
const L0_PUBLIC_DOMAIN_POST_HISTORY_STATEMENTS = Object.freeze([
  'profile=registration-only/v1',
  'source_sha256=a28e4337628095bfeb98f3acf4f33fa89d485c4f2913f56e1e70589a112179b1',
  'executed_sha256=a28e4337628095bfeb98f3acf4f33fa89d485c4f2913f56e1e70589a112179b1',
  'reason=append-only post-history migration executed byte-for-byte',
]);
const OWNER_FIXTURE_BOUNDARY = '20260829060000_zhudatuan_operator_invitation_registration.sql';
const AUTONODE_TASK_OPERATION_PUBLICATION = '20260914090000_publish_autonode_task_operations.sql';
const INVITATION_SCOPE = '20260821066000_resolve_invitation_scope.sql';
const REGISTRATION_ASSERTION_OMISSIONS = new Map([
  [INVITATION_SCOPE, /\ndo \$assert\$ begin\n  if access\.resource_scope\('identity\.invitations\.create',[\s\S]*?\nend \$assert\$;\n/],
  ['20260821069000_add_store_management.sql', /\n  select id into membership from access\.membership[\s\S]*?STORE_CREATE_SCOPE_UNRESOLVED'; end if;\n/],
  ['20260821074000_grant_platform_owner_operations.sql', /\ndo \$assert\$[\s\S]*?\n\$assert\$;\n/],
  ['20260821075000_grant_platform_cardlibrary_read.sql', /\ndo \$assert\$[\s\S]*?\nend \$assert\$;\n/],
  ['20260821076000_grant_platform_cockpit_reads.sql', /\ndo \$assert\$[\s\S]*?\n\$assert\$;\n/],
  ['20260821078000_complete_experience_application.sql', /\n  if exists\(\n    select 1 from unnest\(required_operations\)[\s\S]*?PLATFORM_OWNER_EXPERIENCE_OPERATION_MISSING';\n  end if;\n/],
  ['20260828092000_finance_security_boundaries.sql', /\n  if not exists\(select 1 from capability\.membership_operations\('membership-platform-owner-ethan-v1'\)[\s\S]*?FINANCE_CONSOLE_READ_PERMISSION_MISSING'; end if;\n/],
]);
const INVENTORY_CUTOVER = '20260820133000_inventory_single_source_cutover.sql';
const SECURE_STAGE = '20260821026000_backfill_domain_data.sql';
const REPAIR_FILES = [
  '20260821010000_assert_source_head.sql','20260821011000_create_domain_schemas.sql','20260821012000_create_runtime_control.sql',
  '20260821013000_create_identity_access.sql','20260821014000_create_organization_partner.sql','20260821015000_create_capability_member.sql',
  '20260821016000_create_qualification.sql','20260821017000_create_catalog_pricing.sql','20260821018000_create_inventory_experience.sql',
  '20260821019000_create_cart_checkout_order.sql','20260821020000_create_fulfillment_verification.sql','20260821021000_create_payment_voucher_benefit.sql',
  '20260821022000_create_finance_channel.sql','20260821023000_create_support_notification.sql','20260821024000_create_reporting_risk_audit.sql',
  '20260821025000_create_extension.sql','20260821026000_backfill_domain_data.sql','20260821027000_reconcile_domain_data.sql',
  '20260821028000_build_domain_indexes.sql','20260821029000_publish_domain_contract.sql','20260821030000_revoke_public_access.sql',
  '20260821031000_drop_legacy_objects.sql','20260821032000_assert_target_head.sql','20260821033000_complete_experience_publication.sql',
  '20260821034000_add_storefront_offer_read.sql','20260821035000_add_auth_ticket_exchange.sql',
  '20260821036000_add_invitation_terms_read.sql','20260821037000_add_member_journey.sql','20260821038000_add_keyset_indexes.sql',
  '20260821039000_checkout_atomic_order.sql','20260821040000_payment_recovery.sql','20260821041000_voucher_lifecycle.sql','20260821042000_benefit_lifecycle.sql',
  '20260821043000_finance_lifecycle.sql',
  '20260821044000_channel_lifecycle.sql',
  '20260821045000_channel_scope_mapping.sql',
  '20260821046000_support_lifecycle.sql',
  '20260821047000_notification_lifecycle.sql',
  '20260821048000_reporting_lifecycle.sql',
  '20260821049000_risk_lifecycle.sql',
  '20260821050000_audit_lifecycle.sql',
  '20260821051000_extension_lifecycle.sql',
  '20260821052000_import_lifecycle.sql',
  '20260821053000_complete_batch_imports.sql',
  '20260821054000_move_membership_owner.sql',
  '20260821055000_isolate_wechat_payment_applications.sql',
  '20260821056000_authorize_member_data_scope.sql',
  '20260821057000_resolve_payment_webhook_scope.sql',
  '20260821058000_align_member_operations.sql',
  '20260821059000_reconcile_contract_head.sql',
  '20260821060000_rebind_membership_functions.sql',
  '20260821061000_normalize_membership_scopes.sql',
  '20260821062000_publish_error_contract.sql',
  '20260821063000_finalize_error_contract.sql',
  '20260821064000_add_client_error_telemetry.sql',
  '20260821065000_add_invitation_lifecycle.sql',
  '20260821066000_resolve_invitation_scope.sql',
  '20260821067000_add_session_management.sql',
  '20260821068000_add_member_benefit_ledger.sql',
  '20260821069000_add_store_management.sql',
  '20260821070000_repair_decision_audit_scope.sql',
  '20260821071000_grant_store_administration.sql',
  '20260821072000_add_console_member_commands.sql',
  '20260821073000_publish_console_contract.sql',
  '20260821074000_grant_platform_owner_operations.sql',
  '20260821075000_grant_platform_cardlibrary_read.sql',
  '20260821076000_grant_platform_cockpit_reads.sql',
  '20260821077000_add_reporting_cockpit.sql',
  '20260821078000_complete_experience_application.sql',
  '20260821079000_resolve_experience_version_scope.sql',
  '20260821080000_restore_member_scope_authorization.sql',
  '20260828091000_finance_reconciliation_integrity.sql',
  '20260828092000_finance_security_boundaries.sql',
  '20260828093000_finance_accounting_integrity.sql',
  '20260828094000_finance_invoice_issue_integrity.sql',
  '20260828095000_payment_provider_time_evidence.sql',
  '20260828100000_finance_reconciliation_repair_workflow.sql',
  '20260828170000_zhudatuan_registration_baseline.sql',
  '20260828173000_zhudatuan_web_business_access.sql',
  '20260828180000_zhudatuan_purchase_access.sql',
  '20260828183000_zhudatuan_runtime_readiness_repair.sql',
  '20260829040000_zhudatuan_registration_bootstrap_runtime_repair.sql',
  '20260829054500_zhudatuan_identity_login_acl_repair.sql',
  '20260829060000_zhudatuan_operator_invitation_registration.sql',
  '20260829105000_create_referral_foundation.sql',
  '20260829190000_reconcile_runtime_contract_head.sql',
  '20260829200000_owner_identity_reset_foundation.sql',
  '20260829201000_reconcile_current_contract_checksum.sql',
  '20260829210000_owner_operator_coverage.sql',
  '20260829211000_platform_owner_transfer.sql',
  '20260829212000_owner_runtime_boundary_hardening.sql',
  '20260829213000_reconcile_contract_identity_checksum.sql',
  '20260829214000_owner_personal_scope_and_invoice_scope.sql',
  '20260829215000_restore_invoice_request_operator_boundary.sql',
  '20260829216000_owner_capability_exactness.sql',
  '20260829217000_scope_hint_resource_precedence.sql',
  '20260830100000_finance_configurable_policy_workflow.sql',
  '20260830101000_console_support_boundary.sql',
  '20260830102000_grant_runtime_digest.sql',
  '20260830103000_identity_runtime_contract_visibility.sql',
  '20260830104000_business_runtime_role_matrix.sql',
  '20260830105000_business_runtime_schema_visibility.sql',
  '20260831100000_identity_finance_read_boundary.sql',
  '20260831110000_identity_distribution_channel_voucher_read_boundary.sql',
  '20260831120000_identity_reporting_read_boundary.sql',
  '20260831130000_identity_console_tail_read_boundary.sql',
  '20260831140000_identity_registration_profile_acl_repair.sql',
  '20260831150000_identity_experience_application_commands.sql',
  '20260901060000_zhudatuan_brand_display_names.sql',
  '20260901070000_identity_notification_challenge_jobs.sql',
  '20260901100000_access_identity_scope_assignments.sql',
  '20260901210000_restore_platform_owner_personal_scope_projection.sql',
  '20260901220000_add_payment_mall_identity.sql',
  '20260901221000_add_fulfillment_mall_identity.sql',
  '20260901222000_add_inventory_mall_identity.sql',
  '20260901223000_publish_mall_provisioning.sql',
  '20260902010000_restore_public_mall_role_contracts.sql',
  '20260902011000_enable_public_mall_external_payment.sql',
  '20260902012000_zhudatuan_mall_provisioning_access.sql',
  '20260902132000_canonical_governance_context.sql',
  '20260902133000_repair_console_support_scope_contract.sql',
  '20260902134000_senior_administrator_role.sql',
  '20260902135000_owner_identity_runtime_boundary.sql',
  '20260902136000_administrator_invitation_runtime_alignment.sql',
  '20260902137000_separate_login_account_from_mobile.sql',
  '20260902138000_fix_administrator_registration_role_boundary.sql',
  '20260902139000_add_member_invitation_records_read.sql',
  '20260902140000_align_senior_administrator_business_permissions.sql',
  '20260903100000_separate_operator_business_scope.sql',
  '20260903101000_allow_platform_owner_invitation_history.sql',
  '20260903102000_invitation_record_target_and_creator_scope.sql',
  '20260903103000_provision_l1_mall_owner.sql',
  '20260903104000_enable_provisioned_mall_registration.sql',
  '20260903105000_initialize_storefront_qualification.sql',
  '20260903106000_governance_invitation_tree_visibility.sql',
  '20260903107000_merge_storefront_and_governance_invitation_visibility.sql',
  '20260903108000_allow_existing_consumer_identity_registration.sql',
  '20260903110000_zhudatuan_payment_webhook_access.sql',
  '20260903111000_publish_canonical_guest_catalog.sql',
  '20260903112000_enable_l6_storefront_self_registration.sql',
  '20260904010000_allow_platform_owner_l6_registration.sql',
  '20260905010000_publish_runtime_catalog_alignment.sql',
  '20260905011000_expand_governance_store_scope.sql',
  '20260905012000_honor_invitation_scope_hint.sql',
  '20260905013000_registration_invite_role_projection.sql',
  '20260905014000_bind_storefront_browse_scope.sql',
  '20260905203000_provision_zhudatuan_storefront_application.sql',
  '20260906010000_add_l1_owner_role_and_named_scope.sql',
  '20260906011000_complete_l1_owner_runtime_head.sql',
  '20260907010000_enable_identity_catalog_commands.sql',
  '20260907110000_publish_storefront_member_directory.sql',
  '20260907113000_separate_l0_l1_auth_return_targets.sql',
  '20260907120000_create_identity_realm_accounts.sql',
  '20260907121000_scope_identity_lifecycle_by_realm.sql',
  '20260907122000_bind_sessions_tickets_to_realm_accounts.sql',
  '20260907123000_enforce_identity_node_profiles.sql',
  '20260908010000_canonicalize_sfl_identity_node_ids.sql',
  '20260908011000_canonicalize_sfl_identity_targets.sql',
  '20260908012000_create_sfl_login_intents.sql',
  '20260908013000_generalize_storefront_roles.sql',
  '20260909010000_bind_published_listings_to_storefront_pool.sql',
  '20260909061000_add_checkout_address_default.sql',
  '20260909062000_provision_autonode_identity_realm.sql',
  '20260909062500_reconcile_autonode_identity_migration_ledger.sql',
  '20260909063000_reprovision_disabled_autonode_identity_realm.sql',
  '20260909160000_route_identity_notifications_by_node.sql',
  '20260909203000_switch_l0_public_domain_to_fufu.sql',
  '20260909204000_reconcile_l0_public_domain_migration_ledger.sql',
  '20260911010000_add_storefront_member_custom_profile.sql',
  '20260911113000_order_participant_product_route_snapshot.sql',
  '20260911153500_allow_web_order_four_flow_read.sql',
  '20260911155000_allow_web_order_route_facts_read.sql',
  '20260911163000_allow_purchase_partner_agreement_read.sql',
  '20260911170000_project_authoritative_owner_to_node_console.sql',
  '20260911180000_allow_node_mall_operator_invitations.sql',
  '20260911190000_bind_operator_registration_to_realm_console.sql',
  '20260911200000_create_sfl_node_sovereignty.sql',
  '20260911210000_create_sfl_hosted_node_provisioning.sql',
  '20260912010000_create_sfl_node_context_scope.sql',
  '20260912020000_create_sfl_member_registration_progression.sql',
  '20260912030000_create_sfl_multi_realm_membership.sql',
  '20260912040000_create_sfl_hosted_mall_opening.sql',
  '20260912050000_create_sfl_sovereign_upgrade.sql',
  '20260912120000_create_zhudatuan_supplier_network.sql',
  '20260912130000_create_supplier_analytics_perspective.sql',
  '20260912140000_index_catalog_reverse_lookups.sql',
  '20260912150000_create_sfl_administrator_segment_scope.sql',
  '20260912170000_create_sfl_execution_contract_kernel.sql',
  '20260912180000_reconcile_identity_runtime_state.sql',
  '20260912181000_restore_identity_reconciliation_function_ownership.sql',
  '20260912182000_create_storefront_member_node_projection.sql',
  '20260912183000_fix_storefront_member_node_projection.sql',
  '20260912190000_create_supplier_four_flow_ledger.sql',
  '20260912200000_create_sfl_company_template_clone.sql',
  '20260912210000_catalog_media_replication_persistence.sql',
  '20260912220000_publish_storefront_member_context_projection.sql',
  '20260912230000_separate_permission_write_targets.sql',
  '20260912240000_bind_permission_reads_to_session_membership.sql',
  '20260912250000_grant_catalog_media_replication_job.sql',
  '20260913012500_restore_identity_context_resolver_execute.sql',
  '20260913013500_restore_identity_session_owner_execute.sql',
  '20260913014500_restore_storefront_member_context_owner.sql',
  '20260913015500_complete_senior_administrator_invitation_projection.sql',
  '20260913020500_backfill_hbbtzn_storefront_member_l6.sql',
  '20260913021500_align_purchase_supplier_flow_access.sql',
  '20260913021600_align_purchase_operation_completion_outbox.sql',
  '20260913022500_enable_hbbtzn_l2_h5_provisioning.sql',
  '20260913023000_enforce_sfl_vertical_level_adjacency.sql',
  '20260914090000_publish_autonode_task_operations.sql',
  '20260914150000_enable_console_support_case_creation.sql',
  '20260914151000_restore_sfl_parent_level_rules.sql',
  '20260914231500_add_support_message_visibility.sql',
  '20260915090000_restore_l1_supplier_trial_inventory.sql',
  '20260916123000_enable_console_support_review_attachments.sql',
  '20260916150000_add_identity_display_code_mapping.sql',
  '20260916160000_repair_identity_display_runtime_acl.sql',
];

const mode = process.argv[2];
if (!['--check-inventory','--schema-fresh','--environment-bootstrap','--inventory-cutover-unsafe','--postgres-fresh','--mvp-kernel','--identity-realm-isolation'].includes(mode)) {
  throw new Error('usage: database-contracts.mjs --check-inventory|--schema-fresh|--environment-bootstrap|--inventory-cutover-unsafe|--postgres-fresh|--mvp-kernel|--identity-realm-isolation [URL] [local-disposable-fixture]');
}
const replayRole = mode === '--postgres-fresh' ? process.argv[4] : undefined;
if (replayRole !== undefined && !/^[a-z][a-z0-9_]{2,62}$/.test(replayRole)) throw new Error('POSTGRES_FRESH_ROLE_INVALID');
if (mode === '--identity-realm-isolation' && process.argv[4] !== 'local-disposable-fixture') {
  throw new Error('IDENTITY_REALM_POSTGRES_FIXTURE_CONFIRMATION_REQUIRED');
}
if (mode === '--registration-boundary-postgres' && process.argv[4] !== 'local-disposable-fixture') {
  throw new Error('REGISTRATION_BOUNDARY_POSTGRES_FIXTURE_CONFIRMATION_REQUIRED');
}

const migrationFiles = (await readdir(MIGRATIONS)).filter((name) => name.endsWith('.sql')).sort();
await verifyInventory(migrationFiles);
if (mode === '--check-inventory') {
  console.log(`migration inventory ok: historical=94 repair=${REPAIR_FILES.length} total=${migrationFiles.length}`);
  process.exit(0);
}

if (mode === '--registration-boundary-postgres') {
  const database = await openDatabase();
  try {
    await verifyRegistrationBoundaryOnPostgres(database);
  } finally {
    await database.close();
  }
  console.log('registration boundary PostgreSQL replay passed: rds-like-deny=1 rds-like-allow=2 legacy-upgrade=1');
  process.exit(0);
}

const database = await openDatabase();
try {
  await execute(database, mode === '--identity-realm-isolation' ? `
    create role anon nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
    create role authenticated nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
    create role service_role nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
    create role shopapp login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
    create role shopconsole nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
    create role shopjob login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
    create role shopmigration login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
    create role shopread login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
    create role zhudatuanbootstrap login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
    create role zhudatuanconsoleapi login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
    create role zhudatuanidentityapi login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
    create role zhudatuanidentityjob login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
    create role zhudatuanpaymentwebhookapi nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
    create role zhudatuanprovisioningapi login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
    create role zhudatuanpurchaseapi login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
    create role zhudatuanroot login inherit superuser createdb createrole replication bypassrls;
    create role zhudatuansandboxbootstrap login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
    create role zhudatuanwebapi login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  ` : `
    create role anon nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
    create role authenticated nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
    create role service_role nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
    create role shopmigration nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
    create role zhudatuanbootstrap nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
    create role zhudatuanroot nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  `, 'database role bootstrap');
  if (mode === '--identity-realm-isolation') {
    await execute(database, `
      do $fixture$
      begin
        if current_database()<>'zhudatuan_registration' then
          raise exception 'IDENTITY_REALM_POSTGRES_DATABASE_INVALID';
        end if;
      end
      $fixture$;
      grant shopconsole to zhudatuanconsoleapi;
      grant shopapp,shopjob to shopmigration with inherit false,set true;
      alter database zhudatuan_registration owner to shopmigration;
      set role shopmigration;
    `, 'identity realm database owner bootstrap');
  } else if (replayRole !== undefined) {
    await execute(database, `set role "${replayRole}"`, 'database migration role');
  }
  await execute(database, `
    create schema supabase_migrations;
    create table supabase_migrations.schema_migrations(version text primary key,statements text[],name text);
  `, 'database bootstrap');
  let applied = 0;
  for (const name of migrationFiles) {
    if (mode === '--registration-fresh' && (name === BOOTSTRAP || name === OWNER_RECONCILIATION)) {
      await database.query('insert into supabase_migrations.schema_migrations(version,name) values($1,$2)', [
        name.slice(0, 14),
        `environment-omitted:${name}`,
      ]);
      applied += 1;
      continue;
    }
    if (mode === '--identity-realm-isolation'
      && name === '20260912181000_restore_identity_reconciliation_function_ownership.sql') {
      await execute(database, 'reset role; set role zhudatuanroot;', 'identity realm authority handoff');
    }
    if (name === BOOTSTRAP) {
      await seedDeploymentBoundary(database);
      await seedBootstrapPrecondition(database);
    }
    if (name === OWNER_FIXTURE_BOUNDARY) await seedOwnerGuardPrecondition(database);
    if (name === AUTONODE_TASK_OPERATION_PUBLICATION) await seedAutoNodeTaskOperationPrecondition(database);
    if (mode === '--inventory-cutover-unsafe' && name === INVENTORY_CUTOVER) {
      await seedUnsafeInventoryCutover(database);
      await assertUnsafeInventoryCutoverRejected(database, await readFile(join(MIGRATIONS,name),'utf8'));
      console.log(`unsafe inventory cutover rejected atomically: migrations_before_cutover=${applied}`);
      process.exitCode = 0;
      break;
    }
    if (name === SECURE_STAGE) await stageFreshReplaySecrets(database);
    await execute(database, await readFile(join(MIGRATIONS,name),'utf8'), `migration ${name}`);
    const selfRecorded = await database.query(
      'select name from supabase_migrations.schema_migrations where version=$1',
      [name.slice(0,14)],
    );
    if (selfRecorded.rows.length > 0) {
      if (selfRecorded.rows.length !== 1 || selfRecorded.rows[0]?.name !== name) {
        throw new Error(`SELF_RECORDED_MIGRATION_LEDGER_INVALID:${name}`);
      }
    } else if (name === AUTONODE_IDENTITY_POST_HISTORY || name === L0_PUBLIC_DOMAIN_POST_HISTORY) {
      await database.query(
        'insert into supabase_migrations.schema_migrations(version,name,statements) values($1,$2,$3)',
        [name.slice(0,14),name,name === AUTONODE_IDENTITY_POST_HISTORY
          ? AUTONODE_IDENTITY_POST_HISTORY_STATEMENTS
          : L0_PUBLIC_DOMAIN_POST_HISTORY_STATEMENTS],
      );
    } else {
      await database.query('insert into supabase_migrations.schema_migrations(version,name) values($1,$2)', [name.slice(0,14),name]);
    }
    applied += 1;
  }
  if (mode !== '--inventory-cutover-unsafe') {
    if (mode === '--registration-fresh') await reconcileRegistrationReplayBoundary(database);
    await verifyTarget(database);
    if (mode === '--mvp-kernel') {
      const { verifyMvpKernel } = await import('./mvp-kernel.mjs');
      await verifyMvpKernel(database);
    }
    if (mode === '--identity-realm-isolation') {
      const { verifyIdentityRealmIsolation } = await import('./identity-realm-isolation.mjs');
      const evidencePath = process.env.E12_DATABASE_EVIDENCE_PATH;
      const evidence = await verifyIdentityRealmIsolation(database, { collectEvidence: evidencePath !== undefined });
      if (evidencePath !== undefined) {
        if (evidence === null) throw new Error('IDENTITY_REALM_EVIDENCE_NOT_COLLECTED');
        await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
      }
      console.log('identity realm isolation passed: nodes=L0-L11 profiles=operating_mall:6,consumer:6 accounts=12 l0-l1-surfaces=4 cross-host=0 login-intent=issue/wrong-target/consume/replay password-scope=pass logout-scope=pass node-lifecycle=2');
    }
    console.log(`target schema replay passed: migrations=${applied} historical=94 repair=${REPAIR_FILES.length}`);
  }
} finally {
  await database.close();
}

async function openDatabase() {
  if (mode === '--registration-fresh') {
    const cluster = new PGlite();
    await cluster.exec('create database zhudatuan_registration');
    const data = await cluster.dumpDataDir('none');
    await cluster.close();
    return new PGlite({ database: 'zhudatuan_registration', loadDataDir: data, extensions: { pgcrypto } });
  }
  if (mode !== '--postgres-fresh' && mode !== '--registration-boundary-postgres' && mode !== '--identity-realm-isolation') {
    return new PGlite({ extensions: { pgcrypto } });
  }
  const connectionString = process.argv[3];
  if (connectionString !== undefined && !/^postgres(?:ql)?:\/\//.test(connectionString)) throw new Error('POSTGRES_FRESH_URL_INVALID');
  if (mode === '--identity-realm-isolation' && connectionString === undefined) {
    throw new Error('IDENTITY_REALM_POSTGRES_URL_REQUIRED');
  }
  if (mode === '--registration-boundary-postgres' && connectionString === undefined) {
    throw new Error('REGISTRATION_BOUNDARY_POSTGRES_URL_REQUIRED');
  }
  const client = new Client({ ...(connectionString === undefined ? {} : { connectionString }), connectionTimeoutMillis: 5_000, statement_timeout: 120_000 });
  await client.connect();
  return Object.freeze({
    exec: async (sql) => { await client.query(sql); },
    query: (sql, parameters) => client.query(sql, parameters),
    close: () => client.end(),
  });
}

async function verifyInventory(files) {
  const duplicates = duplicateVersions(files);
  if (duplicates.size) throw new Error(`duplicate migration versions: ${JSON.stringify([...duplicates])}`);
  const history = JSON.parse(await readFile(HISTORY,'utf8'));
  if (history.algorithm!=='sha256' || history.count!==94 || history.migrations.length!==94) throw new Error('HISTORICAL_MIGRATION_MANIFEST_INVALID');
  const historical = files.filter((name)=>name.slice(0,14)<=history.head);
  if (JSON.stringify(historical)!==JSON.stringify(history.migrations.map((item)=>item.file))) throw new Error('HISTORICAL_MIGRATION_FILESET_DRIFT');
  for (const item of history.migrations) {
    const digest = createHash('sha256').update(await readFile(join(MIGRATIONS,item.file))).digest('hex');
    if (digest!==item.sha256) throw new Error(`HISTORICAL_MIGRATION_HASH_DRIFT:${item.file}`);
  }
  const repair = files.filter((name)=>name.slice(0,14)>history.head);
  if (JSON.stringify(repair)!==JSON.stringify(REPAIR_FILES)) throw new Error(`REPAIR_MIGRATION_SEQUENCE_DRIFT:${JSON.stringify(repair)}`);
  await readFile(OBJECTS,'utf8').catch(()=>{ throw new Error('DATABASE_OBJECT_CONTRACT_MISSING'); });
}

function duplicateVersions(files) {
  const versions = new Map();
  for (const file of files) {
    const match = /^(\d{14})_[a-z0-9_]+\.sql$/.exec(file);
    if (!match) throw new Error(`INVALID_MIGRATION_FILENAME:${file}`);
    const existing = versions.get(match[1]) ?? [];
    existing.push(file); versions.set(match[1],existing);
  }
  return new Map([...versions].filter(([,names])=>names.length>1));
}

async function execute(database,sql,label) {
  try { await database.exec(sql); }
  catch (error) { throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`,{cause:error}); }
}

async function seedBootstrapPrecondition(database) {
  await execute(database, `insert into public.users(id,tenant_id,enterprise_id,department_id,employee_no,display_name,email,status)
    values('user-fresh-replay-ethan','tenant-smart-wing','enterprise-demo','department-digital','SW_FRESH_REPLAY_ETHAN','Fresh Replay Ethan','fresh-replay@example.invalid','active');
    insert into public.members(id,user_id,primary_identifier,status) values('member-fresh-replay-ethan','user-fresh-replay-ethan','local_username:ethan','active');
    insert into public.member_login_aliases(provider,subject,member_id) values('local_username','ethan','member-fresh-replay-ethan');`,'bootstrap precondition');
}

async function seedDeploymentBoundary(database) {
  await execute(database, `
    create schema if not exists deployment authorization shopmigration;
    alter schema deployment owner to shopmigration;
    create table if not exists deployment.boundary(
      id text primary key,
      database_name text not null,
      sentinel_hash char(64) not null check(sentinel_hash~'^[0-9a-f]{64}$'),
      created_at timestamptz not null default clock_timestamp()
    );
    alter table deployment.boundary owner to shopmigration;
    revoke all on deployment.boundary from public;
    insert into deployment.boundary(id,database_name,sentinel_hash)
    values('zhudatuan-registration-v1',current_database(),repeat('0',64));
    create or replace function deployment.registration_bootstrap_boundary(p_sentinel text)
    returns boolean language sql stable security definer
    set search_path=pg_catalog,deployment as $function$
      select current_database()='zhudatuan_registration'
        and session_user='zhudatuanbootstrap'
        and exists(select 1 from deployment.boundary
          where id='zhudatuan-registration-v1' and database_name=current_database()
            and sentinel_hash=encode(pg_catalog.sha256(pg_catalog.convert_to(p_sentinel,'UTF8')),'hex'))
    $function$;
    create or replace function deployment.is_independent_registration_database()
    returns boolean language sql stable security definer
    set search_path=pg_catalog,deployment as $function$
      select current_database()='zhudatuan_registration'
        and exists(select 1 from deployment.boundary
          where id='zhudatuan-registration-v1' and database_name=current_database())
    $function$;
    alter function deployment.registration_bootstrap_boundary(text) owner to shopmigration;
    alter function deployment.is_independent_registration_database() owner to shopmigration;
    revoke all on function deployment.registration_bootstrap_boundary(text) from public;
    revoke all on function deployment.is_independent_registration_database() from public;
    grant usage on schema deployment to zhudatuanbootstrap,shopmigration;
    grant execute on function deployment.registration_bootstrap_boundary(text) to zhudatuanbootstrap,shopmigration;
    grant execute on function deployment.is_independent_registration_database() to shopmigration;
  `, 'deployment boundary bootstrap');
}

async function seedOwnerGuardPrecondition(database) {
  await execute(database, `do $fixture$
  begin
    if not exists(
      select 1 from access.membership membership
      join access.membershiprole assignment on assignment.membership_id=membership.id
      where membership.id='membership-platform-owner-ethan-v1'
        and assignment.role_id='role-platform-owner-v2' and membership.status='active'
        and assignment.effective_at<=clock_timestamp()
        and (assignment.expires_at is null or assignment.expires_at>clock_timestamp())
    ) then
      insert into identity.principal(id,status,credential_version,created_at,updated_at,version)
      values('principal:zhudatuan:owner:ethan:v1','active',1,clock_timestamp(),clock_timestamp(),0)
      on conflict(id) do update set status='active',updated_at=excluded.updated_at;
      insert into member.profile(id,principal_id,display_name,status,created_at,updated_at,version)
      values('member:zhudatuan:owner:ethan:v1','principal:zhudatuan:owner:ethan:v1','Database Replay Owner','active',clock_timestamp(),clock_timestamp(),0)
      on conflict(id) do update set principal_id=excluded.principal_id,status='active',updated_at=excluded.updated_at;
      insert into identity.credential(
        id,principal_id,provider,subject_hash,subject_ciphertext,subject_key_version,secret_hash,encrypted_secret,
        status,rotated_at,created_at
      ) values(
        'credential:password:zhudatuan-owner-ethan:v1','principal:zhudatuan:owner:ethan:v1','password',repeat('a',64),null,null,
        'scrypt$v1$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA$BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
        null,'active',clock_timestamp(),clock_timestamp()
      ) on conflict(id) do update set principal_id=excluded.principal_id,status='active';
      insert into access.membership(id,member_id,organization_id,client,status,access_version,joined_at)
      values('membership-platform-owner-ethan-v1','member:zhudatuan:owner:ethan:v1','tenant-zhudatuan','operator','active',1,clock_timestamp())
      on conflict(id) do update set member_id=excluded.member_id,organization_id=excluded.organization_id,
        client='operator',status='active',access_version=greatest(access.membership.access_version,1),left_at=null;
      delete from access.membershiprole where membership_id='membership-platform-owner-ethan-v1';
      insert into access.membershiprole(membership_id,role_id,effective_at) values
        ('membership-platform-owner-ethan-v1','role-platform-owner-v2','1970-01-01T00:00:00Z'),
        ('membership-platform-owner-ethan-v1','role:self','1970-01-01T00:00:00Z');
      delete from access.scopegrant where membership_id='membership-platform-owner-ethan-v1';
      insert into access.scopegrant(id,membership_id,scope_kind,scope_id,scope_path,effect,effective_at,access_version) values
        ('scope:database-replay-owner:v1:platform','membership-platform-owner-ethan-v1','platform','organization-platform-root','organization-platform-root','allow','1970-01-01T00:00:00Z',1),
        ('scope:database-replay-owner:v1:tenant','membership-platform-owner-ethan-v1','tenant','tenant-zhudatuan','tenant-zhudatuan','allow','1970-01-01T00:00:00Z',1),
        ('scope:database-replay-owner:v1:self','membership-platform-owner-ethan-v1','self','self:principal:zhudatuan:owner:ethan:v1','self:principal:zhudatuan:owner:ethan:v1','allow','1970-01-01T00:00:00Z',1);
    end if;
  end
  $fixture$;`,'owner guard precondition');
}

async function seedAutoNodeTaskOperationPrecondition(database) {
  await execute(database, `
    insert into organization.organization(id,kind,parent_id,name,timezone,status,version,created_at,updated_at)
    values(
      'mall:d1708f04df2dd8a61736852c4900fb43','mall','enterprise-zhudatuan','宏泰甄选',
      'Asia/Shanghai','active',0,'1970-01-01T00:00:00Z','1970-01-01T00:00:00Z'
    ) on conflict(id) do nothing;
    insert into organization.unitclosure(ancestor_id,descendant_id,depth) values
      ('mall:d1708f04df2dd8a61736852c4900fb43','mall:d1708f04df2dd8a61736852c4900fb43',0),
      ('enterprise-zhudatuan','mall:d1708f04df2dd8a61736852c4900fb43',1),
      ('tenant-zhudatuan','mall:d1708f04df2dd8a61736852c4900fb43',2),
      ('organization-platform-root','mall:d1708f04df2dd8a61736852c4900fb43',3)
    on conflict(ancestor_id,descendant_id) do nothing;
  `, 'autonode task operation precondition');
}

async function stageFreshReplaySecrets(database) {
  await execute(database, `insert into runtime.vouchersecretstage(voucher_id,code_ciphertext,code_fingerprint,key_version,staged_at)
    select id,'fixturekms:v1:'||encode(digest(voucher_code,'sha256'),'base64'),encode(digest(lower(voucher_code),'sha256'),'hex'),'fixture-v1',created_at
    from public.vouchers on conflict(voucher_id) do nothing;
    insert into runtime.partneraddressstage(store_id,address_ciphertext,address_token,key_version,staged_at)
    select id,'fixturekms:v1:'||encode(digest(address_text,'sha256'),'base64'),encode(digest(lower(address_text),'sha256'),'hex'),'fixture-v1',created_at
    from public.stores where address_text is not null on conflict(store_id) do nothing;
    insert into runtime.distributorcontactstage(distributor_id,contact_ciphertext,contact_token,key_version,staged_at)
    select id,'fixturekms:v1:'||encode(digest(contact_json::text,'sha256'),'base64'),encode(digest(contact_json::text,'sha256'),'hex'),'fixture-v1',created_at
    from public.distributors where contact_json<>'{}'::jsonb on conflict(distributor_id) do nothing;`,'secure fixture stage');
}

async function seedUnsafeInventoryCutover(database) {
  await execute(database, `do $$ begin update public.inventory set reserved_qty=greatest(reserved_qty,1); if not found then raise exception 'UNSAFE_INVENTORY_FIXTURE_MISSING'; end if; end $$;`,'unsafe inventory fixture');
}

async function assertUnsafeInventoryCutoverRejected(database,sql) {
  try { await database.exec(sql); }
  catch (error) {
    if (!String(error instanceof Error?error.message:error).includes('INVENTORY_CUTOVER_RECONCILIATION_REQUIRED')) throw error;
    if ((await database.query("select to_regclass('inventory.cutover_reviews') is not null as leaked")).rows[0].leaked) throw new Error('UNSAFE_INVENTORY_CUTOVER_PARTIAL_COMMIT');
    return;
  }
  throw new Error('UNSAFE_INVENTORY_CUTOVER_UNEXPECTEDLY_SUCCEEDED');
}

async function verifyTarget(database) {
  const operationContract = parse(await readFile(join(ROOT,'01_core_hexin','packages','contract','definitions','operations.yml'),'utf8'));
  const eventContract = parse(await readFile(join(ROOT,'01_core_hexin','packages','contract','definitions','events.yml'),'utf8'));
  const expectedOperations = Array.isArray(operationContract?.operations)
    ? operationContract.operations.filter((operation) => operation.availability !== 'frozen').length
    : -1;
  const expectedEvents = Array.isArray(eventContract?.events) ? eventContract.events.length : -1;
  const result = await database.query(`select
    (select count(*)::integer from runtime.operation) operations,
    (select count(*)::integer from runtime.event) events,
    (select count(*)::integer from pg_tables where schemaname='public') public_tables,
    (select count(*)::integer from supabase_migrations.schema_migrations) migrations`);
  const row=result.rows[0];
  if (row.operations!==expectedOperations || row.events!==expectedEvents || row.public_tables!==0 || row.migrations!==migrationFiles.length) throw new Error(`TARGET_CATALOG_INVALID:${JSON.stringify(row)}`);
  await verifyObjectContract(database);
  await verifyRls(database);
  await verifyAuditImmutability(database);
  await verifyExperiencePublication(database);
  await verifyExtensionLifecycle(database);
}

async function verifyExtensionLifecycle(database) {
  const hash='c'.repeat(64);
  const manifest=JSON.stringify({id:'replayprovider',kind:'channel',priority:1,version:'1.0.0',apiVersion:'2026-08-21',
    contractVersion:'replay.v1',healthOperation:'local',capabilities:['Catalog'],permissions:[],configSchema:'replay.v1',
    eventSubscriptions:[],secretRefs:[],limits:{connectionTimeoutMs:1,responseTimeoutMs:1,totalDeadlineMs:1,maxConcurrency:1,
      requestsPerSecond:1,maxAttempts:1,failureThreshold:1,recoveryMs:100},signature:'c2lnbmVk'});
  await database.query(`insert into extension.manifest(id,version,kind,contract_version,manifest,manifest_hash,signature,registered_at)
    values('replayprovider','1.0.0','channel','replay.v1',$1::jsonb,$2,'c2lnbmVk',clock_timestamp());`,[manifest,hash]);
  await database.exec(`insert into extension.contractversion(extension_id,contract_version,schema_hash,status)
    values('replayprovider','replay.v1','${hash}','verified');
    insert into extension.installation(id,extension_id,extension_version,scope_id,status,manifest,base_url,endpoints,secret_ref,health_operation,installed_at)
    values('extension:replay-active','replayprovider','1.0.0','rls-scope-a','enabled','${manifest}'::jsonb,'https://replay.invalid','{"local":"/health"}','secret/replay','local',clock_timestamp()),
      ('extension:replay-candidate','replayprovider','1.0.0','rls-scope-a','testing','${manifest}'::jsonb,'https://replay.invalid','{"local":"/health"}','secret/replay','local',clock_timestamp());`);
  let uniqueRejected=false;
  try { await database.exec("update extension.installation set status='enabled' where id='extension:replay-candidate'"); }
  catch (error) { if (!String(error instanceof Error?error.message:error).toLowerCase().includes('unique')) throw error; uniqueRejected=true; }
  if (!uniqueRejected) throw new Error('EXTENSION_SINGLE_ACTIVE_CONSTRAINT_MISSING');
  await database.exec(`begin; set local role shopapp; select set_config('app.workload','api',true),
    set_config('app.scope_id','rls-scope-a',true),set_config('app.actor_id','extension-auditor',true);`);
  const visible=await database.query("select id from extension.load_installation('extension:replay-candidate','rls-scope-a')");
  const manifestVisible=await database.query("select count(*)::integer count from extension.manifest where id='replayprovider'");
  await database.exec('commit');
  if (visible.rows[0]?.id!=='extension:replay-candidate' || manifestVisible.rows[0]?.count!==1) throw new Error('EXTENSION_SCOPE_POLICY_INVALID');
  let mutationRejected=false;
  await database.exec(`begin; set local role shopapp; select set_config('app.workload','api',true),set_config('app.scope_id','rls-scope-a',true);`);
  try { await database.query("update extension.manifest set signature='forged' where id='replayprovider'"); }
  catch (error) { if (!String(error instanceof Error?error.message:error).toLowerCase().includes('permission')) throw error; mutationRejected=true; }
  await database.exec('rollback');
  if (!mutationRejected) throw new Error('EXTENSION_MANIFEST_MUTATION_ALLOWED');
}

async function verifyAuditImmutability(database) {
  const hash='b'.repeat(64);
  await database.exec(`insert into audit.record(id,scope_id,actor_id,actor_type,action,resource_type,resource_id,before_hash,after_hash,
    evidence,trace_id,previous_hash,record_hash,recorded_at) values('audit:immutability','organization-platform-root','audit-test','system',
    'audit.test','audit','audit:immutability',null,null,'{}','audit:test',null,'${hash}',clock_timestamp());`);
  await database.exec(`begin; set local role shopapp; select set_config('app.workload','api',true),
    set_config('app.scope_id','organization-platform-root',true);`);
  let rejected=false; let changed=0;
  try { changed=(await database.query("update audit.record set action='mutated' where id='audit:immutability'")).rowCount ?? 0; }
  catch (error) {
    if (!String(error instanceof Error?error.message:error).includes('AUDIT_IMMUTABLE')) throw error;
    rejected=true;
  }
  await database.exec('rollback');
  if (!rejected && changed!==0) throw new Error('AUDIT_UPDATE_WAS_NOT_REJECTED');
  const unchanged=await database.query("select action from audit.record where id='audit:immutability'");
  if (unchanged.rows[0]?.action!=='audit.test') throw new Error('AUDIT_UPDATE_IMMUTABILITY_INVALID');
  await database.exec(`begin; set local role shopjob; select set_config('app.workload','jobs',true),set_config('app.audit_archive','true',true);
    delete from audit.record where id='audit:immutability'; commit;`);
  const deleted=await database.query("select count(*)::integer count from audit.record where id='audit:immutability'");
  if (deleted.rows[0]?.count!==0) throw new Error('AUDIT_ARCHIVE_DELETE_INVALID');
}

async function verifyExperiencePublication(database) {
  const hash = 'a'.repeat(64);
  await database.exec(`insert into experience.application(id,scope_id,code,public_slug,name,status,created_at,updated_at) values
    ('application:publication-audit','scope-publication-audit','PUBLICATION_AUDIT','publication-audit','Publication audit','active',clock_timestamp(),clock_timestamp());
    insert into experience.version(id,application_id,sequence,schema_version,configuration,configuration_hash,validation_state,reason,created_by,created_at) values
    ('version:publication-audit','application:publication-audit',1,'2','{"version":2,"application":"application:publication-audit","pages":[{"id":"home","path":"/","blocks":[]}]}',
      '${hash}','valid','publication audit fixture','audit',clock_timestamp());
    update experience.application set head_version_id='version:publication-audit' where id='application:publication-audit';
    insert into experience.release(id,application_id,version_id,state,effective_at,published_by) values
    ('release:publication-audit','application:publication-audit','version:publication-audit','active',clock_timestamp(),'audit');
    insert into experience.binding(application_id,domain,mall_id,pool_id) values
    ('application:publication-audit','audit.invalid','mall:publication-audit','pool:publication-audit');
    insert into experience.publication(id,release_id,application_id,version_id,content_hash,object_key,object_ref,object_hash,object_size,state,staged_at,published_at) values
    ('publication:audit','release:publication-audit','application:publication-audit','version:publication-audit','${hash}',
      'experience/application:publication-audit/${hash}.json','object:publication-audit','${hash}',1,'active',clock_timestamp(),clock_timestamp());`);
  await database.exec(`begin; set local role shopapp; select set_config('app.workload','api',true),set_config('app.scope_id','public:experience',true);`);
  const direct = await database.query("select count(*)::integer count from experience.publication where id='publication:audit'");
  const published = await database.query("select release,version,hash,object_key from experience.read_published('mall:publication-audit')");
  await database.exec('commit');
  if (direct.rows[0]?.count !== 0 || published.rows[0]?.release !== 'release:publication-audit' || published.rows[0]?.hash !== hash) {
    throw new Error('EXPERIENCE_PUBLICATION_SECURITY_INVALID');
  }
}

async function verifyRls(database) {
  await database.exec(`insert into risk.policy(id,scope_id,name,status,next_version,updated_at) values
    ('rls-policy-a','rls-scope-a','RLS A','draft',1,clock_timestamp()),('rls-policy-b','rls-scope-b','RLS B','draft',1,clock_timestamp());`);
  await database.exec(`begin; set local role shopapp;
    select set_config('app.workload','api',true),set_config('app.scope_id','rls-scope-a',true),set_config('app.actor_id','rls-auditor',true);`);
  const visible = await database.query("select array_agg(id order by id) ids from risk.policy where id like 'rls-policy-%'");
  await database.exec('commit');
  if (JSON.stringify(visible.rows[0]?.ids)!==JSON.stringify(['rls-policy-a'])) throw new Error('RLS_SCOPE_READ_ISOLATION_INVALID');
  await database.exec(`begin; set local role shopapp;
    select set_config('app.workload','api',true),set_config('app.scope_id','rls-scope-a',true),set_config('app.actor_id','rls-auditor',true);`);
  try {
    await database.query("insert into risk.policy(id,scope_id,name,status,next_version,updated_at) values('rls-policy-forbidden','rls-scope-b','forbidden','draft',1,clock_timestamp())");
  } catch (error) {
    await database.exec('rollback');
    if (!String(error instanceof Error ? error.message : error).toLowerCase().includes('row-level security')) throw error;
    return;
  }
  await database.exec('rollback');
  throw new Error('RLS_SCOPE_WRITE_ISOLATION_INVALID');
}

async function verifyObjectContract(database) {
  const contract = parse(await readFile(OBJECTS, 'utf8'));
  const entries = Array.isArray(contract?.objects) ? contract.objects : [];
  const schemas = entries.filter((entry) => entry.kind === 'schema').map((entry) => entry.id).sort();
  const tableEntries = entries.filter((entry) => entry.kind === 'table');
  const expectedTableRls = new Map(tableEntries.map((entry) => [entry.id, entry.rls === true]));
  const grantRoles = [...new Set(entries.filter((entry) => entry.kind === 'grant').map((entry) => entry.role))].sort();
  const expected = new Map([
    ['schema', new Set(schemas)],
    ['table', new Set(tableEntries.map((entry) => entry.id))],
    ['view', new Set(entries.filter((entry) => entry.kind === 'view').map((entry) => entry.id))],
    ['function', new Set(entries.filter((entry) => entry.kind === 'function').map((entry) => entry.id))],
    ['trigger', new Set(entries.filter((entry) => entry.kind === 'trigger').map((entry) => entry.id))],
    ['policy', new Set(entries.filter((entry) => entry.kind === 'policy').map((entry) => entry.id))],
    ['grant', new Set(entries.filter((entry) => entry.kind === 'grant').map((entry) => entry.id))],
  ]);
  if (mode === '--registration-fresh') {
    for (const id of [
      'access.membership.zhudatuanregistrationboundary_runtime_guard',
      'access.membershiprole.zhudatuanregistrationboundary_runtime_guard',
      'access.role.zhudatuanregistrationboundary_runtime_guard',
      'runtime.schemaversion.zhudatuanregistrationboundary_runtime_guard',
    ]) expected.get('policy').add(id);
  }
  const schemaRows = await database.query('select schema_name id from information_schema.schemata where schema_name=any($1::text[])', [schemas]);
  const tableRows = await database.query(`select namespace.nspname||'.'||relation.relname id,relation.relrowsecurity rls
    from pg_class relation join pg_namespace namespace on namespace.oid=relation.relnamespace
    where namespace.nspname=any($1::text[]) and relation.relkind in('r','p')`, [schemas]);
  const viewRows = await database.query(`select namespace.nspname||'.'||relation.relname id from pg_class relation
    join pg_namespace namespace on namespace.oid=relation.relnamespace
    where namespace.nspname=any($1::text[]) and relation.relkind in('v','m')`, [schemas]);
  const functionRows = await database.query(`select namespace.nspname||'.'||procedure.proname id from pg_proc procedure
    join pg_namespace namespace on namespace.oid=procedure.pronamespace where namespace.nspname=any($1::text[])`, [schemas]);
  const triggerRows = await database.query(`select namespace.nspname||'.'||relation.relname||'.'||trigger.tgname id from pg_trigger trigger
    join pg_class relation on relation.oid=trigger.tgrelid join pg_namespace namespace on namespace.oid=relation.relnamespace
    where not trigger.tgisinternal and namespace.nspname=any($1::text[])`, [schemas]);
  const policyRows = await database.query(`select schemaname||'.'||tablename||'.'||policyname id from pg_policies where schemaname=any($1::text[])`, [schemas]);
  compareSet('schema', expected.get('schema'), schemaRows.rows.map((row) => row.id));
  compareSet('table', expected.get('table'), tableRows.rows.map((row) => row.id));
  compareSet('view', expected.get('view'), viewRows.rows.map((row) => row.id));
  compareSet('function', expected.get('function'), functionRows.rows.map((row) => row.id));
  compareSet('trigger', expected.get('trigger'), triggerRows.rows.map((row) => row.id));
  compareSet('policy', expected.get('policy'), policyRows.rows.map((row) => row.id));
  const tableRlsDrift = tableRows.rows
    .filter((row) => expectedTableRls.get(row.id) !== row.rls)
    .map((row) => ({ id: row.id, expected: expectedTableRls.get(row.id), actual: row.rls }));
  if (tableRlsDrift.length) throw new Error(`DATABASE_OBJECT_RLS_DRIFT:${JSON.stringify(tableRlsDrift)}`);

  const roleRows = await database.query(`with roles(role) as (select unnest($2::text[])),
    table_privilege(privilege) as (values('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')),
    schema_privilege(privilege) as (values('USAGE'),('CREATE')),
    schemas as (select namespace.nspname schema,namespace.nspowner::regrole::text owner
      from pg_namespace namespace where namespace.nspname=any($1::text[])),
    tables as (select schemaname,tablename,tableowner owner from pg_tables where schemaname=any($1::text[])),
    views as (select schemaname,viewname,viewowner owner from pg_views where schemaname=any($1::text[])),
    functions as (select procedure.oid,procedure.oid::regprocedure::text signature,procedure.proowner::regrole::text owner
      from pg_proc procedure join pg_namespace namespace on namespace.oid=procedure.pronamespace where namespace.nspname=any($1::text[]))
    select role||':schema:'||schema||':'||lower(privilege) id from roles cross join schemas cross join schema_privilege
      where role<>owner and has_schema_privilege(role,schema,privilege)
    union all
    select role||':table:'||schemaname||'.'||tablename||':'||lower(privilege) from roles cross join tables cross join table_privilege
      where role<>owner and has_table_privilege(role,schemaname||'.'||tablename,privilege)
    union all
    select role||':view:'||schemaname||'.'||viewname||':'||lower(privilege) from roles cross join views cross join table_privilege
      where role<>owner and has_table_privilege(role,schemaname||'.'||viewname,privilege)
    union all
    select role||':function:'||replace(signature,' ','')||':execute' from roles cross join functions
      where role<>owner and has_function_privilege(role,oid,'EXECUTE')`, [schemas,grantRoles]);
  compareSet('grant', expected.get('grant'), roleRows.rows.map((row) => row.id));
}

function compareSet(kind, expected, actualValues) {
  const actual = new Set(actualValues);
  const missing = [...expected].filter((value) => !actual.has(value)).sort();
  const extra = [...actual].filter((value) => !expected.has(value)).sort();
  if (missing.length || extra.length) throw new Error(`DATABASE_OBJECT_${kind.toUpperCase()}_DRIFT:${JSON.stringify({ missing, extra })}`);
}
