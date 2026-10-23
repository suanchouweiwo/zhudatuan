import type { LoaderFunctionArgs, ShouldRevalidateFunctionArgs } from 'react-router';
import { redirect, redirectDocument } from 'react-router';
import { selectConsoleNavigationItems } from '../entity/navigation/ConsoleNavigation';
import type { ConsoleContext, ConsoleProfile, ConsoleScope, ConsoleSession } from '../entity/session/ConsoleSession';
import { consumeDocumentPrefetch, type DocumentPrefetch } from '../shared/api/DocumentPrefetch';
import { scopePath } from '../shared/url/ScopePath';
import { consoleModules } from './ConsoleModuleRegistry';

declare global {
  interface Window {
    __consoleAbortDocumentPrefetch?: () => void;
    __consoleSessionPrefetch?: DocumentPrefetch<Readonly<{ value: unknown }>>;
    __consoleScopePrefetch?: DocumentPrefetch<ConsoleScopePrefetch>;
    __consoleCockpitPrefetch?: DocumentPrefetch<ConsoleCockpitPrefetch>;
    __consoleProductPrefetch?: DocumentPrefetch<ConsoleProductPrefetch>;
    __consoleSupportPrefetch?: DocumentPrefetch<ConsoleSupportPrefetch>;
    __consoleMemberPrefetch?: DocumentPrefetch<ConsoleMemberPrefetch>;
    __consoleAccessPrefetch?: DocumentPrefetch<ConsoleAccessPrefetch>;
    __consoleQualificationPrefetch?: DocumentPrefetch<ConsoleQualificationPrefetch>;
    __consoleNotificationPrefetch?: DocumentPrefetch<ConsoleNotificationPrefetch>;
  }
}

interface ConsoleScopePrefetch {
  readonly accessVersion: number;
  readonly roots: readonly Readonly<{ kind: string; id: string }>[];
  readonly profile: unknown;
  readonly layers: readonly Readonly<{ scopeKind: string; scopeId: string; value: unknown }>[];
}

interface ConsoleCockpitPrefetch {
  readonly scopeKind: ConsoleScope['kind'];
  readonly scopeId: string;
  readonly accessVersion: number;
  readonly period: string;
  readonly value: unknown;
}

interface ConsoleProductPrefetch {
  readonly scopeKind: ConsoleScope['kind'];
  readonly scopeId: string;
  readonly accessVersion: number;
  readonly query: Readonly<{
    q: string;
    category: string;
    supplier: string;
    mall: string;
    status: string;
    cursor?: string;
    limit: number;
    preview: boolean;
    view?: 'supply-network' | 'selection-center';
    selection?: 'available';
  }>;
  readonly value: unknown;
}

interface ConsoleSupportPrefetch {
  readonly scopeKind: ConsoleScope['kind'];
  readonly scopeId: string;
  readonly accessVersion: number;
  readonly value: unknown;
}

interface ConsoleMemberPrefetch {
  readonly scopeKind: ConsoleScope['kind'];
  readonly scopeId: string;
  readonly accessVersion: number;
  readonly cursor?: string;
  readonly value: unknown;
}

interface ConsoleAccessPrefetch {
  readonly scopeKind: ConsoleScope['kind'];
  readonly scopeId: string;
  readonly accessVersion: number;
  readonly cursor?: string;
  readonly value: unknown;
}

interface ConsoleQualificationPrefetch {
  readonly scopeKind: ConsoleScope['kind'];
  readonly scopeId: string;
  readonly accessVersion: number;
  readonly cursor?: string;
  readonly value: unknown;
}

interface ConsoleNotificationPrefetch {
  readonly scopeKind: ConsoleScope['kind'];
  readonly scopeId: string;
  readonly accessVersion: number;
  readonly view: 'templates' | 'announcements';
  readonly cursor?: string;
  readonly value: unknown;
}

