import { createHash, randomUUID } from 'node:crypto';
import type { ModuleContext } from '../../../../bootstrap/ModuleRegistry';
import { AUDIT_SINK, type AuditSink } from '../../../../foundation/application/AuditSink';
import { requireAccess } from '../../../../foundation/application/ModuleOperations';
import { bodyRecord, integerField, keysetResult, queryPage, textField } from '../../../../foundation/interface/Validation';
import type { OperationRequest, OperationResult, OperationUsecase } from '../../../../foundation/application/OperationHandler';
import { markEnforcedWriteResult } from '../../../../foundation/application/ExecutionKernel';
import { KMS_CLIENT, type KmsClient } from '../../../../foundation/infrastructure/KmsClient';
import { DATABASE_POOL, type DatabasePool } from '../../../../foundation/persistence/Pool';
import { PAYMENT_GATEWAY, type PaymentGateway } from '../../01_public_gongkai/ports_jiekou/PaymentGateway';
import { PaymentSettlement } from '../../03_application_yingyong/services_fuwu/PaymentSettlement';
import { RefundPlanner } from '../../03_application_yingyong/services_fuwu/RefundPlanner';
import { PaymentReference } from '../../02_domain_yewu/models_moxing/PaymentReference';
import { orderPort } from '../../../order_dingdan';
import { claimPaymentRequest as claimRequest, completePaymentRequest as completeRequest, enqueuePaymentRecovery as enqueueRecovery,
  isPaymentOutcomeUnknown as providerOutcomeUnknown, paymentTransaction as transaction, setPaymentContext as setContext } from '../../03_application_yingyong/services_fuwu/PaymentOperationSupport';
import type { WechatScene } from '@shop/config/server';
import { PaymentWebhook } from './PaymentWebhook';
import { readPaymentIntent } from './PaymentIntentReadOperations';

interface IntentState { readonly intent: string; readonly attempt: string | null; readonly order_id: string; readonly order_number: string;
  readonly scope_id: string; readonly mall_id: string; readonly member_id: string; readonly total_minor: number; readonly amount_minor: number;
  readonly payer_identity: string | null; readonly payer_ciphertext: string | null; readonly state: string | null; readonly parameters: unknown | null;
  readonly scene: WechatScene | null; readonly application_hash: string | null; readonly expires_at: string }

export function paymentOperations(context: ModuleContext): OperationUsecase {
  return new PaymentOperations(context.container.get(DATABASE_POOL).workload('command'), context.container.get(PAYMENT_GATEWAY),
    context.container.get(KMS_CLIENT), context.container.get(AUDIT_SINK));
}

class PaymentOperations implements OperationUsecase {
  private readonly settlement = new PaymentSettlement();
  private readonly refunds = new RefundPlanner();
  private readonly webhook: PaymentWebhook;
  constructor(private readonly pool: DatabasePool, private readonly gateway: PaymentGateway, private readonly kms: KmsClient,
    private readonly audit: AuditSink) {
    this.webhook = new PaymentWebhook(pool, gateway, audit);
  }

  async invoke(request: OperationRequest): Promise<OperationResult> {
    if (request.type === 'payment.intents.create') return markEnforcedWriteResult(await this.create(request));
    if (request.type === 'payment.intents.read') return this.readIntent(request);
    if (request.type === 'payment.refunds.request') return markEnforcedWriteResult(await this.refund(request));
    if (request.type === 'payment.recoveries.read') return this.readRecoveries(request);
    if (request.type === 'payment.recoveries.resolve') return markEnforcedWriteResult(await this.resolveRecovery(request));
    if (request.type === 'payment.webhooks.wechat') return markEnforcedWriteResult(await this.webhook.handle(request));
    throw new Error(`OPERATION_ACTION_MISSING:${request.type}`);
  }

  private async readIntent(request: OperationRequest): Promise<OperationResult> {
    return readPaymentIntent(this.pool, request);
  }

