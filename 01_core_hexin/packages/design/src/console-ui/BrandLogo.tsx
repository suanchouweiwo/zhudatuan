import type { ReactNode } from 'react';

const mark = new URL('../brand/brand-mark.svg', import.meta.url).href;
const inverseMark = new URL('../brand/brand-mark-white.svg', import.meta.url).href;

export interface BrandLogoProps {
  brandName?: string;
  showAssetLabel?: boolean;
  size?: 'sm' | 'md' | 'lg';
  collapsed?: boolean;
  tier?: string;
  domain?: string;
  inverse?: boolean;
  children?: ReactNode;
}

export function BrandLogo({ brandName = '主打团', showAssetLabel = false, size = 'md', collapsed = false, tier, domain, inverse = false, children }: BrandLogoProps) {
  const iconSize = { sm: 24, md: 32, lg: 40 }[size];
  const fontSize = { sm: 'text-sm', md: 'text-base', lg: 'text-lg' }[size];
  return (
    <div className="console-brand flex items-center gap-2.5 select-none" data-asset-slot="zhudatuan-m-logo">
      <img src={inverse ? inverseMark : mark} alt="主打团 M 标志" width={iconSize} height={iconSize} className="shrink-0 object-contain" title={showAssetLabel ? '现有主打团正式 M 资产' : undefined} />
      {!collapsed && <div className="flex flex-col leading-tight min-w-0">
        <div className="flex items-center gap-1.5">
          <span className={`tracking-tight text-[var(--console-text)] font-bold ${fontSize}`}>{brandName}</span>
          {tier && <span className="px-1 py-0.5 text-[10px] font-mono font-medium rounded-[var(--console-radius)] border bg-[var(--console-accent-subtle)] text-[var(--console-brand)] border-[var(--console-accent-border)]">{tier}</span>}
        </div>
        {domain && <span className="text-[11px] text-[var(--console-text-muted)] font-mono truncate">{domain}</span>}
        {children}
      </div>}
    </div>
  );
}
