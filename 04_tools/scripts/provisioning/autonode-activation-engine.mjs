import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

import {
  FileNodeProvisioningEngine,
  parseNodeProvisioningRequest,
} from './autonode-engine.mjs';
import { isZhudatuanL0Opening, zhudatuanOpeningSecretUnit } from './autonode-zhudatuan-opening.mjs';

export const AUTONODE_ACTIVATION_REQUEST_SCHEMA_VERSION = 'sfl.autonode-activation-request.v1';
export const AUTONODE_ACTIVATION_LEDGER_SCHEMA_VERSION = 'sfl.autonode-activation-ledger.v1';
export const AUTONODE_ACTIVATION_PLAN_SCHEMA_VERSION = 'sfl.autonode-activation-plan.v1';
export const AUTONODE_ACTIVATION_STEPS = Object.freeze([
  'FILES_MATERIALIZED',
  'RELEASE_BOUND',
  'RUNTIME_CONFIGURED',
  'IDENTITY_BOUND',
  'TLS_BOUND',
  'TUNNEL_BOUND',
  'DNS_BOUND',
  'SYSTEMD_READY',
  'PROCESSES_READY',
  'HEALTH_VERIFIED',
  'ACTIVE',
]);

const LOCK_WAIT_MS = 15_000;
const LOCK_STALE_MS = 60_000;

export function parseNodeActivationRequest(value) {
  return normalizeActivationRequest(value);
}

export function nodeActivationTunnelName(request, manifest) {
  const signedLevel = manifest?.signed_level ?? request.provisioning_request.signed_level;
  if (typeof signedLevel !== 'string') throw new Error('AUTONODE_ACTIVATION_LEVEL_UNRESOLVED');
  const instance = `${request.provisioning_request.node_slug}-${signedLevel.toLowerCase()}`;
  return `${instance.slice(0, 52)}-${sha256(request.activation_request_id).slice(0, 10)}`;
}

/**
 * Persistent bridge from the candidate engine to real providers. The provider is
 * injected so the same ledger can drive local acceptance and the production host.
 */
export class NodeActivationEngine {
  constructor(stateRoot, provider) {
    this.root = stateRootPath(stateRoot);
    this.activationRoot = join(this.root, 'activation');
    this.candidateRoot = join(this.root, 'candidate');
    this.provider = requiredProvider(provider);
  }

  async plan(input) {
    const request = normalizeActivationRequest(input);
    await this.#prepare();
    const candidate = await new FileNodeProvisioningEngine(this.candidateRoot, {
      allocateSecretStorePort: isZhudatuanL0Opening(request),
    })
      .provision(request.provisioning_request);
    const identity = activationIdentity(request);
    return await withLock(this.activationRoot, 'engine', async () => {
      const ledgerFile = this.#ledgerFile(identity);
      let ledger = await readJson(ledgerFile);
      if (ledger !== null) {
        assertReplayMatches(ledger, request, identity);
        return await this.#result(ledger, candidate);
      }

      const plan = await activationPlan(request, candidate);
      const planRef = `activation/plans/${identity.idempotencyDigest}.json`;
      await writeJsonAtomic(join(this.root, planRef), plan);
      const now = new Date().toISOString();
      ledger = {
        schema_version: AUTONODE_ACTIVATION_LEDGER_SCHEMA_VERSION,
        activation_request_id: request.activation_request_id,
        idempotency_digest: identity.idempotencyDigest,
        request_digest: identity.requestDigest,
        request: withoutIdempotencyKey(request),
        plan_ref: planRef,
        plan_digest: plan.plan_digest,
        node_id: candidate.manifest.node_id,
        state: 'PLANNED',
        status: 'PLANNED',
        generation: 1,
        attempts: {},
        step_receipts: [],
        rollback_receipts: [],
        completed_cycles: [],
        in_flight: null,
        waiting_external: [],
        last_error: null,
        created_at: now,
        updated_at: now,
      };
      await writeJsonAtomic(ledgerFile, ledger);
      return await this.#result(ledger, candidate);
    });
  }

