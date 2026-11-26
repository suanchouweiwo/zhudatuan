import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { UserProfile, EnterpriseMall, Product, CartItem, Order, DeliveryAddress, AccountLog } from '../types';
import { ProductionApiError } from '../services/productionApi.error';
import { loadProductionApi } from '../services/productionApiLoader';
import { toFrontendCategories, toFrontendOrders, toFrontendProducts } from '../adapters/frontendData';
import type { AndroidAppPage, AppMode, LaptopPage, LoginCredentials, MallContextType, MiniProgramPage, MobileFulfillmentStage, PageRoute, PendingFeatureInfo, RouteParams, SessionStatus, TabletOrientation, TabletPage, ViewportMode } from './MallContext.types';
import { useDeviceNavigation } from './useDeviceNavigation';
import { checkoutSelectedCartRequest, PaymentPhoneVerificationRequired, prepareCheckoutSelection, refreshRejectedCheckoutCart } from './checkoutSelectedCart';
import { useProductionSync } from './useProductionSync';
import { purchaseAvailabilityMessage } from './purchaseAvailabilityMessage';
import { useToasts } from './useToasts';
import { guestStorefrontProfile } from './guestStorefrontProfile';
import { EMPTY_GUEST_PROFILE, UNRESOLVED_MALL } from './productionStorefrontState';
import type { CartQuantitySync, CartQuantityUpdate } from './cartQuantitySync';
import { addCartItemOptimistically, rollbackCartQuantity, setCartQuantityOptimistically } from './cartOptimisticState';
import { switchDefaultAddressOptimistically } from './addressDefaultState';
import { cartSessionDecision, queueCartAddition, type PendingCartAddition } from './cartSessionRecovery';
import type { ApiPaymentResult } from '../services/productionApi.types';
import type { CanonicalPaymentProgress } from '../services/canonicalCheckout';
import type { WechatJsapiPaymentOutcome } from '../services/wechatJsapiPayment';
import {
  beginPaymentRecovery,
  clearPaymentRecovery,
  finishPaymentSubmission,
  isPaymentRecoveryPending,
  loadPaymentRecovery,
  paymentCartFingerprint,
  paymentRecoveryScope,
  paymentRetryIdempotencyKey,
  tryBeginPaymentSubmission,
  updatePaymentRecovery,
  type PaymentRecoveryRecord,
} from '../services/paymentRecovery';
export type * from './MallContext.types';
const MallContext = createContext<MallContextType | undefined>(undefined);
const PaymentPhoneVerificationModal = React.lazy(() => import('../components/mobile/PaymentPhoneVerificationModal').then(({ PaymentPhoneVerificationModal }) => ({ default: PaymentPhoneVerificationModal })));

type ShowcaseService = {
  getUserProfile: () => UserProfile;
  getCurrentMall: () => EnterpriseMall;
  getMalls: () => EnterpriseMall[];
  getProducts: () => Product[];
  getOrders: () => Order[];
  getAccountLogs: () => AccountLog[];
  getCart: () => CartItem[];
  getFavorites: () => string[];
  getAddresses: () => DeliveryAddress[];
  switchMall: (mallId: string) => EnterpriseMall;
  addToCart: (product: Product, quantity?: number, selectedSpec?: Record<string, string>) => CartItem[];
  updateCartQuantity: (cartItemId: string, quantity: number) => CartItem[];
  toggleCartItemSelected: (cartItemId: string) => CartItem[];
  toggleSelectAllCart: (selected: boolean) => CartItem[];
  removeCartItem: (cartItemId: string) => CartItem[];
  toggleFavorite: (productId: string) => boolean;
  addAddress: (address: Omit<DeliveryAddress, 'id'>) => DeliveryAddress[];
  setDefaultAddress: (addressId: string) => DeliveryAddress[];
};

type MallProviderProps = {
  children: React.ReactNode;
  /** Only the isolated /[device] visual showcase may inject local demo data. */
  showcaseService?: ShowcaseService;
  /** Keeps the server and browser on the same first-render device mode. */
  initialPath?: string;
};

