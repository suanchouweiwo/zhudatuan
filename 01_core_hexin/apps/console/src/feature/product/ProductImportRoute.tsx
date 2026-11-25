import { Button, ResourcePanel } from '@shop/design';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import type { z } from 'zod';
import { useConsoleContext } from '../../entity/session/ConsoleContext';
import { queryCondition, safeQueryError } from '../../shared/api/QueryState';
import { DataTable, type DataColumn } from '../../shared/ui/DataTable';
import { formatCount, formatDate } from '../../shared/ui/Format';
import { MetricCards } from '../../shared/ui/MetricCards';
import { scopePath } from '../../shared/url/ScopePath';
import { importKey, readImport } from '../importing/ImportQuery';
import type { ImportError, ImportJob } from '../importing/ImportSchema';
import { canCreateCatalogImport, confirmCatalogImport } from './ProductImportCommand';
import { CatalogImportPreviewRowsSchema, CatalogImportValidationSummarySchema } from './ProductSchema';

const errorColumns: readonly DataColumn<ImportError>[] = [
  { key: 'row', label: '包内行', render: (row) => row.row_number },
  { key: 'field', label: '字段', render: (row) => row.field ?? '—' },
  { key: 'reason', label: '错误代码', render: (row) => row.reason_code },
  { key: 'detail', label: '处理建议', render: (row) => row.detail ?? '—' },
];

export function Component() {
  const jobId = useParams().jobId ?? '';
  if (!jobId) throw new Response('IMPORT_ROUTE_INVALID', { status: 404 });
  return <CatalogImportJob jobId={jobId} />;
}

function CatalogImportJob({ jobId }: Readonly<{ jobId: string }>) {
  const context = useConsoleContext();
  const navigate = useNavigate();
  const productsPath = scopePath(context.scope, 'products');
  const queryClient = useQueryClient();
  const key = importKey(context, 'catalog', jobId);
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => readImport(context, 'catalog', jobId, signal),
    refetchInterval: (current) => ['ready', 'completed', 'failed', 'cancelled'].includes(current.state.data?.state ?? '') ? false : 2_000,
  });
  const confirmation = useMutation({
    mutationFn: () => confirmCatalogImport(context, jobId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  });
  const data = query.data;
  const queryError = safeQueryError(query.error);
  const condition = queryCondition({ pending: query.isPending, fetching: query.isFetching, error: query.error,
    hasData: data !== undefined, empty: false, stale: query.isStale });
  const parsedSummary = CatalogImportValidationSummarySchema.safeParse(data?.validation_summary);
  const summary = parsedSummary.success ? parsedSummary.data : undefined;
  const parsedPreview = CatalogImportPreviewRowsSchema.safeParse(data?.preview);
  const preview = parsedPreview.success ? parsedPreview.data : [];
  const validationPending = data?.state === 'uploaded' || data?.state === 'validating';
  const validCount = summary?.validCount ?? (validationPending ? 0
    : Math.max(0, (data?.total_count ?? 0) - (data?.errors.length ?? 0)));

  useEffect(() => {
    if (data?.state !== 'completed') return;
    void queryClient.invalidateQueries({ queryKey: [
      'console', context.scope.kind, context.scope.id, context.session.accessVersion, 'catalog.listings.read',
    ] });
  }, [context.scope.id, context.scope.kind, context.session.accessVersion, data?.state, queryClient]);

  return (
    <ResourcePanel title="商品导入" eyebrow="VALIDATE → CONFIRM → DRAFT" description={`${jobId}；上传后先停在权威校验结果，确认后才写入当前商城。`}
      condition={condition} {...(queryError === undefined ? {} : { error: queryError })} retry={() => { void query.refetch(); }}
      actions={<div className="productimportactions"><Button onPress={() => { void navigate(productsPath); }}>返回商品</Button>
        <Button onPress={() => { void query.refetch(); }}>刷新</Button></div>}>
      {data === undefined ? <span /> : <div className="featurestack productimportresult">
        <MetricCards items={[
          { label: '任务状态', value: stateLabel(data.state) },
          { label: '总行数', value: formatCount(data.total_count ?? 0) },
          { label: '校验有效', value: formatCount(validCount), tone: validCount > 0 ? 'success' : 'danger' },
          { label: '错误行', value: formatCount(summary?.errorCount ?? data.errors.length), tone: data.errors.length > 0 ? 'danger' : 'success' },
          { label: '已保存草稿', value: formatCount(data.success_count ?? 0), tone: 'success' },
          { label: '更新时间', value: formatDate(data.updated_at) },
        ]} />
        <CatalogImportProgress key={jobId} job={data} summary={summary} confirming={confirmation.isPending} />
        {data.state === 'ready' ? <section className="productconfirmcard" aria-labelledby="catalogconfirmtitle">
          <div><h2 id="catalogconfirmtitle">服务端校验已完成</h2>
            <p>将写入 {validCount} 个有效商品的 Catalog、Pricing、Inventory 与当前商城草稿货架；错误行不会写入。</p></div>
          <Button tone="primary" isPending={confirmation.isPending}
            isDisabled={!canCreateCatalogImport(context) || validCount === 0}
            onPress={() => confirmation.mutate()}>确认保存草稿</Button>
        </section> : null}
        {data.state === 'completed' ? <section className="productconfirmcard productconfirmcomplete" aria-label="导入完成">
          <div><h2>商品草稿已保存</h2><p>返回商品列表即可逐个上架；错误行仍保留在下方供修正后重新上传。</p></div>
          <Button tone="primary" onPress={() => { void navigate(productsPath); }}>去上架商品</Button>
        </section> : null}
        {data.last_error == null ? null : <p className="productcommanderror" role="alert">{data.last_error}</p>}
        {confirmation.error === null ? null : <p className="productcommanderror" role="alert">
          {confirmation.error instanceof Error ? confirmation.error.message : '确认导入失败'}
        </p>}
        {preview.length === 0 ? null : <section aria-labelledby="catalogpreviewtitle">
          <h2 id="catalogpreviewtitle">前 {preview.length} 行预览</h2>
          <div className="productpreviewtable"><table><thead><tr><th>包内行</th><th>商品</th><th>SKU</th><th>分类</th><th>售价</th><th>库存</th></tr></thead>
            <tbody>{preview.map((row) => <tr key={row.rowNumber}><td>{row.rowNumber}</td><td>{row.title ?? '—'}</td>
              <td>{row.sku ?? '—'}</td><td>{row.category ?? '—'}</td><td>{money(row.priceMinor)}</td><td>{row.stock ?? '—'}</td></tr>)}</tbody></table></div>
        </section>}
        <DataTable caption="校验错误行" columns={errorColumns} rows={data.errors}
          rowKey={(row) => `${row.row_number}:${row.reason_code}:${row.field ?? ''}`} />
      </div>}
    </ResourcePanel>
  );
}

