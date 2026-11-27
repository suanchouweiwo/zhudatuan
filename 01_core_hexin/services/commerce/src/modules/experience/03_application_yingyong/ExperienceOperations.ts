import { createHash, randomUUID } from 'node:crypto';
import { CACHE_CATALOG } from '@shop/config/runtime';
import { parseExperience, serializeExperience, type ExperienceDocument } from '@shop/contract';
import type { ModuleContext } from '../../../bootstrap/ModuleRegistry';
import { AUDIT_SINK } from '../../../foundation/application/AuditSink';
import { ModuleOperations, operationLifecycle, requireAccess, rowResult, type OperationDatabase } from '../../../foundation/application/ModuleOperations';
import { bodyRecord, keysetResult, queryPage, textField } from '../../../foundation/interface/Validation';
import { CACHE } from '../../../foundation/cache/Cache';
import { VersionedKey } from '../../../foundation/cache/VersionedKey';
import { DATABASE_POOL } from '../../../foundation/persistence/Pool';
import { PublishPolicy } from '../02_domain_yewu/policy/PublishPolicy';
import { experienceObjectKey } from '../04_adapters_shixian/adapter/CdnPublisher';

export function experienceOperations(context: ModuleContext): ModuleOperations {
  const pool = context.container.get(DATABASE_POOL);
  const cache = context.container.get(CACHE);
  const policy = new PublishPolicy();
  return new ModuleOperations('experience', pool, context.container.get(AUDIT_SINK), {
    'experience.published.read': operationLifecycle({
      prepare: async (request) => {
        const raw = request.input.query.mall;
        const mall = Array.isArray(raw) ? raw[0] : raw;
        if (typeof mall !== 'string' || !/^[a-zA-Z0-9:.-]{3,255}$/.test(mall)) throw new Error('EXPERIENCE_MALL_INVALID');
        const activeKey = VersionedKey.create('experience', { mall, version: 'active' });
        const active = await cache.get<string>(activeKey);
        const cached = active ? published(await cache.get<unknown>(VersionedKey.create('experience', { mall, version: active }))) : null;
        return { mall, activeKey, cached };
      },
      shortCircuit: (_request, { cached }) => cached ? publishedResponse(cached) : undefined,
      execute: async (_request, database, { mall }) => {
        const result = await database.query<PublishedExperience>('select * from experience.read_published($1)', [mall]);
        const value = published(result.rows[0]);
        if (!value) throw new Error('EXPERIENCE_PUBLICATION_NOT_FOUND');
        return publishedResponse(value);
      },
      finalize: async (_request, result, { mall, activeKey }) => {
        const value = published(result.body);
        if (!value) throw new Error('EXPERIENCE_PUBLICATION_INVALID');
        const versionKey = VersionedKey.create('experience', { mall, version: value.version });
        if (await cache.put(versionKey, value, CACHE_CATALOG.experience.maximumSeconds)) {
          await cache.put(activeKey, value.version, Math.max(1, CACHE_CATALOG.experience.staleSeconds));
        }
        return result;
      },
    }),
    'experience.applications.create': async (request, database) => {
      const access = requireAccess(request);
      const body = bodyRecord(request);
      const identity = applicationIdentity(body);
      const result = await database.query(`insert into experience.application(id,scope_id,code,public_slug,name,status,created_at,updated_at,version)
        values($1,$2,$3,$4,$5,'draft',clock_timestamp(),clock_timestamp(),0) returning *`,
      [`application:${randomUUID()}`, access.scope.id, identity.code, identity.publicSlug, textField(body, 'name')]);
      return rowResult(result, 201);
    },
    'experience.applications.copy': async (request, database) => {
      const access = requireAccess(request);
      const body = bodyRecord(request);
      const identity = applicationIdentity(body);
      const id = `application:${randomUUID()}`;
      const result = await database.query(`insert into experience.application(id,scope_id,code,public_slug,name,status,created_at,updated_at,version)
        select $1,$2,$3,$4,$5,'draft',clock_timestamp(),clock_timestamp(),0 from experience.application source
        where source.id=$6 and source.head_version_id is not null returning *`,
      [id, access.scope.id, identity.code, identity.publicSlug, textField(body, 'name'), request.input.path.applicationid!]);
      if (!result.rows[0]) throw new Error('EXPERIENCE_SOURCE_APPLICATION_INVALID');
      const version = `version:${randomUUID()}`;
      const copied = await database.query(`insert into experience.version(id,application_id,sequence,schema_version,configuration,configuration_hash,validation_state,reason,created_by,created_at)
        select $1,$2,1,version.schema_version,version.configuration,version.configuration_hash,version.validation_state,$3,$4,clock_timestamp()
        from experience.application source join experience.version version on version.id=source.head_version_id where source.id=$5`,
      [version, id, textField(body, 'reason', 500), access.actor.id, request.input.path.applicationid!]);
      if (copied.rowCount !== 1) throw new Error('EXPERIENCE_SOURCE_VERSION_INVALID');
      await database.query('update experience.application set head_version_id=$2 where id=$1', [id, version]);
      return { status: 201, body: { ...result.rows[0], versionId: version } };
    },
    'experience.applications.read': async (request, database) => {
      const access = requireAccess(request);
      const page = queryPage(request);
      const application = queryText(request.input.query.application);
      const result = await database.query(`select application.id,application.scope_id,application.code,application.public_slug,application.name,application.status,application.version,
        application.created_at,application.updated_at,head.id head_id,head.sequence head_sequence,head.schema_version head_schema_version,
        head.validation_state head_validation_state,head.reason head_reason,head.created_at head_created_at,
        published.id published_id,published.sequence published_sequence,published.schema_version published_schema_version,
        published.validation_state published_validation_state,published.reason published_reason,published.created_at published_created_at,
        binding.domain,binding.mall_id,binding.pool_id
        from experience.application application left join experience.version head on head.id=application.head_version_id
        left join lateral(select version.* from experience.release release join experience.version version on version.id=release.version_id
          where release.application_id=application.id and release.state in('active','scheduled') order by case release.state when 'active' then 0 else 1 end,
          release.effective_at desc,release.id desc limit 1) published on true
        left join lateral(select domain,mall_id,pool_id from experience.binding where application_id=application.id order by domain limit 1) binding on true
        where exists(select 1 from organization.unitclosure closure where closure.ancestor_id=$1 and closure.descendant_id=application.scope_id)
        and ($2='' or application.id=$2)
        and ($3::timestamptz is null or (application.updated_at,application.id)<($3::timestamptz,$4))
        order by application.updated_at desc,application.id desc limit $5`, [access.scope.id, application, page.sort, page.id, page.fetch]);
      return keysetResult(result, page, 'updated_at');
    },
    'experience.applications.update': async (request, database) => {
      const body = bodyRecord(request);
      const result = await database.query(`update experience.application set name=coalesce($2,name),status=coalesce($3,status),version=version+1,updated_at=clock_timestamp()
        where id=$1 and ($4::bigint is null or version=$4) returning *`, [request.input.path.applicationid!, body.name ?? null, body.status ?? null, request.input.expectedVersion ?? null]);
      if (!result.rows[0]) throw new Error('VERSION_CONFLICT');
      return rowResult(result);
    },
    'experience.versions.save': async (request, database) => {
      const access = requireAccess(request);
      const body = bodyRecord(request);
      if (request.input.expectedVersion === undefined) throw new Error('EXPECTED_VERSION_REQUIRED');
      const configuration = body.configuration;
      if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) throw new Error('VALIDATION_FAILED:configuration');
      if (String(body.schemaVersion) !== '2') throw new Error('EXPERIENCE_VERSION_INVALID');
      const document = parseExperience(configuration);
      if (document.application !== request.input.path.applicationid) throw new Error('EXPERIENCE_APPLICATION_INVALID');
      const application = await database.query<{ id: string }>(`select id from experience.application where id=$1 and version=$2 for update`,
      [request.input.path.applicationid!, request.input.expectedVersion]);
      if (!application.rows[0]) throw new Error('VERSION_CONFLICT');
      const canonical = serializeExperience(document);
      const version = `version:${randomUUID()}`;
      const result = await database.query(`insert into experience.version(id,application_id,sequence,schema_version,configuration,configuration_hash,validation_state,reason,created_by,created_at)
        select $1,$2,coalesce(max(sequence),0)+1,$3,$4::jsonb,$5,'pending',$6,$7,clock_timestamp() from experience.version where application_id=$2
        returning *`, [version, request.input.path.applicationid!, '2', canonical,
        createHash('sha256').update(canonical).digest('hex'), textField(body, 'reason', 500), access.actor.id]);
      await database.query(`update experience.application set head_version_id=$2,version=version+1,updated_at=clock_timestamp() where id=$1`,
      [request.input.path.applicationid!, version]);
      return rowResult(result, 201);
    },
    'experience.versions.validate': async (request, database) => {
      const loaded = await database.query<{ configuration: unknown; application_id: string }>('select configuration,application_id from experience.version where id=$1 for update', [request.input.path.versionid!]);
      const version = loaded.rows[0];
      if (!version) throw new Error('RESOURCE_NOT_FOUND');
      const valid = validConfiguration(version.configuration, version.application_id);
      const result = await database.query(`update experience.version set validation_state=$2 where id=$1 returning id,application_id,validation_state`, [request.input.path.versionid!, valid ? 'valid' : 'invalid']);
      return rowResult(result);
    },
    'experience.versions.publish': async (request, database) => {
      const access = requireAccess(request);
      if (request.input.expectedVersion === undefined) throw new Error('EXPECTED_VERSION_REQUIRED');
      const loaded = await database.query<{ application_id: string; validation_state: string; configuration: unknown; configuration_hash: string }>(`select version.application_id,version.validation_state,version.configuration,version.configuration_hash
        from experience.version version join experience.application application on application.id=version.application_id
        where version.id=$1 and application.version=$2 for update of version,application`,
      [request.input.path.versionid!, request.input.expectedVersion]);
      const version = loaded.rows[0];
      if (!version) throw new Error('VERSION_CONFLICT');
      const document = parseExperience(version.configuration);
      const binding = await database.query<{ pool_id: string }>('select pool_id from experience.binding where application_id=$1 limit 1', [version.application_id]);
      const references = binding.rows[0] ? await referencesValid(database, document, binding.rows[0].pool_id) : false;
      policy.assertPublishable({ schema: document.application === version.application_id, assets: safeAssets(version.configuration), actions: safeActions(version.configuration) && references,
        capabilities: true, bindings: Boolean(binding.rows[0]), preview: version.validation_state === 'valid' });
      const release = `release:${randomUUID()}`;
      const result = await database.query(`insert into experience.release(id,application_id,version_id,state,effective_at,published_by)
        values($1,$2,$3,'scheduled',clock_timestamp(),$4) returning *`, [release, version.application_id, request.input.path.versionid!, access.actor.id]);
      await database.query(`insert into runtime.outbox(id,event_type,event_version,aggregate_type,aggregate_id,scope_id,payload,trace_id,occurred_at,available_at)
        select $1,'experience.published',1,'experience',$2,application.scope_id,jsonb_build_object('release',$3,'application',$2,'version',$4,'hash',version.configuration_hash,
          'key',$6::text),$5,clock_timestamp(),clock_timestamp()
        from experience.application application join experience.version version on version.id=$4 where application.id=$2`,
      [`event:${randomUUID()}`, version.application_id, release, request.input.path.versionid!, access.trace,
        experienceObjectKey(version.application_id, version.configuration_hash)]);
      return rowResult(result, 202);
    },
    'experience.versions.restore': async (request, database) => {
      const access = requireAccess(request);
      if (request.input.expectedVersion === undefined) throw new Error('EXPECTED_VERSION_REQUIRED');
      const source = await database.query<{ application_id: string }>('select application_id from experience.version where id=$1', [request.input.path.versionid!]);
      const applicationId = source.rows[0]?.application_id;
      if (!applicationId) throw new Error('RESOURCE_NOT_FOUND');
      const application = await database.query<{ id: string }>('select id from experience.application where id=$1 and version=$2 for update',
      [applicationId, request.input.expectedVersion]);
      if (!application.rows[0]) throw new Error('VERSION_CONFLICT');
      const version = `version:${randomUUID()}`;
      const body = bodyRecord(request);
      const result = await database.query(`insert into experience.version(id,application_id,sequence,schema_version,configuration,configuration_hash,validation_state,reason,created_by,created_at)
        select $1,source.application_id,(select coalesce(max(sequence),0)+1 from experience.version where application_id=source.application_id),source.schema_version,
          source.configuration,source.configuration_hash,'valid',$2,$3,clock_timestamp() from experience.version source where source.id=$4 returning *`,
      [version, textField(body, 'reason', 500), access.actor.id, request.input.path.versionid!]);
      await database.query(`update experience.application set head_version_id=$2,version=version+1,updated_at=clock_timestamp() where id=$1`, [applicationId, version]);
      return rowResult(result, 201);
    },
  });
}