  private async create(request: OperationRequest): Promise<OperationResult> {
    const access = requireAccess(request);
    const mall = access.mall_id;
    if (!mall) throw new Error('SCOPE_DENIED');
    const body = bodyRecord(request);
    const order = String(body.order ?? '');
    if (!order) throw new Error('VALIDATION_FAILED:order');
    const sceneValue = textField(body, 'scene', 16);
    if (sceneValue !== 'miniapp' && sceneValue !== 'jsapi') throw new Error('PAYMENT_SCENE_INVALID');
    const scene: WechatScene = sceneValue;
    const application = this.gateway.application(scene);
    const client = await this.pool.connect();
    let state: IntentState;
    try {
      await client.query('begin');
      await setContext(client, request);
      const cached = await claimRequest(client, request, access.actor.id, access.scope.id);
      if (cached) {
        await client.query('commit');
        return cached;
      }
      const existing = await client.query<IntentState>(`select intent.id intent,intent.order_id,orders.order_number,intent.mall_id scope_id,intent.mall_id,
        intent.member_id,intent.amount_minor::float8 total_minor,coalesce(wechat.amount_minor,0)::float8 amount_minor,
        identity.id payer_identity,identity.subject_ciphertext payer_ciphertext,attempt.id attempt,attempt.state,attempt.scene,
        attempt.application_hash,prepay.parameters,intent.expires_at
        from payment.intent intent join ordering.orderrecord orders on orders.id=intent.order_id and orders.mall_id=intent.mall_id
        join access.membership membership on membership.member_id=intent.member_id and membership.id=$2
        left join payment.intenttender wechat on wechat.mall_id=intent.mall_id and wechat.intent_id=intent.id and wechat.kind='wechat'
        left join lateral(select candidate.id,candidate.state,candidate.scene,candidate.application_hash from payment.attempt candidate where candidate.intent_id=intent.id
          and candidate.mall_id=intent.mall_id and candidate.provider='wechat' order by candidate.requested_at desc,candidate.id desc limit 1) attempt on true
        left join payment.prepay prepay on prepay.mall_id=intent.mall_id and prepay.intent_id=intent.id
        join member.profile profile on profile.id=intent.member_id
        left join lateral(select candidate.id,candidate.subject_ciphertext from identity.federatedidentity candidate
          where candidate.principal_id=profile.principal_id and candidate.provider='wechat' and candidate.status='active'
            and candidate.subject_ciphertext is not null and candidate.application_hash=$3
          order by candidate.updated_at desc,candidate.id desc limit 1) identity on true
        where intent.mall_id=$4 and orders.id=$1 and orders.payment_state in('unpaid','authorizing')
          and intent.state in('created','authorizing','authorized')
        for update of intent,orders`, [order, access.membership.id, application.applicationHash, mall]);
      const prior = existing.rows[0];
      if (!prior) throw new Error('PAYMENT_INTENT_NOT_PAYABLE');
      if (prior.attempt && (prior.scene !== scene || prior.application_hash !== application.applicationHash)) {
        throw new Error('PAYMENT_APPLICATION_CONFLICT');
      }
      if (prior?.parameters) {
        const response = { status: 200, body: { intent: prior.intent, parameters: prior.parameters } } satisfies OperationResult;
        await completeRequest(this.audit, client, request, response, access.actor.id, access.scope.id);
        await client.query('commit');
        return response;
      }
      if (prior.state !== null && ['started', 'unknown', 'pending'].includes(prior.state)) {
        await client.query('commit');
        return { status: 202, body: { intent: prior.intent, state: prior.state === 'unknown' ? 'reconciling' : 'authorizing' } };
      }
      if (prior.amount_minor === 0) {
        const payment = await this.settlement.capture(client, { intent: prior.intent, order: prior.order_id, scope: prior.scope_id, mall: prior.mall_id,
          member: prior.member_id, amountMinor: prior.total_minor, currency: 'CNY' }, 'internal');
        const response = { status: 200, body: { intent: prior.intent, payment, state: 'captured' } } satisfies OperationResult;
        await completeRequest(this.audit, client, request, response, access.actor.id, access.scope.id);
        await client.query('commit');
        return response;
      }
      if (!prior.payer_identity || !prior.payer_ciphertext) throw new Error('WECHAT_IDENTITY_REQUIRED');
      if (prior.attempt) {
        await client.query("update payment.attempt set state='started',requested_at=clock_timestamp(),completed_at=null where mall_id=$1 and id=$2",
        [prior.mall_id, prior.attempt]);
        state = prior;
      } else {
        const attempt = `attempt:${randomUUID()}`;
        await client.query(`insert into payment.attempt(id,mall_id,intent_id,tender_id,provider,scene,application_hash,state,requested_at)
          values($1,$2,$3,'tender:wechat','wechat',$4,$5,'started',clock_timestamp())`,
        [attempt, prior.mall_id, prior.intent, scene, application.applicationHash]);
        await client.query("update payment.intent set state='authorizing',version=version+1 where mall_id=$1 and id=$2 and state='created'",
        [prior.mall_id, prior.intent]);
        await orderPort.markAuthorizing(client, order);
        state = { ...prior, attempt, state: 'started' };
      }
      await client.query('commit');
    } catch (cause) {
      await client.query('rollback');
      throw cause;
    } finally {
      client.release();
    }
    try {
      const payer = await this.kms.decrypt('identity/wechat', state.payer_ciphertext!, { identity: state.payer_identity! });
      const payerHash = createHash('sha256').update(payer).digest('hex');
      await transaction(this.pool, request, (database) => database.query(`update payment.attempt set payer_hash=$3
        where mall_id=$1 and id=$2 and state in('started','unknown','pending')`, [state.mall_id, state.attempt!, payerHash]));
      const parameters = await this.gateway.prepay({ scope: state.mall_id, description: `主打团商城-${state.order_number}`,
        orderNumber: PaymentReference.payment(state.order_number).text, amountMinor: state.amount_minor, payer,
        application, expiresAt: wechatTime(state.expires_at) });
      const response = { status: 201, body: { intent: state.intent, parameters } } satisfies OperationResult;
      await transaction(this.pool, request, async (database) => {
        await database.query(`with saved as (insert into payment.prepay(mall_id,intent_id,parameters,provider_request_id,created_at)
        values($1,$2,$3::jsonb,$4,clock_timestamp()) on conflict(mall_id,intent_id) do update
        set mall_id=excluded.mall_id,parameters=excluded.parameters,provider_request_id=excluded.provider_request_id returning parameters)
        update payment.attempt set state='pending',payer_hash=$6,completed_at=clock_timestamp() where mall_id=$1 and id=$5`,
        [state.mall_id, state.intent, JSON.stringify(parameters), parameters.providerRequestId || null, state.attempt!, payerHash]);
        await database.query(`insert into runtime.job(id,kind,owner,scope_id,payload,state,priority,available_at,created_at,updated_at)
        values($1,'paymentquery','payment',$2,jsonb_build_object('intent',$3::text),'queued',10,clock_timestamp()+interval '5 seconds',clock_timestamp(),clock_timestamp())
        on conflict(id) do update set state='queued',available_at=excluded.available_at,updated_at=clock_timestamp(),attempts=0`,
        [`job:query:${state.intent}`, state.scope_id, state.intent]);
        await completeRequest(this.audit, database, request, response, access.actor.id, access.scope.id);
      });
      return response;
    } catch (cause) {
      if (providerOutcomeUnknown(cause)) {
        await transaction(this.pool, request, async (database) => {
          await database.query("update payment.attempt set state='unknown',completed_at=clock_timestamp() where mall_id=$1 and id=$2 and state='started'",
          [state.mall_id, state.attempt!]);
          await database.query(`insert into runtime.job(id,kind,owner,scope_id,payload,state,priority,available_at,created_at,updated_at)
            values($1,'paymentquery','payment',$2,jsonb_build_object('intent',$3::text),'queued',1,clock_timestamp(),clock_timestamp(),clock_timestamp())
            on conflict(id) do update set state='queued',available_at=clock_timestamp(),updated_at=clock_timestamp()`,
          [`job:query:${state.intent}`, state.scope_id, state.intent]);
        });
        return { status: 202, body: { intent: state.intent, state: 'reconciling' } };
      }
      await transaction(this.pool, request, (database) => database.query(
        "update payment.attempt set state='failed',completed_at=clock_timestamp() where mall_id=$1 and id=$2 and state='started'",
        [state.mall_id, state.attempt!]));
      throw cause;
    }
  }

