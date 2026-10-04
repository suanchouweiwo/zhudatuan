begin;

select pg_advisory_xact_lock(hashtext('zhudatuan:operator-invitation-registration:v1'));

do $boundary_guard$
begin
  if not (
    (current_database()='zhudatuan_registration' and current_user='shopmigration')
    or coalesce((select rolsuper from pg_roles where rolname=current_user),false)
  ) then
    raise exception 'ZHUDATUAN_OPERATOR_INVITATION_BOUNDARY_INVALID';
  end if;
  if not exists(select 1 from runtime.schemaversion
    where version='20260829054500'
      and checksum='624ce2aff8edc85f82d71d09db019b623199eeb4522017dca3f9d44ba3803df9') then
    raise exception 'ZHUDATUAN_OPERATOR_INVITATION_PREDECESSOR_INVALID';
  end if;
  if exists(select 1 from runtime.schemaversion
    where version>'20260829054500' and version<>'20260829060000') then
    raise exception 'ZHUDATUAN_OPERATOR_INVITATION_FUTURE_HEAD_INVALID';
  end if;
end
$boundary_guard$;

alter table member.invite add column if not exists target_client text;
alter table member.invite add column if not exists storefront_organization_id text;
update member.invite set target_client='storefront' where target_client is null;
alter table member.invite alter column target_client set default 'storefront';
alter table member.invite alter column target_client set not null;
do $invite_constraints$
begin
  if not exists(select 1 from pg_constraint where conrelid='member.invite'::regclass
    and conname='member_invite_target_client') then
    alter table member.invite add constraint member_invite_target_client
      check(target_client in('storefront','operator'));
  end if;
  if not exists(select 1 from pg_constraint where conrelid='member.invite'::regclass
    and conname='member_invite_storefront_organization') then
    alter table member.invite add constraint member_invite_storefront_organization
      foreign key(storefront_organization_id) references organization.organization(id) on delete restrict;
  end if;
  if not exists(select 1 from pg_constraint where conrelid='member.invite'::regclass
    and conname='member_invite_operator_boundary') then
    alter table member.invite add constraint member_invite_operator_boundary check(
      (target_client='storefront' and storefront_organization_id is null)
      or (target_client='operator'
        and role_id='role-zhudatuan-pending-operator'
        and storefront_organization_id is not null
        and allowed_destination_hash is not null
        and max_uses=1)
    );
  end if;
end
$invite_constraints$;

do $pending_role$
begin
  if exists(select 1 from access.role where id='role-zhudatuan-pending-operator'
    and (scope_id<>'tenant-zhudatuan' or name<>'待授权管理员' or status<>'active')) then
    raise exception 'ZHUDATUAN_PENDING_OPERATOR_ROLE_COLLISION';
  end if;
  if exists(select 1 from access.role where id<>'role-zhudatuan-pending-operator'
    and scope_id='tenant-zhudatuan' and name='待授权管理员') then
    raise exception 'ZHUDATUAN_PENDING_OPERATOR_ROLE_NAME_COLLISION';
  end if;
end
$pending_role$;

insert into access.role(id,scope_id,name,status,version)
values('role-zhudatuan-pending-operator','tenant-zhudatuan','待授权管理员','active',1)
on conflict(id) do nothing;

delete from access.rolepermission mapping
using access.permission permission
where mapping.permission_id=permission.id
  and permission.code='identity.invitation.manage'
  and mapping.role_id<>'role-platform-owner-v2';

insert into access.rolepermission(role_id,permission_id,effect)
select 'role-platform-owner-v2',permission.id,'allow'
from access.permission permission
where permission.code='identity.invitation.manage' and permission.status='active'
on conflict do nothing;

