import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Resolver } from 'node:dns/promises';
import {
  chmod,
  cp,
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
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { catalogOperatorApiEnvironment } from '../../../01_core_hexin/packages/config/src/CatalogOperatorApiEnvironment.ts';
import { identityRegistrationApiEnvironment } from '../../../01_core_hexin/packages/config/src/IdentityRegistrationApiEnvironment.ts';
import { paymentWebhookApiEnvironment } from '../../../01_core_hexin/packages/config/src/PaymentWebhookApiEnvironment.ts';
import { purchaseApiEnvironment } from '../../../01_core_hexin/packages/config/src/PurchaseApiEnvironment.ts';
import { webBusinessApiEnvironment } from '../../../01_core_hexin/packages/config/src/WebBusinessApiEnvironment.ts';
import { parseSflConsoleNodeRuntime } from '../../../01_core_hexin/packages/config/src/SflNodeKernelConsole.ts';
import { gatewayConfiguration } from '../release/generate-sfl-node-gateway.mjs';
import {
  expectedIdentityNodeDatabaseManifest,
  loadIdentityNodeRuntimeDefinition,
} from '../../../01_core_hexin/services/commerce/src/bootstrap/IdentityNodeManifestRuntime.ts';
import { AutoNodeCloudflareClient } from './autonode-cloudflare.mjs';
import { nodeActivationTunnelName } from './autonode-activation-engine.mjs';
import { activateCandidateNodeManifest } from './autonode-engine.mjs';

export const AUTONODE_RUNTIME_PROFILE_SCHEMA_VERSION = 'sfl.autonode-runtime-profile.v1';
export const AUTONODE_PROVIDER_RECEIPT_SCHEMA_VERSION = 'sfl.autonode-provider-receipt.v1';

const SERVICE_ENVIRONMENT_VALIDATORS = Object.freeze({
  'catalog-api': catalogOperatorApiEnvironment,
  'web-api': webBusinessApiEnvironment,
  'identity-api': identityRegistrationApiEnvironment,
  'purchase-api': purchaseApiEnvironment,
  'payment-webhook-api': paymentWebhookApiEnvironment,
});

const SERVICE_CONSTANTS = Object.freeze({
  'catalog-api': { CATALOG_OPERATOR_API_PROFILE: 'catalog-operator-only' },
  'web-api': { WEB_BUSINESS_API_PROFILE: 'web-business-only', AUTH_MODE: 'membership' },
  'identity-api': { IDENTITY_REGISTRATION_API_PROFILE: 'registration-only', AUTH_MODE: 'membership' },
  'purchase-api': { PURCHASE_API_PROFILE: 'purchase-only', AUTH_MODE: 'membership' },
  'payment-webhook-api': { PAYMENT_WEBHOOK_API_PROFILE: 'payment-webhook-only' },
});

const SERVICE_SECRET_REFERENCES = Object.freeze({
  'catalog-api': ['DATABASE_API_CONNECTION_REF'],
  'web-api': ['DATABASE_API_CONNECTION_REF'],
  'identity-api': [
    'DATABASE_API_CONNECTION_REF',
    'SESSION_KEY_REF',
    'IDENTITY_KEY_REF',
  ],
  'purchase-api': ['DATABASE_API_CONNECTION_REF', 'QUOTE_KEY_REF'],
  'catalog-jobs': ['DATABASE_JOB_CONNECTION_REF'],
});

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

export class ProductionNodeActivationProvider {
  constructor(providerStateRoot, options = {}) {
    this.root = providerStatePath(providerStateRoot);
    this.fetcher = options.fetcher ?? fetch;
    this.runner = options.runner ?? runCommand;
    this.publicDnsLookup = options.publicDnsLookup ?? resolvePublicIpv4;
    this.environment = options.environment ?? process.env;
    this.identityRegistry = options.identityRegistry ?? new PgNodeIdentityRegistry(this.environment);
  }

  async preflight(context) {
    const waiting = [];
    const request = context.request;
    if (request.target.environment === 'production' && request.target.node_root !== '/opt/sfl/nodes') {
      waiting.push('production-node-root:/opt/sfl/nodes');
    }
    if (request.target.environment === 'production' && request.target.systemd_unit_root !== '/etc/systemd/system') {
      waiting.push('systemd-unit-root:/etc/systemd/system');
    }
    const profile = await readJson(request.target.runtime_profile_ref).catch(() => null);
    if (profile === null) return Object.freeze([...waiting, 'runtime-profile'].sort());
    let parsed;
    try {
      parsed = parseRuntimeProfile(profile, request);
    } catch (cause) {
      return Object.freeze([...waiting, `runtime-profile:${errorMessage(cause)}`].sort());
    }
    if (!await exists(request.target.release_directory)) waiting.push('immutable-release');
    for (const file of [parsed.tls.certificate_file, parsed.tls.private_key_file, parsed.tls.ca_file]) {
      if (!await exists(file)) waiting.push(`tls-file:${file}`);
    }
    if (parsed.identity_registry.ssl_ca_file !== null && !await exists(parsed.identity_registry.ssl_ca_file)) {
      waiting.push(`identity-registry-ca:${parsed.identity_registry.ssl_ca_file}`);
    }
    if (!requiredEnvironmentValue(this.environment, parsed.cloudflare.api_token_env)) {
      waiting.push(`cloudflare-token:${parsed.cloudflare.api_token_env}`);
    }
    if (!requiredEnvironmentValue(this.environment, parsed.identity_registry.connection_string_env)) {
      waiting.push(`identity-registry:${parsed.identity_registry.connection_string_env}`);
    }
    for (const binary of [
      parsed.commands.systemctl,
      parsed.commands.caddy,
      parsed.commands.cloudflared,
      parsed.commands.curl,
      parsed.commands.chown,
    ]) {
      if (!await exists(binary)) waiting.push(`command:${binary}`);
    }
    const systemd = await readJson(join(context.candidate.nodeDirectory, 'runtime', 'systemd-instances.json'));
    const interpolation = interpolationValues(context, context.candidate.manifest);
    const secretBinding = context.candidate.manifest.secret_binding_set_ref.ref;
    const secretPrefix = secretBinding.endsWith('/secrets')
      ? secretBinding.slice(0, -'secrets'.length)
      : `${secretBinding}/`;
    for (const { service, environment_file: environmentFile } of systemd.instances) {
      if (environmentFile !== null && !Object.hasOwn(parsed.services, service)) {
        waiting.push(`runtime-service:${service}`);
      }
      const serviceEnvironment = Object.hasOwn(parsed.services, service)
        ? interpolateRecord(parsed.services[service], interpolation)
        : {};
      for (const key of SERVICE_SECRET_REFERENCES[service] ?? []) {
        const reference = serviceEnvironment[key];
        if (typeof reference !== 'string' || !reference.startsWith(secretPrefix)) {
          waiting.push(`runtime-secret-binding:${service}:${key}`);
        }
      }
      if (service === 'identity-api') {
        const enabled = request.provisioning_request.resources.wechat_identity ?? true;
        for (const key of ['WECHAT_APPLICATION_CONFIG_REF', 'WECHAT_IDENTITY_CONFIG_REF']) {
          const reference = serviceEnvironment[key];
          if (!enabled) {
            if (reference !== undefined) waiting.push(`runtime-wechat-disabled:${key}`);
          } else if (typeof reference !== 'string' || !reference.startsWith(secretPrefix)) {
            waiting.push(`runtime-secret-binding:${service}:${key}`);
          }
        }
      }
      const template = unitTemplateName(systemd.instances.find((entry) => entry.service === service).unit);
      const source = join(request.target.release_directory,
        '02_platform_pingtai/infrastructure/zhudatuan/aliyun/systemd', template);
      const destination = join(request.target.systemd_unit_root, template);
      const sourceExists = await exists(source);
      const destinationExists = await exists(destination);
      if (!sourceExists && !destinationExists) waiting.push(`systemd-template:${template}`);
      if (sourceExists && destinationExists && await digestFile(source) !== await digestFile(destination)) {
        waiting.push(`systemd-template-conflict:${template}`);
      }
    }
    return Object.freeze([...new Set(waiting)].sort());
  }

  async apply(step, context, invocationId) {
    await this.#prepare();
    const existing = await readJson(this.#receiptFile(invocationId));
    if (existing !== null) return existing;
    const profile = parseRuntimeProfile(await readRequiredJson(context.request.target.runtime_profile_ref), context.request);
    const details = await this.#applyStep(step, context, profile, invocationId);
    const receipt = Object.freeze({
      schema_version: AUTONODE_PROVIDER_RECEIPT_SCHEMA_VERSION,
      status: 'APPLIED',
      step,
      invocation_id: invocationId,
      activation_request_id: context.request.activation_request_id,
      node_id: context.plan.node_id,
      details,
      applied_at: new Date().toISOString(),
    });
    await writeJsonAtomic(this.#receiptFile(invocationId), receipt, 0o600);
    return receipt;
  }

  async rollback(step, context, providerReceipt, invocationId) {
    await this.#prepare();
    const existing = await readJson(this.#receiptFile(invocationId));
    if (existing !== null) return existing;
    const profile = parseRuntimeProfile(await readRequiredJson(context.request.target.runtime_profile_ref), context.request);
    const details = await this.#rollbackStep(step, context, profile, providerReceipt.details ?? {}, invocationId);
    const receipt = Object.freeze({
      schema_version: AUTONODE_PROVIDER_RECEIPT_SCHEMA_VERSION,
      status: 'ROLLED_BACK',
      step,
      invocation_id: invocationId,
      activation_request_id: context.request.activation_request_id,
      node_id: context.plan.node_id,
      details,
      rolled_back_at: new Date().toISOString(),
    });
    await writeJsonAtomic(this.#receiptFile(invocationId), receipt, 0o600);
    return receipt;
  }

  async rollbackInterrupted(step, context, interruptedInvocationId, rollbackInvocationId) {
    if (['RUNTIME_CONFIGURED', 'TLS_BOUND', 'HEALTH_VERIFIED'].includes(step)) {
      return await this.rollback(step, context, { details: {} }, rollbackInvocationId);
    }
    if (step !== 'PROCESSES_READY') {
      throw new Error(`AUTONODE_PRODUCTION_INTERRUPTED_ROLLBACK_UNSUPPORTED:${step}`);
    }
    const systemd = await readRequiredJson(join(
      context.plan.node_directory,
      'runtime',
      'systemd-instances.json',
    ));
    const journal = await readJson(this.#journalFile(interruptedInvocationId)) ?? { initial_active: {} };
    return await this.rollback(step, context, {
      details: {
        units: systemd.instances.map(({ unit }) => ({
          unit,
          active_before: journal.initial_active[unit] === true,
        })),
      },
    }, rollbackInvocationId);
  }

  async #applyStep(step, context, profile, invocationId) {
    switch (step) {
      case 'FILES_MATERIALIZED': return await this.#materializeFiles(context, invocationId);
      case 'RELEASE_BOUND': return await this.#bindRelease(context, invocationId);
      case 'RUNTIME_CONFIGURED': return await this.#configureRuntime(context, profile);
      case 'IDENTITY_BOUND': return await this.#bindIdentity(context, profile);
      case 'TLS_BOUND': return await this.#bindTls(context, profile);
      case 'TUNNEL_BOUND': return await this.#bindTunnel(context, profile, invocationId);
      case 'DNS_BOUND': return await this.#bindDns(context, profile, invocationId);
      case 'SYSTEMD_READY': return await this.#prepareSystemd(context, profile, invocationId);
      case 'PROCESSES_READY': return await this.#startProcesses(context, profile, invocationId);
      case 'HEALTH_VERIFIED': return await this.#verifyHealth(context, profile);
      case 'ACTIVE': return await this.#markActive(context);
      default: throw new Error(`AUTONODE_PRODUCTION_STEP_UNKNOWN:${step}`);
    }
  }

  async #rollbackStep(step, context, profile, details, invocationId) {
    switch (step) {
      case 'ACTIVE': return await this.#unmarkActive(context);
      case 'HEALTH_VERIFIED': return { checked_only: true };
      case 'PROCESSES_READY': return await this.#stopProcesses(details, profile);
      case 'SYSTEMD_READY': return await this.#rollbackSystemd(details, profile);
      case 'DNS_BOUND': return await this.#unbindDns(details, profile);
      case 'TUNNEL_BOUND': return await this.#unbindTunnel(context, details, profile);
      case 'TLS_BOUND': return await this.#unbindTls(context, details);
      case 'IDENTITY_BOUND': return await this.#unbindIdentity(context, profile);
      case 'RUNTIME_CONFIGURED': return { retained_until_node_directory_removal: true };
      case 'RELEASE_BOUND': return await this.#unbindRelease(context, details, invocationId);
      case 'FILES_MATERIALIZED': return await this.#removeFiles(context);
      default: throw new Error(`AUTONODE_PRODUCTION_ROLLBACK_STEP_UNKNOWN:${step}`);
    }
  }

  async #materializeFiles(context, invocationId) {
    const target = context.plan.node_directory;
    const marker = join(target, '.autonode-owner.json');
    const owner = await readJson(marker);
    if (owner !== null) {
      assertOwner(owner, context);
      return { node_directory: target, created: false, owner_digest: digestJson(owner) };
    }
    if (await exists(target)) throw new Error(`AUTONODE_NODE_DIRECTORY_CONFLICT:${target}`);
    await mkdir(dirname(target), { recursive: true });
    const staging = `${target}.autonode-${digestText(invocationId).slice(0, 12)}`;
    await rm(staging, { recursive: true, force: true });
    await cp(context.candidate.nodeDirectory, staging, { recursive: true, errorOnExist: true });
    const value = {
      schema_version: 'sfl.autonode-node-owner.v1',
      activation_request_id: context.request.activation_request_id,
      provisioning_request_id: context.request.provisioning_request.provisioning_request_id,
      node_id: context.plan.node_id,
      plan_digest: context.plan.plan_digest,
    };
    await writeJsonAtomic(join(staging, '.autonode-owner.json'), value, 0o600);
    await rename(staging, target);
    await chmod(target, 0o755);
    await chmod(join(target, 'runtime'), 0o750);
    await chmod(join(target, 'receipts'), 0o750);
    return { node_directory: target, created: true, owner_digest: digestJson(value) };
  }

  async #bindRelease(context, invocationId) {
    const current = join(context.plan.node_directory, 'current');
    const desired = context.request.target.release_directory;
    const previous = await symlinkTarget(current);
    if (previous !== null && resolve(dirname(current), previous) !== desired) {
      throw new Error(`AUTONODE_RELEASE_POINTER_CONFLICT:${current}`);
    }
    if (previous === null) {
      const next = `${current}.autonode-${digestText(invocationId).slice(0, 12)}`;
      await rm(next, { force: true });
      await symlink(desired, next);
      await rename(next, current);
    }
    return {
      release_pointer: current,
      release_directory: desired,
      previous_target: previous,
      source_sha: context.plan.source_sha,
      immutable_artifact_digest: context.plan.immutable_artifact_digest,
    };
  }

  async #configureRuntime(context, profile) {
    const nodeDirectory = context.plan.node_directory;
    const candidateDirectory = context.candidate.nodeDirectory;
    const runtimeDirectory = join(nodeDirectory, 'runtime');
    const resources = await readRequiredJson(join(runtimeDirectory, 'resource-plan.json'));
    const activeManifest = await activateCandidateNodeManifest(
      context.candidate.manifest,
      context.request.provisioning_request.created_at,
    );
    await writeJsonAtomic(join(nodeDirectory, 'manifest.json'), activeManifest, 0o644);

    const generatedSystemd = await readRequiredJson(join(runtimeDirectory, 'systemd-instances.json'));
    const systemd = replaceDeep(generatedSystemd, candidateDirectory, nodeDirectory);
    await writeJsonAtomic(join(runtimeDirectory, 'systemd-instances.json'), systemd, 0o640);

    const configuredServices = [];
    for (const { service, environment_file: environmentFile } of systemd.instances) {
      if (environmentFile === null) continue;
      const candidateFile = join(candidateDirectory, 'runtime', `${service}.env`);
      const generated = await readEnvironment(candidateFile);
      const overrides = interpolateRecord(profile.services[service], {
        ...interpolationValues(context, activeManifest),
        object_store_port: String(resources.ports.object_store),
      }, this.environment);
      const environment = {
        ...replaceDeep(generated, candidateDirectory, nodeDirectory),
        ...(SERVICE_CONSTANTS[service] ?? {}),
        ...overrides,
        APP_ENV: 'production',
        SERVICE_VERSION: context.plan.source_sha,
        NODE_MANIFEST_PATH: join(nodeDirectory, 'manifest.json'),
        NODE_MANIFEST_ID: activeManifest.manifest_id,
        NODE_MANIFEST_DIGEST: activeManifest.manifest_digest,
        NODE_RUNTIME_INSTANCE_ID: activeManifest.runtime_instance_id,
        NODE_RUNTIME_CONFIG_REF: activeManifest.runtime_config_ref.ref,
        NODE_RESOURCE_BINDING_VERSION: activeManifest.resource_binding_set_ref.version,
        NODE_RELEASE_POINTER_REF: activeManifest.release_pointer_ref.ref,
      };
      SERVICE_ENVIRONMENT_VALIDATORS[service]?.(environment);
      await writeEnvironment(environmentFile, environment);
      configuredServices.push({ service, file: environmentFile, digest: await digestFile(environmentFile) });
    }

    await writeFile(join(runtimeDirectory, 'api-gateway.Caddyfile'), gatewayConfiguration(
      activeManifest,
      nodeDirectory,
      resources.ports,
    ), { mode: 0o640 });
    for (const directory of ['caddy-data', 'caddy-config']) {
      await mkdir(join(runtimeDirectory, directory), { recursive: true });
      await chmod(join(runtimeDirectory, directory), 0o770);
    }
    const cloudflaredFile = join(runtimeDirectory, 'cloudflared.yml');
    await writeFile(cloudflaredFile,
      (await readFile(cloudflaredFile, 'utf8')).replaceAll(candidateDirectory, nodeDirectory),
      { mode: 0o640 });
    await chmod(cloudflaredFile, 0o640);
    const consoleRuntime = await parseSflConsoleNodeRuntime({
      ...await readRequiredJson(join(runtimeDirectory, 'console-runtime.json')),
      node_manifest: activeManifest,
    });
    await writeJsonAtomic(join(runtimeDirectory, 'console-runtime.json'), consoleRuntime, 0o640);
    const identityRuntime = await readRequiredJson(join(runtimeDirectory, 'identity-runtime.json'));
    await writeJsonAtomic(join(runtimeDirectory, 'identity-runtime.json'), identityRuntime, 0o640);
    const pointerFile = join(nodeDirectory, 'release-pointer.json');
    await writeJsonAtomic(pointerFile, {
      ...await readRequiredJson(pointerFile),
      manifest_version: activeManifest.manifest_version,
      manifest_digest: activeManifest.manifest_digest,
      candidate_status: 'ACTIVATING',
    }, 0o640);
    return {
      manifest_id: activeManifest.manifest_id,
      manifest_version: activeManifest.manifest_version,
      manifest_digest: activeManifest.manifest_digest,
      configured_services: configuredServices,
      gateway_digest: await digestFile(join(runtimeDirectory, 'api-gateway.Caddyfile')),
      cloudflared_digest: await digestFile(cloudflaredFile),
      console_runtime_digest: await digestFile(join(runtimeDirectory, 'console-runtime.json')),
      identity_runtime_digest: await digestFile(join(runtimeDirectory, 'identity-runtime.json')),
    };
  }

  async #bindTls(context, profile) {
    const target = join(context.plan.node_directory, 'runtime', 'tls');
    await mkdir(target, { recursive: true });
    await chmod(target, 0o750);
    const bindings = [
      [profile.tls.certificate_file, join(target, 'origin.crt'), 0o640],
      [profile.tls.private_key_file, join(target, 'origin.key'), 0o640],
      [profile.tls.ca_file, join(target, 'origin-ca.crt'), 0o640],
    ];
    const files = [];
    for (const [source, destination, mode] of bindings) {
      await cp(source, destination, { force: true });
      await chmod(destination, mode);
      files.push({ path: destination, digest: await digestFile(destination) });
    }
    return { binding_ref: profile.tls.binding_ref, files };
  }

  async #bindIdentity(context, profile) {
    const manifest = await readRequiredJson(join(context.plan.node_directory, 'manifest.json'));
    const identityRuntimePath = join(context.plan.node_directory, 'runtime', 'identity-runtime.json');
    const identityNode = await loadIdentityNodeRuntimeDefinition(identityRuntimePath, manifest);
    const expected = expectedIdentityNodeDatabaseManifest(manifest, identityNode);
    const fact = Object.freeze({
      schema_version: 'sfl.autonode-identity-realm-fact.v1',
      activation_request_id: context.request.activation_request_id,
      provisioning_request_id: context.request.provisioning_request.provisioning_request_id,
      manifest_id: manifest.manifest_id,
      manifest_digest: manifest.manifest_digest,
      realm: expected.realms[0],
      entries: expected.entries,
      targets: expected.targets,
    });
    const databaseReceipt = await this.identityRegistry.provision(fact, profile.identity_registry);
    return {
      binding_ref: profile.identity_registry.binding_ref,
      realm_id: expected.realms[0].id,
      fact_digest: digestJson(fact),
      database_receipt: databaseReceipt,
    };
  }

  async #bindTunnel(context, profile, invocationId) {
    const journalFile = this.#journalFile(invocationId);
    let journal = await readJson(journalFile);
    const resumed = journal !== null;
    if (journal === null) {
      journal = {
        schema_version: 'sfl.autonode-provider-tunnel-journal.v1',
        tunnel_name: nodeActivationTunnelName(context.request, context.candidate.manifest),
        tunnel_secret: randomBytes(32).toString('base64'),
        owned: true,
      };
      await writeJsonAtomic(journalFile, journal, 0o600);
    }
    const client = cloudflareClient(profile, this.environment, this.fetcher);
    const tunnel = await client.ensureTunnel(journal.tunnel_name, journal.tunnel_secret);
    if (!tunnel.created && !resumed && journal.tunnel_id === undefined) {
      throw new Error(`AUTONODE_CLOUDFLARE_TUNNEL_CONFLICT:${journal.tunnel_name}`);
    }
    journal = { ...journal, tunnel_id: tunnel.id };
    await writeJsonAtomic(journalFile, journal, 0o600);
    const credentialsFile = join(context.plan.node_directory, 'tunnel', 'credentials.json');
    await mkdir(dirname(credentialsFile), { recursive: true });
    await chmod(dirname(credentialsFile), 0o750);
    await writeJsonAtomic(credentialsFile, {
      AccountTag: profile.cloudflare.account_id,
      TunnelSecret: journal.tunnel_secret,
      TunnelID: tunnel.id,
    }, 0o640);
    const configFile = join(context.plan.node_directory, 'runtime', 'cloudflared.yml');
    const config = await readFile(configFile, 'utf8');
    await writeFile(configFile, config.replace(/^tunnel: .*$/m, `tunnel: ${tunnel.id}`), { mode: 0o640 });
    return {
      tunnel_id: tunnel.id,
      tunnel_name: tunnel.name,
      cname_target: `${tunnel.id}.cfargotunnel.com`,
      credentials_digest: await digestFile(credentialsFile),
      config_digest: await digestFile(configFile),
      owned: journal.owned,
    };
  }

  async #bindDns(context, profile, invocationId) {
    const credentials = await readRequiredJson(join(context.plan.node_directory, 'tunnel', 'credentials.json'));
    const tunnelId = requiredText(credentials.TunnelID, 'tunnel credentials id');
    const target = `${tunnelId}.cfargotunnel.com`;
    const journalFile = this.#journalFile(invocationId);
    const journal = await readJson(journalFile) ?? {
      schema_version: 'sfl.autonode-provider-dns-journal.v1',
      records: {},
    };
    const baseDomain = zhudatuanActivationDomain(context.request);
    if (baseDomain && journal.zone_id === undefined && Object.keys(journal.records).length === 0) {
      const configuredClient = cloudflareClient(profile, this.environment, this.fetcher);
      journal.zone_id = await configuredClient.zoneForDomain(baseDomain);
      await writeJsonAtomic(journalFile, journal, 0o600);
    }
    const client = cloudflareClient(profile, this.environment, this.fetcher, journal.zone_id ?? profile.cloudflare.zone_id);
    const records = [];
    for (const host of context.plan.hosts) {
      journal.records[host] ??= { intended: true };
      await writeJsonAtomic(journalFile, journal, 0o600);
      const ownershipMarker = `AutoNode ${context.request.activation_request_id} ${context.plan.node_id}`;
      const record = await client.ensureCname(
        host,
        target,
        ownershipMarker,
      );
      const owned = record.created || record.comment === ownershipMarker;
      journal.records[host] = { id: record.id, content: record.content, owned };
      await writeJsonAtomic(journalFile, journal, 0o600);
      records.push({ ...record, owned });
    }
    return { cname_target: target, records, ...(journal.zone_id ? { zone_id: journal.zone_id } : {}) };
  }

  async #prepareSystemd(context, profile, invocationId) {
    const systemd = await readRequiredJson(join(context.plan.node_directory, 'runtime', 'systemd-instances.json'));
    const journalFile = this.#journalFile(invocationId);
    let journal = await readJson(journalFile) ?? {
      schema_version: 'sfl.autonode-provider-systemd-journal.v1',
      initial_enabled: {},
    };
    const templates = [];
    for (const template of [...new Set(systemd.instances.map(({ unit }) => unitTemplateName(unit)))]) {
      const source = join(context.request.target.release_directory,
        '02_platform_pingtai/infrastructure/zhudatuan/aliyun/systemd', template);
      const destination = join(context.request.target.systemd_unit_root, template);
      const sourceExists = await exists(source);
      const destinationExists = await exists(destination);
      if (!destinationExists) {
        if (!sourceExists) throw new Error(`AUTONODE_SYSTEMD_TEMPLATE_MISSING:${template}`);
        await cp(source, destination, { force: false });
        await chmod(destination, 0o644);
      } else if (sourceExists && await digestFile(source) !== await digestFile(destination)) {
        throw new Error(`AUTONODE_SYSTEMD_TEMPLATE_CONFLICT:${template}`);
      }
      templates.push({ template, destination, installed: !destinationExists });
    }
    await this.runner(profile.commands.systemctl, ['daemon-reload']);
    for (const { unit } of systemd.instances) {
      if (!Object.hasOwn(journal.initial_enabled, unit)) {
        journal.initial_enabled[unit] = (await this.runner(profile.commands.systemctl, ['is-enabled', unit], { allowFailure: true })).code === 0;
        await writeJsonAtomic(journalFile, journal, 0o600);
      }
      if (!journal.initial_enabled[unit]) await this.runner(profile.commands.systemctl, ['enable', unit]);
    }
    return { templates, units: systemd.instances.map(({ unit }) => ({ unit, enabled_before: journal.initial_enabled[unit] })) };
  }

  async #startProcesses(context, profile, invocationId) {
    const ownership = `${profile.ownership.owner}:${profile.ownership.group}`;
    await this.runner(profile.commands.chown, ['-R', ownership, context.plan.node_directory]);
    const systemd = await readRequiredJson(join(context.plan.node_directory, 'runtime', 'systemd-instances.json'));
    const instances = [...systemd.instances].sort((left, right) =>
      PROCESS_ORDER.indexOf(left.service) - PROCESS_ORDER.indexOf(right.service));
    const journalFile = this.#journalFile(invocationId);
    let journal = await readJson(journalFile) ?? {
      schema_version: 'sfl.autonode-provider-process-journal.v1',
      initial_active: {},
    };
    for (const { unit } of instances) {
      if (!Object.hasOwn(journal.initial_active, unit)) {
        journal.initial_active[unit] = (await this.runner(profile.commands.systemctl, ['is-active', unit], { allowFailure: true })).code === 0;
        await writeJsonAtomic(journalFile, journal, 0o600);
      }
      if (!journal.initial_active[unit]) await this.runner(profile.commands.systemctl, ['start', unit]);
    }
    return {
      runtime_ownership: ownership,
      units: instances.map(({ service, unit }) => ({
        service,
        unit,
        active_before: journal.initial_active[unit],
        active_after: true,
      })),
    };
  }

  async #verifyHealth(context, profile) {
    const resources = await readRequiredJson(join(context.plan.node_directory, 'runtime', 'resource-plan.json'));
    const local = [];
    for (const [service, port] of [
      ['catalog-api', resources.ports.catalog],
      ['web-api', resources.ports.web],
      ['identity-api', resources.ports.identity],
      ['purchase-api', resources.ports.purchase],
    ]) {
      const response = await this.fetcher(`http://127.0.0.1:${port}/health/ready`, { signal: AbortSignal.timeout(profile.health.timeout_ms) });
      if (response.status !== 200) throw new Error(`AUTONODE_LOCAL_HEALTH_FAILED:${service}:${response.status}`);
      local.push({ service, port, status: response.status });
    }
    const hosts = Object.fromEntries(context.candidate.manifest.domain_bindings.map((binding) => [
      binding.surface_ref.slice('surface:'.length),
      binding.host,
    ]));
    const publicTargets = [
      ['gateway', `https://${hosts.api}/health/gateway`],
      ['console-runtime', `https://${hosts.console}/console-runtime.json`],
      ['identity-runtime', `https://${hosts.identity}/identity-runtime.json`],
      ['storefront', `https://${hosts.storefront}/`],
    ];
    const external = [];
    for (const [name, url] of publicTargets) {
      external.push({ name, url, ...await publicHealth(
        this.runner,
        profile.commands.curl,
        name,
        url,
        profile.health.timeout_ms,
        this.publicDnsLookup,
      ) });
    }
    const unknownHost = `autonode-unknown-${digestText(context.plan.node_id).slice(0, 12)}.invalid`;
    const negative = await this.runner(profile.commands.curl, [
      '--silent', '--insecure', '--noproxy', '*', '--output', '/dev/null', '--write-out', '%{http_code}',
      '--resolve', `${unknownHost}:${resources.ports.gateway}:127.0.0.1`,
      `https://${unknownHost}:${resources.ports.gateway}/`,
    ]);
    if (negative.stdout.trim() !== '421') throw new Error(`AUTONODE_UNKNOWN_HOST_FALLBACK:${negative.stdout.trim()}`);
    return { local, external, unknown_host_status: 421 };
  }

  async #markActive(context) {
    const nodeDirectory = context.plan.node_directory;
    const manifest = await readRequiredJson(join(nodeDirectory, 'manifest.json'));
    const pointerFile = join(nodeDirectory, 'release-pointer.json');
    await writeJsonAtomic(pointerFile, {
      ...await readRequiredJson(pointerFile),
      candidate_status: 'ACTIVE',
    }, 0o640);
    const resourcesFile = join(nodeDirectory, 'runtime', 'resource-plan.json');
    const resources = await readRequiredJson(resourcesFile);
    await writeJsonAtomic(resourcesFile, {
      ...resources,
      external_status: 'BOUND',
      external_bindings: resources.external_bindings.map((binding) => ({ ...binding, status: 'BOUND' })),
    }, 0o640);
    const activation = {
      schema_version: 'sfl.autonode-production-activation-receipt.v1',
      activation_request_id: context.request.activation_request_id,
      provisioning_request_id: context.request.provisioning_request.provisioning_request_id,
      node_id: context.plan.node_id,
      parent_node_id: context.plan.parent_node_id,
      manifest_id: manifest.manifest_id,
      manifest_digest: manifest.manifest_digest,
      plan_digest: context.plan.plan_digest,
      source_sha: context.plan.source_sha,
      build_id: context.plan.build_id,
      build_count: 1,
      immutable_artifact_digest: context.plan.immutable_artifact_digest,
      source_tree_copy_count: 0,
      node_specific_build_count: 0,
      activated_at: new Date().toISOString(),
    };
    const file = join(nodeDirectory, 'receipts', 'activation.json');
    await writeJsonAtomic(file, activation, 0o640);
    return { activation_receipt: file, activation_digest: await digestFile(file) };
  }

  async #unmarkActive(context) {
    const nodeDirectory = context.plan.node_directory;
    await rm(join(nodeDirectory, 'receipts', 'activation.json'), { force: true });
    const pointerFile = join(nodeDirectory, 'release-pointer.json');
    if (await exists(pointerFile)) {
      await writeJsonAtomic(pointerFile, { ...await readRequiredJson(pointerFile), candidate_status: 'ROLLED_BACK' }, 0o640);
    }
    return { active_marker_removed: true };
  }

  async #stopProcesses(details, profile) {
    const stopped = [];
    for (const { unit, active_before: activeBefore } of [...(details.units ?? [])].reverse()) {
      if (!activeBefore) {
        await this.runner(profile.commands.systemctl, ['stop', unit], { allowFailure: true });
        stopped.push(unit);
      }
    }
    return { stopped_units: stopped };
  }

  async #rollbackSystemd(details, profile) {
    const disabled = [];
    for (const { unit, enabled_before: enabledBefore } of [...(details.units ?? [])].reverse()) {
      if (!enabledBefore) {
        await this.runner(profile.commands.systemctl, ['disable', unit], { allowFailure: true });
        disabled.push(unit);
      }
    }
    await this.runner(profile.commands.systemctl, ['daemon-reload']);
    return { disabled_units: disabled, shared_templates_retained: true };
  }

  async #unbindDns(details, profile) {
    const client = cloudflareClient(profile, this.environment, this.fetcher, details.zone_id ?? profile.cloudflare.zone_id);
    const deleted = [];
    for (const record of [...(details.records ?? [])].reverse()) {
      if (!record.owned) continue;
      await client.deleteDnsRecord(record.id);
      deleted.push({ id: record.id, name: record.name });
    }
    return { deleted_records: deleted };
  }

  async #unbindTunnel(context, details, profile) {
    if (details.owned) {
      await cloudflareClient(profile, this.environment, this.fetcher).deleteTunnel(details.tunnel_id);
    }
    await rm(join(context.plan.node_directory, 'tunnel', 'credentials.json'), { force: true });
    return { tunnel_id: details.tunnel_id, deleted: details.owned === true };
  }

  async #unbindTls(context, details) {
    const removed = [];
    for (const file of details.files ?? []) {
      const target = resolve(file.path);
      assertInside(join(context.plan.node_directory, 'runtime', 'tls'), target);
      await rm(target, { force: true });
      removed.push(target);
    }
    return { removed_files: removed };
  }

  async #unbindIdentity(context, profile) {
    return {
      binding_ref: profile.identity_registry.binding_ref,
      database_receipt: await this.identityRegistry.disable(
        context.request.activation_request_id,
        profile.identity_registry,
      ),
    };
  }

  async #unbindRelease(context, details, invocationId) {
    const current = join(context.plan.node_directory, 'current');
    const actual = await symlinkTarget(current);
    if (actual !== null && resolve(dirname(current), actual) === context.request.target.release_directory) {
      await rm(current, { force: true });
    }
    if (details.previous_target !== null && details.previous_target !== undefined) {
      const next = `${current}.rollback-${digestText(invocationId).slice(0, 12)}`;
      await symlink(details.previous_target, next);
      await rename(next, current);
    }
    return { release_pointer: current, restored_target: details.previous_target ?? null };
  }

  async #removeFiles(context) {
    const target = context.plan.node_directory;
    if (!await exists(target)) return { removed_node_directory: target, already_absent: true };
    const owner = await readRequiredJson(join(target, '.autonode-owner.json'));
    assertOwner(owner, context);
    await rm(target, { recursive: true, force: true });
    return { removed_node_directory: target };
  }

  async #prepare() {
    await mkdir(join(this.root, 'receipts'), { recursive: true });
    await mkdir(join(this.root, 'journals'), { recursive: true });
  }

  #receiptFile(invocationId) {
    return join(this.root, 'receipts', `${digestText(invocationId)}.json`);
  }

  #journalFile(invocationId) {
    return join(this.root, 'journals', `${digestText(invocationId)}.json`);
  }
}

