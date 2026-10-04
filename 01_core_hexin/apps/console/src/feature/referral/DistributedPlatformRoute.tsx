import { Badge, Button, MasterDetail, MasterItem, ResourceState, Surface, WorkspaceHero } from '@shop/design';
import type { SflNodeResourceBinding } from '@shop/config/sfl-node-registry';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useConsoleContext } from '../../entity/session/ConsoleContext';
import { queryCondition, safeQueryError } from '../../shared/api/QueryState';
import { appConfig } from '../../shared/config/AppConfig';
import { formatDate } from '../../shared/ui/Format';
import { scopePath } from '../../shared/url/ScopePath';
import { applicationKey, applicationRootKey, readApplications } from '../application/ApplicationQuery';
import type { Application } from '../application/ApplicationSchema';
import {
  canCreateMall,
  canReadMallNodeTask,
  canRetryMallNodeTask,
  completeMallCreateStepup,
  createMall,
  isMallMobileMissing,
  isMallStepupRequired,
  mallCreationError,
  mallCreationRequiresStepup,
  mallEnterpriseScopes,
  mallMobileEnrollmentRequired,
  mallNodeTaskKey,
  mallProvisioningScope,
  newMallCreateAttempt,
  readMallNodeTask,
  retryMallNodeTask,
  startMallCreateStepup,
  type AutoNodeTaskReceipt,
  type CreatedMall,
  type MallCreateAttempt,
  type MallCreateDraft,
  type MallStepupChallenge,
} from '../application/MallCreateCommand';
import {
  applicationStatusLabel,
  applicationStatusTone,
  publicationLabel,
} from '../application/ApplicationPresentation';
import { PlatformCreateDialog, type PlatformCreatePhase } from './PlatformCreateDialog';
import { PlatformTaskCenter } from './PlatformTaskCenter';
import './distributed-platform.css';

type DirectorySelection = Readonly<{ kind: 'node' }> | Readonly<{ kind: 'application'; application: Application }>;
type TopologyLayout = 'tree' | 'flow';

declare const __LK_INSTANCE_NODE_BINDINGS__: readonly Pick<SflNodeResourceBinding, 'node_id' | 'display_name'>[] | undefined;

