begin;

-- Legacy assurance rows remain readable, while every newly issued financial
-- proof must use the Level 3 assurance created for the current session.
alter table identity.assurance add column session_id text references identity.session(id);
create index identity_assurance_session_verified on identity.assurance(session_id,verified_at desc)
  where session_id is not null;

create or replace function identity.resolve_session(p_token_hash text)
returns table(actor_id text,session_id text,membership_id text,credential_version bigint,access_version bigint,
  target text,assurance_level smallint,assurance_verified_at timestamptz)
language sql stable security definer
set search_path=identity,access,member,pg_temp as $function$
  select session.principal_id,session.id,session.membership_id,session.credential_version,session.access_version,
    case session.client when 'operator' then 'console' else session.client end,
    case when session.assurance_level>=3 and assurance.verified_at is null
      then least(session.assurance_level,2::smallint) else session.assurance_level end,
    case when session.assurance_level>=3 then assurance.verified_at else null end
  from identity.session session
  join identity.principal principal on principal.id=session.principal_id
  join member.profile profile on profile.principal_id=session.principal_id
  join access.membership membership on membership.id=session.membership_id and membership.member_id=profile.id
  left join lateral(
    select evidence.verified_at from identity.assurance evidence
    where evidence.principal_id=session.principal_id and evidence.session_id=session.id
      and evidence.level>=3
      and (evidence.expires_at is null or evidence.expires_at>clock_timestamp())
    order by evidence.level desc,evidence.verified_at desc limit 1
  ) assurance on true
  where session.token_hash=p_token_hash and session.revoked_at is null and session.expires_at>clock_timestamp()
    and session.credential_version=principal.credential_version and principal.status='active' and membership.status='active'
$function$;

-- Financial mutations consume a short-lived, single-use proof. Only a digest
-- is persisted; the bearer value is returned once by identity.stepup.complete.
create table access.actionproof(
  token_hash char(64) primary key check(token_hash~'^[0-9a-f]{64}$'),
  actor_id text not null references identity.principal(id),
  session_id text not null references identity.session(id),
  membership_id text not null references access.membership(id),
  assurance_id text not null references identity.assurance(id),
  scope_id text not null,
  operation text not null,
  resource_id text not null check(resource_id<>'' and length(resource_id)<=255),
  idempotency_key text not null check(idempotency_key<>'' and length(idempotency_key)<=255),
  expected_version bigint check(expected_version>=0),
  request_hash char(64) not null check(request_hash~'^[0-9a-f]{64}$'),
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  check(expires_at>issued_at and expires_at<=issued_at+interval '5 minutes'),
  check(consumed_at is null or consumed_at between issued_at and expires_at)
);
create index access_actionproof_pending on access.actionproof(expires_at,session_id)
  where consumed_at is null;
alter table access.actionproof enable row level security;

create or replace function runtime.reject_financial_outbox_fact_mutation()
returns trigger language plpgsql set search_path=runtime,pg_temp as $function$
declare financial_fact boolean;
begin
  financial_fact:=old.event_type like 'finance.%' or old.event_type like 'invoice.%'
    or old.event_type in('order.placed','order.cancelled','payment.succeeded','payment.refunded',
      'payment.late.detected','payment.late.refunded','payment.autorefund.requested');
  if tg_op='DELETE' then
    if financial_fact and (old.published_at is null
      or old.occurred_at>clock_timestamp()-interval '90 days')
    then raise exception 'FINANCIAL_EVENT_FACT_RETENTION_REQUIRED'; end if;
    return old;
  end if;
  financial_fact:=financial_fact or new.event_type like 'finance.%' or new.event_type like 'invoice.%'
    or new.event_type in('order.placed','order.cancelled','payment.succeeded','payment.refunded',
      'payment.late.detected','payment.late.refunded','payment.autorefund.requested');
  if financial_fact
    and (new.event_type,new.event_version,new.scope_id,new.payload,new.occurred_at,new.trace_id)
      is distinct from
      (old.event_type,old.event_version,old.scope_id,old.payload,old.occurred_at,old.trace_id)
  then raise exception 'FINANCIAL_EVENT_FACT_IMMUTABLE'; end if;
  return new;
