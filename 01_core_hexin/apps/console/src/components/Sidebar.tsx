import type { NavigationItem } from '../entity/navigation/ConsoleNavigation';
import type { ConsoleModuleId } from '../entity/navigation/ConsoleModuleManifest';
import { CURRENT_CONSOLE_RELEASE } from '../entity/release/ConsoleReleaseLedger';
import type { ConsoleNavigationIntent } from '../shared/interaction/ConsoleModulePreload';
import { ShellIcon } from './ShellIcon';

export interface SidebarProps {
  readonly active: string | undefined;
  readonly collapsed: boolean;
  readonly displayName: string;
  readonly roleLabel: string;
  readonly brandName?: string;
  readonly brandSubtitle?: string;
  readonly mainItems: readonly NavigationItem[];
  readonly bottomItems: readonly NavigationItem[];
  readonly onNavigate: (suffix: string) => void;
  readonly onNavigateIntent?: (moduleId: ConsoleModuleId, intent: ConsoleNavigationIntent) => void;
  readonly onOpenProfile: () => void;
  readonly onToggle: () => void;
}

export function Sidebar({ active, collapsed, displayName, brandName = '主打团', brandSubtitle = '运营管理后台',
  mainItems, bottomItems, onNavigate, onNavigateIntent, onOpenProfile, onToggle }: SidebarProps) {

  return (
    <aside className={`consolesidebar${collapsed ? ' iscollapsed' : ''}`} aria-label="主导航">
      <div className="sidebarbrand">
        <span className="sidebarproductmark" aria-hidden="true">
          <img src={`${import.meta.env.BASE_URL}brand/brand-mark.svg`} alt="" width="34" height="34" />
        </span>
        <span className="sidebarbrandcopy"><strong>{brandName}</strong><small>{brandSubtitle}</small></span>
        <button className="sidebartoggle" type="button" onClick={onToggle}
          aria-label={collapsed ? '展开导航' : '收起导航'} aria-expanded={!collapsed}>
          <ShellIcon name={collapsed ? 'chevron' : 'collapse'} />
        </button>
      </div>
      <div className="sidebarnavtitle">工作台工作流</div>
      <nav aria-label="工作台与治理系统" className="sidebarnavigation">
        {mainItems.map((item) => {
          const label = navigationLabel(item);
          return <button key={item.moduleId} type="button" onClick={() => onNavigate(item.suffix)} data-module={item.moduleId}
            onPointerEnter={() => onNavigateIntent?.(item.moduleId, 'hover')}
            onFocus={() => onNavigateIntent?.(item.moduleId, 'focus')}
            onPointerDown={() => onNavigateIntent?.(item.moduleId, 'pointerdown')}
            onTouchStart={() => onNavigateIntent?.(item.moduleId, 'touchstart')}
            data-status={item.status}
            aria-disabled={item.status === 'disabled' ? true : undefined}
            aria-label={label} aria-current={item.moduleId === active ? 'page' : undefined}
            title={collapsed ? label : undefined}>
            <ShellIcon name={item.icon} /><span className="sidebarlabel">{label}</span>
          </button>;
        })}
      </nav>
      <footer className="sidebarfooter">
        <nav aria-label="个人中心、工程与架构和服务中心" className="sidebarutilitynavigation">
          <button className="sidebarprofile" type="button" onClick={onOpenProfile}
            aria-label={`个人中心：${displayName}`} aria-current={active === 'profile' ? 'page' : undefined}
            title={collapsed ? `个人中心：${displayName}` : undefined}>
            <span className="sidebarprofileavatar" aria-hidden="true">{avatarLetter(displayName)}</span>
            <span className="sidebarlabel">个人中心</span>
          </button>
          {bottomItems.map((item) => {
            const label = navigationLabel(item);
            return <button key={item.moduleId} type="button" onClick={() => onNavigate(item.suffix)}
              data-module={item.moduleId} data-status={item.status}
              onPointerEnter={() => onNavigateIntent?.(item.moduleId, 'hover')}
              onFocus={() => onNavigateIntent?.(item.moduleId, 'focus')}
              onPointerDown={() => onNavigateIntent?.(item.moduleId, 'pointerdown')}
              onTouchStart={() => onNavigateIntent?.(item.moduleId, 'touchstart')}
              aria-disabled={item.status === 'disabled' ? true : undefined} aria-label={label}
              aria-current={item.moduleId === active ? 'page' : undefined} title={collapsed ? label : undefined}>
              <ShellIcon name={item.icon} /><span className="sidebarlabel">{label}</span>
            </button>;
          })}
        </nav>
        <button className="sidebarversion" type="button" onClick={() => onNavigate('system/releases')}
          aria-label={`主打团 Console 当前生产版本 ${CURRENT_CONSOLE_RELEASE.version}`}
          title={collapsed ? `主打团 Console ${CURRENT_CONSOLE_RELEASE.version}` : undefined}>
          <span className="sidebarversioncopy"><small>主打团 CONSOLE</small><strong>{CURRENT_CONSOLE_RELEASE.version}</strong></span>
          <span className="sidebarversionstate"><i aria-hidden="true" />生产版</span>
        </button>
      </footer>
    </aside>
  );
}

function navigationLabel(item: NavigationItem): string {
  const label = item.moduleId === 'applications' ? item.label.replace(/^主打团 · /, '') : item.label;
  return item.status === 'disabled' ? `${label}（已停用）` : label;
}

function avatarLetter(displayName: string): string {
  return displayName.match(/[A-Za-z]/)?.[0]?.toUpperCase() ?? (displayName.trim().slice(0, 1) || '智');
}
