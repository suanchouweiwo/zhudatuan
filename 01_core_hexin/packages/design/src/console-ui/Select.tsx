import React, { useState, useRef, useEffect } from 'react';
import { ChevronDown, Check } from 'lucide-react';

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
  badge?: string;
  disabled?: boolean;
}

export interface SelectProps {
  label?: string;
  options: SelectOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  size?: 'sm' | 'md' | 'lg';
  fullWidth?: boolean;
  className?: string;
}

export const Select: React.FC<SelectProps> = ({
  label,
  options,
  value,
  onChange,
  placeholder = '请选择',
  disabled = false,
  size = 'md',
  fullWidth = false,
  className = '',
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const selectedOption = options.find((opt) => opt.value === value);

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, []);

  const sizeClasses = {
    sm: 'h-7 px-2.5 text-xs',
    md: 'h-[var(--console-input-height)] px-3 text-[length:var(--console-font-size)]',
    lg: 'h-10 px-3.5 text-base',
  }[size];

  return (
    <div
      ref={containerRef}
      className={`relative flex flex-col gap-1 select-none ${fullWidth ? 'w-full' : ''} ${className}`}
    >
      {label && <span className="text-xs font-medium text-[var(--console-text-secondary)]">{label}</span>}

      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setIsOpen(!isOpen)}
        className={`w-full flex items-center justify-between bg-[var(--console-surface)] text-[var(--console-text)] border border-[var(--console-border-strong)] rounded-[var(--console-radius)] transition-colors duration-150 outline-none text-left cursor-pointer ${sizeClasses} ${
          isOpen ? 'border-[var(--console-accent)] ring-1 ring-[var(--console-accent)]' : 'hover:border-[var(--console-text-muted)]'
        } ${disabled ? 'bg-[var(--console-hover)] text-[var(--console-text-muted)] cursor-not-allowed border-[var(--console-border)]' : ''}`}
      >
        <span className={`truncate ${!selectedOption ? 'text-[var(--console-text-muted)]' : ''}`}>
          {selectedOption ? selectedOption.label : placeholder}
        </span>
        <ChevronDown
          className={`w-3.5 h-3.5 text-[var(--console-text-muted)] shrink-0 transition-transform duration-150 ${
            isOpen ? 'rotate-180 text-[var(--console-accent)]' : ''
          }`}
        />
      </button>

      {isOpen && (
        <div className="absolute top-[calc(100%+4px)] left-0 min-w-full w-max max-h-60 overflow-y-auto bg-[var(--console-surface)] border border-[var(--console-border-strong)] shadow-[var(--console-shadow-floating)] rounded-[var(--console-radius)] z-50 py-1">
          {options.map((option) => {
            const isSelected = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                disabled={option.disabled}
                onClick={() => {
                  onChange(option.value);
                  setIsOpen(false);
                }}
                className={`w-full flex items-center justify-between px-3 py-1.5 text-xs text-left cursor-pointer transition-colors ${
                  isSelected
                    ? 'bg-[var(--console-accent-subtle)] text-[var(--console-brand)] font-semibold'
                    : 'text-[var(--console-text)] hover:bg-[var(--console-subtle)]'
                } ${option.disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
              >
                <div className="flex flex-col pr-4">
                  <span className="truncate">{option.label}</span>
                  {option.description && (
                    <span className="text-[11px] text-[var(--console-text-muted)] font-normal">
                      {option.description}
                    </span>
                  )}
                </div>
                {isSelected && <Check className="w-3.5 h-3.5 text-[var(--console-accent)] shrink-0" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