export function parseRuntimeProfile(value, request) {
  const profile = requiredRecord(value, 'runtime profile');
  if (profile.schema_version !== AUTONODE_RUNTIME_PROFILE_SCHEMA_VERSION) {
    throw new Error('AUTONODE_RUNTIME_PROFILE_SCHEMA_INVALID');
  }
  const environment = requiredText(profile.environment, 'runtime profile environment');
  if (environment !== request.target.environment) throw new Error('AUTONODE_RUNTIME_PROFILE_ENVIRONMENT_MISMATCH');
  const tls = requiredRecord(profile.tls, 'runtime profile tls');
  const cloudflare = requiredRecord(profile.cloudflare, 'runtime profile cloudflare');
  const identityRegistry = requiredRecord(profile.identity_registry, 'runtime profile identity registry');
  const commands = requiredRecord(profile.commands, 'runtime profile commands');
  const ownership = requiredRecord(profile.ownership ?? { owner: 'root', group: 'zhudatuan' },
    'runtime profile ownership');
  const services = requiredRecord(profile.services, 'runtime profile services');
  return Object.freeze({
    schema_version: AUTONODE_RUNTIME_PROFILE_SCHEMA_VERSION,
    profile_id: requiredText(profile.profile_id, 'runtime profile id'),
    environment,
    services: Object.freeze(Object.fromEntries(Object.entries(services).map(([service, source]) => [
      requiredText(service, 'runtime service'),
      stringRecord(source, `runtime service ${service}`),
    ]))),
    tls: Object.freeze({
      binding_ref: requiredText(tls.binding_ref, 'tls binding ref'),
      certificate_file: absoluteFile(tls.certificate_file, 'tls certificate file'),
      private_key_file: absoluteFile(tls.private_key_file, 'tls private key file'),
      ca_file: absoluteFile(tls.ca_file, 'tls ca file'),
    }),
    cloudflare: Object.freeze({
      account_id: requiredText(cloudflare.account_id, 'cloudflare account id'),
      zone_id: zhudatuanActivationDomain(request) && cloudflare.zone_id === undefined
        ? undefined
        : requiredText(cloudflare.zone_id, 'cloudflare zone id'),
      api_token_env: requiredText(cloudflare.api_token_env, 'cloudflare api token env'),
    }),
    identity_registry: Object.freeze({
      binding_ref: requiredText(identityRegistry.binding_ref, 'identity registry binding ref'),
      connection_string_env: requiredText(identityRegistry.connection_string_env, 'identity registry connection string env'),
      ssl_ca_file: identityRegistry.ssl_ca_file === undefined
        ? null
        : absoluteFile(identityRegistry.ssl_ca_file, 'identity registry ssl ca file'),
    }),
    commands: Object.freeze({
      systemctl: absoluteFile(commands.systemctl ?? '/usr/bin/systemctl', 'systemctl'),
      caddy: absoluteFile(commands.caddy ?? '/usr/bin/caddy', 'caddy'),
      cloudflared: absoluteFile(commands.cloudflared ?? '/usr/local/bin/cloudflared', 'cloudflared'),
      curl: absoluteFile(commands.curl ?? '/usr/bin/curl', 'curl'),
      chown: absoluteFile(commands.chown ?? '/usr/bin/chown', 'chown'),
    }),
    ownership: Object.freeze({
      owner: systemAccount(ownership.owner, 'runtime owner'),
      group: systemAccount(ownership.group, 'runtime group'),
    }),
    health: Object.freeze({
      timeout_ms: optionalPositiveInteger(requiredRecord(profile.health ?? {}, 'runtime profile health').timeout_ms, 15_000),
    }),
  });
}

