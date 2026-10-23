import { parseArgs } from 'node:util';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { url: { type: 'string', default: 'http://127.0.0.1:4370' } },
  strict: true,
});

const command = positionals[0]?.toUpperCase();
const base = controlUrl(values.url);
if (command === 'LIST') {
  if (positionals.length > 3) throw new Error('L_ARCH_CONTROL_USAGE_INVALID');
  const url = new URL('/v1/arch', base);
  if (positionals[1]) url.searchParams.set('node_id', positionals[1]);
  if (positionals[2]) url.searchParams.set('interface_id', positionals[2]);
  process.stdout.write(`${JSON.stringify(await request(url), null, 2)}\n`);
} else if (command === 'SET') {
  if (positionals.length !== 4) throw new Error('L_ARCH_CONTROL_USAGE_INVALID');
  const [, nodeId, interfaceId, state] = positionals;
  if (!['connected', 'disconnected', 'removed', 'unmounted'].includes(state)) {
    throw new Error('L_ARCH_CONTROL_STATE_INVALID');
  }
  const url = new URL('/v1/arch', base);
  const current = await request(url);
  const next = await request(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      node_id: nodeId,
      interface_id: interfaceId,
      state,
      expected_revision: current.revision,
    }),
  });
  const connection = next.connections.find((candidate) => candidate.nodeId === nodeId
    && candidate.interfaceId === interfaceId);
  process.stdout.write(`${JSON.stringify({
    schema_version: next.schema_version,
    revision: next.revision,
    node_id: nodeId,
    interface_id: interfaceId,
    state: connection?.state ?? 'unmounted',
  }, null, 2)}\n`);
} else {
  throw new Error('L_ARCH_CONTROL_USAGE_INVALID');
}

function controlUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || (url.hostname !== '127.0.0.1' && url.hostname !== '[::1]' && url.hostname !== '::1')) {
    throw new Error('L_ARCH_CONTROL_URL_NOT_LOOPBACK');
  }
  return url;
}

async function request(url, init) {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({ code: 'L_ARCH_CONTROL_RESPONSE_INVALID' }));
  if (!response.ok) throw new Error(`${body.code ?? 'L_ARCH_CONTROL_REQUEST_FAILED'}:${response.status}`);
  return body;
}