create or replace function access.resolve_membership(p_membership_id text)
returns table(id text,active boolean,access_version bigint,denies text[],grants jsonb)
language sql stable security definer
set search_path=access,member,organization,pg_temp as $function$
  select membership.id,membership.status='active',membership.access_version,
    coalesce((select array_agg(distinct denied.code order by denied.code) from (
      select permission.code
      from access.membershiprole assignment
      join access.role role on role.id=assignment.role_id and role.status='active'
      join access.rolepermission mapping on mapping.role_id=role.id and mapping.effect='deny'
      join access.permission permission on permission.id=mapping.permission_id and permission.status='active'
      where assignment.membership_id=membership.id
        and assignment.effective_at<=clock_timestamp()
        and (assignment.expires_at is null or assignment.expires_at>clock_timestamp())
        and (role.id='role:self' or role.scope_id=membership.organization_id or exists(
          select 1 from organization.unitclosure closure
          where closure.ancestor_id=role.scope_id and closure.descendant_id=membership.organization_id))
      union
      select permission.code
      from access.membershipoverride overridepermission
      join access.permission permission on permission.id=overridepermission.permission_id and permission.status='active'
      where overridepermission.membership_id=membership.id and overridepermission.effect='deny'
        and overridepermission.revoked_at is null
        and overridepermission.effective_at<=clock_timestamp()
        and (overridepermission.expires_at is null or overridepermission.expires_at>clock_timestamp())
    ) denied),array[]::text[]),
    coalesce((select jsonb_agg(jsonb_build_object(
      'scope',access.scope_object(scopegrant.scope_id),
      'permissions',coalesce((select jsonb_agg(distinct allowed.code order by allowed.code) from (
          select permission.code
          from access.membershiprole assignment
          join access.role role on role.id=assignment.role_id and role.status='active'
          join access.rolepermission mapping on mapping.role_id=role.id and mapping.effect='allow'
          join access.permission permission on permission.id=mapping.permission_id and permission.status='active'
          where assignment.membership_id=membership.id
            and assignment.effective_at<=clock_timestamp()
            and (assignment.expires_at is null or assignment.expires_at>clock_timestamp())
            and (
              (role.id='role:self' and scopegrant.scope_kind in('self','owner'))
              or ((role.scope_id=membership.organization_id or exists(
                select 1 from organization.unitclosure closure
                where closure.ancestor_id=role.scope_id and closure.descendant_id=membership.organization_id))
                and (role.scope_id=scopegrant.scope_id or exists(
                  select 1 from organization.unitclosure closure
                  where closure.ancestor_id=role.scope_id and closure.descendant_id=scopegrant.scope_id)))
            )
          union
          select permission.code
          from access.membershipoverride overridepermission
          join access.permission permission on permission.id=overridepermission.permission_id and permission.status='active'
          where overridepermission.membership_id=membership.id and overridepermission.effect='allow'
            and overridepermission.revoked_at is null
            and overridepermission.effective_at<=clock_timestamp()
            and (overridepermission.expires_at is null or overridepermission.expires_at>clock_timestamp())
        ) allowed), '[]'::jsonb),
      'effective',scopegrant.effective_at,'expires',scopegrant.expires_at) order by scopegrant.scope_path)
      from access.scopegrant scopegrant
      where scopegrant.membership_id=membership.id and scopegrant.effect='allow'
        and scopegrant.access_version>0 and scopegrant.access_version<=membership.access_version
        and scopegrant.effective_at<=clock_timestamp()
        and (scopegrant.expires_at is null or scopegrant.expires_at>clock_timestamp())), '[]'::jsonb)
  from access.membership membership where membership.id=p_membership_id
$function$;

create or replace function capability.membership_operations(p_membership_id text)
returns table(operation_id text) language sql stable security definer
set search_path=capability,access,member,organization,runtime,pg_temp as $function$
  with resolved as materialized(
    select * from access.resolve_membership(p_membership_id)
  )
  select operation.operation_id from capability.operation operation
  where operation.audience<>'public'
    and exists(select 1 from access.membership membership
      join organization.unitclosure closure on closure.descendant_id=membership.organization_id
      join capability.entitlement entitlement on entitlement.scope_id=closure.ancestor_id
        and entitlement.capability_id=operation.capability_id
      where membership.id=p_membership_id and membership.status='active' and entitlement.state='enabled'
        and entitlement.effective_at<=clock_timestamp()
        and (entitlement.expires_at is null or entitlement.expires_at>clock_timestamp()))
    and (operation.permission_code is null or exists(
      select 1 from resolved
      cross join lateral jsonb_array_elements(resolved.grants) grantrow
      where resolved.active and (grantrow->'permissions') ? operation.permission_code
    ))
    and not exists(select 1 from resolved
      where operation.permission_code=any(resolved.denies))
$function$;

create or replace function access.protect_zhudatuan_pending_operator_role()
returns trigger language plpgsql
set search_path=pg_catalog,pg_temp as $function$
begin
  if tg_table_name='role' then
    if old.id='role-zhudatuan-pending-operator'
      or (tg_op='UPDATE' and new.id='role-zhudatuan-pending-operator') then
      raise exception 'ZHUDATUAN_PENDING_OPERATOR_ROLE_PROTECTED';
    end if;
  elsif new.role_id='role-zhudatuan-pending-operator' then
    raise exception 'ZHUDATUAN_PENDING_OPERATOR_PERMISSION_FORBIDDEN';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end
$function$;
revoke all on function access.protect_zhudatuan_pending_operator_role() from public,shopapp,shopjob,shopread;

drop trigger if exists protect_zhudatuan_pending_operator_role on access.role;
create trigger protect_zhudatuan_pending_operator_role
before update or delete on access.role
for each row execute function access.protect_zhudatuan_pending_operator_role();
drop trigger if exists protect_zhudatuan_pending_operator_permission on access.rolepermission;
create trigger protect_zhudatuan_pending_operator_permission
before insert or update on access.rolepermission
for each row execute function access.protect_zhudatuan_pending_operator_role();

