import { bearerToken, distinctValues, enumValue, integerValue, processEnvironment, requiredValue, type EnvironmentSource } from './Environment';
import { apiAllowedOrigins } from './ApiEnvironment';

export const IDENTITY_REGISTRATION_API_PROFILE = 'registration-only' as const;

export const IDENTITY_REGISTRATION_API_ENVIRONMENT_KEYS = Object.freeze([
  'IDENTITY_REGISTRATION_API_PROFILE',
  'API_PORT',
  'API_BIND_HOST',
  'APP_ENV',
  'AUTH_MODE',
  'SERVICE_VERSION',
  'API_ALLOWED_ORIGINS',
  'IDENTITY_CONTROLLER_ORIGIN',
  'DATABASE_API_CONNECTION_REF',
  'DATABASE_API_ROLE',
  'SESSION_KEY_REF',
  'IDENTITY_KEY_REF',
  'WECHAT_APPLICATION_CONFIG_REF',
  'WECHAT_IDENTITY_CONFIG_REF',
  'KMS_ENDPOINT',
  'KMS_BEARER_TOKEN',
  'OBJECT_STORE_ENDPOINT',
  'OBJECT_STORE_BEARER_TOKEN',
  'SECRET_STORE_ENDPOINT',
  'SECRET_STORE_BEARER_TOKEN',
  'NODE_MANIFEST_PATH',
  'NODE_MANIFEST_ID',
  'NODE_MANIFEST_DIGEST',
  'NODE_IDENTITY_RUNTIME_PATH',
  'NODE_RUNTIME_INSTANCE_ID',
  'NODE_RUNTIME_CONFIG_REF',
  'NODE_RESOURCE_BINDING_VERSION',
  'NODE_RELEASE_POINTER_REF',
] as const);

export type IdentityRegistrationApiEnvironment = Readonly<Partial<Record<
  (typeof IDENTITY_REGISTRATION_API_ENVIRONMENT_KEYS)[number], string
>>>;

const CONFIGURATION_KEY = /^(?:API_|APP_ENV$|AUTH_|DATABASE_|EXTENSION_|IDENTITY_|INVOICE_|JOB_|KMS_|NODE_(?:MANIFEST_|RUNTIME_|RESOURCE_|RELEASE_)|NOTIFICATION_|OBJECT_|PAYMENT_|PAYOUT_|PII_|PUBLIC_|QUOTE_|REDIS_|SECRET_|SESSION_|SERVICE_VERSION$|WECHAT_)/;
const ALLOWED_KEYS = new Set<string>(IDENTITY_REGISTRATION_API_ENVIRONMENT_KEYS);

