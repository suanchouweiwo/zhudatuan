begin;

insert into runtime.operation(id,owner,method,path,contract_version)
values('provisioning.malls.create','provisioning','POST','/api/v1/provisioning/malls','1.0.0');

insert into access.permission(id,code,risk,status)
values('permission:326a6cd0a1184e734fc3d2d6','organization.layer.manage','critical','active');

insert into capability.capability(id,kind,name,version,status)
values('provisioning.malls.create','operation','provisioning.malls.create',1,'active');

insert into capability.operation(operation_id,capability_id,permission_code,audience)
values('provisioning.malls.create','provisioning.malls.create','organization.layer.manage','operator');

insert into capability.entitlement(id,scope_id,capability_id,state,quota,effective_at,expires_at,version)
values('platform:provisioning.malls.create','organization-platform-root','provisioning.malls.create','enabled',null,
  '1970-01-01T00:00:00Z',null,0);

delete from access.rolepermission mapping using access.permission permission
where mapping.role_id='role-platform-owner-v2' and mapping.permission_id=permission.id
  and permission.code='organization.layer.manage' and mapping.effect='deny';

insert into access.rolepermission(role_id,permission_id,effect)
select 'role-platform-owner-v2',permission.id,'allow' from access.permission permission
where permission.code='organization.layer.manage' and permission.status='active'
on conflict do nothing;

insert into runtime.schemaversion(version,checksum)
values('20260901223000','c95f702b55319f504b809e3f34865fe2120052d9cd4e6a09b43cefed655a7bde');

commit;
