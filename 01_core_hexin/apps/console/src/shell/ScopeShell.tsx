import { useQueryClient } from '@tanstack/react-query';
import type { SflNodeResourceBinding } from '@shop/config/sfl-node-registry';
import { WorkspacePanelSkeleton } from '@shop/design';
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { Outlet, useLoaderData, useLocation, useMatches, useNavigate, useNavigation } from 'react-router';
import { selectConsoleNavigationItems } from '../entity/navigation/ConsoleNavigation';
import { ConsoleContextProvider } from '../entity/session/ConsoleContext';
import type { ConsoleContext } from '../entity/session/ConsoleSession';
import { scopeDisplayName, scopeKindLabel } from '../entity/session/ScopePresentation';
import { consoleModuleById, consoleModules, selectConsoleModuleByEntryPath } from '../route/ConsoleModuleRegistry';
import { deepestConsoleRouteHandle, resolveConsoleRoutePresentation } from '../route/ConsoleModuleRoutes';
import { scopeSuffix } from '../route/ProfessionalRouteCatalog';
import { buildInfo } from '../shared/config/BuildInfo';
import { requireConsoleRuntimeConfig } from '../shared/config/RuntimeConfig';
import { preloadConsoleModule, type ConsoleNavigationIntent } from '../shared/interaction/ConsoleModulePreload';
import { scopePath } from '../shared/url/ScopePath';

declare const __LK_INSTANCE_NODE_BINDINGS__: readonly Pick<SflNodeResourceBinding, 'node_id' | 'brand_name'>[] | undefined;

const LazyHeader = lazy(async () => {
  const { Header } = await import('../components/Header');
  return { default: Header };
});

const LazySidebar = lazy(async () => {
  const { Sidebar } = await import('../components/Sidebar');
  return { default: Sidebar };
});

const LazyAccessDeniedActionsProvider = lazy(async () => {
  const { AccessDeniedActionsProvider } = await import('@shop/design/access-denied');
  return { default: AccessDeniedActionsProvider };
});

const LazyEngineeringWorkspace = lazy(async () => {
  const { Component } = await import('../feature/engineering/EngineeringWorkspaceRoute');
  return { default: Component };
});

