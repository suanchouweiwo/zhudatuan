import { Button } from '@shop/design';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { ConsoleContext, ConsoleScope } from '../../entity/session/ConsoleSession';
import { manageInstance, readManagedInstances, readMallNodeTask, type AutoNodeTaskReceipt } from './MallCreateCommand';

export function InstanceLifecycle({ context, scope }: { context: ConsoleContext; scope: ConsoleScope }) {
  const [task, setTask] = useState<AutoNodeTaskReceipt>();
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const instances = useQuery({ queryKey: ['managed-instances', scope.id], queryFn: () => readManagedInstances(context, scope) });
  const running = task !== undefined && ['QUEUED', 'RUNNING'].includes(task.status);
  useEffect(() => {
    if (task) return;
    const previous = instances.data?.find((instance) => instance.task)?.task;
    if (previous) setTask(previous);
  }, [instances.data, task]);
  useEffect(() => {
    if (!running || !task) return;
    const timer = window.setTimeout(() => {
      void readMallNodeTask(context, scope, task.task_id).then((next) => {
        setTask(next);
        if (next.status === 'SUCCEEDED') void instances.refetch();
      }).catch((cause: unknown) => { setError(cause instanceof Error ? cause.message : String(cause)); });
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [context, scope, task, running, instances.refetch]);
  const execute = async (nodeId: string, action: 'CREATE' | 'DELETE') => {
    setSubmitting(true); setError(undefined);
    try { setTask(await manageInstance(context, scope, nodeId, action)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSubmitting(false); }
  };
  return <section className="commerceboard" aria-label="L0 实例管理">
    <div className="commercefilterbar"><div><strong>L0 实例管理</strong><span>同一核心，独立配置；删除后重新生成空库商城。</span></div></div>
    {instances.isPending ? <p>正在读取实例…</p> : null}
    {instances.error ? <p role="alert">{instances.error.message}</p> : null}
    {instances.data?.map((instance) => <div className="commerceownership" key={instance.node_id}>
      <div><strong>{instance.name}</strong><p>{instance.state === 'DELETED' ? '已删除，可生成全新商城' : '实例已存在'}</p></div>
      {instance.lifecycle ? <Button isDisabled={running || submitting} onPress={() => {
        void execute(instance.node_id, instance.state === 'DELETED' ? 'CREATE' : 'DELETE');
      }}>{instance.state === 'DELETED' ? '生成全新商城' : '完整删除测试商城'}</Button> : <span>主打团核心实例</span>}
    </div>)}
    {task ? <p role="status">{task.status === 'SUCCEEDED' ? (task.action === 'DELETE' ? '删除完成' : '全新商城已生成') : `${task.phase} · ${task.progress}%`}</p> : null}
    {task?.last_error ? <p role="alert">{task.last_error.message}</p> : null}
    {task?.status === 'FAILED_RETRYABLE' ? <Button onPress={() => {
      void execute(task.node_id, task.action === 'DELETE' ? 'DELETE' : 'CREATE');
    }}>继续任务</Button> : null}
    {error ? <p role="alert">{error}</p> : null}
    {task?.status === 'SUCCEEDED' ? task.result?.access_entries.map((entry) => <p key={entry.surface_ref}><a href={entry.url}>{entry.surface_ref === 'surface:console' ? '打开新商城后台' : entry.surface_ref === 'surface:storefront' ? '打开新商城' : entry.url}</a></p>) : null}
  </section>;
}