  private async refund(request: OperationRequest): Promise<OperationResult> {
    const access = requireAccess(request);
    const mall = access.mall_id;
    if (!mall) throw new Error('SCOPE_DENIED');
    const body = bodyRecord(request);
    const id = `refund:${randomUUID()}`;
    const amount = integerField(body, 'amountMinor', 1);
    const payment = textField(body, 'payment');
    const reason = textField(body, 'reason', 500);
    return transaction(this.pool, request, async (database) => {
      const cached = await claimRequest(database, request, access.actor.id, access.scope.id);
      if (cached) return cached;
      const refund = await this.refunds.create(database, { id, payment, amountMinor: amount, idempotency: request.input.idempotency!, reason,
        mall });
      await database.query(`insert into runtime.job(id,kind,owner,scope_id,payload,state,priority,available_at,created_at,updated_at)
        values($1,'paymentrefund','payment',$2,jsonb_build_object('refund',$3::text,'actor',$4::text),'queued',10,clock_timestamp(),clock_timestamp(),clock_timestamp())`,
      [`job:${refund.id}`, mall, refund.id, access.actor.id]);
      const response = { status: 202, body: refund } satisfies OperationResult;
      await completeRequest(this.audit, database, request, response, access.actor.id, access.scope.id);
      return response;
    });
  }