export class PgNodeIdentityRegistry {
  constructor(environment = process.env) {
    this.environment = environment;
  }

  async provision(fact, configuration) {
    return await this.#query(configuration,
      'select identity.provision_node_realm($1::jsonb) receipt', [JSON.stringify(fact)]);
  }

  async disable(activationRequestId, configuration) {
    return await this.#query(configuration,
      'select identity.disable_node_realm($1) receipt', [activationRequestId]);
  }

  async #query(configuration, statement, parameters) {
    const imported = await import('pg');
    const Client = imported.Client ?? imported.default?.Client;
    if (typeof Client !== 'function') throw new Error('AUTONODE_POSTGRES_CLIENT_UNAVAILABLE');
    const ca = configuration.ssl_ca_file === null
      ? undefined
      : await readFile(configuration.ssl_ca_file, 'utf8');
    const client = new Client({
      connectionString: requiredEnvironmentValue(this.environment, configuration.connection_string_env),
      ...(ca === undefined ? {} : { ssl: { ca, rejectUnauthorized: true } }),
      application_name: 'autonode-identity-registry',
    });
    await client.connect();
    try {
      const result = await client.query(statement, parameters);
      const receipt = result.rows[0]?.receipt;
      if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt)) {
        throw new Error('AUTONODE_IDENTITY_DATABASE_RECEIPT_INVALID');
      }
      return Object.freeze({ ...receipt });
    } finally {
      await client.end();
    }
  }
}

