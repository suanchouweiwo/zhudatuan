begin;

grant usage on schema identity_display to zhudatuanidentityapi;
grant select,insert on identity_display.code_mapping to zhudatuanidentityapi;

insert into runtime.schemaversion(version,checksum)
values('20260916160000',encode(public.digest('identity-display-runtime-acl:v1','sha256'),'hex'));

commit;
