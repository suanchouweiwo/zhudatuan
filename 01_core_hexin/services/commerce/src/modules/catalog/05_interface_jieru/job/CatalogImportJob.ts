import type { ClaimedJob, JobProcessor } from '../../../../foundation/application/JobRunner';
import { importCode, importDetail, importId, saveImportReport } from '../../../../foundation/infrastructure/ImportFile';
import type { ObjectStore } from '../../../../foundation/infrastructure/ObjectStore';
import type { DatabasePool } from '../../../../foundation/persistence/Pool';
import { readCatalogPackage } from '../../03_application_yingyong/CatalogPackage';
import { PgCatalogImport } from '../../04_adapters_shixian/persistence/PgCatalogImport';

export class CatalogImportProcessor implements JobProcessor {
  private readonly imports: PgCatalogImport;

  constructor(pool: DatabasePool, objects: ObjectStore) {
    this.imports = new PgCatalogImport(pool);
    this.objects = objects;
  }

  private readonly objects: ObjectStore;

  async process(job: ClaimedJob, signal: AbortSignal): Promise<void> {
    if (job.kind !== 'catalogimport') throw new Error('JOB_KIND_MISMATCH');
    if (!job.scope_id) throw new Error('CATALOGIMPORT_SCOPE_REQUIRED');
    if (signal.aborted) throw signal.reason;
    const id = importId(job.payload, 'CATALOGIMPORT_REQUIRED');
    const target = await this.imports.find(id, job.scope_id);
    if (!target || ['completed', 'failed', 'cancelled'].includes(target.state)) return;
    if (target.scope !== job.scope_id) throw new Error('CATALOGIMPORT_SCOPE_MISMATCH');
    try {
      let state = target.state;
      if (state === 'uploaded' || state === 'validating') {
        await this.imports.beginValidation(target);
        await this.imports.stage(target, await readCatalogPackage(this.objects, target.reference, target.sha256), signal);
        return;
      }
      if (state === 'ready') return;
      if (state === 'running') {
        if (!await this.imports.process(target, signal)) return;
        state = 'reporting';
      }
      if (state !== 'reporting') throw new Error('IMPORT_STATE_INVALID');
      const report = await saveImportReport(this.objects, 'catalog', target.id, await this.imports.failures(target));
      await this.imports.complete(target, report);
    } catch (cause) {
      const code = importCode(cause, 'IMPORT_PROCESSING_FAILED');
      const detail = importDetail(cause);
      if (code.startsWith('CATALOG_PACKAGE_')) {
        await this.imports.reject(target, code, detail);
        return;
      }
      await this.imports.fault(target, detail);
      throw cause;
    }
  }
}
