import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  canonicalJson,
  generateNodeManifest,
} from '../../../01_core_hexin/packages/config/src/SflNodeKernel.ts';
import { parseSflConsoleNodeRuntime } from '../../../01_core_hexin/packages/config/src/SflNodeKernelConsole.ts';
import { parseIdentityNodeRegistry } from '../../../01_core_hexin/packages/sdk/src/IdentityNodeRegistry.ts';
import { IDENTITY_NODE_MANIFEST } from '../../../01_core_hexin/packages/config/src/IdentityNodeManifest.ts';
import { CreateMall } from '../../../01_core_hexin/services/commerce/src/modules/provisioning/03_application_yingyong/CreateMall.ts';
import { gatewayConfiguration } from '../release/generate-sfl-node-gateway.mjs';

export const AUTONODE_REQUEST_SCHEMA_VERSION = 'sfl.autonode-request.v2';
export const AUTONODE_RECURSIVE_REQUEST_SCHEMA_VERSION = 'sfl.autonode-request.v3';
export const AUTONODE_LEGACY_REQUEST_SCHEMA_VERSION = 'sfl.autonode-request.v1';
export const AUTONODE_LEDGER_SCHEMA_VERSION = 'sfl.autonode-ledger.v1';
export const AUTONODE_RESOURCE_REGISTRY_SCHEMA_VERSION = 'sfl.autonode-resource-registry.v1';
export const AUTONODE_PROVISIONING_STEPS = Object.freeze([
  'ACCEPTED',
  'BUSINESS_READY',
  'MANIFEST_READY',
  'RESOURCES_PLANNED',
  'RUNTIME_READY',
  'RELEASE_BOUND',
  'CANDIDATE_READY',
]);

export function parseNodeProvisioningRequest(value) {
  return normalizeRequest(value);
}

export async function activateCandidateNodeManifest(manifest, activatedAt = manifest?.generated_at) {
  const version = typeof manifest?.manifest_version === 'string'
    ? Number.parseInt(manifest.manifest_version.split('.').at(-1) ?? '', 10)
    : Number.NaN;
  if (!Number.isSafeInteger(version)) throw new Error('AUTONODE_MANIFEST_VERSION_INVALID');
  const {
    schema_version: _schemaVersion,
    manifest_version: _manifestVersion,
    manifest_digest: _manifestDigest,
    generated_at: _generatedAt,
    lifecycle_status: _lifecycleStatus,
    ...spec
  } = manifest;
  return await generateNodeManifest({
    ...spec,
    manifest_revision: version + 1,
    generated_at: activatedAt,
    lifecycle_status: 'active',
  });
}

export const AUTONODE_PORT_NAMES = Object.freeze([
  'gateway',
  'storefront',
  'catalog',
  'web',
  'identity',
  'purchase',
  'webhook',
  'object_store',
  'tunnel_metrics',
]);
const PORT_MINIMUM = 18_000;
const PORT_MAXIMUM = 58_000;
const LOCK_WAIT_MS = 10_000;
const LOCK_STALE_MS = 30_000;

/**
 * Durable, candidate-only AutoNode orchestrator. The supplied root is the complete
 * authority boundary: this engine never writes production resources or source trees.
 */
export class FileNodeProvisioningEngine {
  constructor(candidateRoot) {
    this.root = candidateRootPath(candidateRoot);
    this.stateRoot = join(this.root, 'state');
    this.nodesRoot = join(this.root, 'nodes');
  }

  async provision(input, options = {}) {
    const submittedRequest = normalizeRequest(input);
    await this.#prepareRoot();
    return await withLock(this.stateRoot, 'engine', async () => {
      const request = await this.#resolveRequest(submittedRequest);
      const identity = requestIdentity(request);
      const ledgerFile = join(this.stateRoot, 'requests', `${identity.idempotencyDigest}.json`);
      let ledger = await readJson(ledgerFile);
      let acceptedNow = false;
      if (ledger === null) {
        await this.#claimNode(request, identity.idempotencyDigest);
        ledger = initialLedger(request, identity);
        await writeJsonAtomic(ledgerFile, ledger);
        acceptedNow = true;
      } else {
        assertReplayMatches(ledger, request, identity);
      }

      if (ledger.state === 'ROLLED_BACK') throw new Error('AUTONODE_REQUEST_ROLLED_BACK');
      if (acceptedNow) await options.afterStep?.('ACCEPTED', structuredClone(ledger));

      for (const step of AUTONODE_PROVISIONING_STEPS.slice(stepIndex(ledger.state) + 1)) {
        ledger = incrementAttempt(ledger, step);
        await writeJsonAtomic(ledgerFile, ledger);
        let output;
        try {
          output = await this.#executeStep(step, request, ledger);
        } catch (cause) {
          ledger = recordFailure(ledger, step, cause);
          await writeJsonAtomic(ledgerFile, ledger);
          throw cause;
        }
        ledger = completeStep(ledger, step, output);
        await writeJsonAtomic(ledgerFile, ledger);
        await options.afterStep?.(step, structuredClone(ledger));
      }
      await this.#markNodeReady(request);
      return await this.#result(ledger);
    });
  }

  async rollback(input, reason = 'candidate rollback') {
    const submittedRequest = normalizeRequest(input);
    await this.#prepareRoot();
    return await withLock(this.stateRoot, 'engine', async () => {
      const request = await this.#resolveRequest(submittedRequest);
      const identity = requestIdentity(request);
      const ledgerFile = join(this.stateRoot, 'requests', `${identity.idempotencyDigest}.json`);
      let ledger = await readJson(ledgerFile);
      if (ledger === null) throw new Error('AUTONODE_REQUEST_UNKNOWN');
      assertReplayMatches(ledger, request, identity);
      if (ledger.state === 'ROLLED_BACK') {
        return await readRequiredJson(resolveInside(this.root, ledger.rollback_receipt_ref));
      }

      const nodeDirectory = this.#nodeDirectory(request);
      const removedFiles = await fileInventory(nodeDirectory, this.root);
      const resourcesFile = join(this.stateRoot, 'resources.json');
      const registry = await this.#resourceRegistry();
      const allocation = registry.allocations[identity.nodeId] ?? null;
      if (allocation !== null && allocation.provisioning_request_id !== request.provisioning_request_id) {
        throw new Error('AUTONODE_RESOURCE_OWNER_MISMATCH');
      }
      if (allocation !== null) delete registry.allocations[identity.nodeId];
      registry.revision += 1;
      await writeJsonAtomic(resourcesFile, registry);

      const nodesFile = join(this.stateRoot, 'nodes.json');
      const nodes = await this.#nodeRegistry();
      const child = Object.entries(nodes.nodes).find(([, fact]) => fact.parent_node_id === identity.nodeId);
      if (child !== undefined) throw new Error(`AUTONODE_NODE_HAS_CHILDREN:${child[0]}`);
      if (nodes.nodes[identity.nodeId]?.idempotency_digest === identity.idempotencyDigest) {
        delete nodes.nodes[identity.nodeId];
      }
      nodes.revision += 1;
      await writeJsonAtomic(nodesFile, nodes);

      await rm(nodeDirectory, { recursive: true, force: true });
      const rolledBackAt = new Date().toISOString();
      const receipt = Object.freeze({
        schema_version: 'sfl.autonode-rollback-receipt.v1',
        provisioning_request_id: request.provisioning_request_id,
        node_id: identity.nodeId,
        reason: requiredText(reason, 'rollback reason'),
        rolled_back_at: rolledBackAt,
        released_ports: allocation?.ports ?? {},
        released_hosts: allocation?.hosts ?? [],
        removed_files: removedFiles,
        source_sha: request.artifact.source_sha,
        build_id: request.artifact.build_id,
        immutable_artifact_digest: request.artifact.immutable_artifact_digest,
      });
      const receiptRef = `state/receipts/${identity.idempotencyDigest}-rollback.json`;
      await writeJsonAtomic(join(this.root, receiptRef), receipt);
      ledger = {
        ...ledger,
        state: 'ROLLED_BACK',
        rollback_receipt_ref: receiptRef,
        last_error: null,
        updated_at: rolledBackAt,
      };
      await writeJsonAtomic(ledgerFile, ledger);
      return receipt;
    });
  }

