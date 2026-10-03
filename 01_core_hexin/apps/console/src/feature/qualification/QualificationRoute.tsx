import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { useConsoleContext } from '../../entity/session/ConsoleContext';
import { queryCondition, safeQueryError } from '../../shared/api/QueryState';
import type { DataColumn } from '../../shared/ui/DataTable';
import { formatDate } from '../../shared/ui/Format';
import { PagedResource } from '../../shared/ui/PagedResource';
import { pageCursor } from '../../shared/url/PageCursor';
import { QUALIFICATION_STALE_TIME_MS, qualificationKey, readQualifications } from './QualificationQuery';
import type { QualificationPolicy } from './QualificationSchema';

const columns: readonly DataColumn<QualificationPolicy>[] = [
  { key: 'name', label: '资格策略', render: (row) => row.name },
  { key: 'status', label: '状态', render: (row) => row.status },
  { key: 'version', label: '生效版本', render: (row) => row.active_version ?? '—' },
  { key: 'rules', label: '规则字段', render: (row) => row.rule === null ? '—' : Object.keys(row.rule).length },
  { key: 'published', label: '发布时间', render: (row) => formatDate(row.published_at) },
  { key: 'updated', label: '更新时间', render: (row) => formatDate(row.updated_at) },
];

export function Component() {
  const context = useConsoleContext(); const [search, setSearch] = useSearchParams(); const cursor = search.get('cursor') ?? undefined;
  const query = useQuery({ queryKey: qualificationKey(context, cursor), queryFn: ({ signal }) => readQualifications(context, cursor, signal),
    staleTime: QUALIFICATION_STALE_TIME_MS, retry: false, refetchOnWindowFocus: false });
  const data = query.data; const error = safeQueryError(query.error);
  const state = queryCondition({ pending: query.isPending, fetching: query.isFetching, error: query.error,
    hasData: data !== undefined, empty: data?.items.length === 0, stale: query.isStale });
  return <PagedResource title="资格管理" eyebrow="MORVIA QUALIFICATION" description="资格策略、版本和规则摘要来自 qualification.center.read；结算仍会服务端重算。"
    condition={state} {...(error === undefined ? {} : { error })} rows={data?.items ?? []} columns={columns} rowKey={(row) => row.id}
    count={data?.count ?? 0} {...(data?.nextCursor === undefined ? {} : { nextCursor: data.nextCursor })}
    boundary={{ title: '策略发布保持关闭', message: '资格策略写入缺版本预览、影响解释、Step-up 与回滚证据时不执行。' }}
    retry={() => { void query.refetch(); }} next={(next) => setSearch(pageCursor(search, next))} />;
}