export function Component() {
  const context = useConsoleContext();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [search, setSearch] = useSearchParams();
  const [createPhase, setCreatePhase] = useState<PlatformCreatePhase>('form');
  const [createError, setCreateError] = useState<string>();
  const [createAttempt, setCreateAttempt] = useState<MallCreateAttempt>();
  const [createChallenge, setCreateChallenge] = useState<MallStepupChallenge>();
  const [createResult, setCreateResult] = useState<CreatedMall>();
  const [stepupCompleted, setStepupCompleted] = useState(false);
  const [mobileEnrollment, setMobileEnrollment] = useState(false);
  const [taskRetrying, setTaskRetrying] = useState(false);
  const [taskRetryError, setTaskRetryError] = useState<string>();
  const manifest = appConfig.nodeManifest;
  const provisioningScope = mallProvisioningScope(context);
  const enterpriseScopes = mallEnterpriseScopes(context);
  const createAvailable = canCreateMall(context, provisioningScope);
  const taskReadable = canReadMallNodeTask(context, provisioningScope);
  const taskRetryAvailable = canRetryMallNodeTask(context, provisioningScope);
  const nextPlatformLevel = nextLevel(manifest.signed_level);
  const createOpen = search.get('create') === 'platform';
  const query = useQuery({
    queryKey: applicationKey(context),
    queryFn: ({ signal }) => readApplications(context, undefined, signal),
    staleTime: 60_000,
  });
  const nodeTaskQuery = useQuery({
    queryKey: mallNodeTaskKey(context, provisioningScope, createResult?.nodeTask.task_id ?? 'none'),
    queryFn: ({ signal }) => readMallNodeTask(context, provisioningScope!, createResult!.nodeTask.task_id, signal),
    enabled: createResult !== undefined && taskReadable,
    initialData: createResult?.nodeTask,
    refetchInterval: ({ state }) => state.data !== undefined && terminalNodeTask(state.data) ? false : 1_500,
  });
  const applications = useMemo(
    () => (query.data?.items ?? []).filter((application) => application.mall_id !== null && application.mall_id !== undefined),
    [query.data?.items],
  );
  const selectedId = search.get('selected');
  const topologyLayout: TopologyLayout = search.get('layout') === 'flow' ? 'flow' : 'tree';
  const selectedApplication = applications.find((application) => application.id === selectedId);
  const selection: DirectorySelection = selectedApplication === undefined
    ? { kind: 'node' }
    : { kind: 'application', application: selectedApplication };
  const condition = queryCondition({
    pending: query.isPending,
    fetching: query.isFetching,
    error: query.error,
    hasData: query.data !== undefined,
    empty: false,
    stale: query.isStale,
  });
  const queryError = safeQueryError(query.error);
  const storefronts = manifest.domain_bindings.filter((binding) => binding.surface_ref === 'surface:storefront');
  const published = applications.filter((application) => application.published_sequence !== null
    && application.published_sequence !== undefined).length;

  const selectNode = () => {
    const next = new URLSearchParams(search);
    next.delete('selected');
    setSearch(next);
  };
  const selectApplication = (application: Application) => {
    const next = new URLSearchParams(search);
    next.set('selected', application.id);
    setSearch(next);
  };
  const selectTopologyLayout = (layout: TopologyLayout) => {
    const next = new URLSearchParams(search);
    if (layout === 'tree') next.delete('layout');
    else next.set('layout', layout);
    setSearch(next, { replace: true });
  };
  const openPlatformCreate = () => {
    const next = new URLSearchParams(search);
    next.set('create', 'platform');
    setCreatePhase('form');
    setCreateError(undefined);
    setMobileEnrollment(mallMobileEnrollmentRequired(context));
    setSearch(next);
  };
  const closePlatformCreate = () => {
    if (createPhase === 'starting' || createPhase === 'verifying' || createPhase === 'creating') return;
    const next = new URLSearchParams(search);
    next.delete('create');
    if (createResult !== undefined) next.set('selected', createResult.applicationId);
    setSearch(next);
    setCreatePhase('form');
    setCreateError(undefined);
    setCreateAttempt(undefined);
    setCreateChallenge(undefined);
    setCreateResult(undefined);
    setStepupCompleted(false);
    setMobileEnrollment(false);
    setTaskRetrying(false);
    setTaskRetryError(undefined);
  };
  const requestStepup = async (attempt: MallCreateAttempt) => {
    if (provisioningScope === undefined) {
      setCreateError(mallCreationError(new Error('MALL_CREATE_NOT_AVAILABLE')));
      setCreatePhase('form');
      return;
    }
    setCreatePhase('starting');
    try {
      const challenge = await startMallCreateStepup(context, provisioningScope);
      setCreateAttempt(attempt);
      setCreateChallenge(challenge);
      setCreatePhase('verification');
    } catch (cause) {
      if (isMallMobileMissing(cause)) {
        setCreateError(undefined);
        setCreatePhase('form');
        setMobileEnrollment(true);
        return;
      }
      setCreateError(mallCreationError(cause));
      setCreatePhase('form');
    }
  };
  const provisionPlatform = async (attempt: MallCreateAttempt) => {
    if (provisioningScope === undefined) {
      setCreateError(mallCreationError(new Error('MALL_CREATE_NOT_AVAILABLE')));
      setCreatePhase('form');
      return;
    }
    setCreatePhase('creating');
    try {
      const result = await createMall(context, provisioningScope, attempt);
      setCreateResult(result);
      setCreateError(undefined);
      setCreatePhase('success');
      await queryClient.invalidateQueries({ queryKey: applicationRootKey(context) });
    } catch (cause) {
      if (isMallStepupRequired(cause)) {
        setStepupCompleted(false);
        await requestStepup(attempt);
        return;
      }
      setCreateError(mallCreationError(cause));
      setCreatePhase('form');
    }
  };
  const beginPlatformCreate = async (draft: MallCreateDraft) => {
    if (!createAvailable || provisioningScope === undefined) {
      setCreateError(mallCreationError(new Error('MALL_CREATE_NOT_AVAILABLE')));
      return;
    }
    setCreateError(undefined);
    const attempt = sameCreateDraft(createAttempt, draft) ? createAttempt : newMallCreateAttempt(draft);
    setCreateAttempt(attempt);
    if (mallMobileEnrollmentRequired(context)) {
      setCreatePhase('form');
      setMobileEnrollment(true);
      return;
    }
    if (mallCreationRequiresStepup(context) && !stepupCompleted) {
      await requestStepup(attempt);
      return;
    }
    await provisionPlatform(attempt);
  };
  const verifyAndCreate = async (code: string) => {
    if (provisioningScope === undefined || createChallenge === undefined || createAttempt === undefined) return;
    setCreateError(undefined);
    setCreatePhase('verifying');
    try {
      await completeMallCreateStepup(context, provisioningScope, createChallenge.id, code);
      setStepupCompleted(true);
      setCreateChallenge(undefined);
      await provisionPlatform(createAttempt);
    } catch (cause) {
      setCreateError(mallCreationError(cause));
      setCreatePhase('verification');
    }
  };
  const retryNodeTask = async () => {
    if (createResult === undefined || provisioningScope === undefined || !taskRetryAvailable) return;
    setTaskRetrying(true);
    setTaskRetryError(undefined);
    try {
      const task = await retryMallNodeTask(context, provisioningScope, createResult.nodeTask.task_id);
      if (task.task_id !== createResult.nodeTask.task_id) throw new Error('NODE_TASK_RETRY_CHAIN_CHANGED');
      queryClient.setQueryData(mallNodeTaskKey(context, provisioningScope, task.task_id), task);
    } catch (cause) {
      setTaskRetryError(safeQueryError(cause instanceof Error ? cause : new Error('NODE_TASK_RETRY_FAILED')));
    } finally {
      setTaskRetrying(false);
    }
  };

  return (
    <section className="distributedplatform" aria-labelledby="distributedplatformtitle">
      <WorkspaceHero
        className="distributedplatformhero"
        eyebrow="L0—L5 · DISTRIBUTED PLATFORM"
        title={<span id="distributedplatformtitle">分布式平台</span>}
        description="统一查看当前主权节点、承载商城、H5 入口、版本与收益关系。"
        meta={<>
          <Badge tone="info">{manifest.signed_level}</Badge>
          <Badge tone={manifest.lifecycle_status === 'active' ? 'success' : 'warning'}>
            {lifecycleLabel(manifest.lifecycle_status)}
          </Badge>
        </>}
        actions={<>
          <Button onPress={() => { void navigate(scopePath(context.scope, 'referral/settings')); }}>收益与结算</Button>
          <Button tone="primary" onPress={openPlatformCreate}>创建下级平台</Button>
        </>}
      />

      <section className="distributedplatformmetrics" aria-label="平台摘要">
        <PlatformMetric label="当前层级" value={manifest.signed_level} hint="由当前 NodeManifest 确认" />
        <PlatformMetric label="独立入口" value={String(storefronts.length)} hint="当前节点的 H5 与商城域名" />
        <PlatformMetric label="商城应用" value={String(applications.length)} hint="当前范围真实返回" />
        <PlatformMetric label="已发布" value={String(published)} hint="存在正式发布版本" />
      </section>

      <PlatformTaskCenter applications={applications} applicationsPending={query.isPending}
        applicationsError={queryError} context={context} scope={provisioningScope}
        onRetryApplications={() => { void query.refetch(); }} />

      <ResourceState
        condition={condition}
        {...(queryError === undefined ? {} : { error: queryError })}
        retry={() => void query.refetch()}
        resourceLabel="分布式平台"
      >
        <MasterDetail
          className="distributedplatformworkbench"
          masterLabel="平台与商城目录"
          detailLabel="节点和商城应用详情"
          master={(
            <div className="distributedplatformdirectory">
              <header>
                <div>
                  <span>平台结构</span>
                  <strong>当前节点与承载商城</strong>
                </div>
                <Badge tone="neutral">{applications.length + 1}</Badge>
              </header>
              <div className="distributedplatformdirectoryitems">
                <p>主权节点</p>
                <MasterItem
                  selected={selection.kind === 'node'}
                  title={platformName(manifest.node_id)}
                  description={`${manifest.signed_level} · 独立运行节点`}
                  meta={manifest.node_id}
                  leading={<span className="distributedplatformnodeicon">{manifest.signed_level.slice(1)}</span>}
                  trailing={<Badge tone="success">运行中</Badge>}
                  onClick={selectNode}
                />
                <p>商城应用</p>
                {applications.length === 0 ? (
                  <div className="distributedplatformempty">当前节点尚未创建商城应用。</div>
                ) : applications.map((application) => (
                  <MasterItem
                    key={application.id}
                    selected={selection.kind === 'application' && selection.application.id === application.id}
                    title={application.name}
                    description={application.domain ?? `/${application.public_slug}`}
                    meta={application.mall_id}
                    leading={<span className="distributedplatformappicon">H5</span>}
                    trailing={<Badge tone={applicationStatusTone(application.status)}>{applicationStatusLabel(application.status)}</Badge>}
                    onClick={() => selectApplication(application)}
                  />
                ))}
              </div>
            </div>
          )}
          detail={selection.kind === 'node'
            ? <NodeDetail layout={topologyLayout} onLayoutChange={selectTopologyLayout} />
            : <ApplicationDetail application={selection.application} />}
        />
      </ResourceState>
      {createOpen ? <PlatformCreateDialog
        open
        phase={createPhase}
        context={context}
        enterprises={enterpriseScopes}
        preferredEnterpriseId={context.scope.kind === 'enterprise' || context.scope.kind === 'mall'
          ? context.scope.id : enterpriseScopes[0]?.id}
        available={createAvailable}
        sourceLevel={manifest.signed_level}
        targetLevel={nextPlatformLevel}
        challengeExpiresAt={createChallenge?.expires_at}
        error={createError}
        result={createResult}
        nodeTask={nodeTaskQuery.data}
        nodeTaskError={taskRetryError ?? (!taskReadable && createResult !== undefined
          ? '当前身份未开通平台任务读取能力' : safeQueryError(nodeTaskQuery.error))}
        taskRetryAvailable={taskRetryAvailable}
        taskRetrying={taskRetrying}
        mobileEnrollment={mobileEnrollment}
        onSubmit={(draft) => { void beginPlatformCreate(draft); }}
        onVerify={(code) => { void verifyAndCreate(code); }}
        onRelogin={() => window.location.assign(appConfig.identityEntryUrl)}
        onRetryNodeTask={() => { void retryNodeTask(); }}
        onClose={closePlatformCreate}
      /> : null}
    </section>
  );
}

