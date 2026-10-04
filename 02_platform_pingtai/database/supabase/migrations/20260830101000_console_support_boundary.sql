begin;

do $role$
begin
  if not exists(select 1 from pg_roles where rolname='shopconsole') then
    create role shopconsole nologin noinherit nosuperuser nocreatedb nocreaterole nobypassrls;
  end if;
  if not exists(select 1 from pg_roles where rolname='zhudatuanconsoleapi') then
    create role zhudatuanconsoleapi login noinherit nosuperuser nocreatedb nocreaterole nobypassrls;
    grant shopconsole to zhudatuanconsoleapi;
  end if;
end
$role$;

revoke all on schema identity,access,capability,organization,member,support,runtime,audit,risk from shopconsole;
revoke all privileges on all tables in schema identity,access,capability,organization,member,support,runtime,audit,risk from shopconsole;
revoke execute on all functions in schema identity,access,capability,organization,member,support,runtime,audit,risk from shopconsole;

grant usage on schema identity,access,capability,organization,member,support,runtime,audit,risk to shopconsole;
grant execute on function
  identity.resolve_session(text),
  access.resolve_membership(text),
  access.membership_version(text),
  access.resolve_scope(text,text,text),
  access.resource_scope(text,text,text),
  access.scope_object(text),
  access.scope_allowed(text),
  capability.membership_operations(text),
  audit.scope_allowed(text),
  risk.scope_allowed(text)
to shopconsole;

grant select on access.membership,organization.unitclosure to shopconsole;
grant insert on access.decisionaudit to shopconsole;

grant select on support.ticket,support.conversation,support.message,support.evidence to shopconsole;
grant insert on support.message,support.history to shopconsole;
grant update on support.ticket,support.conversation to shopconsole;

grant select,insert,update on runtime.idempotency to shopconsole;
grant insert on runtime.outbox to shopconsole;
grant select on runtime.operation,runtime.schemaversion to shopconsole;

grant select on risk.policy,risk.policyversion,risk.signal,risk.decision,risk.listentry to shopconsole;
grant insert on risk.decision,risk.case to shopconsole;

grant select on audit.record,audit.recorddefault,audit.accessrecord,audit.archiveref to shopconsole;
grant insert on audit.record,audit.recorddefault,audit.accessrecord to shopconsole;

create policy consoleself on access.membership for select to shopconsole
using(id=nullif(current_setting('app.membership_id',true),''));
create policy consoledecision on access.decisionaudit for insert to shopconsole
with check(scope_id is null or access.scope_allowed(scope_id));
create policy consoleclosure on organization.unitclosure for select to shopconsole using(true);

create policy consolesupportticketselect on support.ticket for select to shopconsole using(access.scope_allowed(scope_id));
create policy consolesupportticketupdate on support.ticket for update to shopconsole
using(access.scope_allowed(scope_id)) with check(access.scope_allowed(scope_id));
create policy consolesupportconversationselect on support.conversation for select to shopconsole using(access.scope_allowed(scope_id));
create policy consolesupportconversationupdate on support.conversation for update to shopconsole
using(access.scope_allowed(scope_id)) with check(access.scope_allowed(scope_id));
create policy consolesupportmessageselect on support.message for select to shopconsole using(access.scope_allowed(scope_id));
create policy consolesupportmessageinsert on support.message for insert to shopconsole with check(access.scope_allowed(scope_id));
create policy consolesupporthistoryinsert on support.history for insert to shopconsole with check(access.scope_allowed(scope_id));
create policy consolesupportevidenceselect on support.evidence for select to shopconsole using(access.scope_allowed(scope_id));

create policy consoleidempotency on runtime.idempotency for all to shopconsole
using(access.scope_allowed(scope)) with check(access.scope_allowed(scope));
create policy consoleoutboxinsert on runtime.outbox for insert to shopconsole with check(access.scope_allowed(scope_id));
create policy consoleoperationselect on runtime.operation for select to shopconsole using(true);
create policy consoleschemaversionselect on runtime.schemaversion for select to shopconsole using(true);

create policy consoleriskpolicyselect on risk.policy for select to shopconsole using(risk.scope_allowed(scope_id));
create policy consoleriskversionselect on risk.policyversion for select to shopconsole
using(exists(select 1 from risk.policy policy where policy.id=policy_id and risk.scope_allowed(policy.scope_id)));
create policy consolerisksignalselect on risk.signal for select to shopconsole using(risk.scope_allowed(scope_id));
create policy consoleriskdecisionselect on risk.decision for select to shopconsole using(risk.scope_allowed(scope_id));
create policy consoleriskdecisioninsert on risk.decision for insert to shopconsole with check(risk.scope_allowed(scope_id));
create policy consoleriskcasinsert on risk.case for insert to shopconsole with check(risk.scope_allowed(scope_id));
create policy consolerisklistselect on risk.listentry for select to shopconsole using(risk.scope_allowed(scope_id));

create policy consoleauditrecordselect on audit.record for select to shopconsole using(audit.scope_allowed(scope_id));
create policy consoleauditrecordinsert on audit.record for insert to shopconsole with check(audit.scope_allowed(scope_id));
create policy consoleauditdefaultselect on audit.recorddefault for select to shopconsole using(audit.scope_allowed(scope_id));
create policy consoleauditdefaultinsert on audit.recorddefault for insert to shopconsole with check(audit.scope_allowed(scope_id));
create policy consoleauditaccessselect on audit.accessrecord for select to shopconsole using(audit.scope_allowed(scope_id));
create policy consoleauditaccessinsert on audit.accessrecord for insert to shopconsole with check(audit.scope_allowed(scope_id));
create policy consoleauditarchiveselect on audit.archiveref for select to shopconsole using(audit.scope_allowed(scope_id));

delete from access.rolepermission mapping
using access.permission permission
where mapping.role_id='role-platform-owner-v2'
  and mapping.permission_id=permission.id
  and permission.code in('support.message.read','support.message.send')
  and mapping.effect='deny';

insert into access.rolepermission(role_id,permission_id,effect)
select 'role-platform-owner-v2',permission.id,'allow'
from access.permission permission
where permission.code in('support.case.read','support.message.read','support.message.send') and permission.status='active'
  and not exists(
    select 1 from access.rolepermission mapping
    where mapping.role_id='role-platform-owner-v2' and mapping.permission_id=permission.id and mapping.effect='allow'
  );

insert into runtime.schemaversion(version,checksum)
values('20260830101000','351696672f660832ef75fe9dd2b11d6dd918b55a738903e261cbe32b0b8fc28d');

commit;