  async read(input) {
    const submittedRequest = normalizeRequest(input);
    await this.#prepareRoot();
    const request = await this.#resolveRequest(submittedRequest);
    const identity = requestIdentity(request);
    const ledger = await readJson(join(this.stateRoot, 'requests', `${identity.idempotencyDigest}.json`));
    if (ledger === null) return null;
    assertReplayMatches(ledger, request, identity);
    return structuredClone(ledger);
  }

  async restore(input) {
    const submittedRequest = normalizeRequest(input);
    await this.#prepareRoot();
    await withLock(this.stateRoot, 'engine', async () => {
      const request = await this.#resolveRequest(submittedRequest);
      const identity = requestIdentity(request);
      const ledgerFile = join(this.stateRoot, 'requests', `${identity.idempotencyDigest}.json`);
      const previous = await readJson(ledgerFile);
      if (previous === null) throw new Error('AUTONODE_REQUEST_UNKNOWN');
      assertReplayMatches(previous, request, identity);
      if (previous.state !== 'ROLLED_BACK') return;
      await this.#claimNode(request, identity.idempotencyDigest);
      const restored = {
        ...initialLedger(request, identity),
        created_at: previous.created_at,
        restoration_count: (previous.restoration_count ?? 0) + 1,
        restored_from_receipt_ref: previous.rollback_receipt_ref,
      };
      await writeJsonAtomic(ledgerFile, restored);
    });
    return await this.provision(input);
  }

