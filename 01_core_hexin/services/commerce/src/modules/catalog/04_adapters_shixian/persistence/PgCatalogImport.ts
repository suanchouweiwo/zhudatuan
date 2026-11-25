import type { PoolClient } from 'pg';
import type { ImportTarget } from '../../../../foundation/application/BatchImport';
import type { ImportFailure } from '../../../../foundation/infrastructure/ImportFile';
import type { StoredObject } from '../../../../foundation/infrastructure/ObjectStore';
import type { DatabasePool } from '../../../../foundation/persistence/Pool';
import { configureWorker, workerTransaction } from '../../../../foundation/infrastructure/WorkerDatabase';
import type { CatalogPackageDocument } from '../../03_application_yingyong/CatalogPackage';
import { catalogImportFailure, importProduct, validateCatalogProduct } from '../../03_application_yingyong/CatalogProductImport';

interface TargetRow { readonly id: string; readonly scope_id: string; readonly object_ref: string; readonly sha256: string; readonly state: ImportTarget['state'] }
interface StagedRow { readonly row_number: number; readonly payload: Readonly<Record<string, string>>; readonly invalid: boolean }

export class PgCatalogImport {
  constructor(private readonly pool: DatabasePool) {}

  async find(id: string, scope: string): Promise<ImportTarget | null> {
    const result = await this.pool.query<TargetRow>(
      'select id,scope_id,object_ref,sha256,state from catalog.importjob where id=$1 and scope_id=$2', [id, scope]);
    const row = result.rows[0];
    return row ? { id: row.id, scope: row.scope_id, reference: row.object_ref, sha256: row.sha256, state: row.state } : null;
  }

  async beginValidation(target: ImportTarget): Promise<void> {
    await workerTransaction(this.pool, target.scope, async (client) => {
      await client.query(`update catalog.importjob set state='validating',last_error=null,total_count=0,cursor_value=0,
        validation_summary=jsonb_build_object('validationStartedAt',
          coalesce(validation_summary->'validationStartedAt',to_jsonb(clock_timestamp()))),updated_at=clock_timestamp()
        where id=$1 and scope_id=$2 and state in ('uploaded','validating')`, [target.id, target.scope]);
    });
  }

  async stage(target: ImportTarget, document: CatalogPackageDocument, signal: AbortSignal): Promise<void> {
    const rows = document.rows;
    await workerTransaction(this.pool, target.scope, async (client) => {
      await client.query('delete from catalog.importrow where job_id=$1 and scope_id=$2', [target.id, target.scope]);
      await client.query('delete from catalog.importerror where job_id=$1 and scope_id=$2', [target.id, target.scope]);
      await client.query('update catalog.importjob set total_count=$3,updated_at=clock_timestamp() where id=$1 and scope_id=$2',
        [target.id, target.scope, rows.length]);
    });
    for (let offset = 0; offset < rows.length; offset += 500) {
      signal.throwIfAborted();
      const batch = rows.slice(offset, offset + 500).map((payload, index) => ({
        row_number: offset + index + 2,
        payload: { ...payload, packageSha: target.sha256 },
      }));
      await workerTransaction(this.pool, target.scope, async (client) => {
        await client.query(`insert into catalog.importrow(job_id,scope_id,row_number,payload)
          select $1,$2,item.row_number,item.payload from jsonb_to_recordset($3::jsonb) item(row_number integer,payload jsonb)`,
        [target.id, target.scope, JSON.stringify(batch)]);
      });
    }
    let errorCount = 0;
    const seenSkuCodes = new Set<string>();
    const validationBatchSize = 50;
    for (let offset = 0; offset < rows.length; offset += validationBatchSize) {
      const batch = rows.slice(offset, offset + validationBatchSize);
      await workerTransaction(this.pool, target.scope, async (client) => {
        for (let index = 0; index < batch.length; index += 1) {
          signal.throwIfAborted();
          const rowNumber = offset + index + 2;
          try {
            await validateCatalogProduct(client, target.scope, { ...batch[index]!, packageSha: target.sha256 }, seenSkuCodes);
          } catch (cause) {
            errorCount += 1;
            const failure = catalogImportFailure(cause);
            await client.query(`insert into catalog.importerror(job_id,scope_id,row_number,reason_code,field,detail)
              values($1,$2,$3,$4,$5,$6) on conflict(job_id,row_number,reason_code)
              do update set field=excluded.field,detail=excluded.detail`,
            [target.id, target.scope, rowNumber, failure.reason, failure.field, failure.detail]);
          }
        }
        const checked = offset + batch.length;
        await client.query(`update catalog.importjob set cursor_value=$3,
          validation_summary=validation_summary||jsonb_build_object('validCount',$3::integer-$4::integer,'errorCount',$4::integer),
          updated_at=clock_timestamp() where id=$1 and scope_id=$2`, [target.id, target.scope, checked, errorCount]);
      });
    }
    await workerTransaction(this.pool, target.scope, async (client) => {
      await client.query(`update catalog.importjob set state='ready',total_count=$2,cursor_value=0,success_count=0,failure_count=0,
        validation_summary=validation_summary||$3::jsonb||jsonb_build_object('shardSize',500,'validationFinishedAt',clock_timestamp()),
        updated_at=clock_timestamp() where id=$1 and scope_id=$4`,
      [target.id, rows.length, JSON.stringify({ ...document.summary, validCount: rows.length - errorCount, errorCount }), target.scope]);
    });
  }