create or replace function access.protect_zhudatuan_owner()
returns trigger language plpgsql
set search_path=pg_catalog,pg_temp as $function$
declare protected boolean := false;
begin
  if tg_table_schema='access' and tg_table_name='role' then
    if tg_op<>'INSERT' then protected := coalesce(old.id='role-platform-owner-v2',false); end if;
    if tg_op<>'DELETE' then protected := protected or coalesce(new.id='role-platform-owner-v2',false); end if;
  elsif tg_table_schema='access' and tg_table_name='membership' then
    if tg_op<>'INSERT' then
      protected := coalesce(old.id='membership-platform-owner-ethan-v1',false)
        or coalesce(old.member_id='member:zhudatuan:owner:ethan:v1',false);
    end if;
    if tg_op<>'DELETE' then
      protected := protected or coalesce(new.id='membership-platform-owner-ethan-v1',false)
        or coalesce(new.member_id='member:zhudatuan:owner:ethan:v1',false);
    end if;
  elsif tg_table_schema='access' and tg_table_name='membershiprole' then
    if tg_op<>'INSERT' then
      protected := coalesce(old.role_id='role-platform-owner-v2',false)
        or coalesce(old.membership_id='membership-platform-owner-ethan-v1',false);
    end if;
    if tg_op<>'DELETE' then
      protected := protected or coalesce(new.role_id='role-platform-owner-v2',false)
        or coalesce(new.membership_id='membership-platform-owner-ethan-v1',false);
    end if;
  elsif tg_table_schema='access' and tg_table_name='rolepermission' then
    if tg_op<>'INSERT' then protected := coalesce(old.role_id='role-platform-owner-v2',false); end if;
    if tg_op<>'DELETE' then protected := protected or coalesce(new.role_id='role-platform-owner-v2',false); end if;
  elsif tg_table_schema='access' and tg_table_name in('scopegrant','membershipoverride') then
    if tg_op<>'INSERT' then protected := coalesce(old.membership_id='membership-platform-owner-ethan-v1',false); end if;
    if tg_op<>'DELETE' then protected := protected or coalesce(new.membership_id='membership-platform-owner-ethan-v1',false); end if;
  elsif tg_table_schema='identity' and tg_table_name='principal' then
    if tg_op<>'INSERT' then protected := coalesce(old.id='principal:zhudatuan:owner:ethan:v1',false); end if;
    if tg_op<>'DELETE' then protected := protected or coalesce(new.id='principal:zhudatuan:owner:ethan:v1',false); end if;
  elsif tg_table_schema='identity' and tg_table_name='credential' then
    if tg_op<>'INSERT' then
      protected := coalesce(old.id='credential:password:zhudatuan-owner-ethan:v1',false)
        or coalesce(old.principal_id='principal:zhudatuan:owner:ethan:v1',false);
    end if;
    if tg_op<>'DELETE' then
      protected := protected or coalesce(new.id='credential:password:zhudatuan-owner-ethan:v1',false)
        or coalesce(new.principal_id='principal:zhudatuan:owner:ethan:v1',false);
    end if;
  elsif tg_table_schema='member' and tg_table_name='profile' then
    if tg_op<>'INSERT' then
      protected := coalesce(old.id='member:zhudatuan:owner:ethan:v1',false)
        or coalesce(old.principal_id='principal:zhudatuan:owner:ethan:v1',false);
    end if;
    if tg_op<>'DELETE' then
      protected := protected or coalesce(new.id='member:zhudatuan:owner:ethan:v1',false)
        or coalesce(new.principal_id='principal:zhudatuan:owner:ethan:v1',false);
    end if;
  end if;
  if not protected then
    if tg_op='DELETE' then return old; end if;
    return new;
  end if;
  if tg_table_schema='identity' and tg_table_name='credential' and tg_op='UPDATE' then
    if current_setting('app.workload',true)='api'
      and access.zhudatuan_owner_context()
      and new.id='credential:password:zhudatuan-owner-ethan:v1'
      and new.principal_id='principal:zhudatuan:owner:ethan:v1'
      and new.provider='password' and new.status='active'
      and new.secret_hash is not null and new.secret_hash is distinct from old.secret_hash
      and new.rotated_at>=transaction_timestamp() and new.rotated_at<=clock_timestamp()
      and (to_jsonb(new)-'secret_hash'-'rotated_at')=(to_jsonb(old)-'secret_hash'-'rotated_at')
    then return new; end if;
  end if;
  if tg_table_schema='identity' and tg_table_name='principal' and tg_op='UPDATE' then
    if current_setting('app.workload',true)='api'
      and access.zhudatuan_owner_context()
      and new.id='principal:zhudatuan:owner:ethan:v1' and new.status='active'
      and new.credential_version=old.credential_version+1
      and new.version=old.version+1
      and new.updated_at>=old.updated_at
      and new.updated_at>=transaction_timestamp() and new.updated_at<=clock_timestamp()
      and (to_jsonb(new)-'credential_version'-'version'-'updated_at')
        =(to_jsonb(old)-'credential_version'-'version'-'updated_at')
    then return new; end if;
  end if;
  if (current_database()='zhudatuan_registration' and current_user='shopmigration')
    or coalesce((select rolsuper from pg_roles where rolname=current_user),false) then
    if tg_op='DELETE' then return old; end if;
    return new;
  end if;
  raise exception 'ZHUDATUAN_OWNER_PROTECTED';
end
$function$;
revoke all on function access.protect_zhudatuan_owner()
  from public,shopapp,shopjob,shopread,zhudatuanidentityapi,zhudatuanidentityjob,zhudatuanbootstrap;

