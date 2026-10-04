begin;

select pg_advisory_xact_lock(hashtext('sfl:session-membership-permission-consumption:v1'));

do $precondition$
begin
  if not exists(select 1 from runtime.schemaversion
      where version='20260912230000'
        and checksum='00957fef847764497bcc033057d4feceb919c7a90a6ec984daf6e40f2694b096') then
    raise exception 'SESSION_MEMBERSHIP_PERMISSION_PREDECESSOR_INVALID';
  end if;
  if exists(select 1 from runtime.schemaversion where version>'20260912230000') then
    raise exception 'SESSION_MEMBERSHIP_PERMISSION_FUTURE_HEAD_INVALID';
  end if;
  if to_regprocedure('identity.resolve_session(text,text)') is null
    or to_regprocedure('access.resolve_membership(text)') is null
    or to_regprocedure('access.membership_version(text)') is null
    or to_regprocedure('access.resolve_scope(text,text,text,text)') is null
    or to_regprocedure('capability.membership_operations(text)') is null then
    raise exception 'SESSION_MEMBERSHIP_PERMISSION_TARGET_MISSING';
  end if;
end
$precondition$;

drop function identity.resolve_session(text,text);
create function identity.resolve_session(p_token_hash text,p_entry_host text)
returns table(
  actor_id text,account_id text,realm_id text,session_id text,membership_id text,
  credential_version bigint,access_version bigint,target text,membership_client text,
  governance_organization_id text,assurance_level smallint,
  assurance_verified_at timestamptz,entry_realm_id text,line_id text,node_id text,
  parent_node_id text,signed_level text,node_profile text,mall_id text,
  host_sovereign_node_id text,relation_version integer
)
language sql stable security definer
set search_path=pg_catalog,pg_temp as $function$
  select account.legacy_principal_id,account.id,account.realm_id,session.id,session.membership_id,
    session.credential_version,session.access_version,
    case target.membership_client when 'operator' then 'console' else target.membership_client end,
    membership.client,membership.organization_id,
    case
      when session.assurance_level>=3 and stepup.verified_at is not null and phone.verified_at is not null then 3::smallint
      when session.assurance_level>=2 and phone.verified_at is not null then 2::smallint
      else 1::smallint
    end,
    case when session.assurance_level>=3 and stepup.verified_at is not null and phone.verified_at is not null
      then stepup.verified_at else null end,
    active.entry_realm_id,active.line_id,active.node_id,active.parent_node_id,active.signed_level,
    active.node_profile,active.mall_id,active.host_sovereign_node_id,active.relation_version
  from identity.session session
  join identity.account account on account.id=session.account_id and account.realm_id=session.realm_id
  join access.membership membership on membership.id=session.membership_id
    and membership.account_id=account.id and membership.realm_id=account.realm_id
  join identity.realmtarget target on target.realm_id=session.realm_id and target.target=session.auth_target
    and target.membership_client=membership.client
    and target.membership_organization_id=membership.organization_id
  join identity.realmentry entry on entry.host=p_entry_host and entry.status='active'
  cross join lateral identity.resolve_active_membership_context(
    entry.realm_id,account.id,membership.id
  ) active
  left join lateral (select evidence.verified_at from identity.assurance evidence
    where evidence.account_id=account.id and evidence.realm_id=account.realm_id
      and evidence.method='phone_otp' and evidence.level=2
      and evidence.verified_at<=clock_timestamp() and evidence.expires_at>clock_timestamp()
    order by evidence.verified_at desc limit 1) phone on true
  left join lateral (select evidence.verified_at from identity.assurance evidence
    where evidence.account_id=account.id and evidence.realm_id=account.realm_id and evidence.level>=3
      and evidence.evidence_hash=encode(public.digest(session.id::text,'sha256'),'hex')
      and evidence.verified_at>=clock_timestamp()-interval '15 minutes'
      and evidence.verified_at<=clock_timestamp()
      and evidence.expires_at is not null and evidence.expires_at>clock_timestamp()
    order by evidence.level desc,evidence.verified_at desc limit 1) stepup on true
  where session.token_hash=p_token_hash and session.revoked_at is null
    and session.expires_at>clock_timestamp()
    and session.credential_version=account.credential_version and account.status='active'
    and account.legacy_principal_id=session.principal_id and membership.status='active'
    and session.access_version=membership.access_version and session.client=membership.client
$function$;

alter function identity.resolve_session(text,text) owner to zhudatuanroot;
revoke all on function identity.resolve_session(text,text) from public;
grant execute on function identity.resolve_session(text,text)
  to shopapp,zhudatuanidentityapi,shopconsole,zhudatuanwebapi,zhudatuanpurchaseapi,zhudatuanprovisioningapi;

