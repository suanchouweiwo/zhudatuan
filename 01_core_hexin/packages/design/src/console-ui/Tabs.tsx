import React from 'react';

export interface TabItem {
  id: string;
  label: string;
  count?: number;
  disabled?: boolean;
}

export interface TabsProps {
  items: TabItem[];
  activeId: string;
  onChange: (id: string) => void;
  variant?: 'underline' | 'segmented';
  className?: string;
}

export const Tabs: React.FC<TabsProps> = ({
  items,
  activeId,
  onChange,
  variant = 'underline',
  className = '',
}) => {
  if (variant === 'segmented') {
    return (
      <div
        className={`inline-flex items-center p-0.5 bg-[var(--console-hover)] border border-[var(--console-border)] rounded-[var(--console-radius)] ${className}`}
        role="tablist"
      >
        {items.map((tab) => {
          const isActive = tab.id === activeId;
          return (
            <button
              key={tab.id}
              role="tab"
              aria-selected={isActive}
              disabled={tab.disabled}
              onClick={() => onChange(tab.id)}
              className={`px-3 py-1 text-xs font-medium rounded-[var(--console-radius)] transition-colors whitespace-nowrap cursor-pointer select-none flex items-center gap-1.5 ${
                isActive
                  ? 'bg-[var(--console-surface)] text-[var(--console-brand)] shadow-[var(--console-shadow-subtle)] font-semibold'
                  : 'text-[var(--console-text-muted)] hover:text-[var(--console-text)]'
              } ${tab.disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
            >
              <span>{tab.label}</span>
              {typeof tab.count === 'number' && (
                <span
                  className={`text-[11px] tabular-nums font-mono px-1 py-0.5 rounded-[var(--console-radius)] ${
                    isActive ? 'bg-[var(--console-accent-subtle)] text-[var(--console-accent)]' : 'bg-[var(--console-border)] text-[var(--console-text-secondary)]'
                  }`}
                >
                  {tab.count}
                </span>
              )}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div className={`flex items-center gap-6 border-b border-[var(--console-border)] ${className}`} role="tablist">
      {items.map((tab) => {
        const isActive = tab.id === activeId;
        return (
          <button
            key={tab.id}
            role="tab"
            aria-selected={isActive}
            disabled={tab.disabled}
            onClick={() => onChange(tab.id)}
            className={`pb-2.5 pt-1 text-sm font-medium transition-colors cursor-pointer select-none relative whitespace-nowrap flex items-center gap-2 ${
              isActive ? 'text-[var(--console-brand)] font-semibold' : 'text-[var(--console-text-muted)] hover:text-[var(--console-text)]'
            } ${tab.disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
          >
            <span>{tab.label}</span>
            {typeof tab.count === 'number' && (
              <span
                className={`text-xs tabular-nums font-mono px-1.5 py-0.5 rounded-[var(--console-radius)] ${
                  isActive ? 'bg-[var(--console-accent-subtle)] text-[var(--console-accent)]' : 'bg-[var(--console-hover)] text-[var(--console-text-muted)]'
                }`}
              >
                {tab.count}
              </span>
            )}
            {/* 激活指示线使用交互强调色 */}
            {isActive && (
              <span
                className="absolute bottom-0 left-0 right-0 h-0.5 bg-[var(--console-accent)] rounded-none"
                aria-hidden="true"
              />
            )}
          </button>
        );
      })}
    </div>
  );
};
