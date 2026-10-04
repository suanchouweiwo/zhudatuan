import React, { useEffect } from 'react';
import { X } from 'lucide-react';

export interface DrawerProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: 'md' | 'lg' | 'xl';
}

export const Drawer: React.FC<DrawerProps> = ({
  isOpen,
  onClose,
  title,
  subtitle,
  children,
  footer,
  width = 'md',
}) => {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const widthClasses = {
    md: 'max-w-md',
    lg: 'max-w-xl',
    xl: 'max-w-3xl',
  }[width];

  return (
    <div className="fixed inset-0 z-50 overflow-hidden">
      {/* 遮罩 */}
      <div
        className="fixed inset-0 bg-[var(--console-scrim)] backdrop-blur-xs transition-opacity"
        onClick={onClose}
        aria-hidden="true"
      />

      <div className="fixed inset-y-0 right-0 pl-0 sm:pl-10 max-w-full flex">
        <div
          role="dialog"
          aria-modal="true"
          aria-label={title}
          className={`w-screen ${widthClasses} bg-[var(--console-surface)] shadow-[var(--console-shadow-floating)] border-l border-[var(--console-border-strong)] flex flex-col`}
        >
          {/* 抽屉头部 */}
          <div className="border-t-2 border-t-[var(--console-brand)] px-4 sm:px-6 py-3.5 sm:py-4 border-b border-[var(--console-border)] flex items-center justify-between bg-[var(--console-subtle)]">
            <div>
              <h3 className="text-sm font-semibold text-[var(--console-text)]">{title}</h3>
              {subtitle && <p className="text-xs text-[var(--console-text-muted)] mt-0.5">{subtitle}</p>}
            </div>
            <button
              onClick={onClose}
              className="text-[var(--console-text-muted)] hover:text-[var(--console-text)] p-1.5 rounded-[var(--console-radius)] hover:bg-[var(--console-hover)] cursor-pointer transition-colors"
              title="关闭抽屉"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* 抽屉内容区 */}
          <div className="p-4 sm:p-6 overflow-y-auto flex-1 text-xs text-[var(--console-text-secondary)] leading-relaxed">
            {children}
          </div>

          {/* 抽屉底部 */}
          {footer && (
            <div className="px-4 sm:px-6 py-3 border-t border-[var(--console-border)] bg-[var(--console-subtle)] flex items-center justify-end gap-2.5">
              {footer}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
