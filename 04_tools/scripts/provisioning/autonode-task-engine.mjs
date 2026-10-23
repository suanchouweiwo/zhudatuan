import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

export const AUTONODE_TASK_REQUEST_SCHEMA_VERSION = 'sfl.autonode-control-task-request.v1';
export const AUTONODE_TASK_RECEIPT_SCHEMA_VERSION = 'sfl.autonode-control-task-receipt.v1';

const RETRYABLE_STATUSES = new Set(['FAILED_RETRYABLE', 'WAITING_EXTERNAL']);
const RECOVERABLE_STATUSES = new Set(['QUEUED', 'RUNNING']);
const LOCK_WAIT_MS = 15_000;
const LOCK_STALE_MS = 60_000;

export function parseAutoNodeTaskRequest(value) {
  const record = requiredRecord(value, 'task request');
  if (record.schema_version !== AUTONODE_TASK_REQUEST_SCHEMA_VERSION) {
    throw new Error('AUTONODE_TASK_REQUEST_SCHEMA_INVALID');
  }
  if (!['ACTIVATE', 'DELETE', 'CREATE'].includes(record.action)) throw new Error('AUTONODE_TASK_ACTION_INVALID');
  const requestedBy = requiredRecord(record.requested_by, 'requested_by');
  const activationRequest = record.action === 'ACTIVATE' ? requiredRecord(record.activation_request, 'activation_request') : {};
  return Object.freeze({
    schema_version: AUTONODE_TASK_REQUEST_SCHEMA_VERSION,
    task_id: requiredText(record.task_id, 'task_id'),
    idempotency_key: requiredText(record.idempotency_key, 'idempotency_key'),
    action: record.action,
    node_id: requiredText(record.node_id, 'node_id'),
    requested_by: Object.freeze({
      actor_id: requiredText(requestedBy.actor_id, 'requested_by.actor_id'),
      membership_id: requiredText(requestedBy.membership_id, 'requested_by.membership_id'),
    }),
    activation_request: Object.freeze(structuredClone(activationRequest)),
  });
}

export class AutoNodeTaskEngine {
  #inFlight = new Map();
  #nodeQueues = new Map();

  constructor(stateRoot, executor) {
    this.root = stateRootPath(stateRoot);
    this.tasksRoot = join(this.root, 'tasks');
    this.idempotencyRoot = join(this.root, 'idempotency');
    if (!executor || typeof executor.plan !== 'function' || typeof executor.apply !== 'function') {
      throw new Error('AUTONODE_TASK_EXECUTOR_INVALID');
    }
    this.executor = executor;
  }

