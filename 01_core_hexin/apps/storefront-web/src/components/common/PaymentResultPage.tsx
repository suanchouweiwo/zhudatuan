'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowRight, Check, ChevronDown, CircleAlert, Clock3, Home, LoaderCircle, ReceiptText, RefreshCw, ShieldCheck } from 'lucide-react';
import { useMall } from '../../context/MallContext';
import type { PaymentFlowStage, PaymentRecoveryRecord } from '../../services/paymentRecovery';
import { productionApi, type ApiPaymentResult, type ApiPaymentResultState, ProductionApiError } from '../../services/productionApi';

interface PaymentResultPageProps {
  readonly paymentId?: string;
  readonly session?: PaymentRecoveryRecord;
}

type PaymentDisplayStage = PaymentFlowStage | 'preparing';

const COPY: Readonly<Record<PaymentDisplayStage, Readonly<{ eyebrow: string; title: string; detail: string }>>> = Object.freeze({
  validating: { eyebrow: '订单已为你保留', title: '正在确认订单', detail: '正在核对商品、金额与收货信息。' },
  'creating-order': { eyebrow: '订单已为你保留', title: '正在创建订单', detail: '马上为你打开微信支付。' },
  'creating-payment': { eyebrow: '订单已创建', title: '正在打开微信支付', detail: '请稍候，不要重复点击结算。' },
  'opening-wechat': { eyebrow: '订单已创建', title: '正在打开微信支付', detail: '微信支付面板即将出现。' },
  'wechat-active': { eyebrow: '微信安全支付', title: '请在微信中完成支付', detail: '完成或取消后，这里会自动确认结果。' },
  verifying: { eyebrow: '已回到商城', title: '正在确认到账', detail: '正在向服务端核对结果，请勿重复付款。' },
  recovery: { eyebrow: '订单已为你保留', title: '支付结果确认中', detail: '网络或渠道稍有延迟，我们会继续确认，请勿重复付款。' },
  captured: { eyebrow: '支付已完成', title: '支付成功', detail: '款项已经确认，订单将继续为你安排。' },
  cancelled: { eyebrow: '订单已为你保留', title: '已取消支付', detail: '没有重复下单，需要时可以继续付款。' },
  failed: { eyebrow: '订单已为你保留', title: '本次支付未完成', detail: '可以为原订单重新发起支付。' },
  expired: { eyebrow: '订单已为你保留', title: '本次支付已过期', detail: '可以为原订单重新发起支付。' },
  preparing: { eyebrow: '订单已为你保留', title: '正在准备支付结果', detail: '正在恢复本次支付，请勿重复付款。' },
});

const PRE_ORDER_COPY: Readonly<Partial<Record<PaymentDisplayStage, Readonly<{ eyebrow: string; title: string; detail: string }>>>> = Object.freeze({
  preparing: { eyebrow: '正在准备结算', title: '正在恢复订单状态', detail: '正在确认订单是否创建，请勿重复提交。' },
  validating: { eyebrow: '正在准备结算', title: '正在确认订单', detail: '正在核对商品、金额与收货信息。' },
  'creating-order': { eyebrow: '正在准备结算', title: '正在创建订单', detail: '订单创建完成后将打开微信支付。' },
  recovery: { eyebrow: '订单状态待确认', title: '正在恢复订单状态', detail: '正在确认订单是否创建，请勿重复提交。' },
  failed: { eyebrow: '订单状态待确认', title: '本次结算未完成', detail: '尚未确认是否已创建订单，请返回购物车后继续原操作。' },
  expired: { eyebrow: '订单状态待确认', title: '本次结算已失效', detail: '尚未确认是否已创建订单，请返回购物车后继续原操作。' },
  cancelled: { eyebrow: '订单状态待确认', title: '本次结算已取消', detail: '尚未确认是否已创建订单，请返回购物车检查。' },
});

