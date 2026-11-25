import { createHash, randomUUID } from 'node:crypto';
import type { ModuleContext } from '../../../bootstrap/ModuleRegistry';
import { projectImport } from '../../../foundation/application/ImportOperations';
import { operationLifecycle, requireAccess, rowResult, type OperationActions, type OperationDatabase } from '../../../foundation/application/ModuleOperations';
import type { OperationRequest, OperationResult } from '../../../foundation/application/OperationHandler';
import { bodyRecord } from '../../../foundation/interface/Validation';
import { OBJECT_STORE, type ObjectStore } from '../../../foundation/infrastructure/ObjectStore';
import { isCatalogPublicationReference, readListingPublicationStatus } from './CatalogListingPublication';

interface CatalogImportUploadPreparation {
  readonly kind: 'upload';
  readonly access: NonNullable<OperationRequest['access']>;
  readonly reference: string;
  readonly sha256: string;
}

interface CatalogImportConfirmationPreparation {
  readonly kind: 'confirm';
  readonly access: NonNullable<OperationRequest['access']>;
  readonly importId: string;
}

type CatalogImportPreparation = CatalogImportUploadPreparation | CatalogImportConfirmationPreparation;

interface ImportJobRow extends Record<string, unknown> {
  readonly id: string;
  readonly state: string;
}

export function catalogImportOperations(context: ModuleContext): OperationActions {
  const objects = context.container.get(OBJECT_STORE);
  return {
    'catalog.imports.create': operationLifecycle({
      prepare: (request) => prepareCatalogImport(request, objects),
      execute: async (_request, database, prepared) => {
        return prepared.kind === 'confirm'
          ? confirmCatalogImport(database, prepared)
          : createOrReuseCatalogImport(database, prepared);
      },
    }),
    'catalog.imports.read': operationLifecycle({
      execute: async (request, database) => {
        const access = requireAccess(request);
        if (isCatalogPublicationReference(request.input.path.importid)) {
          return readListingPublicationStatus(request, database);
        }
        return rowResult(await database.query(`select job.id,job.state,job.total_count,job.cursor_value,job.success_count,job.failure_count,
          job.validation_summary,job.last_error,job.report_object_ref,job.report_sha256,job.report_size,job.created_at,job.updated_at,
          coalesce((select jsonb_agg(row_to_json(errorrow) order by errorrow.row_number,errorrow.reason_code) from
            (select row_number,reason_code,field,detail from catalog.importerror where job_id=job.id order by row_number,reason_code limit 100) errorrow),'[]'::jsonb) errors
          ,coalesce((select jsonb_agg(jsonb_build_object('rowNumber',previewrow.row_number,'title',previewrow.payload->>'title',
            'sku',previewrow.payload->>'sku','category',previewrow.payload->>'category','priceMinor',previewrow.payload->>'priceMinor',
            'stock',previewrow.payload->>'stock','status',previewrow.payload->>'status') order by previewrow.row_number) from
            (select row_number,payload from catalog.importrow where job_id=job.id order by row_number limit 20) previewrow),'[]'::jsonb) preview
          from catalog.importjob job where job.id=$1 and job.scope_id=$2`, [request.input.path.importid!, access.scope.id]));
      },
      finalize: async (request, result) => isCatalogPublicationReference(request.input.path.importid)
        ? result : projectImport(result, objects),
    }),
  };
}

export async function createOrReuseCatalogImport(
  database: OperationDatabase,
  prepared: CatalogImportUploadPreparation,
): Promise<OperationResult> {
  await database.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`${prepared.access.scope.id}:${prepared.sha256}`]);
  const existing = await database.query<ImportJobRow>(`select id,state,total_count,cursor_value,success_count,failure_count,created_at,updated_at
    from catalog.importjob where scope_id=$1 and sha256=$2 order by created_at desc limit 1`,
  [prepared.access.scope.id, prepared.sha256]);
  if (existing.rows[0]) {
    return { status: ['completed', 'failed', 'cancelled'].includes(existing.rows[0].state) ? 200 : 202,
      body: { ...existing.rows[0], duplicate: true } };
  }
  const id = `catalogimport:${randomUUID()}`;
  const result = await database.query<ImportJobRow>(`insert into catalog.importjob(id,scope_id,object_ref,sha256,state,created_at,updated_at)
    values($1,$2,$3,$4,'uploaded',clock_timestamp(),clock_timestamp()) returning id,state,total_count,cursor_value,success_count,failure_count,created_at,updated_at`,
  [id, prepared.access.scope.id, prepared.reference, prepared.sha256]);
  await database.query(`insert into runtime.job(id,kind,owner,scope_id,payload,state,priority,available_at,created_at,updated_at)
    values($1,'catalogimport','catalog',$2,jsonb_build_object('import',$3::text),'queued',100,clock_timestamp(),clock_timestamp(),clock_timestamp())`,
  [`job:${id}:0`, prepared.access.scope.id, id]);
  const row = result.rows[0];
  if (!row) throw new Error('CATALOG_IMPORT_CREATE_FAILED');
  return { status: 202, body: { ...row, duplicate: false } };
}

