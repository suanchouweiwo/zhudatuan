import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export const AUTONODE_OPERATIONS_STATE_SCHEMA_VERSION = 'sfl.autonode-operations-state.v1';
export const AUTONODE_OPERATIONS_RUNTIME_PROFILE_SCHEMA_VERSION = 'sfl.autonode-runtime-profile.v1';

const PROCESS_ORDER = Object.freeze([
  'object-store',
  'catalog-api',
  'web-api',
  'identity-api',
  'purchase-api',
  'payment-webhook-api',
  'catalog-jobs',
  'payment-jobs',
  'storefront',
  'api-gateway',
  'cloudflared',
]);

const LOCAL_HEALTH_SERVICES = Object.freeze({
  'catalog-api': 'catalog',
  'web-api': 'web',
  'identity-api': 'identity',
  'purchase-api': 'purchase',
});

export class ProductionNodeOperationsProvider {
  constructor(options = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.cloudflareApiToken = options.cloudflareApiToken ?? process.env.CLOUDFLARE_API_TOKEN;
    this.runner = options.runner ?? runCommand;
    this.journalctl = options.journalctl ?? '/usr/bin/journalctl';
    if (!isAbsolute(this.journalctl)) throw new Error('AUTONODE_JOURNALCTL_PATH_INVALID');
  }

  async status(request) {
    const context = await this.#context(request);
    return await this.#inspect(context);
  }

