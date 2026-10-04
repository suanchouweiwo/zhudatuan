import { Button, ResourcePanel } from '@shop/design';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { useConsoleContext } from '../../entity/session/ConsoleContext';
import { queryCondition, safeQueryError } from '../../shared/api/QueryState';
import { DataTable, type DataColumn } from '../../shared/ui/DataTable';
import { formatCount, formatDate } from '../../shared/ui/Format';
import { MetricCards } from '../../shared/ui/MetricCards';
import { importKey, importKinds, readImport } from './ImportQuery';
import type { ImportError, ImportKind } from './ImportSchema';

const columns: readonly DataColumn<ImportError>[] = [
  { key: 'row', label: '行号', render: (row) => row.row_number },
  { key: 'reason', label: '错误代码', render: (row) => row.reason_code },
  { key: 'field', label: '字段', render: (row) => row.field ?? '—' },
  { key: 'detail', label: '说明', render: (row) => row.detail ?? '—' },
];

export function Component() {
  const params = useParams();
  const kind = importKinds.includes(params.kind as ImportKind) ? params.kind as ImportKind : null;
  const jobId = params.jobId ?? '';
  if (kind === null || jobId === '') throw new Response('IMPORT_ROUTE_INVALID', { status: 404 });
  return <ImportJobRoute kind={kind} jobId={jobId} />;
}

function ImportJobRoute({ kind, jobId }: Readonly<{ kind: ImportKind; jobId: string }>) {
  const context = useConsoleContext();
  const query = useQuery({ queryKey: importKey(context, kind, jobId), queryFn: ({ signal }) => readImport(context, kind, jobId, signal),
    refetchInterval: (current) => ['completed', 'failed', 'cancelled'].includes(current.state.data?.state ?? '') ? false : 3_000 });
  const data = query.data; const error = safeQueryError(query.error);
  const state = queryCondition({ pending: query.isPending, fetching: query.isFetching, error: query.error,
    hasData: data !== undefined, empty: false, stale: query.isStale });
  return <ResourcePanel title="导入结果" eyebrow="主打团 IMPORT" description={`${kind} · ${jobId}；进度、错误行和报告均由服务端任务返回。`}
    condition={state} {...(error === undefined ? {} : { error })} retry={() => { void query.refetch(); }}
    actions={<Button onPress={() => { void query.refetch(); }}>刷新进度</Button>}>
    {data === undefined ? <span /> : <div className="featurestack">
      <MetricCards items={[
        { label: '任务状态', value: data.state }, { label: '总行数', value: formatCount(data.total_count ?? 0) },
        { label: '成功', value: formatCount(data.success_count ?? 0), tone: 'success' },
        { label: '失败', value: formatCount(data.failure_count ?? 0), tone: (data.failure_count ?? 0) > 0 ? 'danger' : 'success' },
        { label: '更新时间', value: formatDate(data.updated_at) },
      ]} />
      {data.last_error === undefined || data.last_error === null ? null : <section className="capabilitynote" aria-labelledby="importfailure">
        <h2 id="importfailure">任务错误</h2><p>{data.last_error}</p></section>}
      <DataTable caption="导入错误行" columns={columns} rows={data.errors} rowKey={(row) => `${row.row_number}:${row.reason_code}:${row.field ?? ''}`} />
    </div>}
  </ResourcePanel>;
}
