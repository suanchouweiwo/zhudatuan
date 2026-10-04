import React from 'react';

export type StatusVariant = 'success' | 'warning' | 'error' | 'info' | 'neutral' | 'brand';

export interface StatusBadgeProps {
  variant?: StatusVariant;
  label: string;
  showDot?: boolean;
  className?: string;
}

export const StatusBadge: React.FC<StatusBadgeProps> = ({
  variant = 'neutral',
  label,
  showDot = true,
  className = '',
}) => {
  const styles: Record<StatusVariant, { bg: string; border: string; text: string; dot: string }> = {
    success: {
      bg: 'bg-[var(--console-success-bg)]',
      border: 'border-[var(--console-success-border)]',
      text: 'text-[var(--console-success-text)]',
      dot: 'bg-[var(--console-success)]',
    },
    warning: {
      bg: 'bg-[var(--console-warning-bg)]',
      border: 'border-[var(--console-warning-border)]',
      text: 'text-[var(--console-warning-text)]',
      dot: 'bg-[var(--console-warning)]',
    },
    error: {
      bg: 'bg-[var(--console-danger-bg)]',
      border: 'border-[var(--console-danger-border)]',
      text: 'text-[var(--console-danger-text)]',
      dot: 'bg-[var(--console-danger)]',
    },
    info: {
      bg: 'bg-[var(--console-info-bg)]',
      border: 'border-[var(--console-info-border)]',
      text: 'text-[var(--console-info-text)]',
      dot: 'bg-[var(--console-info)]',
    },
    neutral: {
      bg: 'bg-[var(--console-subtle)]',
      border: 'border-[var(--console-border-strong)]',
      text: 'text-[var(--console-text-secondary)]',
      dot: 'bg-[var(--console-text-muted)]',
    },
    brand: {
      bg: 'bg-[var(--console-accent-subtle)]',
      border: 'border-[var(--console-accent-border)]',
      text: 'text-[var(--console-brand)]',
      dot: 'bg-[var(--console-brand)]',
    },
  };

  const current = styles[variant];

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-medium border rounded-[var(--console-radius)] select-none whitespace-nowrap leading-none ${current.bg} ${current.border} ${current.text} ${className}`}
    >
      {showDot && (
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${current.dot}`} aria-hidden="true" />
      )}
      <span>{label}</span>
    </span>
  );
};