function queryText(value: string | readonly string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim().slice(0, 255) ?? '';
}

function applicationIdentity(body: Readonly<Record<string, unknown>>): Readonly<{ code: string; publicSlug: string }> {
  const code = textField(body, 'code', 32);
  const publicSlug = textField(body, 'publicSlug', 48);
  if (!/^[A-Z][A-Z0-9_]{2,31}$/.test(code)) throw new Error('VALIDATION_FAILED:code');
  if (!/^[a-z0-9][a-z0-9-]{2,47}$/.test(publicSlug) && !/^h[0-9]+$/.test(publicSlug)) throw new Error('VALIDATION_FAILED:publicSlug');
  return Object.freeze({ code, publicSlug });
}

export interface PublishedExperience {
  readonly release: string;
  readonly version: string;
  readonly hash: string;
  readonly document: unknown;
  readonly effective_at: string;
  readonly object_key: string;
}

function published(value: unknown): PublishedExperience | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.release !== 'string' || typeof candidate.version !== 'string' || typeof candidate.hash !== 'string'
    || typeof candidate.effective_at !== 'string' || typeof candidate.object_key !== 'string') return null;
  parseExperience(candidate.document);
  return candidate as unknown as PublishedExperience;
}

function publishedResponse(value: PublishedExperience) {
  const seconds = Math.max(1, CACHE_CATALOG.experience.staleSeconds);
  return { status: 200, body: value, headers: { etag: `"${value.hash}"`, 'cache-control': `public,max-age=${seconds},stale-while-revalidate=${seconds}` } };
}

