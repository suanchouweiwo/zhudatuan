begin;
grant usage on schema identity_display to zhudatuanidentityapi;
grant select,insert on identity_display.code_mapping to zhudatuanidentityapi;
commit;
