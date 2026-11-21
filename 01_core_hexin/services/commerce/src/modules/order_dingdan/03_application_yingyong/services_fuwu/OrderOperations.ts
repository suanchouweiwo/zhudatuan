import { randomUUID } from 'node:crypto';
import type { ModuleContext } from '../../../../bootstrap/ModuleRegistry';
import { AUDIT_SINK } from '../../../../foundation/application/AuditSink';
import { ModuleOperations, requireAccess, rowResult } from '../../../../foundation/application/ModuleOperations';
import { bodyRecord, keysetResult, queryPage, textField } from '../../../../foundation/interface/Validation';
import type { OperationDatabase } from '../../../../foundation/application/ModuleOperations';
import { DATABASE_POOL } from '../../../../foundation/persistence/Pool';
import { SECURITY_KEYS } from '../../../../foundation/infrastructure/SecretStore';
import { fullCheckoutPort } from '../../../checkout_jiesuan/04_adapters_shixian/providers_waibu/FullCheckoutPort';
import { BenefitPort } from '../../../benefit';
import { FinancePort } from '../../../finance';
import { VoucherPort } from '../../../voucher';
import { confirmOrderReceiptOperations } from '../commands_xieru/ConfirmOrderReceipt';
import { applyAftersale } from '../commands_xieru/ApplyAftersale';
import { PlaceOrder } from '../commands_xieru/PlaceOrder';
import { createReportingExport, listReportingExports } from '../../../reporting';

export function orderOperations(context: ModuleContext): ModuleOperations {
  const pool = context.container.get(DATABASE_POOL);
  const place = new PlaceOrder(
    fullCheckoutPort(context.container.get(SECURITY_KEYS).quote),
    new BenefitPort(new FinancePort()),
    new VoucherPort(new FinancePort()),
  );
  return new ModuleOperations('order', pool, context.container.get(AUDIT_SINK), {
    'order.orders.create': (request, database) => place.execute(request, database),
    'order.orders.read': async (request, database) => {
      const access = requireAccess(request);
      const owner = access.scope.kind === 'owner';
      const supplier = access.scope.kind === 'supplier';
      const store = access.scope.kind === 'store';
      const order = queryValue(request.input.query.order);
      const page = queryPage(request);
      const result = await database.query(`select orders.*,coalesce(jsonb_agg(jsonb_build_object('id',line.id,'sku',line.sku_id,'listing',line.listing_id,'title',line.title_snapshot,
        'quantity',line.quantity,'unitMinor',line.unit_minor,'totalMinor',line.total_minor,'discountMinor',line.discount_minor,
        'payableMinor',line.payable_minor,'provider',line.provider,'partner',line.partner_id)) filter(where line.id is not null),'[]') lines
        from ordering.orderrecord orders left join ordering.line line on line.order_id=orders.id where (
        ($1::boolean and orders.member_id=$2) or ($3 and exists(select 1 from fulfillment.fulfillmentorder where order_id=orders.id and partner_id=$2))
        or ($4 and exists(select 1 from fulfillment.fulfillmentorder where order_id=orders.id and store_id=$2))
        or (not $1::boolean and not $3 and not $4 and exists(select 1 from organization.unitclosure closure where closure.ancestor_id=$2 and closure.descendant_id=orders.mall_id))
        ) and ($5='' or orders.id=$5) and ($6::timestamptz is null or (orders.created_at,orders.id)<($6::timestamptz,$7))
        group by orders.id order by orders.created_at desc,orders.id desc limit $8`, [owner, access.scope.id, supplier, store, order, page.sort, page.id, page.fetch]);
      const response = keysetResult(result, page, 'created_at');
      if (queryValue(request.input.query.exports) !== 'true') return response;
      return { ...response, exports: await listReportingExports(database, access.scope.id, 'orders', 20) };
    },
    ...confirmOrderReceiptOperations(),
    'order.reminders.create': async (request, database) => {
      const access = requireAccess(request);
      const result = await database.query(`insert into ordering.reminder(id,order_id,member_id,kind,state,created_at)
        select $1,orders.id,orders.member_id,'fulfillment','queued',clock_timestamp() from ordering.orderrecord orders
        where orders.id=$2 and orders.member_id=$3 and orders.lifecycle_state in('created','active')
          and not exists(select 1 from ordering.reminder prior where prior.order_id=orders.id and prior.created_at>clock_timestamp()-interval '30 minutes')
        returning *`, [`reminder:${randomUUID()}`, request.input.path.orderid!, access.scope.id]);
      const reminder = result.rows[0] as { id?: string } | undefined;
      if (!reminder?.id) throw new Error('ORDER_REMINDER_NOT_ALLOWED_OR_RATE_LIMITED');
      await database.query(`insert into runtime.job(id,kind,owner,scope_id,payload,state,priority,available_at,created_at,updated_at)
        values($1,'notification','order',$2,jsonb_build_object('reminder',$3,'order',$4),'queued',20,clock_timestamp(),clock_timestamp(),clock_timestamp())`,
      [`job:${reminder.id}`, access.scope.id, reminder.id, request.input.path.orderid!]);
      return rowResult(result, 202);
    },
    'order.orders.export': async (request, database) => {
      const body = bodyRecord(request);
      return { status: 202, body: await createReportingExport(request, database, 'orders', body) };
    },
    'order.aftersales.read': async (request, database) => {
      const access = requireAccess(request);
      const page = queryPage(request);
      const result = await database.query(`select aftersale.*,orders.order_number,orders.member_id,orders.mall_id from ordering.aftersale aftersale
        join ordering.orderrecord orders on orders.id=aftersale.order_id where ((orders.member_id=$1) or exists(select 1 from organization.unitclosure closure
        where closure.ancestor_id=$1 and closure.descendant_id=orders.mall_id) or exists(select 1 from fulfillment.returnrecord returned
          join fulfillment.fulfillmentorder fulfillment on fulfillment.id=returned.fulfillment_id where returned.aftersale_id=aftersale.id
            and (fulfillment.partner_id=$1 or fulfillment.store_id=$1))) and ($2::timestamptz is null or (aftersale.created_at,aftersale.id)<($2::timestamptz,$3))
        order by aftersale.created_at desc,aftersale.id desc limit $4`, [access.scope.id, page.sort, page.id, page.fetch]);
      return keysetResult(result, page, 'created_at');
    },
    'order.aftersales.apply': applyAftersale,
    'order.aftersales.approve': review('approved'),
    'order.aftersales.reject': review('rejected'),
  });
}