const LANDING_SESSION_HANDOFF_MS = 5_000;
const DOCUMENT_PREFETCH_HANDOFF_MS = 1_500;
const DOCUMENT_PREFETCH_TIMEOUT = Symbol('DOCUMENT_PREFETCH_TIMEOUT');
let landingSessionHandoff: Readonly<{ path: string; session: ConsoleSession; expiresAt: number }> | undefined;

export function scopeShouldRevalidate({
  currentUrl,
  nextUrl,
  formMethod,
  defaultShouldRevalidate,
}: Pick<ShouldRevalidateFunctionArgs, 'currentUrl' | 'nextUrl' | 'formMethod' | 'defaultShouldRevalidate'>): boolean {
  if (formMethod === undefined && scopeRouteKey(currentUrl) === scopeRouteKey(nextUrl)) return false;
  return defaultShouldRevalidate;
}

function scopeRouteKey(url: URL): string | undefined {
  return url.pathname.match(/^\/scopes\/[^/]+\/[^/]+/)?.[0];
}

export async function landingLoader({ request }: LoaderFunctionArgs) {
  const session = await readSession(request.signal);
  const first = session.scopes.find(isConsoleScope) ?? session.scope;
  if (!isConsoleScope(first)) throw new Response('CONSOLE_SCOPE_MISSING', { status: 403 });
  const entry = selectConsoleNavigationItems(consoleModules, first.kind, session.capabilities)
    .find(({ placement, status }) => placement === 'main' && status === 'enabled');
  const target = scopePath(first, entry?.suffix ?? 'settings/profile');
  landingSessionHandoff = Object.freeze({ path: target, session, expiresAt: Date.now() + LANDING_SESSION_HANDOFF_MS });
  return redirect(target);
}

export async function scopeLoader({ params, request }: LoaderFunctionArgs): Promise<ConsoleContext> {
  const parsed = parseScopeParameters(params);
  if (parsed === undefined) throw new Response('SCOPE_ROUTE_INVALID', { status: 404 });
  const session = takeLandingSession(request) ?? await readSession(request.signal);
  const roots = session.scopes.filter(isConsoleScope);
  const prefetched = await takeScopePrefetch(session, roots, request.signal);
  const [layers, profileResult] = await Promise.all([
    readLayers(session, roots, prefetched?.layers, request.signal),
    readProfile(session, prefetched?.profile, request.signal),
  ]);
  const scopes = uniqueScopes([...roots, ...layers]);
  const scope = scopes.find((candidate) => candidate.kind === parsed.scopeKind && candidate.id === parsed.scopeId);
  if (scope === undefined) throw new Response('SCOPE_NOT_GRANTED', { status: 403 });
  return Object.freeze({ session, profile: profileResult.profile, profileState: profileResult.state, scopes, scope });
}

function takeLandingSession(request: Request): ConsoleSession | undefined {
  const handoff = landingSessionHandoff;
  landingSessionHandoff = undefined;
  if (handoff === undefined || handoff.expiresAt < Date.now() || handoff.path !== new URL(request.url).pathname) return undefined;
  return handoff.session;
}

async function readProfile(
  session: ConsoleSession,
  prefetched: unknown,
  signal: AbortSignal,
): Promise<Readonly<{ profile: ConsoleProfile; state: 'ready' | 'unavailable' }>> {
  try {
    const parsed = parseProfile(prefetched);
    if (parsed?.status !== undefined) return Object.freeze({ profile: parsed, state: 'ready' });
    const { memberProfileRead, consoleRequest } = await consoleClient();
    const value = await memberProfileRead({}, consoleRequest(undefined, signal, session.accessVersion));
    const profile = parseProfile(value);
    if (profile === undefined) throw new Error('CONSOLE_PROFILE_SCHEMA_INVALID');
    return Object.freeze({ profile, state: 'ready' });
  } catch (cause) {
    if (signal.aborted || apiErrorStatus(cause) === 401) throw cause;
    return Object.freeze({
      profile: session.profile ?? Object.freeze({ display_name: '当前用户', employee_no: null }),
      state: 'unavailable',
    });
  }
}

