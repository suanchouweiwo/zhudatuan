import { createHash } from 'node:crypto';

export class AuthTransaction {
  private constructor(readonly state: string, readonly nonce: string, readonly challenge: string) { Object.freeze(this); }

  static start(value: unknown): AuthTransaction {
    const record = object(value, 'AUTH_TRANSACTION_REQUIRED');
    return new AuthTransaction(token(record.state, 'AUTH_STATE_INVALID', 32, 128), token(record.nonce, 'AUTH_NONCE_INVALID', 32, 128),
      token(record.challenge, 'AUTH_PKCE_CHALLENGE_INVALID', 43, 43));
  }

  static complete(value: unknown): Readonly<{ ticket: string; stateHash: string; nonceHash: string; challenge: string }> {
    const record = object(value, 'AUTH_EXCHANGE_INVALID');
    const verifier = token(record.verifier, 'AUTH_PKCE_VERIFIER_INVALID', 43, 128);
    return Object.freeze({ ticket: token(record.ticket, 'AUTH_TICKET_INVALID', 64, 128),
      stateHash: hash(token(record.state, 'AUTH_STATE_INVALID', 32, 128)), nonceHash: hash(token(record.nonce, 'AUTH_NONCE_INVALID', 32, 128)),
      challenge: createHash('sha256').update(verifier).digest('base64url') });
  }

  get stateHash(): string { return hash(this.state); }
  get nonceHash(): string { return hash(this.nonce); }
}

function object(value: unknown, code: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  return value as Readonly<Record<string, unknown>>;
}

function token(value: unknown, code: string, minimum: number, maximum: number): string {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(code);
  return value;
}

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
