begin;
-- ON CONFLICT(id) requires reading the conflict key as well as INSERT.
grant select(id) on runtime.outbox to zhudatuanprovisioningapi;
insert into runtime.schemaversion(version,checksum)
values('20261024121000',encode(public.digest('instance-lifecycle-outbox-access-v1','sha256'),'hex'));
commit;
