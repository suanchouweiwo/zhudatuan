import type { Membership, Permission } from '@smart-wing/api-contract';

export interface WorkerEnv {
  ASSETS?: Fetcher;
  DATABASE_URL?: string;
  /** Provider region used only for health and operations reporting. */
  DATABASE_REGION?: string;
  /** One server-selected public mall shared by Web and mini-program guests. */
  PUBLIC_MALL_SLUG?: string;
  /** Canonical public media origin shared by Web and the WeChat mini-program. */
  PUBLIC_MEDIA_BASE_URL?: string;
  /** Loopback/private HTTP endpoint of the Beijing Tair read-cache sidecar. */
  CORE_READ_CACHE_URL?: string;
  /** Independent bearer credential for the private read-cache sidecar. */
  CORE_READ_CACHE_TOKEN?: string;
  APP_ENV?: string;
  AUTH_MODE?: string;
  /** Public member registration is fail-closed in production unless enabled. */
  SELF_REGISTRATION_ENABLED?: string;
  /** Username/password registration has its own production release switch. */
  USERNAME_REGISTRATION_ENABLED?: string;
  /** Independent release switch for create-and-bind registration in WeChat. */
  WECHAT_REGISTRATION_ENABLED?: string;
  /** Debug OTP is permitted only outside production. A real SMS provider follows. */
  SMS_PROVIDER?: string;
  /** Approved Aliyun SMS signature and one-time-code template. */
  ALIYUN_SMS_SIGN_NAME?: string;
  ALIYUN_SMS_TEMPLATE_CODE_VERIFICATION?: string;
  ALIYUN_SMS_REGION_ID?: string;
  ALIYUN_SMS_ENDPOINT?: string;
  /** Prefer an ECS RAM role. Dedicated SMS AKs remain a migration fallback. */
  ALIYUN_SMS_ECS_RAM_ROLE?: string;
  ALIYUN_SMS_ACCESS_KEY_ID?: string;
  ALIYUN_SMS_ACCESS_KEY_SECRET?: string;
  /** Exact test-client IPs that may skip only the login failure limiter. */
  TEST_LOGIN_RATE_LIMIT_BYPASS_IPS?: string;
  /** Required ISO timestamp at which the temporary bypass begins. */
  TEST_LOGIN_RATE_LIMIT_BYPASS_FROM?: string;
  /** Required ISO timestamp after which the test-client bypass fails closed. */
  TEST_LOGIN_RATE_LIMIT_BYPASS_UNTIL?: string;
  PII_ENCRYPTION_KEY?: string;
  SESSION_SIGNING_KEY?: string;
  /** Stable pepper for phone lookup and one-time verification hashes. */
  IDENTITY_LOOKUP_KEY?: string;
  /** Separate signing key for console.zhudatuan.com sessions. */
  ADMIN_SESSION_SIGNING_KEY?: string;
  /** Public identifier of the production WeChat mini program. */
  WECHAT_MINIAPP_APP_ID?: string;
  /** Server-only secret used exclusively for jscode2session. */
  WECHAT_MINIAPP_APP_SECRET?: string;
  /** Independent HMAC key for revocable mini-program bearer sessions. */
  MINIAPP_SESSION_SIGNING_KEY?: string;
  /** Direct-merchant WeChat Pay merchant number bound to the mini program. */
  WECHAT_PAY_MCH_ID?: string;
  WECHAT_PAY_MERCHANT_SERIAL_NO?: string;
  /** PEM-encoded merchant API certificate private key; server secret only. */
  WECHAT_PAY_MERCHANT_PRIVATE_KEY?: string;
  /** Exactly 32-byte API v3 key for notification resource decryption. */
  WECHAT_PAY_API_V3_KEY?: string;
  /** PEM-encoded WeChat Pay platform public key or platform certificate key. */
  WECHAT_PAY_PLATFORM_PUBLIC_KEY?: string;
  /** Expected Wechatpay-Serial value for notification verification. */
  WECHAT_PAY_PLATFORM_KEY_ID?: string;
  /** Public HTTPS payment notification endpoint. */
  WECHAT_PAY_NOTIFY_URL?: string;
}

/**
 * Runtime projection of one resolved Membership. It is never an
 * independently-authorized principal and never contains permissions from
 * another membership.
 */
export interface AuthorizationContext {
  tenantId: string;
  enterpriseId: string;
  mallId: string;
  mallCode: string;
  userId: string;
  employeeNo: string;
  roles: string[];
  permissions: Permission[];
  membership: Membership;
  stepUpAt: string | null;
}

export interface RequestContext {
  requestId: string;
  authorization: AuthorizationContext | null;
}
