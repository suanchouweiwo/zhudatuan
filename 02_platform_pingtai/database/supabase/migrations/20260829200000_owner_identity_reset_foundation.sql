begin;

insert into runtime.operation(id,owner,method,path,contract_version)
values('identity.members.reset','identity','PUT','/api/v1/identity/members/{membershipid}/registration','1.0.0')
on conflict(id) do update set owner=excluded.owner,method=excluded.method,path=excluded.path,contract_version=excluded.contract_version;

insert into runtime.event(type,version,owner,schema_ref)
values('identity.member.reset',1,'identity','contract://events/identity.member.reset/v1')
on conflict(type,version) do update set owner=excluded.owner,schema_ref=excluded.schema_ref;

insert into access.permission(id,code,risk,status)
values('permission:62a354df9138535ba0651fd6','identity.registration.reset','high','active')
on conflict(code) do update set risk=excluded.risk,status='active';

delete from access.rolepermission mapping
using access.permission permission
where mapping.permission_id=permission.id and permission.code='identity.registration.reset'
  and mapping.role_id<>'role-platform-owner-v2';

insert into access.rolepermission(role_id,permission_id,effect)
select 'role-platform-owner-v2',id,'allow' from access.permission where code='identity.registration.reset'
on conflict do nothing;

insert into capability.capability(id,kind,name,version,status)
values('identity.members.reset','operation','identity.members.reset',1,'active')
on conflict(id) do update set status='active';

insert into capability.operation(operation_id,capability_id,permission_code,audience)
values('identity.members.reset','identity.members.reset','identity.registration.reset','operator')
on conflict(operation_id) do update set capability_id=excluded.capability_id,
  permission_code=excluded.permission_code,audience=excluded.audience;

insert into capability.entitlement(id,scope_id,capability_id,state,quota,effective_at,expires_at,version)
values('platform:identity.members.reset','organization-platform-root','identity.members.reset','enabled',null,
  '1970-01-01T00:00:00Z',null,0)
on conflict(id) do update set state='enabled',expires_at=null;

-- Unlike self-service identity operations, an account reset is authorized
-- against the target membership organization supplied by the path.
do $scope$
declare definition text; patched text;
begin
  select pg_get_functiondef('access.resource_scope(text,text,text)'::regprocedure) into definition;
  if position('identity.members.reset' in definition)=0 then
    patched:=replace(definition,
      $needle$  elsif p_operation='identity.invitations.revoke' then
    select organization_id into resolved from member.invite where id=p_resource;
  elsif p_operation like 'identity.%' then$needle$,
      $replacement$  elsif p_operation='identity.invitations.revoke' then
    select organization_id into resolved from member.invite where id=p_resource;
  elsif p_operation='identity.members.reset' then
    select organization_id into resolved from access.membership where id=p_resource;
  elsif p_operation like 'identity.%' then$replacement$);
    if patched=definition then raise exception 'IDENTITY_RESET_SCOPE_PATCH_FAILED'; end if;
    execute patched;
  end if;
end
$scope$;

create or replace function access.protect_root_owner_membership()
returns trigger language plpgsql security definer set search_path=access,pg_temp as $function$
begin
  if exists(select 1 from access.membershiprole assignment
      where assignment.membership_id=old.id and assignment.role_id='role-platform-owner-v2'
        and assignment.effective_at<=clock_timestamp()
        and (assignment.expires_at is null or assignment.expires_at>clock_timestamp()))
    and (tg_op='DELETE' or new.status<>'active' or new.member_id<>old.member_id) then
    raise exception 'OWNER_MEMBERSHIP_PROTECTED';
  end if;
  return case when tg_op='DELETE' then old else new end;
end
$function$;

create or replace function access.protect_root_owner_role()
returns trigger language plpgsql security definer set search_path=access,pg_temp as $function$
begin
  if old.role_id='role-platform-owner-v2' and old.effective_at<=clock_timestamp()
    and (old.expires_at is null or old.expires_at>clock_timestamp())
    and exists(select 1 from access.membership where id=old.membership_id and status='active')
    and (tg_op='DELETE' or new.role_id<>'role-platform-owner-v2'
      or new.expires_at is not null and new.expires_at<=clock_timestamp()) then
    raise exception 'OWNER_ROLE_PROTECTED';
  end if;
  return case when tg_op='DELETE' then old else new end;
end
$function$;

