/** Public transport contracts for the browser-to-commerce API boundary. */
export interface ApiProduct {
  id: string;
  skuId: string;
  name: string;
  nameEn?: string | null;
  nameZh?: string | null;
  subtitle: string | null;
  subtitleEn?: string | null;
  subtitleZh?: string | null;
  categoryCode: string;
  taxonomy?: { l1: string | null; l2: string | null; l3: string | null; status: string };
  coverUrl: string | null;
  priceCents: number;
  marketPriceCents: number | null;
  availableStock: number;
  supplierName: string;
  isTest: boolean;
  purchasable: boolean;
  qualification: {
    visible: boolean;
    purchasable: boolean;
    visibilityReason: string;
    purchaseReason: string;
    policyVersion?: number;
    matchedPolicyIds?: string[];
    cityZoneIds?: string[];
    limitTemplateIds?: string[];
  };
}

export interface ApiOrder {
  id: string;
  orderNo: string;
  status: string;
  goodsAmountCents: number;
  discountCents: number;
  payableCents: number;
  paidCents: number;
  welfarePaidCents?: number;
  mealPaidCents?: number;
  createdAt: string;
  updatedAt: string;
  items?: Array<{ productId: string; productTitle: string; productImage: string | null; priceCents: number; quantity: number; specs: Record<string, string>; itemType: string }>;
}

export type ApiPaymentResultState = 'preparing' | 'pending' | 'recovery' | 'captured' | 'failed' | 'expired';
export interface ApiPaymentResult {
  intentId: string;
  orderId: string;
  paymentId: string;
  state: ApiPaymentResultState;
  paymentState: string | null;
  amountMinor: number;
  currency: string;
  action: Readonly<Record<string, string>> | null;
  expiresAt: string;
  retryAfter: 0 | 5;
}

export interface ApiAccount {
  id: string;
  type: 'welfare' | 'meal';
  balanceCents: number;
  status: string;
  updatedAt: string;
}
export interface ApiAccountLedger {
  id: string;
  accountType: 'welfare' | 'meal';
  direction: 'credit' | 'debit';
  amountCents: number;
  balanceAfterCents: number;
  businessType: string;
  businessId: string;
  orderNo: string | null;
  createdAt: string;
}
export interface ApiCartItem {
  id: string;
  skuId: string;
  productId: string;
  quantity: number;
  selected: boolean;
  updatedAt: string;
  purchasable?: boolean;
  qualification?: { purchaseReason?: string };
}
export interface ApiDeliveryAddress {
  id: string;
  name: string;
  phone: string;
  province: string;
  city: string;
  district: string;
  detail: string;
  tag?: string;
  isDefault: boolean;
  version?: number;
}
export interface ApiAfterSale {
  id: string;
  afterSaleNo: string;
  orderId: string;
  orderNo: string;
  type: 'refund_only' | 'return_refund' | 'exchange';
  status: string;
  reason: string;
  requestedAmountCents: number;
  createdAt: string;
  updatedAt: string;
}
export interface ApiActor {
  userId: string;
  identityCode?: string;
  employeeNo: string;
  displayName: string;
  departmentName: string | null;
  phoneMasked: string | null;
  roles: string[];
  permissions: string[];
}
export interface ApiMemberAssurance {
  level: 'account' | 'phone';
  accountAuthenticated: boolean;
  accountAuthenticatedAt: string;
  phoneVerified: boolean;
  phoneVerifiedAt: string | null;
  phoneVerificationMethod: string | null;
  paymentEligible: boolean;
  restrictedCapabilities: string[];
}
export interface ApiSecuritySession {
  id: string;
  target: 'storefront' | 'admin';
  deviceLabel: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  current: boolean;
}
export interface ApiSecurityCenter {
  hasLocalCredential: boolean;
  phoneMasked: string | null;
  passwordChangedAt: string | null;
  assuranceLevel: 'account' | 'phone';
  accountAuthenticated: boolean;
  accountAuthenticatedAt: string | null;
  phoneVerified: boolean;
  phoneVerifiedAt: string | null;
  paymentEligible: boolean;
  restrictedCapabilities: string[];
  phoneVerificationAvailable: boolean;
  sessions: ApiSecuritySession[];
}
export interface LoginRequest {
  accessCode?: string;
  username?: string;
  password?: string;
}
export interface ApiBootstrap {
  actor: ApiActor & { assurance: ApiMemberAssurance };
  scope: { tenantId: string; enterpriseId: string; mallId: string; mallCode: string; mallName: string; brandName: string; enterpriseName: string };
}
export interface ApiHomeSnapshot {
  bootstrap: ApiBootstrap;
  accounts: { items: ApiAccount[] };
  orders: { items: ApiOrder[] };
  accountLedgers: { items: ApiAccountLedger[] };
}
export interface CreateOrderRequest {
  items: Array<{ skuId: string; quantity: number }>;
  recipient: { name: string; mobile: string; province: string; city: string; district: string; address: string };
}
