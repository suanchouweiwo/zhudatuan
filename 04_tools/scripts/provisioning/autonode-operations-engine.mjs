import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

export const AUTONODE_OPERATION_REQUEST_SCHEMA_VERSION = 'sfl.autonode-operation-request.v1';
export const AUTONODE_OPERATION_RECEIPT_SCHEMA_VERSION = 'sfl.autonode-operation-receipt.v1';
export const AUTONODE_OPERATION_TYPES = Object.freeze([
  'STATUS',
  'PAUSE',
  'RESUME',
  'UPGRADE',
  'ROLLBACK',
  'LOGS',
  'DELETE',
]);

const MUTATING_ACTIONS = new Set(['PAUSE', 'RESUME', 'UPGRADE', 'ROLLBACK', 'DELETE']);
const LOCK_WAIT_MS = 10_000;
const LOCK_STALE_MS = 30_000;

export function parseNodeOperationRequest(value) {
  const request = requiredRecord(value, 'operation request');
  if (request.schema_version !== AUTONODE_OPERATION_REQUEST_SCHEMA_VERSION) {
    throw new Error('AUTONODE_OPERATION_REQUEST_SCHEMA_INVALID');
  }
  const target = requiredRecord(request.target, 'operation target');
  const requestedBy = requiredRecord(request.requested_by, 'operation requester');
  const action = requiredRecord(request.action, 'operation action');
  const type = requiredText(action.type, 'operation action type').toUpperCase();
  if (!AUTONODE_OPERATION_TYPES.includes(type)) throw new Error(`AUTONODE_OPERATION_TYPE_INVALID:${type}`);
  const normalized = {
    schema_version: AUTONODE_OPERATION_REQUEST_SCHEMA_VERSION,
    operation_request_id: requiredText(request.operation_request_id, 'operation request id'),
    idempotency_key: requiredText(request.idempotency_key, 'operation idempotency key'),
    requested_at: timestamp(request.requested_at, 'operation requested at'),
    requested_by: Object.freeze({
      actor_id: requiredText(requestedBy.actor_id, 'operation actor id'),
      membership_id: requiredText(requestedBy.membership_id, 'operation membership id'),
      authorized_operation: requiredText(requestedBy.authorized_operation, 'authorized operation'),
    }),
    target: Object.freeze({
      node_id: requiredText(target.node_id, 'operation node id'),
      node_directory: absolutePath(target.node_directory, 'operation node directory'),
      environment: environmentName(target.environment),
      runtime_profile_ref: absolutePath(target.runtime_profile_ref, 'runtime profile ref'),
    }),
    action: Object.freeze({
      type,
      ...(action.reason === undefined ? {} : { reason: requiredText(action.reason, 'operation reason') }),
      ...(type === 'UPGRADE' ? { release: releaseEvidence(action.release) } : {}),
      ...(type === 'LOGS' ? { line_count: boundedInteger(action.line_count ?? 100, 1, 500, 'operation log line count') } : {}),
    }),
  };
  return Object.freeze(normalized);
}

export class NodeOperationsEngine {
  constructor(stateRoot, provider) {
    this.root = stateRootPath(stateRoot);
    if (provider === null || typeof provider !== 'object') throw new Error('AUTONODE_OPERATION_PROVIDER_REQUIRED');
    this.provider = provider;
  }

  async execute(input) {
    const request = parseNodeOperationRequest(input);
    await this.#prepare();
    const requestDigest = digestJson(request);
    const receiptFile = this.#receiptFile(request);
    return await withLock(this.root, request.target.node_id, async () => {
      const previous = await readJson(receiptFile);
      if (previous?.request_digest !== undefined && previous.request_digest !== requestDigest) {
        throw new Error(`AUTONODE_OPERATION_REPLAY_CONFLICT:${request.operation_request_id}`);
      }
      if (previous?.status === 'SUCCEEDED') return Object.freeze({ ...previous, replayed: true });

      const startedAt = new Date().toISOString();
      const running = {
        schema_version: AUTONODE_OPERATION_RECEIPT_SCHEMA_VERSION,
        operation_request_id: request.operation_request_id,
        idempotency_digest: digestText(request.idempotency_key),
        request_digest: requestDigest,
        node_id: request.target.node_id,
        action: request.action.type,
        status: 'RUNNING',
        attempt: (previous?.attempt ?? 0) + 1,
        requested_at: request.requested_at,
        started_at: startedAt,
        completed_at: null,
        replayed: false,
        result: null,
        error: null,
      };
      await writeJsonAtomic(receiptFile, running);
      try {
        const result = await this.#dispatch(request);
        const receipt = Object.freeze({
          ...running,
          status: 'SUCCEEDED',
          completed_at: new Date().toISOString(),
          result,
        });
        await writeJsonAtomic(receiptFile, receipt);
        return receipt;
      } catch (cause) {
        await writeJsonAtomic(receiptFile, {
          ...running,
          status: 'FAILED_RETRYABLE',
          completed_at: new Date().toISOString(),
          error: errorMessage(cause),
        });
        throw cause;
      }
    });
  }

