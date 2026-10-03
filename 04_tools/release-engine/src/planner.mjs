import { matchesAny } from './glob.mjs';
import { digest } from './stable.mjs';
import { changedFiles, currentHead, resolveGitRef } from './git.mjs';
import { invariant } from './errors.mjs';
import { resolveDeployment } from './adapter.mjs';

export async function createPlan(adapter, options = {}) {
  const direct = options.direct === true;
  const prepare = options.prepare === true;
  const forcedSingleTarget = direct || prepare;
  if (forcedSingleTarget) {
    invariant(typeof options.target === 'string' && options.target.length > 0, prepare ? 'PREPARE_TARGET_REQUIRED' : 'DIRECT_TARGET_REQUIRED', `${prepare ? 'Prepare Artifact' : 'Direct delivery'} requires exactly one explicit target`);
    invariant(/^[a-f0-9]{40}$/.test(options.to ?? ''), prepare ? 'PREPARE_SHA_REQUIRED' : 'DIRECT_SHA_REQUIRED', `${prepare ? 'Prepare Artifact' : 'Direct delivery'} requires one full lowercase Git commit SHA`);
  }
  if (direct) {
    invariant((options.nodes ?? []).length === 1, 'DIRECT_NODE_REQUIRED', 'Direct delivery requires exactly one explicit node');
  }
  const fromRef = options.from ?? adapter.defaultBaseRef ?? 'HEAD^';
  const toRef = options.to ?? 'HEAD';
  const requestedTargets = options.target === undefined ? [] : [options.target];
  for (const target of requestedTargets) invariant(Boolean(adapter.targets[target]), 'PLAN_TARGET_UNKNOWN', `Unknown target ${target}`);
  const [fromSha, toSha] = await Promise.all([resolveGitRef(adapter.projectRoot, fromRef), resolveGitRef(adapter.projectRoot, toRef)]);
  const changes = await changedFiles(adapter.projectRoot, fromSha, toSha, options.files ?? []);
  const initial = classifyChanges(adapter, changes);
  const refined = await refineDynamicImpact(adapter, initial, changes, { fromSha, toSha });
  const classification =
    requestedTargets.length > 0
      ? forcedSingleTarget
        ? { ...refined, targets: requestedTargets, reasons: [prepare ? 'explicit artifact preparation' : 'explicit direct deployment'], validations: [], touches: [], unknownFiles: [] }
        : scopeClassification(adapter, refined, requestedTargets)
      : refined;
  const scopedChanges = requestedTargets.length > 0 ? changes.filter((change) => classification.files.some((file) => sameChange(file, change))) : changes;
  const targets = expandTargetDependencies(adapter, classification.targets);
  invariant(
    !forcedSingleTarget || targets.length === 1,
    prepare ? 'PREPARE_SCOPE_EXPANSION_FORBIDDEN' : 'DIRECT_SCOPE_EXPANSION_FORBIDDEN',
    `${prepare ? 'Prepare Artifact' : 'Direct delivery'} cannot expand beyond the one requested target`,
    { requestedTargets, targets }
  );
  const requestedNodes = options.nodes ?? [];
  for (const node of requestedNodes) invariant(Boolean(adapter.nodes[node]), 'PLAN_NODE_UNKNOWN', `Unknown node ${node}`);
  const eligibleNodes = eligibleNodesForTargets(adapter, targets);
  for (const node of requestedNodes) {
    for (const target of targets) invariant(Boolean(adapter.nodes[node].deployments[target]), 'PLAN_NODE_TARGET_UNSUPPORTED', `${node} does not deploy ${target}`);
  }
  const actions = materializeActions(adapter, targets, requestedNodes, scopedChanges, classification.validations, direct || prepare);
  const deploymentOrder = orderTargets(adapter, targets);
  const plan = {
    schema: 'ai.delivery.plan.v2',
    engineVersion: 2,
    project: adapter.project,
    adapter: adapter.adapterPath,
    direct,
    prepare,
    from: { ref: fromRef, sha: fromSha },
    to: { ref: toRef, sha: toSha },
    deployRequired: targets.length > 0,
    changes: scopedChanges,
    classifications: classification.files,
    reasons: classification.reasons,
    targets,
    requestedTargets,
    targetScope: requestedTargets.length > 0 ? { mode: 'explicit', requestedTargets, excludedChangeCount: changes.length - scopedChanges.length } : { mode: 'affected', requestedTargets: [], excludedChangeCount: 0 },
    impact: { flags: classification.touches, unknownFiles: classification.unknownFiles },
    requiredValidations: actions.requiredValidations,
    dependencyInstallRequired: [...actions.preflight, ...actions.tests, ...actions.typecheck, ...actions.build].length > 0,
    artifacts: targets.map((target) => ({ target, inputs: adapter.targets[target].artifactInputs })),
    deploymentOrder,
    eligibleNodes,
    selectedNodes: requestedNodes,
    selectedRealms: requestedNodes.map((node) => adapter.nodes[node].realmId).filter(Boolean),
    impactFlags: classification.touches,
    actions,
    prohibitedRestarts: requestedNodes.flatMap((nodeKey) =>
      Object.entries(adapter.nodes[nodeKey].deployments)
        .filter(([target]) => !targets.includes(target))
        .map(([target, deployment]) => ({ node: nodeKey, target, service: deployment.service }))
    ),
    productionApproval: direct ? { required: false, token: null } : { required: true, token: `${adapter.project}:${toSha}` },
    estimates: estimate(adapter, targets, actions),
  };
  return Object.freeze({ ...plan, generatedAt: new Date().toISOString(), planDigest: digest(plan) });
}

