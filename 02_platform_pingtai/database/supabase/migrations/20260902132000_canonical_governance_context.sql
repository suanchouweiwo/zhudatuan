begin;

select pg_advisory_xact_lock(hashtext('zhudatuan:canonical-governance-context:v1'));

do $boundary_guard$
begin
  if not (
    (current_database()='zhudatuan_registration' and current_user='shopmigration')
    or coalesce((select rolsuper from pg_roles where rolname=current_user),false)
  ) then
    raise exception 'CANONICAL_GOVERNANCE_CONTEXT_BOUNDARY_INVALID';
  end if;
  if not exists(select 1 from runtime.schemaversion
    where version='20260902012000'
      and checksum='3a36f65b55737f624fc3d717a8f8815685908eae0cdb57673aeb5ba465887995') then
    raise exception 'CANONICAL_GOVERNANCE_CONTEXT_PREDECESSOR_INVALID';
  end if;
  if exists(select 1 from runtime.schemaversion where version>'20260902012000') then
    raise exception 'CANONICAL_GOVERNANCE_CONTEXT_FUTURE_HEAD_INVALID';
  end if;
end
$boundary_guard$;

create or replace function access.canonical_governance_scope(
  p_scope_kind text,
  p_scope_id text,
  p_actor_id text,
  p_membership_id text
)
returns table(scope_kind text,semantic_id text,storage_id text,organization_id text)
language sql stable security definer
set search_path=pg_catalog,pg_temp as $function$
  with actor_context as materialized(
    select membership.member_id,membership.organization_id
    from access.membership membership
    join member.profile profile on profile.id=membership.member_id
      and profile.principal_id=p_actor_id and profile.status='active'
    join identity.principal principal on principal.id=profile.principal_id and principal.status='active'
    where membership.id=p_membership_id and membership.status='active'
  ), candidates as(
    select 1 priority,'self'::text scope_kind,p_actor_id semantic_id,
      'self:'||p_actor_id storage_id,actor_context.organization_id
    from actor_context
    where p_scope_id in(p_actor_id,'self:'||p_actor_id)
      and (p_scope_kind is null or p_scope_kind='self')
    union all
    select 2,'owner',actor_context.member_id,actor_context.member_id,actor_context.organization_id
    from actor_context
    where p_scope_id in(actor_context.member_id,'owner:'||actor_context.member_id)
      and (p_scope_kind is null or p_scope_kind='owner')
    union all
    select 3,scope.kind,scope.id,scope.id,
      coalesce(case when scope.kind='tenant' then scope.id end,
        (select tenant.id from organization.unitclosure closure
          join organization.organization tenant on tenant.id=closure.ancestor_id and tenant.kind='tenant'
          where closure.descendant_id=scope.id order by closure.depth asc limit 1),scope.id)
    from organization.organization scope
    where scope.id=p_scope_id and scope.status='active'
      and (p_scope_kind is null or p_scope_kind=scope.kind)
  )
  select candidates.scope_kind,candidates.semantic_id,candidates.storage_id,candidates.organization_id
  from candidates order by candidates.priority limit 1
$function$;

create or replace function access.resolve_governance(
  p_membership_id text,
  p_actor_id text,
  p_scope_kind text,
  p_scope_id text
)
returns table(
  governance_level text,
  is_exact_owner boolean,
  actor_membership_id text,
  actor_principal_id text,
  organization_id text,
  owner_membership_id text,
  scope_kind text,
  scope_semantic_id text,
  scope_storage_id text,
  scope_organization_id text,
  resolved_at timestamptz
)
language sql stable security definer
set search_path=pg_catalog,pg_temp as $function$
  with decision_time as materialized(select statement_timestamp() resolved_at),
  actor_context as materialized(
    select membership.id membership_id,profile.principal_id,membership.organization_id,membership.client
    from decision_time
    join access.membership membership on membership.id=p_membership_id and membership.status='active'
    join member.profile profile on profile.id=membership.member_id
      and profile.principal_id=p_actor_id and profile.status='active'
    join identity.principal principal on principal.id=profile.principal_id and principal.status='active'
  ), authoritative_owner as materialized(
    select owner.membership_id,profile.principal_id
    from decision_time
    join access.platformowner owner on owner.singleton=true and owner.state='active'
    join access.membership membership on membership.id=owner.membership_id and membership.status='active'
    join member.profile profile on profile.id=membership.member_id and profile.status='active'
    join identity.principal principal on principal.id=profile.principal_id and principal.status='active'
    where exists(select 1 from access.membershiprole assignment
      where assignment.membership_id=owner.membership_id
        and assignment.role_id='role-platform-owner-v2'
        and assignment.effective_at<=decision_time.resolved_at
        and (assignment.expires_at is null or assignment.expires_at>decision_time.resolved_at))
  ), canonical_scope as materialized(
    select normalized.*
    from actor_context
    cross join lateral access.canonical_governance_scope(
      p_scope_kind,p_scope_id,actor_context.principal_id,actor_context.membership_id) normalized
  )
  select case
      when authoritative_owner.membership_id=actor_context.membership_id
        and authoritative_owner.principal_id=actor_context.principal_id then 'owner'
      when actor_context.client='operator' then 'administrator'
      else 'member'
    end governance_level,
    coalesce(authoritative_owner.membership_id=actor_context.membership_id
      and authoritative_owner.principal_id=actor_context.principal_id,false) is_exact_owner,
    actor_context.membership_id,actor_context.principal_id,actor_context.organization_id,
    authoritative_owner.membership_id,canonical_scope.scope_kind,canonical_scope.semantic_id,
    canonical_scope.storage_id,canonical_scope.organization_id,decision_time.resolved_at
  from decision_time
  cross join actor_context
  cross join canonical_scope
  left join authoritative_owner on true