function stateLabel(state: string): string {
  if (state === 'uploaded' || state === 'validating') return '正在校验';
  if (state === 'ready') return '待确认';
  if (state === 'running' || state === 'reporting') return '正在保存';
  if (state === 'completed') return '已完成';
  if (state === 'failed') return '失败';
  if (state === 'cancelled') return '已取消';
  return state;
}

function CatalogImportProgress({ job, summary, confirming }: Readonly<{
  job: ImportJob;
  summary: z.infer<typeof CatalogImportValidationSummarySchema> | undefined;
  confirming: boolean;
}>) {
  const waiting = job.state === 'uploaded';
  const validating = job.state === 'validating';
  const saving = job.state === 'running' || job.state === 'reporting';
  const saved = job.state === 'completed';
  const stopped = job.state === 'failed' || job.state === 'cancelled';
  const validationDone = job.state === 'ready' || saving || saved || summary?.validationFinishedAt !== undefined;
  const total = job.total_count ?? 0;
  const cursor = Math.min(job.cursor_value ?? 0, total);
  const checked = validationDone ? total : cursor;
  const saveStarted = saving || saved || summary?.saveRequestedAt !== undefined;
  const processed = saved ? total : saveStarted ? cursor : 0;
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    if (!waiting && !validating && !saving) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [saving, validating, waiting]);

  const validationDuration = waiting ? duration(job.created_at, now)
    : duration(summary?.validationStartedAt, summary?.validationFinishedAt ?? (stopped ? job.updated_at : validating ? now : undefined));
  const saveDuration = duration(summary?.saveRequestedAt, saving ? now : saved || stopped ? job.updated_at : undefined);
  const validationStatus = validationDone ? '校验完成' : stopped ? stateLabel(job.state)
    : waiting ? '等待校验' : total === 0 ? '正在读取导入包' : '正在校验';
  const saveStatus = saved ? '保存完成' : job.state === 'reporting' ? '正在生成结果'
    : saving ? '正在保存草稿' : confirming ? '正在提交保存'
      : stopped ? saveStarted ? stateLabel(job.state) : '未开始' : '等待确认';

  return <section className="productimportprogress" aria-label="导入进度">
    <div>
      <div className="productimportprogresslabel">
        <strong>校验进度</strong>
        <span>{validationStatus}{total > 0 ? ` · 已校验 ${formatCount(checked)} / ${formatCount(total)} 行` : ''}
          {validationDuration ? ` · ${waiting ? '已等待' : '耗时'} ${validationDuration}` : validationDone || stopped ? ' · 耗时未记录' : ''}</span>
      </div>
      <progress aria-label="校验进度" max={total || 1}
        value={total > 0 ? checked : validationDone ? 1 : validating ? undefined : 0} />
    </div>
    <div>
      <div className="productimportprogresslabel">
        <strong>保存草稿进度</strong>
        <span>{saveStatus}{saveStarted && total > 0
          ? ` · 已处理 ${formatCount(processed)} / ${formatCount(total)} 行` : ''}
          {saveDuration ? ` · 耗时 ${saveDuration}` : saved ? ' · 耗时未记录' : ''}</span>
      </div>
      <progress aria-label="保存草稿进度" max={total || 1}
        value={confirming || (job.state === 'running' && processed === 0) ? undefined : saved && total === 0 ? 1 : processed} />
    </div>
  </section>;
}

function duration(start: string | undefined, end: string | number | undefined): string | undefined {
  if (start === undefined || end === undefined) return undefined;
  const seconds = Math.floor(((typeof end === 'string' ? Date.parse(end) : end) - Date.parse(start)) / 1_000);
  if (!Number.isFinite(seconds)) return undefined;
  if (seconds < 1) return '不到 1 秒';
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes} 分 ${seconds % 60} 秒` : `${seconds} 秒`;
}

function money(value: string | null | undefined): string {
  if (value == null || !/^\d+$/.test(value)) return '—';
  return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' }).format(Number(value) / 100);
}
