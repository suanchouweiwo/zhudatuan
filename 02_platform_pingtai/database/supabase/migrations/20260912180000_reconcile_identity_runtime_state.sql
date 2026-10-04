begin;

select pg_advisory_xact_lock(hashtext('identity:runtime-reconciliation:v1'));

create or replace function identity.project_member_realm_targets()
returns trigger
language plpgsql security definer
set search_path=pg_catalog,pg_temp as $function$
begin
  insert into identity.realmtarget(
    realm_id,surface,target,membership_client,membership_organization_id,application_slug,
    return_origin,created_at,node_profile
  )
  select new.realm_id,target.surface,target.target,target.membership_client,target.membership_organization_id,
    target.application_slug,target.return_origin,clock_timestamp(),'consumer'
  from identity.realm entry_realm
  join identity.realmtarget target on target.realm_id=entry_realm.id and target.surface='consumer'
  where entry_realm.node_id=new.registration_host_node_id
  on conflict(realm_id,target) do nothing;
  return new;
end
$function$;

drop trigger if exists identity_project_member_realm_targets on organization.membernoderegistration;
create trigger identity_project_member_realm_targets
after insert on organization.membernoderegistration
for each row execute function identity.project_member_realm_targets();

insert into identity.realmtarget(
  realm_id,surface,target,membership_client,membership_organization_id,application_slug,
  return_origin,created_at,node_profile
)
select registration.realm_id,target.surface,target.target,target.membership_client,target.membership_organization_id,
  target.application_slug,target.return_origin,clock_timestamp(),'consumer'
from organization.membernoderegistration registration
join identity.realm entry_realm on entry_realm.node_id=registration.registration_host_node_id
join identity.realmtarget target on target.realm_id=entry_realm.id and target.surface='consumer'
on conflict(realm_id,target) do nothing;

alter function identity.realm_contains_account_realm(text,text) owner to shopmigration;
alter function identity.project_member_realm_targets() owner to shopmigration;
alter function identity.resolve_active_membership_context(text,text,text) owner to shopmigration;
alter function identity.resolve_session(text,text) owner to zhudatuanroot;

revoke all on function identity.realm_contains_account_realm(text,text) from public;
revoke all on function identity.project_member_realm_targets() from public;
revoke all on function identity.resolve_active_membership_context(text,text,text) from public;
revoke all on function identity.resolve_session(text,text) from public;
grant execute on function identity.realm_contains_account_realm(text,text),
  identity.resolve_active_membership_context(text,text,text)
  to shopapp,zhudatuanidentityapi,shopconsole,zhudatuanwebapi,zhudatuanpurchaseapi,zhudatuanprovisioningapi;
grant execute on function identity.resolve_session(text,text)
  to shopapp,zhudatuanidentityapi,shopconsole,zhudatuanwebapi,zhudatuanpurchaseapi,zhudatuanprovisioningapi;

create index if not exists catalog_sku_product_lookup
  on catalog.sku(product_id,id);
create index if not exists catalog_listing_sku_scope_lookup
  on catalog.listing(sku_id,scope_id);
create index if not exists catalog_source_listing_sku_scope_lookup
  on catalog.sourcelisting(sku_id,scope_id)
  where sku_id is not null;

insert into runtime.schemaversion(version,checksum)
values('20260912030000','697017d7e4f14820baa7be131b8f894fd62c9389795ad4d2989ae2560810f0a0')
on conflict(version) do update set checksum=excluded.checksum;

delete from runtime.schemaversion
where version='20260912160000'
  and checksum='81529c7f539d1204f7834fc8d42bc6a6c8099fe3c34143c931a5553cf88667e6';

insert into runtime.schemaversion(version,checksum)
values('20260912180000','7df38af5586b26b2bf2343a0961ed5e336faffad87f6f4e3b45035186ae4dd46');

