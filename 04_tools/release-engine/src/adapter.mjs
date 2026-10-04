import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

import { invariant } from './errors.mjs';

export const ADAPTER_SCHEMA = 'ai.delivery.project.v1';

export async function loadAdapter(adapterPath, invocationRoot = process.cwd(), { observationOrRecovery = false } = {}) {
  const absolutePath = isAbsolute(adapterPath) ? adapterPath : resolve(invocationRoot, adapterPath);
  const adapter = JSON.parse(await readFile(absolutePath, 'utf8'));
  if (observationOrRecovery) {
    invariant(adapter?.schema === ADAPTER_SCHEMA && safeIdentifier(adapter.project), 'ADAPTER_IDENTITY_INVALID', 'Adapter identity is required');
    invariant(adapter.targets && typeof adapter.targets === 'object' && adapter.nodes && typeof adapter.nodes === 'object', 'ADAPTER_PLACEMENTS_INVALID', 'Adapter placements are required');
    for (const target of Object.keys(adapter.targets)) invariant(safeIdentifier(target), 'ADAPTER_TARGET_ID_INVALID', `Target id is unsafe: ${target}`);
    for (const [node, definition] of Object.entries(adapter.nodes)) {
      invariant(safeIdentifier(node), 'ADAPTER_NODE_KEY_INVALID', `Node key is unsafe: ${node}`);
      for (const [target, deployment] of Object.entries(definition?.deployments ?? {})) {
        invariant(safeIdentifier(target) && (!deployment?.hostedBy || safeIdentifier(deployment.hostedBy)), 'ADAPTER_PLACEMENT_ID_INVALID', `Placement id is unsafe: ${node}/${target}`);
      }
    }
  } else validateAdapter(adapter);
  const configuredRoot = adapter.projectRoot ?? '../../..';
  const projectRoot = resolve(dirname(absolutePath), configuredRoot);
  return Object.freeze({ ...(await bindInstance(adapter)), adapterPath: absolutePath, projectRoot });
}

async function bindInstance(adapter) {
  const configuredInstance = process.env.LK_INSTANCE_ROOT?.trim();
  if (!configuredInstance) return adapter;
  const instanceRoot = resolve(configuredInstance);
  const declaration = JSON.parse(await readFile(resolve(instanceRoot, 'sfl-node-registry.declaration.json'), 'utf8'));
  const manifests = declaration.manifests ?? [];
  const nodeIds = new Set(manifests.map((manifest) => manifest.node_id));
  const selected = Object.entries(adapter.nodes).filter(([, node]) => nodeIds.has(node.nodeId));
  const nodes = Object.fromEntries(selected);
  for (const [, node] of selected) {
    for (const deployment of Object.values(node.deployments)) {
      if (!deployment.hostedBy || nodes[deployment.hostedBy]) continue;
      const host = adapter.nodes[deployment.hostedBy];
      if (host) nodes[deployment.hostedBy] = { ...host, deployments: {} };
    }
  }
  for (const [, node] of selected) {
    for (const [target, deployment] of Object.entries(node.deployments)) {
      if (!deployment.hostedBy || nodeIds.has(nodes[deployment.hostedBy]?.nodeId)) continue;
      const hostDeployment = adapter.nodes[deployment.hostedBy]?.deployments[target];
      if (hostDeployment) nodes[deployment.hostedBy].deployments[target] = hostDeployment;
    }
  }
  const publicEnvironment = await instanceFrontendEnvironment(instanceRoot);
  const primaryBindings = manifests[0]?.domain_bindings ?? [];
  const origin = (surface) => {
    const binding = primaryBindings.find((candidate) => candidate.surface_ref === surface);
    return binding ? `https://${binding.host}` : undefined;
  };
  const frontendOrigin = {
    VITE_API_BASE_URL: publicEnvironment.VITE_API_BASE_URL ?? origin('surface:api'),
    VITE_AUTH_BASE_URL: publicEnvironment.VITE_AUTH_BASE_URL ?? origin('surface:identity'),
  };
  const targets = Object.fromEntries(Object.entries(adapter.targets).map(([id, target]) => [id, {
    ...target,
    build: (target.build ?? []).flatMap((command) => {
      const environment = { ...command.environment, LK_INSTANCE_ROOT: instanceRoot };
      if (id === 'console') {
        delete environment.VITE_API_BASE_URL;
        delete environment.VITE_AUTH_BASE_URL;
        for (const [name, value] of Object.entries(frontendOrigin)) if (value) environment[name] = value;
      }
      if (id === 'storefront' && command.argv[0] === 'npm' && command.argv[1] === 'run' && command.argv[2] === 'build:storefront') {
        return [
          { ...command, argv: ['npm', 'exec', '--workspace', '@smart-wing/storefront-web', '--', 'vinext', 'build'], environment },
          { ...command, name: `${command.name}-runtime`, argv: ['node', '01_core_hexin/apps/storefront-web/scripts/build-production-runtime.mjs'], environment },
        ];
      }
      const workspace = id === 'console' ? '@shop/console' : id === 'auth-web' ? '@smart-wing/auth-web' : null;
      const argv = workspace && command.argv[0] === 'npm' && command.argv[1] === 'run' &&
        ['build:console', 'build:auth'].includes(command.argv[2])
        ? ['npm', 'run', 'build', '--workspace', workspace, '--', '--outDir', resolve(instanceRoot, 'dist', id), '--emptyOutDir']
        : command.argv;
      return { ...command, argv, environment };
    }),
  }]));
  const hosts = new Set(manifests.flatMap((manifest) => (manifest.domain_bindings ?? []).map((binding) => binding.host)));
  return {
    ...adapter,
    instanceRoot,
    targets,
    nodes,
    channels: Object.fromEntries(Object.entries(adapter.channels ?? {}).filter(([, channel]) => Boolean(nodes[channel.node]))),
    productionAcceptance: { ...adapter.productionAcceptance, domains: (adapter.productionAcceptance?.domains ?? []).filter((host) => hosts.has(host)) },
  };
}