  async submit(input) {
    const request = parseAutoNodeTaskRequest(input);
    await this.#prepare();
    const requestDigest = digestJson(withoutIdempotencyKey(request));
    const idempotencyDigest = sha256(request.idempotency_key);
    let task;
    await withLock(this.root, 'registry', async () => {
      const idempotencyFile = join(this.idempotencyRoot, `${idempotencyDigest}.json`);
      const replay = await readJson(idempotencyFile);
      if (replay !== null) {
        if (replay.request_digest !== requestDigest) throw new Error('AUTONODE_TASK_IDEMPOTENCY_CONFLICT');
        task = await this.#readStored(replay.task_id);
        return;
      }

      const existing = await this.#readStored(request.task_id, false);
      if (existing !== null) {
        if (existing.request_digest !== requestDigest) throw new Error('AUTONODE_TASK_ID_CONFLICT');
        task = existing;
        return;
      }

      const now = new Date().toISOString();
      task = {
        schema_version: 'sfl.autonode-control-task-ledger.v1',
        request_digest: requestDigest,
        idempotency_digest: idempotencyDigest,
        request,
        receipt: {
          schema_version: AUTONODE_TASK_RECEIPT_SCHEMA_VERSION,
          task_id: request.task_id,
          action: request.action,
          node_id: request.node_id,
          status: 'QUEUED',
          phase: 'QUEUED',
          progress: 0,
          requested_by: request.requested_by,
          plan_digest: null,
          activation_status: null,
          waiting_external: [],
          last_error: null,
          platform: taskPlatform(request),
          result: null,
          events: [event('QUEUED', '平台创建任务已进入执行队列', now)],
          created_at: now,
          updated_at: now,
          started_at: null,
          finished_at: null,
        },
      };
      await writeJsonAtomic(this.#taskFile(request.task_id), task);
      await writeJsonAtomic(idempotencyFile, {
        schema_version: 'sfl.autonode-control-idempotency.v1',
        task_id: request.task_id,
        request_digest: requestDigest,
      });
    });
    if (RECOVERABLE_STATUSES.has(task.receipt.status)) this.#schedule(task.request.task_id, task.request.node_id);
    return publicReceipt(task);
  }

  async instances() {
    return await this.executor.instances();
  }

  async read(taskId) {
    await this.#prepare();
    return publicReceipt(await this.#readStored(requiredText(taskId, 'task_id')));
  }

  async list() {
    await this.#prepare();
    const files = (await readdir(this.tasksRoot)).filter((file) => file.endsWith('.json')).sort();
    const tasks = await Promise.all(files.map((file) => readJson(join(this.tasksRoot, file))));
    return tasks.filter((task) => task !== null).map(publicReceipt)
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  }

  async retry(taskId) {
    await this.#prepare();
    let task;
    await withLock(this.root, `task-${sha256(requiredText(taskId, 'task_id'))}`, async () => {
      task = await this.#readStored(taskId);
      if (!RETRYABLE_STATUSES.has(task.receipt.status)) throw new Error('AUTONODE_TASK_NOT_RETRYABLE');
      const now = new Date().toISOString();
      task = updateReceipt(task, {
        status: 'QUEUED',
        phase: 'QUEUED',
        progress: Math.min(task.receipt.progress, 25),
        waiting_external: [],
        last_error: null,
        result: null,
        finished_at: null,
        events: appendEvent(task.receipt.events, event('QUEUED', '任务已重新进入执行队列', now)),
        updated_at: now,
      });
      await writeJsonAtomic(this.#taskFile(taskId), task);
    });
    this.#schedule(task.request.task_id, task.request.node_id);
    return publicReceipt(task);
  }

  async recover() {
    const tasks = await this.list();
    let recovered = 0;
    for (const receipt of tasks) {
      if (!RECOVERABLE_STATUSES.has(receipt.status)) continue;
      if (receipt.status === 'RUNNING') {
        await this.#markRecovered(receipt.task_id);
      }
      const stored = await this.#readStored(receipt.task_id);
      this.#schedule(stored.request.task_id, stored.request.node_id);
      recovered += 1;
    }
    return recovered;
  }

  async waitForIdle() {
    await Promise.all([...this.#inFlight.values()]);
  }

  #schedule(taskId, nodeId) {
    if (this.#inFlight.has(taskId)) return;
    const previous = this.#nodeQueues.get(nodeId) ?? Promise.resolve();
    const running = previous.catch(() => undefined).then(() => this.#run(taskId));
    const tracked = running.finally(() => {
      this.#inFlight.delete(taskId);
      if (this.#nodeQueues.get(nodeId) === tracked) this.#nodeQueues.delete(nodeId);
    });
    this.#inFlight.set(taskId, tracked);
    this.#nodeQueues.set(nodeId, tracked);
  }

  async #run(taskId) {
    const lockName = `task-${sha256(taskId)}`;
    let task;
    await withLock(this.root, lockName, async () => {
      task = await this.#readStored(taskId);
      if (task.receipt.status !== 'QUEUED') return;
      const now = new Date().toISOString();
      task = updateReceipt(task, {
        status: 'RUNNING',
        phase: 'PLANNING',
        progress: 10,
        started_at: task.receipt.started_at ?? now,
        updated_at: now,
        events: appendEvent(task.receipt.events, event('PLANNING', '正在生成独立节点计划', now)),
      });
      await writeJsonAtomic(this.#taskFile(taskId), task);
    });
    if (task?.receipt.status !== 'RUNNING') return;

    try {
      if (task.request.action !== 'ACTIVATE') {
        const result = await this.executor.lifecycle(task.request, async (phase, progress, message) => {
          await this.#progress(taskId, { phase, progress, message });
        });
        await this.#complete(taskId, {
          status: 'SUCCEEDED', phase: 'SUCCEEDED', progress: 100,
          activation_status: task.request.action === 'DELETE' ? 'DELETED' : 'ACTIVE',
          waiting_external: [], result, last_error: null,
          message: task.request.action === 'DELETE' ? '实例资源已删除' : '空库商城已生成',
        });
        return;
      }
      const planned = normalizePlanResult(await this.executor.plan(task.request.activation_request));
      if (planned.waiting_external.length > 0) {
        await this.#complete(taskId, {
          status: 'WAITING_EXTERNAL',
          phase: 'WAITING_EXTERNAL',
          progress: 25,
          plan_digest: planned.plan_digest,
          activation_status: 'WAITING_EXTERNAL',
          waiting_external: planned.waiting_external,
          message: '节点计划已生成，正在等待外部资源就绪',
        });
        return;
      }
      await this.#progress(taskId, {
        phase: 'ACTIVATING',
        progress: 35,
        plan_digest: planned.plan_digest,
        message: '节点计划已确认，正在执行首次激活',
      });
      const activated = normalizeActivationResult(
        await this.executor.apply(task.request.activation_request, planned.plan_digest),
      );
      if (activated.status === 'ACTIVE') {
        await this.#complete(taskId, {
          status: 'SUCCEEDED',
          phase: 'ACTIVE',
          progress: 100,
          plan_digest: planned.plan_digest,
          activation_status: activated.status,
          waiting_external: [],
          result: activated.result,
          message: '独立平台已经完成首次激活',
        });
        return;
      }
      if (activated.status === 'WAITING_EXTERNAL') {
        await this.#complete(taskId, {
          status: 'WAITING_EXTERNAL',
          phase: 'WAITING_EXTERNAL',
          progress: 60,
          plan_digest: planned.plan_digest,
          activation_status: activated.status,
          waiting_external: activated.waiting_external,
          result: null,
          message: '激活已暂停，正在等待外部资源就绪',
        });
        return;
      }
      throw new Error(`AUTONODE_ACTIVATION_NOT_ACTIVE:${activated.status}`);
    } catch (cause) {
      await this.#fail(taskId, cause);
    }
  }

  async #progress(taskId, change) {
    await withLock(this.root, `task-${sha256(taskId)}`, async () => {
      const task = await this.#readStored(taskId);
      const now = new Date().toISOString();
      await writeJsonAtomic(this.#taskFile(taskId), updateReceipt(task, {
        ...change,
        updated_at: now,
        events: appendEvent(task.receipt.events, event(change.phase, change.message, now)),
      }));
    });
  }

  async #complete(taskId, change) {
    await withLock(this.root, `task-${sha256(taskId)}`, async () => {
      const task = await this.#readStored(taskId);
      const now = new Date().toISOString();
      await writeJsonAtomic(this.#taskFile(taskId), updateReceipt(task, {
        ...change,
        last_error: null,
        updated_at: now,
        finished_at: change.status === 'SUCCEEDED' ? now : null,
        events: appendEvent(task.receipt.events, event(change.phase, change.message, now)),
      }));
    });
  }

  async #fail(taskId, cause) {
    await withLock(this.root, `task-${sha256(taskId)}`, async () => {
      const task = await this.#readStored(taskId);
      const now = new Date().toISOString();
      const message = cause instanceof Error ? cause.message : String(cause);
      await writeJsonAtomic(this.#taskFile(taskId), updateReceipt(task, {
        status: 'FAILED_RETRYABLE',
        phase: 'FAILED',
        activation_status: 'FAILED_RETRYABLE',
        last_error: { message, recorded_at: now },
        result: null,
        updated_at: now,
        finished_at: now,
        events: appendEvent(task.receipt.events, event('FAILED', message, now)),
      }));
    });
  }

  async #markRecovered(taskId) {
    await withLock(this.root, `task-${sha256(taskId)}`, async () => {
      const task = await this.#readStored(taskId);
      if (task.receipt.status !== 'RUNNING') return;
      const now = new Date().toISOString();
      await writeJsonAtomic(this.#taskFile(taskId), updateReceipt(task, {
        status: 'QUEUED',
        phase: 'QUEUED',
        updated_at: now,
        events: appendEvent(task.receipt.events, event('QUEUED', '控制器重启，任务从持久化进度恢复', now)),
      }));
    });
  }

  async #prepare() {
    await mkdir(this.tasksRoot, { recursive: true });
    await mkdir(this.idempotencyRoot, { recursive: true });
  }

  #taskFile(taskId) {
    return join(this.tasksRoot, `${sha256(requiredText(taskId, 'task_id'))}.json`);
  }

  async #readStored(taskId, required = true) {
    const task = await readJson(this.#taskFile(taskId));
    if (task === null && required) throw new Error('AUTONODE_TASK_NOT_FOUND');
    if (task !== null && task.request?.task_id !== taskId) throw new Error('AUTONODE_TASK_LEDGER_INVALID');
    return task;
  }
}

