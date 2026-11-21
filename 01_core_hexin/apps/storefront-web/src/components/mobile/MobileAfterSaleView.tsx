import React from 'react';
import { Camera, Check, ChevronLeft, Clock3, PackageOpen, RotateCcw, Truck, WalletCards } from 'lucide-react';
import type { FrontendOrder, FrontendOrderItem } from '../../adapters/frontendData';
import type { OrderAftersaleInput } from '../../services/productionApi.types';
import { storefrontImageUrl } from '../../services/storefrontImageUrl';

interface MobileAfterSaleViewProps {
  order: FrontendOrder;
  onBack: () => void;
  onSubmit: (input: OrderAftersaleInput) => void;
}

type ServiceType = 'return_goods' | 'refund_only';
type ReturnMethod = 'pickup' | 'self_send';
type ProgressState = 'done' | 'current' | 'pending';

const REASONS = ['商品与描述不符', '质量或破损问题', '错发/漏发', '不再需要'];

function itemKey(item: FrontendOrderItem): string {
  return item.orderLineId ?? item.productId;
}

export function MobileAfterSaleView({ order, onBack, onSubmit }: Readonly<MobileAfterSaleViewProps>) {
  if (order.status === 'after_sale') return <AfterSaleProgress order={order} onBack={onBack} />;
  return <AfterSaleApplication order={order} onBack={onBack} onSubmit={onSubmit} />;
}