  async #prepareRoot() {
    await mkdir(join(this.stateRoot, 'requests'), { recursive: true });
    await mkdir(join(this.stateRoot, 'receipts'), { recursive: true });
    await mkdir(this.nodesRoot, { recursive: true });
    const marker = join(this.root, '.autonode-candidate-root');
    const existing = await readFile(marker, 'utf8').catch(() => null);
    if (existing === null) await writeFile(marker, `${AUTONODE_LEDGER_SCHEMA_VERSION}\n`, { flag: 'wx' }).catch(async (cause) => {
      if (cause?.code !== 'EEXIST') throw cause;
    });
  }

  async #claimNode(request, idempotencyDigest) {
    const identity = requestIdentity(request);
    const nodesFile = join(this.stateRoot, 'nodes.json');
    const registry = await this.#nodeRegistry();
    const existing = registry.nodes[identity.nodeId];
    if (existing !== undefined && existing.idempotency_digest !== idempotencyDigest) {
      throw new Error(`AUTONODE_NODE_ALREADY_CLAIMED:${identity.nodeId}`);
    }
    const hierarchy = requestHierarchy(request);
    registry.nodes[identity.nodeId] = {
      provisioning_request_id: request.provisioning_request_id,
      idempotency_digest: idempotencyDigest,
      line_id: request.line_id,
      parent_node_id: request.parent_node_id,
      root_node_id: hierarchy.root_node_id,
      ancestry: hierarchy.ancestry,
      level: hierarchy.level,
      signed_level: request.signed_level,
      node_directory_ref: relative(this.root, this.#nodeDirectory(request)),
      artifact: request.artifact,
      status: 'PROVISIONING',
    };
    registry.revision += 1;
    await writeJsonAtomic(nodesFile, registry);
  }

  async #nodeRegistry() {
    return await readJson(join(this.stateRoot, 'nodes.json')) ?? {
      schema_version: 'sfl.autonode-node-registry.v1',
      revision: 0,
      nodes: {},
    };
  }

  async #resourceRegistry() {
    return await readJson(join(this.stateRoot, 'resources.json')) ?? {
      schema_version: AUTONODE_RESOURCE_REGISTRY_SCHEMA_VERSION,
      revision: 0,
      allocations: {},
    };
  }

  async #resolveRequest(request) {
    if (request.schema_version !== AUTONODE_RECURSIVE_REQUEST_SCHEMA_VERSION) return request;
    const nodes = await this.#nodeRegistry();
    const parent = nodes.nodes[request.parent_node_id];
    if (parent === undefined || parent.status !== 'CANDIDATE_READY') {
      throw new Error(`AUTONODE_PARENT_NOT_READY:${request.parent_node_id}`);
    }
    if (parent.line_id !== request.line_id) throw new Error('AUTONODE_PARENT_LINE_MISMATCH');
    if (parent.level < 1 || parent.level >= 5) throw new Error('AUTONODE_CHILD_LEVEL_INVALID');
    if (canonicalJson(parent.artifact) !== canonicalJson(request.artifact)) {
      throw new Error('AUTONODE_PARENT_ARTIFACT_MISMATCH');
    }
    const signedLevel = `L${parent.level + 1}`;
    const identity = requestIdentity({ ...request, signed_level: signedLevel });
    const parentDirectory = resolveInside(this.root, parent.node_directory_ref);
    const parentManifest = await readRequiredJson(join(parentDirectory, 'manifest.json'));
    const parentResources = await readRequiredJson(join(parentDirectory, 'runtime', 'resource-plan.json'));
    const domains = request.binding_sources.domains.mode === 'INHERIT_PARENT'
      ? Object.fromEntries(parentManifest.domain_bindings.map((binding) => [
        binding.surface_ref.slice('surface:'.length),
        `${request.node_slug}.${binding.host}`,
      ]))
      : request.domains;
    const bindingSources = resolveRecursiveBindingSources(
      request,
      identity,
      parent,
      parentManifest,
      parentResources,
    );
    return Object.freeze({
      ...request,
      signed_level: signedLevel,
      domains: Object.freeze(domains),
      binding_sources: bindingSources,
      hierarchy: Object.freeze({
        root_node_id: parent.root_node_id,
        ancestry: Object.freeze([...parent.ancestry, identity.nodeId]),
        level: parent.level + 1,
      }),
    });
  }

  async #markNodeReady(request) {
    const identity = requestIdentity(request);
    const nodes = await this.#nodeRegistry();
    const fact = nodes.nodes[identity.nodeId];
    if (fact === undefined) throw new Error('AUTONODE_NODE_FACT_MISSING');
    const manifest = await readRequiredJson(join(this.#nodeDirectory(request), 'manifest.json'));
    nodes.nodes[identity.nodeId] = {
      ...fact,
      status: 'CANDIDATE_READY',
      realm_ref: manifest.realm_ref,
      data_scope_ref: manifest.data_scope_ref,
      mall_id: manifest.mall_id,
      manifest_ref: relative(this.root, join(this.#nodeDirectory(request), 'manifest.json')),
      resource_plan_ref: relative(this.root, join(this.#nodeDirectory(request), 'runtime', 'resource-plan.json')),
      release_pointer_ref: relative(this.root, join(this.#nodeDirectory(request), 'release-pointer.json')),
    };
    nodes.revision += 1;
    await writeJsonAtomic(join(this.stateRoot, 'nodes.json'), nodes);
  }

  #nodeDirectory(request) {
    return join(this.nodesRoot, `${request.node_slug}-${request.signed_level.toLowerCase()}`);
  }

  async #executeStep(step, request) {
    switch (step) {
      case 'BUSINESS_READY': return await this.#businessReady(request);
      case 'MANIFEST_READY': return await this.#manifestReady(request);
      case 'RESOURCES_PLANNED': return await this.#resourcesPlanned(request);
      case 'RUNTIME_READY': return await this.#runtimeReady(request);
      case 'RELEASE_BOUND': return await this.#releaseBound(request);
      case 'CANDIDATE_READY': return await this.#candidateReady(request);
      default: throw new Error(`AUTONODE_STEP_UNKNOWN:${step}`);
    }
  }

  async #businessReady(request) {
    const profile = 'operating_mall';
    const plan = profile === 'operating_mall'
      ? new CreateMall().plan({
        scope: request.business.scope_id,
        parent: request.business.enterprise_id,
        code: request.business.code,
        publicSlug: request.business.public_slug,
        name: request.business.name,
        actor: request.created_by.actor_id,
        actorMembership: request.created_by.membership_id,
      })
      : Object.freeze({
        scope: request.business.scope_id,
        parent: request.business.enterprise_id,
        mall: null,
        code: request.business.code,
        publicSlug: request.business.public_slug,
        name: request.business.name,
      });
    const value = Object.freeze({
      schema_version: 'sfl.autonode-business-core.v1',
      provisioning_request_id: request.provisioning_request_id,
      node_profile: profile,
      state: 'candidate',
      plan,
    });
    const file = join(this.#nodeDirectory(request), 'business-core.json');
    await writeJsonAtomic(file, value);
    return await stepOutput('BUSINESS_READY', [file], this.root);
  }

  async #manifestReady(request) {
    const identity = requestIdentity(request);
    const business = await readRequiredJson(join(this.#nodeDirectory(request), 'business-core.json'));
    const manifest = await generateNodeManifest(manifestSpec(request, identity, business));
    const file = join(this.#nodeDirectory(request), 'manifest.json');
    await writeJsonAtomic(file, manifest);
    return await stepOutput('MANIFEST_READY', [file], this.root);
  }

  async #resourcesPlanned(request) {
    const identity = requestIdentity(request);
    const registry = await this.#resourceRegistry();
    const requestedHosts = Object.values(request.domains).sort();
    const conflicting = Object.entries(registry.allocations).find(([nodeId, allocation]) =>
      nodeId !== identity.nodeId && allocation.hosts.some((host) => requestedHosts.includes(host)));
    if (conflicting !== undefined) throw new Error(`AUTONODE_DOMAIN_ALREADY_RESERVED:${conflicting[0]}`);

    let allocation = registry.allocations[identity.nodeId];
    if (allocation === undefined) {
      const occupied = new Set(Object.values(registry.allocations)
        .flatMap((entry) => Object.values(entry.ports)));
      const ports = allocatePorts(identity.nodeId, occupied);
      allocation = {
        provisioning_request_id: request.provisioning_request_id,
        hosts: requestedHosts,
        ports,
        reserved_at: request.created_at,
      };
      registry.allocations[identity.nodeId] = allocation;
      registry.revision += 1;
      await writeJsonAtomic(join(this.stateRoot, 'resources.json'), registry);
    } else if (allocation.provisioning_request_id !== request.provisioning_request_id
      || canonicalJson(allocation.hosts) !== canonicalJson(requestedHosts)) {
      throw new Error(`AUTONODE_RESOURCE_ALLOCATION_CONFLICT:${identity.nodeId}`);
    }

    const externalBindings = externalBindingPlan(request, identity);
    const bindingSources = requestBindingSources(request);
    const recursive = request.schema_version === AUTONODE_RECURSIVE_REQUEST_SCHEMA_VERSION;
    const resolutionReceipts = recursive
      ? [bindingSources.domains.resolution_receipt, bindingSources.payment.resolution_receipt]
      : [];
    const plan = Object.freeze({
      schema_version: 'sfl.autonode-resource-plan.v1',
      provisioning_request_id: request.provisioning_request_id,
      node_id: identity.nodeId,
      resource_binding_set_ref: reference(`resource-binding-set:${identity.nodeToken}`),
      local_status: 'RESERVED',
      external_status: externalBindings.length === 0
        ? 'NOT_REQUIRED'
        : externalBindings.every((binding) => binding.status === 'RESOLVED') ? 'RESOLVED' : 'WAITING_EXTERNAL',
      hierarchy: requestHierarchy(request),
      hosts: requestedHosts,
      ports: allocation.ports,
      binding_sources: bindingSources,
      effective_resources: recursive ? Object.freeze({
        domains: bindingSources.domains.effective_resource,
        payment: bindingSources.payment.effective_resource,
      }) : undefined,
      resolution_receipts: resolutionReceipts,
      external_bindings: externalBindings,
    });
    const file = join(this.#nodeDirectory(request), 'runtime', 'resource-plan.json');
    await writeJsonAtomic(file, plan);
    return await stepOutput('RESOURCES_PLANNED', [file, join(this.stateRoot, 'resources.json')], this.root);
  }

  async #runtimeReady(request) {
    const nodeDirectory = this.#nodeDirectory(request);
    const manifest = await readRequiredJson(join(nodeDirectory, 'manifest.json'));
    const resources = await readRequiredJson(join(nodeDirectory, 'runtime', 'resource-plan.json'));
    const files = [];
    const gatewayFile = join(nodeDirectory, 'runtime', 'api-gateway.Caddyfile');
    await writeTextAtomic(gatewayFile, gatewayConfiguration(manifest, nodeDirectory, resources.ports, {
      allowProvisioning: true,
    }));
    files.push(gatewayFile);

    const cloudflaredFile = join(nodeDirectory, 'runtime', 'cloudflared.yml');
    await writeTextAtomic(cloudflaredFile, cloudflaredConfiguration(
      request,
      nodeDirectory,
      resources.ports.gateway,
      resources.ports.tunnel_metrics,
    ));
    files.push(cloudflaredFile);

    const identityRegistry = identityNodeRegistry(request, manifest);
    const environment = runtimeEnvironment(request, manifest, identityRegistry, nodeDirectory, resources.ports);
    for (const [service, values] of Object.entries(environment)) {
      const file = join(nodeDirectory, 'runtime', `${service}.env`);
      await writeTextAtomic(file, `${Object.entries(values).map(([key, value]) => systemdEnvironmentLine(key, value)).join('\n')}\n`);
      files.push(file);
    }

    const systemdFile = join(nodeDirectory, 'runtime', 'systemd-instances.json');
    await writeJsonAtomic(systemdFile, systemdPlan(request, nodeDirectory, environment));
    files.push(systemdFile);
    return await stepOutput('RUNTIME_READY', files, this.root);
  }

  async #releaseBound(request) {
    const identity = requestIdentity(request);
    const nodeDirectory = this.#nodeDirectory(request);
    const manifest = await readRequiredJson(join(nodeDirectory, 'manifest.json'));
    const pointer = Object.freeze({
      schema_version: 'sfl.autonode-release-pointer.v1',
      provisioning_request_id: request.provisioning_request_id,
      node_id: identity.nodeId,
      manifest_id: manifest.manifest_id,
      manifest_version: manifest.manifest_version,
      manifest_digest: manifest.manifest_digest,
      resource_binding_set_ref: manifest.resource_binding_set_ref,
      release_pointer_ref: manifest.release_pointer_ref,
      candidate_status: 'BOUND_NOT_ACTIVATED',
    });
    const pointerFile = join(nodeDirectory, 'release-pointer.json');
    await writeJsonAtomic(pointerFile, pointer);

    const consoleRuntime = await parseSflConsoleNodeRuntime({
      schema_version: 'sfl.console-node-runtime.v1',
      source_sha: request.artifact.source_sha,
      build_id: request.artifact.build_id,
      build_count: 1,
      source_tree: request.artifact.source_tree,
      client_version: request.artifact.client_version,
      immutable_artifact_digest: request.artifact.immutable_artifact_digest,
      node_manifest: manifest,
      runtime_binding: {
        resource_binding_set_ref: manifest.resource_binding_set_ref,
        api_base_url: `https://${request.domains.api}`,
        identity_entry_url: `https://${request.domains.identity}/?target=${encodeURIComponent(`${identity.nodeId}:console`)}`,
        scope_kind: 'mall',
      },
    });
    const consoleFile = join(nodeDirectory, 'runtime', 'console-runtime.json');
    await writeJsonAtomic(consoleFile, consoleRuntime);
    const identityFile = join(nodeDirectory, 'runtime', 'identity-runtime.json');
    await writeJsonAtomic(identityFile, {
      schema_version: 'sfl.identity-node-runtime.v1',
      source_sha: request.artifact.source_sha,
      build_id: request.artifact.build_id,
      build_count: 1,
      immutable_artifact_digest: request.artifact.immutable_artifact_digest,
      identity_node_registry: identityNodeRegistry(request, manifest),
    });
    return await stepOutput('RELEASE_BOUND', [pointerFile, consoleFile, identityFile], this.root);
  }

  async #candidateReady(request) {
    const identity = requestIdentity(request);
    const nodeDirectory = this.#nodeDirectory(request);
    const manifest = await readRequiredJson(join(nodeDirectory, 'manifest.json'));
    const resources = await readRequiredJson(join(nodeDirectory, 'runtime', 'resource-plan.json'));
    const files = await fileInventory(nodeDirectory, this.root);
    const receipt = Object.freeze({
      schema_version: 'sfl.autonode-provisioning-receipt.v1',
      provisioning_request_id: request.provisioning_request_id,
      created_by_membership_id: request.created_by.membership_id,
      authorized_operation: request.created_by.authorized_operation,
      created_at: request.created_at,
      candidate_status: 'CANDIDATE_READY',
      production_status: 'PENDING_STABLE_BASELINE',
      external_status: resources.external_status,
      line_id: request.line_id,
      node_id: identity.nodeId,
      parent_node_id: request.parent_node_id,
      root_node_id: requestHierarchy(request).root_node_id,
      ancestry: requestHierarchy(request).ancestry,
      level: requestHierarchy(request).level,
      signed_level: request.signed_level,
      manifest_id: manifest.manifest_id,
      manifest_version: manifest.manifest_version,
      manifest_digest: manifest.manifest_digest,
      realm_ref: manifest.realm_ref,
      data_scope_ref: manifest.data_scope_ref,
      secret_binding_set_ref: manifest.secret_binding_set_ref,
      payment_binding_refs: manifest.payment_binding_refs,
      callback_binding_refs: manifest.callback_binding_refs,
      binding_sources: resources.binding_sources,
      runtime_instance_id: manifest.runtime_instance_id,
      release_pointer_ref: manifest.release_pointer_ref,
      source_sha: request.artifact.source_sha,
      build_id: request.artifact.build_id,
      build_count: 1,
      immutable_artifact_digest: request.artifact.immutable_artifact_digest,
      source_tree_copy_count: 0,
      node_specific_build_count: 0,
      files,
      candidate_bundle_digest: digestJson(files),
    });
    const receiptFile = join(nodeDirectory, 'receipts', 'provisioning.json');
    await writeJsonAtomic(receiptFile, receipt);
    return await stepOutput('CANDIDATE_READY', [receiptFile], this.root);
  }

  async #result(ledger) {
    const request = ledger.request;
    const nodeDirectory = this.#nodeDirectory(request);
    return Object.freeze({
      ledger: structuredClone(ledger),
      nodeDirectory,
      manifest: await readRequiredJson(join(nodeDirectory, 'manifest.json')),
      receipt: await readRequiredJson(join(nodeDirectory, 'receipts', 'provisioning.json')),
    });
  }
}

function normalizeRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('AUTONODE_REQUEST_INVALID');
  const schemaVersion = value.schema_version;
  if (schemaVersion !== AUTONODE_REQUEST_SCHEMA_VERSION
    && schemaVersion !== AUTONODE_RECURSIVE_REQUEST_SCHEMA_VERSION
    && schemaVersion !== AUTONODE_LEGACY_REQUEST_SCHEMA_VERSION) throw new Error('AUTONODE_REQUEST_SCHEMA_INVALID');
  const recursive = schemaVersion === AUTONODE_RECURSIVE_REQUEST_SCHEMA_VERSION;
  const signedLevel = recursive ? null : requiredText(value.signed_level, 'signed_level');
  if (!recursive && !/^L(?:[1-9]|1[01])$/.test(signedLevel)) throw new Error('AUTONODE_SIGNED_LEVEL_INVALID');
  if (recursive && value.signed_level !== undefined) throw new Error('AUTONODE_RECURSIVE_LEVEL_FORBIDDEN');
  const nodeSlug = requiredText(value.node_slug, 'node_slug').toLowerCase();
  if (!/^[a-z][a-z0-9-]{2,31}$/.test(nodeSlug)) throw new Error('AUTONODE_NODE_SLUG_INVALID');
  const createdAt = new Date(requiredText(value.created_at, 'created_at'));
  if (Number.isNaN(createdAt.valueOf())) throw new Error('AUTONODE_CREATED_AT_INVALID');
  const normalizedDomains = value.domains === undefined && recursive
    ? null
    : normalizeDomains(value.domains);
  const business = requiredRecord(value.business, 'business');
  const createdBy = requiredRecord(value.created_by, 'created_by');
  const artifact = requiredRecord(value.artifact, 'artifact');
  const resources = requiredRecord(value.resources, 'resources');
  const normalizedResources = Object.freeze({
    tunnel: requiredBoolean(resources.tunnel, 'resources.tunnel'),
    tls: requiredBoolean(resources.tls, 'resources.tls'),
    secrets: requiredBoolean(resources.secrets, 'resources.secrets'),
    payment: requiredBoolean(resources.payment, 'resources.payment'),
    callbacks: requiredBoolean(resources.callbacks, 'resources.callbacks'),
    ...(schemaVersion === AUTONODE_REQUEST_SCHEMA_VERSION
      ? { wechat_identity: requiredBoolean(resources.wechat_identity, 'resources.wechat_identity') }
      : {}),
  });
  const sourceSha = requiredText(artifact.source_sha, 'artifact.source_sha').toLowerCase();
  const artifactDigest = requiredText(artifact.immutable_artifact_digest, 'artifact.immutable_artifact_digest').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) throw new Error('AUTONODE_SOURCE_SHA_INVALID');
  if (!/^sha256:[0-9a-f]{64}$/.test(artifactDigest)) throw new Error('AUTONODE_ARTIFACT_DIGEST_INVALID');
  if (artifact.build_count !== 1) throw new Error('AUTONODE_BUILD_COUNT_INVALID');
  if (artifact.source_tree !== 'clean' && artifact.source_tree !== 'dirty') throw new Error('AUTONODE_SOURCE_TREE_INVALID');
  const code = requiredText(business.code, 'business.code');
  const publicSlug = requiredText(business.public_slug, 'business.public_slug');
  if (!/^[A-Z][A-Z0-9_]{2,31}$/.test(code)) throw new Error('AUTONODE_BUSINESS_CODE_INVALID');
  if (!/^[a-z0-9][a-z0-9-]{2,47}$/.test(publicSlug)) throw new Error('AUTONODE_PUBLIC_SLUG_INVALID');
  const normalized = {
    schema_version: schemaVersion,
    provisioning_request_id: requiredText(value.provisioning_request_id, 'provisioning_request_id'),
    idempotency_key: requiredText(value.idempotency_key, 'idempotency_key'),
    created_at: createdAt.toISOString(),
    line_id: requiredText(value.line_id, 'line_id'),
    parent_node_id: requiredText(value.parent_node_id, 'parent_node_id'),
    ...(recursive ? {} : { signed_level: signedLevel }),
    node_slug: nodeSlug,
    display_name: requiredText(value.display_name, 'display_name'),
    ...(normalizedDomains === null ? {} : { domains: Object.freeze(normalizedDomains) }),
    business: Object.freeze({
      scope_id: requiredText(business.scope_id, 'business.scope_id'),
      enterprise_id: requiredText(business.enterprise_id, 'business.enterprise_id'),
      code,
      public_slug: publicSlug,
      name: requiredText(business.name, 'business.name'),
    }),
    created_by: Object.freeze({
      actor_id: requiredText(createdBy.actor_id, 'created_by.actor_id'),
      membership_id: requiredText(createdBy.membership_id, 'created_by.membership_id'),
      authorized_operation: requiredText(createdBy.authorized_operation, 'created_by.authorized_operation'),
    }),
    artifact: Object.freeze({
      source_sha: sourceSha,
      build_id: requiredText(artifact.build_id, 'artifact.build_id'),
      build_count: 1,
      immutable_artifact_digest: artifactDigest,
      source_tree: artifact.source_tree,
      client_version: requiredText(artifact.client_version, 'artifact.client_version'),
    }),
    resources: normalizedResources,
  };
  if (schemaVersion === AUTONODE_REQUEST_SCHEMA_VERSION) {
    normalized.binding_sources = normalizeBindingSources(value.binding_sources, normalized.parent_node_id,
      normalizedDomains, normalizedResources);
  }
  if (recursive) {
    normalized.binding_sources = normalizeRecursiveBindingSources(
      value.binding_sources,
      normalized.parent_node_id,
      normalizedDomains,
      normalizedResources,
    );
  }
  return Object.freeze(normalized);
}

