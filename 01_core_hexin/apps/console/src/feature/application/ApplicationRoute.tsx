import { Button, ResourcePanel, ResourceState } from '@shop/design';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useConsoleContext } from '../../entity/session/ConsoleContext';
import { queryCondition, safeQueryError } from '../../shared/api/QueryState';
import { pageCursor } from '../../shared/url/PageCursor';
import { scopePath } from '../../shared/url/ScopePath';
import { applicationCommandAvailable } from './ApplicationCommand';
import { ApplicationCopyDialog, ApplicationCreateDialog, ApplicationDisableDialog, ApplicationEditDialog, ApplicationRecordDrawer, CommerceFlowPreview } from './ApplicationDialogs';
import { applicationSummary, commerceFlow, needsAttention } from './ApplicationPresentation';
import { applicationKey, applicationRootKey, readApplications } from './ApplicationQuery';
import { APPLICATION_PREFETCH_STALE_TIME_MS } from './ApplicationPrefetch';
import type { Application } from './ApplicationSchema';
import { applicationScopePresentation, type CommerceWorkspaceMode } from './ApplicationScope';
import { ApplicationTable } from './ApplicationTable';
import { CommerceSolutionCenter, commerceSolutionName, readCommerceSolution, type CommerceSolutionId } from './CommerceSolutionCenter';
import {
  canCreateMall,
  completeMallCreateStepup,
  createMall,
  isMallMobileMissing,
  isMallStepupRequired,
  mallCreationError,
  mallCreationRequiresStepup,
  mallMobileEnrollmentRequired,
  mallEnterpriseScopes,
  mallProvisioningScope,
  newMallCreateAttempt,
  startMallCreateStepup,
  type CreatedMall,
  type MallCreateAttempt,
  type MallCreateDraft,
  type MallStepupChallenge,
} from './MallCreateCommand';
import { MallCreateDialog, type MallCreatePhase } from './MallCreateDialog';
import { InstanceLifecycle } from './InstanceLifecycle';
import { appConfig } from '../../shared/config/AppConfig';
import './application-workspace.css';
import './application-table.css';
import './application-dialogs.css';
import './application-responsive.css';
import './commerce-solution-center.css';

type CommerceView = 'all' | 'published' | 'drafts' | 'attention';
type ApplicationDialogState = Readonly<{ kind: 'create' }> | Readonly<{ kind: 'edit' | 'copy' | 'disable'; record: Application }>;

const views: readonly Readonly<{ key: CommerceView; label: string }>[] = Object.freeze([
  { key: 'all', label: '全部商城应用' },
  { key: 'published', label: '已发布' },
  { key: 'drafts', label: '开店与装修草稿' },
  { key: 'attention', label: '需要处理' },
]);