insert into supabase_migrations.schema_migrations(version,statements,name) values
('20260911163000',array['profile=registration-reconciled/v1','source_sha256=1f53d2f77738e75b7bed6a71f64a8c790426ed99f2db76e27bf05fc85b3508d9','repair=20260912180000_reconcile_identity_runtime_state.sql','reason=production runtime objects reconciled from verified existing state'],'registration-reconciled:20260911163000_allow_purchase_partner_agreement_read.sql'),
('20260911170000',array['profile=registration-reconciled/v1','source_sha256=601ede38daf28edf9c1bb5fe8670927982dd2e2dbdfe9b1554631dec82496557','repair=20260912180000_reconcile_identity_runtime_state.sql','reason=production runtime objects reconciled from verified existing state'],'registration-reconciled:20260911170000_project_authoritative_owner_to_node_console.sql'),
('20260911180000',array['profile=registration-reconciled/v1','source_sha256=7a4d8bd18406b731cbcc43a8fd425a0fe4c3c336ebc64fbfd25951bfd5f7e32a','repair=20260912180000_reconcile_identity_runtime_state.sql','reason=production runtime objects reconciled from verified existing state'],'registration-reconciled:20260911180000_allow_node_mall_operator_invitations.sql'),
('20260911190000',array['profile=registration-reconciled/v1','source_sha256=3a81b39d5538755f602b9d8022191bec764c74e47c74e6e95eba346af3708fd4','repair=20260912180000_reconcile_identity_runtime_state.sql','reason=production runtime objects reconciled from verified existing state'],'registration-reconciled:20260911190000_bind_operator_registration_to_realm_console.sql'),
('20260911200000',array['profile=registration-reconciled/v1','source_sha256=5b3ba3d37009210f3bd5f508cd7d9feebda22a55f85b846a39acbe8cb290e304','repair=20260912180000_reconcile_identity_runtime_state.sql','reason=production runtime objects reconciled from verified existing state'],'registration-reconciled:20260911200000_create_sfl_node_sovereignty.sql'),
('20260911210000',array['profile=registration-reconciled/v1','source_sha256=32d4d11f8a54d19ede60b979d22e4519dc9a7179e6dc6f867ff24a7ceddb8ae4','repair=20260912180000_reconcile_identity_runtime_state.sql','reason=production runtime objects reconciled from verified existing state'],'registration-reconciled:20260911210000_create_sfl_hosted_node_provisioning.sql'),
('20260912010000',array['profile=registration-reconciled/v1','source_sha256=43efeb5af683761df52af5f5ef8893db38c7cfadaf70b98fa84aa57a89f776d7','repair=20260912180000_reconcile_identity_runtime_state.sql','reason=production runtime objects reconciled from verified existing state'],'registration-reconciled:20260912010000_create_sfl_node_context_scope.sql'),
('20260912020000',array['profile=registration-reconciled/v1','source_sha256=10de05b35b2e89c04a160bdb9d73baf55d8d4a7c0b0f75b7d5c024f766e36bc9','repair=20260912180000_reconcile_identity_runtime_state.sql','reason=production runtime objects reconciled from verified existing state'],'registration-reconciled:20260912020000_create_sfl_member_registration_progression.sql'),
('20260912030000',array['profile=registration-reconciled/v1','source_sha256=031939070132c1af56a8bd4c55797d49079399b61fdba86d0ff2a741a8b47366','repair=20260912180000_reconcile_identity_runtime_state.sql','reason=production runtime objects reconciled from verified existing state'],'registration-reconciled:20260912030000_create_sfl_multi_realm_membership.sql'),
('20260912120000',array['profile=registration-reconciled/v1','source_sha256=4a82066ec8547e40c39a8031e2089bd012fc2cd59403f3e5feb3c95437b2826f','repair=20260912180000_reconcile_identity_runtime_state.sql','reason=production runtime objects reconciled from verified existing state'],'registration-reconciled:20260912120000_create_zhudatuan_supplier_network.sql'),
('20260912130000',array['profile=registration-reconciled/v1','source_sha256=24055370e183528d1db542154a2258b7a6a7e258f9bb625209a0ba623bdf21e0','repair=20260912180000_reconcile_identity_runtime_state.sql','reason=production runtime objects reconciled from verified existing state'],'registration-reconciled:20260912130000_create_supplier_analytics_perspective.sql'),
('20260912140000',array['profile=registration-reconciled/v1','source_sha256=15f60edba4ff299f3273a9f46749ee8e2539d053196a81c5100340914fcf0dff','repair=20260912180000_reconcile_identity_runtime_state.sql','reason=production runtime objects reconciled from verified existing state'],'registration-reconciled:20260912140000_index_catalog_reverse_lookups.sql')
on conflict(version) do nothing;

commit;
