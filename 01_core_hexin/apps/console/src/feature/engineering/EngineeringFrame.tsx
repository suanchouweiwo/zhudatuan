import { StableWorkspaceTabs, useViewScrollMemory } from '@shop/design';
import { type ReactNode, useCallback, useRef } from 'react';
import { NavLink, useParams } from 'react-router';
import { scopePath } from '../../shared/url/ScopePath';
import './engineering.css';

export const engineeringTabs = [
  { id: 'engineering', suffix: 'system/engineering', label: '工程与架构' },
  { id: 'status', suffix: 'system/status', label: '运行状态' },
  { id: 'releases', suffix: 'system/releases', label: '发布与版本' },
  { id: 'incidents', suffix: 'system/incidents', label: '故障与技术' },
] as const;

export type EngineeringViewId = (typeof engineeringTabs)[number]['id'];

interface EngineeringFrameProps {
  readonly eyebrow: string;
  readonly title: string;
  readonly description: string;
  readonly activeView: EngineeringViewId;
  readonly children: ReactNode;
}

export function EngineeringFrame({ eyebrow, title, description, activeView, children }: EngineeringFrameProps) {
  const { scopeKind = 'platform', scopeId = 'organization-platform-root' } = useParams();
  const scope = { kind: scopeKind, id: scopeId };
  const pageRef = useRef<HTMLElement>(null);
  const activeIndex = engineeringTabs.findIndex(({ id }) => id === activeView);
  const workspace = useCallback(() => pageRef.current?.closest<HTMLElement>('.workspacebody') ?? null, []);
  const rememberScroll = useViewScrollMemory(activeView, workspace);

  return <section className="engineeringpage" ref={pageRef}>
    <header className="engineeringhero">
      <div className="engineeringherocopy">
        <span className="engineeringeyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      <img className="engineeringbrand" src="/brand/morvia-compact-lockup.svg" width="460" height="120"
        decoding="async" fetchPriority="high"
        alt="主打团" />
    </header>
    <StableWorkspaceTabs className="engineeringtabs" label="工程与架构中心页面" activeIndex={activeIndex}>
      {engineeringTabs.map((tab) => <NavLink key={tab.suffix} to={scopePath(scope, tab.suffix)}
        onClick={rememberScroll} preventScrollReset
        className={({ isActive }) => isActive ? 'isactive' : undefined}>{tab.label}</NavLink>)}
    </StableWorkspaceTabs>
    <div className="engineeringcontent">{children}</div>
  </section>;
}

interface Metric {
  readonly label: string;
  readonly value: string;
  readonly detail: string;
  readonly tone?: 'brand' | 'ready' | 'waiting';
}

export function MetricGrid({ metrics }: Readonly<{ metrics: readonly Metric[] }>) {
  return <div className="engineeringmetrics">
    {metrics.map((metric) => <article key={metric.label} className="engineeringmetric" data-tone={metric.tone ?? 'brand'}>
      <span>{metric.label}</span><strong>{metric.value}</strong><small>{metric.detail}</small>
    </article>)}
  </div>;
}

export function HonestNotice({ title, children }: Readonly<{ title: string; children: ReactNode }>) {
  return <aside className="engineeringnotice" role="note"><strong>{title}</strong><span>{children}</span></aside>;
}

export function StatusPill({ children, tone = 'waiting' }: Readonly<{
  children: ReactNode;
  tone?: 'ready' | 'waiting' | 'information';
}>) {
  return <span className="engineeringstatus" data-tone={tone}>{children}</span>;
}
