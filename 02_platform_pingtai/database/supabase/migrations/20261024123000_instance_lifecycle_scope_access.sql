begin;
grant execute on function access.scope_allowed(text) to zhudatuanprovisioningapi;
insert into runtime.schemaversion(version,checksum)
values('20261024123000',encode(public.digest('instance-lifecycle-scope-access-v1','sha256'),'hex'));
commit;
