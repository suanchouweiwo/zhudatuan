begin;

select pg_advisory_xact_lock(hashtext('zhudatuan:restore-platform-owner-personal-scope:v1'));

do $boundary_guard$
begin
  if not (
    (current_database()='zhudatuan_registration' and current_user='shopmigration')
    or coalesce((select rolsuper from pg_roles where rolname=current_user),false)
  ) then
    raise exception 'PLATFORM_OWNER_PERSONAL_SCOPE_BOUNDARY_INVALID';
  end if;
  if not exists(select 1 from runtime.schemaversion
    where version='20260901100000'
      and checksum='78d8bc0b3efd7f2207d89e72ca9bd5021f3dc5a53ffac0ef337a2aea248a23a6') then
    raise exception 'PLATFORM_OWNER_PERSONAL_SCOPE_PREDECESSOR_INVALID';
  end if;
  if exists(select 1 from runtime.schemaversion where version>'20260901100000') then
    raise exception 'PLATFORM_OWNER_PERSONAL_SCOPE_FUTURE_HEAD_INVALID';
  end if;
end
$boundary_guard$;

-- 20260901100000 intentionally made role assignments scope-aware, but its
-- resolver replacement dropped the virtual owner grant introduced by
-- 20260829214000. Patch only the aggregate tail so assigned_scope_id and all
-- later role-containment semantics remain intact.
do $restore_projection$
declare
  definition text;
  rewritten text;
  needle text:=$needle$), '[]'::jsonb)
  from access.membership membership where membership.id=p_membership_id
$needle$;
  replacement text:=$replacement$), '[]'::jsonb)
    || coalesce((select jsonb_build_array(jsonb_build_object(
      'scope',access.scope_object(membership.member_id),
      'permissions',coalesce((select jsonb_agg(permission.code order by permission.code)
        from access.rolepermission mapping
        join access.permission permission on permission.id=mapping.permission_id and permission.status='active'
        where mapping.role_id='role:self' and mapping.effect='allow'),'[]'::jsonb),
      'effective',greatest(ownerassignment.effective_at,selfassignment.effective_at),
      'expires',null))
      from access.platformowner owner
      join access.membershiprole ownerassignment on ownerassignment.membership_id=owner.membership_id
        and ownerassignment.role_id='role-platform-owner-v2'
        and ownerassignment.effective_at<=clock_timestamp()
        and (ownerassignment.expires_at is null or ownerassignment.expires_at>clock_timestamp())
      join access.membershiprole selfassignment on selfassignment.membership_id=owner.membership_id
        and selfassignment.role_id='role:self'
        and selfassignment.effective_at<=clock_timestamp()
        and (selfassignment.expires_at is null or selfassignment.expires_at>clock_timestamp())
      where owner.singleton=true and owner.state='active' and owner.membership_id=membership.id
        and not exists(select 1 from access.scopegrant ownerscope
          where ownerscope.membership_id=membership.id and ownerscope.scope_kind='owner'
            and ownerscope.effect='allow' and ownerscope.access_version>0
            and ownerscope.access_version<=membership.access_version
            and ownerscope.effective_at<=clock_timestamp()
            and (ownerscope.expires_at is null or ownerscope.expires_at>clock_timestamp()))), '[]'::jsonb)
  from access.membership membership where membership.id=p_membership_id
$replacement$;
begin
  select pg_get_functiondef('access.resolve_membership(text)'::regprocedure) into definition;
  if position('assignment.assigned_scope_id' in definition)=0 then
    raise exception 'PLATFORM_OWNER_PERSONAL_SCOPE_ASSIGNED_SCOPE_SEMANTICS_MISSING';
  end if;
  rewritten:=replace(definition,needle,replacement);
  if rewritten=definition
    or position(replacement in rewritten)=0
    or position('assignment.assigned_scope_id' in rewritten)=0 then
    raise exception 'PLATFORM_OWNER_PERSONAL_SCOPE_REWRITE_FAILED';
  end if;
  execute rewritten;
end
$restore_projection$;

insert into runtime.schemaversion(version,checksum)
values('20260901210000','503a8b1f8f0502cfaa9a6449dee57350936526e969dba4d63b09974bf6718d11');

commit;