drop trigger if exists protect_zhudatuan_owner_role on access.role;
create trigger protect_zhudatuan_owner_role before insert or update or delete on access.role
for each row execute function access.protect_zhudatuan_owner();
drop trigger if exists protect_zhudatuan_owner_rolepermission on access.rolepermission;
create trigger protect_zhudatuan_owner_rolepermission before insert or update or delete on access.rolepermission
for each row execute function access.protect_zhudatuan_owner();
drop trigger if exists protect_zhudatuan_owner_membership on access.membership;
create trigger protect_zhudatuan_owner_membership before insert or update or delete on access.membership
for each row execute function access.protect_zhudatuan_owner();
drop trigger if exists protect_zhudatuan_owner_membershiprole on access.membershiprole;
create trigger protect_zhudatuan_owner_membershiprole before insert or update or delete on access.membershiprole
for each row execute function access.protect_zhudatuan_owner();
drop trigger if exists protect_zhudatuan_owner_scopegrant on access.scopegrant;
create trigger protect_zhudatuan_owner_scopegrant before insert or update or delete on access.scopegrant
for each row execute function access.protect_zhudatuan_owner();
drop trigger if exists protect_zhudatuan_owner_membershipoverride on access.membershipoverride;
create trigger protect_zhudatuan_owner_membershipoverride before insert or update or delete on access.membershipoverride
for each row execute function access.protect_zhudatuan_owner();
drop trigger if exists protect_zhudatuan_owner_principal on identity.principal;
create trigger protect_zhudatuan_owner_principal before insert or update or delete on identity.principal
for each row execute function access.protect_zhudatuan_owner();
drop trigger if exists protect_zhudatuan_owner_credential on identity.credential;
create trigger protect_zhudatuan_owner_credential before insert or update or delete on identity.credential
for each row execute function access.protect_zhudatuan_owner();
drop trigger if exists protect_zhudatuan_owner_profile on member.profile;
create trigger protect_zhudatuan_owner_profile before insert or update or delete on member.profile
for each row execute function access.protect_zhudatuan_owner();

create or replace function access.protect_scopegrant_deny_runtime()
returns trigger language plpgsql
set search_path=pg_catalog,pg_temp as $function$
begin
  if new.effect='deny'
    and current_user<>'shopmigration'
    and not coalesce((select rolsuper from pg_roles where rolname=current_user),false)
  then raise exception 'SCOPE_DENY_UNSUPPORTED'; end if;
  return new;
end
$function$;
revoke all on function access.protect_scopegrant_deny_runtime()
  from public,shopapp,shopjob,shopread,zhudatuanidentityapi,zhudatuanidentityjob,zhudatuanbootstrap;

drop trigger if exists protect_scopegrant_deny_runtime on access.scopegrant;
create trigger protect_scopegrant_deny_runtime
before insert or update on access.scopegrant
for each row execute function access.protect_scopegrant_deny_runtime();

create or replace function access.protect_zhudatuan_registration_access_write()
returns trigger language plpgsql security definer
set search_path=pg_catalog,pg_temp
set row_security=off as $function$
declare
  candidate_membership access.membership%rowtype;
  candidate_principal text;
  registration_allowed boolean := false;
begin
  if session_user<>'zhudatuanidentityapi'
    and coalesce(current_setting('role',true),'')<>'zhudatuanidentityapi'
  then return new; end if;

  if tg_table_name='membership' then
    candidate_membership := new;
  else
    select membership.* into candidate_membership
    from access.membership membership where membership.id=new.membership_id;
    if not found then raise exception 'ZHUDATUAN_REGISTRATION_MEMBERSHIP_REQUIRED'; end if;
  end if;

  select profile.principal_id,
    exists(
      select 1 from member.invite invite
      where invite.status='active' and invite.max_uses=1 and invite.use_count=invite.max_uses
        and invite.accepted_at>=transaction_timestamp()
        and (
          (invite.target_client='storefront'
            and invite.role_id='role-zhudatuan-storefront-member'
            and invite.organization_id=candidate_membership.organization_id
            and candidate_membership.client='storefront')
          or (invite.target_client='operator'
            and invite.role_id='role-zhudatuan-pending-operator'
            and invite.organization_id='tenant-zhudatuan'
            and invite.storefront_organization_id='mall-zhudatuan'
            and invite.allowed_destination_hash=profile.mobile_token
            and (
              (candidate_membership.client='storefront'
                and candidate_membership.organization_id=invite.storefront_organization_id)
              or (candidate_membership.client='operator'
                and candidate_membership.organization_id=invite.organization_id)
            ))
        )
    ) into candidate_principal,registration_allowed
  from member.profile profile
  join identity.principal principal on principal.id=profile.principal_id and principal.status='active'
  join identity.credential credential on credential.principal_id=principal.id
    and credential.provider='password' and credential.subject_hash=profile.mobile_token
    and credential.status='active' and credential.created_at>=transaction_timestamp()
  where profile.id=candidate_membership.member_id and profile.status='active'
    and profile.created_at>=transaction_timestamp();

  if candidate_membership.status<>'active' or candidate_membership.access_version<>1
    or candidate_membership.joined_at is null or candidate_membership.left_at is not null
    or candidate_membership.employee_no is not null or not coalesce(registration_allowed,false)
  then raise exception 'ZHUDATUAN_REGISTRATION_MEMBERSHIP_BOUNDARY_INVALID'; end if;

  if tg_table_name='membershiprole' then
    if new.expires_at is not null or new.delegated_by is not null
      or new.effective_at<transaction_timestamp()
      or not (
        new.role_id='role:self'
        or (candidate_membership.client='storefront'
          and candidate_membership.organization_id='mall-zhudatuan'
          and new.role_id='role-zhudatuan-storefront-member')
        or (candidate_membership.client='operator'
          and candidate_membership.organization_id='tenant-zhudatuan'
          and new.role_id='role-zhudatuan-pending-operator')
      )
    then raise exception 'ZHUDATUAN_REGISTRATION_ROLE_BOUNDARY_INVALID'; end if;
  elsif tg_table_name='scopegrant' then
    if new.effect<>'allow' or new.expires_at is not null or new.access_version<>1
      or new.effective_at<transaction_timestamp()
      or not (
        (candidate_membership.client='storefront' and (
          (new.scope_kind='mall' and new.scope_id='mall-zhudatuan' and new.scope_path='mall-zhudatuan')
          or (new.scope_kind='owner' and new.scope_id=candidate_membership.member_id
            and new.scope_path=candidate_membership.member_id)
          or (new.scope_kind='self' and new.scope_id='self:'||candidate_principal
            and new.scope_path='self:'||candidate_principal)
        ))
        or (candidate_membership.client='operator' and (
          (new.scope_kind='tenant' and new.scope_id='tenant-zhudatuan' and new.scope_path='tenant-zhudatuan')
          or (new.scope_kind='self' and new.scope_id='self:'||candidate_principal
            and new.scope_path='self:'||candidate_principal)
        ))
      )
    then raise exception 'ZHUDATUAN_REGISTRATION_SCOPE_BOUNDARY_INVALID'; end if;
  end if;
  return new;
