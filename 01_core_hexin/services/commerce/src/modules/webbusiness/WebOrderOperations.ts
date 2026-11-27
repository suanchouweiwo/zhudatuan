import type { ModuleContext } from '../../bootstrap/ModuleRegistry';
import { AUDIT_SINK } from '../../foundation/application/AuditSink';
import { ModuleOperations, requireAccess } from '../../foundation/application/ModuleOperations';
import { keysetResult, queryPage } from '../../foundation/interface/Validation';
import { DATABASE_POOL } from '../../foundation/persistence/Pool';
import { WEB_ORDER_OPERATION_IDS } from './WebBusinessOperationIds';

export function webOrderOperations(context: ModuleContext): ModuleOperations {
  const pool = context.container.get(DATABASE_POOL);
  return new ModuleOperations('order', pool, context.container.get(AUDIT_SINK), {
    'order.orders.read': async (request, database) => {
      const access = requireAccess(request);
      const owner = access.scope.kind === 'owner';
      const supplier = access.scope.kind === 'supplier';
      const store = access.scope.kind === 'store';
      const order = queryValue(request.input.query.order);
      const payment = queryEnum(request.input.query.payment, PAYMENT_STATES);
      const fulfillment = queryEnum(request.input.query.fulfillment, FULFILLMENT_STATES);
      const lifecycle = queryEnum(request.input.query.lifecycle, LIFECYCLE_STATES);
      const placed = queryEnum(request.input.query.placed, PLACED_WINDOWS);
      const view = queryEnum(request.input.query.view, ORDER_VIEWS);
      const mall = queryValue(request.input.query.mall);
      const page = queryPage(request);
      const detail = order !== '';
      const result = await database.query(`with selected_orders as materialized(
        select orders.* from ordering.orderrecord orders where (
          ($1::boolean and orders.member_id=$2) or ($3 and exists(select 1 from fulfillment.fulfillmentorder where order_id=orders.id and partner_id=$2))
          or ($4 and exists(select 1 from fulfillment.fulfillmentorder where order_id=orders.id and store_id=$2))
          or (not $1::boolean and not $3 and not $4 and exists(select 1 from organization.unitclosure closure where closure.ancestor_id=$2 and closure.descendant_id=orders.mall_id))
        ) and ($5='' or orders.id=$5 or orders.order_number=$5)
        and ($6::timestamptz is null or (orders.created_at,orders.id)<($6::timestamptz,$7))
        and ($8='' or orders.payment_state=$8) and ($9='' or orders.fulfillment_state=$9)
        and ($10='' or orders.lifecycle_state=$10) and ($11='' or orders.mall_id=$11)
        and ($12='' or ($12='today' and orders.created_at>=date_trunc('day',clock_timestamp()))
          or ($12='7days' and orders.created_at>=clock_timestamp()-interval '7 days')
          or ($12='30days' and orders.created_at>=clock_timestamp()-interval '30 days'))
        and ($13='' or ($13='unpaid' and orders.payment_state='unpaid')
          or ($13='unshipped' and orders.fulfillment_state in('unallocated','allocated','processing'))
          or ($13='active' and orders.lifecycle_state in('created','active'))
          or ($13='completed' and orders.lifecycle_state='completed')
          or ($13='aftersale' and orders.aftersale_state<>'none')
          or ($13='exception' and (orders.payment_state='failed' or orders.lifecycle_state='cancelled' or orders.aftersale_state='rejected')))
        order by orders.created_at desc,orders.id desc limit $14
      ) select orders.*,coalesce(lines.items,'[]'::jsonb) lines,lines.summary product_summary,
        coalesce(legs.items,'[]'::jsonb) economic_legs,coalesce(inventory.items,'[]'::jsonb) inventory_reservations,
        inventory.summary inventory_summary,
        coalesce(fulfillments.items,'[]'::jsonb) fulfillments,paymentfact.item payment_fact,
        coalesce(financefacts.items,'[]'::jsonb) finance_facts,coalesce(aftersales.items,'[]'::jsonb) aftersales,
        coalesce(operations.items,'[]'::jsonb) operations
        from selected_orders orders
        left join lateral(select coalesce(jsonb_agg((jsonb_build_object('id',line.id,'sku',line.sku_id,'listing',line.listing_id,'title',line.title_snapshot,
          'quantity',line.quantity,'unitMinor',line.unit_minor,'totalMinor',line.total_minor,'discountMinor',line.discount_minor,
          'payableMinor',line.payable_minor)
          || case when $1::boolean then jsonb_build_object('coverUrl',product.attributes->>'coverUrl') else '{}'::jsonb end
          || case when $15::boolean then jsonb_build_object(
          'provider',line.provider,'partner',line.partner_id,'product',line.product_id,
          'routeId',line.route_id,'routeVersion',line.route_version,'operatingNodeId',line.operating_node_id,
          'participantNodeId',line.participant_node_id,'participantMembershipId',line.participant_membership_id,
          'supplierId',line.supplier_id,'supplierRelationshipId',line.supplier_relationship_id,'contractId',line.contract_id,
          'contractHash',line.contract_hash,'fulfillmentPartyId',line.fulfillment_party_id,'settlementPartyId',line.settlement_party_id,
          'invoicePartyId',line.invoice_party_id,'routeSnapshot',line.route_snapshot) else '{}'::jsonb end) order by line.id)
          filter(where $15::boolean or $1::boolean),'[]'::jsonb) items,
          case when count(*)=0 then null else jsonb_build_object(
            'title',(array_agg(line.title_snapshot order by line.id))[1],
            'sku',(array_agg(line.sku_id order by line.id))[1],
            'quantity',least(sum(line.quantity),2147483647)::integer,
            'lineCount',least(count(*),2147483647)::integer) end summary
          from ordering.line line
          left join catalog.sku sku on $1::boolean and line.product_id is null and sku.id=line.sku_id
          left join catalog.product product on $1::boolean and product.id=coalesce(line.product_id,sku.product_id)
          where line.order_id=orders.id) lines on true
        left join lateral(select jsonb_agg(jsonb_build_object('id',leg.id,'routeId',leg.route_id,'routeVersion',leg.route_version,
          'supplierId',leg.supplier_id,'supplierRelationshipId',leg.supplier_relationship_id,'contractId',leg.contract_id,
          'fulfillmentPartyId',leg.fulfillment_party_id,'settlementPartyId',leg.settlement_party_id,'invoicePartyId',leg.invoice_party_id,
          'amountMinor',leg.amount_minor,'state',leg.state) order by leg.id) items
          from ordering.suborder leg where $15::boolean and leg.order_id=orders.id) legs on true
        left join lateral(select coalesce(jsonb_agg(jsonb_build_object('id',reservation.id,'stockItem',reservation.stockitem_id,
          'quantity',reservation.quantity,'state',reservation.state,'expiresAt',reservation.expires_at) order by reservation.id)
          filter(where $15::boolean),'[]'::jsonb) items,
          case when count(*)=0 then null when bool_or(reservation.state='committed') then 'committed'
            when bool_or(reservation.state='active') then 'active'
            when bool_and(reservation.state in('released','expired','cancelled')) then 'released' else 'other' end summary
          from inventory.reservation reservation where reservation.owner_type='order' and reservation.owner_id=orders.id) inventory on true
        left join lateral(select jsonb_agg(jsonb_build_object('id',fulfillment.id,'suborderId',fulfillment.suborder_id,
          'provider',fulfillment.provider,'partnerId',fulfillment.partner_id,'storeId',fulfillment.store_id,'kind',fulfillment.kind,
          'state',fulfillment.state,'externalReference',fulfillment.external_reference,'paymentId',fulfillment.payment_id,
          'amountMinor',fulfillment.amount_minor,'createdAt',fulfillment.created_at,'updatedAt',fulfillment.updated_at,
          'lines',coalesce((select jsonb_agg(jsonb_build_object('lineId',line.order_line_id,'quantity',line.quantity) order by line.order_line_id)
            from fulfillment.line line where line.fulfillment_id=fulfillment.id),'[]'::jsonb),
          'milestones',coalesce((select jsonb_agg(jsonb_build_object('id',milestone.id,'kind',milestone.kind,'state',milestone.state,
            'occurredAt',milestone.occurred_at) order by milestone.occurred_at,milestone.id)
            from fulfillment.milestone milestone where milestone.fulfillment_id=fulfillment.id),'[]'::jsonb)) order by fulfillment.id) items
          from fulfillment.fulfillmentorder fulfillment where $15::boolean and fulfillment.order_id=orders.id) fulfillments on true
        left join lateral(select jsonb_build_object('intentId',intent.id,'intentState',intent.state,'amountMinor',intent.amount_minor,
          'currency',intent.currency,'paymentId',payment.id,'paymentState',payment.state,'capturedMinor',payment.captured_minor,
          'refundedMinor',payment.refunded_minor,'allocations',coalesce((select jsonb_agg(jsonb_build_object('targetType',allocation.target_type,
            'targetId',allocation.target_id,'amountMinor',allocation.amount_minor,'currency',allocation.currency)
            order by allocation.target_type,allocation.target_id) from payment.allocation allocation where allocation.payment_id=payment.id),'[]'::jsonb),
          'refunds',coalesce((select jsonb_agg(jsonb_build_object('id',refund.id,'aftersaleId',refund.aftersale_id,'state',refund.state,
            'amountMinor',refund.amount_minor,'currency',refund.currency,'reason',refund.reason) order by refund.id)
            from payment.refund refund where refund.payment_id=payment.id),'[]'::jsonb)) item
          from payment.intent intent left join payment.payment payment on payment.intent_id=intent.id
          where $15::boolean and intent.order_id=orders.id order by intent.id limit 1) paymentfact on true
        left join lateral(select jsonb_agg(jsonb_build_object('id',journal.id,'referenceType',journal.reference_type,
          'referenceId',journal.reference_id,'state',journal.state,'currency',journal.currency,'postedAt',journal.posted_at,
          'entries',coalesce((select jsonb_agg(jsonb_build_object('accountId',entry.account_id,'side',entry.side,
            'amountMinor',entry.amount_minor) order by entry.id) from finance.entry entry where entry.journal_id=journal.id),'[]'::jsonb))
          order by journal.id) items from finance.journal journal where $15::boolean and (
          (journal.reference_type='order.placed' and journal.reference_id=orders.id)
          or journal.reference_id in(select payment.id from payment.payment payment join payment.intent intent on intent.id=payment.intent_id
            where intent.order_id=orders.id)
          or journal.reference_id in(select refund.id from payment.refund refund join payment.payment payment on payment.id=refund.payment_id
            join payment.intent intent on intent.id=payment.intent_id where intent.order_id=orders.id))) financefacts on true
        left join lateral(select jsonb_agg(jsonb_build_object('id',aftersale.id,'lineId',aftersale.line_id,'kind',aftersale.kind,
          'state',aftersale.state,'quantity',aftersale.quantity,'amountMinor',aftersale.amount_minor,'reason',aftersale.reason,
          'requestedAt',aftersale.created_at,'updatedAt',aftersale.updated_at,'routeSnapshot',aftersale.route_snapshot)
          order by aftersale.created_at desc,aftersale.id desc) items
          from ordering.aftersale aftersale where $15::boolean and aftersale.order_id=orders.id) aftersales on true
        left join lateral(select jsonb_agg(jsonb_build_object('id',operation.id,'kind',operation.kind,
          'actor_id',operation.actor_id,'actor_name',operation.actor_name,'membership_id',operation.membership_id,
          'occurred_at',operation.occurred_at,'result',operation.result) order by operation.occurred_at desc,operation.id desc) items
          from (select 'placed:'||orders.id id,'placed' kind,orders.member_id actor_id,
              null::text actor_name,
              orders.participant_membership_id membership_id,orders.created_at occurred_at,'created' result
            union all
            select milestone.id,'shipment',nullif(milestone.evidence->>'actor',''),
              null::text,null,
              milestone.occurred_at,milestone.state from fulfillment.fulfillmentorder fulfillment
              join fulfillment.milestone milestone on milestone.fulfillment_id=fulfillment.id
              where fulfillment.order_id=orders.id and milestone.kind='shipment'
            union all
            select aftersale.id,'aftersale_request',aftersale.requested_by,
              null::text,
              aftersale.requested_membership_id,aftersale.created_at,aftersale.state
              from ordering.aftersale aftersale where aftersale.order_id=orders.id
            union all
            select review.id,case when review.next_state='approved' then 'aftersale_approved' else 'aftersale_rejected' end,
              review.actor_id,null::text,
              review.membership_id,review.occurred_at,review.next_state from ordering.reviewaction review
              join ordering.aftersale aftersale on aftersale.id=review.aftersale_id
          where aftersale.order_id=orders.id and review.next_state in('approved','rejected')) operation
          where $15::boolean) operations on true
        order by orders.created_at desc,orders.id desc`,
      [owner, access.scope.id, supplier, store, order, page.sort, page.id, payment, fulfillment, lifecycle, mall, placed, view, page.fetch, detail]);
      return keysetResult(result, page, 'created_at');
    },
  }, WEB_ORDER_OPERATION_IDS);
}

const PAYMENT_STATES = ['unpaid', 'authorizing', 'paid', 'partially_refunded', 'refunded', 'failed'] as const;
const FULFILLMENT_STATES = ['unallocated', 'allocated', 'processing', 'shipped', 'delivered', 'cancelled', 'returned'] as const;
const LIFECYCLE_STATES = ['created', 'active', 'completed', 'cancelled', 'closed'] as const;
const PLACED_WINDOWS = ['today', '7days', '30days'] as const;
const ORDER_VIEWS = ['unpaid', 'unshipped', 'active', 'completed', 'aftersale', 'exception'] as const;

function queryValue(value: string | readonly string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim().slice(0, 255) ?? '';
}

function queryEnum<const T extends string>(value: string | readonly string[] | undefined, allowed: readonly T[]): T | '' {
  const normalized = queryValue(value);
  return allowed.includes(normalized as T) ? normalized as T : '';
}
