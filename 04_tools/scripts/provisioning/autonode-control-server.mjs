import { createServer } from 'node:http';

export const AUTONODE_CONTROL_API_SCHEMA_VERSION = 'sfl.autonode-control-api.v1';

export function requireLoopbackControlHost(host) {
  if (host !== '127.0.0.1' && host !== '::1') throw new Error('AUTONODE_CONTROL_HOST_NOT_LOOPBACK');
  return host;
}

export function createAutoNodeControlServer(engine, archState) {
  if (!engine || typeof engine.submit !== 'function' || typeof engine.read !== 'function'
    || typeof engine.retry !== 'function' || typeof engine.list !== 'function') {
    throw new Error('AUTONODE_CONTROL_ENGINE_INVALID');
  }
  if (!archState || typeof archState.read !== 'function' || typeof archState.update !== 'function') {
    throw new Error('L_ARCH_STATE_PROVIDER_INVALID');
  }
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/health/ready') {
        send(response, 200, { schema_version: AUTONODE_CONTROL_API_SCHEMA_VERSION, status: 'READY' });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/arch') {
        const state = await archState.read();
        const nodeId = url.searchParams.get('node_id');
        const interfaceId = url.searchParams.get('interface_id');
        send(response, 200, nodeId === null && interfaceId === null ? state : {
          ...state,
          connections: state.connections.filter((connection) => (nodeId === null || connection.nodeId === nodeId)
            && (interfaceId === null || connection.interfaceId === interfaceId)),
        });
        return;
      }
      if (request.method === 'PUT' && url.pathname === '/v1/arch') {
        send(response, 200, await archState.update(await readBody(request)));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/tasks') {
        send(response, 202, await engine.submit(await readBody(request)));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/tasks') {
        send(response, 200, { items: await engine.list() });
        return;
      }
      const match = url.pathname.match(/^\/v1\/tasks\/([^/]+)$/);
      if (match && request.method === 'GET') {
        send(response, 200, await engine.read(decodeURIComponent(match[1])));
        return;
      }
      const retry = url.pathname.match(/^\/v1\/tasks\/([^/]+)\/retry$/);
      if (retry && request.method === 'POST') {
        send(response, 202, await engine.retry(decodeURIComponent(retry[1])));
        return;
      }
      send(response, 404, { code: 'AUTONODE_CONTROL_ROUTE_NOT_FOUND' });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      send(response, statusFor(message), { code: message });
    }
  });
}

async function readBody(request) {
  const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') throw new Error('AUTONODE_CONTROL_CONTENT_TYPE_INVALID');
  let body = '';
  for await (const chunk of request) {
    body += chunk.toString('utf8');
    if (Buffer.byteLength(body) > 1024 * 1024) throw new Error('AUTONODE_CONTROL_BODY_TOO_LARGE');
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new Error('AUTONODE_CONTROL_BODY_INVALID');
  }
}

function send(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(`${JSON.stringify(body)}\n`);
}

function statusFor(message) {
  if (message === 'AUTONODE_TASK_NOT_FOUND') return 404;
  if (message.includes('CONFLICT') || message === 'AUTONODE_TASK_NOT_RETRYABLE') return 409;
  if (message.includes('INVALID') || message.includes('REQUIRED') || message.includes('TOO_LARGE')) return 400;
  if (message === 'AUTONODE_TASK_BUSY') return 503;
  return 500;
}