end
$function$;
revoke all on function access.protect_zhudatuan_registration_access_write()
  from public,shopapp,shopjob,shopread,zhudatuanidentityapi;

drop trigger if exists protect_zhudatuan_registration_membership_write on access.membership;
create trigger protect_zhudatuan_registration_membership_write
before insert on access.membership
for each row execute function access.protect_zhudatuan_registration_access_write();
drop trigger if exists protect_zhudatuan_registration_membershiprole_write on access.membershiprole;
create trigger protect_zhudatuan_registration_membershiprole_write
before insert on access.membershiprole
for each row execute function access.protect_zhudatuan_registration_access_write();
drop trigger if exists protect_zhudatuan_registration_scopegrant_write on access.scopegrant;
create trigger protect_zhudatuan_registration_scopegrant_write
before insert on access.scopegrant
for each row execute function access.protect_zhudatuan_registration_access_write();

create or replace function member.protect_zhudatuan_invite_update()
returns trigger language plpgsql
set search_path=pg_catalog,pg_temp as $function$
declare
  authenticated boolean := nullif(current_setting('app.membership_id',true),'') is not null;
  authorization_scope text := nullif(current_setting('app.scope_id',true),'');
  management_allowed boolean := false;
begin
  if current_user not in('shopapp','zhudatuanidentityapi') then
    if tg_op='DELETE' then return old; end if;
    return new;
  end if;
  if tg_op='DELETE' then raise exception 'ZHUDATUAN_INVITATION_DELETE_BOUNDARY_INVALID'; end if;
  if tg_op='INSERT' then
    if not authenticated then raise exception 'ZHUDATUAN_INVITATION_CREATE_BOUNDARY_INVALID'; end if;
    if new.target_client='operator' then
      management_allowed := new.organization_id='tenant-zhudatuan'
        and authorization_scope='tenant-zhudatuan'
        and ((current_user='zhudatuanidentityapi' and access.zhudatuan_invitation_owner())
          or (current_user='shopapp' and access.zhudatuan_owner_context()))
        and new.created_by='membership-platform-owner-ethan-v1'
        and new.role_id='role-zhudatuan-pending-operator'
        and new.storefront_organization_id is not null
        and new.allowed_destination_hash is not null and new.max_uses=1;
    else
      management_allowed := current_user='shopapp'
        and authorization_scope=new.organization_id
        and new.created_by=nullif(current_setting('app.membership_id',true),'')
        and new.role_id='role-zhudatuan-storefront-member'
        and new.storefront_organization_id is null and new.allowed_destination_hash is null
        and exists(select 1 from organization.organization scope
          where scope.id=authorization_scope and scope.kind='mall' and scope.status='active')
        and exists(select 1 from access.role role
          where role.id=new.role_id and role.scope_id=authorization_scope and role.status='active')
        and exists(
          select 1 from access.resolve_membership(nullif(current_setting('app.membership_id',true),'')) resolved
          cross join lateral jsonb_array_elements(resolved.grants) grantrow
          where resolved.active and not ('identity.invitation.manage'=any(resolved.denies))
            and grantrow->'scope'->>'id'=authorization_scope
            and (grantrow->'permissions') ? 'identity.invitation.manage'
        );
    end if;
    if not management_allowed or new.status<>'active' or new.use_count<>0 or new.accepted_at is not null
      or new.version<>0 or new.effective_at>clock_timestamp() or new.expires_at<=clock_timestamp()
    then raise exception 'ZHUDATUAN_INVITATION_CREATE_BOUNDARY_INVALID'; end if;
    return new;
  end if;
  if new.id is distinct from old.id
    or new.organization_id is distinct from old.organization_id
    or new.label is distinct from old.label
    or new.destination_hash is distinct from old.destination_hash
    or new.token_hash is distinct from old.token_hash
    or new.expires_at is distinct from old.expires_at
    or new.created_by is distinct from old.created_by
    or new.role_id is distinct from old.role_id
    or new.allowed_destination_hash is distinct from old.allowed_destination_hash
    or new.max_uses is distinct from old.max_uses
    or new.effective_at is distinct from old.effective_at
    or new.created_at is distinct from old.created_at
    or new.registration_policy_id is distinct from old.registration_policy_id
    or new.terms_hash is distinct from old.terms_hash
    or new.target_client is distinct from old.target_client
    or new.storefront_organization_id is distinct from old.storefront_organization_id
  then raise exception 'ZHUDATUAN_INVITATION_IMMUTABLE_BOUNDARY_INVALID'; end if;

  if authenticated then
    if old.target_client='operator' then
      management_allowed := old.organization_id='tenant-zhudatuan'
        and authorization_scope='tenant-zhudatuan'
        and ((current_user='zhudatuanidentityapi' and access.zhudatuan_invitation_owner())
          or (current_user='shopapp' and access.zhudatuan_owner_context()));
    elsif current_user='zhudatuanidentityapi' then
      management_allowed := false;
    else
      management_allowed := authorization_scope is not null and exists(
          select 1 from access.membership membership
          join access.scopegrant scopegrant on scopegrant.membership_id=membership.id
            and scopegrant.effect='allow' and scopegrant.access_version>0
            and scopegrant.access_version<=membership.access_version
            and scopegrant.effective_at<=clock_timestamp()
            and (scopegrant.expires_at is null or scopegrant.expires_at>clock_timestamp())
          where membership.id=nullif(current_setting('app.membership_id',true),'')
            and membership.status='active'
            and (authorization_scope=old.organization_id or exists(
              select 1 from organization.unitclosure closure
              where closure.ancestor_id=authorization_scope and closure.descendant_id=old.organization_id))
            and (scopegrant.scope_id=authorization_scope or exists(
              select 1 from organization.unitclosure closure
              where closure.ancestor_id=scopegrant.scope_id and closure.descendant_id=authorization_scope))
            and (scopegrant.scope_id=old.organization_id or exists(
              select 1 from organization.unitclosure closure
              where closure.ancestor_id=scopegrant.scope_id and closure.descendant_id=old.organization_id))
            and (
              exists(
                select 1 from access.membershiprole assignment
                join access.role role on role.id=assignment.role_id and role.status='active'
                join access.rolepermission mapping on mapping.role_id=role.id and mapping.effect='allow'
                join access.permission permission on permission.id=mapping.permission_id
                  and permission.code='identity.invitation.manage' and permission.status='active'
                where assignment.membership_id=membership.id
                  and assignment.effective_at<=clock_timestamp()
                  and (assignment.expires_at is null or assignment.expires_at>clock_timestamp())
                  and (role.scope_id=membership.organization_id or exists(
                    select 1 from organization.unitclosure closure
                    where closure.ancestor_id=role.scope_id and closure.descendant_id=membership.organization_id))
                  and (role.scope_id=authorization_scope or exists(
                    select 1 from organization.unitclosure closure
                    where closure.ancestor_id=role.scope_id and closure.descendant_id=authorization_scope))
                  and (role.scope_id=old.organization_id or exists(
                    select 1 from organization.unitclosure closure
                    where closure.ancestor_id=role.scope_id and closure.descendant_id=old.organization_id))
              ) or exists(
                select 1 from access.membershipoverride overridepermission
                join access.permission permission on permission.id=overridepermission.permission_id
                  and permission.code='identity.invitation.manage' and permission.status='active'
                where overridepermission.membership_id=membership.id and overridepermission.effect='allow'
                  and overridepermission.revoked_at is null
                  and overridepermission.effective_at<=clock_timestamp()
                  and (overridepermission.expires_at is null or overridepermission.expires_at>clock_timestamp())
              )
            )
        )
        and not exists(
          select 1 from access.membershiprole assignment
          join access.membership membership on membership.id=assignment.membership_id and membership.status='active'
          join access.role role on role.id=assignment.role_id and role.status='active'
          join access.rolepermission mapping on mapping.role_id=role.id and mapping.effect='deny'
          join access.permission permission on permission.id=mapping.permission_id
            and permission.code='identity.invitation.manage' and permission.status='active'
          where assignment.membership_id=nullif(current_setting('app.membership_id',true),'')
            and assignment.effective_at<=clock_timestamp()
            and (assignment.expires_at is null or assignment.expires_at>clock_timestamp())
            and (role.scope_id=membership.organization_id or exists(
              select 1 from organization.unitclosure closure
              where closure.ancestor_id=role.scope_id and closure.descendant_id=membership.organization_id))
        )
        and not exists(
          select 1 from access.membershipoverride denied
          join access.permission permission on permission.id=denied.permission_id
            and permission.code='identity.invitation.manage' and permission.status='active'
          where denied.membership_id=nullif(current_setting('app.membership_id',true),'')
            and denied.effect='deny' and denied.revoked_at is null
            and denied.effective_at<=clock_timestamp()
            and (denied.expires_at is null or denied.expires_at>clock_timestamp())
        );
    end if;
    if not management_allowed or old.status<>'active' or new.status<>'disabled'
      or new.use_count<>old.use_count or new.accepted_at is distinct from old.accepted_at
      or new.version<>old.version+1
    then raise exception 'ZHUDATUAN_INVITATION_REVOKE_BOUNDARY_INVALID'; end if;
  else
    if old.status<>'active' or new.status<>old.status
      or new.use_count<>old.use_count+1 or new.use_count>new.max_uses
      or new.version<>old.version+1
      or (new.use_count<new.max_uses and new.accepted_at is distinct from old.accepted_at)
      or (new.use_count=new.max_uses and (new.accepted_at is null
        or new.accepted_at<transaction_timestamp() or new.accepted_at>clock_timestamp()))
    then raise exception 'ZHUDATUAN_INVITATION_CONSUME_BOUNDARY_INVALID'; end if;
  end if;
  return new;
