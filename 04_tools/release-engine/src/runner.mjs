import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { DeliveryError } from './errors.mjs';

export async function runCommand(spec, context) {
  const argv = expandArgv(spec.argv, context);
  const cwd = expandText(spec.cwd ?? context.projectRoot, context);
  const environment = Object.fromEntries(
    Object.entries(spec.environment ?? {}).map(([name, value]) => [name, expandText(value, context)])
  );
  const timeoutMs = spec.timeoutMs ?? 10 * 60_000;
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const output = [];
  let timedOut = false;
  let interruptedSignal = null;
  const result = await new Promise((resolve, reject) => {
    // Give each command its own process group so a timeout also stops its local descendants.
    const useProcessGroup = process.platform !== 'win32';
    let escalation;
    let closedResult;
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env: { ...process.env, ...context.environment, ...environment },
      shell: false,
      detached: useProcessGroup,
      stdio: [spec.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    const terminate = (signal) => {
      if (useProcessGroup && child.pid) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch (error) {
          if (error?.code === 'ESRCH') return;
        }
      }
      child.kill(signal);
    };
    const requestTermination = (signal, reason) => {
      if (reason === 'timeout') timedOut = true;
      else interruptedSignal ??= signal;
      terminate(signal);
      if (escalation) return;
      escalation = setTimeout(() => {
        terminate('SIGKILL');
        if (closedResult) resolve(closedResult);
      }, 2_000);
      escalation.unref();
    };
    const forwardedSignals = process.platform === 'win32' ? ['SIGINT', 'SIGTERM'] : ['SIGHUP', 'SIGINT', 'SIGTERM'];
    const signalHandlers = new Map(forwardedSignals.map((signal) => [signal, () => requestTermination(signal, 'runner-interrupted')]));
    for (const [signal, handler] of signalHandlers) process.on(signal, handler);
    const removeSignalHandlers = () => {
      for (const [signal, handler] of signalHandlers) process.off(signal, handler);
    };
    if (spec.input !== undefined) child.stdin.end(spec.input);
    child.stdout.on('data', (chunk) => output.push(chunk));
    child.stderr.on('data', (chunk) => output.push(chunk));
    child.on('error', (error) => {
      removeSignalHandlers();
      reject(error);
    });
    const timer = setTimeout(() => {
      requestTermination('SIGTERM', 'timeout');
    }, timeoutMs);
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      removeSignalHandlers();
      const completed = { exitCode, signal };
      if (escalation && useProcessGroup && processGroupExists(child.pid)) {
        closedResult = completed;
        escalation.ref();
        return;
      }
      if (escalation) clearTimeout(escalation);
      resolve(completed);
    });
  });
  const durationMs = Math.round(performance.now() - started);
  const log = Buffer.concat(output).toString('utf8');
  if (context.logPath) {
    await mkdir(dirname(context.logPath), { recursive: true });
    await writeFile(context.logPath, log);
  }
  if (timedOut || interruptedSignal || result.exitCode !== 0) {
    const code = timedOut ? 'COMMAND_TIMEOUT' : interruptedSignal ? 'COMMAND_INTERRUPTED' : 'COMMAND_FAILED';
    let remoteFailure = null;
    if (argv[0] === 'ssh') {
      for (const line of log.trim().split(/\r?\n/).reverse()) {
        try {
          const parsed = JSON.parse(line);
          if (parsed?.ok === false && parsed.error) { remoteFailure = parsed.error; break; }
        } catch {}
      }
    }
    throw new DeliveryError(code, `${spec.name} failed`, {
      argv,
      cwd,
      exitCode: result.exitCode,
      signal: interruptedSignal ?? result.signal,
      timeoutMs,
      outputTail: log.slice(-4_000),
      ...(remoteFailure ? { remoteFailure } : {}),
    });
  }
  return { name: spec.name, argv, cwd, startedAt, durationMs, exitCode: result.exitCode, ...(spec.input === undefined ? {} : { inputBytes: Buffer.byteLength(spec.input) }), output: log, outputTail: log.slice(-2_000) };
}

function processGroupExists(pid) {
  if (!pid) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export function expandArgv(argv, context) {
  const result = [];
  for (const argument of argv) {
    if (argument === '{{changedFiles}}') {
      result.push(...context.changedFiles);
    } else {
      result.push(expandText(argument, context));
    }
  }
  return result;
}

export function expandText(value, context) {
  return String(value).replace(/\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g, (_, key) => {
    if (!(key in context)) throw new DeliveryError('COMMAND_TEMPLATE_UNKNOWN', `Unknown command template ${key}`);
    return String(context[key]);
  });
}