function normalizeDomains(value) {
  const domains = requiredRecord(value, 'domains');
  const normalized = Object.fromEntries(['api', 'console', 'identity', 'storefront'].map((surface) => [
    surface,
    hostName(domains[surface], surface),
  ]));
  if (new Set(Object.values(normalized)).size !== 4) throw new Error('AUTONODE_DOMAIN_AMBIGUOUS');
  return Object.freeze(normalized);
}

function normalizeRecursiveBindingSources(value, parentNodeId, domains, resources) {
  const sources = requiredRecord(value, 'binding_sources');
  const domain = requiredRecord(sources.domains, 'binding_sources.domains');
  const domainMode = bindingMode(domain.mode, 'binding_sources.domains.mode', false);
  if (domainMode === 'OWN' && domains === null) throw new Error('AUTONODE_OWN_DOMAINS_REQUIRED');
  if (domainMode === 'INHERIT_PARENT' && domains !== null) throw new Error('AUTONODE_INHERITED_DOMAINS_FORBIDDEN');
  const payment = requiredRecord(sources.payment, 'binding_sources.payment');
  const paymentMode = bindingMode(payment.mode, 'binding_sources.payment.mode', true);
  if (paymentMode === 'DISABLED' && resources.payment) {
    throw new Error('AUTONODE_BINDING_RESOURCE_MISMATCH:binding_sources.payment');
  }
  return Object.freeze({
    domains: Object.freeze({
      mode: domainMode,
      source_node_id: domainMode === 'INHERIT_PARENT' ? parentNodeId : null,
      source_binding_ref: optionalRef(domain.source_binding_ref, 'binding_sources.domains.source_binding_ref'),
      dns_ref: optionalRef(domain.dns_ref, 'binding_sources.domains.dns_ref'),
      tls_ref: optionalRef(domain.tls_ref, 'binding_sources.domains.tls_ref'),
      tunnel_ref: optionalRef(domain.tunnel_ref, 'binding_sources.domains.tunnel_ref'),
    }),
    wechat_identity: Object.freeze({
      mode: 'DISABLED', effective_status: 'DISABLED', source_node_id: null, source_binding_ref: null,
    }),
    payment: Object.freeze({
      mode: paymentMode,
      effective_status: paymentMode === 'DISABLED' ? 'DISABLED' : 'PENDING_RESOLUTION',
      source_node_id: paymentMode === 'INHERIT_PARENT' ? parentNodeId : null,
      source_binding_ref: optionalRef(payment.source_binding_ref, 'binding_sources.payment.source_binding_ref'),
      provider_ref: optionalRef(payment.provider_ref, 'binding_sources.payment.provider_ref'),
      merchant_ref: optionalRef(payment.merchant_ref, 'binding_sources.payment.merchant_ref'),
      callback_ref: optionalRef(payment.callback_ref, 'binding_sources.payment.callback_ref'),
      secret_ref: optionalRef(payment.secret_ref, 'binding_sources.payment.secret_ref'),
    }),
  });
}

