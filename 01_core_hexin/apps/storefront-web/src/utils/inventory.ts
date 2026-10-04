/**
 * 主打团企业福利商城 - 库存/可购买状态统一口径
 */

export const STOCK_TEXT = {
  testProduct: '测试商品',
  outOfStock: '缺货',
  unavailable: '库存异常',
  inStock: (stock: number): string => `现货 ${stock} 件`,
  canOrder: '可下单',
  canOrderNow: '可立即下单',
  insufficientInCheckout: '库存不足',
} as const;

export type InventoryStatus = {
  canPurchase: boolean;
  stockText: string;
  badgeText: string;
  availabilityText: string;
  actionButtonStateText: string;
};

export const getInventoryStatus = (stock: number, isTest: boolean): InventoryStatus => {
  if (isTest) {
    return {
      canPurchase: false,
      stockText: STOCK_TEXT.testProduct,
      badgeText: STOCK_TEXT.testProduct,
      availabilityText: STOCK_TEXT.unavailable,
      actionButtonStateText: '测试商品不支持购买',
    };
  }

  if (stock <= 0) {
    return {
      canPurchase: false,
      stockText: STOCK_TEXT.outOfStock,
      badgeText: STOCK_TEXT.outOfStock,
      availabilityText: STOCK_TEXT.unavailable,
      actionButtonStateText: STOCK_TEXT.insufficientInCheckout,
    };
  }

  return {
    canPurchase: true,
    stockText: STOCK_TEXT.inStock(stock),
    badgeText: STOCK_TEXT.canOrder,
    availabilityText: `可立即发货（库存 ${stock} 件）`,
    actionButtonStateText: STOCK_TEXT.canOrderNow,
  };
};

export const getOutOfStockActionHint = (count: number): string => `有 ${count} 件商品库存异常，提交前请返回购物车逐一修正数量。`;