function validConfiguration(value: unknown, application: string): boolean {
  try { return parseExperience(value).application === application; }
  catch { return false; }
}

function safeAssets(value: unknown): boolean {
  return !/(?:data:|javascript:|file:|blob:)/i.test(JSON.stringify(value));
}

function safeActions(value: unknown): boolean {
  try {
    const document = parseExperience(value);
    return document.pages.every((page) => page.blocks.every((block) => block.action === undefined || safeTarget(block.action.type, block.action.target)));
  } catch { return false; }
}

function safeTarget(type: string, target: string): boolean {
  if (type === 'link') return /^\/(?:page|pages)\/[a-z0-9/-]+(?:\?[a-z0-9&=_-]+)?$/i.test(target);
  return /^[a-zA-Z0-9:._-]{1,255}$/.test(target);
}

async function referencesValid(database: OperationDatabase, document: ExperienceDocument, pool: string): Promise<boolean> {
  const references = new Map<string, Set<string>>();
  for (const page of document.pages) for (const block of page.blocks) if (block.action) {
    const targets = references.get(block.action.type) ?? new Set<string>();
    targets.add(block.action.target); references.set(block.action.type, targets);
  }
  const pages = new Set(document.pages.flatMap((page) => [page.id, page.path]));
  if ([...(references.get('micropage') ?? [])].some((target) => !pages.has(target))) return false;
  const checks: readonly [readonly string[], string, readonly unknown[]][] = [
    [[...(references.get('product') ?? []), ...(references.get('exchangeableproduct') ?? [])], `select product.id from catalog.product product join catalog.sku sku on sku.product_id=product.id
      join catalog.listing listing on listing.sku_id=sku.id and listing.pool_id=$2 where product.id=any($1::text[]) and product.status='active' and listing.status='published'`, [pool]],
    [[...(references.get('category') ?? [])], "select id from catalog.category where id=any($1::text[]) and status='active'", []],
    [[...(references.get('collection') ?? [])], "select id from catalog.pool where id=any($1::text[]) and status='active'", []],
    [[...(references.get('marketingactivity') ?? [])], "select id from marketing.campaign where id=any($1::text[]) and state='active' and effective_at<=clock_timestamp() and (expires_at is null or expires_at>clock_timestamp())", []],
  ];
  for (const [targets, query, suffix] of checks) {
    if (targets.length === 0) continue;
    const rows = await database.query(query, [targets, ...suffix]);
    if (rows.rowCount !== new Set(targets).size) return false;
  }
  return true;
}
