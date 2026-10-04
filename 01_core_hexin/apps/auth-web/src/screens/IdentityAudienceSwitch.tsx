import React from 'react';
import { ShieldCheck, UserRound } from 'lucide-react';
import morviaMark from '../../../../../05_docs_ziliao/VI_shijue/current/ZHU-VI-1.5/assets/svg/morvia-mark.svg';

type IdentityAudience = 'consumer' | 'operator';

export const IdentityAudienceSwitch: React.FC<Readonly<{
  active: IdentityAudience;
  onSwitch: () => void;
}>> = ({ active, onSwitch }) => (
  <button
    type="button"
    onClick={onSwitch}
    aria-label={`当前为${active === 'consumer' ? '会员' : '管理员'}渠道，点击切换到${active === 'consumer' ? '管理员' : '会员'}渠道`}
    className="identity-channel-button flex min-h-10 min-w-[112px] items-center justify-center gap-1.5 rounded-xl border bg-white px-3 py-2 text-xs font-bold transition"
  >
    {active === 'consumer' ? <UserRound className="h-4 w-4" /> : <ShieldCheck className="h-4 w-4" />}
    {active === 'consumer' ? '会员' : '管理员'}
  </button>
);

export const IdentityFlowHeader: React.FC<Readonly<{
  active: IdentityAudience;
  brand: 'morvia' | 'hongtai';
  brandName?: string;
  onSwitch: () => void;
}>> = ({ active, brand, brandName = brand === 'hongtai' ? '宏泰甄选' : '主打团', onSwitch }) => (
  <div className="flex min-h-[88px] items-center justify-between gap-4 border-b border-[#D7DBE5] bg-white px-6 sm:px-8">
    <div className="flex min-w-0 items-center gap-3">
      {brand === 'morvia'
        ? <img src={morviaMark} alt="" className="h-9 w-9 shrink-0" />
        : <span className="hongtai-header-mark" aria-hidden="true">H</span>}
      <div className="min-w-0">
        <p className="identity-brand-eyebrow text-[10px] font-bold uppercase tracking-[0.18em]">{brandName}统一身份</p>
        <p className="mt-0.5 truncate text-sm font-bold text-[#111111]">统一账号认证</p>
      </div>
    </div>
    <div>
      <p className="mb-1 text-right text-[9px] font-bold uppercase tracking-[0.15em] text-slate-400">当前渠道</p>
      <IdentityAudienceSwitch active={active} onSwitch={onSwitch} />
    </div>
  </div>
);
