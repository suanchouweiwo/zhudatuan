import type { Dispatch, SetStateAction } from 'react';
import type { AccountLog, CartItem, DeliveryAddress, EnterpriseMall, Order, OrderStatus, Product, ProductItemType, UserProfile } from '../types';
import type { FrontendCategory, FrontendOrder, FrontendProduct } from '../adapters/frontendData';
import type { ApiPaymentResult } from '../services/productionApi.types';
import type { PaymentRecoveryRecord } from '../services/paymentRecovery';

export type SessionStatus = 'checking' | 'guest' | 'authenticated';
export type CatalogSyncStatus = 'idle' | 'syncing' | 'ready' | 'error';
export type ViewportMode = 'auto' | 'laptop-1366' | 'desktop-1440' | 'side-by-side';
export type AppMode = 'pc' | 'mini-program' | 'android-app' | 'tablet-app' | 'laptop-web';
export type AppModeSwitchOptions = { preservePath?: boolean };
export type MiniProgramPage = 'home' | 'category' | 'welfare' | 'detail' | 'cart' | 'orders' | 'profile' | 'address';
export type AndroidAppPage = 'home' | 'search' | 'detail' | 'checkout' | 'orders' | 'profile';
export type TabletPage = 'home' | 'category' | 'detail' | 'cart' | 'orders' | 'profile';
export type TabletOrientation = 'landscape' | 'portrait';
export type LaptopPage = 'home-1366' | 'home-1440' | 'category' | 'detail' | 'cart' | 'orders' | 'member' | 'account-security';
export type MobileFulfillmentStage = 'processing' | 'shipped' | 'received';

export interface PendingFeatureInfo {
  isOpen: boolean;
  featureName: string;
  desc?: string;
}

export type PageRoute = 'home' | 'category' | 'detail' | 'cart' | 'checkout' | 'payment-result' | 'user-center' | 'orders' | 'order-detail' | 'after-sale' | 'coupons' | 'balance' | 'mvp-console' | 'mvp-delivery' | 'architecture';

export interface RouteParams {
  productId?: string;
  orderId?: string;
  parentOrderNo?: string;
  keyword?: string;
  categoryId?: string;
  itemType?: ProductItemType | 'all';
  statusFilter?: OrderStatus | 'all';
  accountTab?: 'welfare' | 'meal';
}

export interface ToastMessage {
  id: string;
  type: 'success' | 'info' | 'error' | 'warning';
  text: string;
  channel?: 'default' | 'cart';
}

export interface ToastOptions {
  channel?: ToastMessage['channel'];
  durationMs?: number;
}

export interface LoginCredentials {
  accessCode?: string;
  username?: string;
  password?: string;
}

export interface MallContextType {
  appMode: AppMode;
  setAppMode: (mode: AppMode, options?: AppModeSwitchOptions) => void;
  viewportMode: ViewportMode;
  setViewportMode: (mode: ViewportMode) => void;
  mpPage: MiniProgramPage;
  mpAddressReturnPage: 'cart' | 'profile';
  setMpPage: (page: MiniProgramPage, productId?: string) => void;
  androidPage: AndroidAppPage;
  setAndroidPage: (page: AndroidAppPage, productId?: string) => void;
  tabletPage: TabletPage;
  setTabletPage: (page: TabletPage, productId?: string) => void;
  tabletOrientation: TabletOrientation;
  setTabletOrientation: (orientation: TabletOrientation) => void;
  laptopPage: LaptopPage;
  setLaptopPage: (page: LaptopPage, productId?: string) => void;
  mobileProductId: string;
  setMobileProductId: Dispatch<SetStateAction<string>>;
  pendingFeature: PendingFeatureInfo;
  triggerPendingFeature: (featureName: string, desc?: string) => void;
  closePendingFeatureModal: () => void;
  currentPage: PageRoute;
  routeParams: RouteParams;
  navigateTo: (page: PageRoute, params?: RouteParams) => void;
  user: UserProfile;
  currentMall: EnterpriseMall;
  malls: EnterpriseMall[];
  switchMall: (mallId: string) => void;
  refreshUserData: () => void;
  orders: Order[];
  products: Product[];
  presentationProducts: FrontendProduct[];
  presentationOrders: FrontendOrder[];
  mobileFulfillmentSimulationStage: MobileFulfillmentStage | null;
  setMobileFulfillmentSimulationStage: Dispatch<SetStateAction<MobileFulfillmentStage | null>>;
  presentationCategories: FrontendCategory[];
  accountLogs: AccountLog[];
  sessionStatus: SessionStatus;
  catalogSyncStatus: CatalogSyncStatus;
  sessionError: string | null;
  login: (credentials: LoginCredentials) => Promise<boolean>;
  logout: () => Promise<void>;
  refreshProductionData: () => Promise<void>;
  isSubmittingOrder: boolean;
  activePaymentId: string | null;
  activePaymentSession: PaymentRecoveryRecord | null;
  closePaymentResult: () => void;
  continueActivePayment: () => Promise<void>;
  recordPaymentResult: (result: ApiPaymentResult) => void;
  checkoutSelectedCart: (addressId?: string) => Promise<boolean>;
  refreshCheckoutAddresses: () => Promise<void>;
  cart: CartItem[];
  cartCount: number;
  addToCart: (product: Product, quantity?: number, selectedSpec?: Record<string, string>) => boolean;
  updateCartQuantity: (cartItemId: string, quantity: number) => boolean;
  prepareCart: () => void;
  toggleCartItemSelected: (cartItemId: string) => void;
  toggleSelectAllCart: (selected: boolean) => void;
  removeCartItem: (cartItemId: string) => Promise<void>;
  favorites: string[];
  toggleFavorite: (productId: string) => void;
  addresses: DeliveryAddress[];
  addAddress: (address: Omit<DeliveryAddress, 'id'>) => Promise<boolean>;
  setDefaultAddress: (addressId: string) => Promise<boolean>;
  toasts: readonly ToastMessage[];
  showToast: (text: string, type?: ToastMessage['type'], options?: ToastOptions) => void;
  removeToast: (id: string) => void;
  quickViewProduct: Product | null;
  setQuickViewProduct: Dispatch<SetStateAction<Product | null>>;
}