function optionalRef(value, name) {
  if (value === undefined || value === null) return null;
  const ref = requiredRecord(value, name);
  return Object.freeze({
    ref: requiredText(ref.ref, `${name}.ref`),
    version: requiredText(ref.version, `${name}.version`),
  });
}

function normalizeBindingSources(value, parentNodeId, domains, resources) {
  const sources = requiredRecord(value, 'binding_sources');
  const domain = requiredRecord(sources.domains, 'binding_sources.domains');
  const domainMode = bindingMode(domain.mode, 'binding_sources.domains.mode', false);
  const baseDomain = domainName(domain.base_domain, 'binding_sources.domains.base_domain');
  if (Object.values(domains).some((host) => host !== baseDomain && !host.endsWith(`.${baseDomain}`))) {
    throw new Error('AUTONODE_DOMAIN_SOURCE_MISMATCH');
  }
  const domainSourceNodeId = sourceNodeId(domain, domainMode, parentNodeId, 'binding_sources.domains');
  return Object.freeze({
    domains: Object.freeze({
      mode: domainMode,
      base_domain: baseDomain,
      source_node_id: domainSourceNodeId,
      source_binding_ref: requiredText(domain.source_binding_ref, 'binding_sources.domains.source_binding_ref'),
    }),
    wechat_identity: normalizeOptionalBindingSource(
      sources.wechat_identity,
      'binding_sources.wechat_identity',
      resources.wechat_identity,
      parentNodeId,
    ),
    payment: normalizeOptionalBindingSource(
      sources.payment,
      'binding_sources.payment',
      resources.payment,
      parentNodeId,
    ),
  });
}

function normalizeOptionalBindingSource(value, name, enabled, parentNodeId) {
  const source = requiredRecord(value, name);
  const mode = bindingMode(source.mode, `${name}.mode`, true);
  if (mode === 'DISABLED' && enabled) throw new Error(`AUTONODE_BINDING_RESOURCE_MISMATCH:${name}`);
  if (mode === 'DISABLED') {
    if ((source.source_node_id !== undefined && source.source_node_id !== null)
      || (source.source_binding_ref !== undefined && source.source_binding_ref !== null)) {
      throw new Error(`AUTONODE_DISABLED_BINDING_SOURCE_FORBIDDEN:${name}`);
    }
    return Object.freeze({ mode, effective_status: 'DISABLED', source_node_id: null, source_binding_ref: null });
  }
  return Object.freeze({
    mode,
    effective_status: enabled ? 'ENABLED' : 'DISABLED',
    source_node_id: sourceNodeId(source, mode, parentNodeId, name),
    source_binding_ref: requiredText(source.source_binding_ref, `${name}.source_binding_ref`),
  });
}

function bindingMode(value, name, allowDisabled) {
  const mode = requiredText(value, name);
  const allowed = allowDisabled ? ['DISABLED', 'INHERIT_PARENT', 'OWN'] : ['INHERIT_PARENT', 'OWN'];
  if (!allowed.includes(mode)) throw new Error(`AUTONODE_BINDING_MODE_INVALID:${name}`);
  return mode;
}

function sourceNodeId(source, mode, parentNodeId, name) {
  if (mode === 'INHERIT_PARENT') {
    const sourceNode = requiredText(source.source_node_id, `${name}.source_node_id`);
    if (sourceNode !== parentNodeId) throw new Error(`AUTONODE_PARENT_BINDING_SOURCE_MISMATCH:${name}`);
    return sourceNode;
  }
  if (source.source_node_id !== undefined && source.source_node_id !== null) {
    throw new Error(`AUTONODE_OWN_BINDING_SOURCE_NODE_FORBIDDEN:${name}`);
  }
  return null;
}

function requestBindingSources(request) {
  if (request.binding_sources !== undefined) return request.binding_sources;
  return Object.freeze({
    domains: Object.freeze({
      mode: 'LEGACY_DIRECT',
      base_domain: null,
      source_node_id: null,
      source_binding_ref: null,
    }),
    wechat_identity: Object.freeze({
      mode: 'LEGACY_DIRECT',
      effective_status: 'ENABLED',
      source_node_id: null,
      source_binding_ref: null,
    }),
    payment: Object.freeze({
      mode: request.resources.payment ? 'LEGACY_DIRECT' : 'DISABLED',
      effective_status: request.resources.payment ? 'ENABLED' : 'DISABLED',
      source_node_id: null,
      source_binding_ref: null,
    }),
  });
}

