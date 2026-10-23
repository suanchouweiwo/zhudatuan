import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createAutoNodeControlServer, requireLoopbackControlHost } from './autonode-control-server.mjs';
import { AutoNodeActivationCliExecutor } from './autonode-task-executor.mjs';
import { AutoNodeTaskEngine } from './autonode-task-engine.mjs';
import { DEFAULT_L_ARCH_STATE_PATH, LArchStateFile } from './l-arch-state-file.mjs';

const host = requireLoopbackControlHost(process.env.AUTONODE_CONTROL_HOST ?? '127.0.0.1');
const port = number(process.env.AUTONODE_CONTROL_PORT ?? '4370', 'AUTONODE_CONTROL_PORT');
const taskStateRoot = resolve(process.env.AUTONODE_TASK_STATE_ROOT ?? '/var/lib/sfl-autonode-control');
const activationStateRoot = resolve(process.env.AUTONODE_ACTIVATION_STATE_ROOT ?? join(taskStateRoot, 'activation'));
const providerStateRoot = resolve(process.env.AUTONODE_PROVIDER_STATE_ROOT ?? join(taskStateRoot, 'provider'));
const archStatePath = resolve(process.env.L_ARCH_STATE_PATH ?? DEFAULT_L_ARCH_STATE_PATH);

await mkdir(taskStateRoot, { recursive: true });
await mkdir(activationStateRoot, { recursive: true });
await mkdir(providerStateRoot, { recursive: true });

const executor = new AutoNodeActivationCliExecutor({
  stateRoot: activationStateRoot,
  providerStateRoot,
});
const engine = new AutoNodeTaskEngine(taskStateRoot, executor);
const recovered = await engine.recover();
const server = createAutoNodeControlServer(engine, new LArchStateFile(archStatePath));

server.listen(port, host, () => {
  process.stdout.write(`AUTONODE_CONTROL_READY host=${host} port=${port} recovered=${recovered}\n`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => server.close(() => process.exit(0)));
}

function number(value, name) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) throw new Error(`${name}_INVALID`);
  return parsed;
}