  async apply(input, approvedPlanDigest, options = {}) {
    const request = normalizeActivationRequest(input);
    const planned = await this.plan(request);
    if (requiredText(approvedPlanDigest, 'approved plan digest') !== planned.plan.plan_digest) {
      throw new Error('AUTONODE_ACTIVATION_PLAN_NOT_APPROVED');
    }
    const identity = activationIdentity(request);
    return await withLock(this.activationRoot, 'engine', async () => {
      const ledgerFile = this.#ledgerFile(identity);
      let ledger = await readRequiredJson(ledgerFile);
      assertReplayMatches(ledger, request, identity);
      if (ledger.status === 'ROLLED_BACK') throw new Error('AUTONODE_ACTIVATION_ROLLED_BACK');
      if (ledger.status === 'ACTIVE') return await this.#result(ledger, planned.candidate);

      const context = Object.freeze({ request, plan: planned.plan, candidate: planned.candidate });
      const waiting = await this.provider.preflight(context);
      if (!Array.isArray(waiting)) throw new Error('AUTONODE_PROVIDER_PREFLIGHT_INVALID');
      if (waiting.length > 0) {
        ledger = {
          ...ledger,
          status: 'WAITING_EXTERNAL',
          waiting_external: [...new Set(waiting.map((item) => requiredText(item, 'waiting external')))].sort(),
          updated_at: new Date().toISOString(),
        };
        await writeJsonAtomic(ledgerFile, ledger);
        return await this.#result(ledger, planned.candidate);
      }

      for (const step of AUTONODE_ACTIVATION_STEPS.slice(activationStepIndex(ledger.state) + 1)) {
        const invocationId = activationInvocation(identity, ledger.generation, step);
        ledger = startAttempt(ledger, step, invocationId);
        await writeJsonAtomic(ledgerFile, ledger);
        let providerReceipt;
        try {
          providerReceipt = normalizeProviderReceipt(
            await this.provider.apply(step, context, invocationId),
            step,
            invocationId,
          );
          await options.afterProvider?.(step, structuredClone(providerReceipt));
        } catch (cause) {
          ledger = recordFailure(ledger, step, cause);
          await writeJsonAtomic(ledgerFile, ledger);
          throw cause;
        }
        ledger = completeStep(ledger, step, providerReceipt);
        await writeJsonAtomic(ledgerFile, ledger);
        await options.afterStep?.(step, structuredClone(ledger));
      }
      return await this.#result(ledger, planned.candidate);
    });
  }

