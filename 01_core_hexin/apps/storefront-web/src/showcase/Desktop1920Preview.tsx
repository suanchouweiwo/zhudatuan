'use client';

import Link from 'next/link';
import React from 'react';
import { Laptop, Maximize2, Monitor, Smartphone, Tablet } from 'lucide-react';
import { STOREFRONT_WEB_PRESETS } from '../components/laptop/StorefrontWebStandard';

export type DesktopPreviewProfileId = 'windows-175' | 'native-100';

export type DesktopPreviewProfile = {
  id: DesktopPreviewProfileId;
  label: string;
  detail: string;
  cssWidth: number;
  cssHeight: number;
};

const DESKTOP_STANDARD = STOREFRONT_WEB_PRESETS['desktop-1920'];

export const DESKTOP_PREVIEW_PROFILES: readonly DesktopPreviewProfile[] = [
  {
    id: 'windows-175',
    label: '27英寸 · 175%',
    detail: '1920×1080 物理屏幕 / 1097×617 全屏等效 CSS 画布',
    cssWidth: Math.round(DESKTOP_STANDARD.width / 1.75),
    cssHeight: Math.round(DESKTOP_STANDARD.height / 1.75),
  },
  {
    id: 'native-100',
    label: '1920×1080 · 100%',
    detail: '1920×1080 CSS 原始画布',
    cssWidth: DESKTOP_STANDARD.width,
    cssHeight: DESKTOP_STANDARD.height,
  },
] as const;

export function fitDesktopPreviewScale(availableWidth: number, availableHeight: number, profile: Pick<DesktopPreviewProfile, 'cssWidth' | 'cssHeight'>) {
  if (availableWidth <= 0 || availableHeight <= 0) return 1;
  return Math.min(1, availableWidth / profile.cssWidth, availableHeight / profile.cssHeight);
}

const FULL_VI_PROFILE = DESKTOP_PREVIEW_PROFILES.find(({ id }) => id === 'native-100') ?? DESKTOP_PREVIEW_PROFILES[1];