  async delete(request) {
    const node = request.target.node_directory.split('/').at(-1);
    const nodeParts = request.target.node_id.split(':');
    if (nodeParts.length !== 3 || node !== `${nodeParts[1]}-${nodeParts[2]}`
      || resolve(request.target.node_directory) !== `/opt/sfl/nodes/${node}`) {
      throw new Error('AUTONODE_OPERATION_NODE_IDENTITY_MISMATCH');
    }
    const file = `/var/lib/sfl-autonode-control/resources/${node}.json`;
    const resource = await readRequiredJson(file);
    if (resource.node !== node || resource.nodeRoot !== request.target.node_directory
      || resource.database?.container !== `${node}-postgres`
      || resource.objectDirectory !== `/var/lib/sfl-${node}-objects`) {
      throw new Error('AUTONODE_OPERATION_RESOURCE_IDENTITY_MISMATCH');
    }
    if (resource.state === 'DELETED') return { node_id: request.target.node_id, state: 'DELETED', changed: false };
    for (const unit of resource.services) {
      if (!/^sfl-[a-z-]+@/.test(unit) || !unit.endsWith(`@${node}.service`)) {
        throw new Error('AUTONODE_OPERATION_RESOURCE_UNIT_MISMATCH');
      }
      const loaded = await this.runner('/usr/bin/systemctl', ['show', unit, '--property=LoadState', '--value']);
      if (loaded.stdout.trim() !== 'not-found') {
        await this.runner('/usr/bin/systemctl', ['stop', unit]);
        await this.runner('/usr/bin/systemctl', ['disable', unit]);
      }
    }
    const cloudflare = async (path) => {
      const token = this.cloudflareApiToken;
      if (!token) throw new Error('CLOUDFLARE_INGRESS_CREDENTIALS_MISSING');
      const response = await this.fetcher(`https://api.cloudflare.com/client/v4${path}`, {
        method: 'DELETE', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000),
      });
      const payload = await response.json();
      if (response.status !== 404 && (!response.ok || payload.success !== true)) {
        throw new Error(`AUTONODE_RESOURCE_DELETE_FAILED:${response.status}`);
      }
    };
    for (const record of resource.dnsRecords ?? []) {
      await cloudflare(`/zones/${encodeURIComponent(record.zoneId)}/dns_records/${encodeURIComponent(record.id)}`);
    }
    if (resource.cloudflare?.tunnelId) {
      await cloudflare(`/accounts/${encodeURIComponent(resource.cloudflare.accountId)}/cfd_tunnel/${encodeURIComponent(resource.cloudflare.tunnelId)}`);
    }
    const container = resource.database.container;
    const existing = await this.runner('/usr/bin/docker', ['container', 'ls', '-a', '--format', '{{.Names}}']);
    if (existing.stdout.split('\n').includes(container)) await this.runner('/usr/bin/docker', ['rm', '-f', container]);
    const networks = await this.runner('/usr/bin/docker', ['network', 'ls', '--format', '{{.Name}}']);
    for (const network of resource.networks ?? []) {
      if (![`${node}_registration`, `${node}-database-link`].includes(network)) throw new Error('AUTONODE_OPERATION_RESOURCE_NETWORK_MISMATCH');
      if (networks.stdout.split('\n').includes(network)) await this.runner('/usr/bin/docker', ['network', 'rm', network]);
    }
    for (const unit of resource.services) {
      await rm(`/etc/systemd/system/${unit}`, { force: true });
      await rm(`/etc/systemd/system/${unit}.d`, { recursive: true, force: true });
    }
    await this.runner('/usr/bin/systemctl', ['daemon-reload']);
    // rm removes links themselves; it does not traverse shared runtime targets.
    await rm(resource.objectDirectory, { recursive: true, force: true });
    await rm(resource.nodeRoot, { recursive: true, force: true });
    await writeJsonAtomic(file, { ...resource, state: 'DELETED', deletedAt: new Date().toISOString() }, 0o600);
    return { node_id: request.target.node_id, state: 'DELETED', changed: true };
  }

  async pause(request) {
    const context = await this.#context(request);
    const before = await this.#inspect(context);
    if (before.runtime_state === 'SUSPENDED') return { ...before, changed: false };
    const activeBefore = new Set(before.units.filter(({ active }) => active).map(({ unit }) => unit));
    try {
      for (const { unit } of [...context.instances].reverse()) {
        if (activeBefore.has(unit)) await this.runner(context.profile.commands.systemctl, ['stop', unit]);
      }
      await this.#record(context, request, 'SUSPENDED', 'SUCCEEDED');
      return { ...await this.#inspect(context), changed: true };
    } catch (cause) {
      await this.#restoreUnitActivity(context, activeBefore);
      await this.#record(context, request, before.desired_state, 'FAILED', cause);
      throw cause;
    }
  }

  async resume(request) {
    const context = await this.#context(request);
    const before = await this.#inspect(context);
    if (before.runtime_state === 'ACTIVE') return { ...before, changed: false };
    const activeBefore = new Set(before.units.filter(({ active }) => active).map(({ unit }) => unit));
    try {
      for (const { unit } of context.instances) {
        if (!activeBefore.has(unit)) await this.runner(context.profile.commands.systemctl, ['start', unit]);
      }
      await this.#assertHealthy(context);
      await this.#record(context, request, 'ACTIVE', 'SUCCEEDED');
      return { ...await this.#inspect(context), changed: true };
    } catch (cause) {
      await this.#restoreUnitActivity(context, activeBefore);
      await this.#record(context, request, before.desired_state, 'FAILED', cause);
      throw cause;
    }
  }

  async upgrade(request) {
    const context = await this.#context(request);
    const release = request.action.release;
    await assertDirectory(release.release_directory, 'AUTONODE_UPGRADE_RELEASE_MISSING');
    const previous = await this.#releaseSnapshot(context);
    if (previous.source_sha === release.source_sha
      && previous.immutable_artifact_digest === release.immutable_artifact_digest
      && previous.release_directory === release.release_directory) {
      return { ...await this.#inspect(context), changed: false, release: previous };
    }
    return await this.#switchRelease(context, request, release, previous, 'UPGRADE');
  }

  async rollback(request) {
    const context = await this.#context(request);
    const state = await this.#state(context);
    const release = state.release_history.at(-1);
    if (release === undefined) throw new Error('AUTONODE_ROLLBACK_RELEASE_UNAVAILABLE');
    await assertDirectory(release.release_directory, 'AUTONODE_ROLLBACK_RELEASE_MISSING');
    const previous = await this.#releaseSnapshot(context);
    return await this.#switchRelease(context, request, release, previous, 'ROLLBACK');
  }

  async logs(request) {
    const context = await this.#context(request);
    const state = await this.#state(context);
    const lineCount = request.action.line_count;
    const perUnit = Math.max(1, Math.floor(lineCount / Math.max(1, context.instances.length)));
    const services = [];
    for (const { service, unit } of context.instances) {
      const result = await this.runner(this.journalctl, [
        '--unit', unit,
        '--no-pager',
        '--output', 'short-iso',
        '--lines', String(perUnit),
      ], { allowFailure: true });
      services.push({
        service,
        unit,
        status: result.code === 0 ? 'AVAILABLE' : 'UNAVAILABLE',
        lines: result.stdout.split('\n').filter(Boolean).slice(-perUnit),
        ...(result.code === 0 ? {} : { error: result.stderr.trim() || `exit ${result.code}` }),
      });
    }
    return {
      node_id: context.manifest.node_id,
      requested_line_count: lineCount,
      operation_history: state.history.slice(-lineCount),
      services,
    };
  }

  async #switchRelease(context, request, release, previous, action) {
    const before = await this.#inspect(context);
    const state = await this.#state(context);
    const history = action === 'ROLLBACK'
      ? state.release_history.slice(0, -1)
      : [...state.release_history, previous].slice(-20);
    const next = await releaseDocuments(context, release, request.requested_at);
    await this.#writeState(context, {
      ...state,
      pending_transition: { action, operation_request_id: request.operation_request_id, previous, next: release },
    });
    try {
      await this.#writeReleaseDocuments(context, next);
      await switchSymlink(context.currentLink, release.release_directory, request.operation_request_id);
      if (before.desired_state === 'ACTIVE') {
        for (const { unit } of context.instances) {
          await this.runner(context.profile.commands.systemctl, ['restart', unit]);
        }
        await this.#assertHealthy(context);
      }
      await this.#record(context, request, before.desired_state, 'SUCCEEDED', null, {
        release_history: history,
        pending_transition: null,
      });
      const refreshed = await this.#context(request);
      return {
        ...await this.#inspect(refreshed),
        changed: true,
        previous_release: previous,
        release: await this.#releaseSnapshot(refreshed),
      };
    } catch (cause) {
      let failure = cause;
      try {
        await this.#restoreRelease(context, previous);
      } catch (restoreCause) {
        failure = new Error(`AUTONODE_RELEASE_RESTORE_FAILED:${errorMessage(cause)}:${errorMessage(restoreCause)}`);
      }
      if (before.desired_state === 'ACTIVE') {
        for (const { unit } of context.instances) {
          await this.runner(context.profile.commands.systemctl, ['restart', unit], { allowFailure: true });
        }
      }
      await this.#record(context, request, before.desired_state, 'FAILED', failure, { pending_transition: null });
      throw failure;
    }
  }

  async #context(request) {
    const nodeDirectory = request.target.node_directory;
    if (['/', '/opt', '/opt/sfl', '/opt/sfl/nodes'].includes(nodeDirectory)) {
      throw new Error('AUTONODE_OPERATION_NODE_DIRECTORY_FORBIDDEN');
    }
    const [owner, manifest, pointer, systemd, resources, profileValue] = await Promise.all([
      readRequiredJson(join(nodeDirectory, '.autonode-owner.json')),
      readRequiredJson(join(nodeDirectory, 'manifest.json')),
      readRequiredJson(join(nodeDirectory, 'release-pointer.json')),
      readRequiredJson(join(nodeDirectory, 'runtime', 'systemd-instances.json')),
      readRequiredJson(join(nodeDirectory, 'runtime', 'resource-plan.json')),
      readRequiredJson(request.target.runtime_profile_ref),
    ]);
    if (owner.node_id !== request.target.node_id || manifest.node_id !== request.target.node_id
      || pointer.node_id !== request.target.node_id) {
      throw new Error(`AUTONODE_OPERATION_NODE_IDENTITY_MISMATCH:${request.target.node_id}`);
    }
    const { manifest_digest: manifestDigest, ...unsignedManifest } = manifest;
    if (manifestDigest !== digestCanonicalJson(unsignedManifest)) {
      throw new Error(`AUTONODE_OPERATION_MANIFEST_DIGEST_MISMATCH:${request.target.node_id}`);
    }
    if (pointer.manifest_digest !== manifest.manifest_digest
      || pointer.manifest_version !== manifest.manifest_version
      || canonicalJson(pointer.release_pointer_ref) !== canonicalJson(manifest.release_pointer_ref)) {
      throw new Error(`AUTONODE_OPERATION_RELEASE_EVIDENCE_MISMATCH:${request.target.node_id}`);
    }
    if (manifest.lifecycle_status !== 'active' || pointer.candidate_status !== 'ACTIVE') {
      throw new Error(`AUTONODE_OPERATION_NODE_NOT_ACTIVE:${request.target.node_id}`);
    }
    const instances = normalizeInstances(systemd.instances);
    const profile = parseOperationsRuntimeProfile(profileValue, request.target.environment);
    const currentLink = join(nodeDirectory, 'current');
    const currentTarget = await symlinkTarget(currentLink);
    if (currentTarget === null) throw new Error(`AUTONODE_OPERATION_RELEASE_POINTER_MISSING:${currentLink}`);
    await assertDirectory(currentTarget, 'AUTONODE_OPERATION_CURRENT_RELEASE_MISSING');
    return {
      request,
      nodeDirectory,
      owner,
      manifest,
      pointer,
      resources,
      profile,
      instances,
      currentLink,
      currentTarget,
      stateFile: join(nodeDirectory, 'runtime', 'operations-state.json'),
    };
  }

  async #inspect(context) {
    const state = await this.#state(context);
    const units = [];
    for (const { service, unit } of context.instances) {
      const result = await this.runner(context.profile.commands.systemctl, ['is-active', unit], { allowFailure: true });
      units.push({ service, unit, active: result.code === 0 });
    }
    const health = [];
    for (const [service, portName] of Object.entries(LOCAL_HEALTH_SERVICES)) {
      const unit = units.find((entry) => entry.service === service);
      const port = context.resources?.ports?.[portName];
      if (!unit?.active || !Number.isSafeInteger(port)) {
        health.push({ service, status: 'UNAVAILABLE', http_status: null });
        continue;
      }
      try {
        const response = await this.fetcher(`http://127.0.0.1:${port}/health/ready`, {
          signal: AbortSignal.timeout(context.profile.health.timeout_ms),
        });
        health.push({ service, status: response.status === 200 ? 'READY' : 'FAILED', http_status: response.status });
      } catch (cause) {
        health.push({ service, status: 'FAILED', http_status: null, error: errorMessage(cause) });
      }
    }
    const activeCount = units.filter(({ active }) => active).length;
    const allHealthy = health.every(({ status }) => status === 'READY');
    let runtimeState = 'DEGRADED';
    if (state.desired_state === 'SUSPENDED' && activeCount === 0) runtimeState = 'SUSPENDED';
    if (state.desired_state === 'ACTIVE' && activeCount === units.length && allHealthy) runtimeState = 'ACTIVE';
    return {
      node_id: context.manifest.node_id,
      runtime_state: runtimeState,
      desired_state: state.desired_state,
      source_sha: context.manifest.release_pointer_ref.source_sha,
      build_id: context.manifest.release_pointer_ref.build_id,
      immutable_artifact_digest: context.manifest.release_pointer_ref.immutable_artifact_digest,
      release_directory: context.currentTarget,
      manifest_version: context.manifest.manifest_version,
      manifest_digest: context.manifest.manifest_digest,
      pending_transition: state.pending_transition,
      units,
      health,
      last_operation: state.history.at(-1) ?? null,
    };
  }

  async #assertHealthy(context) {
    const refreshed = await this.#context(context.request);
    const status = await this.#inspect(refreshed);
    if (!status.units.every(({ active }) => active)
      || !status.health.every(({ status: healthStatus }) => healthStatus === 'READY')) {
      throw new Error(`AUTONODE_RUNTIME_HEALTH_FAILED:${status.runtime_state}`);
    }
  }

  async #releaseSnapshot(context) {
    return Object.freeze({
      release_directory: context.currentTarget,
      source_sha: context.manifest.release_pointer_ref.source_sha,
      build_id: context.manifest.release_pointer_ref.build_id,
      build_count: 1,
      immutable_artifact_digest: context.manifest.release_pointer_ref.immutable_artifact_digest,
    });
  }

  async #writeReleaseDocuments(context, documents) {
    await writeJsonAtomic(join(context.nodeDirectory, 'manifest.json'), documents.manifest, 0o644);
    await writeJsonAtomic(join(context.nodeDirectory, 'release-pointer.json'), documents.pointer, 0o640);
    await writeJsonAtomic(join(context.nodeDirectory, 'runtime', 'console-runtime.json'), documents.consoleRuntime, 0o640);
    await writeJsonAtomic(join(context.nodeDirectory, 'runtime', 'identity-runtime.json'), documents.identityRuntime, 0o640);
    for (const { environment_file: file } of context.instances) {
      if (file === null) continue;
      const environment = await readEnvironment(file);
      await writeEnvironment(file, {
        ...environment,
        SERVICE_VERSION: documents.manifest.release_pointer_ref.source_sha,
        NODE_MANIFEST_PATH: join(context.nodeDirectory, 'manifest.json'),
        NODE_MANIFEST_ID: documents.manifest.manifest_id,
        NODE_MANIFEST_DIGEST: documents.manifest.manifest_digest,
        NODE_RUNTIME_INSTANCE_ID: documents.manifest.runtime_instance_id,
        NODE_RUNTIME_CONFIG_REF: documents.manifest.runtime_config_ref.ref,
        NODE_RESOURCE_BINDING_VERSION: documents.manifest.resource_binding_set_ref.version,
        NODE_RELEASE_POINTER_REF: documents.manifest.release_pointer_ref.ref,
      });
    }
  }

  async #restoreRelease(context, release) {
    const documents = await releaseDocuments(context, release, new Date().toISOString());
    await this.#writeReleaseDocuments(context, documents);
    await switchSymlink(context.currentLink, release.release_directory, `restore-${Date.now()}`);
  }

  async #restoreUnitActivity(context, activeBefore) {
    for (const { unit } of context.instances) {
      const current = (await this.runner(context.profile.commands.systemctl, ['is-active', unit], { allowFailure: true })).code === 0;
      if (activeBefore.has(unit) && !current) {
        await this.runner(context.profile.commands.systemctl, ['start', unit], { allowFailure: true });
      } else if (!activeBefore.has(unit) && current) {
        await this.runner(context.profile.commands.systemctl, ['stop', unit], { allowFailure: true });
      }
    }
  }

  async #state(context) {
    const state = await readJson(context.stateFile);
    if (state !== null) {
      if (state.schema_version !== AUTONODE_OPERATIONS_STATE_SCHEMA_VERSION
        || state.node_id !== context.manifest.node_id
        || !['ACTIVE', 'SUSPENDED'].includes(state.desired_state)
        || !Array.isArray(state.release_history)
        || !Array.isArray(state.history)) {
        throw new Error(`AUTONODE_OPERATION_STATE_INVALID:${context.manifest.node_id}`);
      }
      return state;
    }
    return {
      schema_version: AUTONODE_OPERATIONS_STATE_SCHEMA_VERSION,
      node_id: context.manifest.node_id,
      desired_state: 'ACTIVE',
      pending_transition: null,
      release_history: [],
      history: [],
    };
  }

  async #record(context, request, desiredState, outcome, cause = null, patch = {}) {
    const state = await this.#state(context);
    const entry = {
      operation_request_id: request.operation_request_id,
      action: request.action.type,
      outcome,
      actor_id: request.requested_by.actor_id,
      membership_id: request.requested_by.membership_id,
      authorized_operation: request.requested_by.authorized_operation,
      requested_at: request.requested_at,
      completed_at: new Date().toISOString(),
      reason: request.action.reason ?? null,
      error: cause === null ? null : errorMessage(cause),
    };
    await this.#writeState(context, {
      ...state,
      ...patch,
      schema_version: AUTONODE_OPERATIONS_STATE_SCHEMA_VERSION,
      node_id: context.manifest.node_id,
      desired_state: desiredState,
      history: [...state.history, entry].slice(-100),
    });
  }

  async #writeState(context, state) {
    await writeJsonAtomic(context.stateFile, state, 0o640);
  }
}