end $function$;
create or replace function runtime.reject_financial_inbox_fact_mutation()
returns trigger language plpgsql set search_path=runtime,pg_temp as $function$
declare financial_fact boolean;
begin
  financial_fact:=old.event_type like 'finance.%' or old.event_type like 'invoice.%'
    or old.event_type in('order.placed','order.cancelled','payment.succeeded','payment.refunded',
      'payment.late.detected','payment.late.refunded','payment.autorefund.requested');
  if tg_op='DELETE' then
    if financial_fact and (old.processed_at is null
      or old.received_at>clock_timestamp()-interval '90 days')
    then raise exception 'FINANCIAL_EVENT_FACT_RETENTION_REQUIRED'; end if;
    return old;
  end if;
  financial_fact:=financial_fact or new.event_type like 'finance.%' or new.event_type like 'invoice.%'
    or new.event_type in('order.placed','order.cancelled','payment.succeeded','payment.refunded',
      'payment.late.detected','payment.late.refunded','payment.autorefund.requested');
  if financial_fact
    and (new.event_type,new.event_version,new.payload,new.trace_id)
      is distinct from (old.event_type,old.event_version,old.payload,old.trace_id)
  then raise exception 'FINANCIAL_EVENT_FACT_IMMUTABLE'; end if;
  return new;
end $function$;
create trigger runtime_financial_outbox_fact_immutable before update or delete on runtime.outbox
for each row execute function runtime.reject_financial_outbox_fact_mutation();
create trigger runtime_financial_inbox_fact_immutable before update or delete on runtime.inbox
for each row execute function runtime.reject_financial_inbox_fact_mutation();

create or replace function finance.resource_scope(p_resource text)
returns text language plpgsql stable security definer
set search_path=finance,invoice,pg_temp as $function$
declare resolved text;
begin
  select scope_id into resolved from finance.reconciliation where id=p_resource;
  if resolved is null then select scope_id into resolved from finance.settlement where id=p_resource; end if;
  if resolved is null then select scope_id into resolved from finance.settlementadjustment where id=p_resource; end if;
  if resolved is null then select scope_id into resolved from finance.withdrawal where id=p_resource; end if;
  if resolved is null then select scope_id into resolved from finance.hold where id=p_resource; end if;
  if resolved is null then select scope_id into resolved from finance.periodclose where id=p_resource; end if;
  if resolved is null then select scope_id into resolved from finance.backfill where id=p_resource; end if;
  if resolved is null then select scope_id into resolved from finance.policy where id=p_resource; end if;
  if resolved is null then select scope_id into resolved from finance.statement where id=p_resource; end if;
  if resolved is null then select scope_id into resolved from finance.account where id=p_resource; end if;
  if resolved is null then select owner_id into resolved from invoice.profile where id=p_resource; end if;
  if resolved is null then select profile.owner_id into resolved from invoice.request request
    join invoice.profile profile on profile.id=request.profile_id where request.id=p_resource; end if;
  return resolved;
end $function$;