function queryValue(value: string | readonly string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim().slice(0, 255) ?? '';
}

function review(next: 'approved' | 'rejected') {
  return async (request: Parameters<ModuleOperations['invoke']>[0], database: OperationDatabase) => {
    const access = requireAccess(request);
    const body = bodyRecord(request);
    const result = await database.query<{ id: string; order_id: string; requested_by: string | null }>(`update ordering.aftersale set state=$2,version=version+1,updated_at=clock_timestamp()
      where id=$1 and state='requested' and coalesce(requested_by,'')<>$3 and ($4::bigint is null or version=$4) returning id,order_id,requested_by`,
    [request.input.path.aftersaleid!, next, access.actor.id, request.input.expectedVersion ?? null]);
    const aftersale = result.rows[0];
    if (!aftersale) throw new Error('AFTERSALE_REVIEW_CONFLICT_OR_SEPARATION');
    await database.query(`insert into ordering.reviewaction(id,aftersale_id,previous_state,next_state,reason,evidence,actor_id,membership_id,grant_evidence,trace_id,occurred_at)
      values($1,$2,'requested',$3,$4,$5,$6,$7,$8::jsonb,$9,clock_timestamp())`, [`review:${randomUUID()}`, aftersale.id, next, textField(body, 'reason', 1000), body.evidence ?? null,
      access.actor.id, access.membership.id, JSON.stringify({ permission: 'order.aftersale.decide', scope: access.scope }), access.trace]);
    await database.query(`update ordering.orderrecord set aftersale_state=$2,version=version+1,updated_at=clock_timestamp() where id=$1`, [aftersale.order_id, next === 'approved' ? 'processing' : 'rejected']);
    if (next === 'approved') await database.query(`insert into runtime.job(id,kind,owner,scope_id,payload,state,priority,available_at,created_at,updated_at)
      select $1,'paymentrefund','payment',orders.scope_id,jsonb_build_object('aftersale',$2::text),'queued',10,clock_timestamp(),clock_timestamp(),clock_timestamp()
      from ordering.orderrecord orders where orders.id=$3`, [`job:refund:${aftersale.id}`, aftersale.id, aftersale.order_id]);
    return rowResult(result);
  };
}