function resolveRecursiveBindingSources(request, identity, parent, parentManifest, parentResources) {
  const domain = request.binding_sources.domains;
  const parentDomainRef = parentManifest.resource_binding_set_ref;
  const ownDomainRefs = [domain.source_binding_ref, domain.dns_ref, domain.tls_ref, domain.tunnel_ref];
  const domainResolved = domain.mode === 'INHERIT_PARENT'
    ? parentManifest.domain_bindings.length > 0 && parentDomainRef?.ref && parentDomainRef?.version
    : ownDomainRefs.every((value) => value !== null);
  const effectiveDomain = domain.mode === 'INHERIT_PARENT'
    ? {
      ref: parentDomainRef.ref,
      version: parentDomainRef.version,
      dns_ref: parentResources.effective_resources?.domains?.dns_ref ?? null,
      tls_ref: parentResources.effective_resources?.domains?.tls_ref ?? null,
      tunnel_ref: parentResources.effective_resources?.domains?.tunnel_ref ?? null,
    }
    : {
      ref: domain.source_binding_ref?.ref ?? null,
      version: domain.source_binding_ref?.version ?? null,
      dns_ref: domain.dns_ref,
      tls_ref: domain.tls_ref,
      tunnel_ref: domain.tunnel_ref,
    };

  const payment = request.binding_sources.payment;
  const parentPaymentRef = parentManifest.payment_binding_refs[0] ?? null;
  const ownPaymentRefs = [payment.source_binding_ref, payment.provider_ref, payment.merchant_ref,
    payment.callback_ref, payment.secret_ref];
  const paymentResolved = payment.mode === 'DISABLED'
    || (payment.mode === 'INHERIT_PARENT'
      ? parentPaymentRef !== null
      : ownPaymentRefs.every((value) => value !== null));
  const effectivePayment = payment.mode === 'DISABLED'
    ? null
    : payment.mode === 'INHERIT_PARENT'
      ? {
        ref: parentPaymentRef?.ref ?? null,
        version: parentPaymentRef?.version ?? null,
        provider_ref: parentResources.effective_resources?.payment?.provider_ref ?? null,
        merchant_ref: parentResources.effective_resources?.payment?.merchant_ref ?? null,
        callback_ref: parentResources.effective_resources?.payment?.callback_ref ?? null,
        secret_ref: null,
      }
      : {
        ref: payment.source_binding_ref?.ref ?? null,
        version: payment.source_binding_ref?.version ?? null,
        provider_ref: payment.provider_ref,
        merchant_ref: payment.merchant_ref,
        callback_ref: payment.callback_ref,
        secret_ref: payment.secret_ref,
      };
  const resolvedAt = request.created_at;
  const domainReceipt = Object.freeze({
    schema_version: 'sfl.autonode-resource-resolution-receipt.v1',
    kind: 'domains',
    node_id: identity.nodeId,
    mode: domain.mode,
    source_node_id: domain.mode === 'INHERIT_PARENT' ? request.parent_node_id : identity.nodeId,
    source_ref: effectiveDomain.ref,
    source_version: effectiveDomain.version,
    status: domainResolved ? 'RESOLVED' : 'WAITING_EXTERNAL',
    resolved_at: domainResolved ? resolvedAt : null,
  });
  const paymentReceipt = Object.freeze({
    schema_version: 'sfl.autonode-resource-resolution-receipt.v1',
    kind: 'payment',
    node_id: identity.nodeId,
    mode: payment.mode,
    source_node_id: payment.mode === 'INHERIT_PARENT' ? request.parent_node_id : payment.mode === 'OWN' ? identity.nodeId : null,
    source_ref: effectivePayment?.ref ?? null,
    source_version: effectivePayment?.version ?? null,
    status: paymentResolved ? 'RESOLVED' : 'WAITING_EXTERNAL',
    resolved_at: paymentResolved ? resolvedAt : null,
  });
  return Object.freeze({
    domains: Object.freeze({
      ...domain,
      source_node_id: domainReceipt.source_node_id,
      source_binding_ref: effectiveDomain.ref,
      source_version: effectiveDomain.version,
      resolution_status: domainReceipt.status,
      effective_resource: Object.freeze(effectiveDomain),
      resolution_receipt: domainReceipt,
    }),
    wechat_identity: request.binding_sources.wechat_identity,
    payment: Object.freeze({
      ...payment,
      source_node_id: paymentReceipt.source_node_id,
      source_binding_ref: effectivePayment?.ref ?? null,
      source_version: effectivePayment?.version ?? null,
      effective_status: payment.mode === 'DISABLED' ? 'DISABLED' : 'ENABLED',
      resolution_status: paymentReceipt.status,
      effective_resource: effectivePayment === null ? null : Object.freeze(effectivePayment),
      resolution_receipt: paymentReceipt,
    }),
  });
}

function requestIdentity(request) {
  const level = request.signed_level.toLowerCase();
  const nodeToken = `${request.node_slug}:${level}`;
  return Object.freeze({
    nodeId: `node:${nodeToken}`,
    nodeToken,
    runtimeInstance: `${request.node_slug}-${level}`,
    idempotencyDigest: sha256(request.idempotency_key),
    requestDigest: digestJson(request),
  });
}

function requestHierarchy(request) {
  if (request.hierarchy !== undefined) return request.hierarchy;
  const identity = requestIdentity(request);
  return Object.freeze({
    root_node_id: request.parent_node_id,
    ancestry: Object.freeze([request.parent_node_id, identity.nodeId]),
    level: Number(request.signed_level.slice(1)),
  });
}

function initialLedger(request, identity) {
  const acceptedAt = new Date().toISOString();
  return {
    schema_version: AUTONODE_LEDGER_SCHEMA_VERSION,
    provisioning_request_id: request.provisioning_request_id,
    idempotency_digest: identity.idempotencyDigest,
    request_digest: identity.requestDigest,
    request: withoutIdempotencyKey(request),
    node_id: identity.nodeId,
    state: 'ACCEPTED',
    attempts: { ACCEPTED: 1 },
    step_receipts: [{
      step: 'ACCEPTED',
      attempt: 1,
      completed_at: acceptedAt,
      output_refs: [],
      receipt_digest: digestJson({ request_digest: identity.requestDigest }),
    }],
    last_error: null,
    rollback_receipt_ref: null,
    created_at: acceptedAt,
    updated_at: acceptedAt,
  };
}

function assertReplayMatches(ledger, request, identity) {
  if (ledger.schema_version !== AUTONODE_LEDGER_SCHEMA_VERSION
    || ledger.provisioning_request_id !== request.provisioning_request_id
    || ledger.idempotency_digest !== identity.idempotencyDigest
    || ledger.request_digest !== identity.requestDigest) {
    throw new Error('AUTONODE_IDEMPOTENCY_CONFLICT');
  }
}

function incrementAttempt(ledger, step) {
  const attempts = { ...ledger.attempts, [step]: (ledger.attempts[step] ?? 0) + 1 };
  return { ...ledger, attempts, last_error: null, updated_at: new Date().toISOString() };
}

function completeStep(ledger, step, output) {
  const completedAt = new Date().toISOString();
  return {
    ...ledger,
    state: step,
    step_receipts: [...ledger.step_receipts, {
      step,
      attempt: ledger.attempts[step],
      completed_at: completedAt,
      ...output,
    }],
    last_error: null,
    updated_at: completedAt,
  };
}

function recordFailure(ledger, step, cause) {
  return {
    ...ledger,
    last_error: {
      step,
      attempt: ledger.attempts[step],
      message: cause instanceof Error ? cause.message : String(cause),
      recorded_at: new Date().toISOString(),
    },
    updated_at: new Date().toISOString(),
  };
}

function stepIndex(state) {
  const index = AUTONODE_PROVISIONING_STEPS.indexOf(state);
  if (index < 0) throw new Error(`AUTONODE_LEDGER_STATE_INVALID:${state}`);
  return index;
}

