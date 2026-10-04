import React, { useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Inbox,
} from 'lucide-react';
import { Checkbox } from './Checkbox';
import { Button } from './Button';

export interface Column<T> {
  key: string;
  title: string;
  align?: 'left' | 'center' | 'right';
  width?: string | number;
  sortable?: boolean;
  render?: (record: T, index: number) => React.ReactNode;
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  dataSource: T[];
  rowKey: (record: T) => string;
  loading?: boolean;
  emptyText?: string;
  emptyActionText?: string;
  onEmptyAction?: () => void;
  // 选择功能
  selectable?: boolean;
  selectedRowKeys?: string[];
  onSelectChange?: (keys: string[]) => void;
  batchActions?: React.ReactNode;
  // 分页
  pagination?: {
    current: number;
    pageSize: number;
    total: number;
    onChange: (page: number, pageSize: number) => void;
  };
  // 密度
  density?: 'comfortable' | 'compact';
  className?: string;
}

export function DataTable<T extends object>({
  columns,
  dataSource,
  rowKey,
  loading = false,
  emptyText = '暂无业务数据',
  emptyActionText,
  onEmptyAction,
  selectable = false,
  selectedRowKeys = [],
  onSelectChange,
  batchActions,
  pagination,
  density = 'comfortable',
  className = '',
}: DataTableProps<T>) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc' | null>(null);

  const handleSort = (key: string) => {
    if (sortKey === key) {
      if (sortDirection === 'asc') setSortDirection('desc');
      else if (sortDirection === 'desc') {
        setSortKey(null);
        setSortDirection(null);
      }
    } else {
      setSortKey(key);
      setSortDirection('asc');
    }
  };

  // 全选状态处理
  const allKeys = dataSource.map(rowKey);
  const isAllSelected = allKeys.length > 0 && allKeys.every((k) => selectedRowKeys.includes(k));
  const isPartiallySelected =
    selectedRowKeys.length > 0 && !isAllSelected && allKeys.some((k) => selectedRowKeys.includes(k));

  const handleSelectAll = (checked: boolean) => {
    if (!onSelectChange) return;
    if (checked) {
      const merged = Array.from(new Set([...selectedRowKeys, ...allKeys]));
      onSelectChange(merged);
    } else {
      const filtered = selectedRowKeys.filter((k) => !allKeys.includes(k));
      onSelectChange(filtered);
    }
  };

  const handleSelectRow = (key: string, checked: boolean) => {
    if (!onSelectChange) return;
    if (checked) {
      onSelectChange([...selectedRowKeys, key]);
    } else {
      onSelectChange(selectedRowKeys.filter((k) => k !== key));
    }
  };

  // 密度高度计算
  const paddingYClass = density === 'compact' ? 'py-1.5' : 'py-2.5';
  const fontSizeClass = density === 'compact' ? 'text-[13px]' : 'text-sm';

  return (
    <div className={`console-card flex flex-col overflow-hidden ${className}`} data-density={density}>
      {/* 批量操作工具条浮层 */}
      {selectable && selectedRowKeys.length > 0 && (
        <div className="bg-[var(--console-accent-subtle)] border-b border-[var(--console-accent-border)] px-4 py-2 flex items-center justify-between text-xs text-[var(--console-brand)]">
          <div className="flex items-center gap-2">
            <span className="font-semibold">已选中 {selectedRowKeys.length} 项</span>
            <button
              onClick={() => onSelectChange && onSelectChange([])}
              className="text-[var(--console-accent)] hover:underline cursor-pointer ml-1"
            >
              清空选择
            </button>
          </div>
          {batchActions && <div className="flex items-center gap-2">{batchActions}</div>}
        </div>
      )}

      {/* 移动端 (max-width: 768px) 横向横滑提示 */}
      <div className="md:hidden px-3 py-1 bg-[var(--console-subtle)] border-b border-[var(--console-border)] flex items-center justify-between text-[11px] text-[var(--console-text-muted)]">
        <span>左右横滑浏览完整表格字段</span>
        <span className="font-mono text-[10px] text-[var(--console-brand)] font-semibold bg-[var(--console-accent-subtle)] px-1.5 py-0.5 rounded-[var(--console-radius)]">← 左右滑动 →</span>
      </div>

      {/* 表格容器 */}
      <div className="overflow-x-auto min-w-full table-touch-scroller">
        <table className="min-w-[640px] w-full border-collapse text-left">
          <thead>
            <tr className="bg-[var(--console-subtle)] border-b border-[var(--console-border-strong)] text-[var(--console-text-secondary)] font-medium text-xs select-none">
              {selectable && (
                <th className="w-10 px-3 py-2 text-center">
                  <Checkbox
                    checked={isAllSelected}
                    indeterminate={isPartiallySelected}
                    onChange={handleSelectAll}
                  />
                </th>
              )}
              {columns.map((col) => {
                const isSorted = sortKey === col.key;
                const alignClass =
                  col.align === 'right'
                    ? 'text-right'
                    : col.align === 'center'
                    ? 'text-center'
                    : 'text-left';

                return (
                  <th
                    key={col.key}
                    style={{ width: col.width }}
                    className={`px-3 py-2.5 whitespace-nowrap ${alignClass} ${
                      col.sortable ? 'cursor-pointer hover:bg-[var(--console-hover)]' : ''
                    }`}
                    onClick={() => col.sortable && handleSort(col.key)}
                  >
                    <div
                      className={`inline-flex items-center gap-1 ${
                        col.align === 'right' ? 'justify-end' : col.align === 'center' ? 'justify-center' : ''
                      }`}
                    >
                      <span>{col.title}</span>
                      {col.sortable && (
                        <span className="text-[var(--console-text-muted)]">
                          {isSorted ? (
                            sortDirection === 'asc' ? (
                              <ArrowUp className="w-3 h-3 text-[var(--console-accent)]" />
                            ) : (
                              <ArrowDown className="w-3 h-3 text-[var(--console-accent)]" />
                            )
                          ) : (
                            <ArrowUpDown className="w-3 h-3 hover:text-[var(--console-text)]" />
                          )}
                        </span>
                      )}
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>

          <tbody className="divide-y divide-[var(--console-border)] bg-[var(--console-surface)]">
            {loading ? (
              // 骨架占位加载态
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={i} className="animate-pulse">
                  {selectable && (
                    <td className="px-3 py-3 text-center">
                      <div className="w-4 h-4 bg-[var(--console-border)] rounded-[var(--console-radius)] mx-auto" />
                    </td>
                  )}
                  {columns.map((col, idx) => (
                    <td key={idx} className="px-3 py-3">
                      <div
                        className="h-3.5 bg-[var(--console-border)] rounded-[var(--console-radius)]"
                        style={{ width: idx === 0 ? '60%' : '80%' }}
                      />
                    </td>
                  ))}
                </tr>
              ))
            ) : dataSource.length === 0 ? (
              // 空数据状态
              <tr>
                <td
                  colSpan={columns.length + (selectable ? 1 : 0)}
                  className="px-6 py-12 text-center text-[var(--console-text-muted)]"
                >
                  <div className="flex flex-col items-center justify-center gap-2 max-w-sm mx-auto">
                    <div className="w-10 h-10 rounded-[var(--console-radius)] bg-[var(--console-subtle)] flex items-center justify-center text-[var(--console-text-muted)] border border-[var(--console-border)]">
                      <Inbox className="w-5 h-5 stroke-[1.5]" />
                    </div>
                    <p className="text-xs font-medium text-[var(--console-text-secondary)]">{emptyText}</p>
                    <p className="text-[11px] text-[var(--console-text-muted)]">
                      未检索到匹配的记录，请尝试调整筛选条件或重置搜索
                    </p>
                    {emptyActionText && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={onEmptyAction}
                        className="mt-2 text-xs"
                      >
                        {emptyActionText}
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ) : (
              // 正常行数据渲染
              dataSource.map((record, index) => {
                const key = rowKey(record);
                const isSelected = selectedRowKeys.includes(key);

                return (
                  <tr
                    key={key}
                    className={`h-[var(--console-row-height)] transition-colors duration-100 ${
                      isSelected
                        ? 'bg-[var(--console-accent-subtle)]/50 hover:bg-[var(--console-accent-subtle)]'
                        : 'hover:bg-[var(--console-subtle)]'
                    } ${fontSizeClass}`}
                  >
                    {selectable && (
                      <td className={`w-10 px-3 ${paddingYClass} text-center`}>
                        <Checkbox
                          checked={isSelected}
                          onChange={(chk) => handleSelectRow(key, chk)}
                        />
                      </td>
                    )}
                    {columns.map((col) => {
                      const alignClass =
                        col.align === 'right'
                          ? 'text-right'
                          : col.align === 'center'
                          ? 'text-center'
                          : 'text-left';

                      const value = record[col.key as keyof T];

                      return (
                        <td
                          key={col.key}
                          className={`px-3 ${paddingYClass} ${alignClass} text-[var(--console-text)]`}
                        >
                          {col.render ? col.render(record, index) : (value ?? '-') as React.ReactNode}
                        </td>
                      );
                    })}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* 分页控制区 */}
      {pagination && (
        <div className="border-t border-[var(--console-border)] px-3 sm:px-4 py-2.5 bg-[var(--console-subtle)] flex flex-wrap items-center justify-between gap-2.5 text-xs text-[var(--console-text-muted)] select-none">
          <div className="flex items-center gap-2">
            <span>
              共 <strong className="text-[var(--console-text)] tabular-nums font-mono">{pagination.total}</strong> 条记录
            </span>
            <span className="text-[var(--console-border-strong)]">|</span>
            <span>
              第 <span className="tabular-nums font-mono">{pagination.current}</span> /{' '}
              <span className="tabular-nums font-mono">
                {Math.ceil(pagination.total / pagination.pageSize) || 1}
              </span>{' '}
              页
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              disabled={pagination.current <= 1 || loading}
              onClick={() => pagination.onChange(pagination.current - 1, pagination.pageSize)}
              className="p-1 border border-[var(--console-border-strong)] bg-[var(--console-surface)] rounded-[var(--console-radius)] hover:bg-[var(--console-hover)] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer text-[var(--console-text-secondary)]"
              title="上一页"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
            <span className="px-2 py-0.5 border border-[var(--console-accent)] bg-[var(--console-surface)] text-[var(--console-accent)] font-semibold rounded-[var(--console-radius)] tabular-nums font-mono">
              {pagination.current}
            </span>
            <button
              disabled={
                pagination.current >= Math.ceil(pagination.total / pagination.pageSize) || loading
              }
              onClick={() => pagination.onChange(pagination.current + 1, pagination.pageSize)}
              className="p-1 border border-[var(--console-border-strong)] bg-[var(--console-surface)] rounded-[var(--console-radius)] hover:bg-[var(--console-hover)] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer text-[var(--console-text-secondary)]"
              title="下一页"
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