function terminalNodeTask(task: AutoNodeTaskReceipt): boolean {
  return task.status === 'SUCCEEDED' || task.status === 'WAITING_EXTERNAL' || task.status === 'FAILED_RETRYABLE';
}

function PlatformMetric({ hint, label, value }: Readonly<{ hint: string; label: string; value: string }>) {
  return (
    <Surface className="distributedplatformmetric" padding="compact" radius="medium">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{hint}</small>
    </Surface>
  );
}

function NodeDetail({ layout, onLayoutChange }: Readonly<{
  layout: TopologyLayout;
  onLayoutChange: (layout: TopologyLayout) => void;
}>) {
  const manifest = appConfig.nodeManifest;
  const storefronts = manifest.domain_bindings.filter((binding) => binding.surface_ref === 'surface:storefront');
  const identity = manifest.domain_bindings.find((binding) => binding.surface_ref === 'surface:identity');
  const api = manifest.domain_bindings.find((binding) => binding.surface_ref === 'surface:api');
  const consoleBinding = manifest.domain_bindings.find((binding) => binding.surface_ref === 'surface:console');
  return (
    <div className="distributedplatformdetail">
      <header className="distributedplatformdetailheader">
        <div>
          <span>当前主权节点</span>
          <h2>{platformName(manifest.node_id)}</h2>
          <p>{manifest.node_id}</p>
        </div>
        <div className="distributedplatformdetailbadges">
          <Badge tone="info">{manifest.signed_level}</Badge>
          <Badge tone="success">独立发布</Badge>
          <Badge tone="success">独立身份域</Badge>
        </div>
      </header>

      <section className="distributedplatformsection distributedplatformtopology" aria-labelledby="nodetopologytitle">
        <header>
          <div>
            <h3 id="nodetopologytitle">节点关系</h3>
            <span>同一份真实 NodeManifest</span>
          </div>
          <div className="distributedplatformviewtoggle" role="group" aria-label="节点关系布局">
            <button type="button" aria-pressed={layout === 'tree'} onClick={() => onLayoutChange('tree')}>树状视图</button>
            <button type="button" aria-pressed={layout === 'flow'} onClick={() => onLayoutChange('flow')}>链路视图</button>
          </div>
        </header>
        <div className="distributedplatformtopologycanvas" data-layout={layout}>
          {manifest.parent_node_id === null ? null : <>
            <TopologyNode
              id={manifest.parent_node_id}
              level={parentLevel(manifest.signed_level)}
              name={platformName(manifest.parent_node_id)}
              relation="上级平台"
            />
            <span className="distributedplatformtopologyconnector" aria-hidden="true" />
          </>}
          <TopologyNode
            current
            id={manifest.node_id}
            level={manifest.signed_level}
            name={platformName(manifest.node_id)}
            relation="当前平台"
          />
        </div>
      </section>

      <section className="distributedplatformsection" aria-labelledby="nodeidentitytitle">
        <header><h3 id="nodeidentitytitle">节点身份</h3><span>NodeManifest</span></header>
        <dl className="distributedplatformfacts">
          <Fact label="父级节点" value={manifest.parent_node_id ?? '根节点'} />
          <Fact label="节点类型" value={profileLabel(manifest.node_profile)} />
          <Fact label="身份 Realm" value={manifest.realm_ref.ref} />
          <Fact label="数据范围" value={manifest.data_scope_ref.ref} />
          <Fact label="运行实例" value={manifest.runtime_instance_id} />
          <Fact label="生成时间" value={manifest.generated_at === null ? '—' : formatDate(manifest.generated_at)} />
        </dl>
      </section>

      <section className="distributedplatformsection" aria-labelledby="nodeentrytitle">
        <header><h3 id="nodeentrytitle">域名与入口</h3><span>{manifest.domain_bindings.length} 个绑定</span></header>
        <div className="distributedplatformentries">
          <Entry label="后台" host={consoleBinding?.host} />
          <Entry label="身份" host={identity?.host} />
          <Entry label="API" host={api?.host} />
          {storefronts.map((binding) => <Entry key={binding.binding_ref.ref} label="商城/H5" host={binding.host} />)}
        </div>
      </section>

      <section className="distributedplatformrelease" aria-label="发布版本">
        <div><span>发布指针</span><strong>{manifest.release_pointer_ref.ref}</strong></div>
        <div><span>制品版本</span><strong>{manifest.release_pointer_ref.source_sha.slice(0, 10)}</strong></div>
      </section>
    </div>
  );
}