-- Keep member-only reads owner-scoped, while finance and invoice operator
-- commands resolve through the actual resource or the membership organization.
create or replace function access.resource_scope(p_operation text,p_resource text,p_membership_id text)
returns text language plpgsql stable security definer
set search_path=access,capability,member,organization,partner,catalog,pricing,inventory,experience,cart,checkout,ordering,fulfillment,verification,payment,voucher,benefit,finance,invoice,channel,support,notification,reporting,risk,audit,extension,pg_temp as $function$
declare resolved text;
begin
  if p_operation='organization.stores.manage' then
    select coalesce((select id from partner.partner where id=p_resource and kind='store'),
      (select organization_id from access.membership where id=p_membership_id)) into resolved;
  elsif p_operation='identity.invitations.create' then
    select organization_id into resolved from access.membership where id=p_membership_id;
  elsif p_operation='identity.invitations.revoke' then
    select organization_id into resolved from member.invite where id=p_resource;
  elsif p_operation like 'identity.%' then
    select 'self:'||profile.principal_id into resolved from access.membership membership
      join member.profile profile on profile.id=membership.member_id where membership.id=p_membership_id;
  elsif p_operation='finance.periods.manage' then
    select organization_id into resolved from access.membership where id=p_membership_id;
  elsif exists(select 1 from capability.operation where operation_id=p_operation and audience='member')
      or p_operation like 'cart.%' or p_operation like 'checkout.%' or p_operation in(
      'order.orders.create','order.aftersales.apply','payment.intents.create','benefit.accounts.read',
      'notification.notifications.read','notification.preferences.manage','notification.endpoints.manage') then
    select profile.id into resolved from access.membership membership join member.profile profile on profile.id=membership.member_id
      where membership.id=p_membership_id;
  elsif p_operation in('order.orders.read','order.aftersales.read','support.cases.read','support.messages.read')
      and exists(select 1 from access.membership where id=p_membership_id and client='storefront') then
    select profile.id into resolved from access.membership membership join member.profile profile on profile.id=membership.member_id
      where membership.id=p_membership_id;
  elsif p_resource is null then
    select organization_id into resolved from access.membership where id=p_membership_id;
  else
    select id into resolved from organization.organization where id=p_resource;
    if resolved is null then select id into resolved from partner.partner where id=p_resource; end if;
    if resolved is null then select id into resolved from member.profile where id=p_resource; end if;
    if resolved is null then select scope_id into resolved from catalog.pool where id=p_resource; end if;
    if resolved is null then select scope_id into resolved from catalog.sourcelisting where id=p_resource; end if;
    if resolved is null then select scope_id into resolved from catalog.listing where id=p_resource; end if;
    if resolved is null then select scope_id into resolved from catalog.importjob where id=p_resource; end if;
    if resolved is null then select scope_id into resolved from pricing.pricebook where id=p_resource; end if;
    if resolved is null then select scope_id into resolved from pricing.rule where id=p_resource; end if;
    if resolved is null then select mall_id into resolved from pricing.quote where id=p_resource; end if;
    if resolved is null then select scope_id into resolved from inventory.stockitem where id=p_resource; end if;
    if resolved is null then select scope_id into resolved from experience.application where id=p_resource; end if;
    if resolved is null then select application.scope_id into resolved from experience.version versionrecord
      join experience.application application on application.id=versionrecord.application_id where versionrecord.id=p_resource; end if;
    if resolved is null then select mall_id into resolved from cart.cart where id=p_resource; end if;
    if resolved is null then select mall_id into resolved from checkout.session where id=p_resource; end if;
    if resolved is null then select scope_id into resolved from ordering.orderrecord where id=p_resource; end if;
    if resolved is null then select orders.mall_id into resolved from fulfillment.fulfillmentorder fulfillment
      join ordering.orderrecord orders on orders.id=fulfillment.order_id where fulfillment.id=p_resource; end if;
    if resolved is null then select orders.mall_id into resolved from fulfillment.returnrecord returned
      join fulfillment.fulfillmentorder fulfillment on fulfillment.id=returned.fulfillment_id
      join ordering.orderrecord orders on orders.id=fulfillment.order_id where returned.id=p_resource; end if;
    if resolved is null then select scope_id into resolved from verification.session where id=p_resource; end if;
    if resolved is null then select scope_id into resolved from verification.device where id=p_resource; end if;
    if resolved is null then select scope_id into resolved from payment.recoverycase where id=p_resource; end if;
    if resolved is null then select scope_id into resolved from voucher.program where id=p_resource; end if;
    if resolved is null then select scope_id into resolved from voucher.cardpool where id=p_resource; end if;
    if resolved is null then select scope_id into resolved from voucher.reserverequest where id=p_resource; end if;
    if resolved is null then select program.scope_id into resolved from voucher.issuebatch batch
      join voucher.program program on program.id=batch.program_id where batch.id=p_resource; end if;
    if resolved is null then select program.scope_id into resolved from voucher.voucher voucher
      join voucher.program program on program.id=voucher.program_id where voucher.id=p_resource; end if;
    if resolved is null then select program.scope_id into resolved from voucher.redemption redemption
      join voucher.voucher voucher on voucher.id=redemption.voucher_id
      join voucher.program program on program.id=voucher.program_id where redemption.id=p_resource; end if;
    if resolved is null then select scope_id into resolved from benefit.plan where id=p_resource; end if;
    if resolved is null then select plan.scope_id into resolved from benefit.budget budget
      join benefit.plan plan on plan.id=budget.plan_id where budget.id=p_resource; end if;
    if resolved is null then select plan.scope_id into resolved from benefit.grantbatch batch
      join benefit.plan plan on plan.id=batch.plan_id where batch.id=p_resource; end if;
    if resolved is null then select finance.resource_scope(p_resource) into resolved; end if;
    if resolved is null then select scope_id into resolved from channel.connection where id=p_resource; end if;
    if resolved is null then select support.resource_scope(p_resource) into resolved; end if;
    if resolved is null then select notification.resource_scope(p_resource) into resolved; end if;
    if resolved is null then select reporting.resource_scope(p_resource) into resolved; end if;
    if resolved is null then select risk.resource_scope(p_resource) into resolved; end if;
    if resolved is null then select scope_id into resolved from extension.installation where id=p_resource; end if;
    if resolved is null and p_operation in('access.roles.manage','access.scopes.manage','capability.assignments.manage',
      'partner.partners.manage','qualification.policies.manage','experience.applications.update','notification.templates.manage',
      'notification.announcements.manage','reporting.exports.create','risk.policies.manage','verification.devices.manage',
      'voucher.programs.manage','benefit.plans.manage','benefit.budgets.manage','finance.policies.manage','invoice.profiles.manage')
      then select organization_id into resolved from access.membership where id=p_membership_id; end if;
  end if;
  if resolved is null then raise exception 'RESOURCE_SCOPE_NOT_FOUND'; end if;
  return resolved;