function zhudatuanActivationDomain(request) {
  const provisioning = request.provisioning_request;
  const baseDomain = provisioning?.binding_sources?.domains?.base_domain;
  // Previously submitted activation requests keep their original DNS zone.
  if (provisioning?.parent_node_id === 'node:zhudatuan:l0' && baseDomain !== 'hbbtzn.com') return baseDomain;
}

function cloudflareClient(profile, environment, fetcher, zoneId) {
  return new AutoNodeCloudflareClient({
    accountId: profile.cloudflare.account_id,
    zoneId,
    apiToken: requiredEnvironmentValue(environment, profile.cloudflare.api_token_env),
    fetcher,
  });
}

async function publicHealth(runner, curl, name, url, timeoutMs, publicDnsLookup) {
  const attempts = 6;
  const commandTimeout = Math.max(2, Math.ceil(timeoutMs / attempts / 1_000));
  const target = new URL(url);
  const targetPort = target.port || '443';
  let publicAddress = null;
  let last = { code: -1, stdout: '' };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const args = [
      '--silent', '--show-error', '--noproxy', '*', '--max-time', String(commandTimeout),
      '--output', '/dev/null', '--write-out', '%{http_code}',
    ];
    if (publicAddress !== null) args.push('--resolve', `${target.hostname}:${targetPort}:${publicAddress}`);
    args.push(url);
    last = await runner(curl, args, { allowFailure: true });
    const status = Number.parseInt(last.stdout.trim(), 10);
    if (last.code === 0 && Number.isSafeInteger(status) && status >= 200 && status < 400) {
      return {
        status,
        attempts: attempt,
        resolution: publicAddress === null ? 'SYSTEM' : 'PUBLIC_DNS_FALLBACK',
      };
    }
    if (last.code === 6 && publicAddress === null) {
      const addresses = await publicDnsLookup(target.hostname).catch(() => []);
      publicAddress = addresses.find((address) => typeof address === 'string' && address.length > 0) ?? null;
    }
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`AUTONODE_PUBLIC_HEALTH_FAILED:${name}:${last.code}:${last.stdout.trim()}`);
}

