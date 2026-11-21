import type { FrontendOrder, FrontendOrderItem, FrontendProduct } from '../../adapters/frontendData';
import type { MobileFulfillmentStage } from '../../context/MallContext';

export type MobileInventoryStatus = 'available' | 'tight' | 'unavailable' | 'pending';

export interface MobileInventoryProduct {
  purchasable?: boolean;
  stock?: number;
  stockCount?: number;
}

export interface MobileMerchantPackage {
  id: string;
  merchantName: string;
  items: FrontendOrderItem[];
  statusLabel: string;
  deliveryHint: string;
}

export function mobileOrderPayableAmount(order: FrontendOrder): number {
  if (order.payment.wechatPayableMinor !== undefined) return order.payment.wechatPayableMinor / 100;
  if (order.payment.wechatPaid > 0) return order.payment.wechatPaid;
  const payableTotal = order.payment.totalGoodsAmount + order.payment.shippingFee;
  const orderTotal = payableTotal > 0 ? payableTotal : order.totalAmount;
  return Math.max(0, orderTotal - order.payment.welfareDeducted - order.payment.mealDeducted);
}

export function inventoryStatus(product: MobileInventoryProduct): MobileInventoryStatus {
  const stockCount = product.stockCount ?? product.stock ?? 0;
  if (!product.purchasable && stockCount === 0) return 'pending';
  if (stockCount <= 0) return 'unavailable';
  if (stockCount <= 8) return 'tight';
  return 'available';
}

export function groupOrderPackages(order: FrontendOrder, fulfillmentStage: MobileFulfillmentStage | null = null): MobileMerchantPackage[] {
  const groups = new Map<string, FrontendOrderItem[]>();
  order.items.forEach((item) => {
    const merchantName = item.product.supplierName || order.supplierName || order.mallName;
    groups.set(merchantName, [...(groups.get(merchantName) ?? []), item]);
  });

  return [...groups.entries()].map(([merchantName, items], index) => ({
    id: `${order.id}-package-${index + 1}`,
    merchantName,
    items,
    statusLabel: packageStatusLabel(order.status, fulfillmentStage),
    deliveryHint: packageDeliveryHint(order, index, fulfillmentStage),
  }));
}

function packageStatusLabel(status: FrontendOrder['status'], fulfillmentStage: MobileFulfillmentStage | null): string {
  if (fulfillmentStage === 'processing') return '备货中';
  if (fulfillmentStage === 'shipped') return '运输中';
  if (fulfillmentStage === 'received') return '已收货';
  if (status === 'pending_payment' || status === 'pending_pay') return '待付款';
  if (status === 'pending_shipment' || status === 'paid') return '备货中';
  if (status === 'pending_receipt' || status === 'shipping' || status === 'shipped') return '运输中';
  if (status === 'completed') return '已签收';
  return '售后处理中';
}

function packageDeliveryHint(order: FrontendOrder, index: number, fulfillmentStage: MobileFulfillmentStage | null): string {
  if (fulfillmentStage === 'received') return '包裹已签收，等待订单完成';
  if (fulfillmentStage === 'shipped' && order.trackingNo) return `${order.expressCompany || '承运方'} · ${order.trackingNo}`;
  if (fulfillmentStage === 'shipped') return '包裹运输中，物流信息持续更新';
  if (order.trackingNo) return `${order.expressCompany || '承运方'} · ${order.trackingNo}`;
  if (order.status === 'pending_payment' || order.status === 'pending_pay') return '付款后由商户独立安排配送';
  if (order.status === 'completed') return '包裹已完成签收';
  if (order.status === 'after_sale') return '售后进度将同步到本包裹';
  return index === 0 ? '预计 24 小时内更新物流' : '等待商户确认发货时间';
}