  async rollback(input, reason = 'node activation rollback') {
    const request = normalizeActivationRequest(input);
    const planned = await this.plan(request);
    const identity = activationIdentity(request);
    return await withLock(this.activationRoot, 'engine', async () => {
      const ledgerFile = this.#ledgerFile(identity);
      let ledger = await readRequiredJson(ledgerFile);
      assertReplayMatches(ledger, request, identity);
      if (ledger.status === 'ROLLED_BACK') return await this.#result(ledger, planned.candidate);
      const context = Object.freeze({ request, plan: planned.plan, candidate: planned.candidate });
      const compensations = [];
      if (ledger.in_flight !== null
        && !ledger.step_receipts.some(({ invocation_id: invocationId }) => invocationId === ledger.in_flight.invocation_id)) {
        if (typeof this.provider.rollbackInterrupted !== 'function') {
          throw new Error(`AUTONODE_PROVIDER_INTERRUPTED_ROLLBACK_UNSUPPORTED:${ledger.in_flight.step}`);
        }
        const invocationId = `${ledger.in_flight.invocation_id}:rollback`;
        const recovered = normalizeRollbackReceipt(
          await this.provider.rollbackInterrupted(
            ledger.in_flight.step,
            context,
            ledger.in_flight.invocation_id,
            invocationId,
          ),
          ledger.in_flight.step,
          invocationId,
        );
        compensations.push(recovered);
        ledger = { ...ledger, in_flight: null, updated_at: new Date().toISOString() };
        await writeJsonAtomic(ledgerFile, ledger);
      }
      for (const applied of [...ledger.step_receipts].reverse()) {
        const invocationId = `${applied.invocation_id}:rollback`;
        const receipt = normalizeRollbackReceipt(
          await this.provider.rollback(applied.step, context, applied.provider_receipt, invocationId),
          applied.step,
          invocationId,
        );
        compensations.push(receipt);
      }
      const now = new Date().toISOString();
      const rollback = {
        schema_version: 'sfl.autonode-activation-rollback-receipt.v1',
        activation_request_id: request.activation_request_id,
        node_id: ledger.node_id,
        generation: ledger.generation,
        reason: requiredText(reason, 'rollback reason'),
        plan_digest: ledger.plan_digest,
        source_sha: request.provisioning_request.artifact.source_sha,
        immutable_artifact_digest: request.provisioning_request.artifact.immutable_artifact_digest,
        compensations,
        rolled_back_at: now,
      };
      const rollbackRef = `activation/receipts/${identity.idempotencyDigest}-g${ledger.generation}-rollback.json`;
      await writeJsonAtomic(join(this.root, rollbackRef), rollback);
      ledger = {
        ...ledger,
        status: 'ROLLED_BACK',
        rollback_receipts: [...ledger.rollback_receipts, rollbackRef],
        in_flight: null,
        waiting_external: [],
        last_error: null,
        updated_at: now,
      };
      await writeJsonAtomic(ledgerFile, ledger);
      return await this.#result(ledger, planned.candidate);
    });
  }

  async restore(input, approvedPlanDigest, options = {}) {
    const request = normalizeActivationRequest(input);
    const planned = await this.plan(request);
    const identity = activationIdentity(request);
    await withLock(this.activationRoot, 'engine', async () => {
      const ledgerFile = this.#ledgerFile(identity);
      const ledger = await readRequiredJson(ledgerFile);
      assertReplayMatches(ledger, request, identity);
      if (ledger.status !== 'ROLLED_BACK') throw new Error('AUTONODE_ACTIVATION_NOT_ROLLED_BACK');
      const now = new Date().toISOString();
      await writeJsonAtomic(ledgerFile, {
        ...ledger,
        state: 'PLANNED',
        status: 'PLANNED',
        generation: ledger.generation + 1,
        attempts: {},
        completed_cycles: [...ledger.completed_cycles, {
          generation: ledger.generation,
          step_receipts: ledger.step_receipts,
        }],
        step_receipts: [],
        in_flight: null,
        waiting_external: [],
        last_error: null,
        updated_at: now,
      });
    });
    return await this.apply(request, approvedPlanDigest, options);
  }

  async read(input) {
    const request = normalizeActivationRequest(input);
    await this.#prepare();
    const identity = activationIdentity(request);
    const ledger = await readJson(this.#ledgerFile(identity));
    if (ledger === null) return null;
    assertReplayMatches(ledger, request, identity);
    const candidate = await new FileNodeProvisioningEngine(this.candidateRoot, {
      allocateSecretStorePort: isZhudatuanL0Opening(request),
    })
      .provision(request.provisioning_request);
    return await this.#result(ledger, candidate);
  }

  async #prepare() {
    await mkdir(join(this.activationRoot, 'requests'), { recursive: true });
    await mkdir(join(this.activationRoot, 'plans'), { recursive: true });
    await mkdir(join(this.activationRoot, 'receipts'), { recursive: true });
  }

  #ledgerFile(identity) {
    return join(this.activationRoot, 'requests', `${identity.idempotencyDigest}.json`);
  }

  async #result(ledger, candidate) {
    return Object.freeze({
      ledger: structuredClone(ledger),
      plan: await readRequiredJson(resolveInside(this.root, ledger.plan_ref)),
      candidate,
    });
  }
}

