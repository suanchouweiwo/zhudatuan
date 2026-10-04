/**
 * 主打团企业福利商城 - 全局 TypeScript 类型定义
 * 技术服务方：雍彻科技
 */

export type WelfareAccountType = 'welfare' | 'meal' | 'wechat' | 'cash';

export type ProductItemType =
  | 'physical' // 实物商品
  | 'virtual_coupon' // 虚拟卡券
  | 'movie_ticket' // 电影票
  | 'supermarket' // 商超商品
  | 'life_service' // 生活服务
  | 'nearby_store'; // 附近门店核销

export type SupplierType = 'third_party' | 'self_operated' | 'group_owned';

export interface Supplier {
  id: string;
  name: string;
  type: SupplierType;
  code: string;
}

export interface ProductParam {
  key: string;
  value: string;
}

export interface ProductSpec {
  name: string;
  options: string[];
}

export interface NearbyStoreInfo {
  storeName: string;
  address: string;
  distance: string;
  businessHours: string;
  phone: string;
}

export interface Product {
  id: string;
  skuId?: string;
  title: string;
  subtitle: string;
  images: string[];
  priceMarket: number;
  priceMall: number;
  priceWelfare: number; // 企业福利专享价
  categoryId: string;
  categoryName: string;
  subCategoryId?: string;
  taxonomy?: {
    l1: string | null;
    l2: string | null;
    l3: string | null;
    status: string;
  };
  brand: string;
  tags: string[];
  supplierId: string;
  supplierName: string;
  supplierType: SupplierType;
  itemType: ProductItemType;
  allowedAccounts: WelfareAccountType[];
  stock: number;
  salesCount: number;
  rating: number;
  reviewCount: number;
  deliverySla: string; // 履约时效，如 "次日达", "即时发码", "1小时极速达"
  isEnterpriseExclusive?: boolean;
  isDailySpecial?: boolean;
  isHotRedeem?: boolean;
  isNewArrival?: boolean;
  isTest?: boolean;
  purchasable?: boolean;
  qualificationReason?: string;
  specs?: ProductSpec[];
  params?: ProductParam[];
  descriptionHtml?: string;
  descriptionDetailText?: string[];
  nearbyStoreInfo?: NearbyStoreInfo;

  // 预留分销商字段
  distributorId?: string;
}

export interface Category {
  id: string;
  name: string;
  iconName: string; // Lucide Icon identifier
  hotKeywords: string[];
  children?: {
    id: string;
    name: string;
    items: string[];
  }[];
}

export interface CartItem {
  id: string;
  productId: string;
  product: Product;
  quantity: number;
  selectedSpec: Record<string, string>;
  selected: boolean;

  // 预留分销商字段
  distributorId?: string;
}

export interface DeliveryAddress {
  id: string;
  name: string;
  phone: string;
  province: string;
  city: string;
  district: string;
  detail: string;
  isDefault: boolean;
  version?: number;
  tag?: string; // 如 "公司", "家庭"
}

export interface InvoiceInfo {
  type: 'none' | 'personal' | 'company';
  title?: string;
  taxNumber?: string;
  email?: string;
}

export type OrderStatus =
  | 'pending_payment' // 待付款
  | 'pending_shipment' // 待发货
  | 'pending_receipt' // 待收货
  | 'completed' // 已完成
  | 'after_sale'; // 售后中

export interface OrderItem {
  productId: string;
  productTitle: string;
  productImage: string;
  price: number;
  quantity: number;
  specText: string;
  itemType: ProductItemType;
  verificationCode?: string; // 虚拟券/门票核销码
}

export interface OrderPaymentDetail {
  totalGoodsAmount: number;
  shippingFee: number;
  welfareDeducted: number; // 福利卡扣减
  mealDeducted: number; // 餐卡扣减
  wechatPaid: number; // 微信支付/补差
  finalPaidAmount: number;
  payMethodText: string;
  paidAt?: string;
}

export interface Order {
  id: string;
  orderNo: string;
  parentOrderNo?: string;
  enterpriseId: string;
  enterpriseName: string;
  mallId: string;
  mallName: string;
  supplierId: string;
  supplierName: string;
  supplierType: SupplierType;
  status: OrderStatus;
  createTime: string;
  items: OrderItem[];
  address?: DeliveryAddress;
  payment: OrderPaymentDetail;
  invoice?: InvoiceInfo;
  userRemark?: string;
  trackingNo?: string;
  expressCompany?: string;
  verificationCode?: string; // 虚拟核销码/兑换码

  // 预留分销商字段
  distributorId?: string;
}

export interface AccountLog {
  id: string;
  accountType: 'welfare' | 'meal';
  title: string;
  amount: number; // 正数为充值/发放，负数为消费
  direction: 'in' | 'out';
  orderNo?: string;
  time: string;
  balanceAfter: number;
  remark?: string;
}

export type CouponStatus = 'unused' | 'used' | 'expired';

export interface UserCoupon {
  id: string;
  type: ProductItemType;
  title: string;
  faceValue: number;
  code: string;
  qrCodeUrl?: string;
  expiryDate: string;
  status: CouponStatus;
  storeName?: string;
  storeAddress?: string;
  usageRules: string[];
  sourceOrderNo?: string;

  // 预留分销商字段
  distributorId?: string;
}

export interface AfterSaleRecord {
  id: string;
  afterSaleNo: string;
  orderId: string;
  orderNo: string;
  supplierName: string;
  applyTime: string;
  reason: string;
  type: 'refund_only' | 'return_goods' | 'exchange';
  status: 'submitted' | 'processing' | 'completed' | 'rejected';
  refundAmount: number;
  description: string;
  items: OrderItem[];

  // 预留分销商字段
  distributorId?: string;
}

export interface EnterpriseMall {
  id: string;
  enterpriseId: string;
  enterpriseName: string;
  mallName: string;
  logoText: string;
  badge: string;
  welcomeBanner: string;

  // 预留分销商字段
  distributorId?: string;
}

export interface UserProfile {
  id: string;
  employeeId: string;
  name: string;
  avatar: string;
  phone: string;
  jobTitle: string;
  department: string;
  enterpriseId: string;
  enterpriseName: string;
  currentMallId: string;
  welfareBalance: number;
  mealBalance: number;
  couponCount: number;
  assuranceLevel: 'account' | 'phone';
  phoneVerified: boolean;
  paymentEligible: boolean;

  // 预留分销商字段
  distributorId?: string;
}
