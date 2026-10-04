import React from 'react';
import { Search, RefreshCw, SlidersHorizontal } from 'lucide-react';
import { Input } from './Input';
import { Button } from './Button';

export interface ToolbarProps {
  searchValue: string;
  onSearchChange: (value: string) => void;
  searchPlaceholder?: string;
  filters?: React.ReactNode;
  actions?: React.ReactNode;
  onRefresh?: () => void;
  isRefreshing?: boolean;
  density?: 'comfortable' | 'compact';
  onDensityChange?: (density: 'comfortable' | 'compact') => void;
  className?: string;
}

export const Toolbar: React.FC<ToolbarProps> = ({
  searchValue,
  onSearchChange,
  searchPlaceholder = '输入关键词检索...',
  filters,
  actions,
  onRefresh,
  isRefreshing = false,
  density,
  onDensityChange,
  className = '',
}) => {
  return (
    <div
      className={`console-card p-3 mb-4 flex flex-wrap items-center justify-between gap-3 bg-[var(--console-surface)] ${className}`}
    >
      {/* 左侧：搜索与自定义筛选项 */}
      <div className="flex flex-wrap items-center gap-2.5 w-full sm:w-auto sm:flex-1 min-w-0">
        <div className="w-full sm:w-64 max-w-full">
          <Input
            size="sm"
            value={searchValue}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={searchPlaceholder}
            prefixIcon={<Search className="w-3.5 h-3.5" />}
          />
        </div>

        {filters && <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">{filters}</div>}
      </div>

      {/* 右侧：刷新、密度切换、业务操作 */}
      <div className="flex items-center gap-2 shrink-0 flex-wrap sm:flex-nowrap w-full sm:w-auto justify-between sm:justify-end pt-1 sm:pt-0 border-t sm:border-t-0 border-[var(--console-hover)]">
        {onDensityChange && density && (
          <div className="flex items-center border border-[var(--console-border-strong)] rounded-[var(--console-radius)] p-0.5 bg-[var(--console-subtle)]">
            <button
              type="button"
              onClick={() => onDensityChange('comfortable')}
              className={`px-2 py-0.5 text-xs font-medium rounded-[var(--console-radius)] transition-colors cursor-pointer ${
                density === 'comfortable'
                  ? 'bg-[var(--console-surface)] text-[var(--console-brand)] shadow-[var(--console-shadow-subtle)]'
                  : 'text-[var(--console-text-muted)] hover:text-[var(--console-text)]'
              }`}
              title="舒适密度 (默认行高)"
            >
              舒适
            </button>
            <button
              type="button"
              onClick={() => onDensityChange('compact')}
              className={`px-2 py-0.5 text-xs font-medium rounded-[var(--console-radius)] transition-colors cursor-pointer ${
                density === 'compact'
                  ? 'bg-[var(--console-surface)] text-[var(--console-brand)] shadow-[var(--console-shadow-subtle)]'
                  : 'text-[var(--console-text-muted)] hover:text-[var(--console-text)]'
              }`}
              title="紧凑密度 (高数据吞吐)"
            >
              紧凑
            </button>
          </div>
        )}

        {onRefresh && (
          <Button
            size="sm"
            variant="secondary"
            onClick={onRefresh}
            isLoading={isRefreshing}
            leftIcon={<RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />}
            title="刷新当前数据列表"
          >
            刷新
          </Button>
        )}

        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
};