end $function$;

create or replace function access.issue_action_proof(
  p_token_hash text,p_actor text,p_session text,p_membership text,p_assurance text,
  p_operation text,p_resource text,p_idempotency text,p_expected_version bigint,p_request_hash text
) returns table(scope_id text,resource_id text,expires_at timestamptz)
language plpgsql volatile security definer
set search_path=access,identity,capability,pg_temp as $function$
declare
  target_scope text;
  bound_resource text;
  assuranceid text;
  expiry timestamptz;
begin
  if p_token_hash is null or p_token_hash!~'^[0-9a-f]{64}$' or p_actor is null or p_actor=''
    or p_session is null or p_session='' or p_membership is null or p_membership=''
    or p_assurance is null or p_assurance=''
    or p_idempotency is null or p_idempotency='' or length(p_idempotency)>255
    or p_request_hash is null or p_request_hash!~'^[0-9a-f]{64}$'
    or (p_resource is not null and (p_resource='' or length(p_resource)>255))
  then raise exception 'ACTION_PROOF_REQUIRED'; end if;
  if p_operation not in(
    'finance.statements.export','finance.reconciliations.manage','finance.settlements.decide',
    'finance.settlements.adjust','finance.withdrawals.create','finance.withdrawals.decide',
    'finance.withdrawals.recover','finance.periods.manage','finance.backfills.decide',
    'finance.policies.manage','invoice.requests.decide','invoice.requests.red'
  ) then raise exception 'ACTION_PROOF_REQUIRED'; end if;
  if p_operation<>'finance.statements.export' and p_expected_version is null
  then raise exception 'EXPECTED_VERSION_REQUIRED'; end if;
  if p_expected_version is not null and p_expected_version<0
  then raise exception 'EXPECTED_VERSION_INVALID'; end if;

  select assurance.id,least(clock_timestamp()+interval '5 minutes',coalesce(assurance.expires_at,clock_timestamp()+interval '5 minutes'))
    into assuranceid,expiry
  from identity.session session
  join identity.principal principal on principal.id=session.principal_id
  join access.membership membership on membership.id=session.membership_id
  join identity.assurance assurance
    on assurance.id=p_assurance and assurance.principal_id=session.principal_id and assurance.session_id=session.id
  where session.id=p_session and session.principal_id=p_actor and session.membership_id=p_membership
    and session.revoked_at is null and session.expires_at>clock_timestamp() and session.assurance_level>=3
    and principal.status='active' and session.credential_version=principal.credential_version
    and membership.status='active' and session.access_version=membership.access_version
    and assurance.level=3 and assurance.verified_at>=clock_timestamp()-interval '5 minutes'
    and (assurance.expires_at is null or assurance.expires_at>clock_timestamp())
  limit 1;
  if assuranceid is null then raise exception 'STEPUP_REQUIRED'; end if;
  if not exists(select 1 from capability.membership_operations(p_membership) granted
    join capability.operation operation on operation.operation_id=granted.operation_id
    join capability.capability capability on capability.id=operation.capability_id and capability.status='active'
    left join access.permission permission on permission.code=operation.permission_code
    where granted.operation_id=p_operation
      and (operation.permission_code is null or permission.status='active'))
  then raise exception 'PERMISSION_DENIED'; end if;

  target_scope:=access.resource_scope(p_operation,p_resource,p_membership);
  bound_resource:=coalesce(p_resource,target_scope);
  insert into access.actionproof(token_hash,actor_id,session_id,membership_id,assurance_id,scope_id,operation,
    resource_id,idempotency_key,expected_version,request_hash,issued_at,expires_at)
  values(p_token_hash,p_actor,p_session,p_membership,assuranceid,target_scope,p_operation,bound_resource,
    p_idempotency,p_expected_version,p_request_hash,clock_timestamp(),expiry);
  return query select target_scope,bound_resource,expiry;
