import React from 'react';
import { useMall, TabletPage } from '../../context/MallContext';
import { resolveStorefrontPresentationIdentity } from '../../config/storefrontIdentity';
import { Home, Grid, Gift, ShoppingCart, FileText, User, Building2, ChevronRight, ShieldCheck, RotateCw } from 'lucide-react';

export const TabletNavRail: React.FC = () => {
  const { tabletPage, setTabletPage, tabletOrientation, setTabletOrientation, cartCount, user, currentMall, triggerPendingFeature } = useMall();
  const { brandName } = resolveStorefrontPresentationIdentity();

  const navItems: { key: TabletPage; label: string; icon: React.ReactNode }[] = [
    { key: 'home', label: '首页', icon: <Home className="w-5 h-5" /> },
    { key: 'category', label: '分类', icon: <Grid className="w-5 h-5" /> },
    { key: 'detail', label: '福利商品', icon: <Gift className="w-5 h-5" /> },
    { key: 'cart', label: '购物车', icon: <ShoppingCart className="w-5 h-5" /> },
    { key: 'orders', label: '订单中心', icon: <FileText className="w-5 h-5" /> },
    { key: 'profile', label: '我的福利', icon: <User className="w-5 h-5" /> },
  ];

  if (tabletOrientation === 'portrait') {
    // Bottom Navigation Bar for Tablet Portrait (800x1280)
    return (
      <div className="bg-white border-t border-gray-200 py-2 px-4 flex items-center justify-around shadow-lg z-30 select-none">
        {navItems.map((item) => {
          const isActive = tabletPage === item.key;
          return (
            <button
              key={item.key}
              onClick={() => setTabletPage(item.key)}
              className={`flex flex-col items-center gap-1 py-1 px-3 rounded-xl transition-all cursor-pointer relative min-h-[44px] min-w-[56px] justify-center ${
                isActive ? 'text-[var(--sw-brand)] bg-blue-50 font-bold' : 'text-gray-500 hover:text-gray-900 font-medium'
              }`}
            >
              <div className="relative">
                {item.icon}
                {item.key === 'cart' && cartCount > 0 && <span className="absolute -top-1.5 -right-2 bg-[#E5484D] text-white text-[10px] font-bold px-1.5 py-0.2 rounded-full min-w-[16px] text-center">{cartCount}</span>}
              </div>
              <span className="text-[11px] leading-none">{item.label}</span>
            </button>
          );
        })}
      </div>
    );
  }

  // Left Navigation Rail for Tablet Landscape (1280x800)
  return (
    <div className="w-56 bg-[var(--sw-brand-dark)] text-white flex flex-col justify-between p-3 border-r border-blue-900/50 shadow-md select-none shrink-0">
      {/* Top Header & Enterprise Info */}
      <div className="space-y-4">
        <div className="flex flex-col items-start gap-1 px-2 py-1 border-b border-blue-800/60 pb-3">
          <span className="flex max-w-full items-center gap-2">
            <img src="/brand/morvia-mark-white.svg" alt="" aria-hidden="true" className="h-10 w-10 flex-shrink-0 object-contain" />
            <strong className="truncate text-xl font-black tracking-tight">{brandName}</strong>
          </span>
          <div className="overflow-hidden">
            <div className="text-[10px] text-blue-200 truncate">Tablet App 专属版</div>
          </div>
        </div>

        {/* Navigation Rail Buttons */}
        <nav className="space-y-1.5">
          {navItems.map((item) => {
            const isActive = tabletPage === item.key;
            return (
              <button
                key={item.key}
                onClick={() => setTabletPage(item.key)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-2xl transition-all cursor-pointer text-xs min-h-[44px] ${
                  isActive ? 'bg-white text-[var(--sw-brand-dark)] font-bold shadow-md transform translate-x-1' : 'text-blue-100 hover:bg-white/10 font-medium'
                }`}
              >
                <div className="relative">
                  {item.icon}
                  {item.key === 'cart' && cartCount > 0 && <span className="absolute -top-2 -right-2 bg-[#E5484D] text-white text-[9px] font-bold w-4 h-4 rounded-full flex items-center justify-center">{cartCount}</span>}
                </div>
                <span className="text-xs">{item.label}</span>
              </button>
            );
          })}
        </nav>
      </div>

      {/* Bottom User Card & Orientation Switcher */}
      <div className="space-y-2 pt-3 border-t border-blue-800/60">
        {/* User Mini Card */}
        <div onClick={() => setTabletPage('profile')} className="p-2.5 rounded-2xl bg-white/10 hover:bg-white/15 transition-colors cursor-pointer flex items-center gap-2.5 border border-white/10">
          {user.avatar ? (
            <img src={user.avatar} alt={user.name} className="w-8 h-8 rounded-xl object-cover border border-white/30" />
          ) : (
            <div className="w-8 h-8 rounded-xl bg-white/20 text-white flex items-center justify-center font-black border border-white/30">{user.name.slice(0, 1)}</div>
          )}
          <div className="overflow-hidden flex-1">
            <div className="text-xs font-bold text-white truncate">{user.name}</div>
            <div className="text-[10px] text-yellow-300 font-mono truncate">福利卡 ¥{user.welfareBalance.toFixed(0)}</div>
          </div>
          <ChevronRight className="w-3.5 h-3.5 text-blue-200" />
        </div>

        {/* Landscape / Portrait Orientation Toggle in Rail */}
        <button
          onClick={() => setTabletOrientation(tabletOrientation === 'landscape' ? 'portrait' : 'landscape')}
          className="w-full bg-blue-900/60 hover:bg-blue-800/80 text-blue-100 text-[11px] font-medium py-2 rounded-xl flex items-center justify-center gap-1.5 transition-colors cursor-pointer min-h-[40px]"
        >
          <RotateCw className="w-3.5 h-3.5 text-amber-300" />
          <span>切换为{tabletOrientation === 'landscape' ? '竖屏 (800×1280)' : '横屏 (1280×800)'}</span>
        </button>
      </div>
    </div>
  );
};