  private async readRecoveries(request: OperationRequest): Promise<OperationResult> {
    const access = requireAccess(request);
    const mall = access.mall_id;
    if (!mall) throw new Error('SCOPE_DENIED');
    const page = queryPage(request);
    return transaction(this.pool, request, async (database) => {
      const result = await database.query(`select recovery.id,recovery.order_id,recovery.evidence->>'orderNumber' order_number,
        recovery.resource_type,recovery.resource_id,
        recovery.severity,recovery.state,recovery.error_code,recovery.evidence,recovery.occurrence_count,recovery.opened_at,recovery.resolved_at,
        recovery.resolution_request_id from payment.recoverycase recovery where recovery.mall_id=$1
        and ($2::timestamptz is null or (recovery.opened_at,recovery.id)<($2::timestamptz,$3))
        order by recovery.opened_at desc,recovery.id desc limit $4`, [mall, page.sort, page.id, page.fetch]);
      return keysetResult(result, page, 'opened_at');
    });
  }

  private async resolveRecovery(request: OperationRequest): Promise<OperationResult> {
    const access = requireAccess(request);
    const mall = access.mall_id;
    if (!mall) throw new Error('SCOPE_DENIED');
    const body = bodyRecord(request);
    const action = textField(body, 'action', 32);
    if (!['replay', 'requery', 'retryrefund', 'resolve'].includes(action)) throw new Error('PAYMENT_RECOVERY_ACTION_INVALID');
    const reason = textField(body, 'reason', 500);
    const caseid = request.input.path.caseid!;
    return transaction(this.pool, request, async (database) => {
      const cached = await claimRequest(database, request, access.actor.id, access.scope.id);
      if (cached) return cached;
      const recovery = (await database.query<{ id: string; mall_id: string; resource_type: string; resource_id: string;
        state: string; evidence: Record<string, unknown> }>(`select id,mall_id,resource_type,resource_id,state,evidence
        from payment.recoverycase where mall_id=$1 and id=$2 for update`, [mall, caseid])).rows[0];
      if (!recovery) throw new Error('PAYMENT_RECOVERY_NOT_FOUND');
      if (recovery.state !== 'open') throw new Error('PAYMENT_RECOVERY_ALREADY_RESOLVED');
      const requestid = `recoveryrequest:${createHash('sha256').update(`${caseid}:${request.input.idempotency}`).digest('hex').slice(0, 32)}`;
      await database.query(`insert into payment.recoveryrequest(id,case_id,scope_id,mall_id,actor_id,membership_id,reason,evidence_hash,trace_id,created_at)
        values($1,$2,$3,$3,$4,$5,$6,$7,$8,clock_timestamp())`, [requestid, caseid, recovery.mall_id, access.actor.id, access.membership.id,
        reason, createHash('sha256').update(JSON.stringify(recovery.evidence)).digest('hex'), access.trace]);
      if (action === 'replay') {
        if (recovery.resource_type !== 'deadletter') throw new Error('PAYMENT_RECOVERY_RESOURCE_INVALID');
        const kind = recovery.evidence.kind;
        const payload = recovery.evidence.payload;
        if ((kind !== 'paymentquery' && kind !== 'paymentrefund') || payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
          throw new Error('PAYMENT_DEADLETTER_EVIDENCE_INVALID');
        }
        await enqueueRecovery(database, requestid, kind, recovery.mall_id, payload as Readonly<Record<string, string>>);
        await database.query(`update runtime.deadletter set reviewed_at=clock_timestamp() where id=$1 and owner='payment'`, [recovery.evidence.deadletter]);
      }
      if (action === 'requery') {
        if (recovery.resource_type !== 'intent') throw new Error('PAYMENT_RECOVERY_RESOURCE_INVALID');
        const intent = await database.query('select id from payment.intent where mall_id=$1 and id=$2',
        [recovery.mall_id, recovery.resource_id]);
        if (!intent.rows[0]) throw new Error('PAYMENT_INTENT_NOT_FOUND');
        await enqueueRecovery(database, requestid, 'paymentquery', recovery.mall_id, { intent: recovery.resource_id });
      }
      if (action === 'retryrefund') {
        const refund = recovery.resource_type === 'refund' ? recovery.resource_id : String(recovery.evidence.refund ?? '');
        const refundable = await database.query<{ state: string }>('select state from payment.refund where mall_id=$1 and id=$2 for update',
        [recovery.mall_id, refund]);
        if (!refundable.rows[0] || refundable.rows[0].state === 'succeeded') throw new Error('PAYMENT_REFUND_NOT_RETRYABLE');
        if (refundable.rows[0].state === 'failed') {
          await database.query(`update payment.refund set state='requested',version=version+1 where mall_id=$1 and id=$2`,
          [recovery.mall_id, refund]);
          await database.query(`update payment.refundtender set state='planned' where mall_id=$1 and refund_id=$2 and state='failed'`,
          [recovery.mall_id, refund]);
        }
        await enqueueRecovery(database, requestid, 'paymentrefund', recovery.mall_id, { refund });
      }
      if (action === 'resolve') {
        await database.query(`update payment.recoverycase set state='resolved',resolved_at=clock_timestamp(),resolution_request_id=$3
          where mall_id=$1 and id=$2`, [recovery.mall_id, caseid, requestid]);
        if (recovery.resource_type === 'deadletter') await database.query(`update runtime.deadletter set reviewed_at=clock_timestamp()
          where id=$1 and owner='payment'`, [recovery.evidence.deadletter]);
      }
      const response = { status: 202, body: { case: caseid, request: requestid, action, state: action === 'resolve' ? 'resolved' : 'accepted' } } satisfies OperationResult;
      await completeRequest(this.audit, database, request, response, access.actor.id, access.scope.id);
      return response;
    });
  }

}

function wechatTime(value: string): string {
  const time = new Date(value);
  if (!Number.isFinite(time.getTime())) throw new Error('PAYMENT_EXPIRY_INVALID');
  return time.toISOString().replace('Z', '+00:00');
}
