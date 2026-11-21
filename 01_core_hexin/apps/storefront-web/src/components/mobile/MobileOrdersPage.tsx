import React from 'react';
import { createSecureId } from '@shop/sdk/context';
import { ChevronLeft, ChevronRight, Package, RefreshCw, RotateCcw, Store, Truck, WalletCards } from 'lucide-react';
import type { FrontendOrder, FrontendOrderItem } from '../../adapters/frontendData';
import { useMall, type MobileFulfillmentStage } from '../../context/MallContext';
import { loadProductionApi } from '../../services/productionApiLoader';
import type { OrderAftersaleInput } from '../../services/productionApi.types';
import { storefrontImageUrl } from '../../services/storefrontImageUrl';
import { MobileAfterSaleView } from './MobileAfterSaleView';
import { MobileOrderDetailView } from './MobileOrderDetailView';
import { MobilePaymentSheet } from './MobilePaymentSheet';
import { OrderFlowIcon } from './OrderFlowIcon';
import { currentMobileOrderFilter, matchesMobileOrderFilter, selectMobileOrderFilter, type MobileOrderFilter } from './mobileOrderFilters';
import { groupOrderPackages, mobileOrderPayableAmount, type MobileMerchantPackage } from './mobileOrderPresentation';
import {
  effectiveMobileFulfillmentStage,
  mobileFulfillmentSimulationAction,
  mobileFulfillmentStageLabel,
  nextMobileFulfillmentStage,
  summarizeMobileFulfillment,
} from './mobileOrderFulfillment';

interface MobileOrdersPageProps {
  mode: 'mini-program' | 'android-app';
}

const FILTER_OPTIONS: ReadonlyArray<Readonly<{ id: MobileOrderFilter; label: string }>> = [
  { id: 'all', label: '全部' },
  { id: 'pending_payment', label: '待付款' },
  { id: 'pending_shipment', label: '履约中' },
  { id: 'completed', label: '已完成' },
  { id: 'after_sale', label: '售后' },
];