export function Component() {
  const context = useConsoleContext();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const [flowOpen, setFlowOpen] = useState(false);
  const [solutionOpen, setSolutionOpen] = useState(false);
  const [command, setCommand] = useState<ApplicationDialogState>();
  const [commandNotice, setCommandNotice] = useState<string>();
  const [mallCreateOpen, setMallCreateOpen] = useState(false);
  const [mallCreatePhase, setMallCreatePhase] = useState<MallCreatePhase>('form');
  const [mallCreateError, setMallCreateError] = useState<string>();
  const [mallCreateAttempt, setMallCreateAttempt] = useState<MallCreateAttempt>();
  const [mallCreateChallenge, setMallCreateChallenge] = useState<MallStepupChallenge>();
  const [mallCreateResult, setMallCreateResult] = useState<CreatedMall>();
  const [mallStepupCompleted, setMallStepupCompleted] = useState(false);
  const [mallMobileEnrollment, setMallMobileEnrollment] = useState(false);
  const presentation = applicationScopePresentation(context.scope.kind);
  const provisioningScope = mallProvisioningScope(context);
  const enterpriseScopes = mallEnterpriseScopes(context);
  const mallCreateAvailable = canCreateMall(context, provisioningScope);
  const cursor = search.get('cursor') ?? undefined;
  const query = useQuery({
    queryKey: applicationKey(context, cursor),
    queryFn: ({ signal }) => readApplications(context, cursor, signal),
    staleTime: APPLICATION_PREFETCH_STALE_TIME_MS,
  });
  const data = query.data;
  const condition = queryCondition({
    pending: query.isPending,
    fetching: query.isFetching,
    error: query.error,
    hasData: data !== undefined,
    empty: false,
    stale: query.isStale,
  });
  const error = safeQueryError(query.error);
  const view = readView(search.get('view'));
  const selectedSolution = readSolution(search);
  const q = (search.get('q') ?? '').trim().toLowerCase();
  const selectedId = search.get('selected') ?? undefined;
  const records = useMemo(() => presentation.mode === 'management'
    ? (data?.items ?? []).filter((record) => record.mall_id !== null && record.mall_id !== undefined)
    : (data?.items ?? []), [data?.items, presentation.mode]);
  const selected = records.find((record) => record.id === selectedId);
  const rows = useMemo(() => records.filter((record) => matchesView(record, view)
    && (q === '' || searchable(record).includes(q))), [q, records, view]);
  const summary = useMemo(() => applicationSummary(records), [records]);
  const flow = commerceFlow(presentation.mode);

  const updateSearch = useCallback(
    (mutate: (next: URLSearchParams) => void) => {
      const next = new URLSearchParams(search);
      mutate(next);
      setSearch(next);
    },
    [search, setSearch]
  );
  const selectView = (nextView: CommerceView) =>
    updateSearch((next) => {
      if (nextView === 'all') next.delete('view');
      else next.set('view', nextView);
      next.delete('cursor');
      next.delete('selected');
    });
  const updateQuery = (value: string) =>
    updateSearch((next) => {
      if (value === '') next.delete('q');
      else next.set('q', value);
      next.delete('cursor');
      next.delete('selected');
    });
  const openRecord = useCallback(
    (record: Application) => {
      setCommand(undefined);
      setFlowOpen(false);
      setSolutionOpen(false);
      updateSearch((next) => next.set('selected', record.id));
    },
    [updateSearch]
  );
  const closeRecord = useCallback(() => {
    if (selectedId === undefined) return;
    updateSearch((next) => next.delete('selected'));
  }, [selectedId, updateSearch]);
  const openCommand = useCallback(
    (next: ApplicationDialogState) => {
      closeRecord();
      setFlowOpen(false);
      setSolutionOpen(false);
      setCommandNotice(undefined);
      setCommand(next);
    },
    [closeRecord]
  );
  const openEdit = useCallback((record: Application) => openCommand({ kind: 'edit', record }), [openCommand]);
  const openCopy = useCallback((record: Application) => openCommand({ kind: 'copy', record }), [openCommand]);
  const openDisable = useCallback((record: Application) => openCommand({ kind: 'disable', record }), [openCommand]);
  const openWorkspace = useCallback((record: Application) => {
    if (record.mall_id === null || record.mall_id === undefined) return;
    navigate(scopePath({ kind: 'mall', id: record.mall_id }, 'cockpit'));
  }, [navigate]);
  const closeCommand = useCallback(() => setCommand(undefined), []);
  const completeCommand = useCallback(
    async (notice: string) => {
      setCommand(undefined);
      setCommandNotice(notice);
      const next = new URLSearchParams(search);
      next.delete('cursor');
      next.delete('selected');
      setSearch(next);
      await queryClient.invalidateQueries({ queryKey: applicationRootKey(context) });
    },
    [context, queryClient, search, setSearch]
  );

  const closeMallCreate = () => {
    if (mallCreatePhase === 'starting' || mallCreatePhase === 'verifying' || mallCreatePhase === 'creating') return;
    setMallCreateOpen(false);
    setMallCreatePhase('form');
    setMallCreateError(undefined);
    setMallCreateAttempt(undefined);
    setMallCreateChallenge(undefined);
    setMallCreateResult(undefined);
    setMallStepupCompleted(false);
    setMallMobileEnrollment(false);
  };

  const openMallCreate = () => {
    closeRecord();
    setCommand(undefined);
    setSolutionOpen(false);
    setFlowOpen(false);
    setMallCreateError(undefined);
    setMallCreatePhase('form');
    setMallMobileEnrollment(mallMobileEnrollmentRequired(context));
    setMallCreateOpen(true);
  };

  const openPrimaryAction = () => {
    if (presentation.mode === 'management') {
      openMallCreate();
      return;
    }
    closeRecord();
    setCommand(undefined);
    setSolutionOpen(false);
    setFlowOpen(true);
  };

  const requestMallStepup = async (attempt: MallCreateAttempt) => {
    if (provisioningScope === undefined) {
      setMallCreateError(mallCreationError(new Error('MALL_CREATE_NOT_AVAILABLE')));
      setMallCreatePhase('form');
      return;
    }
    setMallCreatePhase('starting');
    try {
      const challenge = await startMallCreateStepup(context, provisioningScope);
      setMallCreateAttempt(attempt);
      setMallCreateChallenge(challenge);
      setMallCreatePhase('verification');
    } catch (cause) {
      if (isMallMobileMissing(cause)) {
        setMallCreateError(undefined);
        setMallCreatePhase('form');
        setMallMobileEnrollment(true);
        return;
      }
      setMallCreateError(mallCreationError(cause));
      setMallCreatePhase('form');
    }
  };

  const provisionMall = async (attempt: MallCreateAttempt) => {
    if (provisioningScope === undefined) {
      setMallCreateError(mallCreationError(new Error('MALL_CREATE_NOT_AVAILABLE')));
      setMallCreatePhase('form');
      return;
    }
    setMallCreatePhase('creating');
    try {
      const result = await createMall(context, provisioningScope, attempt);
      setMallCreateResult(result);
      setMallCreateError(undefined);
      setMallCreatePhase('success');
      await queryClient.invalidateQueries({ queryKey: applicationRootKey(context) });
    } catch (cause) {
      if (isMallStepupRequired(cause)) {
        setMallStepupCompleted(false);
        await requestMallStepup(attempt);
        return;
      }
      setMallCreateError(mallCreationError(cause));
      setMallCreatePhase('form');
    }
  };

  const beginMallCreate = async (draft: MallCreateDraft) => {
    if (!mallCreateAvailable || provisioningScope === undefined) {
      setMallCreateError(mallCreationError(new Error('MALL_CREATE_NOT_AVAILABLE')));
      return;
    }
    setMallCreateError(undefined);
    const attempt = sameMallDraft(mallCreateAttempt, draft) ? mallCreateAttempt : newMallCreateAttempt(draft);
    setMallCreateAttempt(attempt);
    if (mallMobileEnrollmentRequired(context)) {
      setMallCreatePhase('form');
      setMallMobileEnrollment(true);
      return;
    }
    if (mallCreationRequiresStepup(context) && !mallStepupCompleted) {
      await requestMallStepup(attempt);
      return;
    }
    await provisionMall(attempt);
  };

  const verifyAndCreateMall = async (code: string) => {
    if (provisioningScope === undefined || mallCreateChallenge === undefined || mallCreateAttempt === undefined) return;
    setMallCreateError(undefined);
    setMallCreatePhase('verifying');
    try {
      await completeMallCreateStepup(context, provisioningScope, mallCreateChallenge.id, code);
      setMallStepupCompleted(true);
      setMallCreateChallenge(undefined);
      await provisionMall(mallCreateAttempt);
    } catch (cause) {
      setMallCreateError(mallCreationError(cause));
      setMallCreatePhase('verification');
    }
  };

  const canCreate = applicationCommandAvailable(context, 'experience.applications.create');
  const canUpdate = applicationCommandAvailable(context, 'experience.applications.update');
  const canCopy = applicationCommandAvailable(context, 'experience.applications.copy');
  const scopeName = context.scope.name ?? context.scope.id;

  if (condition === 'unauthenticated' || condition === 'denied') {
    return (
      <div className="commerceworkspace" data-mode={presentation.mode}>
        <ResourceState
          condition={condition}
          resourceLabel={presentation.title}
          {...(error === undefined ? {} : { error })}
          retry={() => {
            void query.refetch();
          }}
        >
          <span />
        </ResourceState>
      </div>
    );
  }

  return (
    <div className="commerceworkspace" data-mode={presentation.mode}>
      <ResourcePanel
        title={presentation.title}
        eyebrow={presentation.eyebrow}
        description={presentation.description}
        condition={condition}
        {...(error === undefined ? {} : { error })}
        retry={() => {
          void query.refetch();
        }}
        actions={
          <>
            <Button
              onPress={() => {
                closeRecord();
                setFlowOpen(false);
                setSolutionOpen(true);
              }}
            >
              建店方案（3 套）
            </Button>
            <Button tone="primary" onPress={openMallCreate}>
              创建商城
            </Button>
            {presentation.mode === 'management' ? null : (
              <Button tone="primary" isDisabled={!canCreate} onPress={() => openCommand({ kind: 'create' })}>
                新建应用
              </Button>
            )}
            {presentation.mode === 'management'
              ? null
              : <Button onPress={openPrimaryAction}>{presentation.primaryAction}</Button>}
          </>
        }
      >
        <div className="commercecontent">
          {context.scope.kind === 'platform' && provisioningScope ? <InstanceLifecycle context={context} scope={provisioningScope} /> : null}
          {commandNotice === undefined ? null : (
            <p className="commercefiltermeta" role="status">
              {commandNotice}
            </p>
          )}
          <section className="commerceownership" role="note">
            <span aria-hidden="true">域</span>
            <div>
              <strong>
                {presentation.ownership}：{scopeName}
              </strong>
              <p>{presentation.ownershipDetail}</p>
            </div>
            <button className="commercevitheme" type="button" onClick={() => setSolutionOpen(true)}>
              预览方案 · {commerceSolutionName(selectedSolution)} <i aria-hidden="true">›</i>
            </button>
          </section>
          <section className="commercesummary" aria-label="商城与应用读模型摘要">
            {summary.map((metric) => (
              <article key={metric.label} className={`is-${metric.tone}`}>
                <span>{metric.label}</span>
                <strong>{metric.value}</strong>
                <small>{metric.hint}</small>
              </article>
            ))}
          </section>
          <section className="commerceboundarybanner" role="note">
            <span aria-hidden="true">!</span>
            <div>
              <strong>{presentation.mode === 'management' ? '商城创建发动机已接通' : '高风险写操作继续关闭'}</strong>
              <p>{boundaryMessage(presentation.mode)}</p>
            </div>
            <button type="button" onClick={() => setFlowOpen(true)}>
              查看安全流程
            </button>
          </section>
          <ol className="commerceflow" aria-label={`${presentation.title}业务闭环`}>
            {flow.map((step, index) => (
              <li key={step.label}>
                <span>{index + 1}</span>
                <div>
                  <strong>{step.label}</strong>
                  <small>{step.detail}</small>
                </div>
              </li>
            ))}
          </ol>
          <section className="commerceboard" aria-labelledby="commerceboardtitle">
            <nav className="commercetabs" aria-label="商城与应用状态视图">
              {views.map((candidate) => (
                <button key={candidate.key} type="button" aria-pressed={candidate.key === view} onClick={() => selectView(candidate.key)}>
                  {candidate.label}
                </button>
              ))}
            </nav>
            <div className="commercefilterbar">
              <div>
                <strong id="commerceboardtitle">{presentation.mode === 'management' ? '商城清单' : '商城应用清单'}</strong>
                <span>商城身份、应用、商品池、草稿与发布状态来自同一权威读模型</span>
              </div>
              <label className="commercesearch">
                <span className="sr-only">搜索商城应用</span>
                <input type="search" value={search.get('q') ?? ''} onChange={(event) => updateQuery(event.target.value)} placeholder="搜索名称、代码、商城或域名" />
              </label>
            </div>
            <p className="commercefiltermeta">
              当前页筛选 · 显示 {rows.length} / {records.length} 条 · 不推断未返回的商城总量
            </p>
            {data !== undefined && records.length === 0 ? (
              <section className="commerceempty" role="status">
                <strong>{presentation.mode === 'management' ? '当前范围暂无商城' : '当前范围暂无商城应用'}</strong>
                <p>{presentation.mode === 'management' ? '点击“创建商城”，即可建立第一家独立商城。' : '切换数据范围或刷新后再查看。'}</p>
              </section>
            ) : null}
            {data !== undefined && records.length > 0 && rows.length === 0 ? (
              <section className="commerceempty" role="status">
                <strong>当前页没有匹配记录</strong>
                <p>调整状态视图或搜索词即可恢复列表。</p>
                <button type="button" onClick={() => clearFilters(search, setSearch)}>
                  清除筛选
                </button>
              </section>
            ) : null}
            {rows.length > 0 ? <ApplicationTable rows={rows} mode={presentation.mode} canEdit={canUpdate} canCopy={canCopy} onEnter={openWorkspace} onOpen={openRecord} onEdit={openEdit} onCopy={openCopy} onDisable={openDisable} /> : null}
            <footer className="commercepagination">
              <span>当前页 {records.length} 家商城 · 游标分页</span>
              <Button
                onPress={() => {
                  if (data?.nextCursor !== undefined) setSearch(pageCursor(search, data.nextCursor));
                }}
                isDisabled={data?.nextCursor === undefined}
              >
                下一页
              </Button>
            </footer>
          </section>
        </div>
      </ResourcePanel>
      <ApplicationRecordDrawer record={selected} canEdit={canUpdate} canCopy={canCopy} onEnter={openWorkspace} onEdit={openEdit} onCopy={openCopy} onDisable={openDisable} onClose={closeRecord} />
      {command?.kind === 'create' ? <ApplicationCreateDialog context={context} onClose={closeCommand} onSuccess={completeCommand} /> : null}
      {command?.kind === 'edit' ? <ApplicationEditDialog context={context} record={command.record} onClose={closeCommand} onSuccess={completeCommand} /> : null}
      {command?.kind === 'copy' ? <ApplicationCopyDialog context={context} record={command.record} onClose={closeCommand} onSuccess={completeCommand} /> : null}
      {command?.kind === 'disable' ? <ApplicationDisableDialog context={context} record={command.record} onClose={closeCommand} onSuccess={completeCommand} /> : null}
      {mallCreateOpen ? <MallCreateDialog open phase={mallCreatePhase} enterprises={enterpriseScopes}
        preferredEnterpriseId={context.scope.kind === 'enterprise' || context.scope.kind === 'mall'
          ? context.scope.id : enterpriseScopes[0]?.id}
        available={mallCreateAvailable} challengeExpiresAt={mallCreateChallenge?.expires_at}
        error={mallCreateError} result={mallCreateResult} context={context} mobileEnrollment={mallMobileEnrollment}
        onSubmit={(draft) => { void beginMallCreate(draft); }} onVerify={(code) => { void verifyAndCreateMall(code); }}
        onRelogin={() => window.location.assign(appConfig.identityEntryUrl)}
        onClose={closeMallCreate} /> : null}
      <CommerceFlowPreview open={flowOpen} presentation={presentation} onClose={() => setFlowOpen(false)} />
      <CommerceSolutionCenter
        open={solutionOpen}
        selected={selectedSolution}
        onSelect={(solution) =>
          updateSearch((next) => {
            next.set('solution', solution);
            next.delete('theme');
          })
        }
        onClose={() => setSolutionOpen(false)}
      />
    </div>
  );
}

