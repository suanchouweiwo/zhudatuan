import React, { createContext, useContext, useState, useCallback } from 'react';
import { CheckCircle2, AlertTriangle, AlertCircle, Info, X } from 'lucide-react';

export type ToastType = 'success' | 'warning' | 'error' | 'info';

export interface ToastMessage {
  id: string;
  type: ToastType;
  title: string;
  description?: string | undefined;
  duration?: number;
}

interface ToastContextValue {
  showToast: (toast: Omit<ToastMessage, 'id'>) => void;
  success: (title: string, description?: string) => void;
  warning: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
  info: (title: string, description?: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const showToast = useCallback(
    ({ type, title, description, duration = 3500 }: Omit<ToastMessage, 'id'>) => {
      const id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      setToasts((prev) => [...prev, { id, type, title, description, duration }]);
      if (duration > 0) {
        setTimeout(() => removeToast(id), duration);
      }
    },
    [removeToast]
  );

  const success = useCallback(
    (title: string, description?: string) => showToast({ type: 'success', title, description }),
    [showToast]
  );
  const warning = useCallback(
    (title: string, description?: string) => showToast({ type: 'warning', title, description }),
    [showToast]
  );
  const error = useCallback(
    (title: string, description?: string) => showToast({ type: 'error', title, description }),
    [showToast]
  );
  const info = useCallback(
    (title: string, description?: string) => showToast({ type: 'info', title, description }),
    [showToast]
  );

  return (
    <ToastContext.Provider value={{ showToast, success, warning, error, info }}>
      {children}
      {/* Toast 容器固定于右上角 */}
      <div className="fixed top-4 right-4 z-50 flex flex-col gap-2.5 max-w-sm pointer-events-none">
        {toasts.map((toast) => {
          const config = {
            success: {
              icon: <CheckCircle2 className="w-4 h-4 text-[var(--console-success)] shrink-0" />,
              border: 'border-l-4 border-l-[var(--console-success)] border-t border-r border-b border-[var(--console-border)]',
            },
            warning: {
              icon: <AlertTriangle className="w-4 h-4 text-[var(--console-warning)] shrink-0" />,
              border: 'border-l-4 border-l-[var(--console-warning)] border-t border-r border-b border-[var(--console-border)]',
            },
            error: {
              icon: <AlertCircle className="w-4 h-4 text-[var(--console-danger)] shrink-0" />,
              border: 'border-l-4 border-l-[var(--console-danger)] border-t border-r border-b border-[var(--console-border)]',
            },
            info: {
              icon: <Info className="w-4 h-4 text-[var(--console-accent)] shrink-0" />,
              border: 'border-l-4 border-l-[var(--console-accent)] border-t border-r border-b border-[var(--console-border)]',
            },
          }[toast.type];

          return (
            <div
              key={toast.id}
              role="alert"
              className={`pointer-events-auto bg-[var(--console-surface)] shadow-[var(--console-shadow-floating)] rounded-[var(--console-radius)] p-3 flex items-start gap-2.5 transition-all duration-150 ${config.border}`}
            >
              <div className="mt-0.5">{config.icon}</div>
              <div className="flex-1">
                <p className="text-xs font-semibold text-[var(--console-text)]">{toast.title}</p>
                {toast.description && (
                  <p className="text-[11px] text-[var(--console-text-muted)] mt-0.5">{toast.description}</p>
                )}
              </div>
              <button
                onClick={() => removeToast(toast.id)}
                className="text-[var(--console-text-muted)] hover:text-[var(--console-text)] p-0.5 cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
};

export const useToast = () => {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within ToastProvider');
  }
  return context;
};
