import { requireAccess, rowResult, type OperationAction } from '../../../../foundation/application/ModuleOperations';
import { bodyRecord, textField } from '../../../../foundation/interface/Validation';
import { Order, type AftersaleState, type CommerceState, type FulfillmentState, type PaymentState } from '../../02_domain_yewu/models_moxing/Order';

interface AftersaleOrder {
  readonly id: string;
  readonly lifecycle_state: CommerceState;
  readonly payment_state: PaymentState;
  readonly fulfillment_state: FulfillmentState;
  readonly aftersale_state: AftersaleState;
  readonly version: string;
}

export const applyAftersale: OperationAction = async (request, database) => {
  const access = requireAccess(request);
  const body = bodyRecord(request);
  const orderId = request.input.path.orderid!;
  const loaded = await database.query<AftersaleOrder>(`select id,lifecycle_state,payment_state,fulfillment_state,aftersale_state,version::text as version
    from ordering.orderrecord where id=$1 and member_id=$2`, [orderId, access.scope.id]);
  const row = loaded.rows[0];
  if (!row) throw new Error('RESOURCE_NOT_FOUND');
  new Order(row.id, row.lifecycle_state, row.payment_state, row.fulfillment_state, row.aftersale_state).assertAftersaleAllowed();

  const lines = body.lines === undefined ? null : selectedLines(body.lines);
  const kind = body.kind ?? 'refund';
  const returnMethod = body.returnMethod ?? null;
  if (lines && kind !== 'refund' && kind !== 'return') throw new Error('VALIDATION_FAILED:kind');
  if (returnMethod !== null && (kind !== 'return' || (returnMethod !== 'pickup' && returnMethod !== 'self_send'))) {
    throw new Error('VALIDATION_FAILED:returnMethod');
  }
  const reason = textField(body, 'reason', 1000);
  const result = await database.query(`select * from ordering.apply_aftersale($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [
    orderId, row.version, kind, reason, lines, body.line ?? null, body.quantity ?? null, body.amountMinor ?? null, returnMethod,
  ]);
  if (lines === null) return rowResult(result, 201);
  return { status: 201, body: { items: result.rows } };
};

function selectedLines(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('VALIDATION_FAILED:lines');
  const lines = value.map((line) => textField({ line }, 'line'));
  if (new Set(lines).size !== lines.length) throw new Error('VALIDATION_FAILED:lines.duplicate');
  return lines;
}