end
$function$;
revoke all on function member.protect_zhudatuan_invite_update()
  from public,shopapp,shopjob,shopread,zhudatuanidentityapi;

drop trigger if exists protect_zhudatuan_invite_update on member.invite;
create trigger protect_zhudatuan_invite_update
before insert or update or delete on member.invite
for each row execute function member.protect_zhudatuan_invite_update();

create or replace function access.zhudatuan_owner_context()
returns boolean language sql stable
set search_path=pg_catalog,pg_temp as $function$
  select current_user in('shopapp','zhudatuanidentityapi')
    and nullif(current_setting('app.membership_id',true),'')='membership-platform-owner-ethan-v1'
    and nullif(current_setting('app.actor_id',true),'')='principal:zhudatuan:owner:ethan:v1'
    and nullif(current_setting('app.scope_id',true),'') in(
      'tenant-zhudatuan','self:principal:zhudatuan:owner:ethan:v1')
    and exists(
      select 1
      from access.membership membership
      join member.profile profile on profile.id=membership.member_id
        and profile.principal_id='principal:zhudatuan:owner:ethan:v1' and profile.status='active'
      join identity.principal principal on principal.id=profile.principal_id and principal.status='active'
      join access.membershiprole assignment on assignment.membership_id=membership.id
        and assignment.role_id='role-platform-owner-v2'
        and assignment.effective_at<=clock_timestamp()
        and (assignment.expires_at is null or assignment.expires_at>clock_timestamp())
      join access.role role on role.id=assignment.role_id and role.scope_id='tenant-zhudatuan' and role.status='active'
      where membership.id='membership-platform-owner-ethan-v1'
        and membership.organization_id='tenant-zhudatuan'
        and membership.client='operator' and membership.status='active'
        and exists(select 1 from access.scopegrant grantrow
          where grantrow.membership_id=membership.id and grantrow.scope_kind='tenant'
            and grantrow.scope_id='tenant-zhudatuan' and grantrow.effect='allow'
            and grantrow.access_version=membership.access_version
            and grantrow.effective_at<=clock_timestamp()
            and (grantrow.expires_at is null or grantrow.expires_at>clock_timestamp()))
    )
