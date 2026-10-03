import React from 'react';
import { useMall } from '../../context/MallContext';
import type { AppMode, LaptopPage } from '../../context/MallContext.types';
import { Monitor, Laptop, Smartphone, AppWindow, Tablet, Layers } from 'lucide-react';
import { defaultStorefrontWebPage, storefrontDeviceSwitchPolicy, STOREFRONT_WEB_SURFACE_COPY, type StorefrontWebNavigationBoundary, type StorefrontWebSurface } from './StorefrontWebStandard';

type LaptopTopSwitcherProps = {
  surface?: StorefrontWebSurface;
  navigationBoundary?: StorefrontWebNavigationBoundary;
};

export const LaptopTopSwitcher: React.FC<LaptopTopSwitcherProps> = ({ surface = 'laptop', navigationBoundary = 'showcase' }) => {
  const { appMode, setAppMode, laptopPage, setLaptopPage, setTabletOrientation } = useMall();
  const surfaceCopy = STOREFRONT_WEB_SURFACE_COPY[surface];
  const previewControlsDisabled = navigationBoundary === 'production';

  const handleSwitchMode = (mode: AppMode, preservePath = false) => {
    const policy = storefrontDeviceSwitchPolicy(navigationBoundary, mode);
    if (policy.disabled) return;
    setAppMode(mode, { preservePath: preservePath || policy.preservePath });
  };

  const laptopPages: { id: LaptopPage; name: string; desc: string }[] = [
    { id: 'home-1366', name: '1. 1366×768 首页', desc: '首屏高密度 3列' },
    { id: 'home-1440', name: '2. 1440×900 首页', desc: '展宽视口 4列' },
    { id: 'category', name: '3. 分类与搜索', desc: '多维筛选+折叠' },
    { id: 'detail', name: '4. 商品详情页', desc: '1366两栏首屏' },
    { id: 'cart', name: '5. 购物车与结算', desc: '紧凑结算+不遮挡' },
    { id: 'orders', name: '6. 订单中心', desc: '高密度无冗余' },
  ];

  return (
    <div className="bg-[var(--sw-brand-dark)] text-white border-b border-blue-900 shadow-md py-2 px-3 sm:px-6 sticky top-0 z-50 font-sans">
      <div className="sw-web-switcher-container max-w-[1366px] mx-auto flex flex-col xl:flex-row items-center justify-between gap-2.5 text-xs">
        {/* Left Branding */}
        <div className="flex items-center gap-2.5">
          <img src="/brand/morvia-master-lockup-white.svg" alt="MORVIA · zhudatuan 主打团" className="h-9 w-36 flex-shrink-0 object-contain" />
          <div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] bg-blue-500/30 text-blue-200 border border-blue-400/40 font-bold px-1.5 py-0.2 rounded">{surfaceCopy.frameBadge}</span>
            </div>
            <div className="text-[10px] text-blue-200 flex items-center gap-1">
              <span>MORVIA B2B2C</span>
              <span>·</span>
              <span className="text-yellow-200">技术服务：雍彻科技（SGSYEN TECH）</span>
            </div>
          </div>
        </div>

        {/* Center Device Switcher (7 Device Presets) */}
        <div className="flex items-center gap-1 bg-blue-950/80 p-1 rounded-xl border border-blue-800/80 flex-wrap justify-center">
          <button
            type="button"
            aria-pressed={surface === 'desktop-1920'}
            onClick={() => {
              setLaptopPage(defaultStorefrontWebPage('desktop-1920'));
              handleSwitchMode('pc', true);
            }}
            className={`px-2 py-1 rounded-lg font-bold flex items-center gap-1 transition-all cursor-pointer text-[11px] ${surface === 'desktop-1920' ? 'bg-[var(--sw-brand)] text-white shadow-sm' : 'text-blue-200 hover:text-white hover:bg-white/10'}`}
            title="在当前入口切换到 27英寸 Desktop 1920×1080"
          >
            <Monitor className="w-3.5 h-3.5" />
            <span>Desktop 1920×1080</span>
          </button>

          <button
            type="button"
            onClick={() => {
              handleSwitchMode('laptop-web');
              setLaptopPage('home-1366');
            }}
            className={`px-2 py-1 rounded-lg font-bold flex items-center gap-1 transition-all cursor-pointer text-[11px] ${
              appMode === 'laptop-web' && laptopPage === 'home-1366' ? 'bg-[var(--sw-brand)] text-white shadow-sm' : 'text-blue-200 hover:text-white hover:bg-white/10'
            }`}
          >
            <Laptop className="w-3.5 h-3.5 text-cyan-300" />
            <span>Laptop 13 (1366×768)</span>
          </button>

          <button
            type="button"
            onClick={() => {
              handleSwitchMode('laptop-web');
              setLaptopPage('home-1440');
            }}
            className={`px-2 py-1 rounded-lg font-bold flex items-center gap-1 transition-all cursor-pointer text-[11px] ${
              appMode === 'laptop-web' && laptopPage === 'home-1440' ? 'bg-[var(--sw-brand)] text-white shadow-sm' : 'text-blue-200 hover:text-white hover:bg-white/10'
            }`}
          >
            <Laptop className="w-3.5 h-3.5 text-blue-300" />
            <span>Laptop 14 (1440×900)</span>
          </button>

          <button
            type="button"
            onClick={() => handleSwitchMode('mini-program')}
            disabled={previewControlsDisabled}
            aria-disabled={previewControlsDisabled}
            className="px-2 py-1 rounded-lg text-blue-200 hover:text-white hover:bg-white/10 font-medium flex items-center gap-1 transition-all cursor-pointer text-[11px]"
          >
            <Smartphone className="w-3.5 h-3.5 text-emerald-400" />
            <span>微信小程序</span>
          </button>

          <button
            type="button"
            onClick={() => handleSwitchMode('android-app')}
            disabled={previewControlsDisabled}
            aria-disabled={previewControlsDisabled}
            className="px-2 py-1 rounded-lg text-blue-200 hover:text-white hover:bg-white/10 font-medium flex items-center gap-1 transition-all cursor-pointer text-[11px]"
          >
            <AppWindow className="w-3.5 h-3.5 text-amber-400" />
            <span>Android手机</span>
          </button>

          <button
            type="button"
            onClick={() => {
              handleSwitchMode('tablet-app');
              setTabletOrientation('landscape');
            }}
            disabled={previewControlsDisabled}
            aria-disabled={previewControlsDisabled}
            className="px-2 py-1 rounded-lg text-blue-200 hover:text-white hover:bg-white/10 font-medium flex items-center gap-1 transition-all cursor-pointer text-[11px]"
          >
            <Tablet className="w-3.5 h-3.5 text-purple-300" />
            <span>Tablet横屏</span>
          </button>

          <button
            type="button"
            onClick={() => {
              handleSwitchMode('tablet-app');
              setTabletOrientation('portrait');
            }}
            disabled={previewControlsDisabled}
            aria-disabled={previewControlsDisabled}
            className="px-2 py-1 rounded-lg text-blue-200 hover:text-white hover:bg-white/10 font-medium flex items-center gap-1 transition-all cursor-pointer text-[11px]"
          >
            <Tablet className="w-3.5 h-3.5 text-purple-300 rotate-90" />
            <span>Tablet竖屏</span>
          </button>
        </div>

        {/* Right 6 Laptop Page Switcher */}
        <div className="flex items-center gap-1 overflow-x-auto max-w-full pb-0.5 scrollbar-none">
          <span className="text-gray-300 font-medium flex items-center gap-1 flex-shrink-0 mr-1">
            <Layers className="w-3 h-3 text-yellow-300" />
            <span>{surfaceCopy.pageSwitcherLabel}</span>
          </span>
          {laptopPages.map((p) => (
            <button
              type="button"
              key={p.id}
              onClick={() => setLaptopPage(p.id)}
              className={`px-2 py-1 rounded text-[11px] font-bold transition-all cursor-pointer flex-shrink-0 flex items-center gap-1 ${
                laptopPage === p.id ? 'bg-yellow-400 text-gray-900 shadow-sm scale-105' : 'bg-white/10 text-blue-100 hover:bg-white/20'
              }`}
              title={p.desc}
            >
              <span>{p.name}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};
