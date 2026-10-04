import { useEffect, useState, type ReactNode } from 'react';
import { ShellIcon } from './ShellIcon';

export interface HeaderProps {
  readonly title: string;
  readonly summary: string;
  readonly scopeLabel: string;
  readonly displayName: string;
  readonly assuranceLevel: number;
  readonly syncedAt: string;
  readonly loggingOut: boolean;
  readonly logoutError?: string;
  readonly onLogout: () => void;
  readonly onOpenNavigation: () => void;
  readonly onOpenProfile: () => void;
  readonly brandName?: string;
  readonly brandSubtitle?: string;
  readonly scopeControl?: ReactNode;
  readonly theme?: 'light' | 'dark';
  readonly density?: 'comfortable' | 'compact';
  readonly onThemeToggle?: () => void;
  readonly onDensityChange?: (density: 'comfortable' | 'compact') => void;
}

type HeaderPanel = 'account' | 'command' | 'notices' | 'tasks' | null;

export function Header(props: HeaderProps) {
  const { title, summary, scopeLabel, displayName, assuranceLevel, syncedAt, loggingOut, logoutError, onLogout,
    onOpenNavigation, onOpenProfile, brandName = '主打团', brandSubtitle = '运营管理后台', scopeControl,
    theme = 'light', density = 'comfortable', onThemeToggle, onDensityChange } = props;
  const [panel, setPanel] = useState<HeaderPanel>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPanel('command');
      } else if (event.key === 'Escape') {
        setPanel(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const togglePanel = (next: Exclude<HeaderPanel, null>) => setPanel((current) => current === next ? null : next);
  const openProfile = () => {
    setPanel(null);
    onOpenProfile();
  };

  return <header className="consoleheader">
    <div className="consolebrandzone">
      <button className="mobilemenubutton" type="button" onClick={onOpenNavigation} aria-label="打开主导航">
        <ShellIcon name="menu" />
      </button>
      <div className="consolebrand" aria-label={`${brandName} ${brandSubtitle}`}>
        <img src={`${import.meta.env.BASE_URL}brand/${theme === 'dark' ? 'brand-mark-white.svg' : 'brand-mark.svg'}`} alt="" width="32" height="32" />
        <span className="consolebrandcopy"><strong>{brandName}</strong><small>{brandSubtitle}</small></span>
      </div>
      {scopeControl === undefined ? null : <div className="consoleheaderscope">{scopeControl}</div>}
    </div>

    <div className="commandarea">
      <button className="commandtrigger" type="button" onClick={() => togglePanel('command')}
        aria-haspopup="dialog" aria-expanded={panel === 'command'}>
        <ShellIcon name="search" /><span>搜索工作台、任务或快捷命令…</span><kbd>⌘ K</kbd>
      </button>
      {panel === 'command' ? <div className="headerpopup commandpopup" role="dialog" aria-label="快捷命令">
        <label htmlFor="shellcommand">快捷搜索</label>
        <input id="shellcommand" type="search" autoFocus placeholder="输入工作台、订单或任务…" />
        <p>{summary}</p>
        <button type="button" onClick={() => setPanel(null)}>打开「{title}」</button>
      </div> : null}
    </div>

    <div className="consoleactions">
      {onDensityChange === undefined ? null : <div className="consoledensity" role="group" aria-label="显示密度">
        <button type="button" aria-pressed={density === 'comfortable'} onClick={() => onDensityChange('comfortable')}>舒适</button>
        <button type="button" aria-pressed={density === 'compact'} onClick={() => onDensityChange('compact')}>紧凑</button>
      </div>}
      {onThemeToggle === undefined ? null : <button className="iconbutton consolethemebutton" type="button"
        aria-label={theme === 'dark' ? '当前深色模式，点击切换为浅色模式' : '当前浅色模式，点击切换为深色模式'}
        title={theme === 'dark' ? '当前深色模式，点击切换为浅色模式' : '当前浅色模式，点击切换为深色模式'} onClick={onThemeToggle}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
          {theme === 'light' ? <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.4 1.4m11.2 11.2L19 19M5 19l1.4-1.4M17.6 6.4 19 5" /></>
            : <path d="M20.6 14.2A8.7 8.7 0 0 1 9.8 3.4 8.7 8.7 0 1 0 20.6 14.2Z" />}
        </svg>
      </button>}
      <div className="headeractionwrap">
        <button className="taskbutton" type="button" onClick={() => togglePanel('tasks')}
          aria-haspopup="dialog" aria-expanded={panel === 'tasks'}>任务<span aria-label="任务状态待同步" /></button>
        {panel === 'tasks' ? <StatusPopup title="当前任务" detail="任务数据待服务端同步。" /> : null}
      </div>
      <span className="languageindicator" aria-label="当前语言：中文">中文</span>
      <div className="headeractionwrap">
        <button className="iconbutton" type="button" onClick={() => togglePanel('notices')}
          aria-label="通知中心" aria-haspopup="dialog" aria-expanded={panel === 'notices'}><ShellIcon name="bell" /></button>
        {panel === 'notices' ? <StatusPopup title="通知中心" detail="最新运行状态已同步。" /> : null}
      </div>
      <div className="headeractionwrap operatorprofile">
        <button className="avatarbutton" type="button" onClick={() => togglePanel('account')}
          aria-label={`打开 ${displayName} 的账户菜单`} aria-haspopup="dialog" aria-expanded={panel === 'account'}>
          {avatarLetter(displayName)}
        </button>
        <span className="operatorcopy" aria-hidden="true">
          <span><strong>{displayName}</strong></span>
          <small>{scopeLabel} · AAL{assuranceLevel}</small>
        </span>
        {panel === 'account' ? <div className="headerpopup accountpopup" role="dialog" aria-label="账户菜单">
          <strong>{displayName}</strong><span>{scopeLabel}</span>
          <span>AAL{assuranceLevel} · {formatTime(syncedAt)}</span>
          <button className="accountprofileentry" type="button" onClick={openProfile}>个人信息</button>
          <button className="accountlogout" type="button" onClick={onLogout} disabled={loggingOut}>{loggingOut ? '正在退出' : '退出登录'}</button>
          {logoutError === undefined ? null : <em role="alert">{logoutError}</em>}
        </div> : null}
      </div>
    </div>
  </header>;
}

function StatusPopup({ title, detail }: Readonly<{ title: string; detail: string }>) {
  return <div className="headerpopup statuspopup" role="dialog" aria-label={title}><strong>{title}</strong><span>{detail}</span></div>;
}

function avatarLetter(displayName: string): string {
  return displayName.match(/[A-Za-z]/)?.[0]?.toUpperCase() ?? (displayName.trim().slice(0, 1) || '主');
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '同步时间未知' : `同步于 ${date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
}