$function$;
revoke all on function access.zhudatuan_owner_context() from public,shopjob,shopread;
grant execute on function access.zhudatuan_owner_context() to shopapp,zhudatuanidentityapi;

create or replace function access.zhudatuan_invitation_owner()
returns boolean language sql stable
set search_path=pg_catalog,pg_temp as $function$
  select current_user='zhudatuanidentityapi'
    and access.zhudatuan_owner_context()
    and nullif(current_setting('app.scope_id',true),'')='tenant-zhudatuan'
    and exists(select 1 from access.rolepermission mapping
      join access.permission permission on permission.id=mapping.permission_id
      where mapping.role_id='role-platform-owner-v2' and mapping.effect='allow'
        and permission.code='identity.invitation.manage' and permission.status='active'
        and not exists(select 1 from access.membershipoverride denied
          where denied.membership_id='membership-platform-owner-ethan-v1'
            and denied.permission_id=permission.id and denied.effect='deny' and denied.revoked_at is null
            and denied.effective_at<=clock_timestamp()
            and (denied.expires_at is null or denied.expires_at>clock_timestamp())))
$function$;
revoke all on function access.zhudatuan_invitation_owner() from public,shopapp,shopjob,shopread;
grant execute on function access.zhudatuan_invitation_owner() to zhudatuanidentityapi;

drop policy if exists zhudatuanidentityapi on access.membership;
drop policy if exists zhudatuanidentityapiinsert on access.membership;
create policy zhudatuanidentityapi on access.membership for select to zhudatuanidentityapi using(true);
create policy zhudatuanidentityapiinsert on access.membership for insert to zhudatuanidentityapi with check(
  nullif(current_setting('app.membership_id',true),'') is null
  and status='active' and access_version=1 and joined_at is not null and left_at is null and employee_no is null
  and (
    (client='storefront' and organization_id='mall-zhudatuan')
    or (client='operator' and organization_id='tenant-zhudatuan')
  )
);

drop policy if exists zhudatuanidentityapi on access.membershiprole;
drop policy if exists zhudatuanidentityapiinsert on access.membershiprole;
create policy zhudatuanidentityapi on access.membershiprole for select to zhudatuanidentityapi using(true);
create policy zhudatuanidentityapiinsert on access.membershiprole for insert to zhudatuanidentityapi with check(
  nullif(current_setting('app.membership_id',true),'') is null
  and expires_at is null and delegated_by is null and effective_at>=transaction_timestamp()
  and exists(select 1 from access.membership membership where membership.id=membership_id and (
    role_id='role:self'
    or (membership.client='storefront' and membership.organization_id='mall-zhudatuan'
      and role_id='role-zhudatuan-storefront-member')
    or (membership.client='operator' and membership.organization_id='tenant-zhudatuan'
      and role_id='role-zhudatuan-pending-operator')
  ))
);

