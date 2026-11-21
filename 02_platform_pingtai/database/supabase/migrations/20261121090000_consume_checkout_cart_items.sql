begin;

-- Consume only the confirmed order's lines while keeping the purchase role's
-- existing direct privileges on the cart tables.
create or replace function cart.consume_checkout_items(p_order text)
returns boolean language plpgsql security definer
set search_path=pg_catalog,pg_temp
set row_security=off as $function$
declare
  selected_cart_id text;
  purchased_listings text[];
  cart_state text;
  removed_count integer;
begin
  select active_cart.id into selected_cart_id
  from ordering.orderrecord placed
  join checkout.session checkout on checkout.id=placed.checkout_id
    and checkout.member_id=placed.member_id and checkout.mall_id=placed.mall_id
  join pricing.quote quote on quote.id=checkout.quote_id
  join cart.cart active_cart on active_cart.id=checkout.cart_id
    and active_cart.member_id=checkout.member_id and active_cart.mall_id=checkout.mall_id
    and active_cart.application_id=checkout.application_id
  where placed.id=p_order and checkout.state='confirmed' and active_cart.state='active'
    and placed.participant_membership_id=nullif(current_setting('app.membership_id',true),'')
    and (session_user<>'zhudatuanpurchaseapi' or access.purchase_member_mall_allowed(placed.member_id,placed.mall_id))
    and jsonb_typeof(checkout.input->'items')='array'
    and active_cart.version::text=(quote.signed_payload#>>'{cart,version}')
  for update of active_cart;
  if not found then return false; end if;

  select array_agg(line.listing_id) into purchased_listings
  from ordering.line line where line.order_id=p_order;
  if purchased_listings is null then return false; end if;

  update cart.cart active_cart
  set state=case when exists(select 1 from cart.item item where item.cart_id=selected_cart_id
    and not (item.listing_id=any(purchased_listings))) then 'active' else 'converted' end,
    version=active_cart.version+1,updated_at=clock_timestamp()
  where active_cart.id=selected_cart_id returning active_cart.state into cart_state;

  if cart_state='active' then
    delete from cart.item item using ordering.line line
    where item.cart_id=selected_cart_id and line.order_id=p_order
      and item.listing_id=line.listing_id and item.quantity=line.quantity;
    get diagnostics removed_count = row_count;
    if removed_count<>cardinality(purchased_listings) then raise exception 'CART_CONVERSION_CONFLICT'; end if;
  end if;
  return true;
end
$function$;

revoke all on function cart.consume_checkout_items(text) from public,anon,authenticated,service_role;
grant execute on function cart.consume_checkout_items(text) to shopapp,zhudatuanpurchaseapi;

commit;