const PAYMENT_PROGRESS: Readonly<Record<ApiPaymentResultState, number>> = Object.freeze({
  preparing: 0,
  pending: 1,
  recovery: 2,
  captured: 3,
  failed: 3,
  expired: 3,
});

const FINAL_RESULT_STATES = new Set<ApiPaymentResultState>(['captured', 'failed', 'expired']);

export function paymentResultReadFailure(cause: unknown): Readonly<{ message: string | null; retryAfterMs: number }> {
  if (cause instanceof ProductionApiError && (cause.status === 404 || cause.code === 'NOT_FOUND')) {
    return { message: null, retryAfterMs: 1_000 };
  }
  if (cause instanceof ProductionApiError && cause.status === 0) {
    return { message: cause.message, retryAfterMs: 1_000 };
  }
  return {
    message: cause instanceof ProductionApiError ? cause.message : '支付结果暂时无法读取，我们会继续确认',
    retryAfterMs: 3_000,
  };
}

export function selectPaymentResult(previous: ApiPaymentResult | null, next: ApiPaymentResult): ApiPaymentResult {
  if (!previous) return next;
  if (PAYMENT_PROGRESS[previous.state] === 3) return previous;
  return PAYMENT_PROGRESS[next.state] < PAYMENT_PROGRESS[previous.state] ? previous : next;
}

export function paymentDisplayStage(session: PaymentRecoveryRecord | undefined, result: ApiPaymentResult | null): PaymentDisplayStage {
  if (result?.state === 'captured' || result?.state === 'failed' || result?.state === 'expired') return result.state;
  if (session?.stage === 'cancelled') return 'cancelled';
  if (result?.state === 'recovery') return 'recovery';
  if (result?.state === 'pending') return 'verifying';
  return session?.stage ?? 'preparing';
}

export function paymentDisplayCopy(stage: PaymentDisplayStage, orderId: string | null) {
  return orderId === null ? PRE_ORDER_COPY[stage] ?? COPY[stage] : COPY[stage];
}

export function paymentOrderStatusLabel(stage: PaymentDisplayStage, orderId: string | null): string {
  if (orderId !== null) return '订单已安全保留';
  return ['failed', 'expired', 'cancelled'].includes(stage) ? '尚未确认订单' : '正在建立订单';
}

