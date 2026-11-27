import { ApiError } from '@shop/sdk/error';

const ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  AUTHENTICATION_REQUIRED: '登录会话已失效，请重新登录',
  CONTRACT_VERSION_UNSUPPORTED: '商城服务已升级，请刷新页面后重试',
  MOBILE_ASSURANCE_REQUIRED: '手机尚未验证，暂不能提交订单',
  CSRF_TOKEN_INVALID: '安全会话已更新，请刷新页面后重试',
  LISTING_NOT_PURCHASABLE: '该商品当前不可购买',
  LISTING_VERSION_CHANGED: '商品信息已更新，请确认购物车后重新结算',
  CHECKOUT_REJECTED: '商品状态已变化，请确认购物车后重新结算',
  EXPERIENCE_PUBLICATION_MISSING: '商城结算配置未发布，暂时无法提交订单。购物车商品已保留。',
  CHECKOUT_VERSION_CONFLICT: '购物车已发生变化，请刷新后重试',
  PRICE_QUOTE_EXPIRED: '结算报价已过期，请重新提交',
  QUOTE_EXPIRED_OR_CONFLICT: '结算信息已变化，请重新提交',
  WECHAT_IDENTITY_REQUIRED: '该订单需要微信支付，但当前账号未绑定微信',
  CHALLENGE_INVALID: '验证码不正确、已过期或已经使用',
  STEP_UP_DESTINATION_MISSING: '当前账号没有可验证的手机号',
  NOT_FOUND: '请求的内容仍在同步，请稍后重试',
  CONTRACT_RESPONSE_INVALID: '商城服务响应异常，请稍后重试',
});

function fallbackMessage(status: number): string {
  if (status === 404) return '请求的内容仍在同步，请稍后重试';
  if (status === 409) return '数据已发生变化，请稍后重试';
  if (status === 429) return '请求较多，请稍后重试';
  if (status >= 500) return '商城服务暂时繁忙，请稍后重试';
  return '请求未完成，请稍后重试';
}

export class ProductionApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ProductionApiError';
  }
}

export function productionError(cause: unknown): ProductionApiError {
  if (cause instanceof ProductionApiError) return cause;
  if (cause instanceof ApiError) {
    return new ProductionApiError(ERROR_MESSAGES[cause.code] ?? fallbackMessage(cause.status), cause.status, cause.code, cause.requestId);
  }
  if (cause instanceof TypeError && /failed to fetch|load failed|network request failed/i.test(cause.message)) {
    return new ProductionApiError('网络连接已中断，恢复后将自动重试', 0, 'NETWORK_OR_CLIENT_ERROR');
  }
  const message = cause instanceof Error && /[\u3400-\u9fff]/u.test(cause.message) ? cause.message : '商城服务暂时不可用，请稍后重试';
  return new ProductionApiError(message, 0, 'NETWORK_OR_CLIENT_ERROR');
}