export function identityRegistrationApiEnvironment(
  source: EnvironmentSource = processEnvironment(),
): IdentityRegistrationApiEnvironment {
  validateIdentityRegistrationApiEnvironment(source);
  const environment: Partial<Record<(typeof IDENTITY_REGISTRATION_API_ENVIRONMENT_KEYS)[number], string>> = {};
  for (const key of IDENTITY_REGISTRATION_API_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  return Object.freeze(environment);
}

export function validateIdentityRegistrationApiEnvironment(source: EnvironmentSource): void {
  for (const key of Object.keys(source).filter((candidate) => CONFIGURATION_KEY.test(candidate) && !ALLOWED_KEYS.has(candidate)).sort()) {
    throw new Error(`IDENTITY_REGISTRATION_API_KEY_FORBIDDEN:${key}`);
  }
  if (requiredValue(source.IDENTITY_REGISTRATION_API_PROFILE, 'IDENTITY_REGISTRATION_API_PROFILE_INVALID')
    !== IDENTITY_REGISTRATION_API_PROFILE) throw new Error('IDENTITY_REGISTRATION_API_PROFILE_INVALID');
  enumValue(source.APP_ENV, ['development', 'test', 'production'], 'APP_ENV_INVALID');
  if (enumValue(source.AUTH_MODE, ['membership'], 'AUTH_MODE_INVALID') !== 'membership') throw new Error('AUTH_MODE_INVALID');
  for (const [key, code] of [
    ['SERVICE_VERSION', 'SERVICE_VERSION_MISSING'],
    ['API_ALLOWED_ORIGINS', 'API_ALLOWED_ORIGINS_MISSING'],
    ['DATABASE_API_CONNECTION_REF', 'DATABASE_API_CONNECTION_REF_MISSING'],
    ['DATABASE_API_ROLE', 'DATABASE_API_ROLE_MISSING'],
    ['SESSION_KEY_REF', 'SESSION_KEY_REF_MISSING'],
    ['IDENTITY_KEY_REF', 'IDENTITY_KEY_REF_MISSING'],
    ['KMS_ENDPOINT', 'KMS_ENDPOINT_MISSING'],
    ['OBJECT_STORE_ENDPOINT', 'OBJECT_STORE_ENDPOINT_MISSING'],
    ['SECRET_STORE_ENDPOINT', 'SECRET_STORE_ENDPOINT_MISSING'],
    ['NODE_MANIFEST_PATH', 'NODE_MANIFEST_PATH_MISSING'],
    ['NODE_MANIFEST_ID', 'NODE_MANIFEST_ID_MISSING'],
    ['NODE_RUNTIME_INSTANCE_ID', 'NODE_RUNTIME_INSTANCE_ID_MISSING'],
    ['NODE_RUNTIME_CONFIG_REF', 'NODE_RUNTIME_CONFIG_REF_MISSING'],
    ['NODE_RESOURCE_BINDING_VERSION', 'NODE_RESOURCE_BINDING_VERSION_MISSING'],
    ['NODE_RELEASE_POINTER_REF', 'NODE_RELEASE_POINTER_REF_MISSING'],
  ] as const) requiredValue(source[key], code);
  identityRegistrationWechatEnabled(source);
  if (!/^sha256:[0-9a-f]{64}$/.test(requiredValue(source.NODE_MANIFEST_DIGEST, 'NODE_MANIFEST_DIGEST_INVALID'))) {
    throw new Error('NODE_MANIFEST_DIGEST_INVALID');
  }
  if (source.API_BIND_HOST !== undefined && source.API_BIND_HOST !== '127.0.0.1') throw new Error('IDENTITY_REGISTRATION_API_BIND_HOST_INVALID');
  secureEndpoint(source.KMS_ENDPOINT, 'KMS_ENDPOINT_INVALID');
  secureEndpoint(source.OBJECT_STORE_ENDPOINT, 'OBJECT_STORE_ENDPOINT_INVALID');
  secureEndpoint(source.SECRET_STORE_ENDPOINT, 'SECRET_STORE_ENDPOINT_INVALID');
  bearerToken(source.OBJECT_STORE_BEARER_TOKEN, 'OBJECT_STORE_BEARER_TOKEN_INVALID');
  const kmsBearer = bearerToken(source.KMS_BEARER_TOKEN, 'KMS_BEARER_TOKEN_INVALID');
  const secretStoreBearer = bearerToken(source.SECRET_STORE_BEARER_TOKEN, 'SECRET_STORE_BEARER_TOKEN_INVALID');
  distinctValues(kmsBearer, secretStoreBearer, 'WORKLOAD_BEARER_TOKENS_MUST_DIFFER');
  apiAllowedOrigins(source);
  identityRegistrationApiPort(source);
}

export function identityRegistrationApiPort(environment: IdentityRegistrationApiEnvironment): number {
  return integerValue(environment.API_PORT, 4321, 1, 65_535, 'API_PORT_INVALID');
}

export function identityRegistrationApiAllowedOrigins(environment: IdentityRegistrationApiEnvironment): readonly string[] {
  return apiAllowedOrigins(environment);
}

export function identityRegistrationWechatEnabled(source: EnvironmentSource): boolean {
  const configured = [source.WECHAT_APPLICATION_CONFIG_REF, source.WECHAT_IDENTITY_CONFIG_REF]
    .filter((value) => value?.trim()).length;
  if (configured === 0) return false;
  if (configured !== 2) throw new Error('IDENTITY_WECHAT_CONFIGURATION_PARTIAL');
  return true;
}

function secureEndpoint(value: string | undefined, code: string): void {
  const endpoint = requiredValue(value, code);
  let parsed: URL;
  try { parsed = new URL(endpoint); } catch { throw new Error(code); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || parsed.search) throw new Error(code);
}
