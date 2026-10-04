begin;

-- The public member adapter uses the same live-session projection as profile/address reads.
-- Candidates come from the shared TypeScript allocator; this function only persists them.
create or replace function access.web_member_identity_code(
  p_membership text,p_session text,p_segment text default null,p_suffix text default null
) returns table(storefront_node_id text,segment text,code text)
language plpgsql security definer
set search_path=access,organization,identity_display,pg_temp
set row_security=off as $function$
declare
  v_context text := nullif(current_setting('app.scope_id',true),'');
  v_node text;
  v_segment text;
  v_code text;
  v_stored_node text;
begin
  perform 1 from access.web_member_context(p_membership,p_session);
  select min(node.id) into v_node from organization.node node
    where node.mall_id=v_context and node.node_profile='operating_mall' and node.status='active'
    having count(*)=1;
  if v_node is null then return; end if;

  select stored.storefront_node_id,stored.segment into v_stored_node,v_segment
    from identity_display.member_store_segment stored where stored.context_id=v_context;
  if v_segment is null and p_segment is not null then
    insert into identity_display.member_store_segment(context_id,storefront_node_id,segment)
      values(v_context,v_node,p_segment) on conflict do nothing;
    select stored.storefront_node_id,stored.segment into v_stored_node,v_segment
      from identity_display.member_store_segment stored where stored.context_id=v_context;
  end if;
  if v_stored_node is not null and v_stored_node<>v_node then
    raise exception 'MB_CODE_STOREFRONT_CHANGED';
  end if;
  if exists(select 1 from identity_display.member_code_mapping mapping
    where mapping.membership_id=p_membership and mapping.context_id<>v_context) then
    raise exception 'MB_CODE_MAPPING_CONFLICT';
  end if;
  if v_segment is not null and p_suffix is not null then
    insert into identity_display.member_code_mapping(context_id,membership_id,suffix,code)
      values(v_context,p_membership,p_suffix,'MB-'||v_segment||p_suffix) on conflict do nothing;
  end if;
  select mapping.code into v_code from identity_display.member_code_mapping mapping
    where mapping.context_id=v_context and mapping.membership_id=p_membership;
  return query select v_node,v_segment,v_code;
end
$function$;

revoke all on function access.web_member_identity_code(text,text,text,text) from public;
grant execute on function access.web_member_identity_code(text,text,text,text) to zhudatuanwebapi;

insert into runtime.schemaversion(version,checksum)
values('20261004120000',encode(public.digest('web-member-identity-code:v1','sha256'),'hex'));
commit;
