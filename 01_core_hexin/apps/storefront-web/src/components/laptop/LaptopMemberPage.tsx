import { ArrowLeft, ChevronRight, CreditCard, Gift, UserRound } from 'lucide-react';
import type { ReactNode } from 'react';
import { useMall } from '../../context/MallContext';
import type { LaptopPage } from '../../context/MallContext.types';
import { MemberAccountSettings } from '../MemberAccountSettings';
import { MemberProfileDetails } from '../MemberProfileDetails';
import { defaultStorefrontWebPage, type StorefrontWebSurface } from './StorefrontWebStandard';

export function LaptopAccountIdentity({ onSelectTab, children }: {
  onSelectTab: (page: LaptopPage) => void;
  children: ReactNode;
}) {
  const { sessionStatus } = useMall();
  if (sessionStatus === 'checking') {
    return <div aria-hidden="true" className="border-b border-gray-100 pb-3"><div className="h-10" /></div>;
  }
  return sessionStatus === 'authenticated' ? <LaptopMemberEntry onSelectTab={onSelectTab} /> : children;
}

function LaptopMemberEntry({ onSelectTab }: { onSelectTab: (page: LaptopPage) => void }) {
  const { user } = useMall();
  return (
    <button type="button" onClick={() => onSelectTab('member')} className="flex w-full items-center gap-2.5 border-b border-gray-100 pb-3 text-left">
      <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--sw-brand-dark)] text-white shadow-2xs">
        <UserRound className="h-5 w-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-extrabold text-gray-900">会员</span>
        <span className="block truncate text-[11px] text-gray-500">{user.phone}</span>
      </span>
      <span className="flex shrink-0 items-center gap-0.5 whitespace-nowrap text-[11px] font-bold text-[var(--sw-brand)]">
        我的会员 <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
      </span>
    </button>
  );
}

export function LaptopMemberPage({ onSelectTab, surface }: { onSelectTab: (page: LaptopPage) => void; surface: StorefrontWebSurface }) {
  const { user } = useMall();

  return (
    <section className="sw-web-container mx-auto max-w-[1240px] space-y-4 px-3 py-6" aria-labelledby="laptop-member-heading">
      <button type="button" onClick={() => onSelectTab(defaultStorefrontWebPage(surface))} className="flex items-center gap-1.5 text-xs font-semibold text-[var(--sw-brand)] hover:underline">
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />商城首页
      </button>
      <header className="flex items-center justify-between gap-4 rounded-lg border border-gray-200 bg-white px-5 py-4">
        <h1 id="laptop-member-heading" className="text-xl font-bold text-slate-900">我的会员</h1>
        <button type="button" onClick={() => onSelectTab('account-security')} className="mt-2 rounded-lg border border-blue-200 bg-white px-3 py-2 text-xs font-bold text-[var(--sw-brand)]">账号设置</button>
      </header>
      <div className="grid items-start gap-4 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <section className="space-y-3 rounded-lg border border-gray-200 bg-white p-5" aria-label="会员资料">
          <h2 className="text-sm font-bold text-slate-900">会员资料</h2>
          <MemberProfileDetails user={user} />
        </section>
        <section className="space-y-3 rounded-lg border border-gray-200 bg-white p-5" aria-label="会员余额">
          <h2 className="text-sm font-bold text-slate-900">会员余额</h2>
          <div className="rounded-lg bg-blue-50 p-3 text-[var(--sw-brand-dark)]">
            <span className="flex items-center gap-2 text-xs"><CreditCard className="h-4 w-4" aria-hidden="true" />福利卡可用余额</span>
            <p className="mt-1 text-lg font-bold tabular-nums">¥{user.welfareBalance.toFixed(2)}</p>
          </div>
          <div className="rounded-lg bg-emerald-50 p-3 text-emerald-700">
            <span className="flex items-center gap-2 text-xs"><Gift className="h-4 w-4" aria-hidden="true" />餐卡可用余额</span>
            <p className="mt-1 text-lg font-bold tabular-nums">¥{user.mealBalance.toFixed(2)}</p>
          </div>
        </section>
      </div>
    </section>
  );
}

export function LaptopAccountSecurityPage({ onSelectTab }: { onSelectTab: (page: LaptopPage) => void }) {
  return (
    <section className="sw-web-container mx-auto max-w-[1240px] space-y-4 px-3 py-6" aria-labelledby="laptop-account-security-heading">
      <button type="button" onClick={() => onSelectTab('member')} className="flex items-center gap-1.5 text-xs font-semibold text-[var(--sw-brand)] hover:underline">
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />返回我的会员
      </button>
      <div className="laptop-account-security rounded-lg border border-gray-200 bg-white">
        <div className="mx-auto max-w-md px-5 py-7">
          <h1 id="laptop-account-security-heading" className="mb-5 text-xl font-bold text-slate-900">账号安全</h1>
          <MemberAccountSettings embedded />
        </div>
      </div>
    </section>
  );
}
