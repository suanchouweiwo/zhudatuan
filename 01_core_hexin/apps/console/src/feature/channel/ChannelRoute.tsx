import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { useConsoleContext } from '../../entity/session/ConsoleContext';
import { queryCondition, safeQueryError } from '../../shared/api/QueryState';
import type { DataColumn } from '../../shared/ui/DataTable';
import { formatDate } from '../../shared/ui/Format';
import { PagedResource } from '../../shared/ui/PagedResource';
import { pageCursor } from '../../shared/url/PageCursor';
import { channelKey, channelViews, readChannels } from './ChannelQuery';
import type { ChannelRecord, ChannelView } from './ChannelSchema';

const columns: readonly DataColumn<ChannelRecord>[] = [
  { key: 'provider', label: 'Provider/连接', render: (row) => row.provider },
  { key: 'kind', label: '类型', render: (row) => row.kind },
  { key: 'state', label: '服务端状态', render: (row) => row.state },
  { key: 'progress', label: '进度/配置', render: (row) => row.progress },
  { key: 'reference', label: '水位/回执', render: (row) => row.reference },
  { key: 'time', label: '更新时间', render: (row) => formatDate(row.occurredAt) },
  { key: 'version', label: '版本', render: (row) => row.version ?? '—' },
];

export function Component() {
  const context = useConsoleContext(); const [search, setSearch] = useSearchParams();
  const selected = search.get('view'); const view: ChannelView = channelViews.includes(selected as ChannelView) ? selected as ChannelView : 'connections';
  const cursor = search.get('cursor') ?? undefined;
  const query = useQuery({ queryKey: channelKey(context, view, cursor), queryFn: ({ signal }) => readChannels(context, view, cursor, signal) });
  const data = query.data; const error = safeQueryError(query.error);
  const state = queryCondition({ pending: query.isPending, fetching: query.isFetching, error: query.error,
    hasData: data !== undefined, empty: data?.items.length === 0, stale: query.isStale });
  const select = (next: ChannelView) => { const params = new URLSearchParams(); params.set('view', next); setSearch(params); };
  return <PagedResource title="渠道管理" eyebrow="MORVIA CHANNEL" description="连接、同步和外部操作一次读取一个服务端读模型；只展示凭据状态，不暴露 Secret。"
    condition={state} {...(error === undefined ? {} : { error })} rows={data?.items ?? []} columns={columns} rowKey={(row) => row.id}
    count={data?.count ?? 0} {...(data?.nextCursor === undefined ? {} : { nextCursor: data.nextCursor })}
    actions={<label className="inlinefield">查看<select value={view} onChange={(event) => select(event.target.value as ChannelView)}>
      <option value="connections">渠道连接</option><option value="syncs">同步批次</option><option value="operations">外部操作</option></select></label>}
    boundary={{ title: '渠道写操作保持关闭', message: '创建、测试、启停、同步与重放缺 Provider 合同、Preview 和 action-bound proof 时不执行。' }}
    retry={() => { void query.refetch(); }} next={(next) => setSearch(pageCursor(search, next))} />;
}
