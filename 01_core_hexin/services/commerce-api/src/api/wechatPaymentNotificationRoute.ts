import { apiError, json, methodNotAllowed } from './http';
import { callRpc } from './postgresRpc';
import type { WorkerEnv } from './types';
import { loadWechatPayConfig, WechatPayConfigurationError } from './wechatPayConfig';
import { WechatPayProtocolError } from './wechatPayModels';
import { verifyAndDecryptWechatPayNotification } from './wechatPayNotification';

const MAX_NOTIFICATION_BYTES = 64 * 1_024;

/** Public provider callback. It authenticates the signed body instead of a user session. */
export async function handleWechatPaymentNotification(request: Request, env: WorkerEnv, requestId: string): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed(['POST'], requestId);
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_NOTIFICATION_BYTES) {
    return apiError(413, 'WECHAT_PAY_NOTIFICATION_TOO_LARGE', '支付通知内容过大', requestId);
  }

  try {
    const config = loadWechatPayConfig(env);
    const body = await request.text();
    const notification = await verifyAndDecryptWechatPayNotification(config, { headers: request.headers, body });
    await callRpc(env, 'api_apply_wechat_payment_notification', {
      p_notification_id: notification.notificationId,
      p_event_type: notification.eventType,
      p_resource_type: notification.resourceType,
      p_app_id: notification.transaction.appId,
      p_mch_id: notification.transaction.mchId,
      p_out_trade_no: notification.transaction.outTradeNo,
      p_transaction_id: notification.transaction.transactionId,
      p_trade_state: notification.transaction.tradeState,
      p_success_time: notification.transaction.successTime,
      p_amount_total: notification.transaction.amount.total,
      p_payer_openid_hash: notification.payerOpenidHash,
      p_raw_summary: notification.summary,
      p_request_id: requestId,
    });
    return json({ code: 'SUCCESS', message: '成功' });
  } catch (error) {
    if (error instanceof WechatPayConfigurationError) {
      return apiError(503, 'WECHAT_PAYMENT_NOT_CONFIGURED', '微信支付商户配置尚未完成', requestId);
    }
    if (error instanceof WechatPayProtocolError) {
      return apiError(401, 'WECHAT_PAY_NOTIFICATION_REJECTED', '支付通知验证失败', requestId);
    }
    throw error;
  }
}