end $function$;

create or replace function access.consume_action_proof(
  p_token_hash text,p_actor text,p_session text,p_membership text,p_scope text,p_operation text,
  p_resource text,p_idempotency text,p_expected_version bigint,p_request_hash text
) returns boolean language plpgsql volatile security definer
set search_path=access,identity,capability,pg_temp as $function$
declare consumed boolean:=false;
begin
  update access.actionproof proof set consumed_at=clock_timestamp()
  where proof.token_hash=p_token_hash and proof.actor_id=p_actor and proof.session_id=p_session
    and proof.membership_id=p_membership and proof.scope_id=p_scope and proof.operation=p_operation
    and proof.resource_id=p_resource and proof.idempotency_key=p_idempotency
    and proof.expected_version is not distinct from p_expected_version
    and proof.request_hash=p_request_hash
    and proof.consumed_at is null and proof.expires_at>clock_timestamp()
    and exists(select 1 from identity.session session
      join identity.principal principal on principal.id=session.principal_id
      join access.membership membership on membership.id=session.membership_id
      where session.id=p_session and session.principal_id=p_actor and session.membership_id=p_membership
      and session.revoked_at is null and session.expires_at>clock_timestamp() and session.assurance_level>=3
      and principal.status='active' and session.credential_version=principal.credential_version
      and membership.status='active' and session.access_version=membership.access_version
      and exists(select 1 from capability.membership_operations(p_membership) granted
        join capability.operation operation on operation.operation_id=granted.operation_id
        join capability.capability capability on capability.id=operation.capability_id and capability.status='active'
        left join access.permission permission on permission.code=operation.permission_code
        where granted.operation_id=p_operation
          and (operation.permission_code is null or permission.status='active')))
    and exists(select 1 from identity.assurance assurance where assurance.id=proof.assurance_id
      and assurance.principal_id=p_actor and assurance.session_id=p_session and assurance.level=3
      and (assurance.expires_at is null or assurance.expires_at>clock_timestamp()));
  consumed:=found;
  return consumed;
end $function$;

