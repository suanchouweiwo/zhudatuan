import React, { useEffect } from 'react';
import { X } from 'lucide-react';
import { Button } from './Button';

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  onConfirm?: () => void;
  confirmText?: string;
  cancelText?: string;
  isLoading?: boolean | undefined;
  width?: 'sm' | 'md' | 'lg' | 'xl';
}

export const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  title,
  subtitle,
  children,
  footer,
  onConfirm,
  confirmText = '确认提交',
  cancelText = '取消',
  isLoading = false,
  width = 'md',
}) => {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const widthClasses = {
    sm: 'max-w-md',
    md: 'max-w-lg',
    lg: 'max-w-2xl',
    xl: 'max-w-4xl',
  }[width];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4">
      {/* 遮罩层 */}
      <div
        className="fixed inset-0 bg-[var(--console-scrim)] backdrop-blur-xs transition-opacity duration-150"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* 模态框主体 */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`relative w-full ${widthClasses} bg-[var(--console-surface)] rounded-[var(--console-radius)] shadow-[var(--console-shadow-floating)] border border-[var(--console-border-strong)] overflow-hidden z-10 flex flex-col max-h-[90vh]`}
      >
        {/* 标题栏使用当前主题的品牌与表面参数 */}
        <div className="border-t-2 border-t-[var(--console-brand)] px-4 sm:px-5 py-3.5 sm:py-4 border-b border-[var(--console-border)] flex items-center justify-between bg-[var(--console-subtle)]">
          <div>
            <h3 className="text-sm font-semibold text-[var(--console-text)]">{title}</h3>
            {subtitle && <p className="text-xs text-[var(--console-text-muted)] mt-0.5">{subtitle}</p>}
          </div>
          <button
            onClick={onClose}
            className="text-[var(--console-text-muted)] hover:text-[var(--console-text)] p-1 rounded-[var(--console-radius)] hover:bg-[var(--console-hover)] cursor-pointer transition-colors"
            title="关闭窗口 (Esc)"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 内容区 */}
        <div className="px-4 sm:px-5 py-4 overflow-y-auto flex-1 text-xs text-[var(--console-text-secondary)] leading-relaxed">
          {children}
        </div>

        {/* 底部操作区 */}
        <div className="px-4 sm:px-5 py-3 border-t border-[var(--console-border)] bg-[var(--console-subtle)] flex items-center justify-end gap-2.5">
          {footer !== undefined ? (
            footer
          ) : (
            <>
              <Button variant="secondary" size="sm" onClick={onClose}>
                {cancelText}
              </Button>
              {onConfirm && (
                <Button
                  variant="primary"
                  size="sm"
                  isLoading={isLoading}
                  onClick={onConfirm}
                >
                  {confirmText}
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
