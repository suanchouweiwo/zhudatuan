import React from 'react';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';

export interface MetricCardProps {
  label: string;
  value: string | number;
  prefix?: string;
  suffix?: string;
  changeRate?: number; // e.g. 12.4 for +12.4%
  periodLabel?: string;
  footnote?: string;
  actionText?: string;
  onAction?: () => void;
  status?: 'normal' | 'warning' | 'critical';
  className?: string;
}

export const MetricCard: React.FC<MetricCardProps> = ({
  label,
  value,
  prefix,
  suffix,
  changeRate,
  periodLabel = '较昨日',
  footnote,
  actionText,
  onAction,
  status = 'normal',
  className = '',
}) => {
  const isPositive = changeRate !== undefined && changeRate > 0;
  const isNegative = changeRate !== undefined && changeRate < 0;
  const isZero = changeRate !== undefined && changeRate === 0;

  return (
    <div
      className={`console-card p-4 flex flex-col justify-between transition-all duration-150 border-l-2 bg-[var(--console-surface)]  border-[var(--console-border-strong)]  ${
        status === 'warning'
          ? 'border-l-[var(--console-warning)] '
          : status === 'critical'
          ? 'border-l-[var(--console-danger)] '
          : 'border-l-[var(--console-brand)] '
      } ${className}`}
    >
      <div className="flex items-center justify-between text-xs text-[var(--console-text-muted)]  mb-2">
        <span className="font-medium text-[var(--console-text-secondary)] ">{label}</span>
        {actionText && (
          <button
            onClick={onAction}
            className="text-[var(--console-accent)]  hover:underline cursor-pointer select-none text-[11px] font-medium"
          >
            {actionText}
          </button>
        )}
      </div>

      <div className="flex items-baseline gap-1 my-0.5">
        {prefix && (
          <span className="text-sm font-medium text-[var(--console-text-secondary)] ">{prefix}</span>
        )}
        <span className="text-2xl font-bold text-[var(--console-text)]  tabular-nums tracking-tight">
          {typeof value === 'number' ? value.toLocaleString() : value}
        </span>
        {suffix && (
          <span className="text-xs text-[var(--console-text-muted)]  ml-0.5 font-normal">
            {suffix}
          </span>
        )}
      </div>

      <div className="flex flex-col items-start gap-1.5 min-w-0 text-xs text-[var(--console-text-muted)] mt-2 pt-2 border-t border-[var(--console-border)]">
        {changeRate !== undefined ? (
          <div className="flex items-center gap-1.5 whitespace-nowrap shrink-0">
            <span className="text-[11px] text-[var(--console-text-muted)] whitespace-nowrap">{periodLabel}</span>
            <div
              className={`inline-flex items-center gap-0.5 whitespace-nowrap shrink-0 text-xs font-semibold tabular-nums font-mono ${
                isPositive
                  ? 'text-[var(--console-success)] '
                  : isNegative
                  ? 'text-[var(--console-danger)] '
                  : 'text-[var(--console-text-muted)] '
              }`}
            >
              {isPositive && <TrendingUp className="w-3.5 h-3.5 stroke-[2.5]" />}
              {isNegative && <TrendingDown className="w-3.5 h-3.5 stroke-[2.5]" />}
              {isZero && <Minus className="w-3 h-3" />}
              <span>{Math.abs(changeRate)}%</span>
            </div>
          </div>
        ) : (
          <span className="block w-full min-w-0 truncate text-[11px] text-[var(--console-text-muted)]">
            {footnote ?? ''}
          </span>
        )}

        {footnote && changeRate !== undefined && (
          <span className="block w-full min-w-0 truncate text-[11px] text-[var(--console-text-muted)]">
            {footnote}
          </span>
        )}
      </div>
    </div>
  );
};