async function releaseDocuments(context, release, generatedAt) {
  const revision = Number.parseInt(context.manifest.manifest_version.split('.').at(-1) ?? '', 10);
  const pointerVersion = Number.parseInt(context.manifest.release_pointer_ref.version, 10);
  if (!Number.isSafeInteger(revision) || !Number.isSafeInteger(pointerVersion)) {
    throw new Error('AUTONODE_OPERATION_MANIFEST_VERSION_INVALID');
  }
  const {
    schema_version: _schemaVersion,
    manifest_version: _manifestVersion,
    manifest_digest: _manifestDigest,
    generated_at: _generatedAt,
    lifecycle_status: _lifecycleStatus,
    ...spec
  } = context.manifest;
  const unsignedManifest = {
    ...spec,
    schema_version: context.manifest.schema_version,
    manifest_version: `1.0.${revision + 1}`,
    generated_at: new Date(generatedAt).toISOString(),
    lifecycle_status: 'active',
    release_pointer_ref: {
      ...context.manifest.release_pointer_ref,
      version: String(pointerVersion + 1),
      source_sha: release.source_sha,
      build_id: release.build_id,
      build_count: 1,
      immutable_artifact_digest: release.immutable_artifact_digest,
    },
  };
  const manifest = { ...unsignedManifest, manifest_digest: digestCanonicalJson(unsignedManifest) };
  const pointer = {
    ...context.pointer,
    manifest_version: manifest.manifest_version,
    manifest_digest: manifest.manifest_digest,
    release_pointer_ref: manifest.release_pointer_ref,
    candidate_status: 'ACTIVE',
  };
  const consoleFile = join(context.nodeDirectory, 'runtime', 'console-runtime.json');
  const identityFile = join(context.nodeDirectory, 'runtime', 'identity-runtime.json');
  const consoleRuntime = {
    ...await readRequiredJson(consoleFile),
    source_sha: release.source_sha,
    build_id: release.build_id,
    build_count: 1,
    immutable_artifact_digest: release.immutable_artifact_digest,
    node_manifest: manifest,
  };
  const identityRuntime = {
    ...await readRequiredJson(identityFile),
    source_sha: release.source_sha,
    build_id: release.build_id,
    build_count: 1,
    immutable_artifact_digest: release.immutable_artifact_digest,
  };
  return { manifest, pointer, consoleRuntime, identityRuntime };
}

