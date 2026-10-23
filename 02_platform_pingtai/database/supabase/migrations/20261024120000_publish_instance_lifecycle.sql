begin;

insert into runtime.operation(id,owner,method,path,contract_version) values
  ('provisioning.instances.read','provisioning','GET','/api/v1/provisioning/instances','1.0.0'),
  ('provisioning.instances.manage','provisioning','POST','/api/v1/provisioning/instances/{instanceid}/actions','1.0.0')
on conflict(id) do nothing;
insert into capability.capability(id,kind,name,version,status) values
  ('provisioning.instances.read','operation','provisioning.instances.read',1,'active'),
  ('provisioning.instances.manage','operation','provisioning.instances.manage',1,'active')
on conflict(id) do nothing;
insert into capability.operation(operation_id,capability_id,permission_code,audience) values
  ('provisioning.instances.read','provisioning.instances.read','organization.layer.read','operator'),
  ('provisioning.instances.manage','provisioning.instances.manage','organization.layer.manage','operator')
on conflict(operation_id) do nothing;
insert into capability.entitlement(id,scope_id,capability_id,state,quota,effective_at,expires_at,version)
select 'autonode:'||organization.id||':'||capability.id,organization.id,capability.id,'enabled',null,
  '1970-01-01T00:00:00Z',null,0
from organization.organization organization
cross join (values('provisioning.instances.read'),('provisioning.instances.manage')) capability(id)
where organization.status='active' and organization.kind='platform' and organization.parent_id is null
on conflict(id) do nothing;

insert into runtime.schemaversion(version,checksum)
values('20261024120000',encode(public.digest('publish-instance-lifecycle-v1','sha256'),'hex'));
commit;