export function ScopeShell() {
  const context = useLoaderData<ConsoleContext>();
  const location = useLocation();
  const matches = useMatches();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const queryClient = useQueryClient();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [logoutState, setLogoutState] = useState<'idle' | 'pending' | 'error'>('idle');
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    readVisualPreference('zhudatuan_console_theme', ['light', 'dark'], 'light'));
  const [density, setDensity] = useState<'comfortable' | 'compact'>(() =>
    readVisualPreference('zhudatuan_console_density', ['comfortable', 'compact'], 'comfortable'));
  const handle = deepestConsoleRouteHandle(matches);
  const activeModule = handle === undefined ? undefined : consoleModuleById.get(handle.moduleId);
  const presentation = handle === undefined
    ? undefined
    : resolveConsoleRoutePresentation(handle.presentation, context.scope.kind);
  const currentSuffix = scopeSuffix(location.pathname);
  const profileRoute = currentSuffix === 'settings/profile';
  const routeTitle = profileRoute ? '个人信息' : presentation?.title ?? '页面不存在';
  const routeSummary = profileRoute ? '查看当前账户、身份、权限与管理范围' : presentation?.summary ?? '该地址不属于 Console 路由清单';
  const instanceBindings = typeof __LK_INSTANCE_NODE_BINDINGS__ === 'undefined' ? undefined : __LK_INSTANCE_NODE_BINDINGS__;
  const instanceNodeId = instanceBindings === undefined ? undefined : requireConsoleRuntimeConfig().nodeManifest.node_id;
  const instanceBinding = instanceBindings?.find((binding) => binding.node_id === instanceNodeId);
  const brandName = instanceBinding?.brand_name ?? '主打团';
  const brandSubtitle = '运营管理后台';
  const activeRoute = profileRoute ? 'profile' : activeModule?.id;
  const navigationItems = selectConsoleNavigationItems(consoleModules, context.scope.kind, context.session.capabilities);
  const mainNavigationItems = navigationItems.filter(({ placement }) => placement === 'main');
  const bottomNavigationItems = navigationItems.filter(({ placement }) => placement === 'bottom');

  useEffect(() => {
    document.documentElement.dataset.consoleTheme = theme;
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.swTheme = theme;
    document.documentElement.classList.toggle('dark', theme === 'dark');
    try { window.localStorage.setItem('zhudatuan_console_theme', theme); } catch { /* Keep the current page preference. */ }
  }, [theme]);

  useEffect(() => {
    document.documentElement.dataset.density = density;
    try { window.localStorage.setItem('zhudatuan_console_density', density); } catch { /* Keep the current page preference. */ }
  }, [density]);
  const logout = async () => {
    setLogoutState('pending');
    try {
      const [{ consoleCommand, consoleRequest, identitySessionDelete, identitySessionRead }, { appConfig }] = await Promise.all([
        import('../shared/api/Client'),
        import('../shared/config/AppConfig'),
      ]);
      const liveSession = await identitySessionRead({}, consoleRequest(undefined));
      const liveCsrf = liveSession !== undefined && typeof liveSession.csrf === 'string' ? liveSession.csrf : undefined;
      await identitySessionDelete({}, consoleCommand(undefined, {
        accessVersion: context.session.accessVersion,
        ...(liveCsrf === undefined ? {} : { csrfToken: liveCsrf }),
      }));
      queryClient.clear();
      window.location.assign(appConfig.identityEntryUrl);
    } catch {
      setLogoutState('error');
    }
  };

  useEffect(() => {
    document.title = `${routeTitle} · ${brandName}`;
    setMobileOpen(false);
    let observer: MutationObserver | undefined;
    const focusRouteHeading = () => {
      const heading = document.querySelector<HTMLElement>('.workspacebody h1');
      if (heading === null) return false;
      heading.setAttribute('tabindex', '-1');
      heading.focus({ preventScroll: true });
      return true;
    };
    const frame = requestAnimationFrame(() => {
      if (focusRouteHeading()) return;
      const workspace = document.querySelector<HTMLElement>('.workspacebody');
      if (workspace === null) return;
      observer = new MutationObserver(() => {
        if (focusRouteHeading()) observer?.disconnect();
      });
      observer.observe(workspace, { childList: true, subtree: true });
    });
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [brandName, location.pathname, routeTitle]);

  const navigateAfterCancel = (target: string) => {
    void queryClient.cancelQueries({ queryKey: ['console'], type: 'active' });
    void navigate(target);
  };
  const prepareMembers = useCallback(() => {
    if (context.scope.kind !== 'mall' || !context.session.capabilities.includes('member.members.read')) return;
    void import('../feature/member/MemberPrefetch').then(({ prefetchMembers }) =>
      prefetchMembers(queryClient, context));
  }, [context, queryClient]);
  const prepareProducts = useCallback(() => {
    if (!context.session.capabilities.includes('catalog.listings.read')) return Promise.resolve();
    return Promise.all([
      import('../feature/product/ProductCatalogRoute'),
      import('../feature/product/ProductPrefetch').then(({ prefetchProducts }) =>
        prefetchProducts(queryClient, context)),
    ]).then(() => undefined);
  }, [context, queryClient]);
  const prepareApplications = useCallback(() => {
    if (!context.session.capabilities.includes('experience.applications.read')) return Promise.resolve();
    return import('../feature/application/ApplicationPrefetch').then(({ prefetchApplications }) =>
      prefetchApplications(queryClient, context));
  }, [context, queryClient]);
  const prepareOrders = useCallback(() => {
    if (!context.session.capabilities.includes('order.orders.read')) return Promise.resolve();
    return import('../feature/order/OrderPrefetch').then(({ prefetchOrders }) =>
      prefetchOrders(queryClient, context));
  }, [context, queryClient]);
  const prepareFinance = useCallback(() => {
    if (!context.session.capabilities.includes('finance.overview.read')
      && !context.session.capabilities.includes('finance.reconciliations.read')) return Promise.resolve();
    return import('../feature/finance/FinancePrefetch').then(({ prefetchFinance }) =>
      prefetchFinance(queryClient, context));
  }, [context, queryClient]);
  const prepareSupplyChain = useCallback(() => {
    if (!context.session.capabilities.includes('catalog.listings.read')) return Promise.resolve();
    return import('../feature/supply-chain/SupplyChainPrefetch').then(({ prefetchSupplyChain }) =>
      prefetchSupplyChain(queryClient, context));
  }, [context, queryClient]);
  const prepareSupport = useCallback(() => {
    if (!context.session.capabilities.includes('support.cases.read')) return Promise.resolve();
    return import('../feature/support/SupportPrefetch').then(({ prefetchSupport }) =>
      prefetchSupport(queryClient, context));
  }, [context, queryClient]);
  const openRoute = (suffix: string) => {
    setMobileOpen(false);
    const preferredScopeKind = selectConsoleModuleByEntryPath(suffix)?.navigation.preferredScopeKind;
    const targetScope = preferredScopeKind !== undefined && context.scope.kind !== preferredScopeKind
      ? context.scopes.find((scope) => scope.kind === preferredScopeKind) ?? context.scope
      : context.scope;
    navigateAfterCancel(scopePath(targetScope, suffix));
  };
  const prepareRoute = useCallback((moduleId: Parameters<typeof preloadConsoleModule>[0], intent: ConsoleNavigationIntent) => {
    void preloadConsoleModule(moduleId, intent)?.catch(() => undefined);
    if (moduleId === 'access') prepareMembers();
    if (moduleId === 'products') void prepareProducts();
    if (moduleId === 'applications') void prepareApplications();
    if (moduleId === 'orders') void prepareOrders();
    if (moduleId === 'finance') void prepareFinance();
    if (moduleId === 'supply-chain') void prepareSupplyChain();
    if (moduleId === 'support') void prepareSupport();
  }, [prepareApplications, prepareFinance, prepareMembers, prepareOrders, prepareProducts, prepareSupplyChain, prepareSupport]);

  const selectScope = (value: string) => {
    const next = context.scopes.find((scope) => `${scope.kind}:${scope.id}` === value);
    if (next !== undefined) navigateAfterCancel(`${scopePath(next, currentSuffix || 'cockpit')}${location.search}`);
  };
  const scopeLabel = `${scopeKindLabel(context.scope.kind)} · ${scopeDisplayName(context.scope)}`;
  const selectedPeriod = new URLSearchParams(location.search).get('period') ?? '30days';
  const selectPeriod = (period: string) => {
    const search = new URLSearchParams(location.search);
    search.set('period', period);
    navigateAfterCancel(`${location.pathname}?${search.toString()}${location.hash}`);
  };
  const controlContext = activeModule?.id === 'control';
  const showScopePicker = () => {
    const picker = document.querySelector<HTMLSelectElement>('#consolescope');
    picker?.focus();
    if (picker !== null && typeof picker.showPicker === 'function') picker.showPicker();
  };
  const accessDeniedActions = {
    ...(context.scopes.length > 1 ? { onSwitchScope: showScopePicker } : {}),
    onReturnToWorkspace: () => navigateAfterCancel(scopePath(context.scope, 'cockpit')),
    onRelogin: () => {
      void import('../shared/config/AppConfig').then(({ appConfig }) => {
        window.location.assign(appConfig.identityEntryUrl);
      });
    },
  };

  return (
    <ConsoleContextProvider value={context}>
      <div className="consolelayout" data-visual-theme="zhudatuan-console-v2" data-visual-geometry="micro-straight" data-route={activeRoute}
        data-console-theme={theme} data-theme={theme} data-density={density}
        data-sidebar={collapsed ? 'collapsed' : 'expanded'} data-mobile-nav={mobileOpen ? 'open' : 'closed'}>
        <Suspense fallback={<header className="consoleheader" aria-hidden="true" />}>
          <LazyHeader title={routeTitle} summary={routeSummary} scopeLabel={scopeLabel}
            displayName={context.profile.display_name} assuranceLevel={context.session.assurance.level} syncedAt={context.session.syncedAt}
            loggingOut={logoutState === 'pending'} onLogout={() => { void logout(); }}
            onOpenNavigation={() => setMobileOpen(true)}
            onOpenProfile={() => openRoute('settings/profile')}
            brandName={brandName} brandSubtitle={brandSubtitle}
            theme={theme} density={density} onThemeToggle={() => setTheme((value) => value === 'light' ? 'dark' : 'light')}
            onDensityChange={setDensity}
            scopeControl={<>
              <label className="sr-only" htmlFor="consolescope">当前数据范围</label>
              <select id="consolescope" value={`${context.scope.kind}:${context.scope.id}`} onChange={(event) => selectScope(event.target.value)}>
                {context.scopes.map((scope) => <option key={`${scope.kind}:${scope.id}`} value={`${scope.kind}:${scope.id}`}>
                  {scopeKindLabel(scope.kind)} · {scopeDisplayName(scope)}
                </option>)}
              </select>
            </>}
            {...(logoutState === 'error' ? { logoutError: '退出失败，请重试。' } : {})} />
        </Suspense>
        <Suspense fallback={<aside className={`consolesidebar${collapsed ? ' iscollapsed' : ''}`} aria-hidden="true" />}>
          <LazySidebar active={activeRoute} collapsed={collapsed} mainItems={mainNavigationItems} bottomItems={bottomNavigationItems}
            displayName={context.profile.display_name} roleLabel={scopeLabel} brandName={brandName} brandSubtitle={brandSubtitle}
            onNavigate={openRoute}
            onNavigateIntent={prepareRoute}
            onOpenProfile={() => openRoute('settings/profile')}
            onToggle={() => setCollapsed((value) => !value)} />
        </Suspense>
        <button className="mobilebackdrop" type="button" onClick={() => setMobileOpen(false)} aria-label="关闭主导航" />
        <div className="consoleworkspace">
          <div className="scopebar">
            <div className="scopepagetitle"><span>{brandName} / {scopeDisplayName(context.scope)}</span><strong>{routeTitle}</strong></div>
            <div className="scopecontext">
              {controlContext ? <span>{context.scope.id === 'platform:preview' ? '本地预览' : scopeKindLabel(context.scope.kind)}</span> : null}
              {controlContext ? <i aria-hidden="true">·</i> : null}
              {controlContext ? <span>AAL{context.session.assurance.level}</span> : <>
                <label className="sr-only" htmlFor="consoleperiod">统计周期</label>
                <select id="consoleperiod" value={selectedPeriod} onChange={(event) => selectPeriod(event.target.value)}>
                  <option value="7days">近 7 天</option><option value="30days">近 30 天</option><option value="90days">近 90 天</option>
                </select>
              </>}
            </div>
            <div className="scopestatus">
              <span className="scopenavigationstatus" role="status" aria-live="polite"
                data-visible={navigation.state === 'idle' ? 'false' : 'true'}>
                {navigation.state === 'idle' ? '' : '正在切换内容…'}
              </span>
              <span>{controlContext ? '状态评估于' : '数据更新于'} {formatRailTime(context.session.syncedAt)}</span>
            </div>
          </div>
          <main className="workspacebody" aria-busy={navigation.state !== 'idle'}>
            {activeModule?.id === 'cockpit' ? <Outlet /> : (
              <Suspense fallback={<WorkspaceRouteLoading moduleId={activeModule?.id} />}>
                <LazyAccessDeniedActionsProvider actions={accessDeniedActions}>
                  {activeModule?.id === 'engineering' ? <LazyEngineeringWorkspace /> : <Outlet />}
                </LazyAccessDeniedActionsProvider>
              </Suspense>
            )}
          </main>
          <footer className="consolefooter">
            <span data-testid="console-build-info" title={buildInfo.detailLabel}>{buildInfo.footerLabel} · © 2026 {brandName}运营系统 · 节点: {context.scope.id === 'platform:preview' ? 'LOCAL-PREVIEW' : 'BJ-01-PROD'}</span>
            <span className="consolefooterstatus"><i aria-hidden="true" />控制台页面已加载</span>
            <code>AI 调用需服务端授权</code>
          </footer>
        </div>
      </div>
    </ConsoleContextProvider>
  );
}

