import React from 'react';
import morviaMasterLockupWhite from '../../../../../05_docs_ziliao/VI_shijue/current/ZHU-VI-1.5/assets/svg/morvia-master-lockup-white.svg';
import { IdentityFlowHeader } from './IdentityAudienceSwitch';

export const MorviaIdentityShell: React.FC<Readonly<{
  audience: 'consumer' | 'operator';
  brand: 'morvia' | 'hongtai';
  contextLabel: string;
  onAudienceSwitch: () => void;
  children: React.ReactNode;
}>> = ({ audience, brand, contextLabel, onAudienceSwitch, children }) => (
  <main className="morvia-auth-page" data-brand={brand}>
    <section className="morvia-auth-shell">
      <aside className="morvia-auth-brand">
        {brand === 'morvia' ? (
          <img
            src={morviaMasterLockupWhite}
            alt="主打团"
            className="w-[250px] max-w-[74%]"
          />
        ) : (
          <div className="hongtai-lockup" aria-label="宏泰甄选 Hongtai Select">
            <span className="hongtai-mark">H</span>
            <span><strong>宏泰甄选</strong><small>HONGTAI SELECT</small></span>
          </div>
        )}

        <div className="morvia-auth-message">
          <p className="morvia-auth-context">{contextLabel}</p>
          <h1>让每一份福利，<br />通往更多。</h1>
          <p>一个统一身份，清晰连接个人服务与运营管理。</p>
        </div>

        <div className="morvia-auth-brand-foot">
          <div className="grid grid-cols-3 gap-4 border-b border-white/15 pb-6">
            <BrandPoint index="01" label="统一身份" />
            <BrandPoint index="02" label="清晰分流" />
            <BrandPoint index="03" label="稳定抵达" />
          </div>
          <p className="pt-5 text-[11px] font-medium tracking-[0.08em] text-white/65">技术服务方 · SGSYEN TECH</p>
        </div>
      </aside>

      <div className="morvia-auth-surface">
        <IdentityFlowHeader active={audience} brand={brand} onSwitch={onAudienceSwitch} />
        <div className="morvia-auth-body">{children}</div>
      </div>
    </section>
  </main>
);

const BrandPoint: React.FC<Readonly<{ index: string; label: string }>> = ({ index, label }) => (
  <div>
    <span className="block text-[9px] font-bold tracking-[0.2em] text-white/40">{index}</span>
    <strong className="mt-1 block text-xs font-medium tracking-[0.08em] text-white/85">{label}</strong>
  </div>
);