function normalizePlanResult(value) {
  const result = requiredRecord(value, 'plan result');
  const plan = requiredRecord(result.plan, 'plan result.plan');
  const waiting = result.waiting_external ?? [];
  if (!Array.isArray(waiting) || waiting.some((item) => typeof item !== 'string')) {
    throw new Error('AUTONODE_TASK_WAITING_EXTERNAL_INVALID');
  }
  return Object.freeze({
    plan_digest: requiredText(plan.plan_digest, 'plan.plan_digest'),
    waiting_external: Object.freeze([...new Set(waiting)].sort()),
  });
}

function normalizeActivationResult(value) {
  const result = requiredRecord(value, 'activation result');
  const status = requiredText(result.status, 'activation result.status');
  const waiting = result.waiting_external ?? [];
  if (!Array.isArray(waiting) || waiting.some((item) => typeof item !== 'string')) {
    throw new Error('AUTONODE_TASK_WAITING_EXTERNAL_INVALID');
  }
  return Object.freeze({
    status,
    waiting_external: Object.freeze([...new Set(waiting)].sort()),
    result: status === 'ACTIVE' ? activationTaskResult(result) : null,
  });
}

function updateReceipt(task, change) {
  return { ...task, receipt: { ...task.receipt, ...change } };
}

function publicReceipt(task) {
  const receipt = structuredClone(task.receipt);
  return Object.freeze({
    ...receipt,
    platform: normalizeTaskPlatform(receipt.platform, task.request),
    result: receipt.status === 'SUCCEEDED'
      ? normalizeTaskResult(receipt.result) ?? successfulTaskResult(task.request)
      : null,
  });
}