$function$;

revoke all on function access.canonical_governance_scope(text,text,text,text) from public;
revoke all on function access.resolve_governance(text,text,text,text) from public;
grant execute on function access.resolve_governance(text,text,text,text)
  to shopapp,shopconsole,zhudatuanidentityapi,zhudatuanwebapi,zhudatuanpurchaseapi,zhudatuanprovisioningapi;

create or replace function access.zhudatuan_owner_context()
returns boolean language sql stable
set search_path=pg_catalog,pg_temp as $function$
  select current_user in('shopapp','zhudatuanidentityapi') and exists(
    select 1 from access.resolve_governance(
      nullif(current_setting('app.membership_id',true),''),
      nullif(current_setting('app.actor_id',true),''),
      null,
      nullif(current_setting('app.scope_id',true),'')
    ) governance where governance.is_exact_owner)
$function$;
revoke all on function access.zhudatuan_owner_context() from public,shopjob,shopread;
grant execute on function access.zhudatuan_owner_context() to shopapp,zhudatuanidentityapi;

create or replace function access.zhudatuan_invitation_owner()
returns boolean language sql stable
set search_path=pg_catalog,pg_temp as $function$
  select current_user='zhudatuanidentityapi'
    and governance.is_exact_owner
    and governance.scope_kind='tenant'
    and governance.scope_semantic_id=governance.organization_id
    and exists(select 1 from access.rolepermission mapping
      join access.permission permission on permission.id=mapping.permission_id
      where mapping.role_id='role-platform-owner-v2' and mapping.effect='allow'
        and permission.code='identity.invitation.manage' and permission.status='active'
        and not exists(select 1 from access.membershipoverride denied
          where denied.membership_id=governance.actor_membership_id
            and denied.permission_id=permission.id and denied.effect='deny' and denied.revoked_at is null
            and denied.effective_at<=governance.resolved_at
            and (denied.expires_at is null or denied.expires_at>governance.resolved_at)))
  from access.resolve_governance(
    nullif(current_setting('app.membership_id',true),''),
    nullif(current_setting('app.actor_id',true),''),
    null,
    nullif(current_setting('app.scope_id',true),'')
  ) governance
$function$;
revoke all on function access.zhudatuan_invitation_owner() from public,shopapp,shopjob,shopread;
grant execute on function access.zhudatuan_invitation_owner() to zhudatuanidentityapi;

-- Preserve the existing atomic mutation body and make the canonical governance
-- resolver its first identity decision. Locking and final row checks remain.
do $owner_mobile_governance$
declare
  definition text;
  rewritten text;
  needle text:=$needle$begin
  if (session_user<>'shopapp'$needle$;
  replacement text:=$replacement$begin
  if not exists(select 1 from access.resolve_governance(
      nullif(current_setting('app.membership_id',true),''),p_actor,null,
      nullif(current_setting('app.scope_id',true),'')
    ) governance where governance.is_exact_owner) then
    raise exception 'OWNER_MOBILE_CHANGE_FORBIDDEN';
  end if;
  if (session_user<>'shopapp'$replacement$;
begin
  select pg_get_functiondef(
    'access.change_zhudatuan_owner_mobile(text,text,text,text,text,text,text,text,text)'::regprocedure
  ) into definition;
  rewritten:=replace(definition,needle,replacement);
  if rewritten=definition or position('access.resolve_governance(' in rewritten)=0 then
    raise exception 'OWNER_MOBILE_GOVERNANCE_REWRITE_FAILED';
  end if;
  execute rewritten;
end
$owner_mobile_governance$;

insert into runtime.schemaversion(version,checksum)
values('20260902132000','cf4ea3faa16fd6a64b06adfb3ab5488a7c1a8e8c11c13462c0421a72a6f5665d');

commit;
