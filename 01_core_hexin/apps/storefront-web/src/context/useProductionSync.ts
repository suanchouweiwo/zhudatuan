import { canonicalizeProductBrand } from '../domain/brand/productBrand';
import { useEffect, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { AccountLog, CartItem, DeliveryAddress, EnterpriseMall, Order, Product, UserProfile } from '../types';
import { ProductionApiError } from '../services/productionApi.error';
import type { ApiBootstrap, ApiHomeSnapshot, ApiProduct } from '../services/productionApi.types';
import { listPublicProducts, type PublicCatalogOptions } from '../services/publicCatalogApi';
import { loadProductionApi } from '../services/productionApiLoader';
import { mapApiOrder, mapApiProduct } from './mallMappers';
import type { CatalogSyncStatus, SessionStatus } from './MallContext.types';
import { EMPTY_GUEST_PROFILE, UNRESOLVED_MALL } from './productionStorefrontState';
import { mergeAuthenticatedMemberProfile } from './storefrontMemberProfile';
import { createCatalogPublisher } from './catalogSync';

interface ProductionSyncSetters {
  setProducts: Dispatch<SetStateAction<Product[]>>;
  setUser: Dispatch<SetStateAction<UserProfile>>;
  setCurrentMall: Dispatch<SetStateAction<EnterpriseMall>>;
  setMalls: Dispatch<SetStateAction<EnterpriseMall[]>>;
  setOrders: Dispatch<SetStateAction<Order[]>>;
  setAccountLogs: Dispatch<SetStateAction<AccountLog[]>>;
  setCart: Dispatch<SetStateAction<CartItem[]>>;
  setAddresses: Dispatch<SetStateAction<DeliveryAddress[]>>;
  setFavorites: Dispatch<SetStateAction<string[]>>;
  setQuickViewProduct: Dispatch<SetStateAction<Product | null>>;
  setSessionStatus: Dispatch<SetStateAction<SessionStatus>>;
  setSessionError: Dispatch<SetStateAction<string | null>>;
  setCatalogSyncStatus: Dispatch<SetStateAction<CatalogSyncStatus>>;
}

type CatalogPageLoader = (options?: PublicCatalogOptions) => Promise<{ items: ApiProduct[]; pagination: { nextCursor: string | null } }>;
type CatalogPagePublisher = (items: ApiProduct[]) => void;
type CatalogContinuation = () => Promise<void>;

const QUALIFIED_CATALOG_RETRY_DELAYS = [500, 1_500, 3_000] as const;
const SESSION_BOOTSTRAP_RETRY_DELAYS = [350, 900, 2_000, 4_000] as const;

export async function loadProgressiveCatalog(
  loadPage: CatalogPageLoader,
  publish: CatalogPagePublisher,
  continueWhenIdle: CatalogContinuation = waitForCatalogIdle,
  maximumPages = 1,
): Promise<ApiProduct[]> {
  const items = new Map<string, ApiProduct>();
  let cursor: string | undefined;

  for (let pageCount = 0; pageCount < maximumPages; pageCount += 1) {
    const page = await loadPage({
      ...(cursor ? { cursor } : {}),
      limit: 100,
    });
    page.items.forEach((item) => items.set(item.id, item));
    publish([...items.values()]);
    if (!page.pagination.nextCursor || page.pagination.nextCursor === cursor) break;
    cursor = page.pagination.nextCursor;
    await continueWhenIdle();
  }
  return [...items.values()];
}

function waitForCatalogIdle(): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(() => {
      const idleWindow = globalThis as typeof globalThis & {
        requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
      };
      if (idleWindow.requestIdleCallback) {
        idleWindow.requestIdleCallback(() => resolve(), { timeout: 800 });
      } else {
        resolve();
      }
    }, 250);
  });
}

export function shouldRetainProductionSnapshot(error: unknown): boolean {
  return !shouldCloseMemberSession(error);
}

export function shouldCloseMemberSession(error: unknown): boolean {
  return error instanceof ProductionApiError && (error.status === 401 || error.code === 'AUTHENTICATION_REQUIRED');
}

export function shouldRetrySessionBootstrap(error: unknown): boolean {
  if (!(error instanceof ProductionApiError)) return error instanceof TypeError;
  return error.status === 0 || error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500;
}

export function sessionBootstrapRetryDelay(attempt: number): number | undefined {
  return SESSION_BOOTSTRAP_RETRY_DELAYS[attempt];
}

/** A deployment restart must not leave an authenticated member permanently on the public catalog. */
export function shouldRetryQualifiedCatalog(error: unknown): boolean {
  return error instanceof ProductionApiError && (error.status === 0 || error.status === 404 || error.status >= 500);
}

