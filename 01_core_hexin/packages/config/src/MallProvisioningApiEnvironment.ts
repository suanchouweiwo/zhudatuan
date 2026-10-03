import {
  bearerToken,
  enumValue,
  integerValue,
  processEnvironment,
  requiredValue,
  type EnvironmentSource,
} from './Environment';
import { apiAllowedOrigins } from './ApiEnvironment';
import { nodeOriginForBinding } from './SflNodeRegistry';

export const MALL_PROVISIONING_API_PROFILE = 'mall-provisioning-only' as const;
const PLATFORM_CONSOLE_ORIGIN = nodeOriginForBinding(
  'node:zhudatuan:l0',
  'domain:zhudatuan:l0:console',
);

export const MALL_PROVISIONING_API_ENVIRONMENT_KEYS = Object.freeze([
  'MALL_PROVISIONING_API_PROFILE',
  'API_PORT',
  'API_BIND_HOST',
  'APP_ENV',
  'AUTH_MODE',
  'SERVICE_VERSION',
  'API_ALLOWED_ORIGINS',
  'DATABASE_API_CONNECTION_REF',
  'SECRET_STORE_ENDPOINT',
  'SECRET_STORE_BEARER_TOKEN',
] as const);

export type MallProvisioningApiEnvironment = Readonly<Partial<Record<
  (typeof MALL_PROVISIONING_API_ENVIRONMENT_KEYS)[number], string
>>>;

const CONFIGURATION_KEY = /^(?:API_|APP_ENV$|AUTH_|DATABASE_|EXTENSION_|IDENTITY_|INVOICE_|JOB_|KMS_|MALL_|NOTIFICATION_|OBJECT_|PAYMENT_|PAYOUT_|PII_|PUBLIC_|PURCHASE_|QUOTE_|REDIS_|SECRET_|SESSION_|SERVICE_VERSION$|WEB_BUSINESS_|WECHAT_)/;
const ALLOWED_KEYS = new Set<string>(MALL_PROVISIONING_API_ENVIRONMENT_KEYS);

export function mallProvisioningApiEnvironment(
  source: EnvironmentSource = processEnvironment(),
): MallProvisioningApiEnvironment {
  validateMallProvisioningApiEnvironment(source);
  return Object.freeze(Object.fromEntries(MALL_PROVISIONING_API_ENVIRONMENT_KEYS
    .flatMap((key) => source[key] === undefined ? [] : [[key, source[key]!]]))) as MallProvisioningApiEnvironment;
}

export function validateMallProvisioningApiEnvironment(source: EnvironmentSource): void {
  for (const key of Object.keys(source).filter((candidate) => CONFIGURATION_KEY.test(candidate) && !ALLOWED_KEYS.has(candidate)).sort()) {
    throw new Error(`MALL_PROVISIONING_API_KEY_FORBIDDEN:${key}`);
  }
  if (requiredValue(source.MALL_PROVISIONING_API_PROFILE, 'MALL_PROVISIONING_API_PROFILE_INVALID')
    !== MALL_PROVISIONING_API_PROFILE) throw new Error('MALL_PROVISIONING_API_PROFILE_INVALID');
  const app = enumValue(source.APP_ENV, ['development', 'test', 'production'], 'APP_ENV_INVALID');
  if (enumValue(source.AUTH_MODE, ['membership'], 'AUTH_MODE_INVALID') !== 'membership') throw new Error('AUTH_MODE_INVALID');
  for (const [key, code] of [
    ['SERVICE_VERSION', 'SERVICE_VERSION_MISSING'],
    ['API_ALLOWED_ORIGINS', 'API_ALLOWED_ORIGINS_MISSING'],
    ['DATABASE_API_CONNECTION_REF', 'DATABASE_API_CONNECTION_REF_MISSING'],
    ['SECRET_STORE_ENDPOINT', 'SECRET_STORE_ENDPOINT_MISSING'],
  ] as const) requiredValue(source[key], code);
  if (source.API_BIND_HOST !== undefined && source.API_BIND_HOST !== '127.0.0.1') {
    throw new Error('MALL_PROVISIONING_API_BIND_HOST_INVALID');
  }
  const secretStoreEndpoint = secureEndpoint(source.SECRET_STORE_ENDPOINT, 'SECRET_STORE_ENDPOINT_INVALID');
  if (app === 'production' && secretStoreEndpoint.hostname !== '127.0.0.1') {
    throw new Error('MALL_PROVISIONING_API_SECRET_STORE_ENDPOINT_INVALID');
  }
  bearerToken(source.SECRET_STORE_BEARER_TOKEN, 'SECRET_STORE_BEARER_TOKEN_INVALID');
  const origins = apiAllowedOrigins(source);
  if (app === 'production' && origins.join(',') !== PLATFORM_CONSOLE_ORIGIN) {
    throw new Error('MALL_PROVISIONING_API_ORIGINS_INVALID');
  }
  if (mallProvisioningApiPort(source) !== 4325) throw new Error('MALL_PROVISIONING_API_PORT_INVALID');
}

export function mallProvisioningApiPort(environment: MallProvisioningApiEnvironment): number {
  return integerValue(environment.API_PORT, 4325, 1, 65_535, 'API_PORT_INVALID');
}

export function mallProvisioningApiAllowedOrigins(
  environment: MallProvisioningApiEnvironment,
): readonly string[] {
  return apiAllowedOrigins(environment);
}

function secureEndpoint(value: string | undefined, code: string): URL {
  const endpoint = requiredValue(value, code);
  let parsed: URL;
  try { parsed = new URL(endpoint); } catch { throw new Error(code); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || parsed.search) throw new Error(code);
  return parsed;
}