async function readSession(signal: AbortSignal): Promise<ConsoleSession> {
  try {
    const prefetch = window.__consoleSessionPrefetch;
    delete window.__consoleSessionPrefetch;
  const prefetched = await consumeDocumentPrefetch(prefetch, signal, { handoffMs: DOCUMENT_PREFETCH_HANDOFF_MS });
    const parsed = prefetched === undefined ? undefined : parseSession(prefetched.value);
    const session = parsed ?? await readSessionFromSdk(signal);
    if (session.target !== 'console') {
      const { appConfig } = await import('../shared/config/AppConfig');
      throw redirectDocument(appConfig.identityEntryUrl);
    }
    return session;
  } catch (cause) {
    if (signal.aborted) throw signal.reason ?? cause;
    if (apiErrorStatus(cause) === 401) {
      const { appConfig } = await import('../shared/config/AppConfig');
      throw redirectDocument(appConfig.identityEntryUrl);
    }
    if (cause instanceof Error || cause instanceof Response) throw cause;
    throw new Error('CONSOLE_SESSION_READ_FAILED', { cause });
  }
}

async function readLayers(
  session: ConsoleSession,
  roots: readonly ConsoleScope[],
  prefetched: ConsoleScopePrefetch['layers'] | undefined,
  signal: AbortSignal,
): Promise<readonly ConsoleScope[]> {
  const allowed = session.permissions.includes('organization.layer.read')
    && session.capabilities.includes('organization.layers.read');
  if (!allowed) return [];
  const pages = await Promise.all(roots.map(async (scope) => {
    const candidate = prefetched?.find((item) => item.scopeKind === scope.kind && item.scopeId === scope.id);
    const parsed = parseScopePage(candidate?.value);
    if (parsed !== undefined) return parsed.items.filter(isConsoleScope);
    const { organizationLayersRead, consoleRequest } = await consoleClient();
    const value = await organizationLayersRead(
      { query: { limit: 1000 } },
      consoleRequest(scope, signal, session.accessVersion),
    );
    const page = parseScopePage(value);
    if (page === undefined) throw new Error('CONSOLE_SCOPE_PAGE_SCHEMA_INVALID');
    return page.items.filter(isConsoleScope);
  }));
  return Object.freeze(pages.flat());
}

async function readSessionFromSdk(signal: AbortSignal): Promise<ConsoleSession> {
  const { identitySessionRead, consoleRequest } = await consoleClient();
  const value = await identitySessionRead({}, consoleRequest(undefined, signal));
  const session = parseSession(value);
  if (session === undefined) throw new Error('CONSOLE_SESSION_SCHEMA_INVALID');
  return session;
}

async function takeScopePrefetch(
  session: ConsoleSession,
  roots: readonly ConsoleScope[],
  signal: AbortSignal,
): Promise<ConsoleScopePrefetch | undefined> {
  const slot = window.__consoleScopePrefetch;
  delete window.__consoleScopePrefetch;
  const value = await consumeDocumentPrefetch(slot, signal, { handoffMs: DOCUMENT_PREFETCH_HANDOFF_MS });
  if (value === undefined || value.accessVersion !== session.accessVersion || value.roots.length !== roots.length) return undefined;
  const expected = new Set(roots.map((scope) => `${scope.kind}:${scope.id}`));
  return value.roots.every((scope) => expected.has(`${scope.kind}:${scope.id}`)) ? value : undefined;
}


let consoleClientPromise: Promise<typeof import('../shared/api/Client')> | undefined;

function consoleClient() {
  consoleClientPromise ??= import('../shared/api/Client');
  return consoleClientPromise;
}

function apiErrorStatus(cause: unknown): number | undefined {
  return typeof cause === 'object' && cause !== null && 'status' in cause && typeof cause.status === 'number'
    ? cause.status
    : undefined;
}

