import { mallShortName } from '../../domain/brand/productBrand';
import React from 'react';
import { useMall, AndroidAppPage } from '../../context/MallContext';
import { Signal, Wifi, Battery, ArrowLeft, Search, ShoppingBag, Building2, ChevronDown, RefreshCw } from 'lucide-react';

interface AndroidStatusBarProps {
  title?: string;
  showBack?: boolean;
  onBack?: () => void;
  onSearch?: () => void;
  isLoading?: boolean;
  onRefresh?: () => void;
}

export const AndroidStatusBar: React.FC<AndroidStatusBarProps> = ({ title, showBack, onBack, onSearch, isLoading, onRefresh }) => {
  const { currentMall, malls, switchMall, cartCount, setAndroidPage } = useMall();
  const [showMallDropdown, setShowMallDropdown] = React.useState(false);

  return (
    <div className="bg-[var(--sw-brand-dark)] text-white select-none sticky top-0 z-40 shadow-sm font-sans">
      {/* Android 14 系统状态栏 */}
      <div className="px-4 pt-2 pb-1 flex items-center justify-between text-[11px] font-semibold opacity-90">
        <span>09:41</span>
        <div className="flex items-center gap-2">
          <span className="text-[9px] bg-white/20 px-1 py-0.2 rounded font-mono font-bold">5G</span>
          <Signal className="w-3 h-3" />
          <Wifi className="w-3 h-3" />
          <Battery className="w-3.5 h-3.5" />
        </div>
      </div>

      {/* Material 3 Top App Bar */}
      <div className="px-3 py-2.5 flex items-center justify-between gap-2">
        {/* 左侧：返回键 或 企业切换 */}
        <div className="flex items-center gap-2">
          {showBack ? (
            <button onClick={onBack} className="p-1.5 hover:bg-white/10 rounded-full transition-colors cursor-pointer text-white">
              <ArrowLeft className="w-5 h-5" />
            </button>
          ) : (
            <div className="relative">
              <button
                onClick={() => setShowMallDropdown(!showMallDropdown)}
                className="bg-white/10 hover:bg-white/20 text-white px-2.5 py-1 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-colors border border-white/20 cursor-pointer"
              >
                <img src="/brand/morvia-mark-white.svg" alt="" className="h-5 w-5 flex-shrink-0" />
                <span className="truncate max-w-[130px]">{mallShortName(currentMall.mallName)}</span>
                <ChevronDown className="w-3 h-3 opacity-80" />
              </button>

              {/* 企业切换 Popover */}
              {showMallDropdown && (
                <div className="absolute left-0 top-full mt-1.5 w-52 bg-white text-gray-800 rounded-xl shadow-xl border border-gray-100 p-1.5 z-50 text-xs">
                  <div className="text-[10px] text-gray-400 font-bold px-2.5 py-1 uppercase tracking-wider">切换企业福利空间</div>
                  {malls.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => {
                        switchMall(m.id);
                        setShowMallDropdown(false);
                      }}
                      className={`w-full text-left px-2.5 py-2 rounded-lg transition-colors flex items-center justify-between ${m.id === currentMall.id ? 'bg-blue-50 text-[var(--sw-brand)] font-bold' : 'hover:bg-gray-50 text-gray-700'}`}
                    >
                      <span className="truncate">{m.mallName}</span>
                      {m.id === currentMall.id && <span className="w-1.5 h-1.5 rounded-full bg-[var(--sw-brand)]" />}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {title && <h1 className="text-sm font-bold text-white tracking-tight truncate max-w-[150px]">{title}</h1>}
        </div>

        {/* 右侧：搜索、购物车、刷新 */}
        <div className="flex items-center gap-1">
          {onRefresh && (
            <button onClick={onRefresh} className={`p-1.5 hover:bg-white/10 rounded-full transition-colors text-white cursor-pointer ${isLoading ? 'animate-spin text-yellow-300' : ''}`} title="模拟网络刷新">
              <RefreshCw className="w-4 h-4" />
            </button>
          )}

          <button onClick={() => (onSearch ? onSearch() : setAndroidPage('search'))} className="p-1.5 hover:bg-white/10 rounded-full transition-colors text-white cursor-pointer" title="搜索">
            <Search className="w-4.5 h-4.5" />
          </button>

          <button onClick={() => setAndroidPage('checkout')} className="p-1.5 hover:bg-white/10 rounded-full transition-colors text-white relative cursor-pointer" title="购物车/结算">
            <ShoppingBag className="w-4.5 h-4.5 text-yellow-300" />
            {cartCount > 0 && <span className="absolute top-0 right-0 bg-[#E5484D] text-white font-bold text-[9px] w-3.5 h-3.5 rounded-full flex items-center justify-center">{cartCount}</span>}
          </button>
        </div>
      </div>
    </div>
  );
};