export const MobileOrdersPage: React.FC<MobileOrdersPageProps> = ({ mode }) => {
  const {
    presentationOrders,
    mobileFulfillmentSimulationStage,
    setMobileFulfillmentSimulationStage,
    setMpPage,
    setAndroidPage,
    isShowcase,
    continueOrderPayment,
    refreshProductionData,
    showToast,
    triggerPendingFeature,
  } = useMall();
  const [activeFilter, setActiveFilter] = React.useState<MobileOrderFilter>(() => currentMobileOrderFilter());
  const [selectedOrder, setSelectedOrder] = React.useState<FrontendOrder | null>(null);
  const [orderView, setOrderView] = React.useState<'list' | 'detail' | 'after-sale'>('list');
  const [paymentOrder, setPaymentOrder] = React.useState<FrontendOrder | null>(null);
  const aftersaleInFlight = React.useRef(false);
  const aftersaleRequest = React.useRef<{ fingerprint: string; key: string } | null>(null);
  const [showPreviewControl, setShowPreviewControl] = React.useState(false);
  React.useEffect(() => {
    setShowPreviewControl(window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost');
  }, []);
  const visibleOrders = React.useMemo(
    () => presentationOrders.filter((order) => matchesMobileOrderFilter(order.status, activeFilter)),
    [activeFilter, presentationOrders],
  );
  const fulfillment = React.useMemo(
    () => summarizeMobileFulfillment(presentationOrders, mobileFulfillmentSimulationStage),
    [mobileFulfillmentSimulationStage, presentationOrders],
  );
  const filterOptions = React.useMemo(() => FILTER_OPTIONS.map((option) => (
    option.id === 'pending_shipment' ? { ...option, label: fulfillment.label } : option
  )), [fulfillment.label]);
  const filterCounts = React.useMemo(() => Object.fromEntries(FILTER_OPTIONS.map((option) => [
    option.id,
    presentationOrders.filter((order) => matchesMobileOrderFilter(order.status, option.id)).length,
  ])) as Record<MobileOrderFilter, number>, [presentationOrders]);
  const activeLabel = filterOptions.find((option) => option.id === activeFilter)?.label ?? '全部';
  const emptyState = mobileOrderEmptyState(activeFilter, activeLabel);

  const chooseFilter = (filter: MobileOrderFilter) => {
    selectMobileOrderFilter(filter);
    setActiveFilter(filter);
  };

  const simulateNextFulfillmentStage = () => {
    const nextStage = nextMobileFulfillmentStage(fulfillment.stage);
    setMobileFulfillmentSimulationStage(nextStage);
    showToast(`状态演示：${fulfillment.count} 笔订单已同步为${mobileFulfillmentStageLabel(nextStage)}`, 'info');
  };

  const openOrderView = (order: FrontendOrder, view: 'detail' | 'after-sale') => {
    setSelectedOrder(order);
    setOrderView(view);
  };

  const submitAftersale = async (order: FrontendOrder, input: OrderAftersaleInput) => {
    if (isShowcase) {
      triggerPendingFeature('售后申请提交', `订单 ${order.orderNo} 的退货退款表单已完成，等待接入售后提交与审核接口。`);
      return;
    }
    if (aftersaleInFlight.current) return;
    aftersaleInFlight.current = true;
    const lines = [...input.lines].sort();
    const fingerprint = JSON.stringify([order.id, lines, input.kind, input.reason, input.returnMethod]);
    try {
      const pending = aftersaleRequest.current?.fingerprint === fingerprint ? aftersaleRequest.current : { fingerprint, key: createSecureId() };
      aftersaleRequest.current = pending;
      const productionApi = await loadProductionApi();
      const receipts = await productionApi.applyOrderAftersale(order.id, { ...input, lines }, pending.key);
      aftersaleRequest.current = null;
      setSelectedOrder((current) => current?.id === order.id ? { ...current, status: 'after_sale', aftersales: receipts } : current);
      showToast('售后申请已提交', 'success');
      void refreshProductionData().catch(() => undefined);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '售后申请暂未提交，请稍后重试', 'error');
    } finally {
      aftersaleInFlight.current = false;
    }
  };

  const paymentSheet = paymentOrder && (
    <MobilePaymentSheet
      order={paymentOrder}
      onClose={() => setPaymentOrder(null)}
      onConfirm={() => {
        setPaymentOrder(null);
        if (isShowcase) {
          triggerPendingFeature('继续付款', `订单 ${paymentOrder.orderNo} 的支付界面已完成，等待接入微信支付创建与回调接口。`);
        } else {
          void continueOrderPayment(paymentOrder.id);
        }
      }}
    />
  );

  const goBack = () => {
    if (mode === 'mini-program') setMpPage('profile');
    else setAndroidPage('profile');
  };

  if (selectedOrder && orderView === 'detail') {
    return (
      <div className="relative min-h-full">
        <MobileOrderDetailView
          order={selectedOrder}
          onBack={() => setOrderView('list')}
          onContinuePayment={() => setPaymentOrder(selectedOrder)}
          onAfterSale={() => setOrderView('after-sale')}
        />
        {paymentSheet}
      </div>
    );
  }

  if (selectedOrder && orderView === 'after-sale') {
    return (
      <div className="relative min-h-full">
        <MobileAfterSaleView
          order={selectedOrder}
          onBack={() => setOrderView('detail')}
          onSubmit={(input) => { void submitAftersale(selectedOrder, input); }}
        />
      </div>
    );
  }

  return (
    <div className="relative min-h-full bg-[#F3F5F8] pb-20 text-slate-800 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200">
      <div className="sticky top-0 z-30 border-b border-slate-100 bg-white shadow-[0_5px_18px_rgba(25,45,72,0.035)]">
        <header className="flex min-h-[58px] items-center gap-3 px-3">
          <button type="button" onClick={goBack} className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-slate-700 transition-transform duration-150 active:scale-90 active:bg-slate-100" aria-label="返回个人中心">
            <ChevronLeft className="h-5 w-5" />
          </button>
          <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
            <h1 className="text-[16px] font-black tracking-[-0.02em] text-slate-950">我的订单</h1>
            {presentationOrders.length > 0 && (
              <span aria-label={`共 ${presentationOrders.length} 笔订单`} className="text-[10px] font-semibold tabular-nums text-slate-400">
                {presentationOrders.length > 99 ? '99+' : presentationOrders.length}
              </span>
            )}
          </div>
          {showPreviewControl && fulfillment.count > 0 && (
            <button
              type="button"
              onClick={simulateNextFulfillmentStage}
              title={mobileFulfillmentSimulationAction(fulfillment.stage)}
              aria-label={mobileFulfillmentSimulationAction(fulfillment.stage)}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-[#DDE8F6] bg-[#F5F9FE] text-[#52739D] transition-transform duration-150 active:scale-90"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          )}
        </header>

        <nav aria-label="订单状态筛选" className="grid grid-cols-5 px-2">
          {filterOptions.map((option) => {
            const count = filterCounts[option.id];
            const isActive = option.id === activeFilter;
            return (
              <button
                key={option.id}
                type="button"
                aria-pressed={isActive}
                onClick={() => chooseFilter(option.id)}
                className={`relative flex min-h-11 touch-manipulation items-center justify-center gap-0.5 px-0.5 text-[10px] font-bold transition-[color,transform] duration-150 active:scale-[0.96] ${isActive ? 'text-[var(--sw-brand)]' : 'text-slate-400 active:text-slate-700'}`}
              >
                <span key={option.label} aria-live={option.id === 'pending_shipment' ? 'polite' : undefined}>{option.label}</span>
                {count > 0 && <span className={`text-[8px] font-semibold ${isActive ? 'text-[#7899C2]' : 'text-slate-300'}`}>{count > 99 ? '99+' : count}</span>}
                <span className={`absolute bottom-0 left-1/2 h-0.5 -translate-x-1/2 rounded-full bg-[var(--sw-brand)] transition-[width,opacity] duration-200 ${isActive ? 'w-5 opacity-100' : 'w-0 opacity-0'}`} />
              </button>
            );
          })}
        </nav>
      </div>

      <main key={activeFilter} className="space-y-3 px-3 py-3.5 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-200">
        {visibleOrders.length === 0 ? (
          <div role="status" className="rounded-[22px] border border-white bg-white px-6 py-10 text-center shadow-[0_10px_28px_rgba(33,52,78,0.045)]">
            <div className="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-[20px] bg-[#F0F5FB] text-[#6482A8]">
              <OrderFlowIcon className="h-10 w-10" />
            </div>
            <p className="text-[13px] font-black text-slate-800">{emptyState.title}</p>
            <p className="mt-1.5 text-[10px] leading-4 text-slate-400">{emptyState.detail}</p>
          </div>
        ) : (
          visibleOrders.map((order, orderIndex) => {
            const fulfillmentStage = effectiveMobileFulfillmentStage(order, mobileFulfillmentSimulationStage);
            const primaryAction = mobileOrderPrimaryAction(order.status, fulfillmentStage);

            const runPrimaryAction = () => {
              if (primaryAction.kind === 'payment') setPaymentOrder(order);
              else if (primaryAction.kind === 'after-sale') openOrderView(order, 'after-sale');
              else openOrderView(order, 'detail');
            };

            return (
              <MobileOrderCard
                key={order.id}
                order={order}
                orderIndex={orderIndex}
                fulfillmentStage={fulfillmentStage}
                primaryAction={primaryAction}
                onOpenDetail={() => openOrderView(order, 'detail')}
                onPrimaryAction={runPrimaryAction}
              />
            );
          })
        )}
      </main>
      {paymentSheet}
    </div>
  );
};

interface MobileOrderCardProps {
  order: FrontendOrder;
  orderIndex: number;
  fulfillmentStage: MobileFulfillmentStage | null;
  primaryAction: MobileOrderAction;
  onOpenDetail: () => void;
  onPrimaryAction: () => void;
}

const MobileOrderCard: React.FC<MobileOrderCardProps> = ({
  order,
  orderIndex,
  fulfillmentStage,
  primaryAction,
  onOpenDetail,
  onPrimaryAction,
}) => {
  const packages = groupOrderPackages(order, fulfillmentStage);
  const isMultiMerchant = packages.length > 1;
  const isPendingPayment = order.status === 'pending_payment' || order.status === 'pending_pay';
  const displayStatusText = fulfillmentStage ? mobileFulfillmentStageLabel(fulfillmentStage) : order.statusText;
  const displayAmount = isPendingPayment ? mobileOrderPayableAmount(order) : order.totalAmount;
  const statusTone = orderStatusTone(order.status, fulfillmentStage);

  return (
    <article
      className="overflow-hidden rounded-[22px] border border-white bg-white shadow-[0_10px_28px_rgba(33,52,78,0.055)] [content-visibility:auto] [contain-intrinsic-size:184px] motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-200"
      style={{ animationDelay: `${Math.min(orderIndex, 3) * 24}ms` }}
    >
      {isMultiMerchant ? (
        <MultiMerchantOrder
          order={order}
          packages={packages}
          displayAmount={displayAmount}
          primaryAction={primaryAction}
          onOpenDetail={onOpenDetail}
          onPrimaryAction={onPrimaryAction}
        />
      ) : (
        <SingleMerchantOrder
          order={order}
          orderIndex={orderIndex}
          merchantPackage={packages[0]}
          fulfillmentStage={fulfillmentStage}
          displayStatusText={displayStatusText}
          displayAmount={displayAmount}
          statusTone={statusTone}
          primaryAction={primaryAction}
          isPendingPayment={isPendingPayment}
          onOpenDetail={onOpenDetail}
          onPrimaryAction={onPrimaryAction}
        />
      )}
    </article>
  );
};

interface SingleMerchantOrderProps {
  order: FrontendOrder;
  orderIndex: number;
  merchantPackage: MobileMerchantPackage | undefined;
  fulfillmentStage: MobileFulfillmentStage | null;
  displayStatusText: string;
  displayAmount: number;
  statusTone: Readonly<{ text: string; dot: string }>;
  primaryAction: MobileOrderAction;
  isPendingPayment: boolean;
  onOpenDetail: () => void;
  onPrimaryAction: () => void;
}

const SingleMerchantOrder: React.FC<SingleMerchantOrderProps> = ({
  order,
  orderIndex,
  merchantPackage,
  fulfillmentStage,
  displayStatusText,
  displayAmount,
  statusTone,
  primaryAction,
  isPendingPayment,
  onOpenDetail,
  onPrimaryAction,
}) => {
  const merchantName = merchantPackage?.merchantName || order.supplierName || order.mallName;
  const firstItem = order.items[0];
  const itemCount = order.items.reduce((sum, item) => sum + item.quantity, 0);
  const merchantBadge = mobileMerchantBadge(order.supplierType);

  return (
    <>
      <header className="flex min-h-12 items-center gap-2 border-b border-slate-100/80 px-3.5">
        <MerchantMark />
        <span className="min-w-0 truncate text-[11px] font-black text-slate-900">{merchantName}</span>
        {merchantBadge && <span className="shrink-0 rounded-md bg-[#EEF4FF] px-1.5 py-0.5 text-[8px] font-bold text-[var(--sw-brand)]">{merchantBadge}</span>}
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-300" />
        <span className={`ml-auto shrink-0 text-[10px] font-bold ${statusTone.text}`}>{displayStatusText}</span>
      </header>

      <button type="button" onClick={onOpenDetail} className="flex w-full touch-manipulation items-center gap-3 px-3.5 py-3 text-left transition-[background-color,transform] duration-150 active:scale-[0.995] active:bg-[#F7F9FC]">
        <OrderProductImage item={firstItem} eager={orderIndex === 0} />
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 block text-[11px] font-bold leading-[1.55] text-slate-800">{firstItem?.productTitle ?? '订单商品信息同步中'}</span>
          <span className="mt-1 block text-[9px] text-slate-400">
            {firstItem?.specText || '默认规格'} · 共 {itemCount} 件{order.items.length > 1 ? ` · ${order.items.length} 种商品` : ''}
          </span>
          <span className="mt-2.5 flex items-baseline justify-between gap-2">
            <span className="text-[13px] font-black tracking-[-0.02em] text-slate-900">¥{displayAmount.toFixed(2)}</span>
            <span className="text-[9px] text-slate-400">订单详情</span>
          </span>
        </span>
      </button>

      <div className="mx-3.5 mb-2.5 flex min-h-9 items-center gap-2 rounded-[12px] bg-gradient-to-r from-[#F0F5FF] to-[#F8FBFF] px-3">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusTone.dot} shadow-[0_0_0_4px_rgba(36,105,232,0.08)]`} />
        <span className="min-w-0 flex-1 truncate text-[9px] font-semibold text-[#45688F]">{merchantPackage?.deliveryHint || mobileOrderProgressHint(order.status, fulfillmentStage)}</span>
        <span className="shrink-0 text-[8px] text-[#91A1B6]">持续更新</span>
      </div>

      <footer className="flex min-h-[48px] items-center justify-between gap-3 border-t border-slate-100/80 px-3.5 py-2">
        <span className="min-w-0 truncate text-[8px] text-slate-400">{isPendingPayment ? '付款后由商户安排配送' : `订单号 ${order.orderNo}`}</span>
        <OrderActionButton action={primaryAction} onClick={onPrimaryAction} />
      </footer>
    </>
  );
};

interface MultiMerchantOrderProps {
  order: FrontendOrder;
  packages: MobileMerchantPackage[];
  displayAmount: number;
  primaryAction: MobileOrderAction;
  onOpenDetail: () => void;
  onPrimaryAction: () => void;
}

const MultiMerchantOrder: React.FC<MultiMerchantOrderProps> = ({ order, packages, displayAmount, primaryAction, onOpenDetail, onPrimaryAction }) => (
  <>
    <header className="flex min-h-[52px] items-center gap-3 px-3.5">
      <span className="min-w-0 flex-1">
        <span className="block text-[12px] font-black text-slate-900">合并支付订单</span>
        <span className="mt-0.5 block text-[8px] font-medium text-slate-400">来自 {packages.length} 家商户 · 分 {packages.length} 个包裹配送</span>
      </span>
      <span className="shrink-0 text-right">
        <span className="block text-[8px] text-slate-400">合计</span>
        <span className="block text-[13px] font-black tracking-[-0.02em] text-slate-900">¥{displayAmount.toFixed(2)}</span>
      </span>
    </header>

    <div className="space-y-2 px-2.5 pb-2.5">
      {packages.map((merchantPackage, packageIndex) => {
        const firstItem = merchantPackage.items[0];
        const packageItemCount = merchantPackage.items.reduce((sum, item) => sum + item.quantity, 0);
        const packageType = firstItem?.product.supplierType;
        const packageBadge = mobileMerchantBadge(packageType);
        const packageTone = packageStatusTone(merchantPackage.statusLabel);
        return (
          <section key={merchantPackage.id} className="overflow-hidden rounded-[16px] border border-slate-100 bg-[#FBFCFE]">
            <header className="flex min-h-10 items-center gap-2 border-b border-slate-100 bg-white px-2.5">
              <MerchantMark tone={packageIndex % 2 === 0 ? 'warm' : 'green'} compact />
              <span className="min-w-0 truncate text-[10px] font-black text-slate-800">{merchantPackage.merchantName}</span>
              {packageBadge && <span className="shrink-0 rounded-md bg-slate-50 px-1.5 py-0.5 text-[7px] font-bold text-slate-500">{packageBadge}</span>}
              <ChevronRight className="h-3 w-3 shrink-0 text-slate-300" />
              <span className={`ml-auto shrink-0 text-[9px] font-bold ${packageTone.text}`}>{merchantPackage.statusLabel}</span>
            </header>
            <button type="button" onClick={onOpenDetail} className="flex w-full touch-manipulation items-center gap-2.5 px-2.5 py-2 text-left transition-colors duration-150 active:bg-slate-50">
              <OrderProductImage item={firstItem} compact />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[10.5px] font-bold text-slate-800">{firstItem?.productTitle ?? '商品信息同步中'}</span>
                <span className="mt-1 block text-[8px] text-slate-400">{firstItem?.specText || '默认规格'} · 共 {packageItemCount} 件</span>
                <span className="mt-1.5 flex items-center gap-1.5 text-[8px] font-medium text-[#6F8198]">
                  <span className={`h-1 w-1 shrink-0 rounded-full ${packageTone.dot}`} />
                  <span className="truncate">{merchantPackage.deliveryHint}</span>
                </span>
              </span>
            </button>
          </section>
        );
      })}
    </div>

    <footer className="border-t border-slate-100/80 p-2.5">
      <button type="button" onClick={onPrimaryAction} className={`flex min-h-10 w-full touch-manipulation items-center justify-center gap-1.5 rounded-[13px] text-[10px] font-bold transition-transform duration-150 active:scale-[0.985] ${mobileOrderActionTone(primaryAction.tone, true)}`}>
        {primaryAction.kind === 'payment' && <WalletCards className="h-3.5 w-3.5" />}
        {primaryAction.kind === 'after-sale' && <RotateCcw className="h-3.5 w-3.5" />}
        {primaryAction.kind === 'detail' && <Truck className="h-3.5 w-3.5" />}
        {primaryAction.kind === 'detail' ? `查看 ${packages.length} 个包裹进度` : primaryAction.label}
        <ChevronRight className="h-3 w-3" />
      </button>
      <span className="sr-only">订单号 {order.orderNo}</span>
    </footer>
  </>
);

const MerchantMark: React.FC<{ tone?: 'brand' | 'warm' | 'green'; compact?: boolean }> = ({ tone = 'brand', compact = false }) => {
  const toneClass = tone === 'warm' ? 'bg-amber-50 text-amber-600' : tone === 'green' ? 'bg-emerald-50 text-emerald-600' : 'bg-[#EDF4FF] text-[var(--sw-brand)]';
  return (
    <span className={`grid shrink-0 place-items-center rounded-[9px] ${compact ? 'h-6 w-6' : 'h-7 w-7'} ${toneClass}`}>
      <Store className={compact ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
    </span>
  );
};

const OrderProductImage: React.FC<{ item: FrontendOrderItem | undefined; eager?: boolean; compact?: boolean }> = ({ item, eager = false, compact = false }) => {
  const size = compact ? 54 : 72;
  if (!item) {
    return <span className={`grid shrink-0 place-items-center bg-[#F0F4F8] text-[#7C91AB] ${compact ? 'h-[54px] w-[54px] rounded-[13px]' : 'h-[72px] w-[72px] rounded-[16px]'}`}><Package className={compact ? 'h-4 w-4' : 'h-5 w-5'} /></span>;
  }
  return (
    <img
      src={storefrontImageUrl(item.product.imageUrl, size * 2)}
      srcSet={`${storefrontImageUrl(item.product.imageUrl, size)} 1x, ${storefrontImageUrl(item.product.imageUrl, size * 2)} 2x, ${storefrontImageUrl(item.product.imageUrl, size * 3)} 3x`}
      alt={item.productTitle}
      width={size}
      height={size}
      loading={eager ? 'eager' : 'lazy'}
      fetchPriority={eager ? 'high' : 'low'}
      decoding="async"
      className={`shrink-0 bg-[#F5F7FA] object-cover ${compact ? 'h-[54px] w-[54px] rounded-[13px]' : 'h-[72px] w-[72px] rounded-[16px]'}`}
    />
  );
};

const OrderActionButton: React.FC<{ action: MobileOrderAction; onClick: () => void }> = ({ action, onClick }) => (
  <button type="button" onClick={onClick} className={`flex min-h-8 shrink-0 touch-manipulation items-center gap-1.5 rounded-full px-3.5 text-[9px] font-bold transition-transform duration-150 active:scale-95 ${mobileOrderActionTone(action.tone)}`}>
    {action.kind === 'payment' && <WalletCards className="h-3 w-3" />}
    {action.kind === 'after-sale' && <RotateCcw className="h-3 w-3" />}
    {action.kind === 'detail' && <Truck className="h-3 w-3" />}
    {action.label}
  </button>
);

type MobileOrderAction = Readonly<{
  kind: 'payment' | 'after-sale' | 'detail';
  label: string;
  tone: 'brand' | 'quiet' | 'service';
}>;

function mobileOrderPrimaryAction(status: FrontendOrder['status'], fulfillmentStage: MobileFulfillmentStage | null): MobileOrderAction {
  if (status === 'pending_payment' || status === 'pending_pay') return { kind: 'payment', label: '继续付款', tone: 'brand' };
  if (status === 'after_sale') return { kind: 'after-sale', label: '查看进度', tone: 'service' };
  if (status === 'completed' || fulfillmentStage === 'received') return { kind: 'after-sale', label: '退货/退款', tone: 'quiet' };
  if (fulfillmentStage === 'shipped') return { kind: 'detail', label: '查看物流', tone: 'brand' };
  if (fulfillmentStage === 'processing') return { kind: 'after-sale', label: '申请退款', tone: 'quiet' };
  return { kind: 'detail', label: '订单详情', tone: 'quiet' };
}

function mobileOrderActionTone(tone: MobileOrderAction['tone'], fullWidth = false): string {
  if (tone === 'brand') return fullWidth ? 'bg-[#EEF4FF] text-[var(--sw-brand)]' : 'bg-[var(--sw-brand)] text-white shadow-[0_7px_16px_rgba(36,105,232,0.2)]';
  if (tone === 'service') return 'bg-[#F1EEFB] text-[#6E5B9C]';
  return fullWidth ? 'bg-slate-50 text-slate-700' : 'border border-[#D9E2ED] bg-white text-slate-700';
}

function mobileMerchantBadge(supplierType: FrontendOrder['supplierType'] | undefined): string | null {
  if (supplierType === 'self_operated') return '自营';
  if (supplierType === 'group_owned') return '集团';
  return null;
}

function packageStatusTone(statusLabel: string): Readonly<{ text: string; dot: string }> {
  if (statusLabel === '待付款' || statusLabel === '备货中') return { text: 'text-amber-600', dot: 'bg-amber-500' };
  if (statusLabel === '运输中') return { text: 'text-[var(--sw-brand)]', dot: 'bg-[var(--sw-brand)]' };
  if (statusLabel === '已收货' || statusLabel === '已签收') return { text: 'text-emerald-600', dot: 'bg-emerald-500' };
  return { text: 'text-[#725EA1]', dot: 'bg-[#8A76B7]' };
}

function orderStatusTone(status: FrontendOrder['status'], fulfillmentStage: MobileFulfillmentStage | null): Readonly<{ text: string; dot: string }> {
  if (status === 'pending_payment' || status === 'pending_pay') return { text: 'text-amber-700', dot: 'bg-amber-500' };
  if (status === 'after_sale') return { text: 'text-[#725EA1]', dot: 'bg-[#8A76B7]' };
  if (status === 'completed' || fulfillmentStage === 'received') return { text: 'text-emerald-700', dot: 'bg-emerald-500' };
  if (fulfillmentStage === 'processing') return { text: 'text-amber-600', dot: 'bg-amber-500' };
  return { text: 'text-[var(--sw-brand)]', dot: 'bg-[var(--sw-brand)]' };
}

function mobileOrderProgressHint(status: FrontendOrder['status'], fulfillmentStage: MobileFulfillmentStage | null): string {
  if (status === 'pending_payment' || status === 'pending_pay') return '等待完成支付';
  if (status === 'after_sale') return '售后进度持续更新';
  if (status === 'completed' || fulfillmentStage === 'received') return '包裹已完成签收';
  if (fulfillmentStage === 'shipped') return '包裹运输中';
  return '商户正在备货';
}

function mobileOrderEmptyState(filter: MobileOrderFilter, activeLabel: string): Readonly<{ title: string; detail: string }> {
  if (filter === 'pending_payment') return { title: '没有等待付款的订单', detail: '需要继续付款的订单会出现在这里。' };
  if (filter === 'pending_shipment') return { title: `暂无${activeLabel}订单`, detail: '备货、运输与收货进度会自动同步。' };
  if (filter === 'completed') return { title: '还没有已完成订单', detail: '签收完成的订单会安静地留在这里。' };
  if (filter === 'after_sale') return { title: '暂无售后申请', detail: '退货、退款与审核进度会集中展示。' };
  return { title: '还没有订单', detail: '下单后，每一步进度都会在这里更新。' };
}
