import React from 'react';
import { Loader2 } from 'lucide-react';

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  isLoading?: boolean | undefined;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      children,
      variant = 'secondary',
      size = 'md',
      isLoading = false,
      disabled = false,
      leftIcon,
      rightIcon,
      className = '',
      ...props
    },
    ref
  ) => {
    // 尺寸规范
    const sizeClasses = {
      sm: 'h-7 px-2.5 text-xs gap-1.5',
      md: 'h-[var(--console-input-height)] px-3.5 text-[length:var(--console-font-size)] gap-2',
      lg: 'h-10 px-4 text-base gap-2.5',
    }[size];

    // 变体风格规范
    const variantClasses = {
      // 交互强调蓝：主操作 CTA
      primary:
        'bg-[var(--console-accent)] text-[var(--console-inverse)] hover:bg-[var(--console-accent-hover)] active:bg-[var(--console-accent-pressed)] border border-transparent shadow-[var(--console-shadow-subtle)] focus-visible:ring-2 focus-visible:ring-[var(--console-accent)]/30 focus-visible:ring-offset-1',
      // 次级操作：白色表面 + 细边框
      secondary:
        'bg-[var(--console-surface)] text-[var(--console-text)] border border-[var(--console-border-strong)] hover:bg-[var(--console-subtle)] hover:border-[var(--console-text-muted)] active:bg-[var(--console-hover)] shadow-[var(--console-shadow-subtle)] focus-visible:ring-2 focus-visible:ring-[var(--console-accent)]/30',
      // 线框按钮
      outline:
        'bg-transparent text-[var(--console-accent)] border border-[var(--console-accent)] hover:bg-[var(--console-accent-subtle)] active:bg-[var(--console-selected)] focus-visible:ring-2 focus-visible:ring-[var(--console-accent)]/30',
      // 幽灵按钮
      ghost:
        'bg-transparent text-[var(--console-text-secondary)] hover:bg-[var(--console-hover)] hover:text-[var(--console-text)] active:bg-[var(--console-border)] border border-transparent',
      // 危险破坏性操作
      danger:
        'bg-[var(--console-danger)] text-[var(--console-inverse)] hover:bg-[var(--console-danger-hover)] active:bg-[var(--console-danger-pressed)] border border-transparent shadow-[var(--console-shadow-subtle)] focus-visible:ring-2 focus-visible:ring-[var(--console-danger)]/30',
    }[variant];

    const isDisabled = disabled || isLoading;

    return (
      <button
        ref={ref}
        disabled={isDisabled}
        className={`inline-flex items-center justify-center font-medium select-none whitespace-nowrap transition-colors duration-150 rounded-[var(--console-radius)] cursor-pointer outline-none ${sizeClasses} ${variantClasses} ${
          isDisabled ? 'opacity-50 cursor-not-allowed pointer-events-none' : ''
        } ${className}`}
        {...props}
      >
        {isLoading ? (
          <Loader2 className="w-4 h-4 animate-spin shrink-0 text-current" />
        ) : (
          leftIcon && <span className="shrink-0">{leftIcon}</span>
        )}
        <span>{children}</span>
        {!isLoading && rightIcon && <span className="shrink-0">{rightIcon}</span>}
      </button>
    );
  }
);

Button.displayName = 'Button';
