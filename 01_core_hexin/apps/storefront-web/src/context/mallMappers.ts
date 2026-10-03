import type { CartItem, Order, OrderStatus, Product, ProductItemType } from '../types';
import { isStrictTaxonomyPath } from '../domain/catalog/taxonomy';
import type { ApiCartItem, ApiOrder, ApiProduct } from '../services/productionApi';

const CATEGORY_MAP: Record<string, { id: string; name: string }> = {
  food: { id: 'cat_food', name: '食品饮料' },
  appliance: { id: 'cat_appliance', name: '家用电器' },
  digital: { id: 'cat_digital', name: '数码办公' },
  home: { id: 'cat_home', name: '家居日用' },
  personal: { id: 'cat_personal', name: '个护清洁' },
  supermarket: { id: 'cat_supermarket', name: '商超商品' },
  apparel: { id: 'cat_apparel', name: '服饰鞋包' },
  welfare: { id: 'cat_welfare_zone', name: '福利品' },
  'virtual-card': { id: 'cat_virtual', name: '虚拟卡券' },
  movie: { id: 'cat_movie', name: '电影娱乐' },
  life: { id: 'cat_life', name: '生活服务' },
};

const FALLBACK_IMAGE = 'https://images.unsplash.com/photo-1607082349566-187342175e2f?w=600&auto=format&fit=crop&q=80';

export function mapApiProduct(product: ApiProduct): Product {
  const taxonomy = product.taxonomy;
  const strictPath = isStrictTaxonomyPath(taxonomy?.l1 ?? null, taxonomy?.l2 ?? null, taxonomy?.l3 ?? null);
  const category = CATEGORY_MAP[strictPath ? taxonomy!.l1! : product.categoryCode] ?? {
    id: 'cat_welfare_zone',
    name: '福利品',
  };
  const isVirtual = product.categoryCode === 'virtual-card';
  return {
    id: product.id,
    skuId: product.skuId,
    title: product.nameZh ?? product.name,
    subtitle: product.subtitleZh ?? product.subtitle ?? 'MORVIA 主打团严选商品',
    images: [product.coverUrl ?? FALLBACK_IMAGE],
    priceMarket: (product.marketPriceCents ?? product.priceCents) / 100,
    priceMall: product.priceCents / 100,
    priceWelfare: product.priceCents / 100,
    categoryId: category.id,
    categoryName: category.name,
    taxonomy: product.taxonomy,
    brand: product.supplierName,
    tags: ['企业严选', '正品保障'],
    supplierId: `supplier-${product.supplierName}`,
    supplierName: product.supplierName,
    supplierType: product.supplierName.includes('央企') ? 'group_owned' : 'third_party',
    itemType: isVirtual ? 'virtual_coupon' : 'physical',
    allowedAccounts: isVirtual ? ['welfare', 'wechat'] : ['welfare', 'meal', 'wechat'],
    stock: product.availableStock,
    salesCount: 0,
    rating: 5,
    reviewCount: 0,
    deliverySla: isVirtual ? '支付成功后即时发放' : '供应商履约时效为准',
    isEnterpriseExclusive: true,
    isTest: product.isTest,
    purchasable: product.purchasable,
    qualificationReason: product.qualification.purchaseReason,
    specs: [{ name: '标准规格', options: ['默认规格'] }],
    descriptionDetailText: ['商品信息来自生产型商品目录，最终履约规则以供应商确认结果为准。'],
  };
}

export function mapApiCartItems(items: ApiCartItem[], products: Product[]): CartItem[] {
  return items.flatMap((item) => {
    const product = products.find((candidate) => candidate.id === item.productId && candidate.skuId === item.skuId);
    if (!product) return [];
    const qualifiedProduct = item.purchasable === false ? { ...product, purchasable: false, qualificationReason: item.qualification?.purchaseReason } : product;
    return [
      {
        id: item.id,
        productId: item.productId,
        product: qualifiedProduct,
        quantity: item.quantity,
        selectedSpec: {},
        selected: item.selected && item.purchasable !== false,
      },
    ];
  });
}

export function mapApiOrder(order: ApiOrder, scope: { enterpriseId: string; enterpriseName: string; mallId: string; mallName: string }): Order {
  const statusMap: Record<string, OrderStatus> = {
    pending_payment: 'pending_payment',
    paid: 'pending_shipment',
    processing: 'pending_shipment',
    shipped: 'pending_receipt',
    completed: 'completed',
    cancelled: 'completed',
    refund_pending: 'after_sale',
    refunded: 'after_sale',
  };
  return {
    id: order.id,
    orderNo: order.orderNo,
    enterpriseId: scope.enterpriseId,
    enterpriseName: scope.enterpriseName,
    mallId: scope.mallId,
    mallName: scope.mallName,
    supplierId: 'multi-supplier',
    supplierName: '供应商拆单汇总',
    supplierType: 'third_party',
    status: statusMap[order.status] ?? 'pending_payment',
    createTime: order.createdAt,
    items: (order.items ?? []).map((item) => ({
      productId: item.productId,
      productTitle: item.productTitle,
      productImage: item.productImage ?? FALLBACK_IMAGE,
      price: item.priceCents / 100,
      quantity: item.quantity,
      specText:
        Object.entries(item.specs ?? {})
          .map(([key, value]) => `${key}：${value}`)
          .join('；') || '标准规格',
      itemType: item.itemType as ProductItemType,
    })),
    payment: {
      totalGoodsAmount: order.goodsAmountCents / 100,
      shippingFee: 0,
      welfareDeducted: (order.welfarePaidCents ?? order.paidCents) / 100,
      mealDeducted: (order.mealPaidCents ?? 0) / 100,
      wechatPaid: 0,
      finalPaidAmount: order.paidCents / 100,
      payMethodText: order.paidCents > 0 ? '内部福利账户支付' : '待支付',
    },
  };
}