export function classifyChanges(adapter, changes) {
  if (changes.length === 0) return Object.freeze({ targets: [], files: [], reasons: ['no changes'], touches: [], validations: [], unknownFiles: [] });
  const files = [],
    targets = new Set(),
    reasons = new Set(),
    touches = new Set(),
    validations = [],
    unknownFiles = [];
  for (const change of changes) {
    const paths = [change.path, change.sourcePath].filter(Boolean);
    const allMatched = adapter.rules.filter((rule) => paths.some((path) => matchesAny(path, rule.include) && !matchesAny(path, rule.exclude ?? [])));
    const matched = allMatched.some((rule) => rule.validationOnly) ? allMatched.filter((rule) => rule.validationOnly) : allMatched;
    if (matched.length === 0) {
      const upperBound = reachableRuntimeTargets(adapter);
      for (const target of upperBound) targets.add(target);
      unknownFiles.push(change.path);
      reasons.add(`unclassified:${change.path}; selected reachable runtime target upper bound`);
      files.push({ ...change, targets: upperBound, rules: [], validations: [], touches: [], reasons: [`unclassified:${change.path}; selected reachable runtime target upper bound`], impact: 'reachable-upper-bound' });
      continue;
    }
    const fileTargets = [...new Set(matched.flatMap((rule) => rule.targets ?? []))].sort();
    for (const target of fileTargets) targets.add(target);
    const fileTouches = [],
      fileValidations = [],
      fileReasons = [];
    for (const rule of matched) {
      for (const touch of rule.touches ?? []) touches.add(touch);
      validations.push(...(rule.validations ?? []));
      reasons.add(rule.reason ?? rule.id);
      fileTouches.push(...(rule.touches ?? []));
      fileValidations.push(...(rule.validations ?? []));
      fileReasons.push(rule.reason ?? rule.id);
    }
    files.push({
      ...change,
      targets: fileTargets,
      rules: matched.map((rule) => rule.id).sort(),
      validations: uniqueCommands(fileValidations),
      touches: [...new Set(fileTouches)].sort(),
      reasons: [...new Set(fileReasons)].sort(),
      dynamicImpact: [...new Set(matched.map((rule) => rule.dynamicImpact).filter(Boolean))],
      impact: fileTargets.length > 0 ? 'runtime' : 'validation-only',
    });
  }
  return Object.freeze({ targets: [...targets].sort(), files, reasons: [...reasons].sort(), touches: [...touches].sort(), validations: uniqueCommands(validations), unknownFiles: unknownFiles.sort() });
}

