import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProductionNodeOperationsProvider } from './autonode-operations-provider.mjs';

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export class AutoNodeActivationCliExecutor {
  constructor({
    stateRoot,
    providerStateRoot,
    activationCli = fileURLToPath(new URL('./autonode-activate-runtime.mjs', import.meta.url)),
    runner = runCommand,
  }) {
    this.stateRoot = resolve(requiredText(stateRoot, 'stateRoot'));
    this.providerStateRoot = resolve(requiredText(providerStateRoot, 'providerStateRoot'));
    this.activationCli = resolve(requiredText(activationCli, 'activationCli'));
    this.runner = runner;
  }

  async plan(request) {
    return await this.#execute('plan', request);
  }

  async apply(request, approvedPlanDigest) {
    return await this.#execute('apply', request, requiredText(approvedPlanDigest, 'approvedPlanDigest'));
  }

  async lifecycle(request, progress) {
    const configuration = JSON.parse(await readFile(process.env.AUTONODE_INSTANCES_FILE
      ?? '/opt/sfl/control/autonode/instances.json', 'utf8'));
    const instance = configuration.instances.find((entry) => entry.node_id === request.node_id);
    if (!instance) throw new Error('AUTONODE_INSTANCE_NOT_FOUND');
    if (!instance.lifecycle) throw new Error('AUTONODE_INSTANCE_LIFECYCLE_UNAVAILABLE');
    const operation = {
      target: { node_id: instance.node_id, node_directory: `/opt/sfl/nodes/${instance.instance}` },
    };
    if (request.action === 'DELETE') {
      await progress('DELETING', 20, '正在删除实例的服务、数据库、文件和域名入口');
      const cloudflareApiToken = configuration.cloudflareTokenFile
        ? (await readFile(configuration.cloudflareTokenFile, 'utf8')).trim() : undefined;
      await new ProductionNodeOperationsProvider({ cloudflareApiToken }).delete(operation);
      return { manifest_id: null, access_entries: [] };
    }
    const credential = (await readFile(configuration.githubTokenFile, 'utf8')).trim();
    const api = async (path, body) => {
      const response = await fetch(`https://api.github.com/repos/${configuration.repository}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${credential}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) throw new Error(`AUTONODE_RUNNER_REQUEST_FAILED:${response.status}`);
      return response.status === 204 ? null : await response.json();
    };
    const release = async (targets, domainSwitch, stage) => {
      const requestId = `${request.task_id.replace(/[^a-zA-Z0-9-]/g, '-')}-${stage}`;
      const path = '/actions/workflows/delivery-1-6.yml';
      const findRun = async () => (await api(`${path}/runs?event=workflow_dispatch&per_page=100`)).workflow_runs
        .find((run) => run.display_title?.includes(`[${requestId}]`));
      let run = await findRun();
      if (run?.status === 'completed' && run.conclusion !== 'success') {
        await api(`/actions/runs/${run.id}/rerun`, {});
        await new Promise((done) => setTimeout(done, 10000));
      }
      if (!run) {
        await api(`${path}/dispatches`, { ref: configuration.controlRef ?? 'zdt-next', inputs: {
          operation: 'release', identifier: instance.sourceSha,
          release_target: targets.join(','), physical_node: targets.map(() => instance.instance).join(','),
          instance_path: instance.instancePath, request_id: requestId, execution_location: 'auto',
          domain_switch: String(domainSwitch),
        } });
      }
      const deadline = Date.now() + 30 * 60 * 1000;
      while (Date.now() < deadline) {
        run = run ? await api(`/actions/runs/${run.id}`) : await findRun();
        if (run?.status === 'completed') {
          if (run.conclusion !== 'success') throw new Error(`AUTONODE_RUNNER_FAILED:${run.html_url}`);
          return;
        }
        await new Promise((done) => setTimeout(done, 10000));
      }
      throw new Error('AUTONODE_RUNNER_PENDING');
    };
    await progress('DATABASE', 20, 'Runner 正在初始化独立空库');
    await release(['database-migration'], false, 'database');
    await progress('RELEASING', 50, 'Runner 正在安装同一核心的商城、登录和后台');
    await release(['identity-api', 'web-api', 'storefront', 'auth-web', 'console'], false, 'applications');
    await progress('INGRESS', 80, 'Runner 正在接通实例入口');
    await release(['database-migration'], true, 'ingress');
    for (const target of ['identity-api', 'web-api', 'storefront', 'auth-web', 'console']) {
      const manifest = JSON.parse(await readFile(`/opt/sfl/nodes/${instance.instance}/targets/${target}/current/AI_DELIVERY_ARTIFACT.json`, 'utf8'));
      if (manifest.sourceSha !== instance.sourceSha) throw new Error(`AUTONODE_INSTANCE_VERSION_MISMATCH:${target}`);
    }
    for (const port of instance.healthPorts) {
      const response = await fetch(`http://127.0.0.1:${port}/health/ready`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`AUTONODE_INSTANCE_NOT_READY:${port}`);
    }
    return { manifest_id: null, access_entries: instance.access_entries };
  }

  async instances() {
    const configuration = JSON.parse(await readFile(process.env.AUTONODE_INSTANCES_FILE
      ?? '/opt/sfl/control/autonode/instances.json', 'utf8'));
    return await Promise.all(configuration.instances.map(async (instance) => {
      const inventory = await readFile(`/var/lib/sfl-autonode-control/resources/${instance.instance}.json`, 'utf8')
        .then(JSON.parse).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
      return { node_id: instance.node_id, instance: instance.instance, name: instance.name,
        lifecycle: instance.lifecycle === true, state: inventory?.state ?? 'EXISTING', access_entries: instance.access_entries };
    }));
  }

  async #execute(command, request, approvedPlanDigest) {
    await mkdir(this.stateRoot, { recursive: true });
    const temporary = await mkdtemp(join(this.stateRoot, '.request-'));
    const requestFile = join(temporary, 'activation-request.json');
    await writeFile(requestFile, `${JSON.stringify(request, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
      const args = [
        this.activationCli,
        command,
        '--state-root', this.stateRoot,
        '--provider-state-root', this.providerStateRoot,
        '--request', requestFile,
        ...(approvedPlanDigest === undefined ? [] : ['--approved-plan-digest', approvedPlanDigest]),
      ];
      const output = await this.runner(process.execPath, args, { cwd: dirname(this.activationCli) });
      try {
        return JSON.parse(output);
      } catch {
        throw new Error(`AUTONODE_TASK_EXECUTOR_OUTPUT_INVALID:${command}`);
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}

async function runCommand(command, args, options) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const collect = (target, chunk) => {
      const next = target + chunk.toString('utf8');
      if (Buffer.byteLength(next) > MAX_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        throw new Error('AUTONODE_TASK_EXECUTOR_OUTPUT_TOO_LARGE');
      }
      return next;
    };
    child.stdout.on('data', (chunk) => {
      try { stdout = collect(stdout, chunk); } catch (cause) { rejectPromise(cause); }
    });
    child.stderr.on('data', (chunk) => {
      try { stderr = collect(stderr, chunk); } catch (cause) { rejectPromise(cause); }
    });
    child.once('error', rejectPromise);
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise(stdout.trim());
      else rejectPromise(new Error(`AUTONODE_TASK_EXECUTOR_FAILED:${code ?? signal}:${stderr.trim().slice(-1000)}`));
    });
  });
}

function requiredText(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`AUTONODE_TASK_EXECUTOR_FIELD_INVALID:${name}`);
  return value.trim();
}