const SESSION_SCOPE_KINDS = [
  'platform', 'distributor', 'tenant', 'enterprise', 'mall', 'department', 'supplier', 'brand', 'store', 'owner', 'self',
] as const;
const CONSOLE_SCOPE_KINDS = ['platform', 'distributor', 'tenant', 'enterprise', 'mall'] as const;

function parseScopeParameters(value: Readonly<Record<string, string | undefined>>) {
  return CONSOLE_SCOPE_KINDS.includes(value.scopeKind as never) && nonEmpty(value.scopeId) && value.scopeId.length <= 255
    ? { scopeKind: value.scopeKind as ConsoleScope['kind'], scopeId: value.scopeId }
    : undefined;
}

function parseSession(value: unknown): ConsoleSession | undefined {
  if (!isRecord(value)) return undefined;
  const scope = parseScope(value.scope);
  const scopes = parseArray(value.scopes, parseScope);
  const accessVersion = parseDatabaseInteger(value.accessVersion);
  const permissions = parseStringArray(value.permissions);
  const capabilities = parseStringArray(value.capabilities);
  const profile = value.profile === undefined ? undefined : parseProfile(value.profile);
  const governance = parseGovernance(value.governance);
  if (!nonEmpty(value.actor) || !nonEmpty(value.membership) || scope === undefined || scopes === undefined
    || accessVersion === undefined || permissions === undefined || capabilities === undefined
    || (value.profile !== undefined && profile === undefined)
    || (value.governance !== undefined && governance === undefined)
    || !isRecord(value.assurance) || !nonNegativeInteger(value.assurance.level)
    || !optionalNonEmpty(value.assurance.verified) || !nonEmpty(value.target) || !nonEmpty(value.syncedAt)
    || !optionalMinimumString(value.csrf, 16)) return undefined;
  const security = parseSecurity(value.security);
  if (value.security !== undefined && security === undefined) return undefined;
  return {
    actor: value.actor,
    membership: value.membership,
    scope,
    scopes,
    accessVersion,
    permissions,
    capabilities,
    ...(governance === undefined ? {} : { governance }),
    ...(profile === undefined ? {} : { profile }),
    assurance: {
      level: value.assurance.level,
      ...(value.assurance.verified === undefined ? {} : { verified: value.assurance.verified }),
    },
    ...(security === undefined ? {} : { security }),
    ...(value.csrf === undefined ? {} : { csrf: value.csrf }),
    target: value.target,
    syncedAt: value.syncedAt,
  };
}

function parseGovernance(value: unknown): ConsoleSession['governance'] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)
    || !['owner', 'senior_administrator', 'administrator', 'member'].includes(String(value.level))
    || typeof value.exactOwner !== 'boolean'
    || !nonEmpty(value.organization)) return undefined;
  return {
    level: value.level as NonNullable<ConsoleSession['governance']>['level'],
    exactOwner: value.exactOwner,
    organization: value.organization,
  };
}

function parseScope(value: unknown): ConsoleScope | undefined {
  if (!isRecord(value) || !SESSION_SCOPE_KINDS.includes(value.kind as never) || !nonEmpty(value.id)
    || !optionalNonEmpty(value.tenant) || !optionalNonEmpty(value.name)) return undefined;
  let path: ConsoleScope['path'];
  if (value.path !== undefined) {
    if (!Array.isArray(value.path)) return undefined;
    const parsed = value.path.map((item) => {
      if (!isRecord(item) || !SESSION_SCOPE_KINDS.includes(item.kind as never) || !nonEmpty(item.id)) return undefined;
      return { kind: item.kind as ConsoleScope['kind'], id: item.id };
    });
    if (parsed.some((item) => item === undefined)) return undefined;
    path = parsed as NonNullable<ConsoleScope['path']>;
  }
  return {
    kind: value.kind as ConsoleScope['kind'],
    id: value.id,
    ...(value.tenant === undefined ? {} : { tenant: value.tenant }),
    ...(value.name === undefined ? {} : { name: value.name }),
    ...(path === undefined ? {} : { path }),
  };
}