function scopeClassification(adapter, classification, requestedTargets) {
  const requested = new Set(requestedTargets);
  const targets = classification.targets.filter((target) => requested.has(target));
  if (targets.length === 0) {
    return { ...classification, targets: [], files: [], reasons: ['no changes for requested targets'], touches: [], validations: [], unknownFiles: [] };
  }
  const files = classification.files.filter((file) => fileRelatesToTargets(adapter, file, requested));
  const dynamic = files.some((file) => (file.dynamicImpact ?? []).length > 0);
  return {
    ...classification,
    targets,
    files,
    reasons: dynamic ? classification.reasons : [...new Set(files.flatMap((file) => file.reasons ?? []))].sort(),
    touches: dynamic ? classification.touches : [...new Set(files.flatMap((file) => file.touches ?? []))].sort(),
    validations: dynamic ? classification.validations : uniqueCommands(files.flatMap((file) => file.validations ?? [])),
    unknownFiles: classification.unknownFiles.filter((path) => files.some((file) => file.path === path)),
  };
}

function fileRelatesToTargets(adapter, file, requested) {
  if (file.targets.some((target) => requested.has(target))) return true;
  const paths = [file.path, file.sourcePath].filter(Boolean);
  return adapter.rules.some((rule) => !rule.validationOnly && (rule.targets ?? []).some((target) => requested.has(target)) && paths.some((path) => matchesAny(path, rule.include) && !matchesAny(path, rule.exclude ?? [])));
}

function sameChange(left, right) {
  return left.path === right.path && left.status === right.status && left.sourcePath === right.sourcePath;
}

async function refineDynamicImpact(adapter, classification, changes, refs) {
  const dynamicFiles = classification.files.filter((file) => (file.dynamicImpact ?? []).length > 0);
  if (dynamicFiles.length === 0) return classification;
  if (refs.toSha !== (await currentHead(adapter.projectRoot))) return { ...classification, reasons: [...classification.reasons, 'dynamic impact requires target commit checked out'] };
  const dynamicPaths = new Set(dynamicFiles.flatMap((file) => [file.path, file.sourcePath].filter(Boolean)));
  const staticTargets = new Set(classification.targets);
  for (const file of dynamicFiles) for (const target of file.targets) staticTargets.delete(target);
  const dynamicTargets = new Set(),
    dynamicReasons = [],
    dynamicValidations = [],
    resolvedByPath = new Map();
  const resolverIds = [...new Set(dynamicFiles.flatMap((file) => file.dynamicImpact))].sort();
  for (const resolverId of resolverIds) {
    const definition = adapter.impactResolvers?.[resolverId];
    invariant(Boolean(definition), 'IMPACT_RESOLVER_UNKNOWN', `Unknown impact resolver ${resolverId}`);
    const resolver = await import(new URL(definition.module, `file://${adapter.adapterPath}`).href);
    invariant(typeof resolver.resolveImpact === 'function', 'IMPACT_RESOLVER_INVALID', `${resolverId} must export resolveImpact`);
    const resolverPaths = new Set(dynamicFiles.filter((file) => file.dynamicImpact.includes(resolverId)).flatMap((file) => [file.path, file.sourcePath].filter(Boolean)));
    const resolverChanges = changes.filter((change) => [change.path, change.sourcePath].filter(Boolean).some((path) => resolverPaths.has(path)));
    const impact = await resolver.resolveImpact({ adapter, changes: resolverChanges, refs, definition });
    invariant(Array.isArray(impact?.targets) && impact.targets.every((target) => Boolean(adapter.targets[target])), 'IMPACT_TARGET_INVALID', `${resolverId} returned unknown targets`);
    for (const target of impact.targets) dynamicTargets.add(target);
    dynamicReasons.push(...(impact.reasons ?? [`dynamic:${resolverId}`]));
    dynamicValidations.push(...(impact.validations ?? []));
    for (const path of resolverPaths) resolvedByPath.set(path, impact.targets);
  }
  const targets = [...new Set([...staticTargets, ...dynamicTargets])].sort();
  return {
    ...classification,
    targets,
    reasons: [...new Set([...classification.reasons, ...dynamicReasons])].sort(),
    validations: uniqueCommands([...classification.validations, ...dynamicValidations]),
    files: classification.files.map((file) => (dynamicPaths.has(file.path) ? { ...file, targets: resolvedByPath.get(file.path) ?? [], impact: (resolvedByPath.get(file.path) ?? []).length > 0 ? 'runtime' : 'validation-only' } : file)),
  };
}