export function PaymentResultPage({ paymentId, session }: PaymentResultPageProps) {
  const {
    closePaymentResult,
    continueActivePayment,
    isSubmittingOrder,
    navigateTo,
    recordPaymentResult,
    setAndroidPage,
    setLaptopPage,
    setMpPage,
    setTabletPage,
  } = useMall();
  const resolvedPaymentId = session?.paymentId ?? paymentId ?? null;
  const [result, setResult] = useState<ApiPaymentResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(Boolean(resolvedPaymentId));
  const [cycle, setCycle] = useState(0);
  const [showStatusAction, setShowStatusAction] = useState(false);

  useEffect(() => {
    if (!resolvedPaymentId) {
      setRefreshing(false);
      return undefined;
    }
    let active = true;
    let timer: number | undefined;
    setRefreshing(true);
    void productionApi.readPaymentResult(resolvedPaymentId).then((next) => {
      if (!active) return;
      setResult((previous) => selectPaymentResult(previous, next));
      recordPaymentResult(next);
      setError(null);
      setRefreshing(false);
      if (!FINAL_RESULT_STATES.has(next.state)) {
        const retryAfterMs = next.retryAfter > 0 ? next.retryAfter * 1_000 : 1_500;
        timer = window.setTimeout(() => setCycle((value) => value + 1), retryAfterMs);
      }
    }).catch((cause: unknown) => {
      if (!active) return;
      const failure = paymentResultReadFailure(cause);
      setError(failure.message);
      setRefreshing(false);
      timer = window.setTimeout(() => setCycle((value) => value + 1), failure.retryAfterMs);
    });
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [cycle, recordPaymentResult, resolvedPaymentId]);

  useEffect(() => {
    const reveal = window.setTimeout(() => setShowStatusAction(true), 8_000);
    const refreshAfterReturn = () => {
      if (document.visibilityState !== 'hidden') setCycle((value) => value + 1);
    };
    window.addEventListener('pageshow', refreshAfterReturn);
    document.addEventListener('visibilitychange', refreshAfterReturn);
    return () => {
      window.clearTimeout(reveal);
      window.removeEventListener('pageshow', refreshAfterReturn);
      document.removeEventListener('visibilitychange', refreshAfterReturn);
    };
  }, [resolvedPaymentId]);

  const stage = paymentDisplayStage(session, result);
  const amountMinor = result?.amountMinor ?? session?.amountMinor ?? 0;
  const currency = result?.currency ?? session?.currency ?? 'CNY';
  const amount = useMemo(() => formatPaymentAmount(amountMinor, currency), [amountMinor, currency]);
  const orderId = result?.orderId ?? session?.orderId ?? null;
  const copy = paymentDisplayCopy(stage, orderId);
  const retryPayment = stage === 'cancelled' || stage === 'failed' || stage === 'expired';
  const captured = stage === 'captured';
  const pending = !retryPayment && !captured;

  const goToOrders = () => {
    setMpPage('orders');
    setAndroidPage('orders');
    setTabletPage('orders');
    setLaptopPage('orders');
    navigateTo('orders', orderId ? { orderId } : {});
    closePaymentResult();
  };
  const goHome = () => {
    setMpPage('home');
    setAndroidPage('home');
    setTabletPage('home');
    setLaptopPage('home-1366');
    navigateTo('home');
    closePaymentResult();
  };
  const goToCart = () => {
    setMpPage('cart');
    setAndroidPage('checkout');
    setTabletPage('cart');
    setLaptopPage('cart');
    navigateTo('cart');
    closePaymentResult();
  };

  return (
    <section className="min-h-[72vh] bg-[radial-gradient(circle_at_50%_-8%,rgba(210,232,255,0.95)_0%,rgba(244,248,252,0.98)_36%,#f5f7fa_72%)] px-4 py-8 motion-safe:animate-[paymentCarrierIn_160ms_ease-out] md:py-14">
      <div className="mx-auto max-w-[680px] overflow-hidden rounded-[30px] border border-white/90 bg-white/95 shadow-[0_24px_72px_rgba(31,78,126,0.11),0_2px_12px_rgba(36,102,170,0.06)] backdrop-blur-sm">
        <div className="flex items-center justify-between border-b border-slate-100/80 px-5 py-4 md:px-8">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-50 text-[#1769e8]"><ShieldCheck className="h-[18px] w-[18px]" strokeWidth={2} /></span>
            <span className="truncate text-sm font-semibold text-slate-700">{session?.mallName ?? '安心支付'}</span>
          </div>
          <span className="shrink-0 rounded-full bg-[#f4f8ff] px-3 py-1 text-[11px] font-medium text-[#5175a4]">{orderId ? '微信支付' : '安全结算'}</span>
        </div>

        <div className="px-5 pb-7 pt-8 text-center md:px-10 md:pb-10 md:pt-10" aria-live="polite">
          <PaymentStatusMark stage={stage} refreshing={refreshing} />
          <p className="mt-5 text-xs font-semibold tracking-[0.14em] text-[#6483a8]">{copy.eyebrow}</p>
          <h1 className="mt-2 text-[25px] font-bold tracking-tight text-[#13233a] md:text-[30px]">{copy.title}</h1>
          <p className="mx-auto mt-2 max-w-[480px] text-sm leading-6 text-slate-500">{error ?? copy.detail}</p>

          <div className="mt-7 rounded-[22px] border border-[#e9f1fb] bg-[linear-gradient(145deg,#f9fcff_0%,#f2f7fd_100%)] px-5 py-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]">
            <p className="text-[11px] font-medium tracking-[0.08em] text-slate-400">{orderId ? '本次支付' : '本次结算'}</p>
            <p className="mt-1 text-[38px] font-bold tabular-nums tracking-[-0.04em] text-[#14243b]">{amount}</p>
            <div className="mx-auto mt-3 flex w-fit items-center gap-2 rounded-full bg-white/90 px-3 py-1.5 text-xs text-slate-500 shadow-[0_1px_5px_rgba(35,75,120,0.06)]">
              <ReceiptText className="h-3.5 w-3.5 text-[#2a75df]" /><span>{paymentOrderStatusLabel(stage, orderId)}</span>
            </div>
          </div>

          {stage === 'recovery' || error ? (
            <div className="mt-4 rounded-2xl border border-[#e7eef7] bg-[#f8fafc] px-4 py-3 text-left text-xs leading-5 text-[#5e6f84]">{orderId ? '无需重复付款。连接恢复后，页面会继续确认本次支付结果。' : '订单尚未确认创建。请勿重复提交，可返回购物车检查商品信息。'}</div>
          ) : null}

          {(orderId || resolvedPaymentId) ? (
            <details className="group mt-4 rounded-2xl border border-slate-100 bg-white text-left">
              <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between px-4 text-xs font-medium text-slate-500">
                <span>订单详情</span><ChevronDown className="h-4 w-4 transition-transform duration-150 group-open:rotate-180 motion-reduce:transition-none" />
              </summary>
              <div className="border-t border-slate-100 px-4 py-3">
                {orderId ? <ResultRow label="订单编号" value={orderId} /> : null}
                {resolvedPaymentId ? <ResultRow label="支付记录" value={resolvedPaymentId} /> : null}
              </div>
            </details>
          ) : null}

          <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-center">
            {captured ? (
              <><PrimaryButton onClick={goToOrders}>查看订单<ArrowRight className="h-4 w-4" /></PrimaryButton><SecondaryButton onClick={goHome}><Home className="h-4 w-4" />返回首页</SecondaryButton></>
            ) : null}
            {retryPayment && orderId ? (
              <><PrimaryButton onClick={() => void continueActivePayment()} disabled={isSubmittingOrder}>{isSubmittingOrder ? <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <RefreshCw className="h-4 w-4" />}{stage === 'cancelled' ? '继续付款' : '重新支付'}</PrimaryButton><SecondaryButton onClick={goToOrders}>查看订单</SecondaryButton></>
            ) : null}
            {retryPayment && !orderId ? <PrimaryButton onClick={goToCart}>返回购物车确认</PrimaryButton> : null}
            {pending && (showStatusAction || error) ? (
              <button type="button" onClick={goToOrders} className="mx-auto inline-flex min-h-10 items-center justify-center gap-1.5 rounded-full px-4 text-xs font-semibold text-[#426b9b] transition-colors duration-150 hover:bg-blue-50 active:bg-blue-100 motion-reduce:transition-none">查看订单状态<ArrowRight className="h-3.5 w-3.5" /></button>
            ) : null}
          </div>

          {pending && error ? (
            <button type="button" onClick={() => setCycle((value) => value + 1)} disabled={refreshing} className="mt-3 inline-flex min-h-9 items-center gap-1.5 px-3 text-xs font-medium text-slate-400 active:text-[#1769e8] disabled:opacity-50"><RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin motion-reduce:animate-none' : ''}`} />继续确认支付结果</button>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function PaymentStatusMark({ stage, refreshing }: Readonly<{ stage: PaymentDisplayStage; refreshing: boolean }>) {
  if (stage === 'captured') {
    return <div className="relative mx-auto flex h-24 w-24 items-center justify-center"><span className="absolute inset-1 rounded-full bg-emerald-100/70 blur-xl" /><span className="relative flex h-[74px] w-[74px] items-center justify-center rounded-full border border-emerald-200 bg-white text-emerald-600 shadow-[0_8px_28px_rgba(16,185,129,0.16)] motion-safe:animate-[paymentSuccess_280ms_ease-out]"><Check className="h-9 w-9" strokeWidth={2.5} /></span></div>;
  }
  if (stage === 'failed' || stage === 'expired') return <StatusShell><CircleAlert className="h-8 w-8" strokeWidth={1.8} /></StatusShell>;
  if (stage === 'cancelled') return <StatusShell><Clock3 className="h-8 w-8" strokeWidth={1.8} /></StatusShell>;
  return (
    <div className="relative mx-auto flex h-24 w-24 items-center justify-center">
      <span className="absolute inset-0 rounded-full bg-[#dceeff]/80 blur-2xl motion-safe:animate-[pulse_2.8s_ease-in-out_infinite]" />
      <span className="absolute h-[76px] w-[76px] rounded-full border border-[#cfe3f8]/90 bg-white/65 shadow-[inset_0_0_18px_rgba(181,218,249,0.42),0_8px_30px_rgba(72,139,203,0.12)] motion-safe:animate-[pulse_2.4s_ease-in-out_infinite]" />
      <span className="relative flex h-[54px] w-[54px] items-center justify-center rounded-[52%_48%_58%_42%/46%_55%_45%_54%] border border-white bg-[linear-gradient(145deg,rgba(255,255,255,0.98),rgba(213,235,255,0.78))] text-[#2677d5] shadow-[inset_8px_8px_16px_rgba(255,255,255,0.84),0_10px_24px_rgba(74,139,197,0.16)] motion-safe:animate-[pulse_3.1s_ease-in-out_infinite]">
        <LoaderCircle className={`h-6 w-6 ${refreshing ? 'animate-spin motion-reduce:animate-none' : ''}`} strokeWidth={1.8} />
      </span>
    </div>
  );
}

function StatusShell({ children }: Readonly<{ children: ReactNode }>) {
  return <div className="relative mx-auto flex h-24 w-24 items-center justify-center text-[#60758e]"><span className="absolute inset-2 rounded-full bg-[#eaf2fa] blur-xl" /><span className="relative flex h-[72px] w-[72px] items-center justify-center rounded-full border border-[#dfeaf5] bg-white shadow-[0_8px_28px_rgba(60,99,140,0.1)]">{children}</span></div>;
}

function PrimaryButton({ children, disabled = false, onClick }: Readonly<{ children: ReactNode; disabled?: boolean; onClick: () => void }>) {
  return <button type="button" onClick={onClick} disabled={disabled} className="inline-flex min-h-12 flex-1 items-center justify-center gap-2 rounded-2xl bg-[linear-gradient(135deg,#1769e8,#2f7df1)] px-6 text-sm font-bold text-white shadow-[0_10px_24px_rgba(23,105,232,0.22)] transition duration-150 hover:brightness-[1.03] active:translate-y-px active:scale-[0.992] disabled:opacity-60 motion-reduce:transform-none motion-reduce:transition-none sm:max-w-[220px]">{children}</button>;
}

function SecondaryButton({ children, onClick }: Readonly<{ children: ReactNode; onClick: () => void }>) {
  return <button type="button" onClick={onClick} className="inline-flex min-h-12 flex-1 items-center justify-center gap-2 rounded-2xl border border-[#dce7f3] bg-white px-6 text-sm font-semibold text-[#36597f] transition duration-150 hover:bg-[#f7fbff] active:translate-y-px active:bg-blue-50 motion-reduce:transform-none motion-reduce:transition-none sm:max-w-[220px]">{children}</button>;
}

function ResultRow({ label, value }: Readonly<{ label: string; value: string }>) {
  return <div className="flex items-start justify-between gap-4 border-t border-slate-100 py-2.5 first:border-t-0 first:pt-0 last:pb-0"><span className="shrink-0 text-[11px] text-slate-400">{label}</span><span className="break-all text-right font-mono text-[11px] text-slate-500">{value}</span></div>;
}

function formatPaymentAmount(amountMinor: number, currency: string): string {
  const value = (amountMinor / 100).toFixed(2);
  return currency === 'CNY' ? `¥${value}` : `${currency} ${value}`;
}