function manifestSpec(request, identity, business) {
  const profile = 'operating_mall';
  const bindingSources = requestBindingSources(request);
  const mallId = profile === 'operating_mall' ? business.plan.mall : null;
  const domainBindings = Object.entries(request.domains).map(([surface, host]) => ({
    host,
    binding_ref: reference(`domain:${identity.nodeToken}:${surface}`),
    application_ref: `application:${surface}`,
    surface_ref: `surface:${surface}`,
  }));
  return {
    manifest_id: `manifest:${identity.nodeToken}:v1`,
    manifest_revision: 1,
    generated_at: request.created_at,
    lifecycle_status: 'provisioning',
    line_id: request.line_id,
    node_id: identity.nodeId,
    parent_node_id: request.parent_node_id,
    signed_level: request.signed_level,
    node_profile: profile,
    mall_id: mallId,
    host_node_id: null,
    domain_bindings: domainBindings,
    brand_ref: reference(`brand:${identity.nodeToken}`),
    applications: Object.keys(request.domains).map((surface) => reference(`application:${surface}`)),
    surfaces: Object.keys(request.domains).map((surface) => reference(`surface:${surface}`)),
    enabled_features: [
      'catalog',
      'checkout',
      'commerce',
      'console',
      'identity',
      'storefront',
      ...(request.resources.wechat_identity ? ['wechat-identity'] : []),
      ...(request.resources.payment ? ['payment'] : []),
    ].map((feature) => reference(`feature:${feature}`)),
    api_contract_refs: [{ ref: 'contract:commerce-api', version: '1.0.0' }],
    realm_ref: reference(`realm:${request.node_slug}-${request.signed_level.toLowerCase()}`),
    data_scope_ref: reference(mallId ?? `scope:${identity.nodeToken}`),
    resource_binding_set_ref: reference(`resource-binding-set:${identity.nodeToken}`),
    secret_binding_set_ref: reference(`${nodeSecretPrefix(identity)}/secrets`),
    payment_binding_refs: request.resources.payment ? [
      request.schema_version === AUTONODE_RECURSIVE_REQUEST_SCHEMA_VERSION
        && bindingSources.payment.effective_resource?.ref
        ? {
          ref: bindingSources.payment.effective_resource.ref,
          version: bindingSources.payment.effective_resource.version,
        }
        : reference(`payment-binding:${identity.nodeToken}`),
    ] : [],
    callback_binding_refs: request.resources.callbacks ? [reference(`callback-binding:${identity.nodeToken}`)] : [],
    runtime_instance_id: `runtime:${identity.nodeToken}:commerce`,
    runtime_config_ref: reference(`runtime-config:${identity.nodeToken}`),
    release_pointer_ref: {
      ref: `release:${identity.nodeToken}`,
      version: '1',
      source_sha: request.artifact.source_sha,
      build_id: request.artifact.build_id,
      build_count: 1,
      immutable_artifact_digest: request.artifact.immutable_artifact_digest,
    },
  };
}

function externalBindingPlan(request, identity) {
  const bindingSources = requestBindingSources(request);
  const recursive = request.schema_version === AUTONODE_RECURSIVE_REQUEST_SCHEMA_VERSION;
  const domainStatus = recursive ? bindingSources.domains.resolution_status : 'WAITING_EXTERNAL';
  const paymentStatus = recursive ? bindingSources.payment.resolution_status : 'WAITING_EXTERNAL';
  const bindings = Object.entries(request.domains).map(([surface, host]) => ({
    kind: 'domain',
    ref: `domain:${identity.nodeToken}:${surface}`,
    host,
    source_mode: bindingSources.domains.mode,
    source_node_id: bindingSources.domains.source_node_id,
    source_binding_ref: bindingSources.domains.source_binding_ref,
    status: domainStatus,
  }));
  const referenceByKind = {
    tunnel: `tunnel-binding:${identity.nodeToken}`,
    tls: `tls-binding:${identity.nodeToken}`,
    secrets: `${nodeSecretPrefix(identity)}/secrets`,
    wechat_identity: `wechat-identity-binding:${identity.nodeToken}`,
    payment: `payment-binding:${identity.nodeToken}`,
    callbacks: `callback-binding:${identity.nodeToken}`,
  };
  for (const [kind, requested] of Object.entries(request.resources)) {
    if (!requested) continue;
    const source = kind === 'wechat_identity' || kind === 'payment'
      ? bindingSources[kind]
      : null;
    bindings.push({
      kind,
      ref: referenceByKind[kind],
      ...(source === null ? {} : {
        source_mode: source.mode,
        source_node_id: source.source_node_id,
        source_binding_ref: source.source_binding_ref,
      }),
      status: recursive
        ? ['tunnel', 'tls'].includes(kind) ? domainStatus
          : ['payment', 'callbacks'].includes(kind) ? paymentStatus
            : 'RESOLVED'
        : 'WAITING_EXTERNAL',
    });
  }
  return bindings;
}

function allocatePorts(nodeId, occupied) {
  const capacity = PORT_MAXIMUM - PORT_MINIMUM + 1;
  const start = Number.parseInt(sha256(nodeId).slice(0, 8), 16) % capacity;
  const ports = {};
  let cursor = start;
  for (const name of AUTONODE_PORT_NAMES) {
    let selected = null;
    for (let scanned = 0; scanned < capacity; scanned += 1) {
      const candidate = PORT_MINIMUM + (cursor % capacity);
      cursor += 1;
      if (!occupied.has(candidate)) {
        selected = candidate;
        occupied.add(candidate);
        break;
      }
    }
    if (selected === null) throw new Error('AUTONODE_PORT_CAPACITY_EXHAUSTED');
    ports[name] = selected;
  }
  return ports;
}

function runtimeEnvironment(request, manifest, identityRegistry, nodeDirectory, ports) {
  const consumerApplication = identityRegistry.nodes.find((node) => node.nodeId === manifest.node_id)
    ?.consumerApplication ?? request.business.public_slug;
  const shared = {
    APP_ENV: 'candidate',
    SFL_NODE_ID: manifest.node_id,
    NODE_MANIFEST_PATH: join(nodeDirectory, 'manifest.json'),
    NODE_MANIFEST_ID: manifest.manifest_id,
    NODE_MANIFEST_DIGEST: manifest.manifest_digest,
    NODE_RUNTIME_INSTANCE_ID: manifest.runtime_instance_id,
    NODE_RUNTIME_CONFIG_REF: manifest.runtime_config_ref.ref,
    NODE_RESOURCE_BINDING_VERSION: manifest.resource_binding_set_ref.version,
    NODE_RELEASE_POINTER_REF: manifest.release_pointer_ref.ref,
  };
  const withPort = (port) => ({ ...shared, API_BIND_HOST: '127.0.0.1', API_PORT: String(port) });
  const hosts = (surface) => manifest.domain_bindings
    .filter((binding) => binding.surface_ref === `surface:${surface}`)
    .map((binding) => `https://${binding.host}`);
  const apiOrigin = hosts('api')[0];
  const identityOrigin = hosts('identity')[0];
  const consoleOrigin = hosts('console')[0];
  const storefrontOrigins = hosts('storefront');
  const environment = {
    storefront: {
      ...shared,
      STOREFRONT_PORT: String(ports.storefront),
      NEXT_PUBLIC_API_BASE_URL: apiOrigin,
      NEXT_PUBLIC_AUTH_ORIGIN: identityOrigin,
      NEXT_PUBLIC_CLIENT_VERSION: manifest.release_pointer_ref.build_id,
      NEXT_PUBLIC_STOREFRONT_HOSTNAME: new URL(storefrontOrigins[0]).hostname,
      NEXT_PUBLIC_STOREFRONT_APPLICATION: consumerApplication,
      NEXT_PUBLIC_IDENTITY_NODE_REGISTRY: JSON.stringify(identityRegistry),
      SFL_STOREFRONT_HOSTNAME: new URL(storefrontOrigins[0]).hostname,
      SFL_STOREFRONT_APPLICATION: consumerApplication,
      SFL_STOREFRONT_IDENTITY_NODE_REGISTRY: JSON.stringify(identityRegistry),
    },
    'catalog-api': { ...withPort(ports.catalog), API_ALLOWED_ORIGINS: consoleOrigin },
    'web-api': { ...withPort(ports.web), API_ALLOWED_ORIGINS: [consoleOrigin, ...storefrontOrigins].join(',') },
    'identity-api': {
      ...withPort(ports.identity),
      API_ALLOWED_ORIGINS: [identityOrigin, consoleOrigin, ...storefrontOrigins].join(','),
      NODE_IDENTITY_RUNTIME_PATH: join(nodeDirectory, 'runtime', 'identity-runtime.json'),
    },
    'purchase-api': { ...withPort(ports.purchase), API_ALLOWED_ORIGINS: storefrontOrigins.join(',') },
    'payment-webhook-api': withPort(ports.webhook),
    'catalog-jobs': shared,
    'payment-jobs': shared,
    'object-store': {
      ...shared,
      LOCAL_OBJECTS_PORT: String(ports.object_store),
      LOCAL_OBJECTS_DIRECTORY: `/var/lib/sfl-${basename(nodeDirectory)}-objects`,
    },
  };
  if (!request.resources.payment) {
    delete environment['payment-webhook-api'];
    delete environment['payment-jobs'];
  }
  return environment;
}