function normalizeInstances(value) {
  if (!Array.isArray(value) || value.length === 0) throw new Error('AUTONODE_OPERATION_SYSTEMD_INSTANCES_INVALID');
  const instances = value.map((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('AUTONODE_OPERATION_SYSTEMD_INSTANCE_INVALID');
    }
    const service = requiredText(entry.service, 'systemd service');
    const unit = requiredText(entry.unit, 'systemd unit');
    if (!/^[a-z0-9_.:@-]+\.service$/u.test(unit)) throw new Error(`AUTONODE_OPERATION_SYSTEMD_UNIT_INVALID:${unit}`);
    const environmentFile = entry.environment_file === null
      ? null
      : requiredAbsolutePath(entry.environment_file, 'systemd environment file');
    return { service, unit, environment_file: environmentFile };
  });
  return Object.freeze(instances.sort((left, right) => orderOf(left.service) - orderOf(right.service)));
}

function parseOperationsRuntimeProfile(value, environment) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || value.schema_version !== AUTONODE_OPERATIONS_RUNTIME_PROFILE_SCHEMA_VERSION) {
    throw new Error('AUTONODE_OPERATION_RUNTIME_PROFILE_INVALID');
  }
  if (value.environment !== environment) throw new Error('AUTONODE_OPERATION_RUNTIME_PROFILE_ENVIRONMENT_MISMATCH');
  const commands = value.commands;
  if (commands === null || typeof commands !== 'object' || Array.isArray(commands)) {
    throw new Error('AUTONODE_OPERATION_RUNTIME_COMMANDS_INVALID');
  }
  const health = value.health === undefined ? {} : value.health;
  if (health === null || typeof health !== 'object' || Array.isArray(health)) {
    throw new Error('AUTONODE_OPERATION_RUNTIME_HEALTH_INVALID');
  }
  const timeout = health.timeout_ms ?? 15_000;
  if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new Error('AUTONODE_OPERATION_RUNTIME_TIMEOUT_INVALID');
  return Object.freeze({
    commands: Object.freeze({ systemctl: requiredAbsolutePath(commands.systemctl ?? '/usr/bin/systemctl', 'systemctl') }),
    health: Object.freeze({ timeout_ms: timeout }),
  });
}