  async read(input) {
    const request = parseNodeOperationRequest(input);
    await this.#prepare();
    const receipt = await readJson(this.#receiptFile(request));
    if (receipt === null) return null;
    if (receipt.request_digest !== digestJson(request)) {
      throw new Error(`AUTONODE_OPERATION_REPLAY_CONFLICT:${request.operation_request_id}`);
    }
    return Object.freeze({ ...receipt });
  }

  async #dispatch(request) {
    const method = request.action.type.toLowerCase();
    if (typeof this.provider[method] !== 'function') {
      throw new Error(`AUTONODE_OPERATION_PROVIDER_METHOD_MISSING:${method}`);
    }
    return await this.provider[method](request);
  }

  async #prepare() {
    await mkdir(join(this.root, 'receipts'), { recursive: true });
    await mkdir(join(this.root, 'locks'), { recursive: true });
  }

  #receiptFile(request) {
    return join(this.root, 'receipts', `${digestText(request.idempotency_key)}.json`);
  }
}

export function isMutatingNodeOperation(type) {
  return MUTATING_ACTIONS.has(type);
}

function releaseEvidence(value) {
  const release = requiredRecord(value, 'operation release');
  const sourceSha = requiredText(release.source_sha, 'release source sha');
  if (!/^[a-f0-9]{40}$/u.test(sourceSha)) throw new Error('AUTONODE_OPERATION_SOURCE_SHA_INVALID');
  const digest = requiredText(release.immutable_artifact_digest, 'release artifact digest');
  if (!/^sha256:[a-f0-9]{64}$/u.test(digest)) throw new Error('AUTONODE_OPERATION_ARTIFACT_DIGEST_INVALID');
  if (release.build_count !== 1) throw new Error('AUTONODE_OPERATION_BUILD_COUNT_INVALID');
  return Object.freeze({
    release_directory: absolutePath(release.release_directory, 'release directory'),
    source_sha: sourceSha,
    build_id: requiredText(release.build_id, 'release build id'),
    build_count: 1,
    immutable_artifact_digest: digest,
  });
}

async function withLock(root, nodeId, callback) {
  const lock = join(root, 'locks', digestText(nodeId));
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (cause) {
      if (cause?.code !== 'EEXIST') throw cause;
      const marker = await readJson(join(lock, 'owner.json'));
      const createdAt = marker?.created_at === undefined ? Number.NaN : Date.parse(marker.created_at);
      if (Number.isFinite(createdAt) && Date.now() - createdAt > LOCK_STALE_MS) {
        await rm(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`AUTONODE_OPERATION_LOCK_TIMEOUT:${nodeId}`);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
  }
  try {
    await writeJsonAtomic(join(lock, 'owner.json'), { created_at: new Date().toISOString() });
    return await callback();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (cause) {
    if (cause?.code === 'ENOENT') return null;
    throw cause;
  }
}

async function writeJsonAtomic(file, value) {
  await mkdir(dirname(file), { recursive: true });
  const next = `${file}.next-${process.pid}`;
  await writeFile(next, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o640 });
  await rename(next, file);
}

function digestJson(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function digestText(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function stateRootPath(value) {
  const path = absolutePath(value, 'operation state root');
  if ([sep, '/etc', '/opt', '/opt/sfl', '/opt/sfl/nodes'].includes(path)) {
    throw new Error('AUTONODE_OPERATION_STATE_ROOT_FORBIDDEN');
  }
  return path;
}

function absolutePath(value, name) {
  const path = requiredText(value, name);
  if (!isAbsolute(path)) throw new Error(`AUTONODE_OPERATION_ABSOLUTE_PATH_REQUIRED:${name}`);
  return resolve(path);
}

function environmentName(value) {
  const environment = requiredText(value, 'operation environment');
  if (!['production', 'staging'].includes(environment)) throw new Error('AUTONODE_OPERATION_ENVIRONMENT_INVALID');
  return environment;
}

function boundedInteger(value, minimum, maximum, name) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`AUTONODE_OPERATION_INTEGER_INVALID:${name}`);
  }
  return value;
}

function timestamp(value, name) {
  const text = requiredText(value, name);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`AUTONODE_OPERATION_TIMESTAMP_INVALID:${name}`);
  return new Date(text).toISOString();
}

function requiredText(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`AUTONODE_OPERATION_TEXT_REQUIRED:${name}`);
  return value.trim();
}

function requiredRecord(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`AUTONODE_OPERATION_RECORD_REQUIRED:${name}`);
  }
  return value;
}

function errorMessage(cause) {
  return cause instanceof Error ? cause.message : String(cause);
}
