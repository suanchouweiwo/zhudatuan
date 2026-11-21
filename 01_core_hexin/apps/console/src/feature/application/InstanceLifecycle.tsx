import { Button } from '@shop/design';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { ConsoleContext, ConsoleScope } from '../../entity/session/ConsoleSession';
import { enterManagedInstance, manageInstance, readManagedInstances, readManagedInstanceTask, retryManagedInstanceTask, type AutoNodeTaskReceipt } from './MallCreateCommand';

export function InstanceLifecycle({ context, scope }: { context: ConsoleContext; scope: ConsoleScope }) {
  const [task, setTask] = useState<AutoNodeTaskReceipt>();
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const taskSubmission = useRef(false);
  const [administrator, setAdministrator] = useState({ displayName: '', username: '', password: '' });
  const [editing, setEditing] = useState<string>();
  const instances = useQuery({ queryKey: ['managed-instances', scope.id], queryFn: () => readManagedInstances(context, scope) });
  const running = task !== undefined && ['QUEUED', 'RUNNING'].includes(task.status);
  useEffect(() => {
    if (task) return;
    const previous = instances.data?.find((instance) => instance.task)?.task;
    if (previous) setTask(previous);
  }, [instances.data, task]);
  useEffect(() => {
    if (!running || !task) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void readManagedInstanceTask(context, scope, task.task_id, controller.signal).then((next) => {
        if (controller.signal.aborted) return;
        setTask(next);
        if (next.status === 'SUCCEEDED') void instances.refetch();
      }).catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
      });
    }, 3000);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [context, scope, task, running, instances.refetch]);
  const submitTask = async (submit: () => Promise<AutoNodeTaskReceipt>) => {
    if (submitting || taskSubmission.current) return;
    taskSubmission.current = true;
    setSubmitting(true); setError(undefined);
    try {
      const next = await submit();
      setTask(next);
      if (next.status === 'SUCCEEDED') void instances.refetch();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { taskSubmission.current = false; setSubmitting(false); }
  };
  const execute = (nodeId: string, action: 'CREATE' | 'DELETE' | 'INITIALIZE') =>
    submitTask(() => manageInstance(context, scope, nodeId, action, action === 'DELETE' || !administrator.username ? undefined : administrator));
  return <section className="commerceboard" aria-label="L0 实例管理">
    <div className="commercefilterbar"><div><strong>L0 实例管理</strong><span>同一核心，独立配置；删除后重新生成空库商城。</span></div></div>
    {instances.isPending ? <p>正在读取实例…</p> : null}
    {instances.error ? <p role="alert">{instances.error.message}</p> : null}
    {instances.data?.map((instance) => <div className="commerceownership" key={instance.node_id}>
      <div><strong>{instance.name}</strong><p>{instance.state === 'DELETED' ? '已删除，可生成全新商城' : '实例已存在'}</p></div>
      {instance.lifecycle ? <Button isDisabled={running || submitting} onPress={() => {
        if (instance.state === 'DELETED') setEditing(instance.node_id);
        else void execute(instance.node_id, 'DELETE');
      }}>{instance.state === 'DELETED' ? '生成全新商城' : '完整删除测试商城'}</Button> : <span>主打团核心实例</span>}
    </div>)}
    {instances.data?.filter((instance) => instance.lifecycle).map((instance) => <div key={`admin:${instance.node_id}`}>
      {!instance.administrator_ready && instance.state !== 'DELETED' && editing !== instance.node_id ? <Button isDisabled={running || submitting} onPress={() => setEditing(instance.node_id)}>初始化管理员</Button> : null}
      {editing === instance.node_id ? <form onSubmit={(event) => { event.preventDefault(); void execute(instance.node_id, instance.state === 'DELETED' ? 'CREATE' : 'INITIALIZE'); }}>
        <label>管理员姓名<input required value={administrator.displayName} onChange={(event) => setAdministrator({ ...administrator, displayName: event.target.value })} autoComplete="name" /></label>
        <label>登录账号<input required value={administrator.username} onChange={(event) => setAdministrator({ ...administrator, username: event.target.value })} autoComplete="username" /></label>
        <label>登录密码<input required type="password" value={administrator.password} onChange={(event) => setAdministrator({ ...administrator, password: event.target.value })} autoComplete="new-password" /></label>
        <Button type="submit" isDisabled={running || submitting}>{instance.state === 'DELETED' ? '生成商城并初始化管理员' : '保存管理员资料'}</Button>
      </form> : null}
      {instance.administrator_ready && administrator.password ? <Button isDisabled={submitting} onPress={() => {
        setSubmitting(true); setError(undefined);
        void enterManagedInstance(instance, administrator).then((url) => { window.location.assign(url); }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setSubmitting(false));
      }}>进入新商城后台</Button> : null}
    </div>)}
    {task ? <p role="status">{task.status === 'SUCCEEDED' ? (task.action === 'DELETE' ? '删除完成' : task.action === 'INITIALIZE' ? '管理员已初始化' : '全新商城已生成') : `${task.phase} · ${task.progress}%`}</p> : null}
    {task?.last_error ? <p role="alert">{task.last_error.message}</p> : null}
    {task && (task.status === 'WAITING_EXTERNAL' || task.status === 'FAILED_RETRYABLE') ? <Button onPress={() => {
      void submitTask(() => retryManagedInstanceTask(context, scope, task));
    }}>继续任务</Button> : null}
    {error ? <p role="alert">{error}</p> : null}
    {task?.status === 'SUCCEEDED' ? task.result?.access_entries.map((entry) => <p key={entry.surface_ref}><a href={entry.url}>{entry.surface_ref === 'surface:console' ? '打开新商城后台' : entry.surface_ref === 'surface:storefront' ? '打开新商城' : entry.url}</a></p>) : null}
  </section>;
}
