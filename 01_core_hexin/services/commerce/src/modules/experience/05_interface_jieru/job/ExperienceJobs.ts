import type { ClaimedJob, JobProcessor } from '../../../../foundation/application/JobRunner';
import type { ObjectStore, StoredObject } from '../../../../foundation/infrastructure/ObjectStore';
import type { DatabasePool } from '../../../../foundation/persistence/Pool';
import { CdnPublisher } from '../../04_adapters_shixian/adapter/CdnPublisher';
import type { Cache } from '../../../../foundation/cache/Cache';
import { VersionedKey } from '../../../../foundation/cache/VersionedKey';
import { CACHE_CATALOG } from '@shop/config/runtime';
import type { PublishedExperience } from '../../03_application_yingyong/ExperienceOperations';
import { applyJobDatabaseContext } from '../../../../foundation/infrastructure/DatabaseContext';

interface PublicationRow {
  readonly application_id: string;
  readonly configuration: unknown;
  readonly configuration_hash: string;
  readonly effective_at: string;
  readonly release_id: string;
  readonly state: string;
  readonly version_id: string;
}

export class ExperienceJobProcessor implements JobProcessor {
  private readonly publisher: CdnPublisher;

  constructor(private readonly pool: DatabasePool, objects: ObjectStore, private readonly cache?: Cache,
    private readonly scope?: string) { this.publisher = new CdnPublisher(objects); }

  async process(job: ClaimedJob, signal: AbortSignal): Promise<void> {
    if (job.kind !== 'experiencepublish') throw new Error('JOB_KIND_MISMATCH');
    const envelope = record(job.payload, 'EXPERIENCE_EVENT_ENVELOPE_INVALID');
    if (text(envelope.event, 'EXPERIENCE_EVENT_TYPE_REQUIRED') !== 'experience.published') throw new Error('EXPERIENCE_EVENT_TYPE_INVALID');
    const event = text(envelope.eventId, 'EXPERIENCE_EVENT_ID_REQUIRED');
    const payload = record(envelope.payload, 'EXPERIENCE_EVENT_PAYLOAD_INVALID');
    const release = text(payload.release, 'EXPERIENCE_RELEASE_REQUIRED');
    const path = text(payload.key, 'EXPERIENCE_OBJECT_KEY_REQUIRED');
    const expected = text(payload.hash, 'EXPERIENCE_HASH_REQUIRED');
    const selected = await this.pool.query<PublicationRow>(`select release.id release_id,release.application_id,release.version_id,release.state,release.effective_at,
      version.configuration,version.configuration_hash from experience.release release join experience.version version on version.id=release.version_id
      join experience.application application on application.id=release.application_id
      where release.id=$1 and ($2::text is null or application.scope_id=$2)`, [release, this.scope ?? null]);
    const target = selected.rows[0];
    if (!target) throw new Error('EXPERIENCE_RELEASE_NOT_FOUND');
    if (target.application_id !== payload.application || target.version_id !== payload.version || target.configuration_hash !== expected) {
      throw new Error('EXPERIENCE_EVENT_RELEASE_MISMATCH');
    }
    if (!['scheduled', 'active'].includes(target.state)) return this.completeInbox(event);
    const stored = await this.publisher.publish(path, target.configuration, expected, signal);
    await this.activate(event, target, path, stored);
  }

  private async activate(event: string, target: PublicationRow, path: string, stored: StoredObject): Promise<void> {
    const database = await this.pool.connect();
    let malls: readonly string[] = [];
    let active = false;
    try {
      await database.query('begin');
      await applyJobDatabaseContext(database);
      const inbox = await database.query(`select 1 from runtime.inbox where consumer='job:experiencepublish' and event_id=$1 and processed_at is null for update`, [event]);
      if (!inbox.rows[0]) { await database.query('commit'); return; }
      await database.query("select pg_advisory_xact_lock(hashtextextended('experience:'||$1,0))", [target.application_id]);
      const release = await database.query<{ state: string; superseded: boolean }>(`select state,exists(select 1 from experience.release current
        where current.application_id=release.application_id and current.state='active' and current.effective_at>release.effective_at) superseded
        from experience.release release where release.id=$1 for update`, [target.release_id]);
      if (!release.rows[0]) throw new Error('EXPERIENCE_RELEASE_NOT_FOUND');
      await database.query(`insert into experience.publication(id,release_id,application_id,version_id,content_hash,object_key,object_ref,object_hash,object_size,state,staged_at,published_at)
        values('publication:'||$1,$1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp(),case when $9='active' then clock_timestamp() end)
        on conflict(release_id) do update set object_ref=excluded.object_ref,object_hash=excluded.object_hash,object_size=excluded.object_size,
          state=excluded.state,published_at=excluded.published_at`, [target.release_id, target.application_id, target.version_id, target.configuration_hash,
        path, stored.reference, stored.sha256, stored.size, release.rows[0].superseded ? 'staged' : 'active']);
      if (release.rows[0].superseded) {
        await database.query("update experience.release set state='retired',retired_at=clock_timestamp() where id=$1", [target.release_id]);
      } else {
        const bindings = await database.query<{ mall_id: string }>('select mall_id from experience.binding where application_id=$1 order by mall_id', [target.application_id]);
        malls = bindings.rows.map(({ mall_id }) => mall_id);
        active = true;
        await database.query("update experience.publication set state='retired' where application_id=$1 and state='active' and release_id<>$2", [target.application_id, target.release_id]);
        await database.query("update experience.release set state='retired',retired_at=clock_timestamp() where application_id=$1 and state='active' and id<>$2", [target.application_id, target.release_id]);
        await database.query("update experience.release set state='active',retired_at=null where id=$1 and state in('scheduled','active')", [target.release_id]);
        await database.query(`update experience.application set head_version_id=$2,status='active',version=version+case when head_version_id is distinct from $2 then 1 else 0 end,
          updated_at=clock_timestamp() where id=$1`, [target.application_id, target.version_id]);
      }
      await database.query("update runtime.inbox set processed_at=clock_timestamp(),attempts=attempts+1 where consumer='job:experiencepublish' and event_id=$1", [event]);
      await database.query('commit');
    } catch (cause) { await database.query('rollback'); throw cause; }
    finally { database.release(); }
    if (active && this.cache) await this.publishCache(this.cache, malls, target, path);
  }

  private async publishCache(cache: Cache, malls: readonly string[], target: PublicationRow, path: string): Promise<void> {
    const value: PublishedExperience = Object.freeze({ release: target.release_id, version: target.version_id, hash: target.configuration_hash,
      document: target.configuration, effective_at: target.effective_at, object_key: path });
    await Promise.all(malls.map(async (mall) => {
      const versionKey = VersionedKey.create('experience', { mall, version: target.version_id });
      const activeKey = VersionedKey.create('experience', { mall, version: 'active' });
      if (await cache.put(versionKey, value, CACHE_CATALOG.experience.maximumSeconds)) {
        await cache.put(activeKey, target.version_id, Math.max(1, CACHE_CATALOG.experience.staleSeconds));
      }
    }));
  }

  private async completeInbox(event: string): Promise<void> {
    await this.pool.query("update runtime.inbox set processed_at=coalesce(processed_at,clock_timestamp()),attempts=attempts+case when processed_at is null then 1 else 0 end where consumer='job:experiencepublish' and event_id=$1", [event]);
  }
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}
function text(value: unknown, code: string): string { if (typeof value !== 'string' || value.length === 0) throw new Error(code); return value; }
