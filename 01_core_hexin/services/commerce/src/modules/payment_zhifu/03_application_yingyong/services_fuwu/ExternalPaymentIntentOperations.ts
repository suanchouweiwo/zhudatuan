import { createHash, randomUUID } from 'node:crypto';
import type { WechatScene } from '@shop/config/server';
import type { AuditSink } from '../../../../foundation/application/AuditSink';
import { requireAccess } from '../../../../foundation/application/ModuleOperations';
import type { OperationRequest, OperationResult, OperationUsecase } from '../../../../foundation/application/OperationHandler';
import { markEnforcedWriteResult } from '../../../../foundation/application/ExecutionKernel';
import type { KmsClient } from '../../../../foundation/infrastructure/KmsClient';
import type { DatabasePool } from '../../../../foundation/persistence/Pool';
import { bodyRecord, textField } from '../../../../foundation/interface/Validation';
import { orderPort } from '../../../order_dingdan';
import type { PaymentGateway } from '../../01_public_gongkai/ports_jiekou/PaymentGateway';
import { PaymentReference } from '../../02_domain_yewu/models_moxing/PaymentReference';
import {
  claimPaymentRequest as claimRequest,
  completePaymentRequest as completeRequest,
  isPaymentOutcomeUnknown as providerOutcomeUnknown,
  paymentTransaction as transaction,
  setPaymentContext as setContext,
} from './PaymentOperationSupport';
import type {
  PaymentIntentContextReader,
  PaymentIntentState,
  PaymentRecoveryQueue,
} from '../../01_public_gongkai/contracts_qiyue/PaymentContractModule';

export class ExternalPaymentIntentOperations implements OperationUsecase {
  constructor(
    private readonly pool: DatabasePool,
    private readonly gateway: PaymentGateway,
    private readonly kms: KmsClient,
    private readonly audit: AuditSink,
    private readonly contexts: PaymentIntentContextReader,
    private readonly recovery: PaymentRecoveryQueue,
  ) {}

  async invoke(request: OperationRequest): Promise<OperationResult> {
    if (request.type !== 'payment.intents.create') throw new Error(`OPERATION_ACTION_MISSING:${request.type}`);
    return markEnforcedWriteResult(await this.create(request));
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
    let state: PaymentIntentState;
    try {
      await client.query('begin');
      await setContext(client, request);
      const cached = await claimRequest(client, request, access.actor.id, access.scope.id);
      if (cached) {
        await client.query('commit');
        return cached;
      }
      const prior = await this.contexts.read(client, {
        order,
        membership: access.membership.id,
        session: access.actor.session,
        applicationHash: application.applicationHash,
        mall,
      });
      if (!prior) throw new Error('PAYMENT_INTENT_NOT_PAYABLE');
      if (prior.attempt && (prior.scene !== scene || prior.application_hash !== application.applicationHash)) {
        throw new Error('PAYMENT_APPLICATION_CONFLICT');
      }
      if (prior.parameters) {
        const response = { status: 200, body: { intent: prior.intent, parameters: prior.parameters } } satisfies OperationResult;
        await completeRequest(this.audit, client, request, response, access.actor.id, access.scope.id);
        await client.query('commit');
        return response;
      }
      if (prior.state !== null && ['started', 'unknown', 'pending'].includes(prior.state)) {
        await this.recovery.enqueue(client, {
          membership: access.membership.id,
          session: access.actor.session,
          mall: prior.mall_id,
          intent: prior.intent,
          priority: prior.state === 'unknown' ? 1 : 10,
          delaySeconds: prior.state === 'unknown' ? 0 : 5,
        });
        await client.query('commit');
        return { status: 202, body: { intent: prior.intent, state: prior.state === 'unknown' ? 'reconciling' : 'authorizing' } };
      }
      if (prior.amount_minor === 0) throw new Error('PAYMENT_EXTERNAL_TENDER_REQUIRED');
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
    let providerStarted = false;
    let providerAccepted = false;
    try {
      const payer = await this.kms.decrypt('identity/wechat', state.payer_ciphertext!, { identity: state.payer_identity! });
      const payerHash = createHash('sha256').update(payer).digest('hex');
      await transaction(this.pool, request, (database) => database.query(`update payment.attempt set payer_hash=$3
        where mall_id=$1 and id=$2 and state in('started','unknown','pending')`, [state.mall_id, state.attempt!, payerHash]));
      providerStarted = true;
      const parameters = await this.gateway.prepay({
        scope: state.mall_id,
        description: `主打团商城-${state.order_number}`,
        orderNumber: PaymentReference.payment(state.order_number).text,
        amountMinor: state.amount_minor,
        payer,
        application,
        expiresAt: wechatTime(state.expires_at),
      });
      providerAccepted = true;
      const response = { status: 201, body: { intent: state.intent, parameters } } satisfies OperationResult;
      await transaction(this.pool, request, async (database) => {
        await database.query(`with saved as (insert into payment.prepay(mall_id,intent_id,parameters,provider_request_id,created_at)
        values($1,$2,$3::jsonb,$4,clock_timestamp()) on conflict(mall_id,intent_id) do update
        set parameters=excluded.parameters,provider_request_id=excluded.provider_request_id returning parameters)
        update payment.attempt set state='pending',payer_hash=$6,completed_at=clock_timestamp() where mall_id=$1 and id=$5`,
        [state.mall_id, state.intent, JSON.stringify(parameters), parameters.providerRequestId || null, state.attempt!, payerHash]);
        await this.recovery.enqueue(database, {
          membership: access.membership.id,
          session: access.actor.session,
          mall: state.mall_id,
          intent: state.intent,
          priority: 10,
          delaySeconds: 5,
        });
        await completeRequest(this.audit, database, request, response, access.actor.id, access.scope.id);
      });
      return response;
    } catch (cause) {
      if (providerAccepted || (providerStarted && providerOutcomeUnknown(cause))) {
        await transaction(this.pool, request, async (database) => {
          await database.query("update payment.attempt set state='unknown',completed_at=clock_timestamp() where mall_id=$1 and id=$2 and state='started'",
          [state.mall_id, state.attempt!]);
          await this.recovery.enqueue(database, {
            membership: access.membership.id,
            session: access.actor.session,
            mall: state.mall_id,
            intent: state.intent,
            priority: 1,
            delaySeconds: 0,
          });
        });
        return { status: 202, body: { intent: state.intent, state: 'reconciling' } };
      }
      await transaction(this.pool, request, (database) => database.query(
        "update payment.attempt set state='failed',completed_at=clock_timestamp() where mall_id=$1 and id=$2 and state='started'",
        [state.mall_id, state.attempt!]));
      throw cause;
    }
  }
}

function wechatTime(value: string): string {
  const time = new Date(value);
  if (!Number.isFinite(time.getTime())) throw new Error('PAYMENT_EXPIRY_INVALID');
  return time.toISOString().replace('Z', '+00:00');
}