export const MallProvider: React.FC<MallProviderProps> = ({ children, showcaseService, initialPath }) => {
  const navigation = useDeviceNavigation(initialPath);
  const isShowcase = Boolean(showcaseService);

  const [user, setUser] = useState<UserProfile>(() => (showcaseService ? showcaseService.getUserProfile() : { ...EMPTY_GUEST_PROFILE }));
  const [currentMall, setCurrentMall] = useState<EnterpriseMall>(() => (showcaseService ? showcaseService.getCurrentMall() : { ...UNRESOLVED_MALL }));
  const [malls, setMalls] = useState<EnterpriseMall[]>(() => (showcaseService ? showcaseService.getMalls() : []));
  const [cart, setCartState] = useState<CartItem[]>(() => (showcaseService ? showcaseService.getCart() : []));
  const [orders, setOrders] = useState<Order[]>(() => (showcaseService ? showcaseService.getOrders() : []));
  const [mobileFulfillmentSimulationStage, setMobileFulfillmentSimulationStage] = useState<MobileFulfillmentStage | null>(null);
  const [products, setProducts] = useState<Product[]>(() => (showcaseService ? showcaseService.getProducts() : []));
  const [accountLogs, setAccountLogs] = useState<AccountLog[]>(() => (showcaseService ? showcaseService.getAccountLogs() : []));
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>(isShowcase ? 'authenticated' : 'checking');
  const [catalogSyncStatus, setCatalogSyncStatus] = useState<'idle' | 'syncing' | 'ready' | 'error'>(isShowcase ? 'ready' : 'idle');
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [isSubmittingOrder, setIsSubmittingOrder] = useState(false);
  const [paymentPhoneVerificationOpen, setPaymentPhoneVerificationOpen] = useState(false);
  const [activePaymentSession, setActivePaymentSession] = useState<PaymentRecoveryRecord | null>(null);
  const activePaymentId = activePaymentSession?.paymentId ?? null;
  const [favorites, setFavorites] = useState<string[]>(() => (showcaseService ? showcaseService.getFavorites() : []));
  const [addresses, setAddresses] = useState<DeliveryAddress[]>(() => (showcaseService ? showcaseService.getAddresses() : []));
  const [quickViewProduct, setQuickViewProduct] = useState<Product | null>(null);
  const sessionGenerationRef = useRef(0);
  const sessionStatusRef = useRef(sessionStatus);
  const cartRef = useRef(cart);
  const cartCacheScopeRef = useRef<string | null>(null);
  const cartMutationVersionRef = useRef(0);
  const cartItemSnapshotsRef = useRef(new Map<string, CartItem>());
  const pendingCartAdditionRef = useRef<PendingCartAddition | null>(null);
  const refreshCartRequestRef = useRef<Promise<void> | null>(null);
  const activePaymentSessionRef = useRef<PaymentRecoveryRecord | null>(null);
  const paymentInFlightRef = useRef(false);
  const verificationAddressRef = useRef<{ scope: string; addressId: string | undefined } | null>(null);
  const dismissedPaymentKeyRef = useRef<string | null>(null);
  const capturedPaymentsRef = useRef(new Set<string>());
  const { toasts, showToast, removeToast } = useToasts();
  const showToastRef = useRef(showToast);
  const refreshServerCartRef = useRef<() => Promise<void>>(async () => undefined);
  const cartQuantitySyncRef = useRef<CartQuantitySync | null>(null);
  const cartQuantitySyncLoadRef = useRef<Promise<CartQuantitySync> | null>(null);
  const bufferedCartUpdatesRef = useRef(new Map<string, CartQuantityUpdate>());
  const cartSyncGenerationRef = useRef(0);
  const productsRef = useRef(products);
  showToastRef.current = showToast;
  productsRef.current = products;
  sessionStatusRef.current = sessionStatus;
  cartRef.current = cart;
  activePaymentSessionRef.current = activePaymentSession;
  const cacheCart = useCallback((items: CartItem[]) => {
    const scope = cartCacheScopeRef.current;
    if (!scope || typeof window === 'undefined') return;
    void import('./cartCache').then(({ writeCartCache }) => writeCartCache(scope, items));
  }, []);
  const publishCart = useCallback((items: CartItem[]) => {
    cartRef.current = items;
    items.forEach((item) => cartItemSnapshotsRef.current.set(item.id, item));
    setCartState(items);
  }, []);
  const setCart = useCallback<React.Dispatch<React.SetStateAction<CartItem[]>>>((update) => {
    setCartState((current) => {
      const next = typeof update === 'function' ? update(current) : update;
      cartRef.current = next;
      next.forEach((item) => cartItemSnapshotsRef.current.set(item.id, item));
      return next;
    });
  }, []);
  const presentationProducts = useMemo(() => toFrontendProducts(products), [products]);
  const presentationOrders = useMemo(() => toFrontendOrders(orders, presentationProducts), [orders, presentationProducts]);
  const presentationCategories = useMemo(() => toFrontendCategories(products), [products]);
  const currentPaymentScope = useMemo(() => paymentRecoveryScope(user.id, currentMall.id), [currentMall.id, user.id]);
  const activatePaymentSession = useCallback((record: PaymentRecoveryRecord | null) => {
    activePaymentSessionRef.current = record;
    setActivePaymentSession(record);
  }, []);
  const patchActivePaymentSession = useCallback((patch: Parameters<typeof updatePaymentRecovery>[1]) => {
    const current = activePaymentSessionRef.current;
    if (!current) return null;
    const next = updatePaymentRecovery(current, patch);
    activePaymentSessionRef.current = next;
    setActivePaymentSession(next);
    return next;
  }, []);

  const refreshServerCart = useCallback((): Promise<void> => {
    if (refreshCartRequestRef.current) return refreshCartRequestRef.current;
    const sessionGeneration = sessionGenerationRef.current;
    const mutationVersion = cartMutationVersionRef.current;
    const request = (async () => {
      const productionApi = await loadProductionApi();
      const [response, { mergeAuthoritativeCart }] = await Promise.all([
        productionApi.listCart(),
        import('./cartServerState'),
      ]);
      if (sessionGeneration !== sessionGenerationRef.current || mutationVersion !== cartMutationVersionRef.current) return;
      const next = mergeAuthoritativeCart(response.items, productsRef.current, cartRef.current);
      publishCart(next);
      cacheCart(next);
    })().finally(() => {
      if (refreshCartRequestRef.current === request) refreshCartRequestRef.current = null;
    });
    refreshCartRequestRef.current = request;
    return request;
  }, [cacheCart, publishCart]);
  refreshServerCartRef.current = refreshServerCart;
  const ensureCartQuantitySync = useCallback(async (): Promise<CartQuantitySync> => {
    if (cartQuantitySyncRef.current) return cartQuantitySyncRef.current;
    if (cartQuantitySyncLoadRef.current) return cartQuantitySyncLoadRef.current;
    const loadGeneration = cartSyncGenerationRef.current;
    const load = import('./cartQuantitySync').then(({ createCartQuantitySync }) => {
      const sync = createCartQuantitySync(
        async ({ listingId, quantity }) => {
          const productionApi = await loadProductionApi();
          await productionApi.upsertCartItem({ listingId, quantity });
        },
        {
          onCommitted: () => cacheCart(cartRef.current),
          onError: (_cause, failure) => {
            cartMutationVersionRef.current += 1;
            publishCart(rollbackCartQuantity(
              cartRef.current,
              cartItemSnapshotsRef.current.get(failure.update.cartItemId),
              failure.update.cartItemId,
              failure.rollbackQuantity,
            ));
            showToastRef.current('同步失败，已恢复原数量', 'error', { channel: 'cart', durationMs: 1_800 });
          },
        },
      );
      if (loadGeneration !== cartSyncGenerationRef.current) {
        sync.cancel();
        return sync;
      }
      cartQuantitySyncRef.current = sync;
      const buffered = [...bufferedCartUpdatesRef.current.values()];
      bufferedCartUpdatesRef.current.clear();
      buffered.forEach((update) => sync.schedule(update));
      return sync;
    }).finally(() => {
      if (cartQuantitySyncLoadRef.current === load) cartQuantitySyncLoadRef.current = null;
    });
    cartQuantitySyncLoadRef.current = load;
    return load;
  }, [cacheCart, publishCart]);
  const scheduleCartQuantityUpdate = useCallback((update: CartQuantityUpdate) => {
    if (cartQuantitySyncRef.current) {
      cartQuantitySyncRef.current.schedule(update);
      return;
    }
    bufferedCartUpdatesRef.current.set(update.cartItemId, update);
    void ensureCartQuantitySync();
  }, [ensureCartQuantitySync]);
  useEffect(() => () => {
    cartSyncGenerationRef.current += 1;
    bufferedCartUpdatesRef.current.clear();
    cartQuantitySyncRef.current?.cancel();
  }, []);
  const refreshServerAddresses = useCallback(async () => {
    const sessionGeneration = sessionGenerationRef.current;
    const productionApi = await loadProductionApi();
    const response = await productionApi.listAddresses();
    if (sessionGeneration === sessionGenerationRef.current) setAddresses(response.items);
  }, []);
  const { refreshProductionData, refreshPublicCatalog, cancelProductionSync } = useProductionSync(
    {
      setProducts,
      setUser,
      setCurrentMall,
      setMalls,
      setOrders,
      setAccountLogs,
      setCart,
      setAddresses,
      setFavorites,
      setQuickViewProduct,
      setSessionStatus,
      setSessionError,
      setCatalogSyncStatus,
    },
    !isShowcase
  );
  useEffect(() => {
    if (showcaseService) return;
    if (sessionStatus !== 'authenticated') {
      cartSyncGenerationRef.current += 1;
      bufferedCartUpdatesRef.current.clear();
      cartQuantitySyncRef.current?.cancel();
      cartQuantitySyncRef.current = null;
      cartQuantitySyncLoadRef.current = null;
      cartCacheScopeRef.current = null;
      return;
    }
    const scope = `${user.id}:${currentMall.id}`;
    if (cartCacheScopeRef.current !== scope) {
      cartCacheScopeRef.current = scope;
      void import('./cartCache').then(({ readCartCache }) => {
        if (cartCacheScopeRef.current === scope && cartRef.current.length === 0) publishCart(readCartCache(scope));
      });
    }
    setFavorites([]);
    const idleWindow = window as Window & {
      requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    const refreshCart = () => {
      void ensureCartQuantitySync();
      void refreshServerCart().catch(() => showToast('购物车同步失败，请重试', 'error', { channel: 'cart', durationMs: 1_800 }));
    };
    const idleHandle = idleWindow.requestIdleCallback?.(refreshCart, { timeout: 700 });
    const cartTimer = idleHandle === undefined ? window.setTimeout(refreshCart, 120) : null;
    const addressTimer = window.setTimeout(() => {
      void refreshServerAddresses().catch(() => showToast('地址簿同步失败，请稍后重试', 'error'));
    }, 1_500);
    return () => {
      if (idleHandle !== undefined) idleWindow.cancelIdleCallback?.(idleHandle);
      if (cartTimer !== null) window.clearTimeout(cartTimer);
      window.clearTimeout(addressTimer);
    };
  }, [currentMall.id, ensureCartQuantitySync, publishCart, refreshServerAddresses, refreshServerCart, sessionStatus, showcaseService, showToast, user.id]);

  const prepareCart = useCallback(() => {
    if (showcaseService) return;
    if (sessionStatusRef.current !== 'authenticated') return;
    void ensureCartQuantitySync();
    void refreshServerCart().catch(() => undefined);
  }, [ensureCartQuantitySync, refreshServerCart, showcaseService]);
  useEffect(() => {
    if (sessionStatus !== 'authenticated') {
      activatePaymentSession(null);
      return;
    }
    const recovered = loadPaymentRecovery(currentPaymentScope);
    if (isPaymentRecoveryPending(recovered) && dismissedPaymentKeyRef.current !== recovered.idempotencyKey) {
      activatePaymentSession(recovered);
    }
  }, [activatePaymentSession, currentPaymentScope, sessionStatus]);
  useEffect(() => {
    if (sessionStatus !== 'authenticated') return;
    const restore = () => {
      if (document.visibilityState === 'hidden') return;
      const recovered = loadPaymentRecovery(currentPaymentScope);
      if (isPaymentRecoveryPending(recovered) && dismissedPaymentKeyRef.current !== recovered.idempotencyKey) {
        activatePaymentSession(recovered);
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') restore();
    };
    window.addEventListener('pageshow', restore);
    window.addEventListener('focus', restore);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('pageshow', restore);
      window.removeEventListener('focus', restore);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [activatePaymentSession, currentPaymentScope, sessionStatus]);
  const refreshUserData = () => {
    if (sessionStatus === 'authenticated') {
      void refreshProductionData().catch(() => {
        showToast('账户数据同步失败，请稍后重试', 'error');
      });
      return;
    }
    if (showcaseService) {
      setUser(showcaseService.getUserProfile());
      setCurrentMall(showcaseService.getCurrentMall());
      setProducts(showcaseService.getProducts());
      setOrders(showcaseService.getOrders());
      return;
    }
    setUser(guestStorefrontProfile());
    setCurrentMall({ ...UNRESOLVED_MALL });
    setMalls([]);
    void refreshPublicCatalog().catch(() => showToast('公开商品目录同步失败，请稍后重试', 'error'));
    setCart([]);
    setOrders([]);
    setMobileFulfillmentSimulationStage(null);
  };

  const login = async (credentials: LoginCredentials): Promise<boolean> => {
    setSessionError(null);
    try {
      const productionApi = await loadProductionApi();
      await productionApi.login(credentials);
      await refreshProductionData();
      showToast('安全登录成功，已同步福利账户与订单', 'success');
      return true;
    } catch (error) {
      const message = error instanceof ProductionApiError ? error.message : '登录服务暂时不可用';
      setSessionStatus('guest');
      setSessionError(message);
      return false;
    }
  };
  const logout = async () => {
    const revokeRequest = loadProductionApi().then((productionApi) => productionApi.logout());
    cartSyncGenerationRef.current += 1;
    bufferedCartUpdatesRef.current.clear();
    cartQuantitySyncRef.current?.cancel();
    cartQuantitySyncRef.current = null;
    cartQuantitySyncLoadRef.current = null;
    pendingCartAdditionRef.current = null;
    sessionGenerationRef.current += 1;
    cancelProductionSync();
    setSessionStatus('guest');
    setSessionError(null);
    setUser(guestStorefrontProfile());
    setCurrentMall({ ...UNRESOLVED_MALL });
    setMalls([]);
    setProducts([]);
    setCart([]);
    setOrders([]);
    setAccountLogs([]);
    setFavorites([]);
    setAddresses([]);
    setQuickViewProduct(null);
    activatePaymentSession(null);
    dismissedPaymentKeyRef.current = null;
    navigation.navigateTo('home');
    showToast('已退出登录，服务器会话正在安全撤销', 'info');
    try {
      await revokeRequest;
    } catch {
      showToast('页面已退出；服务器会话撤销失败，请刷新页面确认', 'warning');
    }
    void refreshPublicCatalog().catch(() => showToast('公开商品目录同步失败，请稍后重试', 'error'));
  };

  const switchMall = (mallId: string) => {
    if (showcaseService) {
      const newMall = showcaseService.switchMall(mallId);
      setCurrentMall(newMall);
      setUser(showcaseService.getUserProfile());
      setProducts(showcaseService.getProducts());
      setCart(showcaseService.getCart());
      setOrders(showcaseService.getOrders());
      setFavorites(showcaseService.getFavorites());
      setAddresses(showcaseService.getAddresses());
      navigation.navigateTo('home');
      showToast(`已切换至【${newMall.mallName}】`, 'info');
      return;
    }
    if (sessionStatus === 'authenticated' && mallId !== currentMall.id) {
      showToast('当前账号未获得其他商城的数据权限', 'warning');
      return;
    }
    showToast('请先登录并获取企业商城访问权限', 'warning');
  };

  const handleAddToCart = useCallback((product: Product, quantity = 1, selectedSpec: Record<string, string> = {}): boolean => {
    if (product.isTest) {
      showToast('测试商品仅用于系统验证，不能加入购物车', 'warning');
      return false;
    }
    const sessionDecision = cartSessionDecision(sessionStatus, Boolean(showcaseService));
    if (sessionDecision === 'queue') {
      const shouldStartSessionRecovery = pendingCartAdditionRef.current === null;
      pendingCartAdditionRef.current = queueCartAddition(
        pendingCartAdditionRef.current,
        product,
        quantity,
        selectedSpec,
      );
      showToast(
        sessionError
          ? '网络波动，正在恢复登录状态，恢复后将自动加入购物车'
          : '正在确认登录状态，确认后将自动加入购物车',
        'info',
        { channel: 'cart', durationMs: 1_800 },
      );
      if (shouldStartSessionRecovery) void refreshProductionData().catch(() => undefined);
      return false;
    }
    if (sessionDecision === 'require-login') {
      showToast('商品可以直接浏览；登录后才能确认会员价与加入购物车', 'warning');
      return false;
    }
    if (product.purchasable === false) {
      showToast(purchaseAvailabilityMessage(product.qualificationReason), 'warning');
      return false;
    }
    if (!Number.isSafeInteger(quantity) || quantity < 1) return false;
    const existingQuantity = cartRef.current.find((item) => item.product.id === product.id)?.quantity ?? 0;
    const remainingStock = Math.max(0, product.stock - existingQuantity);
    if (remainingStock === 0) {
      showToast(product.stock <= 0 ? '暂时缺货' : `库存仅剩 ${product.stock} 件`, 'warning', { channel: 'cart', durationMs: 1_800 });
      return false;
    }
    const acceptedQuantity = Math.min(quantity, remainingStock);
    if (!showcaseService && sessionStatus === 'authenticated' && product.skuId) {
      const mutation = addCartItemOptimistically(cartRef.current, product, acceptedQuantity, selectedSpec);
      cartMutationVersionRef.current += 1;
      cartItemSnapshotsRef.current.set(mutation.item.id, mutation.item);
      publishCart(mutation.items);
      scheduleCartQuantityUpdate({
        cartItemId: mutation.item.id,
        listingId: product.id,
        previousQuantity: mutation.previousQuantity,
        quantity: mutation.quantity,
      });
      showToast(mutation.quantity === 1 ? '已加入购物车' : `已加入 ${mutation.quantity} 件`, 'success', { channel: 'cart' });
      return true;
    }
    if (!showcaseService && sessionStatus === 'authenticated') {
      showToast('商品资格正在后台同步，请稍后再加入购物车', 'info');
      return false;
    }
    if (showcaseService) {
      publishCart(showcaseService.addToCart(product, acceptedQuantity, selectedSpec));
      showToast('已加入购物车', 'success', { channel: 'cart' });
      return true;
    }
    return false;
  }, [publishCart, refreshProductionData, scheduleCartQuantityUpdate, sessionError, sessionStatus, showcaseService, showToast]);

  useEffect(() => {
    if (showcaseService || sessionStatus === 'checking') return;
    const pending = pendingCartAdditionRef.current;
    if (pending === null) return;
    pendingCartAdditionRef.current = null;
    if (sessionStatus === 'guest') {
      showToast('商品可以直接浏览；登录后才能确认会员价与加入购物车', 'warning', { channel: 'cart' });
      return;
    }
    const currentProduct = productsRef.current.find((product) => product.id === pending.productId) ?? pending.product;
    handleAddToCart(currentProduct, pending.quantity, { ...pending.selectedSpec });
  }, [handleAddToCart, sessionStatus, showcaseService, showToast]);

  const handleUpdateCartQuantity = useCallback((cartItemId: string, quantity: number): boolean => {
    if (!showcaseService && sessionStatus === 'authenticated') {
      const item = cartRef.current.find((candidate) => candidate.id === cartItemId);
      if (!item?.product.skuId || !Number.isSafeInteger(quantity)) return false;
      const requestedQuantity = Math.max(0, quantity);
      const nextQuantity = Math.min(requestedQuantity, Math.max(0, item.product.stock));
      if (nextQuantity === item.quantity) {
        if (requestedQuantity > nextQuantity) showToast(`库存仅剩 ${item.product.stock} 件`, 'warning', { channel: 'cart', durationMs: 1_800 });
        return false;
      }
      const mutation = setCartQuantityOptimistically(cartRef.current, cartItemId, nextQuantity);
      if (!mutation) return false;
      cartMutationVersionRef.current += 1;
      cartItemSnapshotsRef.current.set(cartItemId, mutation.item);
      publishCart(mutation.items);
      scheduleCartQuantityUpdate({
        cartItemId,
        listingId: item.product.id,
        previousQuantity: mutation.previousQuantity,
        quantity: nextQuantity,
      });
      if (requestedQuantity > nextQuantity) showToast(`库存仅剩 ${item.product.stock} 件`, 'warning', { channel: 'cart', durationMs: 1_800 });
      return true;
    }
    if (showcaseService) {
      publishCart(showcaseService.updateCartQuantity(cartItemId, quantity));
      return true;
    }
    return false;
  }, [publishCart, scheduleCartQuantityUpdate, sessionStatus, showcaseService, showToast]);

  const handleToggleCartItemSelected = (cartItemId: string) => {
    if (!showcaseService && sessionStatus === 'authenticated') {
      setCart((current) => current.map((item) => (
        item.id === cartItemId && item.product.purchasable !== false && item.product.stock > 0 ? { ...item, selected: !item.selected } : item
      )));
      return;
    }
    if (showcaseService) setCart(showcaseService.toggleCartItemSelected(cartItemId));
  };

  const handleToggleSelectAllCart = (selected: boolean) => {
    if (!showcaseService && sessionStatus === 'authenticated') {
      setCart((current) => current.map((item) => ({
        ...item,
        selected: selected && item.product.purchasable !== false && item.product.stock > 0,
      })));
      return;
    }
    if (showcaseService) setCart(showcaseService.toggleSelectAllCart(selected));
  };

  const handleRemoveCartItem = async (cartItemId: string) => {
    if (!showcaseService && sessionStatus === 'authenticated') {
      if (handleUpdateCartQuantity(cartItemId, 0)) showToast('已从购物车移除', 'info', { channel: 'cart' });
      return;
    }
    if (showcaseService) {
      publishCart(showcaseService.removeCartItem(cartItemId));
      showToast('已从购物车移除', 'info', { channel: 'cart' });
    }
  };

  const completeCapturedPayment = useCallback((paymentId: string) => {
    const current = activePaymentSessionRef.current;
    if (!current || capturedPaymentsRef.current.has(paymentId)) return;
    capturedPaymentsRef.current.add(paymentId);
    const captured = updatePaymentRecovery(current, { stage: 'captured', paymentId });
    activePaymentSessionRef.current = captured;
    setActivePaymentSession(captured);
    clearPaymentRecovery(captured.scope);
    const completedCartItems = new Set(captured.cartItemIds);
    setCart((items) => items.filter((item) => !completedCartItems.has(item.id)));
    showToastRef.current('支付成功，订单已为你保留', 'success');
    void loadProductionApi().then(async (productionApi) => {
      await Promise.allSettled(captured.cartItemIds.map((itemId) => productionApi.deleteCartItem(itemId)));
      await Promise.allSettled([refreshServerCartRef.current(), refreshProductionData()]);
    }).catch(() => undefined);
  }, [refreshProductionData]);

  const recordPaymentResult = useCallback((result: ApiPaymentResult) => {
    const current = activePaymentSessionRef.current;
    if (!current || (current.paymentId !== null && current.paymentId !== result.intentId)) return;
    if (result.state === 'captured') {
      completeCapturedPayment(result.intentId);
      return;
    }
    if (result.state === 'failed' || result.state === 'expired') {
      patchActivePaymentSession({ stage: result.state, paymentId: result.intentId, amountMinor: result.amountMinor, currency: result.currency });
      return;
    }
    if (current.stage === 'cancelled') return;
    patchActivePaymentSession({
      stage: result.state === 'recovery' ? 'recovery' : 'verifying',
      paymentId: result.intentId,
      amountMinor: result.amountMinor,
      currency: result.currency,
    });
  }, [completeCapturedPayment, patchActivePaymentSession]);

  const applyWechatOutcome = async (outcome: WechatJsapiPaymentOutcome | undefined, paymentId?: string) => {
    if (!outcome) return;
    if (outcome.status === 'returned') {
      patchActivePaymentSession({ stage: 'verifying' });
      if (paymentId) {
        try {
          const productionApi = await loadProductionApi();
          recordPaymentResult(await productionApi.readPaymentResult(paymentId));
        } catch {
          patchActivePaymentSession({ stage: 'recovery' });
        }
      }
    }
    else if (outcome.status === 'cancelled') patchActivePaymentSession({ stage: 'cancelled' });
    else if (outcome.status === 'failed') {
      patchActivePaymentSession({ stage: 'failed' });
      if (outcome.code === 'WECHAT_CLIENT_REQUIRED') showToast('请在微信中打开商城后继续付款', 'info');
    }
    else patchActivePaymentSession({ stage: 'recovery' });
  };

  const paymentProgress = async (progress: CanonicalPaymentProgress) => {
    patchActivePaymentSession({
      stage: progress.stage,
      orderId: progress.orderId,
      paymentId: progress.paymentId,
      amountMinor: progress.amountMinor,
      currency: progress.currency,
    });
    if (progress.stage === 'opening-wechat') await afterPaymentCarrierPaint();
  };

  const submitSelectedCart = async (checkoutUser: UserProfile, addressId?: string): Promise<boolean> => {
    if (sessionStatus !== 'authenticated') {
      showToast('请先登录账户，再提交订单', 'warning');
      return false;
    }
    if (!tryBeginPaymentSubmission(paymentInFlightRef)) return activePaymentSessionRef.current !== null;
    setIsSubmittingOrder(true);
    try {
      const selection = prepareCheckoutSelection(cart, addresses, checkoutUser, addressId);
      const fingerprint = paymentCartFingerprint(selection.address.id, selection.selectedItems.map((item) => ({
        cartItemId: item.id, listingId: item.product.id, quantity: item.quantity,
      })));
      let recovery = loadPaymentRecovery(currentPaymentScope);
      if (recovery?.orderId && isPaymentRecoveryPending(recovery)) {
        dismissedPaymentKeyRef.current = null;
        activatePaymentSession(recovery);
        return true;
      }
      if (recovery && recovery.orderId === null && recovery.cartFingerprint !== fingerprint) {
        clearPaymentRecovery(currentPaymentScope);
        recovery = null;
      }
      recovery ??= beginPaymentRecovery({
        scope: currentPaymentScope,
        amountMinor: selection.amountMinor,
        currency: 'CNY',
        mallName: currentMall.mallName,
        cartFingerprint: fingerprint,
        ...(addressId === undefined ? {} : { checkoutAddressId: addressId }),
        cartItemIds: selection.selectedItems.map((item) => item.id),
      });
      dismissedPaymentKeyRef.current = null;
      activatePaymentSession(recovery);
      await afterPaymentCarrierPaint();
      if (bufferedCartUpdatesRef.current.size > 0 || cartQuantitySyncRef.current?.hasPending()) {
        await (await ensureCartQuantitySync()).flush();
      }
      patchActivePaymentSession({ stage: 'creating-order' });
      const checkout = await checkoutSelectedCartRequest(cart, addresses, checkoutUser, {
        ...(addressId === undefined ? {} : { addressId }),
        idempotencyKey: recovery.idempotencyKey,
        onPaymentProgress: paymentProgress,
      });
      if (checkout.paymentState === 'captured') completeCapturedPayment(checkout.paymentId);
      else if (checkout.paymentState === 'reconciling') patchActivePaymentSession({ stage: 'recovery' });
      else await applyWechatOutcome(checkout.wechatOutcome, checkout.paymentId);
      return true;
    } catch (error) {
      if (error instanceof PaymentPhoneVerificationRequired) {
        verificationAddressRef.current = { scope: currentPaymentScope, addressId };
        activatePaymentSession(null);
        clearPaymentRecovery(currentPaymentScope);
        setPaymentPhoneVerificationOpen(true);
        return false;
      }
      const current = activePaymentSessionRef.current;
      if (error instanceof ProductionApiError && error.code === 'CHECKOUT_REJECTED' && current?.orderId === null) {
        const selectedItems = cart.filter((item) => current.cartItemIds.includes(item.id));
        activatePaymentSession(null);
        clearPaymentRecovery(currentPaymentScope);
        showToast(error.message, 'warning');
        let refreshed = false;
        try {
          const productionApi = await loadProductionApi();
          refreshed = await refreshRejectedCheckoutCart(selectedItems, (input) => productionApi.upsertCartItem(input));
        } catch {
          refreshed = false;
        }
        await Promise.allSettled([refreshServerCartRef.current(), refreshProductionData()]);
        if (!refreshed) showToast('刷新失败，请重新加购', 'error');
        return false;
      }
      if (current) patchActivePaymentSession({ stage: current.orderId ? 'recovery' : 'failed' });
      const message = error instanceof Error ? error.message : '订单服务暂时不可用';
      showToast(current?.orderId ? `支付状态需要确认：${message}` : `订单暂未创建：${message}`, current?.orderId ? 'warning' : 'error');
      return false;
    } finally {
      finishPaymentSubmission(paymentInFlightRef);
      setIsSubmittingOrder(false);
    }
  };

  const continueActivePayment = async (): Promise<void> => {
    const current = activePaymentSessionRef.current;
    if (!current) return;
    if (!current.orderId) {
      await submitSelectedCart(user, current.checkoutAddressId);
      return;
    }
    if (!tryBeginPaymentSubmission(paymentInFlightRef)) return;
    setIsSubmittingOrder(true);
    try {
      const productionApi = await loadProductionApi();
      if (current.paymentId) {
        const result = await productionApi.readPaymentResult(current.paymentId);
        recordPaymentResult(result);
        if (result.state === 'captured') return;
        if (result.action) {
          patchActivePaymentSession({ stage: 'opening-wechat' });
          await afterPaymentCarrierPaint();
          const { requestWechatJsapiPayment } = await import('../services/wechatJsapiPayment');
          await applyWechatOutcome(await requestWechatJsapiPayment(result.action, {
            onInvoked: () => { patchActivePaymentSession({ stage: 'wechat-active' }); },
          }), result.intentId);
          return;
        }
        if (result.state !== 'failed' && result.state !== 'expired') {
          patchActivePaymentSession({ stage: 'recovery' });
          return;
        }
      }
      const retryCount = current.stage === 'failed' || current.stage === 'expired' || current.stage === 'cancelled'
        ? current.retryCount + 1
        : Math.max(current.retryCount, 1);
      const retryIdempotencyKey = paymentRetryIdempotencyKey(current);
      patchActivePaymentSession({ stage: 'creating-payment', retryCount });
      const checkout = await productionApi.continuePayment({
        orderId: current.orderId,
        amountMinor: current.amountMinor,
        currency: current.currency,
        idempotencyKey: retryIdempotencyKey,
        onPaymentProgress: paymentProgress,
      });
      if (checkout.paymentState === 'captured') completeCapturedPayment(checkout.paymentId);
      else if (checkout.paymentState === 'reconciling') patchActivePaymentSession({ stage: 'recovery' });
      else await applyWechatOutcome(checkout.wechatOutcome, checkout.paymentId);
    } catch (error) {
      patchActivePaymentSession({ stage: 'recovery' });
      showToast(error instanceof Error ? error.message : '支付状态暂时无法确认', 'warning');
    } finally {
      finishPaymentSubmission(paymentInFlightRef);
      setIsSubmittingOrder(false);
    }
  };

  const checkoutSelectedCart = (addressId?: string): Promise<boolean> => submitSelectedCart(user, addressId);
  const refreshCheckoutAddresses = async (): Promise<void> => {
    if (!showcaseService && sessionStatus === 'authenticated') await refreshServerAddresses();
  };

  const completePaymentPhoneVerification = async (): Promise<void> => {
    const verifiedUser: UserProfile = {
      ...user,
      assuranceLevel: 'phone',
      phoneVerified: true,
      paymentEligible: true,
    };
    setUser(verifiedUser);
    setPaymentPhoneVerificationOpen(false);
    const verification = verificationAddressRef.current;
    verificationAddressRef.current = null;
    if (verification?.scope === currentPaymentScope) await submitSelectedCart(verifiedUser, verification.addressId);
  };

  const handleToggleFavorite = (productId: string) => {
    if (sessionStatus === 'authenticated') return void showToast('收藏功能即将开放', 'info');
    if (showcaseService) {
      const isFav = showcaseService.toggleFavorite(productId);
      setFavorites(showcaseService.getFavorites());
      showToast(isFav ? '已加入展示收藏夹' : '已取消展示收藏', isFav ? 'success' : 'info');
      return;
    }
    showToast('请先登录后再使用收藏功能', 'warning');
  };

  const handleAddAddress = async (address: Omit<DeliveryAddress, 'id'>): Promise<boolean> => {
    if (showcaseService) {
      setAddresses(showcaseService.addAddress(address));
      showToast('新增展示收货地址成功', 'success');
      return true;
    }
    if (sessionStatus === 'authenticated') {
      try {
        const productionApi = await loadProductionApi();
        await productionApi.upsertAddress({ ...address, id: '' });
        await refreshServerAddresses();
        showToast('收货地址已加密保存', 'success');
        return true;
      } catch (error) {
        showToast(error instanceof ProductionApiError ? error.message : '地址簿保存失败，请稍后重试', 'error');
        return false;
      }
    }
    showToast('请先登录后再管理收货地址', 'warning');
    return false;
  };

  const handleSetDefaultAddress = async (addressId: string): Promise<boolean> => {
    const target = addresses.find((address) => address.id === addressId);
    if (!target || target.isDefault) return Boolean(target);
    if (showcaseService) {
      setAddresses(showcaseService.setDefaultAddress(addressId));
      showToast('默认收货地址已更新', 'success');
      return true;
    }
    if (sessionStatus === 'authenticated') {
      try {
        await switchDefaultAddressOptimistically(
          addresses,
          addressId,
          async (address) => {
            const productionApi = await loadProductionApi();
            return productionApi.setDefaultAddress(address.id, address.version);
          },
          setAddresses,
        );
        showToast('默认收货地址已更新', 'success');
        void refreshServerAddresses().catch(() => showToast('默认地址已保存，地址簿稍后自动同步', 'info'));
        return true;
      } catch (error) {
        showToast(error instanceof ProductionApiError ? error.message : '默认地址更新失败，已恢复原状态', 'error');
        return false;
      }
    }
    showToast('请先登录后再管理收货地址', 'warning');
    return false;
  };

  const cartCount = cart.reduce((sum, item) => sum + item.quantity, 0);

  return (
    <MallContext.Provider
      value={{
        ...navigation,
        user,
        currentMall,
        malls,
        switchMall,
        refreshUserData,
        orders,
        products,
        presentationProducts,
        presentationOrders,
        mobileFulfillmentSimulationStage,
        setMobileFulfillmentSimulationStage,
        presentationCategories,
        accountLogs,
        sessionStatus,
        catalogSyncStatus,
        sessionError,
        login,
        logout,
        refreshProductionData,
        isSubmittingOrder,
        activePaymentId,
        activePaymentSession,
        closePaymentResult: () => {
          dismissedPaymentKeyRef.current = activePaymentSessionRef.current?.idempotencyKey ?? null;
          activatePaymentSession(null);
        },
        continueActivePayment,
        recordPaymentResult,
        checkoutSelectedCart,
        refreshCheckoutAddresses,
        cart,
        cartCount,
        addToCart: handleAddToCart,
        updateCartQuantity: handleUpdateCartQuantity,
        prepareCart,
        toggleCartItemSelected: handleToggleCartItemSelected,
        toggleSelectAllCart: handleToggleSelectAllCart,
        removeCartItem: handleRemoveCartItem,
        favorites,
        toggleFavorite: handleToggleFavorite,
        addresses,
        addAddress: handleAddAddress,
        setDefaultAddress: handleSetDefaultAddress,
        toasts,
        showToast,
        removeToast,
        quickViewProduct,
        setQuickViewProduct,
      }}
    >
      {children}
      {paymentPhoneVerificationOpen && sessionStatus === 'authenticated' && (
        <React.Suspense fallback={null}>
          <PaymentPhoneVerificationModal
            phone={user.phone}
            onClose={() => {
              verificationAddressRef.current = null;
              setPaymentPhoneVerificationOpen(false);
            }}
            onVerified={completePaymentPhoneVerification}
          />
        </React.Suspense>
      )}
    </MallContext.Provider>
  );
};

function afterPaymentCarrierPaint(): Promise<void> {
  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') return Promise.resolve();
  return new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())));
}

export const useMall = () => {
  const context = useContext(MallContext);
  if (!context) throw new Error('useMall must be used within a MallProvider');
  return context;
};