async function activationPlan(request, candidate) {
  const instance = `${request.provisioning_request.node_slug}-${candidate.manifest.signed_level.toLowerCase()}`;
  const nodeDirectory = join(request.target.node_root, instance);
  const hosts = manifestHosts(candidate.manifest);
  const systemd = await readRequiredJson(join(candidate.nodeDirectory, 'runtime', 'systemd-instances.json'));
  const systemdTemplates = [...new Set(systemd.instances.map(({ unit }) =>
    join(request.target.systemd_unit_root, `${unit.split('@')[0]}@.service`)))].sort();
  const units = systemd.instances.map(({ unit }) => unit);
  if (isZhudatuanL0Opening(request)) units.unshift(zhudatuanOpeningSecretUnit(instance));
  const artifact = request.provisioning_request.artifact;
  const operations = [
    operation('FILES_MATERIALIZED', [nodeDirectory], [`remove owned node directory ${nodeDirectory}`]),
    operation('RELEASE_BOUND', [join(nodeDirectory, 'current'), request.target.release_directory],
      [`remove owned release pointer ${join(nodeDirectory, 'current')}`]),
    operation('RUNTIME_CONFIGURED', [request.target.runtime_profile_ref, join(nodeDirectory, 'runtime')],
      [`remove generated runtime files for ${instance}`]),
    operation('IDENTITY_BOUND', [candidate.manifest.realm_ref.ref],
      [`disable only identity realm ${candidate.manifest.realm_ref.ref}`]),
    operation('TLS_BOUND', [
      join(nodeDirectory, 'runtime', 'tls', 'origin.crt'),
      join(nodeDirectory, 'runtime', 'tls', 'origin.key'),
      join(nodeDirectory, 'runtime', 'tls', 'origin-ca.crt'),
    ],
      [`revoke and remove the certificate created for ${candidate.manifest.node_id}`]),
    operation('TUNNEL_BOUND', [`tunnel:${nodeActivationTunnelName(request, candidate.manifest)}`],
      [`delete owned tunnel tunnel:${nodeActivationTunnelName(request, candidate.manifest)}`]),
    operation('DNS_BOUND', Object.values(hosts).sort(),
      [`delete only DNS record IDs recorded for ${candidate.manifest.node_id}`]),
    operation('SYSTEMD_READY', [...systemdTemplates, ...units],
      [`disable only ${instance} systemd instances`]),
    operation('PROCESSES_READY', units,
      [`stop only ${instance} systemd instances`]),
    operation('HEALTH_VERIFIED', healthTargets(hosts), []),
    operation('ACTIVE', [join(nodeDirectory, 'manifest.json'), join(nodeDirectory, 'receipts', 'activation.json')],
      [`restore the previous manifest and pointer for ${candidate.manifest.node_id}`]),
  ];
  const value = {
    schema_version: AUTONODE_ACTIVATION_PLAN_SCHEMA_VERSION,
    activation_request_id: request.activation_request_id,
    provisioning_request_id: request.provisioning_request.provisioning_request_id,
    target_environment: request.target.environment,
    node_id: candidate.manifest.node_id,
    parent_node_id: candidate.manifest.parent_node_id,
    node_directory: nodeDirectory,
    release_directory: request.target.release_directory,
    runtime_profile_ref: request.target.runtime_profile_ref,
    source_sha: artifact.source_sha,
    build_id: artifact.build_id,
    build_count: 1,
    immutable_artifact_digest: artifact.immutable_artifact_digest,
    source_tree_copy_count: 0,
    node_specific_build_count: 0,
    hosts: Object.values(hosts).sort(),
    operations,
  };
  return Object.freeze({ ...value, plan_digest: digestJson(value) });
}

function operation(step, targets, rollback) {
  return Object.freeze({ step, targets: Object.freeze([...targets]), rollback: Object.freeze([...rollback]) });
}

