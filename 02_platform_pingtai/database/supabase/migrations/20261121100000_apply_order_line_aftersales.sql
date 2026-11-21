begin;

alter table ordering.aftersale add column if not exists return_method text;

create or replace function ordering.apply_aftersale(
  p_order text,p_version bigint,p_kind text,p_reason text,p_lines text[],p_line text,
  p_quantity bigint,p_amount_minor bigint,p_return_method text
) returns setof ordering.aftersale language plpgsql security definer
set search_path=pg_catalog,pg_temp set row_security=off as $function$
begin
  perform 1 from ordering.orderrecord orders where orders.id=p_order
    and orders.member_id=nullif(current_setting('app.scope_id',true),'')
    and orders.version=p_version
    and (session_user<>'zhudatuanpurchaseapi' or access.purchase_member_mall_allowed(orders.member_id,orders.mall_id))
  for update;
  if not found then raise exception 'AFTERSALE_STATE_CONFLICT'; end if;

  if p_lines is not null then
    if cardinality(p_lines)=0 or (select count(*) from ordering.line line
      where line.order_id=p_order and line.id=any(p_lines))<>cardinality(p_lines) then
      raise exception 'VALIDATION_FAILED:lines';
    end if;
    if exists(select 1 from ordering.aftersale existing where existing.order_id=p_order
      and (existing.line_id is null or existing.line_id=any(p_lines))
      and existing.state in('requested','approved','processing','completed')) then
      raise exception 'AFTERSALE_STATE_CONFLICT';
    end if;
  end if;

  return query
  insert into ordering.aftersale(id,order_id,line_id,kind,state,quantity,amount_minor,reason,requested_by,
    requested_membership_id,supplier_leg_id,route_snapshot,return_method,created_at,updated_at,version)
  select 'aftersale:'||gen_random_uuid(),p_order,selected.id,p_kind,'requested',
    case when p_lines is null then p_quantity else line.quantity end,
    case when p_lines is null then p_amount_minor else line.payable_minor end,p_reason,
    nullif(current_setting('app.actor_id',true),''),nullif(current_setting('app.membership_id',true),''),
    line.supplier_leg_id,
    case when selected.id is null then jsonb_build_object('scope','order','routes',
      coalesce((select jsonb_agg(order_line.route_snapshot order by order_line.id)
        from ordering.line order_line where order_line.order_id=p_order),'[]'::jsonb))
    else line.route_snapshot||jsonb_build_object('orderLineId',line.id,'linePayableMinor',line.payable_minor) end,
    p_return_method,clock_timestamp(),clock_timestamp(),0
  from unnest(coalesce(p_lines,array[p_line])) selected(id)
  left join ordering.line line on line.order_id=p_order and line.id=selected.id
  returning *;

  update ordering.orderrecord set aftersale_state='requested',version=version+1,updated_at=clock_timestamp()
  where id=p_order;
end
$function$;

revoke all on function ordering.apply_aftersale(text,bigint,text,text,text[],text,bigint,bigint,text)
  from public,anon,authenticated,service_role;
grant execute on function ordering.apply_aftersale(text,bigint,text,text,text[],text,bigint,bigint,text)
  to shopapp,zhudatuanpurchaseapi;

commit;
