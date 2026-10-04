import React from 'react';
import { AlertCircle } from 'lucide-react';

export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label?: string;
  helperText?: string;
  error?: string;
  prefixIcon?: React.ReactNode;
  suffixIcon?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg';
  fullWidth?: boolean;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  (
    {
      label,
      helperText,
      error,
      prefixIcon,
      suffixIcon,
      size = 'md',
      fullWidth = false,
      disabled = false,
      className = '',
      id,
      ...props
    },
    ref
  ) => {
    const inputId = id || (label ? `input-${label.toLowerCase().replace(/\s+/g, '-')}` : undefined);

    const sizeClasses = {
      sm: 'h-7 px-2.5 text-xs',
      md: 'h-[var(--console-input-height)] px-3 text-[length:var(--console-font-size)]',
      lg: 'h-10 px-3.5 text-base',
    }[size];

    return (
      <div className={`flex flex-col gap-1 ${fullWidth ? 'w-full' : ''}`}>
        {label && (
          <label htmlFor={inputId} className="text-xs font-medium text-[var(--console-text-secondary)] select-none flex items-center justify-between">
            <span>{label}</span>
            {props.required && <span className="text-[var(--console-danger)] font-normal">*必填</span>}
          </label>
        )}

        <div className="relative flex items-center">
          {prefixIcon && (
            <div className="absolute left-2.5 flex items-center justify-center text-[var(--console-text-muted)] pointer-events-none">
              {prefixIcon}
            </div>
          )}

          <input
            id={inputId}
            ref={ref}
            disabled={disabled}
            className={`w-full bg-[var(--console-surface)] text-[var(--console-text)] border placeholder:text-[var(--console-text-muted)] rounded-[var(--console-radius)] transition-colors duration-150 outline-none ${sizeClasses} ${
              prefixIcon ? 'pl-8' : ''
            } ${suffixIcon || error ? 'pr-8' : ''} ${
              error
                ? 'border-[var(--console-danger)] bg-[var(--console-danger-bg)]/30 focus:border-[var(--console-danger)] focus:ring-1 focus:ring-[var(--console-danger)]'
                : 'border-[var(--console-border-strong)] hover:border-[var(--console-text-muted)] focus:border-[var(--console-accent)] focus:ring-1 focus:ring-[var(--console-accent)]'
            } ${disabled ? 'bg-[var(--console-hover)] text-[var(--console-text-muted)] cursor-not-allowed border-[var(--console-border)]' : ''} ${className}`}
            {...props}
          />

          {error ? (
            <div className="absolute right-2.5 flex items-center justify-center text-[var(--console-danger)] pointer-events-none">
              <AlertCircle className="w-4 h-4" />
            </div>
          ) : (
            suffixIcon && (
              <div className="absolute right-2.5 flex items-center justify-center text-[var(--console-text-muted)]">
                {suffixIcon}
              </div>
            )
          )}
        </div>

        {error ? (
          <p className="text-xs text-[var(--console-danger)] flex items-center gap-1 mt-0.5">
            <span>{error}</span>
          </p>
        ) : helperText ? (
          <p className="text-[12px] text-[var(--console-text-muted)] mt-0.5">{helperText}</p>
        ) : null}
      </div>
    );
  }
);

Input.displayName = 'Input';
