begin;
create policy zhudatuanprovisioningapiselect on runtime.outbox
for select to zhudatuanprovisioningapi using(access.scope_allowed(scope_id));
insert into runtime.schemaversion(version,checksum)
values('20261024122000',encode(public.digest('instance-lifecycle-outbox-policy-v1','sha256'),'hex'));
commit;