async function instanceFrontendEnvironment(instanceRoot) {
  const environment = {};
  for (const name of ['.env', '.env.local', '.env.production', '.env.production.local']) {
    const contents = await readFile(resolve(instanceRoot, name), 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    for (const line of contents.split(/\r?\n/)) {
      const matched = /^\s*(?:export\s+)?(VITE_API_BASE_URL|VITE_AUTH_BASE_URL)\s*=\s*(.*?)\s*$/.exec(line);
      if (!matched) continue;
      const value = matched[2];
      environment[matched[1]] = /^(['"]).*\1$/.test(value) ? value.slice(1, -1) : value.replace(/\s+#.*$/, '').trim();
    }
  }
  return environment;
}

export function validateAdapter(adapter) {
  invariant(adapter?.schema === ADAPTER_SCHEMA, 'ADAPTER_SCHEMA_INVALID', `Adapter schema must be ${ADAPTER_SCHEMA}`);
  invariant(safeIdentifier(adapter.project), 'ADAPTER_PROJECT_INVALID', 'Adapter project must be a safe identifier');
  invariant(typeof adapter.stateDirectory === 'string' && adapter.stateDirectory.length > 0, 'ADAPTER_STATE_INVALID', 'Adapter stateDirectory is required');
  invariant(adapter.targets && typeof adapter.targets === 'object', 'ADAPTER_TARGETS_INVALID', 'Adapter targets are required');
  invariant(Array.isArray(adapter.rules) && adapter.rules.length > 0, 'ADAPTER_RULES_INVALID', 'Adapter classification rules are required');
  invariant(adapter.nodes && typeof adapter.nodes === 'object', 'ADAPTER_NODES_INVALID', 'Adapter nodes are required');
  invariant(Array.isArray(adapter.productionAcceptance?.domains) && adapter.productionAcceptance.domains.length === 8, 'ADAPTER_PRODUCTION_DOMAINS_INVALID', 'Adapter requires exactly 8 retained production acceptance domains');
  invariant(new Set(adapter.productionAcceptance.domains).size === 8, 'ADAPTER_PRODUCTION_DOMAINS_DUPLICATE', 'Production acceptance domains must be unique');
  for (const [channelId, channel] of Object.entries(adapter.channels ?? {})) {
    invariant(safeIdentifier(channelId), 'ADAPTER_CHANNEL_ID_INVALID', `Channel id is unsafe: ${channelId}`);
    invariant(channel?.id === channelId, 'ADAPTER_CHANNEL_ID_MISMATCH', `Channel ${channelId} must repeat its id`);
    invariant(channel.kind === 'edge', 'ADAPTER_CHANNEL_KIND_INVALID', `Channel ${channelId} has invalid kind`);
    invariant(typeof channel.manifest === 'string' && channel.manifest.length > 0,
      'ADAPTER_CHANNEL_MANIFEST_INVALID', `Channel ${channelId} needs a manifest`);
    invariant(typeof channel.providerModule === 'string' && channel.providerModule.length > 0,
      'ADAPTER_CHANNEL_PROVIDER_INVALID', `Channel ${channelId} needs a provider module`);
  }
  validateCommands(adapter.buildPreflight, adapter.project, 'buildPreflight');
  for (const [resolverId, resolver] of Object.entries(adapter.impactResolvers ?? {})) {
    invariant(typeof resolver?.module === 'string' && resolver.module.length > 0, 'ADAPTER_IMPACT_RESOLVER_INVALID', `Impact resolver ${resolverId} needs a module`);
  }

  for (const [targetId, target] of Object.entries(adapter.targets)) {
    invariant(safeIdentifier(targetId), 'ADAPTER_TARGET_ID_INVALID', `Target id is unsafe: ${targetId}`);
    invariant(target?.id === targetId, 'ADAPTER_TARGET_ID_MISMATCH', `Target ${targetId} must repeat its id`);
    invariant(['content', 'frontend', 'service', 'migration', 'infrastructure'].includes(target.kind), 'ADAPTER_TARGET_KIND_INVALID', `Target ${targetId} has invalid kind`);
    invariant(Array.isArray(target.artifactInputs), 'ADAPTER_TARGET_INPUTS_INVALID', `Target ${targetId} artifactInputs must be an array`);
    invariant((target.after ?? []).every((dependency) => Boolean(adapter.targets[dependency])), 'ADAPTER_TARGET_ORDER_UNKNOWN', `Target ${targetId} has an unknown ordering dependency`);
    invariant((target.requires ?? []).every((dependency) => Boolean(adapter.targets[dependency])), 'ADAPTER_TARGET_REQUIREMENT_UNKNOWN', `Target ${targetId} has an unknown required target`);
    validateCommands(target.tests, targetId, 'tests');
    validateCommands(target.typecheck, targetId, 'typecheck');
    validateCommands(target.build, targetId, 'build');
  }

  for (const rule of adapter.rules) {
    invariant(typeof rule.id === 'string' && rule.id.length > 0, 'ADAPTER_RULE_ID_INVALID', 'Every rule needs an id');
    invariant(Array.isArray(rule.include) && rule.include.length > 0, 'ADAPTER_RULE_INCLUDE_INVALID', `Rule ${rule.id} needs include patterns`);
    invariant(rule.validationOnly === undefined || typeof rule.validationOnly === 'boolean', 'ADAPTER_RULE_VALIDATION_ONLY_INVALID', `Rule ${rule.id} validationOnly must be boolean`);
    invariant((rule.touches ?? []).every((touch) => typeof touch === 'string' && touch.length > 0), 'ADAPTER_RULE_TOUCH_INVALID', `Rule ${rule.id} touches must be strings`);
    validateCommands(rule.validations, rule.id, 'validations');
    if (rule.dynamicImpact) invariant(Boolean(adapter.impactResolvers?.[rule.dynamicImpact]), 'ADAPTER_RULE_IMPACT_UNKNOWN', `Rule ${rule.id} references unknown impact resolver ${rule.dynamicImpact}`);
    for (const targetId of rule.targets ?? []) {
      invariant(Boolean(adapter.targets[targetId]), 'ADAPTER_RULE_TARGET_UNKNOWN', `Rule ${rule.id} references unknown target ${targetId}`);
    }
  }

  for (const [nodeKey, node] of Object.entries(adapter.nodes)) {
    invariant(safeIdentifier(nodeKey), 'ADAPTER_NODE_KEY_INVALID', `Node key is unsafe: ${nodeKey}`);
    invariant(node?.key === nodeKey, 'ADAPTER_NODE_KEY_MISMATCH', `Node ${nodeKey} must repeat its key`);
    invariant(typeof node.nodeId === 'string' && node.nodeId.length > 0, 'ADAPTER_NODE_ID_INVALID', `Node ${nodeKey} needs nodeId`);
    invariant(node.deployments && typeof node.deployments === 'object', 'ADAPTER_NODE_DEPLOYMENTS_INVALID', `Node ${nodeKey} needs deployments`);
    for (const [targetId, deployment] of Object.entries(node.deployments)) {
      invariant(Boolean(adapter.targets[targetId]), 'ADAPTER_NODE_TARGET_UNKNOWN', `Node ${nodeKey} references unknown target ${targetId}`);
      invariant(typeof deployment.pointerRoot === 'string' && deployment.pointerRoot.startsWith('/'), 'ADAPTER_POINTER_INVALID', `${nodeKey}/${targetId} needs an absolute pointerRoot`);
      invariant(typeof deployment.service === 'string' && deployment.service.length > 0, 'ADAPTER_SERVICE_INVALID', `${nodeKey}/${targetId} needs a service`);
      if (deployment.hostedBy !== undefined) {
        invariant(safeIdentifier(deployment.hostedBy) && deployment.hostedBy !== nodeKey,
          'ADAPTER_HOST_NODE_INVALID', `${nodeKey}/${targetId} hostedBy must name another node`);
        const hostDeployment = adapter.nodes[deployment.hostedBy]?.deployments?.[targetId];
        invariant(Boolean(hostDeployment), 'ADAPTER_HOST_NODE_TARGET_UNKNOWN', `${nodeKey}/${targetId} host does not deploy ${targetId}`);
        invariant(hostDeployment.hostedBy === undefined, 'ADAPTER_HOST_NODE_CHAIN_INVALID', `${nodeKey}/${targetId} hostedBy cannot form a chain`);
        invariant(deployment.pointerRoot === hostDeployment.pointerRoot,
          'ADAPTER_HOST_POINTER_MISMATCH', `${nodeKey}/${targetId} must use its host pointer`);
        invariant(deployment.service === hostDeployment.service,
          'ADAPTER_HOST_SERVICE_MISMATCH', `${nodeKey}/${targetId} must use its host service`);
      }
    }
  }
  for (const [channelId, channel] of Object.entries(adapter.channels ?? {})) {
    invariant(Boolean(adapter.nodes[channel.node]), 'ADAPTER_CHANNEL_NODE_INVALID', `Channel ${channelId} references unknown node ${channel.node}`);
  }
  return adapter;
}

export function resolveDeployment(adapter, nodeKey, targetId) {
  const requested = adapter.nodes[nodeKey]?.deployments?.[targetId];
  invariant(Boolean(requested), 'ADAPTER_NODE_TARGET_UNKNOWN', `${nodeKey} does not deploy ${targetId}`);
  const executionNode = requested.hostedBy ?? nodeKey;
  return Object.freeze({
    requestedNode: nodeKey,
    executionNode,
    node: adapter.nodes[executionNode],
    deployment: adapter.nodes[executionNode].deployments[targetId],
  });
}

function safeIdentifier(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value);
}

function validateCommands(commands = [], targetId, phase) {
  invariant(Array.isArray(commands), 'ADAPTER_COMMANDS_INVALID', `${targetId}.${phase} must be an array`);
  for (const command of commands) {
    invariant(typeof command?.name === 'string' && command.name.length > 0, 'ADAPTER_COMMAND_NAME_INVALID', `${targetId}.${phase} command needs a name`);
    invariant(Array.isArray(command.argv) && command.argv.length > 0, 'ADAPTER_COMMAND_ARGV_INVALID', `${targetId}.${phase}.${command.name} needs argv`);
    invariant(command.argv.every((entry) => typeof entry === 'string' && entry.length > 0), 'ADAPTER_COMMAND_ARG_INVALID', `${targetId}.${phase}.${command.name} argv must be strings`);
  }
}
