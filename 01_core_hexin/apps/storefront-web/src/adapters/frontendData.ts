import { canonicalizeProductBrand } from '../domain/brand/productBrand';
import type { Category, Order, OrderItem, OrderStatus, Product } from '../types';

export type FrontendProduct = Product & {
  imageUrl: string;
  image: string;
  gallery: string[];
  price: number;
  originalPrice: number;
  enterpriseSubsidyAmount: number;
  stockCount: number;
  description: string;
  parameters: Record<string, string>;
  specOptions: Record<string, string[]>;
  allowMealCard: boolean;
  isEnterpriseSubsidized: boolean;
  welfarePrice: number;
  marketPrice: number;
  salesVolume: number;
  applicableStoreName: string;
  category: string;
};

export type FrontendCategory = Category & {
  icon: string;
  description: string;
  subCategories: NonNullable<Category['children']>;
};

export type FrontendOrderItem = OrderItem & {
  product: FrontendProduct;
  priceAtPurchase: number;
};

export type FrontendOrder = Omit<Order, 'items' | 'status'> & {
  orderId: string;
  createdAt: string;
  totalAmount: number;
  welfareDeduction: number;
  statusText: string;
  status: OrderStatus | 'shipping' | 'shipped' | 'paid' | 'pending_pay';
  items: FrontendOrderItem[];
};

function toSpecOptions(product: Product): Record<string, string[]> {
  return Object.fromEntries((product.specs ?? []).map((spec) => [spec.name, spec.options]));
}

function toParameters(product: Product): Record<string, string> {
  return Object.fromEntries((product.params ?? []).map((parameter) => [parameter.key, parameter.value]));
}

export function toFrontendProduct(product: Product): FrontendProduct {
  const primaryImage = product.images[0] ?? '';
  return {
    ...product,
    title: canonicalizeProductBrand(product.title),
    subtitle: canonicalizeProductBrand(product.subtitle),
    brand: canonicalizeProductBrand(product.brand),
    imageUrl: primaryImage,
    image: primaryImage,
    gallery: product.images.slice(1),
    price: product.priceWelfare,
    originalPrice: product.priceMarket,
    enterpriseSubsidyAmount: Math.max(0, Number((product.priceMarket - product.priceWelfare).toFixed(2))),
    stockCount: product.stock,
    description: canonicalizeProductBrand(product.descriptionDetailText?.join(' ') ?? product.subtitle ?? 'MORVIA 主打团商城严选商品。'),
    parameters: toParameters(product),
    specOptions: toSpecOptions(product),
    allowMealCard: product.allowedAccounts.includes('meal'),
    isEnterpriseSubsidized: Boolean(product.isEnterpriseExclusive),
    welfarePrice: product.priceWelfare,
    marketPrice: product.priceMarket,
    salesVolume: product.salesCount,
    applicableStoreName: product.nearbyStoreInfo?.storeName ?? product.supplierName,
    category: product.categoryName,
  };
}

function statusText(status: OrderStatus): string {
  const labels: Record<OrderStatus, string> = {
    pending_payment: '待付款',
    pending_shipment: '待发货',
    pending_receipt: '待收货',
    completed: '已完成',
    after_sale: '售后中',
  };
  return labels[status];
}

export function toFrontendProducts(products: Product[]): FrontendProduct[] {
  return products.map(toFrontendProduct);
}

const CATEGORY_ICONS: Record<string, string> = {
  cat_food: 'UtensilsCrossed',
  cat_appliance: 'Tv',
  cat_digital: 'Laptop',
  cat_home: 'Home',
  cat_personal: 'Sparkles',
  cat_movie: 'Film',
  cat_virtual: 'CreditCard',
  cat_supermarket: 'ShoppingBag',
  cat_life: 'Store',
  cat_welfare_zone: 'Gift',
};

const STOREFRONT_CATEGORY_SKELETON = [
  { id: 'cat_welfare_zone', name: '福利品' },
  { id: 'cat_food', name: '食品饮料' },
  { id: 'cat_appliance', name: '家用电器' },
  { id: 'cat_digital', name: '数码办公' },
  { id: 'cat_home', name: '家居日用' },
  { id: 'cat_personal', name: '个护清洁' },
  { id: 'cat_supermarket', name: '商超商品' },
  { id: 'cat_apparel', name: '服饰鞋包' },
  { id: 'cat_virtual', name: '虚拟卡券' },
  { id: 'cat_movie', name: '电影娱乐' },
  { id: 'cat_life', name: '生活服务' },
] as const;

export function toFrontendCategories(products: Product[]): FrontendCategory[] {
  const categories = new Map<string, { name: string; titles: Set<string>; keywords: Set<string> }>();

  STOREFRONT_CATEGORY_SKELETON.forEach((category) => {
    categories.set(category.id, {
      name: category.name,
      titles: new Set<string>(),
      keywords: new Set<string>(),
    });
  });

  products.forEach((product) => {
    const category = categories.get(product.categoryId) ?? {
      name: product.categoryName,
      titles: new Set<string>(),
      keywords: new Set<string>(),
    };
    category.titles.add(product.title);
    [product.brand, ...product.tags].filter(Boolean).forEach((keyword) => category.keywords.add(keyword));
    categories.set(product.categoryId, category);
  });

  return [...categories.entries()].map(([id, category]) => {
    const hotKeywords = [...category.titles, ...category.keywords].slice(0, 3);
    const iconName = CATEGORY_ICONS[id] ?? 'Gift';
    return {
      id,
      name: category.name,
      iconName,
      hotKeywords,
      children: [],
      icon: iconName,
      description: hotKeywords.join(' · '),
      subCategories: [],
    };
  });
}

function productFromOrderSnapshot(order: Order, item: OrderItem): FrontendProduct {
  return toFrontendProduct({
    id: item.productId,
    title: item.productTitle,
    subtitle: '历史订单商品快照',
    images: item.productImage ? [item.productImage] : [],
    priceMarket: item.price,
    priceMall: item.price,
    priceWelfare: item.price,
    categoryId: 'order_snapshot',
    categoryName: '历史订单',
    brand: order.supplierName,
    tags: [],
    supplierId: order.supplierId,
    supplierName: order.supplierName,
    supplierType: order.supplierType,
    itemType: item.itemType,
    allowedAccounts: [],
    stock: 0,
    salesCount: 0,
    rating: 0,
    reviewCount: 0,
    deliverySla: '以订单履约记录为准',
    purchasable: false,
  });
}

export function toFrontendOrders(orders: Order[], products: FrontendProduct[]): FrontendOrder[] {
  return orders.map((order) => ({
    ...order,
    orderId: order.id,
    createdAt: order.createTime,
    totalAmount: order.payment.finalPaidAmount,
    welfareDeduction: order.payment.welfareDeducted,
    statusText: statusText(order.status),
    items: order.items.map((item) => {
      const product = products.find((candidate) => candidate.id === item.productId) ?? productFromOrderSnapshot(order, item);
      return {
        ...item,
        product: {
          ...product,
          id: item.productId,
          title: item.productTitle,
          images: [item.productImage],
          image: item.productImage,
          imageUrl: item.productImage,
          price: item.price,
          priceMarket: item.price,
          priceMall: item.price,
          priceWelfare: item.price,
          originalPrice: item.price,
          welfarePrice: item.price,
          marketPrice: item.price,
          itemType: item.itemType,
        },
        priceAtPurchase: item.price,
      };
    }),
  }));
}
