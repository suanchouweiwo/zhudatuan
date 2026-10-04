import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useSearchParams } from 'react-router';
import { useConsoleContext } from '../../entity/session/ConsoleContext';
import { queryCondition, safeQueryError } from '../../shared/api/QueryState';
import type { DataColumn } from '../../shared/ui/DataTable';
import { formatDate } from '../../shared/ui/Format';
import { PagedResource } from '../../shared/ui/PagedResource';
import { pageCursor } from '../../shared/url/PageCursor';
import { NOTIFICATION_STALE_TIME_MS, notificationKey, notificationViews, readNotificationRecords } from './NotificationQuery';
import type { NotificationRecord, NotificationView } from './NotificationSchema';

const columns: readonly DataColumn<NotificationRecord>[] = [
  { key: 'title', label: '名称', render: (row) => row.title },
  { key: 'channel', label: '渠道', render: (row) => row.channel },
  { key: 'state', label: '状态', render: (row) => row.state },
  { key: 'start', label: '开始/创建', render: (row) => formatDate(row.startsAt) },
  { key: 'end', label: '结束', render: (row) => formatDate(row.endsAt) },
  { key: 'version', label: '版本', render: (row) => row.version },
];

export function Component() {
  const context = useConsoleContext(); const queryClient = useQueryClient(); const [search, setSearch] = useSearchParams();
  const selected = search.get('view'); const view: NotificationView = notificationViews.includes(selected as NotificationView)
    ? selected as NotificationView : 'templates'; const cursor = search.get('cursor') ?? undefined;
  const query = useQuery({ queryKey: notificationKey(context, view, cursor),
    queryFn: ({ signal }) => readNotificationRecords(context, view, cursor, signal),
    staleTime: NOTIFICATION_STALE_TIME_MS, retry: false, refetchOnWindowFocus: false });
  const data = query.data; const error = safeQueryError(query.error);
  const state = queryCondition({ pending: query.isPending, fetching: query.isFetching, error: query.error,
    hasData: data !== undefined, empty: data?.items.length === 0, stale: query.isStale });
  useEffect(() => {
    if (query.data === undefined || query.isFetching) return undefined;
    const adjacent: NotificationView = view === 'templates' ? 'announcements' : 'templates';
    const timer = window.setTimeout(() => {
      void queryClient.prefetchQuery({
        queryKey: notificationKey(context, adjacent),
        queryFn: ({ signal }) => readNotificationRecords(context, adjacent, undefined, signal),
        staleTime: NOTIFICATION_STALE_TIME_MS,
      });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [context, query.data, query.isFetching, queryClient, view]);
  const select = (next: NotificationView) => { const params = new URLSearchParams(); params.set('view', next); setSearch(params); };
  return <PagedResource title="通知管理" eyebrow="主打团 NOTIFICATION" description="模板和公告按 URL 选择独立读模型，不在浏览器合并发送状态。"
    condition={state} {...(error === undefined ? {} : { error })} rows={data?.items ?? []} columns={columns} rowKey={(row) => row.id}
    count={data?.count ?? 0} {...(data?.nextCursor === undefined ? {} : { nextCursor: data.nextCursor })}
    actions={<label className="inlinefield">查看<select value={view} onChange={(event) => select(event.target.value as NotificationView)}>
      <option value="templates">通知模板</option><option value="announcements">公告</option></select></label>}
    boundary={{ title: '通知发布保持关闭', message: '模板变量校验、Preview、Step-up、发送回执和受众重读未闭合前不写入。' }}
    retry={() => { void query.refetch(); }} next={(next) => setSearch(pageCursor(search, next))} />;
}