function reachableRuntimeTargets(adapter) {
  return Object.entries(adapter.targets)
    .filter(([, target]) => target.kind !== 'migration' && target.unknownImpact !== false)
    .map(([target]) => target)
    .sort();
}

function expandTargetDependencies(adapter, targets) {
  const selected = new Set(targets);
  const visit = (target) => {
    for (const dependency of adapter.targets[target]?.requires ?? [])
      if (!selected.has(dependency)) {
        selected.add(dependency);
        visit(dependency);
      }
  };
  for (const target of [...selected]) visit(target);
  return [...selected].sort();
}

export function orderTargets(adapter, targets) {
  const selected = new Set(targets),
    ordered = [],
    visiting = new Set(),
    visited = new Set();
  const visit = (target) => {
    invariant(!visiting.has(target), 'TARGET_DEPENDENCY_CYCLE', `Target dependency cycle at ${target}`);
    if (visited.has(target)) return;
    visiting.add(target);
    for (const dependency of adapter.targets[target]?.after ?? []) if (selected.has(dependency)) visit(dependency);
    visiting.delete(target);
    visited.add(target);
    ordered.push(target);
  };
  for (const target of [...selected].sort()) visit(target);
  return ordered;
}

function eligibleNodesForTargets(adapter, targets) {
  if (targets.length === 0) return [];
  return Object.entries(adapter.nodes)
    .filter(([, node]) => targets.every((target) => Boolean(node.deployments[target])))
    .map(([key]) => key)
    .sort();
}

function materializeActions(adapter, targets, selectedNodes, changes, validations, direct = false) {
  const changed = changes.map((change) => change.path);
  const preflight = !direct && targets.length > 0 ? decorateCommands(adapter.buildPreflight ?? [], 'workspace', changed) : [];
  const tests = direct ? [] : decorateCommands(validations, 'changed-files', changed),
    typecheck = [],
    build = [],
    artifactInputs = [];
  for (const targetId of targets) {
    const target = adapter.targets[targetId];
    if (!direct) tests.push(...decorateCommands(target.tests, targetId, changed));
    if (!direct) typecheck.push(...decorateCommands(target.typecheck, targetId, changed));
    build.push(...decorateCommands(target.build, targetId, changed));
    artifactInputs.push(...target.artifactInputs.map((input) => ({ ...input, target: targetId })));
  }
  const deployments = new Map();
  for (const requestedNode of selectedNodes)
    for (const targetId of targets) {
      const resolved = resolveDeployment(adapter, requestedNode, targetId);
      const { executionNode, deployment } = resolved,
        key = `${executionNode}:${targetId}`,
        existing = deployments.get(key);
      if (existing) {
        existing.requestedNodes.push(requestedNode);
        continue;
      }
      deployments.set(key, {
        node: executionNode,
        nodeId: resolved.node.nodeId,
        realmId: resolved.node.realmId,
        requestedNodes: [requestedNode],
        target: targetId,
        pointerRoot: deployment.pointerRoot,
        currentPointer: `${deployment.pointerRoot}/current`,
        previousPointer: `${deployment.pointerRoot}/previous`,
        service: deployment.service,
        restart: deployment.restart ?? 'systemd',
        health: deployment.health ?? [],
      });
    }
  const actions = { preflight: uniqueCommands(preflight), tests: uniqueCommands(tests), typecheck: uniqueCommands(typecheck), build: uniqueCommands(build), artifactInputs, deployments: [...deployments.values()] };
  actions.requiredValidations = [...actions.tests, ...actions.typecheck].map(({ name, target, argv }) => ({ name, target, argv }));
  return actions;
}

function uniqueCommands(commands) {
  const seen = new Set();
  return commands.filter((command) => {
    const key = JSON.stringify({ argv: command.argv, cwd: command.cwd ?? null, environment: command.environment ?? null });
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function decorateCommands(commands = [], target, changedFiles) {
  return commands.map((command) => ({ ...command, target, changedFiles }));
}

function estimate(adapter, targets, actions) {
  return { estimatedSeconds: targets.reduce((total, target) => total + (adapter.targets[target].estimateSeconds ?? 0), 0), targetCount: targets.length, validationCount: actions.requiredValidations.length };
}