  async process(target: ImportTarget, signal: AbortSignal): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await configureWorker(client, target.scope);
      const job = await client.query<{ cursor_value: number; total_count: number }>(`select cursor_value,total_count from catalog.importjob
        where id=$1 and scope_id=$2 and state='running' for update`, [target.id, target.scope]);
      if (!job.rows[0]) { await client.query('commit'); return true; }
      const staged = await client.query<StagedRow>(`select stagedrow.row_number,stagedrow.payload,
        exists(select 1 from catalog.importerror error where error.job_id=stagedrow.job_id and error.scope_id=stagedrow.scope_id
          and error.row_number=stagedrow.row_number) invalid
        from catalog.importrow stagedrow where stagedrow.job_id=$1 and stagedrow.scope_id=$2 and stagedrow.row_number>$3
        order by stagedrow.row_number limit 500`, [target.id, target.scope, job.rows[0].cursor_value + 1]);
      if (staged.rows.length === 0 && job.rows[0].cursor_value < job.rows[0].total_count) throw new Error('CATALOG_IMPORT_STAGE_INCOMPLETE');
      let successes = 0; let failures = 0;
      for (const row of staged.rows) {
        if (signal.aborted) throw signal.reason;
        if (row.invalid) { failures += 1; continue; }
        await client.query('savepoint importrow');
        try { await importProduct(client, target.scope, target.id, row.row_number, row.payload); successes += 1; }
        catch (cause) {
          await client.query('rollback to savepoint importrow'); failures += 1;
          const failure = catalogImportFailure(cause);
          await client.query(`insert into catalog.importerror(job_id,scope_id,row_number,reason_code,field,detail) values($1,$2,$3,$4,$5,$6)
            on conflict(job_id,row_number,reason_code) do update set field=excluded.field,detail=excluded.detail`,
          [target.id, target.scope, row.row_number, failure.reason, failure.field, failure.detail]);
        }
        await client.query('release savepoint importrow');
      }
      const cursor = staged.rows.at(-1)?.row_number ? staged.rows.at(-1)!.row_number - 1 : job.rows[0].cursor_value;
      const more = cursor < job.rows[0].total_count;
      await client.query(`update catalog.importjob set state=$2,cursor_value=$3,success_count=success_count+$4,failure_count=failure_count+$5,
        validation_summary=validation_summary||jsonb_build_object('processed',$3::integer,'errors',failure_count+$5),last_error=null,updated_at=clock_timestamp()
        where id=$1 and scope_id=$6`,
      [target.id, more ? 'running' : 'reporting', cursor, successes, failures, target.scope]);
      if (more) await continuation(client, target, cursor);
      await client.query('commit');
      return !more;
    } catch (cause) { await client.query('rollback'); throw cause; } finally { client.release(); }
  }

  async failures(target: ImportTarget): Promise<readonly ImportFailure[]> {
    const result = await this.pool.query<{ row_number: number; reason_code: string; field: string | null; detail: string }>(
      'select row_number,reason_code,field,detail from catalog.importerror where job_id=$1 and scope_id=$2 order by row_number,reason_code',
    [target.id, target.scope]);
    return result.rows.map((row) => ({ row: row.row_number, reason: row.reason_code, field: row.field, detail: row.detail }));
  }

  async complete(target: ImportTarget, report: StoredObject): Promise<void> {
    await this.pool.query(`update catalog.importjob set state='completed',report_object_ref=$2,report_sha256=$3,report_size=$4,
      last_error=null,updated_at=clock_timestamp() where id=$1 and scope_id=$5 and state='reporting'`,
    [target.id, report.reference, report.sha256, report.size, target.scope]);
  }
  async reject(target: ImportTarget, code: string, detail: string): Promise<void> {
    await this.pool.query(`update catalog.importjob set state='failed',last_error=$2,
      validation_summary=validation_summary||jsonb_build_object('code',$3),updated_at=clock_timestamp() where id=$1 and scope_id=$4`,
    [target.id, detail, code, target.scope]);
  }
  async fault(target: ImportTarget, detail: string): Promise<void> {
    await this.pool.query('update catalog.importjob set last_error=$2,updated_at=clock_timestamp() where id=$1 and scope_id=$3',
      [target.id, detail, target.scope]);
  }
}

async function continuation(client: PoolClient, target: ImportTarget, cursor: number): Promise<void> {
  await client.query(`insert into runtime.job(id,kind,owner,scope_id,payload,state,priority,available_at,created_at,updated_at)
    values($1,'catalogimport','catalog',$2,jsonb_build_object('import',$3::text),'queued',100,clock_timestamp(),clock_timestamp(),clock_timestamp()) on conflict(id) do nothing`,
  [`job:${target.id}:${cursor}`, target.scope, target.id]);
}