function TopologyNode({ current = false, id, level, name, relation }: Readonly<{
  current?: boolean;
  id: string;
  level: string;
  name: string;
  relation: string;
}>) {
  return (
    <article className="distributedplatformtopologynode" data-current={current || undefined}>
      <div><span>{relation}</span><strong>{name}</strong><small>{id}</small></div>
      <Badge tone={current ? 'info' : 'neutral'}>{level}</Badge>
    </article>
  );
}

function ApplicationDetail({ application }: Readonly<{ application: Application }>) {
  const context = useConsoleContext();
  const navigate = useNavigate();
  return (
    <div className="distributedplatformdetail">
      <header className="distributedplatformdetailheader">
        <div>
          <span>商城应用</span>
          <h2>{application.name}</h2>
          <p>{application.id}</p>
        </div>
        <div className="distributedplatformdetailbadges">
          <Badge tone={applicationStatusTone(application.status)}>{applicationStatusLabel(application.status)}</Badge>
          <Badge tone={application.published_sequence === null || application.published_sequence === undefined ? 'warning' : 'success'}>
            {publicationLabel(application)}
          </Badge>
        </div>
      </header>

      <section className="distributedplatformsection" aria-labelledby="applicationidentitytitle">
        <header><h3 id="applicationidentitytitle">应用身份</h3><span>真实商城记录</span></header>
        <dl className="distributedplatformfacts">
          <Fact label="商城" value={application.mall_id ?? '—'} />
          <Fact label="应用代码" value={application.code} />
          <Fact label="H5 标识" value={application.public_slug} />
          <Fact label="正式域名" value={application.domain ?? '—'} />
          <Fact label="应用版本" value={`v${application.version}`} />
          <Fact label="更新时间" value={formatDate(application.updated_at)} />
        </dl>
      </section>

      <section className="distributedplatformapplicationstatus" aria-label="平台化状态">
        <div>
          <span>当前形态</span>
          <strong>商城应用</strong>
          <p>已经拥有独立商城与 H5 内容；建立独立 NodeManifest、身份入口和发布指针后，才成为完整下级平台。</p>
        </div>
        <Button tone="primary" onPress={() => { void navigate(scopePath({ kind: 'mall', id: application.mall_id ?? context.scope.id }, 'cockpit')); }}>
          进入商城工作台
        </Button>
      </section>
    </div>
  );
}

