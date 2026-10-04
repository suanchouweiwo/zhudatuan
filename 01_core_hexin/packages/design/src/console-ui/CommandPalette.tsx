import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Search, Sliders, Sparkles, ArrowRight, CornerDownLeft } from 'lucide-react';

export interface CommandItem {
  id: string;
  title: string;
  category: string;
  description?: string;
  icon?: ReactNode;
  action: () => void;
  shortcut?: string;
}

export interface CommandNavigationItem {
  id: string;
  name: string;
  icon?: ReactNode;
}

export interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  commands?: readonly CommandItem[];
  navigation?: readonly CommandNavigationItem[];
  onNavigate?: (moduleId: string) => void;
  onDensityToggle?: () => void;
  theme?: 'light' | 'dark';
  onThemeToggle?: () => void;
}

const emptyCommands: readonly CommandItem[] = [];
const emptyNavigation: readonly CommandNavigationItem[] = [];

export function CommandPalette({ isOpen, onClose, commands = emptyCommands, navigation = emptyNavigation, onNavigate, onDensityToggle, theme, onThemeToggle }: CommandPaletteProps) {
  const [search, setSearch] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const availableCommands = useMemo(() => {
    const result: CommandItem[] = [...commands];
    if (onThemeToggle) result.push({ id: 'ui-theme', title: theme === 'dark' ? '切换为浅色主题' : '切换为深色主题', category: '界面偏好', icon: <Sparkles className="w-4 h-4" />, action: onThemeToggle });
    if (onDensityToggle) result.push({ id: 'ui-density', title: '切换舒适 / 紧凑密度', category: '界面偏好', icon: <Sliders className="w-4 h-4" />, action: onDensityToggle });
    if (onNavigate) for (const item of navigation) result.push({ id: `nav-${item.id}`, title: item.name, category: '工作区导航', icon: item.icon, action: () => onNavigate(item.id) });
    const query = search.trim().toLocaleLowerCase();
    return result.filter((command) => `${command.title} ${command.category} ${command.description ?? ''}`.toLocaleLowerCase().includes(query));
  }, [commands, navigation, onNavigate, onDensityToggle, onThemeToggle, theme, search]);

  const execute = (command: CommandItem) => { command.action(); onClose(); };

  useEffect(() => {
    if (!isOpen) return;
    setSearch('');
    setSelectedIndex(0);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        setSelectedIndex((index) => availableCommands.length ? (index + direction + availableCommands.length) % availableCommands.length : 0);
      } else if (event.key === 'Enter') {
        const command = availableCommands[selectedIndex];
        if (command) { event.preventDefault(); command.action(); onClose(); }
      } else if (event.key === 'Escape') { event.preventDefault(); onClose(); }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, selectedIndex, availableCommands, onClose]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-cmd-index="${selectedIndex}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-14 sm:pt-20 p-3 sm:p-4">
      <div className="fixed inset-0 bg-[var(--console-scrim)] backdrop-blur-xs" onClick={onClose} aria-hidden="true" />
      <div role="dialog" aria-modal="true" aria-label="全局快捷指令" className="relative w-full max-w-2xl bg-[var(--console-surface)] border border-[var(--console-border-strong)] rounded-[var(--console-radius)] shadow-[var(--console-shadow-floating)] overflow-hidden z-10 flex flex-col max-h-[80vh]">
        <div className="flex items-center px-4 py-3 border-b border-[var(--console-border)] gap-3">
          <Search className="w-5 h-5 text-[var(--console-brand)] shrink-0" />
          <input ref={inputRef} value={search} onChange={(event) => { setSearch(event.target.value); setSelectedIndex(0); }} placeholder="搜索工作区或操作" aria-label="搜索快捷指令" className="w-full text-sm text-[var(--console-text)] placeholder:text-[var(--console-text-muted)] outline-none bg-transparent" />
          <kbd className="px-1.5 py-0.5 text-[10px] bg-[var(--console-subtle)] text-[var(--console-text-muted)] border border-[var(--console-border)] rounded-[var(--console-radius)]">Esc</kbd>
        </div>
        <div ref={listRef} className="overflow-y-auto p-2 flex-1">
          {availableCommands.length ? availableCommands.map((command, index) => <button key={command.id} type="button" data-cmd-index={index} onClick={() => execute(command)} onMouseEnter={() => setSelectedIndex(index)} className={`w-full flex items-center justify-between text-left px-3 py-2.5 rounded-[var(--console-radius)] cursor-pointer transition-colors ${index === selectedIndex ? 'bg-[var(--console-selected)] text-[var(--console-brand)]' : 'hover:bg-[var(--console-hover)] text-[var(--console-text-secondary)]'}`}>
            <span className="flex items-center gap-3 min-w-0">
              <span className="p-1.5 border border-[var(--console-border)] bg-[var(--console-subtle)] rounded-[var(--console-radius)] shrink-0">{command.icon ?? <ArrowRight className="w-4 h-4" />}</span>
              <span className="flex flex-col min-w-0"><span className="text-xs font-semibold truncate">{command.title}</span><span className="text-[11px] text-[var(--console-text-muted)] truncate">{command.description ?? command.category}</span></span>
            </span>
            <span className="flex items-center gap-2 shrink-0 ml-3">{command.shortcut && <kbd className="text-[10px] text-[var(--console-text-muted)]">{command.shortcut}</kbd>}{index === selectedIndex && <CornerDownLeft className="w-3.5 h-3.5 text-[var(--console-accent)]" />}</span>
          </button>) : <p className="py-10 text-center text-xs text-[var(--console-text-muted)]">{search ? '没有匹配的指令' : '当前工作区没有可用指令'}</p>}
        </div>
        <div className="px-4 py-2 border-t border-[var(--console-border)] bg-[var(--console-subtle)] text-[11px] text-[var(--console-text-muted)]">↑ ↓ 选择 · Enter 执行 · Esc 关闭</div>
      </div>
    </div>
  );
}
