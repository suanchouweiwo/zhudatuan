import type { ConsoleAppConfig } from '@shop/config/sfl-console-runtime';

interface ScopeCandidate {
  readonly kind?: string;
  readonly id?: string;
}

interface SessionCandidate {
  readonly profile?: Readonly<{ status?: string }>;
  readonly accessVersion?: number;
  readonly capabilities?: readonly string[];
  readonly permissions?: readonly string[];
  readonly scope?: ScopeCandidate;
  readonly scopes?: readonly ScopeCandidate[];
}

export interface DocumentPrefetch<T> {
  readonly settled: boolean;
  readonly promise: Promise<T | undefined>;
}

const DOCUMENT_PREFETCH_TIMEOUT = Symbol('DOCUMENT_PREFETCH_TIMEOUT');

export async function consumeDocumentPrefetch<T>(
  slot: DocumentPrefetch<T> | undefined,
  signal: AbortSignal,
  options: Readonly<{ handoffMs?: number }> = {},
): Promise<T | undefined> {
  if (slot === undefined) return undefined;
  if (signal.aborted) {
    window.__consoleAbortDocumentPrefetch?.();
    throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
  }
  let rejectAbort: (cause: unknown) => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const abort = () => {
    window.__consoleAbortDocumentPrefetch?.();
    rejectAbort(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
  };
  let timer: number | undefined;
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (slot.settled || options.handoffMs === undefined) return await Promise.race([slot.promise, aborted]);
    const value = await Promise.race([
      slot.promise,
      aborted,
      new Promise<typeof DOCUMENT_PREFETCH_TIMEOUT>((resolve) => {
        timer = window.setTimeout(() => resolve(DOCUMENT_PREFETCH_TIMEOUT), options.handoffMs);
      }),
    ]);
    if (value === DOCUMENT_PREFETCH_TIMEOUT) {
      window.__consoleAbortDocumentPrefetch?.();
      return undefined;
    }
    return value;
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

const consoleKinds = Object.freeze(['platform', 'distributor', 'tenant', 'enterprise', 'mall']);

export function startDocumentPrefetch(
  appConfig: Pick<ConsoleAppConfig, 'apiBaseUrl' | 'clientVersion'>,
): void {
  const controllers = new Set<AbortController>();
  window.__consoleAbortDocumentPrefetch = () => {
    for (const controller of controllers) controller.abort();
    controllers.clear();
  };

  const readJson = <T>(path: string, extraHeaders: Readonly<Record<string, string>> = {}): DocumentPrefetch<T> => {
    const controller = new AbortController();
    controllers.add(controller);
    const timeout = window.setTimeout(() => controller.abort(), 1_500);
    return tracked(fetch(`${appConfig.apiBaseUrl}${path}`, {
      credentials: 'include',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        'x-contract-version': '1.0.0',
        'x-client-version': appConfig.clientVersion,
        'x-trace-id': crypto.randomUUID(),
        ...extraHeaders,
      },
    }).then(async (response) => {
      if (!response.ok) return undefined;
      try { return await response.json() as T; } catch { return undefined; }
    }, () => undefined).finally(() => {
      window.clearTimeout(timeout);
      controllers.delete(controller);
    }));
  };

  const session = readJson<SessionCandidate>('/api/v1/identity/session');
  window.__consoleSessionPrefetch = tracked(session.promise.then((value) => value === undefined ? undefined : { value }));
  window.__consoleScopePrefetch = tracked(session.promise.then(async (value) => {
    if (value === undefined) return undefined;
    const roots = Array.isArray(value?.scopes) ? value.scopes.filter(isConsoleScope) : [];
    if (!Number.isInteger(value?.accessVersion) || roots.length === 0) return undefined;
    const headers = { 'x-access-version': String(value.accessVersion) };
    const profile = value.profile?.status !== undefined
      ? { promise: Promise.resolve(value.profile) }
      : readJson<unknown>('/api/v1/members/me', headers);
    const canReadLayers = Array.isArray(value.permissions) && value.permissions.includes('organization.layer.read')
      && Array.isArray(value.capabilities) && value.capabilities.includes('organization.layers.read');
    const layers = canReadLayers ? roots.map(async (scope) => ({
      scopeKind: scope.kind,
      scopeId: scope.id,
      value: await readJson<unknown>('/api/v1/organizations/layers?limit=1000', {
        ...headers,
        'x-scope-hint': scope.id,
      }).promise,
    })) : [];
    return {
      accessVersion: value.accessVersion!,
      roots: roots.map((scope) => ({ kind: scope.kind, id: scope.id })),
      profile: await profile.promise,
      layers: await Promise.all(layers),
    };
  }));
  window.__consoleCockpitPrefetch = tracked(session.promise.then((value) => {
    if (value === undefined) return undefined;
    const match = location.pathname.match(/^\/scopes\/(platform|distributor|tenant|enterprise|mall)\/([^/]+)\/cockpit\/?$/);
    let direct: Readonly<{ kind: string; id: string }> | undefined;
    try { direct = match === null ? undefined : { kind: match[1]!, id: decodeURIComponent(match[2]!) }; } catch { direct = undefined; }
    if (location.pathname !== '/' && direct === undefined) return undefined;
    const first = direct ?? (Array.isArray(value?.scopes) ? value.scopes.find(isConsoleScope) : undefined) ?? value?.scope;
    if (!isConsoleScope(first) || !Number.isInteger(value?.accessVersion)) return undefined;
    const requested = new URLSearchParams(location.search).get('period');
    const period = requested !== null && ['realtime', 'yesterday', '7days', '30days'].includes(requested) ? requested : '30days';
    return readJson<unknown>(`/api/v1/reports/dashboard?period=${period}&limit=100`, {
      'x-scope-hint': first.id,
      'x-access-version': String(value.accessVersion),
    }).promise.then((dashboard) => dashboard === undefined ? undefined : {
      scopeKind: first.kind,
      scopeId: first.id,
      accessVersion: value.accessVersion!,
      period,
      value: dashboard,
    });
  }));
  window.__consoleProductPrefetch = tracked(session.promise.then((value) => {
    if (value === undefined || !Number.isInteger(value?.accessVersion)
      || !Array.isArray(value.capabilities) || !value.capabilities.includes('catalog.listings.read')) return undefined;
    const match = location.pathname.match(/^\/scopes\/(platform|distributor|tenant|enterprise|mall)\/([^/]+)\/(products|supply-chain)\/?$/);
    let direct: Readonly<{ kind: 'platform' | 'distributor' | 'tenant' | 'enterprise' | 'mall'; id: string }> | undefined;
    try {
      const candidate = match?.[1] === undefined ? undefined : { kind: match[1], id: decodeURIComponent(match[2]!) };
      direct = isConsoleScope(candidate) ? candidate : undefined;
    } catch { direct = undefined; }
    if (direct === undefined) return undefined;
    const supplyNetwork = match?.[3] === 'supply-chain';
    const workspace = new URLSearchParams(location.search).get('workspace');
    const selectionCenter = !supplyNetwork && (workspace === 'selection' || workspace === 'pending');
    const requestedLimit = Number(new URLSearchParams(location.search).get('limit') ?? 20);
    const limit = supplyNetwork ? 1 : selectionCenter ? [20, 50, 100].includes(requestedLimit) ? requestedLimit : 20
      : [20, 50, 100].includes(requestedLimit) ? requestedLimit : 20;
    const search = new URLSearchParams(location.search);
    const preview = supplyNetwork || (direct.kind === 'platform' && direct.id === 'platform:preview');
    const query: Readonly<{
      q: string; category: string; supplier: string; mall: string; status: string;
      cursor?: string; limit: number; preview: boolean; view?: 'supply-network' | 'selection-center'; selection?: 'available';
    }> = {
      q: supplyNetwork ? '' : search.get('q') ?? '',
      category: supplyNetwork || selectionCenter ? '' : search.get('category') ?? '',
      supplier: supplyNetwork || selectionCenter ? '' : preview ? (search.get('supplier') ?? '') : '',
      mall: supplyNetwork || selectionCenter ? '' : preview ? (search.get('mall') ?? '') : '',
      status: supplyNetwork || selectionCenter ? '' : search.get('status') ?? '',
      ...(!supplyNetwork && search.get('cursor') !== null ? { cursor: search.get('cursor')! } : {}),
      limit,
      preview: selectionCenter ? false : preview,
      ...(supplyNetwork ? { view: 'supply-network' as const } : selectionCenter ? { view: 'selection-center' as const } : {}),
      ...(workspace === 'pending' ? { selection: 'available' as const } : {}),
    };
    const parameters = new URLSearchParams({ limit: String(limit) });
    if (query.q !== '') parameters.set('q', query.q);
    if (query.category !== '') parameters.set('category', query.category);
    if (query.supplier !== '') parameters.set('supplier', query.supplier);
    if (query.mall !== '') parameters.set('mall', query.mall);
    if (query.status !== '') parameters.set('status', query.status);
    if (query.cursor !== undefined) parameters.set('cursor', query.cursor);
    if (query.view !== undefined) parameters.set('view', query.view);
    if (query.selection !== undefined) parameters.set('selection', query.selection);
    return readJson<unknown>(`/api/v1/catalog/listings?${parameters.toString()}`, {
      'x-scope-hint': direct.id,
      'x-access-version': String(value.accessVersion),
    }).promise.then((products) => products === undefined ? undefined : {
      scopeKind: direct.kind,
      scopeId: direct.id,
      accessVersion: value.accessVersion!,
      query,
      value: products,
    });
  }));
  window.__consoleSupportPrefetch = tracked(session.promise.then((value) => {
    if (value === undefined || !Number.isInteger(value?.accessVersion)
      || !Array.isArray(value.capabilities) || !value.capabilities.includes('support.cases.read')) return undefined;
    const match = location.pathname.match(/^\/scopes\/(platform|distributor|tenant|enterprise|mall)\/([^/]+)\/support(?:\/[^/]+)?\/?$/);
    let direct: Readonly<{ kind: 'platform' | 'distributor' | 'tenant' | 'enterprise' | 'mall'; id: string }> | undefined;
    try {
      const candidate = match?.[1] === undefined ? undefined : { kind: match[1], id: decodeURIComponent(match[2]!) };
      direct = isConsoleScope(candidate) ? candidate : undefined;
    } catch { direct = undefined; }
    if (direct === undefined) return undefined;
    return readJson<unknown>('/api/v1/support/cases?limit=50', {
      'x-scope-hint': direct.id,
      'x-access-version': String(value.accessVersion),
    }).promise.then((cases) => cases === undefined ? undefined : {
      scopeKind: direct.kind,
      scopeId: direct.id,
      accessVersion: value.accessVersion!,
      value: cases,
    });
  }));
  const management = session.promise.then((value) => {
    if (value === undefined || !Number.isInteger(value?.accessVersion)) return undefined;
    const match = location.pathname.match(/^\/scopes\/(platform|distributor|tenant|enterprise|mall)\/([^/]+)\/settings\/(members|access)\/?$/);
    let direct: Readonly<{ kind: 'platform' | 'distributor' | 'tenant' | 'enterprise' | 'mall'; id: string }> | undefined;
    try {
      const candidate = match?.[1] === undefined ? undefined : { kind: match[1], id: decodeURIComponent(match[2]!) };
      direct = isConsoleScope(candidate) ? candidate : undefined;
    } catch { direct = undefined; }
    if (direct === undefined) return undefined;
    const route = match?.[3];
    const requestedCursor = new URLSearchParams(location.search).get('cursor') ?? undefined;
    const memberCursor = route === 'members' ? requestedCursor : undefined;
    const accessCursor = route === 'access' ? requestedCursor : undefined;
    const headers = {
      'x-scope-hint': direct.id,
      'x-access-version': String(value.accessVersion),
    };
    const memberParameters = new URLSearchParams({ limit: '20' });
    if (memberCursor !== undefined) memberParameters.set('cursor', memberCursor);
    const accessParameters = new URLSearchParams({ limit: '500' });
    if (accessCursor !== undefined) accessParameters.set('cursor', accessCursor);
    return {
      scopeKind: direct.kind,
      scopeId: direct.id,
      accessVersion: value.accessVersion!,
      memberCursor,
      accessCursor,
      members: route === 'members'
        ? readJson<unknown>(`/api/v1/members?${memberParameters.toString()}`, headers).promise
        : Promise.resolve(undefined),
      access: route === 'access'
        ? readJson<unknown>(`/api/v1/access/center?${accessParameters.toString()}`, headers).promise
        : Promise.resolve(undefined),
    };
  });
  window.__consoleMemberPrefetch = tracked(management.then(async (candidate) => {
    if (candidate === undefined) return undefined;
    const value = await candidate.members;
    return value === undefined ? undefined : {
      scopeKind: candidate.scopeKind,
      scopeId: candidate.scopeId,
      accessVersion: candidate.accessVersion,
      ...(candidate.memberCursor === undefined ? {} : { cursor: candidate.memberCursor }),
      value,
    };
  }));
  window.__consoleAccessPrefetch = tracked(management.then(async (candidate) => {
    if (candidate === undefined) return undefined;
    const value = await candidate.access;
    return value === undefined ? undefined : {
      scopeKind: candidate.scopeKind,
      scopeId: candidate.scopeId,
      accessVersion: candidate.accessVersion,
      ...(candidate.accessCursor === undefined ? {} : { cursor: candidate.accessCursor }),
      value,
    };
  }));
  const governance = session.promise.then((value) => {
    if (value === undefined || !Number.isInteger(value?.accessVersion)) return undefined;
    const match = location.pathname.match(/^\/scopes\/(platform|distributor|tenant|enterprise|mall)\/([^/]+)\/settings\/(qualification|notification)\/?$/);
    let direct: Readonly<{ kind: 'platform' | 'distributor' | 'tenant' | 'enterprise' | 'mall'; id: string }> | undefined;
    try {
      const candidate = match?.[1] === undefined ? undefined : { kind: match[1], id: decodeURIComponent(match[2]!) };
      direct = isConsoleScope(candidate) ? candidate : undefined;
    } catch { direct = undefined; }
    if (direct === undefined) return undefined;
    const route = match?.[3];
    const search = new URLSearchParams(location.search);
    const cursor = search.get('cursor') ?? undefined;
    const selectedView = search.get('view');
    const view = selectedView === 'announcements' ? 'announcements' as const : 'templates' as const;
    const headers = {
      'x-scope-hint': direct.id,
      'x-access-version': String(value.accessVersion),
    };
    const parameters = new URLSearchParams({ limit: '50' });
    if (cursor !== undefined) parameters.set('cursor', cursor);
    return {
      scopeKind: direct.kind,
      scopeId: direct.id,
      accessVersion: value.accessVersion!,
      route,
      cursor,
      view,
      value: route === 'qualification'
        ? readJson<unknown>(`/api/v1/qualifications?${parameters.toString()}`, headers).promise
        : readJson<unknown>(`/api/v1/notifications/${view}?${parameters.toString()}`, headers).promise,
    };
  });
  window.__consoleQualificationPrefetch = tracked(governance.then(async (candidate) => {
    if (candidate === undefined || candidate.route !== 'qualification') return undefined;
    const value = await candidate.value;
    return value === undefined ? undefined : {
      scopeKind: candidate.scopeKind,
      scopeId: candidate.scopeId,
      accessVersion: candidate.accessVersion,
      ...(candidate.cursor === undefined ? {} : { cursor: candidate.cursor }),
      value,
    };
  }));
  window.__consoleNotificationPrefetch = tracked(governance.then(async (candidate) => {
    if (candidate === undefined || candidate.route !== 'notification') return undefined;
    const value = await candidate.value;
    return value === undefined ? undefined : {
      scopeKind: candidate.scopeKind,
      scopeId: candidate.scopeId,
      accessVersion: candidate.accessVersion,
      view: candidate.view,
      ...(candidate.cursor === undefined ? {} : { cursor: candidate.cursor }),
      value,
    };
  }));
  preloadDirectRoute();
}

function preloadDirectRoute(): void {
  const settingsRoute = location.pathname.match(/\/settings\/(members|access|qualification|notification)\/?$/)?.[1];
  const entryRoute = location.pathname.match(/^\/scopes\/(platform|distributor|tenant|enterprise|mall)\/[^/]+\/(cockpit|products|supply-chain|orders|storefront-members)(?:\/[^/]+)?\/?$/)?.[2];
  const selectionWorkspace = ['selection', 'pending'].includes(new URLSearchParams(location.search).get('workspace') ?? '');
  const loading = settingsRoute === 'members' ? import('../../feature/member/MemberRoute')
    : settingsRoute === 'access' ? import('../../feature/access/AccessRoute')
      : settingsRoute === 'qualification' ? import('../../feature/qualification/QualificationRoute')
        : settingsRoute === 'notification' ? import('../../feature/notification/NotificationRoute')
          : /^\/scopes\/(platform|distributor|tenant|enterprise|mall)\/[^/]+\/support(?:\/[^/]+)?\/?$/.test(location.pathname)
            ? import('../../feature/support/SupportRoute')
            : entryRoute === 'cockpit' ? import('../../feature/cockpit/CockpitRoute')
              : entryRoute === 'products' ? Promise.all([
                import('../../feature/product/ProductRoute'),
                selectionWorkspace ? import('../../feature/product/ProductSelectionRoute') : import('../../feature/product/ProductCatalogRoute'),
              ])
                : entryRoute === 'supply-chain' ? import('../../feature/supply-chain/SupplyChainRoute')
                  : entryRoute === 'orders' ? import('../../feature/order/OrderRoute')
                    : entryRoute === 'storefront-members' ? import('../../feature/storefront-member/StorefrontMemberRoute')
                      : undefined;
  void loading?.catch(() => undefined);
}

function tracked<T>(promise: Promise<T | undefined>): DocumentPrefetch<T> {
  const slot: { settled: boolean; promise: Promise<T | undefined> } = { settled: false, promise: Promise.resolve(undefined) };
  slot.promise = Promise.resolve(promise).catch(() => undefined).finally(() => { slot.settled = true; });
  return slot;
}

function isConsoleScope(value: ScopeCandidate | undefined): value is Readonly<{
  kind: 'platform' | 'distributor' | 'tenant' | 'enterprise' | 'mall';
  id: string;
}> {
  return value !== undefined && typeof value.kind === 'string' && consoleKinds.includes(value.kind)
    && typeof value.id === 'string';
}