create function access.session_membership_context_matches(
  p_membership_id text,p_realm_id text,p_client text,p_organization_id text
)
returns boolean language sql stable security definer
set search_path=pg_catalog,pg_temp as $function$
  select exists(
    select 1
    from access.membership membership
    join identity.account account on account.id=membership.account_id
      and account.realm_id=membership.realm_id and account.status='active'
    join identity.realm realm on realm.id=membership.realm_id and realm.status='active'
    join organization.organization governance on governance.id=membership.organization_id
      and governance.status='active'
    join identity.realmtarget target on target.realm_id=membership.realm_id
      and target.membership_client=membership.client
      and target.membership_organization_id=membership.organization_id
    where membership.id=p_membership_id and membership.status='active'
      and membership.realm_id=p_realm_id and membership.client=p_client
      and membership.organization_id=p_organization_id
  )
$function$;

create function access.resolve_session_membership(
  p_membership_id text,p_realm_id text,p_client text,p_organization_id text
)
returns table(id text,active boolean,access_version bigint,denies text[],grants jsonb)
language sql stable security definer
set search_path=pg_catalog,pg_temp as $function$
  select resolved.id,resolved.active,resolved.access_version,resolved.denies,resolved.grants
  from access.resolve_membership(p_membership_id) resolved
  where access.session_membership_context_matches(
    p_membership_id,p_realm_id,p_client,p_organization_id
  ) and resolved.id=p_membership_id
$function$;

create function access.session_membership_version(
  p_membership_id text,p_realm_id text,p_client text,p_organization_id text
)
returns bigint language sql stable security definer
set search_path=pg_catalog,pg_temp as $function$
  select access.membership_version(p_membership_id)
  where access.session_membership_context_matches(
    p_membership_id,p_realm_id,p_client,p_organization_id
  )
$function$;

create function access.resolve_session_scope(
  p_membership_id text,p_realm_id text,p_client text,p_organization_id text,
  p_operation text,p_resource text,p_scope_hint text
)
returns table(scope jsonb) language sql stable security definer
set search_path=pg_catalog,pg_temp as $function$
  select resolved.scope
  from access.resolve_scope(p_membership_id,p_operation,p_resource,p_scope_hint) resolved
  where access.session_membership_context_matches(
    p_membership_id,p_realm_id,p_client,p_organization_id
  )
$function$;

create function capability.session_membership_operations(
  p_membership_id text,p_realm_id text,p_client text,p_organization_id text
)
returns table(operation_id text) language sql stable security definer
set search_path=pg_catalog,pg_temp as $function$
  select operation.operation_id
  from capability.membership_operations(p_membership_id) operation
  where access.session_membership_context_matches(
    p_membership_id,p_realm_id,p_client,p_organization_id
  )
$function$;

revoke all on function access.session_membership_context_matches(text,text,text,text),
  access.resolve_session_membership(text,text,text,text),
  access.session_membership_version(text,text,text,text),
  access.resolve_session_scope(text,text,text,text,text,text,text),
  capability.session_membership_operations(text,text,text,text) from public;
grant execute on function access.session_membership_context_matches(text,text,text,text),
  access.resolve_session_membership(text,text,text,text),
  access.session_membership_version(text,text,text,text),
  access.resolve_session_scope(text,text,text,text,text,text,text),
  capability.session_membership_operations(text,text,text,text)
  to shopapp,zhudatuanidentityapi,shopconsole,zhudatuanwebapi,zhudatuanpurchaseapi,zhudatuanprovisioningapi;

insert into runtime.schemaversion(version,checksum)
values('20260912240000','9fa01e96c2698e0da588f0b82780ecdf31eeebd34c78aaffc1b35664d9dc1174');

do $assert$
declare
  session_definition text;
  permission_definition text;
begin
  select pg_get_functiondef('identity.resolve_session(text,text)'::regprocedure)
    into session_definition;
  select pg_get_functiondef('access.resolve_session_membership(text,text,text,text)'::regprocedure)
    into permission_definition;
  if position('membership.client' in session_definition)=0
    or position('membership.organization_id' in session_definition)=0
    or position('session.membership_id' in session_definition)=0
    or position('principal_id=' in lower(permission_definition))>0
    or position('mobile' in lower(permission_definition))>0
    or to_regprocedure('access.resolve_session_scope(text,text,text,text,text,text,text)') is null
    or to_regprocedure('capability.session_membership_operations(text,text,text,text)') is null
    or not exists(select 1 from runtime.schemaversion
      where version='20260912240000'
        and checksum='9fa01e96c2698e0da588f0b82780ecdf31eeebd34c78aaffc1b35664d9dc1174') then
    raise exception 'SESSION_MEMBERSHIP_PERMISSION_MIGRATION_INCOMPLETE';
  end if;
end
$assert$;

commit;
