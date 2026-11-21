import { createHmac } from 'node:crypto';
import type { AuthTarget } from './LoginTarget';

export interface SignedReturnTarget { readonly url: string; readonly proof: string; readonly expiresAt: string }

export class ReturnTargetSigner {
  constructor(private readonly key: string) {}

  issue(target: AuthTarget, url: string, at = new Date()): SignedReturnTarget {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || parsed.search) {
      throw new Error('AUTH_RETURN_TARGET_INVALID');
    }
    const now = at;
    const expiresAt = new Date(now.getTime() + 60_000).toISOString();
    const payload = Buffer.from(JSON.stringify({ version: 1, target, url, expiresAt })).toString('base64url');
    const signature = createHmac('sha256', this.key).update(payload).digest('base64url');
    return Object.freeze({ url, proof: `${payload}.${signature}`, expiresAt });
  }
}
