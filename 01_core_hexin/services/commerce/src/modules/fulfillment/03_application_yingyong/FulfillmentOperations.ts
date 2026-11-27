import { randomUUID } from 'node:crypto';
import type { ModuleContext } from '../../../bootstrap/ModuleRegistry';
import { AUDIT_SINK } from '../../../foundation/application/AuditSink';
import { ModuleOperations, reject, requireAccess, rowResult } from '../../../foundation/application/ModuleOperations';
import { bodyRecord, textField } from '../../../foundation/interface/Validation';
import { DATABASE_POOL } from '../../../foundation/persistence/Pool';

export function fulfillmentOperations(context: ModuleContext): ModuleOperations {
  const pool = context.container.get(DATABASE_POOL);
  return new ModuleOperations('fulfillment', pool, context.container.get(AUDIT_SINK), {
    'fulfillment.tracking.read': async (request, database) => {
      const access = requireAccess(request);
      const mall = access.mall_id;
      if (!mall) throw new Error('SCOPE_DENIED');
      const raw = request.input.query.order;
      const order = (Array.isArray(raw) ? raw[0] : raw)?.trim().slice(0, 255) ?? '';
      if (!order) throw new Error('VALIDATION_FAILED:order');
      const result = await database.query(`select fulfillment.id,fulfillment.order_id,fulfillment.state,fulfillment.external_reference,
        coalesce(jsonb_agg(jsonb_build_object('id',milestone.id,'kind',milestone.kind,'state',milestone.state,'tracking',milestone.external_id,
          'evidence',milestone.evidence,'occurredAt',milestone.occurred_at) order by milestone.occurred_at,milestone.id)
          filter(where milestone.id is not null),'[]') milestones from fulfillment.fulfillmentorder fulfillment
        left join fulfillment.milestone milestone on milestone.mall_id=fulfillment.mall_id and milestone.fulfillment_id=fulfillment.id
        where fulfillment.mall_id=$1 and fulfillment.order_id=$2 and fulfillment.member_id=$3
        group by fulfillment.id order by fulfillment.id`, [mall, order, access.scope.id]);
      return { status: 200, body: { items: result.rows, count: result.rows.length } };
    },
    'fulfillment.shipments.create': async (request, database) => {
      const access = requireAccess(request);
      const body = bodyRecord(request);
      const fulfillment = request.input.path.fulfillmentid!;
      const tracking = textField(body, 'tracking', 128);
      const loaded = await database.query<{ order_id: string; mall_id: string; can_ship: boolean }>(`select orders.id order_id,orders.mall_id,
        (orders.payment_state='paid' and orders.lifecycle_state='active' and shipment.kind='shipment'
          and shipment.state not in('completed','cancelled')) can_ship
        from ordering.orderrecord orders join fulfillment.fulfillmentorder shipment on shipment.mall_id=orders.mall_id and shipment.order_id=orders.id
        where shipment.id=$1 and ($2::text is null or orders.mall_id=$2)
        and case $3::text when 'supplier' then shipment.partner_id=$4 when 'store' then shipment.store_id=$4
          when 'mall' then orders.mall_id=$4 else exists (
            select 1 from organization.unitclosure closure where closure.ancestor_id=$4 and closure.descendant_id=orders.mall_id) end
        for update of orders,shipment`, [fulfillment, access.mall_id ?? null, access.scope.kind, access.scope.id]);
      const target = loaded.rows[0];
      if (!target) reject(404, 'RESOURCE_NOT_FOUND');
      if (!target.can_ship) reject(409, 'SHIPMENT_NOT_AVAILABLE');
      const result = await database.query(`with milestone as (insert into fulfillment.milestone(id,mall_id,fulfillment_id,kind,state,external_id,evidence,occurred_at)
        select $1,$2,$3,'shipment','shipped',$4,$5::jsonb,clock_timestamp() where not exists (
          select 1 from fulfillment.milestone prior where prior.mall_id=$2 and prior.fulfillment_id=$3
          and prior.kind='shipment' and prior.state='shipped') returning external_id), changed as
        (update fulfillment.fulfillmentorder set state='processing',version=version+1,updated_at=clock_timestamp()
          where mall_id=$2 and id=$3 and exists(select 1 from milestone) returning *)
        select changed.*,milestone.external_id tracking from changed cross join milestone`,
      [`milestone:${randomUUID()}`, target.mall_id, fulfillment, tracking, JSON.stringify({ carrier: body.carrier ?? null, actor: access.actor.id })]);
      if (!result.rows[0]) reject(409, 'SHIPMENT_ALREADY_RECORDED');
      await database.query(`update ordering.orderrecord orders set fulfillment_state='shipped',updated_at=clock_timestamp(),version=version+1
        where orders.id=$1 and orders.mall_id=$2 and orders.fulfillment_state in('unallocated','allocated','processing')
        and not exists (
          select 1 from fulfillment.fulfillmentorder shipment where shipment.mall_id=$2 and shipment.order_id=$1
            and shipment.kind='shipment' and shipment.state<>'cancelled' and not exists (
              select 1 from fulfillment.milestone milestone where milestone.mall_id=$2 and milestone.fulfillment_id=shipment.id
                and milestone.kind='shipment' and milestone.state='shipped'))`, [target.order_id, target.mall_id]);
      return rowResult(result, 201);
    },
    'fulfillment.returns.receive': async (request, database) => {
      const access = requireAccess(request);
      const mall = access.mall_id;
      if (!mall) throw new Error('SCOPE_DENIED');
      const body = bodyRecord(request);
      return rowResult(await database.query(`update fulfillment.returnrecord returned
        set state='received',tracking_number=coalesce($3,tracking_number),version=returned.version+1
        where returned.mall_id=$1 and returned.id=$2 and returned.state in('authorized','intransit')
          and ($4::bigint is null or returned.version=$4) returning returned.*`,
      [mall, request.input.path.returnid!, body.tracking ?? null, request.input.expectedVersion ?? null]));
    },
    'fulfillment.returns.inspect': async (request, database) => {
      const access = requireAccess(request);
      const mall = access.mall_id;
      if (!mall) throw new Error('SCOPE_DENIED');
      const body = bodyRecord(request);
      const result = await database.query(`update fulfillment.returnrecord returned set state=$3,inspection=$4::jsonb,version=returned.version+1
        where returned.mall_id=$1 and returned.id=$2 and returned.state='received'
          and ($5::bigint is null or returned.version=$5) returning returned.*`,
      [mall, request.input.path.returnid!, body.accepted === true ? 'accepted' : 'rejected', JSON.stringify(body.inspection ?? {}), request.input.expectedVersion ?? null]);
      const returned = result.rows[0] as { id?: string; mall_id?: string; fulfillment_id?: string } | undefined;
      if (!returned?.id) throw new Error('RETURN_INSPECTION_CONFLICT');
      if (body.accepted === true) await database.query(`insert into runtime.job(id,kind,owner,scope_id,payload,state,priority,available_at,created_at,updated_at)
        values($1,'inventorysync','inventory',$2,jsonb_build_object('mall',$2,'return',$3),'queued',20,clock_timestamp(),clock_timestamp(),clock_timestamp())`,
      [`job:return:${returned.id}`, returned.mall_id, returned.id]);
      return rowResult(result);
    },
  });
}