function orderOf(service) {
  const index = PROCESS_ORDER.indexOf(service);
  return index < 0 ? PROCESS_ORDER.length : index;
}

async function switchSymlink(link, target, operationId) {
  const next = `${link}.operation-${safeToken(operationId)}`;
  await rm(next, { force: true });
  await symlink(resolve(target), next);
  await rename(next, link);
}

async function symlinkTarget(path) {
  try {
    const entry = await lstat(path);
    if (!entry.isSymbolicLink()) throw new Error(`AUTONODE_OPERATION_POINTER_NOT_SYMLINK:${path}`);
    const target = await readlink(path);
    return resolve(dirname(path), target);
  } catch (cause) {
    if (cause?.code === 'ENOENT') return null;
    throw cause;
  }
}

async function assertDirectory(path, code) {
  const entry = await stat(path).catch((cause) => cause?.code === 'ENOENT' ? null : Promise.reject(cause));
  if (entry === null || !entry.isDirectory()) throw new Error(`${code}:${path}`);
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (cause) {
    if (cause?.code === 'ENOENT') return null;
    throw cause;
  }
}

async function readRequiredJson(file) {
  const value = await readJson(file);
  if (value === null) throw new Error(`AUTONODE_OPERATION_FILE_MISSING:${file}`);
  return value;
}

