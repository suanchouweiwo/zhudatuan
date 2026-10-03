begin;

select pg_advisory_xact_lock(hashtext('sfl:reconcile-l0-public-domain-migration-ledger:v1'));

do $reconcile$
declare
  v_name text;
  v_statements text[];
  v_expected_statements constant text[] := array[
    'profile=registration-only/v1',
    'source_sha256=a28e4337628095bfeb98f3acf4f33fa89d485c4f2913f56e1e70589a112179b1',
    'executed_sha256=a28e4337628095bfeb98f3acf4f33fa89d485c4f2913f56e1e70589a112179b1',
    'reason=append-only post-history migration executed byte-for-byte'
  ]::text[];
begin
  if not exists(select 1 from runtime.schemaversion
      where version='20260909203000'
        and checksum='31ed21bd9351a3678742c2b0c10a1a2b725cbbfef09d5888b609569a2f3610ba')
    or (select count(*) from identity.realmentry where realm_id='realm:l0')<>3
    or not exists(select 1 from identity.realmentry where realm_id='realm:l0'
      and host='accounts.fufu.wang' and kind='accounts' and status='active')
    or not exists(select 1 from identity.realmentry where realm_id='realm:l0'
      and host='api.fufu.wang' and kind='api' and status='active')
    or not exists(select 1 from identity.realmentry where realm_id='realm:l0'
      and host='fufu.wang' and kind='storefront' and status='active')
    or (select count(*) from identity.realmtarget where realm_id='realm:l0')<>4
    or not exists(select 1 from identity.realmtarget where realm_id='realm:l0' and target='console'
      and return_origin='https://console.fufu.wang')
    or not exists(select 1 from identity.realmtarget where realm_id='realm:l0' and target='store'
      and return_origin='https://console.fufu.wang/entrances/store')
    or not exists(select 1 from identity.realmtarget where realm_id='realm:l0' and target='supplier'
      and return_origin='https://console.fufu.wang/entrances/supplier')
    or not exists(select 1 from identity.realmtarget where realm_id='realm:l0' and target='storefront'
      and return_origin='https://fufu.wang') then
    raise exception 'L0_PUBLIC_DOMAIN_LEDGER_RECONCILIATION_SOURCE_INVALID';
  end if;

  select name,statements into v_name,v_statements
  from supabase_migrations.schema_migrations
  where version='20260909203000';
  if found then
    if v_name='20260909203000_switch_l0_public_domain_to_fufu.sql'
      and coalesce(cardinality(v_statements),0)=0 then
      update supabase_migrations.schema_migrations set statements=v_expected_statements
      where version='20260909203000';
    elsif v_name<>'20260909203000_switch_l0_public_domain_to_fufu.sql'
      or v_statements is distinct from v_expected_statements then
      raise exception 'L0_PUBLIC_DOMAIN_LEDGER_RECONCILIATION_CONFLICT';
    end if;
  else
    insert into supabase_migrations.schema_migrations(version,statements,name)
    values(
      '20260909203000',
      v_expected_statements,
      '20260909203000_switch_l0_public_domain_to_fufu.sql'
    );
  end if;
end
$reconcile$;

insert into runtime.schemaversion(version,checksum)
values('20260909204000','c2d12536aa4e832a343551634941cc008082d02e5e7a3fcd134201a81799c258');

commit;