drop policy if exists zhudatuanidentityapi on access.scopegrant;
drop policy if exists zhudatuanidentityapiinsert on access.scopegrant;
create policy zhudatuanidentityapi on access.scopegrant for select to zhudatuanidentityapi using(true);
create policy zhudatuanidentityapiinsert on access.scopegrant for insert to zhudatuanidentityapi with check(
  nullif(current_setting('app.membership_id',true),'') is null
  and effect='allow' and expires_at is null and access_version=1 and effective_at>=transaction_timestamp()
  and exists(select 1 from access.membership membership
    join member.profile profile on profile.id=membership.member_id
    where membership.id=membership_id and (
      (membership.client='storefront' and membership.organization_id='mall-zhudatuan' and (
        (scope_kind='mall' and scope_id='mall-zhudatuan' and scope_path='mall-zhudatuan')
        or (scope_kind='owner' and scope_id=membership.member_id and scope_path=membership.member_id)
        or (scope_kind='self' and scope_id='self:'||profile.principal_id and scope_path='self:'||profile.principal_id)
      ))
      or (membership.client='operator' and membership.organization_id='tenant-zhudatuan' and (
        (scope_kind='tenant' and scope_id='tenant-zhudatuan' and scope_path='tenant-zhudatuan')
        or (scope_kind='self' and scope_id='self:'||profile.principal_id and scope_path='self:'||profile.principal_id)
      ))
    ))
);

drop policy if exists zhudatuanidentityapi on member.invite;
drop policy if exists zhudatuanidentityapiinsert on member.invite;
drop policy if exists zhudatuanidentityapiupdate on member.invite;

create policy zhudatuanidentityapi on member.invite for select to zhudatuanidentityapi using(
  (
    nullif(current_setting('app.membership_id',true),'') is null
    and status='active' and effective_at<=clock_timestamp() and expires_at>clock_timestamp()
    and (use_count<max_uses or (use_count=max_uses and accepted_at>=transaction_timestamp()))
    and (
      (target_client='storefront' and role_id='role-zhudatuan-storefront-member'
        and organization_id='mall-zhudatuan' and storefront_organization_id is null)
      or (target_client='operator' and role_id='role-zhudatuan-pending-operator'
        and organization_id='tenant-zhudatuan' and storefront_organization_id='mall-zhudatuan'
        and allowed_destination_hash is not null and max_uses=1)
    )
  ) or (
    access.zhudatuan_invitation_owner()
    and target_client='operator' and organization_id='tenant-zhudatuan'
  )
);

create policy zhudatuanidentityapiinsert on member.invite for insert to zhudatuanidentityapi with check(
  access.zhudatuan_invitation_owner()
  and created_by='membership-platform-owner-ethan-v1'
  and target_client='operator' and role_id='role-zhudatuan-pending-operator'
  and organization_id='tenant-zhudatuan'
  and storefront_organization_id='mall-zhudatuan' and allowed_destination_hash is not null
  and max_uses=1 and use_count=0 and status='active'
  and accepted_at is null and effective_at<=clock_timestamp() and expires_at>clock_timestamp()
  and exists(select 1 from organization.organization storefront
    join organization.unitclosure closure on closure.descendant_id=storefront.id
    where storefront.id=member.invite.storefront_organization_id and storefront.kind='mall' and storefront.status='active'
      and closure.ancestor_id=member.invite.organization_id)
  and exists(select 1 from access.role pending
    where pending.id=member.invite.role_id and pending.scope_id=member.invite.organization_id and pending.status='active')
  and not exists(select 1 from access.rolepermission pendingpermission where pendingpermission.role_id=member.invite.role_id)
);

create policy zhudatuanidentityapiupdate on member.invite for update to zhudatuanidentityapi using(
  (
    nullif(current_setting('app.membership_id',true),'') is null
    and status='active' and effective_at<=clock_timestamp() and expires_at>clock_timestamp() and use_count<max_uses
    and (
      (target_client='storefront' and role_id='role-zhudatuan-storefront-member'
        and organization_id='mall-zhudatuan' and storefront_organization_id is null)
      or (target_client='operator' and role_id='role-zhudatuan-pending-operator'
        and organization_id='tenant-zhudatuan' and storefront_organization_id='mall-zhudatuan'
        and allowed_destination_hash is not null and max_uses=1)
    )
  ) or (
    access.zhudatuan_invitation_owner()
    and target_client='operator' and organization_id='tenant-zhudatuan'
  )
) with check(
  (
    nullif(current_setting('app.membership_id',true),'') is null
    and status='active' and use_count<=max_uses
    and (
      (target_client='storefront' and role_id='role-zhudatuan-storefront-member'
        and organization_id='mall-zhudatuan' and storefront_organization_id is null)
      or (target_client='operator' and role_id='role-zhudatuan-pending-operator'
        and organization_id='tenant-zhudatuan' and storefront_organization_id='mall-zhudatuan'
        and allowed_destination_hash is not null and max_uses=1)
    )
  ) or (
    access.zhudatuan_invitation_owner()
    and target_client='operator' and organization_id='tenant-zhudatuan'
    and role_id='role-zhudatuan-pending-operator'
    and storefront_organization_id='mall-zhudatuan'
    and allowed_destination_hash is not null and max_uses=1 and status='disabled'
  )
);

insert into runtime.schemaversion(version,checksum)
values('20260829060000','b1e238eb8de569b0de9d1d2766620e1f661268d2f9260e646208d4f24715b37a')
on conflict(version) do nothing;

commit;