-- Recheck and lock the resource inside the command transaction. This closes
-- the authorization-to-execution race without putting finance table knowledge
-- into the shared HTTP controller.
create or replace function finance.assert_expected_version(
  p_operation text,p_resource text,p_scope text,p_expected_version bigint
) returns boolean language plpgsql volatile security definer
set search_path=finance,invoice,pg_temp as $function$
declare valid boolean:=false;
begin
  if p_expected_version is null then raise exception 'EXPECTED_VERSION_REQUIRED'; end if;
  if p_expected_version<0 then raise exception 'EXPECTED_VERSION_INVALID'; end if;

  if p_operation='finance.reconciliations.manage' then
    select true into valid from finance.reconciliation where id=p_resource and scope_id=p_scope
      and version=p_expected_version for update;
  elsif p_operation in('finance.settlements.decide','finance.settlements.adjust',
      'finance.withdrawals.create','invoice.requests.create') then
    select true into valid from finance.settlement where id=p_resource and scope_id=p_scope
      and version=p_expected_version for update;
  elsif p_operation in('finance.withdrawals.decide','finance.withdrawals.recover') then
    select true into valid from finance.withdrawal where id=p_resource and scope_id=p_scope
      and version=p_expected_version for update;
  elsif p_operation='finance.periods.manage' then
    select true into valid from finance.periodclose where scope_id=p_scope and period=p_resource
      and version=p_expected_version for update;
    if valid is not true and p_expected_version=0 and exists(select 1 from finance.period where scope_id=p_scope and period=p_resource)
      and not exists(select 1 from finance.periodclose where scope_id=p_scope and period=p_resource)
    then valid:=true; end if;
  elsif p_operation='finance.backfills.decide' then
    select true into valid from finance.backfill where id=p_resource and scope_id=p_scope
      and version=p_expected_version for update;
  elsif p_operation='finance.policies.manage' then
    select true into valid from finance.policy where id=p_resource and scope_id=p_scope
      and version=p_expected_version for update;
    if valid is not true and p_expected_version=0 and not exists(select 1 from finance.policy where id=p_resource)
    then valid:=true; end if;
  elsif p_operation='invoice.profiles.manage' then
    select true into valid from invoice.profile where id=p_resource and owner_id=p_scope
      and version=p_expected_version for update;
    if valid is not true and p_expected_version=0 and not exists(select 1 from invoice.profile where id=p_resource)
    then valid:=true; end if;
  elsif p_operation in('invoice.requests.cancel','invoice.requests.decide','invoice.requests.red') then
    select true into valid from invoice.request request join invoice.profile profile on profile.id=request.profile_id
      where request.id=p_resource and profile.owner_id=p_scope and request.version=p_expected_version for update of request;
  else
    raise exception 'EXPECTED_VERSION_INVALID';
  end if;
  if valid is not true then raise exception 'VERSION_CONFLICT'; end if;
  return true;
end $function$;

revoke all on table access.actionproof from public,anon,authenticated,service_role,shopapp,shopjob;
revoke all on function finance.resource_scope(text),access.resource_scope(text,text,text),
  finance.assert_expected_version(text,text,text,bigint),
  access.issue_action_proof(text,text,text,text,text,text,text,text,bigint,text),
  access.consume_action_proof(text,text,text,text,text,text,text,text,bigint,text)
  from public,anon,authenticated,service_role,shopapp,shopjob;
grant execute on function finance.resource_scope(text) to shopapp,shopjob;
grant execute on function access.resource_scope(text,text,text),
  finance.assert_expected_version(text,text,text,bigint),
  access.issue_action_proof(text,text,text,text,text,text,text,text,bigint,text),
  access.consume_action_proof(text,text,text,text,text,text,text,text,bigint,text) to shopapp;

-- The API can read core ledger facts but must write through the audited
-- security-definer finance functions. Period finalization retains only the
-- narrow columns used by the controlled close workflow.
drop policy if exists appscope on finance.account;
drop policy if exists appscope on finance.journal;
drop policy if exists appscope on finance.entry;
create policy appread on finance.account for select to shopapp using(access.scope_allowed(scope_id));
create policy appread on finance.journal for select to shopapp using(exists(
  select 1 from finance.entry entry join finance.account account on account.id=entry.account_id
  where entry.journal_id=journal.id and access.scope_allowed(account.scope_id)));
create policy appread on finance.entry for select to shopapp using(exists(
  select 1 from finance.account account where account.id=entry.account_id and access.scope_allowed(account.scope_id)));
revoke insert,update,delete on finance.account,finance.journal,finance.entry from shopapp,shopjob;
revoke insert,update,delete on finance.statement,finance.period from shopapp,shopjob;
grant update(state,generated_at) on finance.statement to shopapp;
grant update(state,closed_at,closed_by) on finance.period to shopapp;
revoke delete on all tables in schema finance from shopapp,shopjob;

-- Base invoice tables predate scope_id. Replace the generic workload policy
-- with owner-derived policies and remove every direct delete path.
drop policy if exists appscope on invoice.profile;
drop policy if exists appscope on invoice.request;
drop policy if exists appscope on invoice.document;
drop policy if exists appscope on invoice.line;
drop policy if exists appscope on invoice.statusevent;
create policy appscope on invoice.profile for all to shopapp
  using(access.scope_allowed(owner_id)) with check(access.scope_allowed(owner_id));