function Fact({ label, value }: Readonly<{ label: string; value: string }>) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function Entry({ host, label }: Readonly<{ host: string | undefined; label: string }>) {
  if (host === undefined) return null;
  return <div><span>{label}</span><strong>{host}</strong></div>;
}

function platformName(nodeId: string): string {
  const bindings = typeof __LK_INSTANCE_NODE_BINDINGS__ === 'undefined' ? undefined : __LK_INSTANCE_NODE_BINDINGS__;
  const displayName = bindings?.find((binding) => binding.node_id === nodeId)?.display_name;
  if (displayName !== undefined) return displayName;
  return nodeId.split(':').slice(1, -1).join(' · ') || nodeId;
}

function lifecycleLabel(value: string): string {
  if (value === 'active') return '运行中';
  if (value === 'provisioning') return '创建中';
  if (value === 'suspended') return '已停用';
  return value;
}

function profileLabel(value: string | null): string {
  if (value === null) return '—';
  if (value === 'operating_mall') return '运营平台';
  if (value === 'consumer') return '消费节点';
  return value;
}

function parentLevel(level: string): string {
  const value = Number.parseInt(level.slice(1), 10);
  return Number.isNaN(value) ? '上级' : `L${Math.max(0, value - 1)}`;
}

function nextLevel(level: string): string | undefined {
  const value = Number.parseInt(level.slice(1), 10);
  return Number.isInteger(value) && value >= 0 && value < 11 ? `L${value + 1}` : undefined;
}

function sameCreateDraft(attempt: MallCreateAttempt | undefined, draft: MallCreateDraft): attempt is MallCreateAttempt {
  return attempt !== undefined
    && attempt.enterpriseId === draft.enterpriseId.trim()
    && attempt.name === draft.name.trim()
    && attempt.code === draft.code.trim()
    && attempt.publicSlug === draft.publicSlug.trim();
}