export function DesktopFullViPreview() {
  const [displayScale, setDisplayScale] = React.useState(1);
  const [isMeasured, setIsMeasured] = React.useState(false);

  React.useEffect(() => {
    const measure = () => {
      setDisplayScale(fitDesktopPreviewScale(window.innerWidth, window.innerHeight, FULL_VI_PROFILE));
      setIsMeasured(true);
    };

    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  const displayWidth = Math.ceil(FULL_VI_PROFILE.cssWidth * displayScale);
  const displayHeight = Math.ceil(FULL_VI_PROFILE.cssHeight * displayScale);

  return (
    <main className="relative grid h-dvh w-full place-items-center overflow-hidden bg-slate-950" aria-busy={!isMeasured}>
      <div
        className="overflow-hidden bg-white shadow-2xl"
        style={{ width: displayWidth, height: displayHeight, visibility: isMeasured ? 'visible' : 'hidden' }}
      >
        <iframe
          title="主打团商城 27英寸完整桌面 VI"
          src="/desktop-1920/frame"
          width={FULL_VI_PROFILE.cssWidth}
          height={FULL_VI_PROFILE.cssHeight}
          className="block border-0 bg-white"
          style={{
            width: FULL_VI_PROFILE.cssWidth,
            height: FULL_VI_PROFILE.cssHeight,
            transform: `scale(${displayScale})`,
            transformOrigin: 'top left',
          }}
        />
      </div>

      <Link
        href="/desktop-1920/inspect"
        aria-label="打开桌面画布验收工具"
        title="画布验收"
        className="absolute bottom-3 right-3 grid min-h-[var(--sw-min-touch-target)] min-w-[var(--sw-min-touch-target)] place-items-center rounded-full border border-white/20 bg-slate-950/80 text-white opacity-25 shadow-xl backdrop-blur transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
      >
        <Maximize2 className="h-4 w-4" />
      </Link>
    </main>
  );
}

export function Desktop1920Preview() {
  const viewportRef = React.useRef<HTMLDivElement>(null);
  const [profileId, setProfileId] = React.useState<DesktopPreviewProfileId>('native-100');
  const [fitToWindow, setFitToWindow] = React.useState(true);
  const [fitScale, setFitScale] = React.useState(1);
  const [stageHeight, setStageHeight] = React.useState(320);
  const [isMeasured, setIsMeasured] = React.useState(false);
  const profile = DESKTOP_PREVIEW_PROFILES.find((candidate) => candidate.id === profileId) ?? DESKTOP_PREVIEW_PROFILES[0];

  React.useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const measure = () => {
      const bounds = viewport.getBoundingClientRect();
      const availableHeight = Math.max(1, window.innerHeight - bounds.top - 20);
      setFitScale(fitDesktopPreviewScale(bounds.width, availableHeight, profile));
      setStageHeight(Math.max(240, availableHeight));
      setIsMeasured(true);
    };

    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(viewport);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [profile]);

  const displayScale = fitToWindow ? fitScale : 1;
  const displayWidth = Math.ceil(profile.cssWidth * displayScale);
  const displayHeight = Math.ceil(profile.cssHeight * displayScale);

  return (
    <main className="min-h-dvh bg-slate-950 text-white">
      <header className="sticky top-0 z-50 border-b border-blue-900 bg-[var(--sw-brand-dark)] px-4 py-3 shadow-xl">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <img src="/brand/morvia-mark-white.svg" alt="主打团" className="h-9 w-9" />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <strong className="text-sm">主打团消费者商城 · PC 画布验收台</strong>
                <span className="rounded-full border border-blue-400/40 bg-blue-500/20 px-2 py-0.5 text-[11px] text-blue-100">Desktop 1920×1080</span>
              </div>
              <p className="mt-0.5 truncate text-[11px] text-blue-200">恢复原 PC 大屏展示链路；预览数据与正式商城后端完全隔离</p>
            </div>
          </div>

          <nav aria-label="切换商城设备预览" className="flex flex-wrap items-center gap-1 rounded-xl border border-blue-800 bg-blue-950/70 p-1 text-[11px]">
            <span aria-current="page" className="flex min-h-[var(--sw-min-touch-target)] items-center gap-1 rounded-lg bg-blue-600 px-2.5 font-bold text-white">
              <Monitor className="h-3.5 w-3.5" /> PC
            </span>
            <Link href="/laptop-web" className="flex min-h-[var(--sw-min-touch-target)] items-center gap-1 rounded-lg px-2.5 text-blue-100 hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white">
              <Laptop className="h-3.5 w-3.5" /> Laptop
            </Link>
            <Link href="/mini-program" className="flex min-h-[var(--sw-min-touch-target)] items-center gap-1 rounded-lg px-2.5 text-blue-100 hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white">
              <Smartphone className="h-3.5 w-3.5" /> 微信
            </Link>
            <Link href="/tablet-app" className="flex min-h-[var(--sw-min-touch-target)] items-center gap-1 rounded-lg px-2.5 text-blue-100 hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white">
              <Tablet className="h-3.5 w-3.5" /> 平板
            </Link>
          </nav>

          <div className="flex flex-wrap items-center justify-end gap-2 text-[11px]">
            <div role="group" aria-label="桌面验收环境" className="flex rounded-lg border border-blue-700 bg-blue-950/70 p-1">
              {DESKTOP_PREVIEW_PROFILES.map((candidate) => (
                <button
                  key={candidate.id}
                  type="button"
                  aria-pressed={profile.id === candidate.id}
                  onClick={() => setProfileId(candidate.id)}
                  className={`min-h-[var(--sw-min-touch-target)] rounded-md px-2.5 font-bold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white ${profile.id === candidate.id ? 'bg-white text-blue-950' : 'text-blue-100 hover:bg-white/10'}`}
                >
                  {candidate.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              aria-label="适应窗口显示"
              aria-pressed={fitToWindow}
              onClick={() => setFitToWindow((current) => !current)}
              className="flex min-h-[var(--sw-min-touch-target)] items-center gap-1 rounded-lg border border-blue-700 bg-blue-950/70 px-2.5 font-bold text-blue-100 hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              <Maximize2 className="h-3.5 w-3.5" /> {fitToWindow ? '适应窗口' : '1:1 画布'}
            </button>
          </div>
        </div>
      </header>

      <section className="mx-auto max-w-[1640px] px-3 py-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-300">
          <span>{profile.detail}；DPR 1.75 仍需 Windows 真机复验</span>
          <span aria-live="polite">当前画布显示比例 {Math.round(displayScale * 100)}%</span>
        </div>
        <div
          ref={viewportRef}
          aria-busy={!isMeasured}
          className="overflow-auto rounded-xl border border-slate-700 bg-slate-900 p-2 shadow-2xl"
          style={{ height: stageHeight }}
        >
          <div className="mx-auto" style={{ width: displayWidth, height: displayHeight, visibility: isMeasured ? 'visible' : 'hidden' }}>
            <iframe
              title={`主打团商城 ${profile.label} 预览`}
              src="/desktop-1920/frame"
              width={profile.cssWidth}
              height={profile.cssHeight}
              className="block border-0 bg-white"
              style={{
                width: profile.cssWidth,
                height: profile.cssHeight,
                transform: `scale(${displayScale})`,
                transformOrigin: 'top left',
              }}
            />
          </div>
        </div>
      </section>
    </main>
  );
}