function AfterSaleApplication({ order, onBack, onSubmit }: Readonly<MobileAfterSaleViewProps>) {
  const [selectedIds, setSelectedIds] = React.useState(() => new Set(order.items.map(itemKey)));
  const [serviceType, setServiceType] = React.useState<ServiceType>('return_goods');
  const [reason, setReason] = React.useState(REASONS[0]);
  const [returnMethod, setReturnMethod] = React.useState<ReturnMethod>('pickup');
  const [hasPhoto, setHasPhoto] = React.useState(false);
  const selectedItems = order.items.filter((item) => selectedIds.has(itemKey(item)));
  const selectedAmount = selectedItems.reduce((sum, item) => sum + (item.payableMinor ?? Math.round(item.priceAtPurchase * item.quantity * 100)), 0) / 100;
  const selectedItemCount = selectedItems.reduce((sum, item) => sum + item.quantity, 0);

  const toggleItem = (productId: string) => setSelectedIds((previous) => {
    const next = new Set(previous);
    if (next.has(productId)) next.delete(productId);
    else next.add(productId);
    return next;
  });

  const submit = () => onSubmit({
    lines: selectedItems.map(itemKey),
    kind: serviceType === 'return_goods' ? 'return' : 'refund',
    reason,
    ...(serviceType === 'return_goods' ? { returnMethod } : {}),
  });

  return (
    <div className="min-h-full bg-[#F3F5F8] pb-24 text-slate-800 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-right-1 motion-safe:duration-200">
      <PageHeader title="申请退货/退款" subtitle={order.orderNo} onBack={onBack} />
      <main className="space-y-3 px-3 py-3.5">
        <section className="relative overflow-hidden rounded-[24px] border border-[#DCE7F3] bg-gradient-to-br from-white via-[#F7FAFD] to-[#EDF4FB] p-4 shadow-[0_12px_30px_rgba(40,65,96,0.06)]">
          <span aria-hidden="true" className="absolute inset-0 bg-[radial-gradient(circle_at_92%_4%,rgba(198,222,245,0.52),transparent_42%)]" />
          <div className="relative flex items-start gap-3">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[16px] border border-white bg-white/80 text-[#5A7EA7] shadow-[0_7px_18px_rgba(66,96,132,0.08)]"><RotateCcw className="h-5 w-5" /></span>
            <div className="min-w-0">
              <h2 className="text-[14px] font-black text-[#203A59]">选择适合的处理方式</h2>
              <p className="mt-1 text-[9px] leading-4 text-[#6F8298]">可选择部分商品；提交后，处理进度会在售后页持续更新。</p>
              <p className="mt-2 text-[9px] font-semibold text-[#55769D]">已选 {selectedItemCount} 件 · 预计退款 ¥{selectedAmount.toFixed(2)}</p>
            </div>
          </div>
        </section>

        <section className="overflow-hidden rounded-[22px] border border-white bg-white shadow-[0_10px_28px_rgba(33,52,78,0.045)]">
          <div className="flex items-center justify-between px-3.5 py-3">
            <div><h2 className="text-[12px] font-black text-slate-900">选择商品</h2><p className="mt-0.5 text-[8px] text-slate-400">只退需要处理的商品</p></div>
            <span className="text-[9px] font-semibold text-[#607B9B]">{selectedIds.size}/{order.items.length} 种</span>
          </div>
          <div className="border-t border-slate-100 px-3.5">
            {order.items.map((item, index) => {
              const key = itemKey(item);
              const selected = selectedIds.has(key);
              return (
                <button key={key} type="button" aria-pressed={selected} onClick={() => toggleItem(key)} className="flex w-full touch-manipulation items-center gap-2.5 border-b border-slate-100 py-3 text-left transition-[background-color,transform] duration-150 active:scale-[0.995] active:bg-[#F8FAFC] last:border-b-0">
                  <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border transition-colors duration-150 ${selected ? 'border-[#6E91BA] bg-[#6E91BA] text-white' : 'border-slate-300 bg-white text-transparent'}`}><Check className="h-3 w-3" /></span>
                  <img
                    src={storefrontImageUrl(item.product.imageUrl, 112)}
                    srcSet={`${storefrontImageUrl(item.product.imageUrl, 56)} 1x, ${storefrontImageUrl(item.product.imageUrl, 112)} 2x, ${storefrontImageUrl(item.product.imageUrl, 168)} 3x`}
                    alt={item.productTitle}
                    width={56}
                    height={56}
                    loading={index === 0 ? 'eager' : 'lazy'}
                    fetchPriority={index === 0 ? 'high' : 'low'}
                    decoding="async"
                    className="h-14 w-14 shrink-0 rounded-[14px] bg-[#F5F7FA] object-cover"
                  />
                  <span className="min-w-0 flex-1">
                    <strong className="line-clamp-2 block text-[10px] leading-4 text-slate-800">{item.productTitle}</strong>
                    <span className="mt-1.5 flex items-center justify-between gap-2 text-[9px] text-slate-400"><span className="truncate">{item.specText || '默认规格'} · ×{item.quantity}</span><span className="shrink-0 font-semibold text-slate-700">¥{item.priceAtPurchase.toFixed(2)}</span></span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        <section className="overflow-hidden rounded-[22px] border border-white bg-white p-3.5 shadow-[0_10px_28px_rgba(33,52,78,0.045)]">
          <div>
            <h2 className="text-[12px] font-black text-slate-900">处理方式</h2>
            <div className="mt-3 grid grid-cols-2 gap-1 rounded-[17px] bg-[#F4F7FA] p-1">
              <ServiceTypeButton active={serviceType === 'return_goods'} icon={<PackageOpen className="h-4 w-4" />} title="退货退款" description="寄回商品后退款" onClick={() => setServiceType('return_goods')} />
              <ServiceTypeButton active={serviceType === 'refund_only'} icon={<WalletCards className="h-4 w-4" />} title="仅退款" description="无需寄回商品" onClick={() => setServiceType('refund_only')} />
            </div>
          </div>

          <div className="mt-4 border-t border-slate-100 pt-4">
            <h2 className="text-[12px] font-black text-slate-900">申请原因</h2>
            <div className="mt-2.5 flex flex-wrap gap-2">
              {REASONS.map((item) => <button key={item} type="button" aria-pressed={reason === item} onClick={() => setReason(item)} className={`touch-manipulation rounded-full px-3 py-2 text-[9px] font-semibold transition-[background-color,color,transform] duration-150 active:scale-95 ${reason === item ? 'bg-[#EAF2FB] text-[#496C95] ring-1 ring-[#D5E4F3]' : 'bg-[#F6F8FA] text-slate-500'}`}>{item}</button>)}
            </div>
          </div>

          {serviceType === 'return_goods' && (
            <div className="mt-4 border-t border-slate-100 pt-4 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-1 motion-safe:duration-200">
              <h2 className="text-[12px] font-black text-slate-900">退货方式</h2>
              <div className="mt-2.5 grid grid-cols-2 gap-2">
                <ReturnMethodButton active={returnMethod === 'pickup'} icon={<Truck className="h-4 w-4" />} title="上门取件" description="推荐，无需垫付" onClick={() => setReturnMethod('pickup')} />
                <ReturnMethodButton active={returnMethod === 'self_send'} icon={<RotateCcw className="h-4 w-4" />} title="自行寄回" description="后续填写物流单号" onClick={() => setReturnMethod('self_send')} />
              </div>
            </div>
          )}

          <div className="mt-4 border-t border-slate-100 pt-4">
            <div className="flex items-center justify-between"><h2 className="text-[12px] font-black text-slate-900">补充凭证</h2><span className="text-[8px] text-slate-400">选填</span></div>
            <button type="button" onClick={() => setHasPhoto((value) => !value)} className={`mt-2.5 flex min-h-12 w-full touch-manipulation items-center justify-center gap-2 rounded-[15px] border border-dashed text-[9px] font-semibold transition-[background-color,border-color,color,transform] duration-150 active:scale-[0.99] ${hasPhoto ? 'border-[#BDD8CF] bg-[#F0F8F5] text-[#4D7C70]' : 'border-slate-200 bg-[#FAFBFC] text-slate-400'}`}>
              {hasPhoto ? <><Check className="h-4 w-4" /><span>已添加 1 张问题凭证</span></> : <><Camera className="h-4 w-4" /><span>添加照片或视频</span></>}
            </button>
          </div>
        </section>
      </main>

      <footer className="absolute inset-x-0 bottom-0 z-40 flex min-h-[66px] items-center justify-between gap-3 border-t border-slate-100 bg-white px-3.5 py-2.5 shadow-[0_-8px_24px_rgba(33,52,78,0.04)]">
        <div><p className="text-[8px] tracking-wide text-slate-400">预计退款</p><p className="mt-0.5 text-[18px] font-black tracking-[-0.03em] text-slate-900">¥{selectedAmount.toFixed(2)}</p></div>
        <button type="button" disabled={selectedIds.size === 0} onClick={submit} className="min-h-11 touch-manipulation rounded-full bg-[var(--sw-brand)] px-7 text-[11px] font-black text-white shadow-[0_8px_18px_rgba(36,105,232,0.2)] transition-transform duration-150 active:scale-95 disabled:bg-slate-300 disabled:shadow-none">提交申请</button>
      </footer>
    </div>
  );
}

function AfterSaleProgress({ order, onBack }: Readonly<Pick<MobileAfterSaleViewProps, 'order' | 'onBack'>>) {
  const activeCases = order.aftersales?.filter(({ state }) => ['requested', 'approved', 'processing'].includes(state)) ?? [];
  const receipt = activeCases[0];
  const item = order.items.find(({ orderLineId }) => orderLineId === receipt?.lineId) ?? order.items[0];
  const refundAmount = activeCases.length > 0 && activeCases.every(({ amountMinor }) => amountMinor !== null)
    ? activeCases.reduce((sum, { amountMinor }) => sum + (amountMinor ?? 0), 0) / 100
    : order.totalAmount;
  const image = item?.product.imageUrl ?? '';
  return (
    <div className="min-h-full bg-[#F3F5F8] pb-6 text-slate-800 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-right-1 motion-safe:duration-200">
      <PageHeader title="售后进度" subtitle={receipt?.id ?? `AS-${order.orderNo.slice(-8)}`} onBack={onBack} />
      <main className="space-y-3 px-3 py-3.5">
        <section className="relative overflow-hidden rounded-[24px] border border-[#E1DDF0] bg-gradient-to-br from-white via-[#FAF9FD] to-[#F1EFF8] p-4 shadow-[0_12px_30px_rgba(67,56,104,0.06)]">
          <span aria-hidden="true" className="absolute inset-0 bg-[radial-gradient(circle_at_92%_4%,rgba(225,218,243,0.56),transparent_42%)]" />
          <div className="relative flex items-start justify-between gap-3">
            <div><p className="text-[9px] font-semibold tracking-[0.12em] text-[#8A82A0]">当前状态</p><h2 className="mt-1.5 text-[21px] font-black tracking-[-0.03em] text-[#403A55]">审核中</h2><p className="mt-1.5 text-[9px] leading-4 text-[#827A94]">预计 1 个工作日内完成审核</p></div>
            <span className="grid h-12 w-12 place-items-center rounded-[17px] border border-white bg-white/80 text-[#766C99] shadow-[0_7px_18px_rgba(67,56,104,0.08)]"><Clock3 className="h-5 w-5" /></span>
          </div>
        </section>

        <section className="rounded-[22px] border border-white bg-white p-4 shadow-[0_10px_28px_rgba(33,52,78,0.045)]">
          <h3 className="text-[12px] font-black text-slate-900">处理进度</h3>
          <div className="mt-4">
            <ProgressLine state="done" title="申请已提交" detail="系统已收到退货退款申请" />
            <ProgressLine state="current" title="商户审核中" detail="正在核对订单与商品信息" />
            <ProgressLine state="pending" title="退货取件" detail="审核通过后安排上门取件" />
            <ProgressLine state="pending" title="退款到账" detail="验收完成后按原支付方式退回" last />
          </div>
        </section>

        <section className="rounded-[22px] border border-white bg-white p-3.5 shadow-[0_10px_28px_rgba(33,52,78,0.045)]">
          <div className="flex items-center gap-3">
            <img src={storefrontImageUrl(image, 112)} srcSet={`${storefrontImageUrl(image, 56)} 1x, ${storefrontImageUrl(image, 112)} 2x, ${storefrontImageUrl(image, 168)} 3x`} alt="售后商品" width={56} height={56} loading="eager" fetchPriority="high" decoding="async" className="h-14 w-14 rounded-[14px] bg-[#F5F7FA] object-cover" />
            <div className="min-w-0 flex-1"><p className="line-clamp-2 text-[10px] font-bold leading-4 text-slate-800">{item?.productTitle}</p><p className="mt-1.5 text-[9px] text-slate-400">退款金额 <span className="font-black text-slate-700">¥{refundAmount.toFixed(2)}</span></p></div>
          </div>
        </section>
      </main>
    </div>
  );
}

function PageHeader({ title, subtitle, onBack }: Readonly<{ title: string; subtitle: string; onBack: () => void }>) {
  return (
    <header className="sticky top-0 z-30 flex min-h-[58px] items-center gap-3 border-b border-slate-100 bg-white px-3 shadow-[0_5px_18px_rgba(25,45,72,0.035)]">
      <button type="button" onClick={onBack} className="grid h-9 w-9 shrink-0 touch-manipulation place-items-center rounded-full text-slate-700 transition-transform duration-150 active:scale-90 active:bg-slate-100" aria-label="返回"><ChevronLeft className="h-5 w-5" /></button>
      <div className="min-w-0"><h1 className="text-[15px] font-black tracking-[-0.01em] text-slate-950">{title}</h1><p className="mt-0.5 truncate font-mono text-[8px] tracking-wide text-slate-400">{subtitle}</p></div>
    </header>
  );
}

function ServiceTypeButton({ active, icon, title, description, onClick }: Readonly<{ active: boolean; icon: React.ReactNode; title: string; description: string; onClick: () => void }>) {
  return <button type="button" aria-pressed={active} onClick={onClick} className={`touch-manipulation rounded-[14px] p-2.5 text-left transition-all duration-150 active:scale-[0.98] ${active ? 'bg-white text-[#496C95] shadow-[0_3px_12px_rgba(49,72,101,0.08)] ring-1 ring-[#DEE8F3]' : 'text-slate-400'}`}><span className="mb-2 block">{icon}</span><strong className="block text-[10px]">{title}</strong><span className="mt-0.5 block text-[8px] opacity-75">{description}</span></button>;
}

function ReturnMethodButton({ active, icon, title, description, onClick }: Readonly<{ active: boolean; icon: React.ReactNode; title: string; description: string; onClick: () => void }>) {
  return <button type="button" aria-pressed={active} onClick={onClick} className={`flex touch-manipulation items-start gap-2 rounded-[15px] border p-2.5 text-left transition-[background-color,border-color,color,transform] duration-150 active:scale-[0.98] ${active ? 'border-[#CDDEEF] bg-[#F2F7FC] text-[#496C95]' : 'border-slate-100 bg-[#FAFBFC] text-slate-400'}`}><span className="mt-0.5">{icon}</span><span><strong className="block text-[10px]">{title}</strong><span className="mt-0.5 block text-[8px] opacity-75">{description}</span></span></button>;
}

function ProgressLine({ state, title, detail, last = false }: Readonly<{ state: ProgressState; title: string; detail: string; last?: boolean }>) {
  const isDone = state === 'done';
  const isCurrent = state === 'current';
  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        <span className={`relative z-10 grid h-5 w-5 place-items-center rounded-full border ${isDone ? 'border-[#6D91BB] bg-[#6D91BB] text-white' : isCurrent ? 'border-[#8779AA] bg-white text-[#766C99] shadow-[0_0_0_4px_rgba(135,121,170,0.1)]' : 'border-slate-200 bg-[#F8FAFC] text-slate-300'}`}>{isDone ? <Check className="h-3 w-3" /> : <Clock3 className="h-3 w-3" />}</span>
        {!last && <span className={`h-10 w-px ${isDone ? 'bg-[#BFD0E2]' : 'bg-slate-200'}`} />}
      </div>
      <div className="pb-4"><p className={`text-[10px] font-bold ${isDone || isCurrent ? 'text-slate-800' : 'text-slate-400'}`}>{title}</p><p className="mt-1 text-[8px] leading-3.5 text-slate-400">{detail}</p></div>
    </div>
  );
}
