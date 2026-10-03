import type { ReactNode } from 'react';

export interface WorkspaceItem {
  readonly path: string;
  readonly title: string;
}

export interface WorkspaceShellProps {
  readonly product: string;
  readonly brand: ReactNode;
  readonly label: string;
  readonly path: string;
  readonly items: readonly WorkspaceItem[];
  readonly navigate: (path: string) => void;
  readonly children: ReactNode;
}

export function resolveWorkspacePath(path: string, items: readonly WorkspaceItem[]): string | undefined {
  return path === '/' ? items[0]?.path : path;
}

export function WorkspaceShell({ product, brand, label, path, items, navigate, children }: Readonly<WorkspaceShellProps>) {
  const current = items.find((item) => item.path === path);
  return (
    <div className="workspacelayout">
      <aside className="workspacesidebar">
        {brand}
        <p className="workspacescope">{label}</p>
        <nav aria-label={product}>
          {items.map((item, index) => (
            <button key={item.path} type="button" aria-current={item.path === path ? 'page' : undefined} onClick={() => navigate(item.path)}>
              <span aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
              {item.title}
            </button>
          ))}
        </nav>
        <p className="workspaceassurance">
          <span aria-hidden="true" />
          权限与能力实时校验
        </p>
      </aside>
      <div className="workspacebody">
        <header className="workspaceheader">
          <div>
            <p>MORVIA · zhudatuan 主打团</p>
            <strong>{current?.title ?? product}</strong>
          </div>
          <span>实时业务数据</span>
        </header>
        {children}
      </div>
    </div>
  );
}
