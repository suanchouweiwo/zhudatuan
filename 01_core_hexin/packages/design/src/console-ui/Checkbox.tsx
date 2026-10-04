import React from 'react';
import { Check } from 'lucide-react';

export interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: React.ReactNode;
  disabled?: boolean;
  indeterminate?: boolean;
  className?: string;
}

export const Checkbox: React.FC<CheckboxProps> = ({
  checked,
  onChange,
  label,
  disabled = false,
  indeterminate = false,
  className = '',
}) => {
  return (
    <label
      className={`inline-flex items-center gap-2 cursor-pointer select-none text-xs text-[var(--console-text)] ${
        disabled ? 'cursor-not-allowed opacity-50' : ''
      } ${className}`}
    >
      <div
        role="checkbox"
        aria-checked={indeterminate ? 'mixed' : checked}
        tabIndex={disabled ? -1 : 0}
        onClick={(e) => {
          e.preventDefault();
          if (!disabled) onChange(!checked);
        }}
        onKeyDown={(e) => {
          if ((e.key === ' ' || e.key === 'Enter') && !disabled) {
            e.preventDefault();
            onChange(!checked);
          }
        }}
        className={`w-4 h-4 rounded-[var(--console-radius)] border transition-colors flex items-center justify-center ${
          checked || indeterminate
            ? 'bg-[var(--console-accent)] border-[var(--console-accent)] text-[var(--console-inverse)]'
            : 'bg-[var(--console-surface)] border-[var(--console-border-strong)] hover:border-[var(--console-text-muted)]'
        } focus:ring-2 focus:ring-[var(--console-accent)]/30 outline-none`}
      >
        {checked && <Check className="w-3 h-3 stroke-[2.5]" />}
        {indeterminate && !checked && <span className="w-2 h-0.5 bg-[var(--console-inverse)] rounded-[var(--console-radius)]" />}
      </div>
      {label && <span>{label}</span>}
    </label>
  );
};
