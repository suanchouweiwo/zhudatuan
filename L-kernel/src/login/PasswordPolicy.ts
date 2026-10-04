import { randomBytes, scrypt as derive, timingSafeEqual } from 'node:crypto';
import { passwordMeetsPolicy } from '@shop/contract/password-policy';
const VERSION = 'v1';
const COST = 32_768;
const BLOCK = 8;
const PARALLEL = 1;
const MAX_MEMORY = 64 * 1024 * 1024;
function scrypt(password: string, salt: Buffer, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => derive(password, salt, length, { N: COST, r: BLOCK, p: PARALLEL, maxmem: MAX_MEMORY },
    (cause, result) => cause ? reject(cause) : resolve(result)));
}

export class PasswordPolicy {
  validate(password: string): void {
    if (!passwordMeetsPolicy(password)) {
      throw new Error('PASSWORD_POLICY_REJECTED');
    }
  }

  async hash(password: string): Promise<string> {
    this.validate(password);
    const salt = randomBytes(16);
    const result = await scrypt(password, salt, 64);
    return `scrypt$${VERSION}$${COST}$${BLOCK}$${PARALLEL}$${salt.toString('base64url')}$${result.toString('base64url')}`;
  }

  async verify(password: string, encoded: string | null): Promise<boolean> {
    if (encoded === null) {
      await scrypt(password, Buffer.alloc(16), 64);
      return false;
    }
    const [algorithm, version, costValue, blockValue, parallelValue, saltValue, hashValue] = encoded.split('$');
    if (algorithm !== 'scrypt' || version !== VERSION || Number(costValue) !== COST || Number(blockValue) !== BLOCK || Number(parallelValue) !== PARALLEL || !saltValue || !hashValue) return false;
    const expected = Buffer.from(hashValue, 'base64url');
    const actual = await scrypt(password, Buffer.from(saltValue, 'base64url'), expected.length);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
}
