import { basename, dirname, join } from 'node:path';

import { materializeTarget, packageTarget, treeEvidence } from './artifact.mjs';
import { invariant } from './errors.mjs';
import { assertBuildRefIsCheckedOut } from './git.mjs';
import { createPlan } from './planner.mjs';
import { runCommand } from './runner.mjs';
import { runIndependent } from './run-independent.mjs';
import { createRun, readJson, statePaths, writeJson } from './state.mjs';

export async function createReleasePlan(adapter, options) {
  const started = performance.now();
  const created = await createPlan(adapter, options);
  const plan = { ...created, timings: { plan: elapsed(started) } };
  const run = await createRun(adapter, plan);
  return { ...plan, runId: run.runId, planPath: join(run.directory, 'plan.json') };
}

export async function buildRelease(adapter, planPath) {
  const started = performance.now();
  const plan = await readJson(planPath);
  invariant(plan.project === adapter.project, 'BUILD_PROJECT_MISMATCH', 'Plan belongs to another project');
  await assertBuildRefIsCheckedOut(adapter.projectRoot, plan.to.sha);
  const runDirectory = dirname(planPath);
  const phases = { preflight: [], tests: [], typecheck: [], build: [] };
  const timings = { preflight: 0, tests: 0, typecheck: 0, build: 0, materialize: 0 };
  const runPhase = async (phase) => {
    let index = 0;
    for (const command of plan.actions[phase]) {
      const result = await runCommand(command, commandContext(adapter, plan, runDirectory, command.target, `${phase}-${index++}-${command.name}`));
      phases[phase].push(result);
      timings[phase] += result.durationMs;
    }
  };
  await runPhase('preflight');
  await runIndependent([() => runPhase('tests'), () => runPhase('typecheck')]);
  await runPhase('build');
  if (adapter.instanceRoot) {
    for (const target of plan.deploymentOrder) {
      const directory = instanceOutputDirectory(adapter, target);
      if (directory === null) continue;
      const output = await treeEvidence(directory);
      const command = instanceRuntimeCommand(adapter, plan, target, output.treeDigest);
      const result = await runCommand(command, commandContext(adapter, plan, runDirectory, target, `build-node-runtime-${target}`));
      phases.build.push(result);
      timings.build += result.durationMs;
    }
  }
  const materializeStarted = performance.now();
  const targets = [];
  for (const target of plan.deploymentOrder) targets.push(await materializeTarget(adapter, target, runDirectory, plan.changes));
  timings.materialize = elapsed(materializeStarted);
  timings.total = elapsed(started);
  const evidence = {
    schema: 'ai.delivery.build.v1',
    project: adapter.project,
    runId: plan.runId ?? basename(runDirectory),
    sourceSha: plan.to.sha,
    planDigest: plan.planDigest,
    phases,
    targets,
    timings,
    completedAt: new Date().toISOString(),
  };
  const buildPath = join(runDirectory, 'build.json');
  await writeJson(buildPath, evidence);
  return { ...evidence, buildPath };
}

export async function packageRelease(adapter, buildPath) {
  const started = performance.now();
  const build = await readJson(buildPath);
  const runDirectory = dirname(buildPath);
  const plan = await readJson(join(runDirectory, 'plan.json'));
  const state = statePaths(adapter);
  const artifacts = [];
  for (const target of build.targets) artifacts.push(await packageTarget(adapter, plan, target, runDirectory, state.artifacts));
  const result = {
    schema: 'ai.delivery.package-set.v1',
    project: adapter.project,
    runId: build.runId,
    stateRoot: state.root,
    sourceSha: build.sourceSha,
    direct: false,
    prepare: false,
    requestedTargets: [],
    targetScope: plan.targetScope,
    deploymentOrder: plan.deploymentOrder,
    artifacts,
    timings: { package: elapsed(started), total: elapsed(started) },
    completedAt: new Date().toISOString(),
  };
  const packagePath = join(runDirectory, 'package.json');
  await writeJson(packagePath, result);
  return { ...result, packagePath };
}

function commandContext(adapter, plan, runDirectory, target, logName) {
  return { projectRoot: adapter.projectRoot, environment: {}, changedFiles: plan.changes.map((change) => change.path), sourceSha: plan.to.sha, node: '', target: target ?? '', logPath: join(runDirectory, 'logs', `${logName}.log`) };
}

function instanceOutputDirectory(adapter, target) {
  const directory = { console: 'console', 'auth-web': 'auth-web', storefront: 'storefront-web',
    'identity-api': 'services/identity-api', 'web-api': 'services/web-api' }[target];
  return directory ? join(adapter.instanceRoot, 'dist', directory) : null;
}

function instanceRuntimeCommand(adapter, plan, target, artifactDigest) {
  return {
    name: `instance-runtime:${target}`,
    argv: ['node', '--import', 'tsx', '04_tools/scripts/release/generate-node-manifests.mjs',
      '--instance-root', adapter.instanceRoot,
      '--release-output', join(adapter.instanceRoot, 'dist/config/targets', target, 'node-manifests'),
      '--source-sha', plan.to.sha, '--artifact-digest', artifactDigest,
      '--build-id', `r16-${plan.to.sha}`, '--generated-at', new Date().toISOString()],
    timeoutMs: 120_000,
  };
}

function elapsed(started) {
  return Math.round(performance.now() - started);
}