create or replace function identity.protect_root_owner_principal()
returns trigger language plpgsql security definer set search_path=identity,member,access,pg_temp as $function$
begin
  if (tg_op='DELETE' or new.status<>'active') and exists(
    select 1 from member.profile profile
    join access.membership membership on membership.member_id=profile.id and membership.status='active'
    join access.membershiprole assignment on assignment.membership_id=membership.id
      and assignment.role_id='role-platform-owner-v2' and assignment.effective_at<=clock_timestamp()
      and (assignment.expires_at is null or assignment.expires_at>clock_timestamp())
    where profile.principal_id=old.id) then raise exception 'OWNER_MEMBERSHIP_PROTECTED'; end if;
  return case when tg_op='DELETE' then old else new end;
end
$function$;

create or replace function member.protect_root_owner_profile()
returns trigger language plpgsql security definer set search_path=member,access,pg_temp as $function$
begin
  if (tg_op='DELETE' or new.status<>'active' or new.principal_id<>old.principal_id) and exists(
    select 1 from access.membership membership
    join access.membershiprole assignment on assignment.membership_id=membership.id
      and assignment.role_id='role-platform-owner-v2' and assignment.effective_at<=clock_timestamp()
      and (assignment.expires_at is null or assignment.expires_at>clock_timestamp())
    where membership.member_id=old.id and membership.status='active') then raise exception 'OWNER_MEMBERSHIP_PROTECTED'; end if;
  return case when tg_op='DELETE' then old else new end;
end
$function$;

create or replace function identity.protect_root_owner_credential()
returns trigger language plpgsql security definer set search_path=identity,member,access,pg_temp as $function$
begin
  if old.status='active' and (tg_op='DELETE' or new.status<>'active') and exists(
    select 1 from member.profile profile
    join access.membership membership on membership.member_id=profile.id and membership.status='active'
    join access.membershiprole assignment on assignment.membership_id=membership.id
      and assignment.role_id='role-platform-owner-v2' and assignment.effective_at<=clock_timestamp()
      and (assignment.expires_at is null or assignment.expires_at>clock_timestamp())
    where profile.principal_id=old.principal_id) then raise exception 'OWNER_MEMBERSHIP_PROTECTED'; end if;
  return case when tg_op='DELETE' then old else new end;
end
$function$;

drop trigger if exists protect_root_owner on access.membership;
create trigger protect_root_owner before update of status,member_id or delete on access.membership
for each row execute function access.protect_root_owner_membership();
drop trigger if exists protect_root_owner on access.membershiprole;
create trigger protect_root_owner before update of role_id,expires_at or delete on access.membershiprole
for each row execute function access.protect_root_owner_role();
drop trigger if exists protect_root_owner on identity.principal;
create trigger protect_root_owner before update of status or delete on identity.principal
for each row execute function identity.protect_root_owner_principal();
drop trigger if exists protect_root_owner on member.profile;
create trigger protect_root_owner before update of status,principal_id or delete on member.profile
for each row execute function member.protect_root_owner_profile();
drop trigger if exists protect_root_owner on identity.credential;
create trigger protect_root_owner before update of status or delete on identity.credential
for each row execute function identity.protect_root_owner_credential();


insert into runtime.schemaversion(version,checksum)
values('20260829200000','8d3c51b7ff337a896f6003b33f9857adda755ddd74192d6776cd1d5c85a15e70');

do $assert$
begin
  if not exists(select 1 from access.rolepermission mapping join access.permission permission on permission.id=mapping.permission_id
      where mapping.role_id='role-platform-owner-v2' and permission.code='identity.registration.reset' and mapping.effect='allow')
    or exists(select 1 from access.rolepermission mapping join access.permission permission on permission.id=mapping.permission_id
      where mapping.role_id<>'role-platform-owner-v2' and permission.code='identity.registration.reset')
    or not exists(select 1 from capability.operation where operation_id='identity.members.reset'
      and permission_code='identity.registration.reset' and audience='operator')
    or not exists(select 1 from runtime.event where type='identity.member.reset' and version=1)
    or position('identity.members.reset' in pg_get_functiondef('access.resource_scope(text,text,text)'::regprocedure))=0
    or (select count(*) from pg_trigger where tgname='protect_root_owner' and not tgisinternal)<>5
    or not exists(select 1 from runtime.schemaversion where version='20260829200000')
  then raise exception 'OWNER_IDENTITY_RESET_FOUNDATION_INCOMPLETE'; end if;
end
$assert$;

commit;