function manifestHosts(manifest) {
  const entries = manifest.domain_bindings.map((binding) => [
    binding.surface_ref.slice('surface:'.length),
    binding.host,
  ]);
  const hosts = Object.fromEntries(entries);
  for (const surface of ['api', 'console', 'identity', 'storefront']) {
    if (typeof hosts[surface] !== 'string') throw new Error(`AUTONODE_MANIFEST_HOST_MISSING:${surface}`);
  }
  return Object.freeze(hosts);
}

function healthTargets(hosts) {
  return Object.freeze([
    `https://${hosts.api}/health/gateway`,
    `https://${hosts.console}/console-runtime.json`,
    `https://${hosts.identity}/health/ready`,
    `https://${hosts.storefront}/`,
  ]);
}

function normalizeActivationRequest(value) {
  const record = requiredRecord(value, 'activation request');
  if (record.schema_version !== AUTONODE_ACTIVATION_REQUEST_SCHEMA_VERSION) {
    throw new Error('AUTONODE_ACTIVATION_REQUEST_SCHEMA_INVALID');
  }
  const target = requiredRecord(record.target, 'target');
  const environment = requiredText(target.environment, 'target.environment');
  if (environment !== 'production' && environment !== 'staging') {
    throw new Error('AUTONODE_ACTIVATION_ENVIRONMENT_INVALID');
  }
  const provisioningRequest = parseNodeProvisioningRequest(record.provisioning_request);
  return Object.freeze({
    schema_version: AUTONODE_ACTIVATION_REQUEST_SCHEMA_VERSION,
    activation_request_id: requiredText(record.activation_request_id, 'activation_request_id'),
    idempotency_key: requiredText(record.idempotency_key, 'idempotency_key'),
    provisioning_request: provisioningRequest,
    target: Object.freeze({
      environment,
      node_root: absoluteTarget(target.node_root, 'target.node_root'),
      release_directory: absoluteTarget(target.release_directory, 'target.release_directory'),
      runtime_profile_ref: absoluteTarget(target.runtime_profile_ref, 'target.runtime_profile_ref'),
      systemd_unit_root: absoluteTarget(target.systemd_unit_root, 'target.systemd_unit_root'),
    }),
  });
}

function activationIdentity(request) {
  return Object.freeze({
    idempotencyDigest: sha256(request.idempotency_key),
    requestDigest: digestJson(request),
  });
}

function activationInvocation(identity, generation, step) {
  return sha256(`${identity.idempotencyDigest}:${generation}:${step}`);
}

function activationStepIndex(state) {
  if (state === 'PLANNED') return -1;
  const index = AUTONODE_ACTIVATION_STEPS.indexOf(state);
  if (index < 0) throw new Error(`AUTONODE_ACTIVATION_STATE_INVALID:${state}`);
  return index;
}

function startAttempt(ledger, step, invocationId) {
  return {
    ...ledger,
    status: 'APPLYING',
    attempts: { ...ledger.attempts, [step]: (ledger.attempts[step] ?? 0) + 1 },
    in_flight: { step, invocation_id: invocationId, started_at: new Date().toISOString() },
    waiting_external: [],
    last_error: null,
    updated_at: new Date().toISOString(),
  };
}

function completeStep(ledger, step, providerReceipt) {
  const now = new Date().toISOString();
  return {
    ...ledger,
    state: step,
    status: step === 'ACTIVE' ? 'ACTIVE' : 'APPLYING',
    step_receipts: [...ledger.step_receipts, {
      step,
      attempt: ledger.attempts[step],
      invocation_id: providerReceipt.invocation_id,
      provider_receipt: providerReceipt,
      completed_at: now,
    }],
    in_flight: null,
    last_error: null,
    updated_at: now,
  };
}

function recordFailure(ledger, step, cause) {
  return {
    ...ledger,
    status: 'FAILED_RETRYABLE',
    last_error: {
      step,
      attempt: ledger.attempts[step],
      message: cause instanceof Error ? cause.message : String(cause),
      recorded_at: new Date().toISOString(),
    },
    updated_at: new Date().toISOString(),
  };
}