async function resolvePublicIpv4(hostname) {
  const resolver = new Resolver();
  resolver.setServers(['1.1.1.1', '1.0.0.1']);
  return await resolver.resolve4(hostname);
}

function interpolationValues(context, manifest) {
  const request = context.request.provisioning_request;
  return Object.freeze({
    node_id: manifest.node_id,
    node_slug: request.node_slug,
    node_token: manifest.node_id.split(':').slice(1).join('/nodes/'),
    node_root: context.plan.node_directory,
    mall_id: manifest.mall_id ?? '',
    public_slug: request.business.public_slug,
    source_sha: context.plan.source_sha,
    build_id: context.plan.build_id,
  });
}

function interpolateRecord(record, values, environment) {
  return Object.freeze(Object.fromEntries(Object.entries(record).map(([key, value]) => {
    // Only explicit, whole-value references read from the AutoNode service environment.
    const reference = environment && /^\{env:([A-Z][A-Z0-9_]*)\}$/.exec(value);
    if (reference) return [key, requiredEnvironmentValue(environment, reference[1])];
    return [key, value.replace(/\{([a-z_]+)\}/g, (match, name) => Object.hasOwn(values, name) ? values[name] : match)];
  })));
}

function replaceDeep(value, from, to) {
  if (typeof value === 'string') return value.replaceAll(from, to);
  if (Array.isArray(value)) return value.map((item) => replaceDeep(item, from, to));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceDeep(item, from, to)]));
  }
  return value;
}