create policy appscope on invoice.request for all to shopapp using(exists(
  select 1 from invoice.requestprofile profile
  where profile.request_id=invoice.request.id and access.scope_allowed(profile.owner_id)))
  with check(exists(select 1 from invoice.requestprofile profile
    where profile.request_id=invoice.request.id and access.scope_allowed(profile.owner_id)));
create policy appread on invoice.document for select to shopapp using(exists(
  select 1 from invoice.requestprofile profile
  where profile.request_id=invoice.document.request_id and access.scope_allowed(profile.owner_id)));
create policy appscope on invoice.line for all to shopapp using(exists(
  select 1 from invoice.requestprofile profile
  where profile.request_id=invoice.line.request_id and access.scope_allowed(profile.owner_id)))
  with check(exists(select 1 from invoice.requestprofile profile
    where profile.request_id=invoice.line.request_id and access.scope_allowed(profile.owner_id)));
create policy appscope on invoice.statusevent for all to shopapp using(exists(
  select 1 from invoice.requestprofile profile
  where profile.request_id=invoice.statusevent.request_id and access.scope_allowed(profile.owner_id)))
  with check(exists(select 1 from invoice.requestprofile profile
    where profile.request_id=invoice.statusevent.request_id and access.scope_allowed(profile.owner_id)));
revoke delete on all tables in schema invoice from shopapp,shopjob;

alter table finance.backfill add column version bigint not null default 0 check(version>=0);

-- Publish authoritative read contracts for the remaining Finance Console
-- tabs. The audit read reuses the existing high-risk audit.read permission;
-- policy reads receive a distinct non-mutating permission.
insert into runtime.operation(id,owner,method,path,contract_version) values
  ('finance.policies.read','finance','GET','/api/v1/finance/policies','1.0.0'),
  ('finance.audit.read','finance','GET','/api/v1/finance/audits','1.0.0'),
  ('invoice.operatorprofiles.read','finance','GET','/api/v1/invoices/operator-profiles','1.0.0');
insert into access.permission(id,code,risk,status) values
  ('permission:566c6f084f4cb25060200f9a','finance.policy.read','elevated','active');
insert into capability.capability(id,kind,name,version,status) values
  ('finance.policies.read','operation','finance.policies.read',1,'active'),
  ('finance.audit.read','operation','finance.audit.read',1,'active'),
  ('invoice.operatorprofiles.read','operation','invoice.operatorprofiles.read',1,'active');
insert into capability.operation(operation_id,capability_id,permission_code,audience) values
  ('finance.policies.read','finance.policies.read','finance.policy.read','operator'),
  ('finance.audit.read','finance.audit.read','audit.read','operator'),
  ('invoice.operatorprofiles.read','invoice.operatorprofiles.read','invoice.profile.read','operator');
insert into capability.entitlement(id,scope_id,capability_id,state,quota,effective_at,expires_at,version) values
  ('platform:finance.policies.read','organization-platform-root','finance.policies.read','enabled',null,'1970-01-01T00:00:00Z',null,0),
  ('platform:finance.audit.read','organization-platform-root','finance.audit.read','enabled',null,'1970-01-01T00:00:00Z',null,0),
  ('platform:invoice.operatorprofiles.read','organization-platform-root','invoice.operatorprofiles.read','enabled',null,
    '1970-01-01T00:00:00Z',null,0);

-- Reads follow an existing write grant, while the canonical platform owner
-- receives the two explicit Console reads without gaining a new mutation.
insert into access.rolepermission(role_id,permission_id,effect)
select distinct source.role_id,target.id,'allow'
from access.rolepermission source
join access.permission existing on existing.id=source.permission_id
join access.permission target on target.code=case existing.code
  when 'finance.policy.manage' then 'finance.policy.read'
  when 'invoice.profile.manage' then 'invoice.profile.read' end
where source.effect='allow' and existing.code in('finance.policy.manage','invoice.profile.manage')
on conflict do nothing;
insert into access.rolepermission(role_id,permission_id,effect)
select 'role-platform-owner-v2',permission.id,'allow' from access.permission permission
where permission.code in('finance.policy.read','invoice.profile.read')
on conflict do nothing;

insert into runtime.schemaversion(version,checksum)
values('20260828092000','f4246926b8e96ee76a2b8fc4b1d7bf3c13a7b9c63a5046d492ad9e927a1f7554');

commit;
