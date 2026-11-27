import React, { useState } from 'react';
import { useMall } from '../../context/MallContext';
import { ArrowLeft, FileText, Truck, Download } from 'lucide-react';
import type { OrderStatus } from '../../types';
import { STOREFRONT_WEB_SURFACE_COPY, type StorefrontWebSurface } from './StorefrontWebStandard';

interface LaptopOrdersPageProps {
  onReturnToCheckout?: () => void;
  surface?: StorefrontWebSurface;
}

type OrderFilter = 'all' | 'unpaid' | 'shipping' | 'completed';

const orderFilters: ReadonlyArray<{ id: OrderFilter; name: string; statuses: readonly OrderStatus[] }> = [
  { id: 'all', name: '全部企采订单', statuses: [] },
  { id: 'unpaid', name: '待付款 / 待划扣', statuses: ['pending_payment'] },
  { id: 'shipping', name: '待发货 / 运输中', statuses: ['pending_shipment', 'pending_receipt'] },
  { id: 'completed', name: '已完成 / 已开票', statuses: ['completed'] },
];

export const LaptopOrdersPage: React.FC<LaptopOrdersPageProps> = ({ onReturnToCheckout, surface = 'laptop' }) => {
  const { triggerPendingFeature, presentationOrders, continueOrderPayment, isSubmittingOrder } = useMall();
  const surfaceCopy = STOREFRONT_WEB_SURFACE_COPY[surface];
  const [activeStatus, setActiveStatus] = useState<OrderFilter>('all');
  const [orderToPay, setOrderToPay] = useState<string>();

  const tabs = orderFilters.map((filter) => ({
    ...filter,
    orders: filter.id === 'all'
      ? presentationOrders
      : presentationOrders.filter((order) => filter.statuses.includes(order.status)),
  }));
  const filteredOrders = tabs.find((tab) => tab.id === activeStatus)?.orders ?? presentationOrders;

  return (
    <div className="w-full bg-[#F5F7FA] min-h-[80vh] pb-8 font-sans">
      <div className="sw-web-container max-w-[1240px] mx-auto pt-3 px-3 space-y-3">
        {onReturnToCheckout && (
          <button type="button" onClick={onReturnToCheckout} className="flex items-center gap-1.5 rounded-sm text-xs font-semibold text-[var(--sw-brand)] hover:underline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-[var(--sw-brand)]">
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />返回结算页
          </button>
        )}
        {/* 页头标题 */}
        <div className="flex items-center justify-between text-xs border-b border-gray-200 pb-2">
          <div className="flex items-center gap-2">
            <FileText className="w-4 h-4 text-[var(--sw-brand)]" />
            <h1 className="font-extrabold text-sm text-gray-900">国家电网员工福利订单中心</h1>
          </div>
          <span className="text-gray-400">{surfaceCopy.ordersLayoutLabel}</span>
        </div>

        {/* 订单筛选与主表格两栏 */}
        <div className="sw-web-orders-grid grid grid-cols-1 md:grid-cols-12 gap-3 items-start">
          {/* 左侧状态导航 (3列) */}
          <div className="sw-web-orders-sidebar md:col-span-3 bg-white border border-gray-200 rounded-lg p-2.5 shadow-2xs space-y-1 text-xs">
            <div className="font-bold text-gray-800 pb-2 border-b border-gray-100 text-[11px] uppercase tracking-wider text-gray-400">订单状态筛选</div>

            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveStatus(tab.id)}
                className={`w-full text-left px-2.5 py-2 rounded font-bold cursor-pointer transition-colors flex items-center justify-between ${activeStatus === tab.id ? 'bg-[var(--sw-brand)] text-white' : 'hover:bg-gray-100 text-gray-700'}`}
              >
                <span>{tab.name}</span>
                <span className={`text-[10px] px-1.5 py-0.2 rounded-full font-bold ${activeStatus === tab.id ? 'bg-white/20 text-white' : 'bg-gray-100 text-gray-600'}`}>{tab.orders.length}</span>
              </button>
            ))}

            <div className="pt-2 border-t border-gray-100 text-[10px] text-gray-400">发票随订单自动下载开具电子专票</div>
          </div>

          {/* 右侧订单卡片列表 (9列) */}
          <div className="sw-web-orders-list md:col-span-9 space-y-2.5">
            {filteredOrders.map((order) => (
              <div key={order.orderId} className="bg-white border border-gray-200 rounded-lg shadow-2xs overflow-hidden text-xs">
                {/* 订单头部信息 */}
                <div className="bg-gray-50 px-3 py-2 border-b border-gray-200 flex items-center justify-between text-[11px] text-gray-600 flex-wrap gap-2">
                  <div className="flex items-center gap-3">
                    <span className="font-bold text-gray-900">订单号: {order.orderNo}</span>
                    <span>下单时间: {order.createdAt}</span>
                    <span className="bg-blue-50 text-[var(--sw-brand)] font-bold px-1.5 py-0.2 rounded">{order.supplierName || '平台自营仓'}</span>
                  </div>

                  <div className="flex items-center gap-2">
                    <span className="font-bold text-[#E5484D]">{order.status === 'completed' ? '已完成' : order.status === 'pending_shipment' || order.status === 'pending_receipt' ? '运输中' : '待付款'}</span>
                  </div>
                </div>

                {/* 订单商品列表 */}
                <div className="p-3 divide-y divide-gray-100">
                  {order.items.map((item) => (
                    <div key={item.product.id} className="py-2 flex items-center justify-between gap-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-12 h-12 bg-gray-50 border border-gray-200 rounded p-1 flex-shrink-0 flex items-center justify-center">
                          <img src={item.product.image} alt={item.product.title} className="max-h-full max-w-full object-contain" />
                        </div>
                        <div className="min-w-0">
                          <div className="font-bold text-gray-800 truncate text-xs">{item.product.title}</div>
                          <div className="text-[10px] text-gray-400 mt-0.5">规格：{item.specText} × {item.quantity}</div>
                        </div>
                      </div>

                      <div className="text-right flex-shrink-0">
                        <div className="font-bold text-gray-900">¥{item.priceAtPurchase.toFixed(2)}</div>
                        {order.status !== 'pending_payment' && (
                          <div className="text-[10px] text-gray-400">福利卡全额抵扣</div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>

                {/* 订单底部扣减与操作栏 */}
                <div className="bg-gray-50/60 p-2.5 border-t border-gray-100 flex items-center justify-between flex-wrap gap-2 text-[11px]">
                  <div className="flex items-center gap-2 text-gray-600">
                    <span>
                      总额: <strong className="text-gray-900">¥{(order.payment.payableAmount ?? order.totalAmount).toFixed(2)}</strong>
                    </span>
                    <span>·</span>
                    <span className="text-[var(--sw-brand-dark)] font-bold">福利卡扣减: -¥{order.welfareDeduction.toFixed(2)}</span>
                  </div>

                  {order.status === 'pending_payment' ? (
                    <button type="button" aria-expanded={orderToPay === order.orderId} onClick={() => setOrderToPay(order.orderId)}
                      className="rounded bg-[var(--sw-brand)] px-2.5 py-1 font-bold text-white hover:bg-blue-700">
                      继续付款
                    </button>
                  ) : <div className="flex items-center gap-2">
                    <button
                      onClick={() => triggerPendingFeature('电子发票下载', '专票PDF已生成，支持直接存入发票抬头库')}
                      className="bg-white border border-gray-300 hover:border-[var(--sw-brand)] text-gray-700 hover:text-[var(--sw-brand)] font-bold px-2.5 py-1 rounded flex items-center gap-1 cursor-pointer transition-colors shadow-2xs"
                    >
                      <Download className="w-3.5 h-3.5 text-[var(--sw-brand)]" />
                      <span>下载电子专票</span>
                    </button>

                    <button
                      onClick={() => triggerPendingFeature('物流追踪', '京东快递：单号JD20260722881，预估明日送达')}
                      className="bg-[var(--sw-brand)] hover:bg-blue-700 text-white font-bold px-2.5 py-1 rounded flex items-center gap-1 cursor-pointer transition-colors shadow-xs"
                    >
                      <Truck className="w-3.5 h-3.5" />
                      <span>查看物流状态</span>
                    </button>
                  </div>}
                </div>
                {order.status === 'pending_payment' && orderToPay === order.orderId && (
                  <section aria-label="继续结算原订单" className="flex flex-wrap items-center justify-between gap-2 border-t border-blue-100 bg-blue-50/60 px-3 py-2.5">
                    <div className="space-y-0.5">
                      <h2 className="font-bold text-gray-900">继续结算原订单</h2>
                      <p className="text-[11px] text-gray-600">订单 {order.orderNo} · 订单总额 ¥{(order.payment.payableAmount ?? order.totalAmount).toFixed(2)}</p>
                    </div>
                    <div className="flex items-center gap-2 text-[11px]">
                      <button type="button" onClick={() => setOrderToPay(undefined)}
                        className="rounded border border-gray-300 bg-white px-2.5 py-1 font-bold text-gray-700">取消</button>
                      <button type="button" disabled={isSubmittingOrder} onClick={() => void continueOrderPayment(order.orderId)}
                        className="rounded bg-[var(--sw-brand)] px-2.5 py-1 font-bold text-white hover:bg-blue-700 disabled:opacity-50">确认继续付款</button>
                    </div>
                  </section>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
