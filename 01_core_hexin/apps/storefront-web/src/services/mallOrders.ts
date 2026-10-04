import type { CartItem, DeliveryAddress, Order, OrderStatus, UserCoupon } from '../types';
import { calculatePaymentAllocation } from '../utils/finance';
import { MallCatalogCart } from './mallCatalogCart';
import { STORAGE_KEYS } from './mallState';

export class MallOrders extends MallCatalogCart {
  // --- Order & Checkout Simulation ---
  public getOrders(statusFilter?: OrderStatus | 'all'): Order[] {
    if (!statusFilter || statusFilter === 'all') return [...this.orders];
    return this.orders.filter((o) => o.status === statusFilter);
  }

  public getOrderById(orderId: string): Order | undefined {
    return this.orders.find((o) => o.id === orderId || o.orderNo === orderId);
  }

  /**
   * 提交订单并模拟按不同供应商（第三方/自营/集团）进行逻辑拆单
   */
  public submitCheckoutOrder(params: {
    items: CartItem[];
    address?: DeliveryAddress;
    useWelfareAmount: number;
    useMealAmount: number;
    payMethod: 'welfare_plus_wechat' | 'wechat_only' | 'welfare_only';
    invoiceType?: 'none' | 'personal' | 'company';
    invoiceTitle?: string;
    invoiceTaxNo?: string;
    userRemark?: string;
  }): {
    parentOrderNo: string;
    subOrders: Order[];
    remainingWelfare: number;
    remainingMeal: number;
  } {
    const parentOrderNo = `PORD${Date.now()}`;

    // Group cart items by supplier
    const grouped = new Map<string, CartItem[]>();
    params.items.forEach((item) => {
      const supKey = item.product.supplierId;
      if (!grouped.has(supKey)) grouped.set(supKey, []);
      grouped.get(supKey)!.push(item);
    });

    // Calculate total order amount
    let totalGoodsAmount = 0;
    params.items.forEach((item) => {
      totalGoodsAmount += item.product.priceWelfare * item.quantity;
    });

    const allocation = calculatePaymentAllocation(totalGoodsAmount, params.useWelfareAmount, params.useMealAmount, this.user.welfareBalance, this.user.mealBalance);
    const welfareToDeduct = allocation.welfare;
    const mealToDeduct = allocation.meal;

    const subOrders: Order[] = [];
    let currentOrderSeq = 1;
    let welfareAllocationRemaining = welfareToDeduct;
    let mealAllocationRemaining = mealToDeduct;
    const supplierGroups = Array.from(grouped.entries());

    supplierGroups.forEach(([supplierId, supplierItems], groupIndex) => {
      const firstItem = supplierItems[0].product;
      const subOrderNo = `ORD${Date.now()}${String(currentOrderSeq).padStart(2, '0')}`;
      currentOrderSeq++;

      let subTotal = 0;
      supplierItems.forEach((i) => {
        subTotal += i.product.priceWelfare * i.quantity;
      });

      // Pro-rate welfare and meal deduction for sub-orders
      const isLastGroup = groupIndex === supplierGroups.length - 1;
      const ratio = totalGoodsAmount > 0 ? subTotal / totalGoodsAmount : 1;
      const subWelfare = Math.min(subTotal, isLastGroup ? welfareAllocationRemaining : Math.round(welfareToDeduct * ratio * 100) / 100);
      welfareAllocationRemaining = Math.max(0, Math.round((welfareAllocationRemaining - subWelfare) * 100) / 100);
      const subMeal = Math.min(subTotal - subWelfare, isLastGroup ? mealAllocationRemaining : Math.round(mealToDeduct * ratio * 100) / 100);
      mealAllocationRemaining = Math.max(0, Math.round((mealAllocationRemaining - subMeal) * 100) / 100);
      const subWechat = Math.max(0, subTotal - subWelfare - subMeal);

      const hasVirtualOrTicket = supplierItems.some((i) => i.product.itemType === 'virtual_coupon' || i.product.itemType === 'movie_ticket' || i.product.itemType === 'nearby_store');

      const newSubOrder: Order = {
        id: `ord_${Date.now()}_${currentOrderSeq}`,
        orderNo: subOrderNo,
        parentOrderNo,
        enterpriseId: this.user.enterpriseId,
        enterpriseName: this.user.enterpriseName,
        mallId: this.user.currentMallId,
        mallName: this.getCurrentMall().mallName,
        supplierId: firstItem.supplierId,
        supplierName: firstItem.supplierName,
        supplierType: firstItem.supplierType,
        status: 'pending_shipment', // auto paid in simulation
        createTime: new Date().toLocaleString('zh-CN', { hour12: false }),
        items: supplierItems.map((item) => {
          const specText = Object.entries(item.selectedSpec)
            .map(([k, v]) => `${k}:${v}`)
            .join(' ');
          const vCode = hasVirtualOrTicket ? `${item.product.itemType.toUpperCase()}-${Math.floor(1000 + Math.random() * 9000)}-${Math.floor(1000 + Math.random() * 9000)}` : undefined;
          return {
            productId: item.product.id,
            productTitle: item.product.title,
            productImage: item.product.images[0],
            price: item.product.priceWelfare,
            quantity: item.quantity,
            specText: specText || '默认规格',
            itemType: item.product.itemType,
            verificationCode: vCode,
          };
        }),
        address: params.address,
        payment: {
          totalGoodsAmount: subTotal,
          shippingFee: 0,
          welfareDeducted: subWelfare,
          mealDeducted: subMeal,
          wechatPaid: subWechat,
          finalPaidAmount: subTotal,
          payMethodText: subWechat > 0 ? `福利/餐扣抵扣(¥${(subWelfare + subMeal).toFixed(2)}) + 微信补差(¥${subWechat.toFixed(2)})` : '福利卡/餐卡全额抵扣',
          paidAt: new Date().toLocaleString('zh-CN', { hour12: false }),
        },
        invoice:
          params.invoiceType !== 'none'
            ? {
                type: params.invoiceType || 'personal',
                title: params.invoiceTitle,
                taxNumber: params.invoiceTaxNo,
              }
            : undefined,
        userRemark: params.userRemark,
        verificationCode: hasVirtualOrTicket ? `VERI-${Math.floor(100000 + Math.random() * 900000)}` : undefined,
        distributorId: this.user.distributorId,
      };

      // Generate Coupons if virtual or store item
      supplierItems.forEach((item) => {
        if (['virtual_coupon', 'movie_ticket', 'nearby_store', 'supermarket'].includes(item.product.itemType)) {
          const cpnCode = `${item.product.brand.toUpperCase()}-${Math.floor(1000 + Math.random() * 9000)}-${Math.floor(1000 + Math.random() * 9000)}`;
          const newCpn: UserCoupon = {
            id: `cpn_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
            type: item.product.itemType,
            title: item.product.title,
            faceValue: item.product.priceWelfare,
            code: cpnCode,
            expiryDate: '2027-12-31',
            status: 'unused',
            storeName: item.product.nearbyStoreInfo?.storeName,
            storeAddress: item.product.nearbyStoreInfo?.address,
            usageRules: ['凭借电子二维码或核销码到店/线上直接抵扣', '此卡券由企业福利账户统一兑换发码，免挂失'],
            sourceOrderNo: subOrderNo,
            distributorId: this.user.distributorId,
          };
          this.coupons.unshift(newCpn);
        }
      });

      subOrders.push(newSubOrder);
      this.orders.unshift(newSubOrder);
    });

    // Deduct user balances and create transaction logs
    if (welfareToDeduct > 0) {
      this.user.welfareBalance -= welfareToDeduct;
      this.logs.unshift({
        id: `log_${Date.now()}_w`,
        accountType: 'welfare',
        title: `订单合并下单福利卡扣款 (单号:${parentOrderNo})`,
        amount: -welfareToDeduct,
        direction: 'out',
        orderNo: parentOrderNo,
        time: new Date().toLocaleString('zh-CN', { hour12: false }),
        balanceAfter: this.user.welfareBalance,
        remark: '主打团福利卡账户支取',
      });
    }

    if (mealToDeduct > 0) {
      this.user.mealBalance -= mealToDeduct;
      this.logs.unshift({
        id: `log_${Date.now()}_m`,
        accountType: 'meal',
        title: `订单合并下单餐卡扣款 (单号:${parentOrderNo})`,
        amount: -mealToDeduct,
        direction: 'out',
        orderNo: parentOrderNo,
        time: new Date().toLocaleString('zh-CN', { hour12: false }),
        balanceAfter: this.user.mealBalance,
        remark: '主打团餐卡专享账户支取',
      });
    }

    this.user.couponCount = this.coupons.filter((c) => c.status === 'unused').length;

    // Save updated states
    this.saveUser();
    this.saveToStorage(this.getScopedKey(STORAGE_KEYS.ORDERS), this.orders);
    this.saveToStorage(this.getScopedKey(STORAGE_KEYS.LOGS), this.logs);
    this.saveToStorage(this.getScopedKey(STORAGE_KEYS.COUPONS), this.coupons);

    // Clear checked cart items
    this.clearSelectedCartItems();

    return {
      parentOrderNo,
      subOrders,
      remainingWelfare: this.user.welfareBalance,
      remainingMeal: this.user.mealBalance,
    };
  }

  public updateOrderStatus(orderId: string, status: OrderStatus): Order[] {
    const order = this.orders.find((o) => o.id === orderId || o.orderNo === orderId);
    if (order) {
      order.status = status;
      this.saveToStorage(this.getScopedKey(STORAGE_KEYS.ORDERS), this.orders);
    }
    return this.getOrders();
  }
}