function nodeInstance(context) {
  return basename(context.plan.node_directory);
}

function unitTemplateName(unit) {
  const match = requiredText(unit, 'systemd unit').match(/^([a-z0-9-]+)@[^/]+\.service$/);
  if (!match) throw new Error(`AUTONODE_SYSTEMD_UNIT_INVALID:${unit}`);
  return `${match[1]}@.service`;
}

function assertOwner(owner, context) {
  if (owner?.schema_version !== 'sfl.autonode-node-owner.v1'
    || owner.activation_request_id !== context.request.activation_request_id
    || owner.provisioning_request_id !== context.request.provisioning_request.provisioning_request_id
    || owner.node_id !== context.plan.node_id
    || owner.plan_digest !== context.plan.plan_digest) {
    throw new Error(`AUTONODE_NODE_DIRECTORY_OWNER_MISMATCH:${context.plan.node_directory}`);
  }
}

async function readEnvironment(file) {
  const source = await readFile(file, 'utf8');
  return Object.fromEntries(source.split('\n').filter(Boolean).map((line) => {
    const index = line.indexOf('=');
    if (index < 1) throw new Error(`AUTONODE_ENVIRONMENT_LINE_INVALID:${file}`);
    const key = line.slice(0, index);
    const raw = line.slice(index + 1);
    let value = raw;
    if (raw.startsWith('"') && raw.endsWith('"')) {
      try {
        value = JSON.parse(raw);
      } catch {
        throw new Error(`AUTONODE_ENVIRONMENT_VALUE_INVALID:${file}:${key}`);
      }
    }
    return [key, value];
  }));
}

