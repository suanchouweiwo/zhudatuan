begin;

create or replace function access.protect_zhudatuan_registration_access_write()
returns trigger language plpgsql security definer
set search_path=pg_catalog,pg_temp
set row_security=off as $function$
declare
  candidate_membership access.membership%rowtype;
  candidate_principal text;
  candidate_subject_hash text;
  candidate_invitation_role text;
  candidate_registration_role text;
  candidate_management_organization text;
  registration_challenge_allowed boolean := false;
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

  select profile.principal_id,credential.subject_hash,
    (
      select invite.role_id
      from member.invite invite
      where invite.status='active' and invite.max_uses=1 and invite.use_count=invite.max_uses
        and invite.accepted_at>=transaction_timestamp()
        and (
          (invite.target_client='storefront'
            and invite.role_id=case when invite.organization_id='mall-zhudatuan'
              then 'role-zhudatuan-storefront-member'
              else 'role-zhudatuan-storefront-member:'||invite.organization_id end
            and invite.organization_id=candidate_membership.organization_id
            and candidate_membership.client='storefront')
          or (invite.target_client='operator'
            and (invite.role_id='role-zhudatuan-pending-operator'
              or invite.role_id='role-senior-administrator-v1:'||invite.organization_id)
            and invite.storefront_organization_id is not null
            and invite.allowed_destination_hash=credential.subject_hash
            and candidate_membership.client='operator'
            and candidate_membership.organization_id=invite.storefront_organization_id
            and exists(select 1 from identity.realmtarget target
              where target.realm_id=candidate_membership.realm_id
                and target.target='console' and target.surface='admin'
                and target.membership_client='operator'
                and target.membership_organization_id=candidate_membership.organization_id)
            and exists(select 1 from organization.unitclosure closure
              where closure.ancestor_id=invite.organization_id
                and closure.descendant_id=candidate_membership.organization_id))
        )
      order by invite.accepted_at desc,invite.id
      limit 1
    ),
    (
      select invite.organization_id
      from member.invite invite
      where invite.status='active' and invite.target_client='operator'
        and invite.max_uses=1 and invite.use_count=invite.max_uses
        and invite.accepted_at>=transaction_timestamp()
        and invite.allowed_destination_hash=credential.subject_hash
        and invite.storefront_organization_id=candidate_membership.organization_id
        and (invite.role_id='role-zhudatuan-pending-operator'
          or invite.role_id='role-senior-administrator-v1:'||invite.organization_id)
        and exists(select 1 from organization.unitclosure closure
          where closure.ancestor_id=invite.organization_id
            and closure.descendant_id=candidate_membership.organization_id)
      order by invite.accepted_at desc,invite.id
      limit 1
    ),
    exists(
      select 1 from identity.challenge challenge
      where challenge.purpose='registration'
        and challenge.destination_hash=credential.subject_hash
        and challenge.consumed_at>=transaction_timestamp()
    )
  into candidate_principal,candidate_subject_hash,candidate_invitation_role,
    candidate_management_organization,registration_challenge_allowed
  from member.profile profile
  join identity.principal principal on principal.id=profile.principal_id and principal.status='active'
  join identity.account account on account.id=candidate_membership.account_id
    and account.realm_id=candidate_membership.realm_id
    and account.legacy_principal_id=principal.id and account.status='active'
  join identity.credential credential on credential.principal_id=principal.id
    and credential.provider='password' and credential.status='active'
    and credential.subject_hash=profile.mobile_token
  where profile.id=candidate_membership.member_id and profile.status='active'
    and profile.mobile_ciphertext is not null and profile.mobile_token is not null;

  candidate_registration_role := candidate_invitation_role;
  registration_allowed := candidate_invitation_role is not null
    and coalesce(registration_challenge_allowed,false);

  if candidate_membership.client='storefront'
    and candidate_membership.organization_id='mall-zhudatuan'
    and current_setting('app.registration_mall_id',true)=candidate_membership.organization_id
    and current_setting('app.registration_phone_verification',true)='checkout'
  then
    select role.id into candidate_registration_role
    from access.role role
    join organization.organization mall on mall.id=role.scope_id
    where role.id='role-zhudatuan-storefront-member'
      and role.status='active'
      and mall.id=candidate_membership.organization_id
      and mall.kind='mall' and mall.status='active';
    registration_allowed := candidate_registration_role is not null;
  end if;
  if candidate_subject_hash is null
    or candidate_membership.status<>'active' or candidate_membership.access_version<>1
    or candidate_membership.joined_at is null or candidate_membership.left_at is not null
    or candidate_membership.employee_no is not null or not registration_allowed
  then raise exception 'ZHUDATUAN_REGISTRATION_MEMBERSHIP_BOUNDARY_INVALID'; end if;

  if tg_table_name='membershiprole' then
    if new.expires_at is not null or new.delegated_by is not null
      or new.effective_at<transaction_timestamp()
      or new.role_id not in('role:self',candidate_registration_role)
    then raise exception 'ZHUDATUAN_REGISTRATION_ROLE_BOUNDARY_INVALID'; end if;
  elsif tg_table_name='scopegrant' then
    if new.effect<>'allow' or new.expires_at is not null or new.access_version<>1
      or new.effective_at<transaction_timestamp()
      or not (
        (candidate_membership.client='storefront' and (
          (new.scope_kind='mall' and new.scope_id=candidate_membership.organization_id
            and new.scope_path=candidate_membership.organization_id)
          or (new.scope_kind='owner' and new.scope_id=candidate_membership.member_id
            and new.scope_path=candidate_membership.member_id)
          or (new.scope_kind='self' and new.scope_id='self:'||candidate_principal
            and new.scope_path='self:'||candidate_principal)
        ))
        or (candidate_membership.client='operator' and (
          (new.scope_kind='tenant' and new.scope_id=candidate_management_organization
            and new.scope_path=candidate_management_organization)
          or (new.scope_kind='self' and new.scope_id='self:'||candidate_principal
            and new.scope_path='self:'||candidate_principal)
        ))
      )
    then raise exception 'ZHUDATUAN_REGISTRATION_SCOPE_BOUNDARY_INVALID'; end if;
  end if;
  return new;
end
$function$;

insert into runtime.schemaversion(version,checksum)
values('20261126003000',encode(public.digest('restore-zhudatuan-storefront-checkout-phone-registration-v1','sha256'),'hex'));

commit;