function taskPlatform(request) {
  const business = taskBusiness(request);
  const fallbackMall = request.task_id.startsWith('task:') ? request.task_id.slice('task:'.length) : null;
  return Object.freeze({
    mall_id: optionalText(business?.mall_id) ?? optionalText(business?.scope_id) ?? optionalText(fallbackMall),
    application_id: optionalText(business?.application_id),
    name: optionalText(business?.name),
    public_slug: optionalText(business?.public_slug),
  });
}

function normalizeTaskPlatform(value, request) {
  if (value === undefined || value === null) return taskPlatform(request);
  const platform = requiredRecord(value, 'task receipt platform');
  return Object.freeze({
    mall_id: optionalText(platform.mall_id),
    application_id: optionalText(platform.application_id),
    name: optionalText(platform.name),
    public_slug: optionalText(platform.public_slug),
  });
}

function activationTaskResult(value) {
  const direct = normalizeTaskResult(value.result);
  if (direct !== null) return direct;
  const candidate = optionalRecord(value.candidate);
  const manifest = optionalRecord(candidate?.manifest);
  if (manifest === null) return null;
  return Object.freeze({
    manifest_id: optionalText(manifest?.manifest_id),
    access_entries: manifestAccessEntries(manifest),
  });
}

function successfulTaskResult(request) {
  const provisioning = taskProvisioningRequest(request);
  const domains = optionalRecord(provisioning?.domains);
  const entries = domains === null ? [] : Object.entries(domains).flatMap(([surface, host]) => {
    const value = optionalText(host);
    return value === null ? [] : [{ surface_ref: `surface:${surface}`, url: `https://${value}` }];
  });
  return Object.freeze({ manifest_id: null, access_entries: Object.freeze(entries) });
}

