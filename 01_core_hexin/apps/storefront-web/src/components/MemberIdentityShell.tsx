import { useEffect, useRef, type ReactNode } from 'react';
import { ShieldCheck, UserRound } from 'lucide-react';
import { resolveStorefrontPresentationIdentity } from '../config/storefrontIdentity';

interface MemberIdentityShellProps {
  children: ReactNode;
  closeDisabled: boolean;
  onClose: () => void;
}

export function MemberIdentityShell({ children, closeDisabled, onClose }: MemberIdentityShellProps) {
  const { brandName, mallName } = resolveStorefrontPresentationIdentity();
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeButton.current?.focus({ preventScroll: true });
  }, []);
  return (
    <div role="dialog" aria-modal="true" aria-label="账号设置" className="member-identity-dialog fixed inset-0 z-[75] overscroll-contain">
      <main className="morvia-auth-page" data-brand="morvia">
        <section className="morvia-auth-shell">
          <aside className="morvia-auth-brand">
            <div className="flex max-w-full items-center gap-4" aria-label={brandName}>
              <img src="/brand/morvia-mark-white.svg" alt="" className="h-14 w-14 shrink-0" />
              <strong className="text-3xl font-bold tracking-[-0.035em] text-white">{brandName}</strong>
            </div>
            <div className="morvia-auth-message">
              <p className="morvia-auth-context">{mallName}</p>
              <h1>让每一份福利，<br />通往更多。</h1>
              <p>一个统一身份，清晰连接个人服务与运营管理。</p>
            </div>
            <div className="morvia-auth-brand-foot">
              <div className="grid grid-cols-3 gap-4 border-b border-white/15 pb-6">
                {['统一身份', '清晰分流', '稳定抵达'].map((label, index) => (
                  <div key={label}>
                    <span className="block text-[9px] font-bold tracking-[0.2em] text-white/40">0{index + 1}</span>
                    <strong className="mt-1 block text-xs font-medium tracking-[0.08em] text-white/85">{label}</strong>
                  </div>
                ))}
              </div>
              <p className="pt-5 text-[11px] font-medium tracking-[0.08em] text-white/65">技术服务方 · SGSYEN TECH</p>
            </div>
          </aside>

          <div className="morvia-auth-surface">
            <header className="flex min-h-[88px] items-center justify-between gap-4 border-b border-[#D7DBE5] bg-white px-6 sm:px-8">
              <div className="flex min-w-0 items-center gap-3">
                <img src="/brand/morvia-mark.svg" alt="" className="h-9 w-9 shrink-0" />
                <div className="min-w-0">
                  <p className="identity-brand-eyebrow text-[10px] font-bold uppercase tracking-[0.18em]">{brandName}统一身份</p>
                  <p className="mt-0.5 truncate text-sm font-bold text-[#111111]">统一账号认证</p>
                </div>
              </div>
              <div className="flex shrink-0 items-end gap-2">
                <div>
                  <p className="mb-1 text-right text-[9px] font-bold uppercase tracking-[0.15em] text-slate-400">当前渠道</p>
                  <span className="identity-channel-button flex min-h-10 items-center justify-center gap-1.5 rounded-xl border bg-white px-3 py-2 text-xs font-bold sm:min-w-[112px]">
                    <UserRound className="h-4 w-4" aria-hidden="true" />会员
                  </span>
                </div>
                <button ref={closeButton} type="button" disabled={closeDisabled} onClick={onClose} className="identity-channel-button min-h-10 rounded-xl border bg-white px-3 text-xs font-bold">关闭</button>
              </div>
            </header>
            <div className="morvia-auth-content">
              <div className="morvia-auth-body">
                <div className="mb-7">
                  <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--sw-brand)]">
                    <ShieldCheck className="h-4 w-4" aria-hidden="true" />会员渠道
                  </div>
                  <h2 className="mt-2 text-3xl font-bold tracking-[-0.035em] text-[#111111]">账号设置</h2>
                </div>
                {children}
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