export function WorkspaceRouteLoading({ moduleId }: Readonly<{ moduleId: string | undefined }>) {
  const supplyChain = moduleId === 'supply-chain';
  if (moduleId === 'engineering') return <WorkspacePanelSkeleton className="engineeringrouteskeleton"
    label="正在准备工程中心内容…" />;
  if (moduleId === 'access') return <WorkspacePanelSkeleton className="memberaccessrouteskeleton"
    label="正在准备成员与权限数据…" cards={6} />;
  if (moduleId === 'qualification') return <WorkspacePanelSkeleton className="qualificationrouteskeleton"
    label="正在准备资格与通知数据…" cards={5} />;
  return <section className="workspacerouteloading" role="status" aria-live="polite">
    <span className="workspacerouteloadingicon" aria-hidden="true" />
    <strong>{supplyChain ? '正在打开供应链管理…' : '正在打开工作台…'}</strong>
    <small>{supplyChain ? '正在准备供货伙伴、商品和库存数据' : '正在准备页面内容'}</small>
  </section>;
}

function formatRailTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '--:--'
    : `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function readVisualPreference<Value extends string>(key: string, choices: readonly Value[], fallback: Value): Value {
  try {
    const saved = window.localStorage.getItem(key);
    return choices.find((choice) => choice === saved) ?? fallback;
  } catch {
    return fallback;
  }
}