function normalizeTaskResult(value) {
  if (value === undefined || value === null) return null;
  const result = requiredRecord(value, 'task receipt result');
  const entries = result.access_entries;
  if (!Array.isArray(entries)) throw new Error('AUTONODE_TASK_RESULT_ACCESS_ENTRIES_INVALID');
  return Object.freeze({
    manifest_id: optionalText(result.manifest_id),
    access_entries: Object.freeze(entries.map((entry) => {
      const record = requiredRecord(entry, 'task receipt access entry');
      return Object.freeze({
        surface_ref: requiredText(record.surface_ref, 'task receipt access entry surface_ref'),
        url: requiredHttpsUrl(record.url, 'task receipt access entry url'),
      });
    })),
  });
}

function manifestAccessEntries(manifest) {
  if (manifest === null) return Object.freeze([]);
  const bindings = manifest.domain_bindings;
  if (!Array.isArray(bindings)) return Object.freeze([]);
  return Object.freeze(bindings.flatMap((binding) => {
    const record = optionalRecord(binding);
    const surface = optionalText(record?.surface_ref);
    const host = optionalText(record?.host);
    return surface === null || host === null ? [] : [{ surface_ref: surface, url: `https://${host}` }];
  }));
}

function taskBusiness(request) {
  const provisioning = taskProvisioningRequest(request);
  return optionalRecord(provisioning?.business);
}

function taskProvisioningRequest(request) {
  const activation = optionalRecord(request.activation_request);
  return optionalRecord(activation?.provisioning_request);
}

function optionalRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function optionalText(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function requiredHttpsUrl(value, name) {
  const url = requiredText(value, name);
  if (!url.startsWith('https://')) throw new Error(`AUTONODE_TASK_FIELD_INVALID:${name}`);
  return url;
}

function event(phase, message, occurredAt) {
  return Object.freeze({ phase, message, occurred_at: occurredAt });
}

function appendEvent(events, next) {
  return [...events, next].slice(-100);
}

function withoutIdempotencyKey(request) {
  const { idempotency_key: _idempotencyKey, ...safe } = request;
  return safe;
}

function stateRootPath(value) {
  const target = requiredText(value, 'task state root');
  if (!isAbsolute(target)) throw new Error('AUTONODE_TASK_STATE_ROOT_ABSOLUTE_REQUIRED');
  const path = resolve(target);
  if (path === sep || path === '/etc' || path.startsWith('/etc/') || path === '/opt' || path === '/opt/sfl') {
    throw new Error('AUTONODE_TASK_STATE_ROOT_FORBIDDEN');
  }
  return path;
}

async function withLock(root, name, action) {
  const lock = join(root, 'locks', `${name}.lock`);
  await mkdir(dirname(lock), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    try {
      await mkdir(lock);
      break;
    } catch (cause) {
      if (cause?.code !== 'EEXIST') throw cause;
      const information = await stat(lock).catch((statCause) => statCause?.code === 'ENOENT' ? null : Promise.reject(statCause));
      if (information === null) continue;
      if (Date.now() - information.mtimeMs > LOCK_STALE_MS) {
        await rm(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error('AUTONODE_TASK_BUSY');
      await new Promise((settle) => setTimeout(settle, 25));
    }
  }
  try {
    return await action();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

async function writeJsonAtomic(file, value) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, file);
}

async function readJson(file) {
  const source = await readFile(file, 'utf8').catch((cause) => {
    if (cause?.code === 'ENOENT') return null;
    throw cause;
  });
  return source === null ? null : JSON.parse(source);
}

function requiredRecord(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`AUTONODE_TASK_FIELD_INVALID:${name}`);
  return value;
}

function requiredText(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`AUTONODE_TASK_FIELD_INVALID:${name}`);
  return value.trim();
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function digestJson(value) {
  return `sha256:${sha256(canonicalJson(value))}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