async function writeEnvironment(file, environment) {
  const source = `${Object.entries(environment).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${JSON.stringify(String(value))}`).join('\n')}\n`;
  await writeFile(file, source, { mode: 0o640 });
  await chmod(file, 0o640);
}

function systemAccount(value, name) {
  const account = requiredText(value, name);
  if (!/^[a-z_][a-z0-9_-]{0,31}$/u.test(account)) throw new Error(`AUTONODE_SYSTEM_ACCOUNT_INVALID:${name}`);
  return account;
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
        rejectPromise(new Error(`AUTONODE_COMMAND_FAILED:${command}:${args.join(',')}:${result.code}:${stderr.trim()}`));
      } else resolvePromise(result);
    });
  });
}

function providerStatePath(value) {
  const path = absoluteFile(value, 'provider state root');
  if (path === sep || path === '/etc' || path.startsWith('/etc/') || path === '/opt'
    || path === '/opt/sfl' || path === '/opt/sfl/nodes') throw new Error('AUTONODE_PROVIDER_STATE_ROOT_FORBIDDEN');
  return path;
}

function absoluteFile(value, name) {
  const path = requiredText(value, name);
  if (!isAbsolute(path)) throw new Error(`AUTONODE_ABSOLUTE_PATH_REQUIRED:${name}`);
  return resolve(path);
}

function assertInside(root, file) {
  const suffix = relative(resolve(root), resolve(file));
  if (suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
    throw new Error(`AUTONODE_PATH_OUTSIDE_ROOT:${file}`);
  }
}

async function symlinkTarget(path) {
  try {
    const entry = await lstat(path);
    if (!entry.isSymbolicLink()) throw new Error(`AUTONODE_RELEASE_POINTER_NOT_SYMLINK:${path}`);
    return await readlink(path);
  } catch (cause) {
    if (cause?.code === 'ENOENT') return null;
    throw cause;
  }
}

async function exists(path) {
  return await stat(path).then(() => true, (cause) => {
    if (cause?.code === 'ENOENT') return false;
    throw cause;
  });
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (cause) {
    if (cause?.code === 'ENOENT') return null;
    throw cause;
  }
}

async function readRequiredJson(path) {
  const value = await readJson(path);
  if (value === null) throw new Error(`AUTONODE_FILE_MISSING:${path}`);
  return value;
}

async function writeJsonAtomic(path, value, mode = 0o640) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await rename(temporary, path);
  await chmod(path, mode);
}

async function digestFile(path) {
  return `sha256:${createHash('sha256').update(await readFile(path)).digest('hex')}`;
}

function digestJson(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function digestText(value) {
  return createHash('sha256').update(value).digest('hex');
}

function requiredEnvironmentValue(environment, key) {
  const value = environment[key];
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function requiredRecord(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`AUTONODE_RECORD_REQUIRED:${name}`);
  return value;
}

function stringRecord(value, name) {
  const record = requiredRecord(value, name);
  return Object.freeze(Object.fromEntries(Object.entries(record).map(([key, item]) => [
    requiredText(key, `${name} key`),
    requiredText(item, `${name}.${key}`),
  ])));
}

function requiredText(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`AUTONODE_TEXT_REQUIRED:${name}`);
  return value.trim();
}

function optionalPositiveInteger(value, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > 120_000) throw new Error('AUTONODE_HEALTH_TIMEOUT_INVALID');
  return value;
}

function errorMessage(cause) {
  return cause instanceof Error ? cause.message : String(cause);
}
