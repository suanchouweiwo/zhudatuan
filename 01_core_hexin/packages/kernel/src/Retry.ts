import type { Deadline } from './deadline';
import { errorCause } from './ErrorCause';

export type RetryMode = 'read' | 'businesskeywrite';

export interface RetryPolicy {
  readonly mode: RetryMode;
  readonly attempts: number;
  readonly minimumDelayMilliseconds: number;
  readonly maximumDelayMilliseconds: number;
  readonly deadline: Deadline;
  readonly retryable: (cause: unknown) => boolean;
  readonly random?: () => number;
}

export async function retry<T>(operation: (attempt: number, signal: AbortSignal) => Promise<T>, policy: RetryPolicy): Promise<T> {
  validate(policy);
  let last: Error | undefined;
  for (let attempt = 1; attempt <= policy.attempts; attempt += 1) {
    policy.deadline.throwIfExpired();
    try {
      return await operation(attempt, policy.deadline.signal);
    } catch (cause) {
      const error = errorCause(cause, 'RETRY_FAILED');
      last = error;
      if (attempt === policy.attempts || !policy.retryable(cause)) throw error;
      const delay = retryDelay(attempt, policy.minimumDelayMilliseconds, policy.maximumDelayMilliseconds, policy.random);
      if (delay >= policy.deadline.remaining()) throw new Error('DEADLINE_EXCEEDED', { cause });
      await wait(delay, policy.deadline.signal);
    }
  }
  throw last ?? new Error('RETRY_EXHAUSTED');
}

export function retryDelay(attempt: number, minimumMilliseconds: number, maximumMilliseconds: number, random: () => number = Math.random): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1 || !Number.isSafeInteger(minimumMilliseconds) || minimumMilliseconds < 0
    || !Number.isSafeInteger(maximumMilliseconds) || maximumMilliseconds < minimumMilliseconds) throw new Error('RETRY_DELAY_INVALID');
  const ceiling = Math.min(maximumMilliseconds, minimumMilliseconds * 2 ** Math.min(20, attempt - 1));
  return Math.floor(minimumMilliseconds + random() * Math.max(1, ceiling - minimumMilliseconds));
}

function validate(policy: RetryPolicy): void {
  if (!['read', 'businesskeywrite'].includes(policy.mode) || !Number.isSafeInteger(policy.attempts) || policy.attempts < 1
    || !Number.isSafeInteger(policy.minimumDelayMilliseconds) || policy.minimumDelayMilliseconds < 0
    || !Number.isSafeInteger(policy.maximumDelayMilliseconds) || policy.maximumDelayMilliseconds < policy.minimumDelayMilliseconds) {
    throw new Error('RETRY_POLICY_INVALID');
  }
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(errorCause(signal.reason, 'OPERATION_ABORTED'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(errorCause(signal.reason, 'OPERATION_ABORTED'));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}