async function writeJsonAtomic(file, value, mode) {
  await mkdir(dirname(file), { recursive: true });
  const next = `${file}.next-${process.pid}`;
  await writeFile(next, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await chmod(next, mode);
  await rename(next, file);
}

async function readEnvironment(file) {
  const source = await readFile(file, 'utf8');
  return Object.fromEntries(source.split('\n').filter(Boolean).map((line) => {
    const index = line.indexOf('=');
    if (index < 1) throw new Error(`AUTONODE_OPERATION_ENVIRONMENT_LINE_INVALID:${file}`);
    const key = line.slice(0, index);
    const raw = line.slice(index + 1);
    let value = raw;
    if (raw.startsWith('"') && raw.endsWith('"')) value = JSON.parse(raw);
    return [key, value];
  }));
}

async function writeEnvironment(file, environment) {
  const source = `${Object.entries(environment).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${JSON.stringify(String(value))}`).join('\n')}\n`;
  const next = `${file}.next-${process.pid}`;
  await writeFile(next, source, { mode: 0o640 });
  await chmod(next, 0o640);
  await rename(next, file);
}

function safeToken(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/gu, '-').slice(0, 80);
}

function digestCanonicalJson(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function requiredAbsolutePath(value, name) {
  const path = requiredText(value, name);
  if (!isAbsolute(path)) throw new Error(`AUTONODE_OPERATION_ABSOLUTE_PATH_REQUIRED:${name}`);
  return resolve(path);
}

function requiredText(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`AUTONODE_OPERATION_TEXT_REQUIRED:${name}`);
  return value.trim();
}

async function runCommand(command, args, options = {}) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', rejectPromise);
    child.on('close', (code) => {
      const result = { code: code ?? 1, stdout, stderr };
      if (result.code !== 0 && options.allowFailure !== true) {
        rejectPromise(new Error(`AUTONODE_OPERATION_COMMAND_FAILED:${command}:${args.join(',')}:${result.code}:${stderr.trim()}`));
      } else resolvePromise(result);
    });
  });
}

function errorMessage(cause) {
  return cause instanceof Error ? cause.message : String(cause);
}
