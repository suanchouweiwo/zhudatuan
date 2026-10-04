import React, { useEffect, useState } from 'react';
import { useMall } from '../../context/MallContext';
import type { LaptopPage } from '../../context/MallContext.types';
import { Search, ShoppingCart, Building2, ChevronDown, User, CreditCard, Headphones, FileText, MapPin, Ticket, Zap, Gift, Menu, ShieldCheck } from 'lucide-react';
import { storefrontAuthHref } from '../../config/storefrontAuth';
import { resolveStorefrontPresentationIdentity } from '../../config/storefrontIdentity';
import { defaultStorefrontWebPage, STOREFRONT_WEB_SURFACE_COPY, type StorefrontWebSurface } from './StorefrontWebStandard';

interface LaptopHeaderProps {
  activeTab?: LaptopPage;
  onSelectTab?: (tab: LaptopPage) => void;
  surface?: StorefrontWebSurface;
}

export const LaptopHeader: React.FC<LaptopHeaderProps> = ({ activeTab, onSelectTab, surface = 'laptop' }) => {
  const { currentMall, user, cartCount, setLaptopPage, malls, switchMall, triggerPendingFeature } = useMall();
  const { brandName } = resolveStorefrontPresentationIdentity();
  const surfaceCopy = STOREFRONT_WEB_SURFACE_COPY[surface];
  const homePage = defaultStorefrontWebPage(surface);
  const isGuest = user.id === 'guest';

  const [searchKw, setSearchKw] = useState('');
  const [showMallMenu, setShowMallMenu] = useState(false);
  const [authHref, setAuthHref] = useState<string | undefined>(undefined);

  useEffect(() => {
    setAuthHref(storefrontAuthHref(window.location.hostname));
  }, []);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (onSelectTab) {
      onSelectTab('category');
    } else {
      setLaptopPage('category');
    }
  };

  const handleNavClick = (page: LaptopPage) => {
    if (onSelectTab) {
      onSelectTab(page);
    } else {
      setLaptopPage(page);
    }
  };

  return (
    <header className="sw-web-header w-full bg-white border-b border-gray-200 sticky top-[48px] z-40 font-sans shadow-xs">
      {/* 第一层：企业身份、客服与账户快捷入口 (高度 26px) */}
      <div className="bg-[var(--sw-brand-dark)] text-white text-[11px] h-[26px] px-3 sm:px-4 flex items-center">
        <div className="sw-web-container max-w-[1240px] mx-auto w-full flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="relative">
              <button onClick={() => setShowMallMenu(!showMallMenu)} className="flex items-center gap-1 bg-blue-900/80 hover:bg-blue-800 text-yellow-300 font-bold px-2 py-0.5 rounded cursor-pointer transition-colors text-[10px]">
                <Building2 className="w-3 h-3" />
                <span className="truncate max-w-[150px]">{currentMall.enterpriseName}</span>
                <ChevronDown className="w-3 h-3" />
              </button>

              {showMallMenu && (
                <div className="absolute top-full left-0 mt-1 w-56 bg-white text-gray-800 rounded-lg shadow-xl border border-gray-200 py-1.5 z-50 text-xs">
                  <div className="px-3 py-1 text-[10px] text-gray-400 font-bold uppercase tracking-wider border-b border-gray-100">切换企业专享商城</div>
                  {malls.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => {
                        switchMall(m.id);
                        setShowMallMenu(false);
                      }}
                      className={`w-full text-left px-3 py-1.5 hover:bg-blue-50 flex items-center justify-between cursor-pointer ${m.id === currentMall.id ? 'font-bold text-[var(--sw-brand)] bg-blue-50/60' : ''}`}
                    >
                      <span className="truncate">{m.enterpriseName}</span>
                      <span className="text-[10px] text-gray-400">{m.logoText}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <span className="text-blue-300 text-[10px]">{currentMall.welcomeBanner || '央企与百强企业福利专享通道'}</span>
          </div>

          <div className="flex items-center gap-3 text-[11px] text-blue-100">
            <button onClick={() => handleNavClick('orders')} className="hover:text-yellow-300 transition-colors flex items-center gap-1 cursor-pointer">
              <FileText className="w-3 h-3" />
              <span>我的订单</span>
            </button>
            <span className="text-blue-400/60">|</span>
            <button onClick={() => triggerPendingFeature('专属客服', '7x24小时企业福利专属坐席为您服务')} className="hover:text-yellow-300 transition-colors flex items-center gap-1 cursor-pointer">
              <Headphones className="w-3 h-3" />
              <span>客服中心</span>
            </button>
            <span className="text-blue-400/60">|</span>
            {isGuest ? (
              <a href={authHref} className="flex items-center gap-1 text-yellow-300 font-medium hover:text-yellow-200 transition-colors" aria-label={`登录或注册${brandName}账户`}>
                <User className="w-3 h-3" />
                <span>登录 / 注册</span>
              </a>
            ) : (
              <div className="flex items-center gap-1 text-yellow-300 font-medium">
                <User className="w-3 h-3" />
                <span>
                  {user.name} ({user.department})
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 第二层：Logo、高密度搜索框、福利卡余额与购物车 (高度 48px) */}
      <div className="h-[48px] px-3 sm:px-4 flex items-center border-b border-gray-100 bg-white">
        <div className="sw-web-container max-w-[1240px] mx-auto w-full flex items-center justify-between gap-4">
          {/* Logo */}
          <div onClick={() => handleNavClick(homePage)} className="flex items-center gap-2 cursor-pointer select-none flex-shrink-0">
            <img src="/brand/morvia-mark.svg" alt="" aria-hidden="true" className="h-9 w-9 object-contain" />
            <strong className="max-w-40 truncate text-xl font-black tracking-tight text-[var(--sw-brand-dark)]">{brandName}</strong>
            <span className="text-[9px] bg-red-100 text-[#E5484D] font-bold px-1 py-0.2 rounded">{surfaceCopy.headerBadge}</span>
          </div>

          {/* 搜索框 & 热门搜索 */}
          <form onSubmit={handleSearch} className="sw-web-search flex-1 max-w-[500px] relative">
            <div className="flex items-center border-2 border-[var(--sw-brand)] rounded-md overflow-hidden bg-white h-[32px] shadow-2xs">
              <input
                type="text"
                value={searchKw}
                onChange={(e) => setSearchKw(e.target.value)}
                placeholder="搜索员工福利商品/电影卡/餐券/生活缴费..."
                className="flex-1 px-3 text-xs text-gray-800 placeholder-gray-400 outline-none bg-transparent"
              />
              <button type="submit" className="bg-[var(--sw-brand)] hover:bg-blue-700 text-white font-bold px-4 h-full flex items-center gap-1 text-xs transition-colors cursor-pointer">
                <Search className="w-3.5 h-3.5" />
                <span>搜索</span>
              </button>
            </div>
          </form>

          {/* 右侧：福利卡余额 & 购物车 */}
          <div className="flex items-center gap-3 flex-shrink-0">
            {/* 福利卡余额卡片 */}
            <div className="bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200/80 rounded-md px-2.5 py-1 flex items-center gap-2">
              <CreditCard className="w-4 h-4 text-[var(--sw-brand)]" />
              <div>
                <div className="text-[9px] text-gray-500 leading-none">福利卡可用余额</div>
                <div className="text-xs font-black text-[var(--sw-brand-dark)] leading-tight">¥{user.welfareBalance.toFixed(2)}</div>
              </div>
            </div>

            {/* 餐卡余额卡片 */}
            <div className="bg-emerald-50 border border-emerald-200/80 rounded-md px-2.5 py-1 flex items-center gap-2">
              <Gift className="w-4 h-4 text-emerald-600" />
              <div>
                <div className="text-[9px] text-gray-500 leading-none">餐卡可用余额</div>
                <div className="text-xs font-black text-emerald-700 leading-tight">¥{user.mealBalance.toFixed(2)}</div>
              </div>
            </div>

            {/* 购物车 */}
            <button
              onClick={() => handleNavClick('cart')}
              className="relative bg-white border border-gray-300 hover:border-[var(--sw-brand)] text-gray-700 hover:text-[var(--sw-brand)] font-bold px-3 py-1.5 rounded-md flex items-center gap-1.5 text-xs transition-all cursor-pointer shadow-2xs"
            >
              <ShoppingCart className="w-4 h-4 text-[var(--sw-brand)]" />
              <span>购物车</span>
              {cartCount > 0 && <span className="bg-[#E5484D] text-white text-[10px] font-bold px-1.5 py-0.2 rounded-full min-w-[16px] text-center">{cartCount}</span>}
            </button>
          </div>
        </div>
      </div>

      {/* 第三层：商品分类触发器与紧凑主导航栏 (高度 32px) */}
      <div className="bg-[var(--sw-brand-dark)] text-white text-xs h-[32px] px-3 sm:px-4 flex items-center">
        <div className="sw-web-container max-w-[1240px] mx-auto w-full flex items-center justify-between">
          <div className="flex items-center gap-1">
            {/* 分类菜单标头 */}
            <div onClick={() => handleNavClick('category')} className="w-[200px] bg-[var(--sw-brand)] font-bold h-[32px] flex items-center justify-between px-3 cursor-pointer select-none text-white hover:bg-blue-600 transition-colors">
              <span className="flex items-center gap-1.5 text-xs">
                <Menu className="w-4 h-4" />
                <span>全部分类</span>
              </span>
              <ChevronDown className="w-3.5 h-3.5" />
            </div>

            {/* 主导航条 */}
            <nav className="flex items-center gap-1 ml-2">
              <button onClick={() => handleNavClick(homePage)} className={`px-3 py-1.5 rounded font-bold transition-colors cursor-pointer text-xs ${activeTab === homePage ? 'bg-white/20 text-yellow-300' : 'hover:bg-white/10 text-white'}`}>
                首页
              </button>

              <button
                onClick={() => handleNavClick('category')}
                className={`px-3 py-1.5 rounded font-bold transition-colors cursor-pointer text-xs flex items-center gap-1 ${activeTab === 'category' ? 'bg-white/20 text-yellow-300' : 'hover:bg-white/10 text-white'}`}
              >
                <Zap className="w-3.5 h-3.5 text-yellow-300" />
                <span>企业福利专区</span>
              </button>

              <button onClick={() => triggerPendingFeature('生活缴费', '支持水费、电费、燃气费与话费扣减')} className="px-3 py-1.5 rounded font-medium hover:bg-white/10 text-blue-100 transition-colors cursor-pointer text-xs">
                生活缴费
              </button>

              <button
                onClick={() => triggerPendingFeature('电影票务', '全国院线特惠通兑卡与在线选座')}
                className="px-3 py-1.5 rounded font-medium hover:bg-white/10 text-blue-100 transition-colors cursor-pointer text-xs flex items-center gap-1"
              >
                <Ticket className="w-3.5 h-3.5 text-amber-300" />
                <span>电影票务</span>
              </button>

              <button onClick={() => triggerPendingFeature('虚拟卡券', '京东E卡、盒马鲜生、沃尔玛与品牌卡券')} className="px-3 py-1.5 rounded font-medium hover:bg-white/10 text-blue-100 transition-colors cursor-pointer text-xs">
                虚拟卡券
              </button>

              <button
                onClick={() => triggerPendingFeature('附近门店核销', '支持合作线下超市与园区餐饮扫码核销')}
                className="px-3 py-1.5 rounded font-medium hover:bg-white/10 text-blue-100 transition-colors cursor-pointer text-xs flex items-center gap-1"
              >
                <MapPin className="w-3.5 h-3.5 text-emerald-300" />
                <span>附近门店核销</span>
              </button>
            </nav>
          </div>

          <div className="hidden lg:flex items-center gap-2 text-[10px] text-blue-200">
            <ShieldCheck className="w-3.5 h-3.5 text-yellow-300" />
            <span>合规采购 · 专票开具 · 余额扣减保障</span>
          </div>
        </div>
      </div>
    </header>
  );
};
