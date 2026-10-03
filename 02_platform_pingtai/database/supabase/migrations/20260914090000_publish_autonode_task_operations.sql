begin;

insert into runtime.operation(id,owner,method,path,contract_version) values
  ('provisioning.nodetasks.read','provisioning','GET','/api/v1/provisioning/node-tasks/{taskid}','1.0.0'),
  ('provisioning.nodetasks.retry','provisioning','POST','/api/v1/provisioning/node-tasks/{taskid}/retry','1.0.0');

insert into capability.capability(id,kind,name,version,status) values
  ('provisioning.nodetasks.read','operation','provisioning.nodetasks.read',1,'active'),
  ('provisioning.nodetasks.retry','operation','provisioning.nodetasks.retry',1,'active');

insert into capability.operation(operation_id,capability_id,permission_code,audience) values
  ('provisioning.nodetasks.read','provisioning.nodetasks.read','organization.layer.read','operator'),
  ('provisioning.nodetasks.retry','provisioning.nodetasks.retry','organization.layer.manage','operator');

insert into capability.entitlement(id,scope_id,capability_id,state,quota,effective_at,expires_at,version)
select 'autonode:'||organization.id||':'||capability.id,organization.id,capability.id,'enabled',null,
  '1970-01-01T00:00:00Z',null,0
from organization.organization organization
cross join (values('provisioning.nodetasks.read'),('provisioning.nodetasks.retry')) capability(id)
where organization.status='active' and (
  (organization.kind='platform' and organization.parent_id is null)
  or organization.id='mall:d1708f04df2dd8a61736852c4900fb43'
);

alter policy zhudatuanprovisioningapi on runtime.schemaversion
  using(version in('20260821032000','20260821054000','20260901223000','20260902012000',
    '20260903103000','20260903104000','20260903105000','20260914090000'));

insert into runtime.schemaversion(version,checksum)
values('20260914090000','241214fa70737025d993740f79c59bca7867d6f4540da0041c863b0d45916594');


commit;
