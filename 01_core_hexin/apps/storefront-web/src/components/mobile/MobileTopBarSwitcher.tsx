import React from 'react';
import { useMall, AppMode } from '../../context/MallContext';
import { resolveStorefrontPresentationIdentity } from '../../config/storefrontIdentity';
import { Monitor, Laptop, Smartphone, AppWindow, Tablet } from 'lucide-react';
import { defaultStorefrontWebPage } from '../laptop/StorefrontWebStandard';

export const MobileTopBarSwitcher: React.FC = () => {
  const { appMode, setAppMode, mpPage, setMpPage, androidPage, setAndroidPage, tabletPage, setTabletPage, tabletOrientation, setTabletOrientation, setLaptopPage } = useMall();
  const { brandName } = resolveStorefrontPresentationIdentity();

  const handleSwitchMode = (mode: AppMode, preservePath = false) => {
    setAppMode(mode, { preservePath });
  };

  return (
    <div className="bg-[var(--sw-brand-dark)] text-white border-b border-blue-900 shadow-md py-2 px-3 sm:px-6 sticky top-0 z-50 font-sans">
      <div className="max-w-[1366px] mx-auto flex flex-col md:flex-row items-center justify-between gap-2.5 text-xs">
        {/* Left Branding */}
        <div className="flex items-center gap-2.5">
          <span className="flex flex-shrink-0 items-center gap-2">
            <img src="/brand/morvia-mark-white.svg" alt="" aria-hidden="true" className="h-9 w-9 object-contain" />
            <strong className="max-w-40 truncate text-xl font-black tracking-tight">{brandName}</strong>
          </span>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] bg-yellow-400 text-gray-900 font-bold px-1.5 py-0.2 rounded">全平台4端协同</span>
            </div>
            <div className="text-[10px] text-blue-200 flex items-center gap-1">
              <span>{brandName} B2B2C</span>
              <span>·</span>
              <span className="text-yellow-200">技术服务：雍彻科技（SGSYEN TECH）</span>
            </div>
          </div>
        </div>

        {/* Center Mode Switcher Tabs */}
        <div className="flex items-center gap-1 bg-blue-950/80 p-1 rounded-xl border border-blue-800/80 flex-wrap justify-center">
          <button
            type="button"
            aria-pressed={appMode === 'pc'}
            onClick={() => {
              setLaptopPage(defaultStorefrontWebPage('desktop-1920'));
              handleSwitchMode('pc', true);
            }}
            className={`px-2.5 py-1.5 rounded-lg font-bold flex items-center gap-1 transition-all cursor-pointer text-[11px] ${appMode === 'pc' ? 'bg-[var(--sw-brand)] text-white shadow-sm' : 'text-blue-200 hover:text-white hover:bg-white/10'}`}
          >
            <Monitor className="w-3.5 h-3.5" />
            <span>PC 集团大屏</span>
          </button>

          <button
            onClick={() => {
              setLaptopPage(defaultStorefrontWebPage('laptop'));
              handleSwitchMode('laptop-web');
            }}
            className={`px-2.5 py-1.5 rounded-lg font-bold flex items-center gap-1 transition-all cursor-pointer text-[11px] ${
              appMode === 'laptop-web' ? 'bg-cyan-600 text-white shadow-sm' : 'text-blue-200 hover:text-white hover:bg-white/10'
            }`}
          >
            <Laptop className="w-3.5 h-3.5 text-cyan-300" />
            <span>笔记本端 (/laptop-web)</span>
          </button>

          <button
            onClick={() => handleSwitchMode('mini-program')}
            className={`px-2.5 py-1.5 rounded-lg font-bold flex items-center gap-1 transition-all cursor-pointer text-[11px] ${
              appMode === 'mini-program' ? 'bg-emerald-600 text-white shadow-sm' : 'text-blue-200 hover:text-white hover:bg-white/10'
            }`}
          >
            <Smartphone className="w-3.5 h-3.5 text-emerald-300" />
            <span>微信小程序 (/mini-program)</span>
          </button>

          <button
            onClick={() => handleSwitchMode('android-app')}
            className={`px-2.5 py-1.5 rounded-lg font-bold flex items-center gap-1 transition-all cursor-pointer text-[11px] ${
              appMode === 'android-app' ? 'bg-amber-600 text-white shadow-sm' : 'text-blue-200 hover:text-white hover:bg-white/10'
            }`}
          >
            <AppWindow className="w-3.5 h-3.5 text-amber-300" />
            <span>Android App (/android-app)</span>
          </button>

          <button
            onClick={() => handleSwitchMode('tablet-app')}
            className={`px-2.5 py-1.5 rounded-lg font-bold flex items-center gap-1 transition-all cursor-pointer text-[11px] ${
              appMode === 'tablet-app' ? 'bg-purple-600 text-white shadow-sm' : 'text-blue-200 hover:text-white hover:bg-white/10'
            }`}
          >
            <Tablet className="w-3.5 h-3.5 text-purple-300" />
            <span>平板端 (/tablet-app)</span>
          </button>
        </div>

        {/* Page Switcher Quick Links */}
        {appMode === 'mini-program' && (
          <div className="hidden xl:flex items-center gap-1 text-[11px] text-blue-200">
            <span className="text-gray-300 font-medium">小程序：</span>
            {[
              { id: 'home', name: '首页' },
              { id: 'category', name: '分类' },
              { id: 'detail', name: '详情' },
              { id: 'cart', name: '购物车' },
              { id: 'profile', name: '我的' },
            ].map((p) => (
              <button key={p.id} onClick={() => setMpPage(p.id as any)} className={`px-1.5 py-0.5 rounded cursor-pointer transition-colors ${mpPage === p.id ? 'bg-emerald-500 text-white font-bold' : 'hover:bg-white/10'}`}>
                {p.name}
              </button>
            ))}
          </div>
        )}

        {appMode === 'android-app' && (
          <div className="hidden xl:flex items-center gap-1 text-[11px] text-blue-200">
            <span className="text-gray-300 font-medium">Android：</span>
            {[
              { id: 'home', name: '首页' },
              { id: 'search', name: '搜索' },
              { id: 'detail', name: '详情' },
              { id: 'checkout', name: '结算' },
              { id: 'profile', name: '个人' },
            ].map((p) => (
              <button key={p.id} onClick={() => setAndroidPage(p.id as any)} className={`px-1.5 py-0.5 rounded cursor-pointer transition-colors ${androidPage === p.id ? 'bg-amber-500 text-white font-bold' : 'hover:bg-white/10'}`}>
                {p.name}
              </button>
            ))}
          </div>
        )}

        {appMode === 'tablet-app' && (
          <div className="hidden xl:flex items-center gap-1 text-[11px] text-blue-200">
            <span className="text-gray-300 font-medium">平板 6 页面：</span>
            {[
              {
                id: 'home',
                name: tabletOrientation === 'landscape' ? '1. 横屏首页' : '2. 竖屏首页',
              },
              { id: 'category', name: '3. 分类(双栏)' },
              { id: 'detail', name: '4. 详情(双栏)' },
              { id: 'cart', name: '5. 购物车&结算' },
              { id: 'orders', name: '6. 订单中心(Master-Detail)' },
            ].map((p) => (
              <button key={p.id} onClick={() => setTabletPage(p.id as any)} className={`px-1.5 py-0.5 rounded cursor-pointer transition-colors ${tabletPage === p.id ? 'bg-purple-500 text-white font-bold' : 'hover:bg-white/10'}`}>
                {p.name}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
