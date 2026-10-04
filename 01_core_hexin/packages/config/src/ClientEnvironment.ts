import { browserEnvironment, pickEnvironment, requiredValue, type EnvironmentSource } from './Environment';
import { IDENTITY_NODE_MANIFEST } from './IdentityNodeManifest';

export const CLIENT_ENVIRONMENT_KEYS = ['VITE_API_BASE_URL', 'VITE_AUTH_BASE_URL', 'VITE_CLIENT_VERSION'] as const;
export type { AuthTarget } from '@shop/l-kernel/login';

export interface ClientEnvironment {
  readonly apiBaseUrl: string;
  readonly authBaseUrl: string;
  readonly clientVersion: string;
}

export function clientEnvironment(source: EnvironmentSource = browserEnvironment()): ClientEnvironment {
  const values = pickEnvironment(source, CLIENT_ENVIRONMENT_KEYS);
  const apiBaseUrl = requiredValue(values.VITE_API_BASE_URL, 'CLIENT_API_BASE_URL_MISSING');
  const authBaseUrl = requiredValue(values.VITE_AUTH_BASE_URL, 'CLIENT_AUTH_BASE_URL_MISSING');
  const clientVersion = requiredValue(values.VITE_CLIENT_VERSION, 'CLIENT_VERSION_MISSING');
  if (source.APP_ENV === 'production' && !IDENTITY_NODE_MANIFEST.nodes.some((node) =>
    node.apiOrigin === apiBaseUrl.replace(/\/$/, '') && node.accountsOrigin === authBaseUrl.replace(/\/$/, ''))) {
    throw new Error('CLIENT_NODE_BINDING_INVALID');
  }
  if (!/^https:\/\//.test(apiBaseUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(apiBaseUrl)) throw new Error('CLIENT_API_BASE_URL_INVALID');
  if (!/^https:\/\//.test(authBaseUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(authBaseUrl)) throw new Error('CLIENT_AUTH_BASE_URL_INVALID');
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.]+)?$/i.test(clientVersion)) throw new Error('CLIENT_VERSION_INVALID');
  return Object.freeze({ apiBaseUrl: apiBaseUrl.replace(/\/$/, ''), authBaseUrl: authBaseUrl.replace(/\/$/, ''), clientVersion });
}
