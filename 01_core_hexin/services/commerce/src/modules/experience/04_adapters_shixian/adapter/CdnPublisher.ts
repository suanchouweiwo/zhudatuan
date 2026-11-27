import { createHash } from 'node:crypto';
import { serializeExperience } from '@shop/contract';
import type { ObjectStore, StoredObject } from '../../../../foundation/infrastructure/ObjectStore';

export function experienceObjectKey(application: string, contentHash: string): string {
  const directory = createHash('sha256').update(application).digest('hex');
  return `experience/${directory}/${contentHash}.json`;
}

export class CdnPublisher {
  constructor(private readonly objects: ObjectStore) {}

  async publish(path: string, document: unknown, expectedHash: string, signal: AbortSignal): Promise<StoredObject> {
    if (signal.aborted) throw signal.reason;
    if (!/^experience\/[a-zA-Z0-9:.-]+\/[a-f0-9]{64}\.json$/.test(path)) throw new Error('EXPERIENCE_OBJECT_PATH_INVALID');
    const bytes = new TextEncoder().encode(serializeExperience(document));
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (hash !== expectedHash) throw new Error('EXPERIENCE_CONTENT_HASH_MISMATCH');
    const current = await this.objects.find(path);
    if (current) {
      if (current.sha256 !== hash || current.contentType !== 'application/json' || current.size !== bytes.byteLength || current.scan !== 'clean') {
        throw new Error('EXPERIENCE_OBJECT_COLLISION');
      }
      return current;
    }
    const upload = await this.objects.create(path, 'application/json');
    try {
      await upload.append(bytes);
      const stored = await upload.complete();
      if (stored.sha256 !== hash || stored.size !== bytes.byteLength || stored.scan !== 'clean') throw new Error('EXPERIENCE_OBJECT_INTEGRITY_INVALID');
      const verified = await this.objects.inspect(stored.reference);
      if (verified.sha256 !== hash || verified.size !== bytes.byteLength || verified.contentType !== 'application/json' || verified.scan !== 'clean') {
        throw new Error('EXPERIENCE_OBJECT_VERIFICATION_INVALID');
      }
      return stored;
    } catch (cause) {
      await upload.abort().catch(() => undefined);
      throw cause;
    }
  }
}