export async function confirmCatalogImport(
  database: OperationDatabase,
  prepared: CatalogImportConfirmationPreparation,
): Promise<OperationResult> {
  await database.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`confirm:${prepared.importId}`]);
  const selected = await database.query<ImportJobRow>(`select id,state,total_count,cursor_value,success_count,failure_count,created_at,updated_at
    from catalog.importjob where id=$1 and scope_id=$2 for update`, [prepared.importId, prepared.access.scope.id]);
  const row = selected.rows[0];
  if (!row) return { status: 404, body: { code: 'RESOURCE_NOT_FOUND' } };
  if (['running', 'reporting', 'completed'].includes(row.state)) {
    return { status: row.state === 'completed' ? 200 : 202, body: { ...row, confirmed: true, duplicate: true } };
  }
  if (row.state !== 'ready') {
    return { status: 409, body: { code: row.state === 'uploaded' || row.state === 'validating'
      ? 'CATALOG_IMPORT_VALIDATION_PENDING' : 'CATALOG_IMPORT_NOT_CONFIRMABLE' } };
  }
  const updated = await database.query<ImportJobRow>(`update catalog.importjob set state='running',last_error=null,
    validation_summary=validation_summary||jsonb_build_object('saveRequestedAt',clock_timestamp()),updated_at=clock_timestamp()
    where id=$1 and scope_id=$2 and state='ready'
    returning id,state,total_count,cursor_value,success_count,failure_count,created_at,updated_at`,
  [prepared.importId, prepared.access.scope.id]);
  const confirmed = updated.rows[0];
  if (!confirmed) return { status: 409, body: { code: 'CATALOG_IMPORT_CONFIRMATION_CONFLICT' } };
  await database.query(`insert into runtime.job(id,kind,owner,scope_id,payload,state,priority,available_at,created_at,updated_at)
    values($1,'catalogimport','catalog',$2,jsonb_build_object('import',$3::text),'queued',100,clock_timestamp(),clock_timestamp(),clock_timestamp())
    on conflict(id) do nothing`, [`job:${prepared.importId}:confirm`, prepared.access.scope.id, prepared.importId]);
  return { status: 202, body: { ...confirmed, confirmed: true, duplicate: false } };
}

async function prepareCatalogImport(request: OperationRequest, objects: ObjectStore): Promise<CatalogImportPreparation> {
  const access = requireAccess(request);
  if (access.scope.kind !== 'mall') throw new Error('CATALOG_IMPORT_MALL_SCOPE_REQUIRED');
  const body = bodyRecord(request);
  if (typeof body.confirmImportId === 'string' && body.confirmImportId.trim()) {
    return { kind: 'confirm', access, importId: body.confirmImportId.trim() };
  }
  const sha256 = typeof body.sha256 === 'string' ? body.sha256.trim() : '';
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('VALIDATION_FAILED:sha256');
  if (typeof body.content !== 'string' || body.content.length === 0) throw new Error('CATALOG_PACKAGE_CONTENT_REQUIRED');
  const bytes = new TextEncoder().encode(body.content);
  if (bytes.byteLength > 32 * 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== sha256) {
    throw new Error('CATALOG_PACKAGE_HASH_MISMATCH');
  }
  const reference = await storeCatalogPackage(objects, access.scope.id, sha256, bytes);
  return { kind: 'upload', access, reference, sha256 };
}

async function storeCatalogPackage(objects: ObjectStore, scope: string, sha256: string, bytes: Uint8Array): Promise<string> {
  const scopeDigest = createHash('sha256').update(scope).digest('hex').slice(0, 32);
  const path = `catalog/packages/${scopeDigest}/${sha256}.json`;
  const existing = await objects.find(path);
  if (existing) {
    if (existing.contentType !== 'application/json' || existing.sha256 !== sha256 || existing.size !== bytes.byteLength || existing.scan !== 'clean') {
      throw new Error('CATALOG_PACKAGE_OBJECT_COLLISION');
    }
    return existing.reference;
  }
  const upload = await objects.create(path, 'application/json');
  try {
    for (let offset = 0; offset < bytes.byteLength; offset += 4 * 1024 * 1024) {
      await upload.append(bytes.slice(offset, Math.min(bytes.byteLength, offset + 4 * 1024 * 1024)));
    }
    const stored = await upload.complete();
    if (stored.sha256 !== sha256 || stored.size !== bytes.byteLength || stored.scan !== 'clean') {
      throw new Error('CATALOG_PACKAGE_OBJECT_INVALID');
    }
    return stored.reference;
  } catch (cause) {
    await upload.abort().catch(() => undefined);
    throw cause;
  }
}