function nodeSecretPrefix(identity) {
  return identity.nodeToken.replace(':', '/nodes/');
}

function identityNodeRegistry(request, manifest) {
  const declaredNode = IDENTITY_NODE_MANIFEST.nodes.find((node) => node.nodeId === manifest.node_id);
  const consumerApplication = declaredNode?.targets.find((target) => target.surface === 'consumer')
    ?.application ?? request.business.public_slug;
  const origins = (surface) => manifest.domain_bindings
    .filter((binding) => binding.surface_ref === `surface:${surface}`)
    .map((binding) => `https://${binding.host}`);
  return parseIdentityNodeRegistry(JSON.stringify({
    version: 2,
    nodes: [{
      nodeId: manifest.node_id,
      nodeProfile: manifest.node_profile,
      displayName: request.business.name,
      mallName: request.business.name,
      brandName: request.business.name,
      accountsOrigin: origins('identity')[0],
      apiOrigin: origins('api')[0],
      consumerApiOrigin: origins('api')[0],
      storefrontOrigin: origins('storefront')[0],
      storefrontHosts: origins('storefront').map((origin) => new URL(origin).hostname),
      consumerTarget: 'storefront',
      consumerApplication,
      mallId: manifest.mall_id,
      hostNodeId: null,
      adminOrigin: origins('console')[0],
      adminTarget: 'console',
    }],
  }));
}

function systemdEnvironmentLine(key, value) {
  const escaped = String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
  return `${key}="${escaped}"`;
}

function systemdPlan(request, nodeDirectory, environment) {
  const instance = requestIdentity(request).runtimeInstance;
  const unitByService = {
    'api-gateway': 'sfl-api-gateway',
    storefront: 'sfl-storefront',
    'catalog-api': 'sfl-catalog-api',
    'web-api': 'sfl-web-api',
    'identity-api': 'sfl-identity-api',
    'purchase-api': 'sfl-purchase-api',
    'payment-webhook-api': 'sfl-payment-webhook-api',
    'catalog-jobs': 'sfl-catalog-jobs',
    'payment-jobs': 'sfl-payment-jobs',
    'object-store': 'sfl-catalog-object-store',
    cloudflared: 'sfl-cloudflared',
  };
  const services = [...Object.keys(environment), 'api-gateway', 'cloudflared'];
  return {
    schema_version: 'sfl.autonode-systemd-plan.v1',
    node_id: requestIdentity(request).nodeId,
    status: 'NOT_INSTALLED',
    instances: services.map((service) => ({
      service,
      unit: `${unitByService[service]}@${instance}.service`,
      environment_file: Object.hasOwn(environment, service)
        ? join(nodeDirectory, 'runtime', `${service}.env`)
        : null,
    })),
  };
}

function cloudflaredConfiguration(request, nodeDirectory, gatewayPort, metricsPort) {
  const hosts = Object.values(request.domains).sort();
  return `# Candidate only. External binding remains WAITING_EXTERNAL.\n` +
    `tunnel: \${SFL_TUNNEL_ID}\n` +
    `credentials-file: ${nodeDirectory}/tunnel/credentials.json\n` +
    `metrics: 127.0.0.1:${metricsPort}\n` +
    `no-autoupdate: true\n\n` +
    `originRequest:\n` +
    `  matchSNItoHost: true\n` +
    `  caPool: ${nodeDirectory}/runtime/tls/origin-ca.crt\n` +
    `  connectTimeout: 5s\n\n` +
    `ingress:\n${hosts.map((host) => `  - hostname: ${host}\n    service: https://127.0.0.1:${gatewayPort}`).join('\n')}\n` +
    `  - service: http_status:404\n`;
}

async function stepOutput(step, files, root) {
  const inventory = await Promise.all(files.map(async (file) => ({
    path: relative(root, file),
    digest: await digestFile(file),
  })));
  inventory.sort((left, right) => left.path.localeCompare(right.path));
  return {
    output_refs: inventory.map((entry) => entry.path),
    receipt_digest: digestJson({ step, inventory }),
  };
}

async function fileInventory(directory, root) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await fileInventory(path, root));
    else if (entry.isFile()) files.push({ path: relative(root, path), digest: await digestFile(path) });
  }
  return files;
}

async function withLock(stateRoot, name, action) {
  const locksRoot = join(stateRoot, 'locks');
  const lock = join(locksRoot, `${name}.lock`);
  await mkdir(locksRoot, { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    try {
      await mkdir(lock);
      await writeFile(join(lock, 'owner.json'), `${JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() })}\n`);
      break;
    } catch (cause) {
      if (cause?.code !== 'EEXIST') throw cause;
      const lockStat = await stat(lock).catch((statCause) => {
        if (statCause?.code === 'ENOENT') return null;
        throw statCause;
      });
      if (lockStat === null) continue;
      const age = Date.now() - lockStat.mtimeMs;
      if (age > LOCK_STALE_MS) {
        const stale = `${lock}.stale-${process.pid}-${randomUUID()}`;
        await rename(lock, stale).catch((renameCause) => {
          if (renameCause?.code !== 'ENOENT') throw renameCause;
        });
        await rm(stale, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error('AUTONODE_ENGINE_BUSY');
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
  await writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeTextAtomic(file, value) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.autonode-write.tmp`;
  await writeFile(temporary, value, 'utf8');
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

function candidateRootPath(value) {
  const path = requiredText(value, 'candidate root');
  if (!isAbsolute(path)) throw new Error('AUTONODE_CANDIDATE_ROOT_MUST_BE_ABSOLUTE');
  const normalized = resolve(path);
  if (normalized === sep || normalized === '/opt' || normalized.startsWith('/opt/')
    || normalized === '/etc' || normalized.startsWith('/etc/')) {
    throw new Error('AUTONODE_CANDIDATE_ROOT_FORBIDDEN');
  }
  return normalized;
}

function resolveInside(root, reference) {
  const path = resolve(root, requiredText(reference, 'receipt reference'));
  if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error('AUTONODE_REFERENCE_OUTSIDE_ROOT');
  return path;
}

function withoutIdempotencyKey(request) {
  const { idempotency_key: _idempotencyKey, ...safe } = request;
  return structuredClone(safe);
}

function reference(ref) {
  return Object.freeze({ ref, version: '1' });
}

function requiredRecord(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`AUTONODE_FIELD_INVALID:${name}`);
  return value;
}

function requiredText(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`AUTONODE_FIELD_INVALID:${name}`);
  return value.trim();
}

function requiredBoolean(value, name) {
  if (typeof value !== 'boolean') throw new Error(`AUTONODE_FIELD_INVALID:${name}`);
  return value;
}

function hostName(value, surface) {
  const host = requiredText(value, `domains.${surface}`).toLowerCase();
  if (!/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(host)) {
    throw new Error(`AUTONODE_DOMAIN_INVALID:${surface}`);
  }
  return host;
}

function domainName(value, name) {
  const domain = requiredText(value, name).toLowerCase();
  if (!/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(domain)) {
    throw new Error(`AUTONODE_DOMAIN_SOURCE_INVALID:${name}`);
  }
  return domain;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function digestJson(value) {
  return `sha256:${sha256(canonicalJson(value))}`;
}

async function digestFile(file) {
  return `sha256:${createHash('sha256').update(await readFile(file)).digest('hex')}`;
}
