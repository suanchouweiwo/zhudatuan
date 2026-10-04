begin;

select pg_advisory_xact_lock(hashtext('zhudatuan:authoritative-owner-node-console:v1'));

do $precondition$
begin
  if to_regprocedure('access.resolve_governance(text,text,text,text)') is null
    or to_regprocedure('access.zhudatuan_operator_invitation_allowed(text,boolean)') is null
    or not exists(select 1 from access.platformowner where singleton=true and state='active') then
    raise exception 'AUTHORITATIVE_OWNER_NODE_CONSOLE_PRECONDITION_INVALID';
  end if;
end
$precondition$;

create or replace function access.resolve_authoritative_governance(
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
  with resolved as materialized(
    select governance.*
    from access.resolve_governance(p_membership_id,p_actor_id,p_scope_kind,p_scope_id) governance
  ), authoritative_owner as materialized(
    select owner.membership_id,profile.principal_id
    from access.platformowner owner
    join access.membership membership on membership.id=owner.membership_id and membership.status='active'
    join member.profile profile on profile.id=membership.member_id and profile.status='active'
    join identity.principal principal on principal.id=profile.principal_id and principal.status='active'
    where owner.singleton=true and owner.state='active'
      and exists(select 1 from access.membershiprole assignment
        where assignment.membership_id=owner.membership_id
          and assignment.role_id='role-platform-owner-v2'
          and assignment.effective_at<=statement_timestamp()
          and (assignment.expires_at is null or assignment.expires_at>statement_timestamp()))
  )
  select case
      when actor_membership.client='operator'
        and authoritative_owner.principal_id=resolved.actor_principal_id then 'owner'
      else resolved.governance_level
    end governance_level,
    resolved.is_exact_owner,resolved.actor_membership_id,resolved.actor_principal_id,
    resolved.organization_id,resolved.owner_membership_id,resolved.scope_kind,
    resolved.scope_semantic_id,resolved.scope_storage_id,resolved.scope_organization_id,
    resolved.resolved_at
  from resolved
  join access.membership actor_membership on actor_membership.id=resolved.actor_membership_id
    and actor_membership.status='active'
  left join authoritative_owner on true
$function$;

revoke all on function access.resolve_authoritative_governance(text,text,text,text) from public;
grant execute on function access.resolve_authoritative_governance(text,text,text,text)
  to shopapp,shopconsole,zhudatuanidentityapi,zhudatuanwebapi,zhudatuanpurchaseapi,zhudatuanprovisioningapi;

create or replace function access.zhudatuan_operator_invitation_allowed(
  p_role_id text,
  p_create boolean
)
returns boolean language sql stable
set search_path=pg_catalog,pg_temp as $function$
  select current_user in('shopapp','zhudatuanidentityapi')
    and (
      (governance.scope_kind='tenant'
        and governance.scope_semantic_id=governance.scope_organization_id)
      or (
        governance.is_exact_owner
        and governance.scope_kind='platform'
        and exists(
          select 1 from organization.unitclosure boundary
          where boundary.ancestor_id=governance.scope_organization_id
            and boundary.descendant_id=governance.organization_id
        )
      )
    )
    and (p_role_id='role-zhudatuan-pending-operator'
      or p_role_id='role-senior-administrator-v1:'||governance.scope_organization_id)
    and governance.governance_level in('owner','senior_administrator')
    and (not p_create or governance.governance_level='owner'
      or p_role_id='role-zhudatuan-pending-operator')
    and exists(
      select 1 from access.rolepermission mapping
      join access.permission permission on permission.id=mapping.permission_id
      where mapping.role_id=case when governance.governance_level='owner' then 'role-platform-owner-v2'
          else 'role-senior-administrator-v1:'||governance.scope_organization_id end
        and mapping.effect='allow'
        and permission.code='identity.invitation.manage'
        and permission.status='active'
        and not exists(
          select 1 from access.membershipoverride denied
          where denied.membership_id=governance.actor_membership_id
            and denied.permission_id=permission.id
            and denied.effect='deny'
            and denied.revoked_at is null
            and denied.effective_at<=governance.resolved_at
            and (denied.expires_at is null or denied.expires_at>governance.resolved_at)
        )
    )
  from access.resolve_authoritative_governance(
    nullif(current_setting('app.membership_id',true),''),
    nullif(current_setting('app.actor_id',true),''),
    null,
    nullif(current_setting('app.scope_id',true),'')
  ) governance
$function$;

commit;
