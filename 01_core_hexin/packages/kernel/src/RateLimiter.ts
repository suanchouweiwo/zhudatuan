import type { Deadline } from './deadline';
import { errorCause } from './ErrorCause';

export class RateLimiter {
  private tokens: number;
  private updatedAt: number;
  private chain = Promise.resolve();

  constructor(private readonly ratePerSecond: number, private readonly capacity = Math.max(1, ratePerSecond), private readonly now: () => number = Date.now) {
    if (!Number.isFinite(ratePerSecond) || ratePerSecond <= 0 || !Number.isSafeInteger(capacity) || capacity < 1) throw new Error('RATE_LIMITER_INVALID');
    this.tokens = capacity;
    this.updatedAt = now();
  }

  acquire(deadline: Deadline): Promise<void> {
    const next = this.chain.then(() => this.waitForToken(deadline));
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async waitForToken(deadline: Deadline): Promise<void> {
    for (;;) {
      deadline.throwIfExpired();
      const now = this.now();
      const elapsed = Math.max(0, now - this.updatedAt);
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.ratePerSecond / 1000);
      this.updatedAt = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const delay = Math.ceil((1 - this.tokens) * 1000 / this.ratePerSecond);
      if (delay > deadline.remaining()) throw new Error('DEADLINE_EXCEEDED');
      await wait(delay, deadline.signal);
    }
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