export async function loadQualifiedCatalogWithRecovery(
  loadPage: CatalogPageLoader,
  publish: CatalogPagePublisher,
  wait: (milliseconds: number) => Promise<void> = waitForQualifiedCatalogRetry,
): Promise<ApiProduct[]> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await loadProgressiveCatalog(loadPage, publish);
    } catch (error) {
      const delay = QUALIFIED_CATALOG_RETRY_DELAYS[attempt];
      if (!shouldRetryQualifiedCatalog(error) || delay === undefined) throw error;
      await wait(delay);
    }
  }
}

function waitForQualifiedCatalogRetry(milliseconds: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}

export function authenticatedMall(bootstrap: ApiBootstrap): EnterpriseMall {
  return {
    id: bootstrap.scope.mallId,
    enterpriseId: bootstrap.scope.enterpriseId,
    enterpriseName: bootstrap.scope.enterpriseName,
    mallName: canonicalizeProductBrand(bootstrap.scope.mallName),
    logoText: canonicalizeProductBrand(bootstrap.scope.brandName),
    badge: '企业福利专享',
    welcomeBanner: `${bootstrap.scope.enterpriseName}员工福利商城已开放，实际权益以企业发放为准。`,
  };
}

export function useProductionSync(setters: ProductionSyncSetters, enabled = true) {
  const syncVersionRef = useRef(0);
  const productionRefreshRef = useRef<Promise<void> | null>(null);

  const closeMemberData = () => {
    setters.setUser({ ...EMPTY_GUEST_PROFILE });
    setters.setCurrentMall({ ...UNRESOLVED_MALL });
    setters.setMalls([]);
    setters.setOrders([]);
    setters.setAccountLogs([]);
    setters.setCart([]);
    setters.setAddresses([]);
    setters.setFavorites([]);
    setters.setQuickViewProduct(null);
  };

  const publishCatalog = (items: ApiProduct[]) => {
    setters.setProducts(items.map(mapApiProduct));
    setters.setCatalogSyncStatus('ready');
  };

  const publishMemberShell = (bootstrap: ApiBootstrap) => {
    const resolvedMall = authenticatedMall(bootstrap);
    setters.setUser((previous) => mergeAuthenticatedMemberProfile(previous, bootstrap));
    setters.setCurrentMall(resolvedMall);
    setters.setMalls([resolvedMall]);
    setters.setSessionError(null);
    setters.setSessionStatus('authenticated');
  };

  const refreshPublicCatalog = async () => {
    const syncVersion = ++syncVersionRef.current;
    setters.setCatalogSyncStatus('syncing');
    try {
      await loadProgressiveCatalog(listPublicProducts, (items) => {
        if (syncVersion === syncVersionRef.current) publishCatalog(items);
      });
    } catch (error) {
      if (syncVersion === syncVersionRef.current) setters.setCatalogSyncStatus('error');
      throw error;
    }
  };

  const runProductionRefresh = async () => {
    if (!enabled) return;
    const syncVersion = ++syncVersionRef.current;
    // Public products are available to every visitor. Authentication only
    // upgrades this snapshot with member pricing and purchase qualification.
    setters.setCatalogSyncStatus('syncing');
    const publisher = createCatalogPublisher(() => syncVersion === syncVersionRef.current, publishCatalog);
    const publicCatalogRequest = loadProgressiveCatalog(listPublicProducts, publisher.commitPublic);
    const productionApiRequest = loadProductionApi();
    void publicCatalogRequest.catch(() => undefined);
    let bootstrap: ApiBootstrap;
    try {
      const productionApi = await productionApiRequest;
      bootstrap = (await productionApi.getSession()).bootstrap;
    } catch (error) {
      if (syncVersion !== syncVersionRef.current) return;
      if (shouldCloseMemberSession(error)) {
        closeMemberData();
        setters.setSessionError(null);
        setters.setSessionStatus('guest');
      } else {
        setters.setSessionError(shouldRetrySessionBootstrap(error)
          ? '网络波动，正在恢复登录状态'
          : (error instanceof ProductionApiError ? error.message : '身份服务暂时不可用'));
      }
      try {
        const storefront = await (await productionApiRequest).getPublicStorefront();
        const resolvedMall = { ...UNRESOLVED_MALL, id: storefront.id, mallName: canonicalizeProductBrand(storefront.name), logoText: canonicalizeProductBrand(storefront.name) };
        if (syncVersion === syncVersionRef.current) {
          setters.setCurrentMall(resolvedMall);
          setters.setMalls([resolvedMall]);
        }
      } catch {
        // Keep the static guest shell when the public storefront identity is unavailable.
      }
      try {
        publisher.commitPublic(await publicCatalogRequest);
      } catch {
        if (syncVersion === syncVersionRef.current) setters.setCatalogSyncStatus('error');
      }
      throw error;
    }
    if (syncVersion !== syncVersionRef.current) {
      void publicCatalogRequest.catch(() => undefined);
      return;
    }
    // Identity and the stable shell are ready before balances, orders and
    // ledgers. Slow account APIs must never keep the page in a guest frame.
    publishMemberShell(bootstrap);

    // Member catalog qualification is an independent capability. Do not make
    // it wait for balances, orders, or ledgers: those reads are supplementary
    // and can fail without changing the member's purchase eligibility.
    void productionApiRequest.then((productionApi) => loadQualifiedCatalogWithRecovery(
      productionApi.listQualifiedProducts,
      publisher.commitQualified,
    ))
      .catch(async (error: unknown) => {
        if (error instanceof ProductionApiError) {
          console.warn('[storefront] qualified catalog unavailable after recovery', {
            code: error.code,
            status: error.status,
            requestId: error.requestId,
          });
        }
        try {
          await publicCatalogRequest;
        } catch {
          if (syncVersion === syncVersionRef.current && !publisher.hasPublicFallback()) setters.setCatalogSyncStatus('error');
        }
      });

    let snapshot: ApiHomeSnapshot;
    try {
      const productionApi = await productionApiRequest;
      snapshot = await productionApi.getHomeSnapshot(bootstrap);
    } catch (error) {
      if (syncVersion !== syncVersionRef.current) return;
      // The identity session and member shell have already been verified above.
      // A denied or unavailable account, order, or ledger read must not turn a
      // real member back into a guest or stop their qualified catalog refresh.
      return;
    }
    if (syncVersion !== syncVersionRef.current) return;

    const { accounts, orders: orderResult, accountLedgers: ledgerResult } = snapshot;
    const welfare = accounts.items.find((account) => account.type === 'welfare');
    const meal = accounts.items.find((account) => account.type === 'meal');
    setters.setUser((previous) => ({
      ...previous,
      welfareBalance: (welfare?.balanceCents ?? 0) / 100,
      mealBalance: (meal?.balanceCents ?? 0) / 100,
    }));
    setters.setOrders(orderResult.items.map((order) => mapApiOrder(order, bootstrap.scope)));
    setters.setAccountLogs(
      ledgerResult.items.map((ledger) => ({
        id: ledger.id,
        accountType: ledger.accountType,
        title: ledger.businessType === 'order_payment' ? '商城订单账户支付' : ledger.businessType === 'refund' ? '售后退款原路退回' : '企业福利额度发放',
        amount: ((ledger.direction === 'credit' ? 1 : -1) * ledger.amountCents) / 100,
        direction: ledger.direction === 'credit' ? 'in' : 'out',
        orderNo: ledger.orderNo ?? undefined,
        time: new Date(ledger.createdAt).toLocaleString('zh-CN', {
          hour12: false,
        }),
        balanceAfter: ledger.balanceAfterCents / 100,
      }))
    );
  };

  const refreshProductionData = (): Promise<void> => {
    if (!enabled) return Promise.resolve();
    const activeRefresh = productionRefreshRef.current;
    if (activeRefresh) return activeRefresh;
    const refresh = runProductionRefresh();
    productionRefreshRef.current = refresh;
    refresh.then(
      () => {
        if (productionRefreshRef.current === refresh) productionRefreshRef.current = null;
      },
      () => {
        if (productionRefreshRef.current === refresh) productionRefreshRef.current = null;
      }
    );
    return refresh;
  };

  const cancelProductionSync = () => {
    syncVersionRef.current += 1;
    setters.setCatalogSyncStatus('idle');
  };

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let retryAttempt = 0;
    let retryTimer: number | null = null;
    const clearRetry = () => {
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      retryTimer = null;
    };
    const synchronize = () => {
      clearRetry();
      void refreshProductionData().then(() => {
        retryAttempt = 0;
      }).catch((error: unknown) => {
        if (disposed || !shouldRetrySessionBootstrap(error)) return;
        const delay = sessionBootstrapRetryDelay(retryAttempt);
        retryAttempt += 1;
        if (delay === undefined) {
          setters.setSessionError('网络连接尚未恢复，请点击重试');
          return;
        }
        retryTimer = window.setTimeout(synchronize, delay);
      });
    };
    // Publish identity first; balances, orders and catalog continue without
    // blocking the first authenticated frame.
    synchronize();
    const handleOnline = () => {
      retryAttempt = 0;
      synchronize();
    };
    window.addEventListener('online', handleOnline);
    return () => {
      disposed = true;
      clearRetry();
      window.removeEventListener('online', handleOnline);
      syncVersionRef.current += 1;
      productionRefreshRef.current = null;
    };
  }, [enabled]);

  return { refreshProductionData, refreshPublicCatalog, cancelProductionSync };
}
