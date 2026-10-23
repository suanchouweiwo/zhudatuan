import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const L_ARCH_STATE_VERSION = 'l-arch-state.v1';
export const DEFAULT_L_ARCH_STATE_PATH = '/var/lib/l-arch/state.json';

export class LArchStateFile {
  #queue = Promise.resolve();

  constructor(path = DEFAULT_L_ARCH_STATE_PATH) {
    if (typeof path !== 'string' || !path.startsWith('/')) throw new Error('L_ARCH_STATE_PATH_INVALID');
    this.path = path;
  }

  async read() {
    return await readDocument(this.path);
  }

  async update(input) {
    const pending = this.#queue.then(() => this.#update(input));
    this.#queue = pending.then(() => undefined, () => undefined);
    return await pending;
  }

  async #update(input) {
    const change = parseChange(input);
    const current = await readDocument(this.path);
    if (change.expected_revision !== current.revision) {
      throw new Error(`L_ARCH_REVISION_CONFLICT:${current.revision}`);
    }
    const connections = new Map(current.connections.map((connection) => [key(connection), connection]));
    const connectionKey = key(change);
    const existing = connections.get(connectionKey);
    if ((change.state === 'unmounted' && existing === undefined) || existing?.state === change.state) return current;
    if (change.state === 'unmounted') connections.delete(connectionKey);
    else connections.set(connectionKey, Object.freeze({
      nodeId: change.node_id,
      interfaceId: change.interface_id,
      state: change.state,
    }));
    const next = Object.freeze({
      schema_version: L_ARCH_STATE_VERSION,
      revision: current.revision + 1,
      updated_at: new Date().toISOString(),
      connections: Object.freeze([...connections.values()].sort(compareConnections)),
    });
    await writeDocument(this.path, next);
    return next;
  }
}

async function readDocument(path) {
  let source;
  try {
    source = await readFile(path, 'utf8');
  } catch (cause) {
    if (cause?.code === 'ENOENT') return emptyDocument();
    throw cause;
  }
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error('L_ARCH_STATE_INVALID');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('L_ARCH_STATE_INVALID');
  if (value.schema_version !== L_ARCH_STATE_VERSION) throw new Error('L_ARCH_STATE_VERSION_INVALID');
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) throw new Error('L_ARCH_STATE_REVISION_INVALID');
  if (typeof value.updated_at !== 'string' || Number.isNaN(Date.parse(value.updated_at))) throw new Error('L_ARCH_STATE_UPDATED_AT_INVALID');
  if (!Array.isArray(value.connections)) throw new Error('L_ARCH_STATE_CONNECTIONS_INVALID');
  const seen = new Set();
  const connections = value.connections.map((connection) => parseStoredConnection(connection, seen));
  return Object.freeze({
    schema_version: L_ARCH_STATE_VERSION,
    revision: value.revision,
    updated_at: value.updated_at,
    connections: Object.freeze(connections.sort(compareConnections)),
  });
}

function emptyDocument() {
  return Object.freeze({
    schema_version: L_ARCH_STATE_VERSION,
    revision: 0,
    updated_at: null,
    connections: Object.freeze([]),
  });
}

function parseChange(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('L_ARCH_CHANGE_INVALID');
  const node_id = identifier(value.node_id, 'L_ARCH_NODE_ID_INVALID');
  const interface_id = identifier(value.interface_id, 'L_ARCH_INTERFACE_ID_INVALID');
  if (!['connected', 'disconnected', 'removed', 'unmounted'].includes(value.state)) {
    throw new Error('L_ARCH_CONNECTION_STATE_INVALID');
  }
  if (!Object.hasOwn(value, 'expected_revision')) throw new Error('L_ARCH_EXPECTED_REVISION_REQUIRED');
  if (!Number.isSafeInteger(value.expected_revision) || value.expected_revision < 0) {
    throw new Error('L_ARCH_EXPECTED_REVISION_INVALID');
  }
  return Object.freeze({ node_id, interface_id, state: value.state, expected_revision: value.expected_revision });
}

function parseStoredConnection(value, seen) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('L_ARCH_CONNECTION_INVALID');
  const nodeId = identifier(value.nodeId, 'L_ARCH_NODE_ID_INVALID');
  const interfaceId = identifier(value.interfaceId, 'L_ARCH_INTERFACE_ID_INVALID');
  if (!['connected', 'disconnected', 'removed'].includes(value.state)) throw new Error('L_ARCH_CONNECTION_STATE_INVALID');
  const connection = Object.freeze({ nodeId, interfaceId, state: value.state });
  const connectionKey = key(connection);
  if (seen.has(connectionKey)) throw new Error('L_ARCH_CONNECTION_DUPLICATE');
  seen.add(connectionKey);
  return connection;
}

function identifier(value, code) {
  if (typeof value !== 'string' || value.trim() !== value || value.length < 1 || value.length > 240) throw new Error(code);
  return value;
}

function key(connection) {
  return JSON.stringify([
    connection.nodeId ?? connection.node_id,
    connection.interfaceId ?? connection.interface_id,
  ]);
}

function compareConnections(left, right) {
  return left.nodeId.localeCompare(right.nodeId) || left.interfaceId.localeCompare(right.interfaceId);
}

async function writeDocument(path, document) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o755 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(document)}\n`, { encoding: 'utf8', mode: 0o644, flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