function normalizeProviderReceipt(value, step, invocationId) {
  const receipt = requiredRecord(value, `provider receipt ${step}`);
  if (receipt.status !== 'APPLIED' || receipt.step !== step || receipt.invocation_id !== invocationId) {
    throw new Error(`AUTONODE_PROVIDER_RECEIPT_INVALID:${step}`);
  }
  return Object.freeze(structuredClone(receipt));
}

function normalizeRollbackReceipt(value, step, invocationId) {
  const receipt = requiredRecord(value, `rollback receipt ${step}`);
  if (receipt.status !== 'ROLLED_BACK' || receipt.step !== step || receipt.invocation_id !== invocationId) {
    throw new Error(`AUTONODE_PROVIDER_ROLLBACK_RECEIPT_INVALID:${step}`);
  }
  return Object.freeze(structuredClone(receipt));
}

function assertReplayMatches(ledger, request, identity) {
  if (ledger.schema_version !== AUTONODE_ACTIVATION_LEDGER_SCHEMA_VERSION
    || ledger.activation_request_id !== request.activation_request_id
    || ledger.idempotency_digest !== identity.idempotencyDigest
    || ledger.request_digest !== identity.requestDigest) {
    throw new Error('AUTONODE_ACTIVATION_IDEMPOTENCY_CONFLICT');
  }
}

function withoutIdempotencyKey(request) {
  const { idempotency_key: _idempotencyKey, ...safe } = request;
  return structuredClone(safe);
}

function requiredProvider(provider) {
  if (!provider || typeof provider.preflight !== 'function' || typeof provider.apply !== 'function'
    || typeof provider.rollback !== 'function') throw new Error('AUTONODE_PROVIDER_INVALID');
  return provider;
}

function stateRootPath(value) {
  const path = absoluteTarget(value, 'activation state root');
  if (path === sep || path === '/etc' || path.startsWith('/etc/') || path === '/opt' || path === '/opt/sfl/nodes') {
    throw new Error('AUTONODE_ACTIVATION_STATE_ROOT_FORBIDDEN');
  }
  return path;
}

function absoluteTarget(value, name) {
  const path = requiredText(value, name);
  if (!isAbsolute(path)) throw new Error(`AUTONODE_ABSOLUTE_PATH_REQUIRED:${name}`);
  return resolve(path);
}

async function withLock(root, name, action) {
  const locksRoot = join(root, 'locks');
  const lock = join(locksRoot, `${name}.lock`);
  await mkdir(locksRoot, { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    try {
      await mkdir(lock);
      await writeFile(join(lock, 'owner.json'), `${JSON.stringify({
        pid: process.pid,
        acquired_at: new Date().toISOString(),
      })}\n`);
      break;
    } catch (cause) {
      if (cause?.code !== 'EEXIST') throw cause;
      const information = await stat(lock).catch((statCause) => {
        if (statCause?.code === 'ENOENT') return null;
        throw statCause;
      });
      if (information === null) continue;
      if (Date.now() - information.mtimeMs > LOCK_STALE_MS) {
        const stale = `${lock}.stale-${process.pid}-${randomUUID()}`;
        await rename(lock, stale).catch((renameCause) => {
          if (renameCause?.code !== 'ENOENT') throw renameCause;
        });
        await rm(stale, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error('AUTONODE_ACTIVATION_BUSY');
      await new Promise((settle) => setTimeout(settle, 25));
    }
  }
  try {
    return await action();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

function resolveInside(root, reference) {
  const path = resolve(root, requiredText(reference, 'reference'));
  if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error('AUTONODE_REFERENCE_OUTSIDE_ROOT');
  return path;
}

async function writeJsonAtomic(file, value) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.autonode-write.tmp`;
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

async function readRequiredJson(file) {
  const value = await readJson(file);
  if (value === null) throw new Error(`AUTONODE_FILE_MISSING:${file}`);
  return value;
}

function requiredRecord(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`AUTONODE_FIELD_INVALID:${name}`);
  }
  return value;
}

function requiredText(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`AUTONODE_FIELD_INVALID:${name}`);
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
