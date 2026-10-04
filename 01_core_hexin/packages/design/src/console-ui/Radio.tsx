import React from 'react';

export interface RadioOption<T extends string = string> {
  value: T;
  label: string;
  description?: string;
  disabled?: boolean;
}

export interface RadioGroupProps<T extends string = string> {
  options: RadioOption<T>[];
  value: T;
  onChange: (value: T) => void;
  name?: string;
  layout?: 'horizontal' | 'vertical';
  disabled?: boolean;
  className?: string;
}

export function RadioGroup<T extends string = string>({
  options,
  value,
  onChange,
  layout = 'horizontal',
  disabled = false,
  className = '',
}: RadioGroupProps<T>) {
  return (
    <div
      className={`flex ${layout === 'horizontal' ? 'flex-row gap-4' : 'flex-col gap-2'} ${className}`}
    >
      {options.map((option) => {
        const isChecked = option.value === value;
        const isDisabled = disabled || option.disabled;
        return (
          <label
            key={option.value}
            className={`inline-flex items-start gap-2 cursor-pointer select-none text-xs text-[var(--console-text)] ${
              isDisabled ? 'opacity-40 cursor-not-allowed' : ''
            }`}
          >
            <div
              role="radio"
              aria-checked={isChecked}
              tabIndex={isDisabled ? -1 : 0}
              onClick={(e) => {
                e.preventDefault();
                if (!isDisabled) onChange(option.value);
              }}
              className={`w-4 h-4 rounded-full border mt-0.5 transition-colors flex items-center justify-center ${
                isChecked
                  ? 'border-[var(--console-accent)] bg-[var(--console-surface)]'
                  : 'border-[var(--console-border-strong)] bg-[var(--console-surface)] hover:border-[var(--console-text-muted)]'
              } focus:ring-2 focus:ring-[var(--console-accent)]/30 outline-none`}
            >
              {isChecked && <div className="w-2 h-2 rounded-full bg-[var(--console-accent)]" />}
            </div>
            <div className="flex flex-col">
              <span className="font-medium text-[var(--console-text)]">{option.label}</span>
              {option.description && (
                <span className="text-[11px] text-[var(--console-text-muted)]">{option.description}</span>
              )}
            </div>
          </label>
        );
      })}
    </div>
  );
}