function parseProfile(value: unknown): ConsoleProfile | undefined {
  if (!isRecord(value) || !nonEmpty(value.display_name) || !(typeof value.employee_no === 'string' || value.employee_no === null)
    || !optionalNonEmpty(value.id) || !optionalNonEmpty(value.status) || !optionalBoolean(value.mobile_bound)
    || !optionalNonEmpty(value.membership_id) || !optionalNonEmpty(value.organization_id)
    || !(value.joined_at === undefined || value.joined_at === null || nonEmpty(value.joined_at))) return undefined;
  const accessVersion = value.access_version === undefined ? undefined : parseDatabaseInteger(value.access_version);
  if (value.access_version !== undefined && accessVersion === undefined) return undefined;
  return {
    ...(value.id === undefined ? {} : { id: value.id }),
    display_name: value.display_name,
    ...(value.status === undefined ? {} : { status: value.status }),
    ...(value.mobile_bound === undefined ? {} : { mobile_bound: value.mobile_bound }),
    ...(value.membership_id === undefined ? {} : { membership_id: value.membership_id }),
    ...(value.organization_id === undefined ? {} : { organization_id: value.organization_id }),
    employee_no: value.employee_no,
    ...(value.joined_at === undefined ? {} : { joined_at: value.joined_at }),
    ...(accessVersion === undefined ? {} : { access_version: accessVersion }),
  };
}

function parseScopePage(value: unknown): Readonly<{ items: readonly ConsoleScope[]; count: number; nextCursor?: string }> | undefined {
  if (!isRecord(value) || !nonNegativeInteger(value.count) || !optionalNonEmpty(value.nextCursor)) return undefined;
  const items = parseArray(value.items, parseScope);
  if (items === undefined) return undefined;
  return { items, count: value.count, ...(value.nextCursor === undefined ? {} : { nextCursor: value.nextCursor }) };
}

function parseSecurity(value: unknown): ConsoleSession['security'] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || typeof value.hasLocalCredential !== 'boolean'
    || !(value.phoneMasked === null || nonEmpty(value.phoneMasked))
    || !(value.passwordChangedAt === null || nonEmpty(value.passwordChangedAt))) return undefined;
  return {
    hasLocalCredential: value.hasLocalCredential,
    phoneMasked: value.phoneMasked,
    passwordChangedAt: value.passwordChangedAt,
  };
}

function uniqueScopes(scopes: readonly ConsoleScope[]): readonly ConsoleScope[] {
  const unique = [...new Map(scopes.map((scope) => [`${scope.kind}:${scope.id}`, scope] as const)).values()];
  unique.sort((left, right) => scopeRank(left.kind) - scopeRank(right.kind)
    || (left.name ?? left.id).localeCompare(right.name ?? right.id));
  return Object.freeze(unique);
}

function scopeRank(kind: ConsoleScope['kind']): number {
  return SESSION_SCOPE_KINDS.indexOf(kind);
}

function parseDatabaseInteger(value: unknown): number | undefined {
  const parsed = typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value) ? Number(value) : value;
  return typeof parsed === 'number' && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every(nonEmpty) ? value : undefined;
}

function parseArray<T>(value: unknown, parse: (item: unknown) => T | undefined): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parsed = value.map(parse);
  return parsed.some((item) => item === undefined) ? undefined : parsed as T[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function optionalNonEmpty(value: unknown): value is string | undefined {
  return value === undefined || nonEmpty(value);
}

function optionalMinimumString(value: unknown, minimum: number): value is string | undefined {
  return value === undefined || (typeof value === 'string' && value.length >= minimum);
}

function optionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === 'boolean';
}

function isConsoleScope(scope: ConsoleScope): boolean {
  return CONSOLE_SCOPE_KINDS.includes(scope.kind as never);
}
