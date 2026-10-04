import { hbbtznH5Application, storefrontIdentityNodeRegistry } from './storefrontIdentity';
const H5_DOCUMENT_PATH = '/h5';

function isStaticAssetPath(pathname: string): boolean {
  return pathname.startsWith('/assets/')
    || pathname.startsWith('/_next/')
    || /\.[a-z0-9]+$/i.test(pathname);
}

export function resolveH5RuntimeRequest(request: Request): Request {
  const target = new URL(request.url);
  const h5StorefrontHosts = new Set(storefrontIdentityNodeRegistry().nodes
    .flatMap((node) => node.storefrontHosts.filter((host) => host.startsWith('h5.'))));
  if ((!h5StorefrontHosts.has(target.hostname) && hbbtznH5Application(target.hostname) === undefined)
    || (request.method !== 'GET' && request.method !== 'HEAD')
    || target.pathname === '/api'
    || target.pathname.startsWith('/api/')
    || isStaticAssetPath(target.pathname)) return request;

  if (target.pathname === H5_DOCUMENT_PATH) return request;
  target.pathname = H5_DOCUMENT_PATH;
  return new Request(target, request);
}