function readView(value: string | null): CommerceView {
  return views.some((view) => view.key === value) ? (value as CommerceView) : 'all';
}

function readSolution(search: URLSearchParams): CommerceSolutionId {
  return readCommerceSolution(search.get('solution') ?? search.get('theme'));
}

function matchesView(row: Application, view: CommerceView): boolean {
  if (view === 'published') return row.published_sequence !== null && row.published_sequence !== undefined;
  if (view === 'drafts') return row.head_sequence !== null && row.head_sequence !== undefined && row.head_sequence !== row.published_sequence;
  if (view === 'attention') return needsAttention(row);
  return true;
}

function searchable(row: Application): string {
  return `${row.name} ${row.code} ${row.public_slug} ${row.mall_id ?? ''} ${row.pool_id ?? ''} ${row.domain ?? ''}`.toLowerCase();
}

function boundaryMessage(mode: CommerceWorkspaceMode): string {
  if (mode === 'management') return '平台一次建立商城身份、组织关系、独立商品池、商城应用和开店草稿；失败不会留下半成品。';
  if (mode === 'design') return '保存、校验、预览、发布与恢复需完整 expectedVersion / proof 旅程；当前页面只读取权威状态。';
  return '平台可查看准入与异常，但正式审批必须进入系统治理并与商户权限隔离。';
}

function sameMallDraft(attempt: MallCreateAttempt | undefined, draft: MallCreateDraft): attempt is MallCreateAttempt {
  return attempt !== undefined
    && attempt.enterpriseId === draft.enterpriseId.trim()
    && attempt.name === draft.name.trim()
    && attempt.code === draft.code.trim()
    && attempt.publicSlug === draft.publicSlug.trim();
}

function clearFilters(search: URLSearchParams, setSearch: ReturnType<typeof useSearchParams>[1]) {
  const next = new URLSearchParams(search);
  next.delete('q');
  next.delete('view');
  next.delete('cursor');
  next.delete('selected');
  setSearch(next);
}
