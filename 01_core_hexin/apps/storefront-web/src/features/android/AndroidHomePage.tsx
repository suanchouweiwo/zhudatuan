import React, { useState } from 'react';
import { useMall } from '../../context/MallContext';
import { AndroidStatusBar } from '../../components/mobile/AndroidStatusBar';
import { AndroidBottomNav } from '../../components/mobile/AndroidBottomNav';
import { CreditCard, Utensils, Search, Mic, QrCode, Sparkles, ChevronRight, Flame, Plus, RefreshCw, AlertCircle, ShieldCheck, Building2, Tag } from 'lucide-react';

export const AndroidHomePage: React.FC = () => {
  const { user, currentMall, setAndroidPage, addToCart, triggerPendingFeature, presentationProducts: MOCK_PRODUCTS, presentationCategories: MOCK_CATEGORIES } = useMall();
  const [activeChip, setActiveChip] = useState('all');
  const [isLoading, setIsLoading] = useState(false);
  const [showNetworkRetrySnackbar, setShowNetworkRetrySnackbar] = useState(false);

  const simulateRefresh = () => {
    setIsLoading(true);
    setShowNetworkRetrySnackbar(false);
    setTimeout(() => {
      setIsLoading(false);
      setShowNetworkRetrySnackbar(true);
      setTimeout(() => setShowNetworkRetrySnackbar(false), 3000);
    }, 1200);
  };

  const feedProducts = MOCK_PRODUCTS.filter((p) => {
    if (activeChip === 'all') return true;
    if (activeChip === 'welfare') return p.isEnterpriseExclusive;
    if (activeChip === 'meal') return p.categoryId === 'cat_food';
    if (activeChip === 'coupon') return p.itemType === 'virtual_coupon';
    return true;
  });

  return (
    <div className="bg-[#F5F7FA] min-h-full flex flex-col font-sans text-gray-800 relative">
      <AndroidStatusBar title="主打团福利 App" isLoading={isLoading} onRefresh={simulateRefresh} />

      {/* Android Search & Voice/Scan Top Card */}
      <div className="bg-[var(--sw-brand-dark)] px-3 pb-3 pt-1">
        <div className="bg-white rounded-2xl p-1.5 flex items-center justify-between shadow-md">
          <button onClick={() => setAndroidPage('search')} className="flex-1 flex items-center gap-2 pl-2 text-xs text-gray-400 font-medium cursor-pointer">
            <Search className="w-4 h-4 text-gray-400" />
            <span>搜索协议采购、生鲜卡券、笔记本数码...</span>
          </button>

          <div className="flex items-center gap-1 border-l border-gray-200 pl-1.5 text-gray-500">
            <button onClick={() => triggerPendingFeature('Android 原生语音搜索', '调起 Android SpeechRecognizer 接口听写输入。')} className="p-1.5 hover:bg-gray-100 rounded-full transition-colors cursor-pointer" title="语音搜索">
              <Mic className="w-4 h-4 text-[var(--sw-brand)]" />
            </button>

            <button onClick={() => triggerPendingFeature('Android Camera 扫码核销', '调起相机扫描线下门店优惠券核销二维码。')} className="p-1.5 hover:bg-gray-100 rounded-full transition-colors cursor-pointer" title="扫码">
              <QrCode className="w-4 h-4 text-gray-700" />
            </button>
          </div>
        </div>
      </div>

      <div className="p-3 space-y-3 flex-1 overflow-y-auto pb-16">
        {/* Network Exception Retry Snackbar */}
        {showNetworkRetrySnackbar && (
          <div className="bg-gray-900 text-white rounded-2xl p-3 text-xs flex items-center justify-between shadow-xl animate-in slide-in-from-top duration-300">
            <div className="flex items-center gap-2">
              <RefreshCw className="w-4 h-4 text-emerald-400 animate-spin" />
              <span>数据同步完成（内网节点就绪）</span>
            </div>
            <button onClick={() => setShowNetworkRetrySnackbar(false)} className="text-amber-400 font-bold px-2 py-0.5">
              关闭
            </button>
          </div>
        )}

        {/* Material 3 Elevated Welfare Balances Container */}
        <div className="bg-gradient-to-br from-white to-blue-50/60 rounded-3xl p-3.5 shadow-sm border border-blue-100/80 space-y-3">
          <div className="flex items-center justify-between border-b border-gray-100 pb-2">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-[var(--sw-brand)] animate-ping" />
              <span className="text-xs font-black text-gray-900">{currentMall.mallName}</span>
            </div>
            <span className="text-[10px] bg-[var(--sw-brand-light)] text-[var(--sw-brand)] font-bold px-2 py-0.5 rounded-full">Material 3 B2B2C</span>
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            <div onClick={() => setAndroidPage('profile')} className="bg-gradient-to-r from-[var(--sw-brand)] to-blue-700 text-white rounded-2xl p-3 shadow-xs cursor-pointer active:scale-98 transition-transform">
              <div className="flex items-center justify-between text-[10px] opacity-90">
                <span className="flex items-center gap-1 font-medium">
                  <CreditCard className="w-3.5 h-3.5" />
                  福利卡可用额度
                </span>
                <span>明细 &gt;</span>
              </div>
              <div className="text-lg font-black font-mono mt-1">¥{user.welfareBalance.toLocaleString('zh-CN', { minimumFractionDigits: 2 })}</div>
            </div>

            <div onClick={() => setAndroidPage('profile')} className="bg-gradient-to-r from-[#FF7A00] to-amber-600 text-white rounded-2xl p-3 shadow-xs cursor-pointer active:scale-98 transition-transform">
              <div className="flex items-center justify-between text-[10px] opacity-90">
                <span className="flex items-center gap-1 font-medium">
                  <Utensils className="w-3.5 h-3.5" />
                  餐卡专享补贴
                </span>
                <span>明细 &gt;</span>
              </div>
              <div className="text-lg font-black font-mono mt-1">¥{user.mealBalance.toLocaleString('zh-CN', { minimumFractionDigits: 2 })}</div>
            </div>
          </div>
        </div>

        {/* Material 3 Horizontal Filter Chips */}
        <div className="flex items-center gap-2 overflow-x-auto no-scrollbar py-0.5 text-xs font-bold">
          {[
            { id: 'all', label: '🔥 全部精选' },
            { id: 'welfare', label: '🏢 企业大客户协议价' },
            { id: 'meal', label: '🍱 餐卡专区特惠' },
            { id: 'coupon', label: '🎟️ 星巴克/电影电子券' },
          ].map((chip) => (
            <button
              key={chip.id}
              onClick={() => setActiveChip(chip.id)}
              className={`px-3.5 py-1.5 rounded-full whitespace-nowrap transition-all cursor-pointer ${
                activeChip === chip.id ? 'bg-[var(--sw-brand)] text-white shadow-md shadow-blue-500/20' : 'bg-white text-gray-700 border border-gray-200/80 hover:bg-gray-50'
              }`}
            >
              {chip.label}
            </button>
          ))}
        </div>

        {/* Android Promo Carousel Banner */}
        <div className="bg-gradient-to-r from-gray-900 via-indigo-950 to-blue-950 text-white rounded-3xl p-4 shadow-md space-y-2 relative overflow-hidden">
          <div className="relative z-10 space-y-1">
            <span className="bg-yellow-400 text-gray-900 text-[9px] font-black px-2 py-0.5 rounded-full">Android 专属内测补贴</span>
            <h3 className="text-base font-black tracking-tight">主打团 App · 集团大客户采购直供</h3>
            <p className="text-xs text-blue-200">全额福利卡扣税扣减 · 极速物流开票 · 支持指纹支付</p>
          </div>

          <div className="flex items-center justify-between pt-2 border-t border-white/10 relative z-10">
            <button onClick={() => setAndroidPage('search')} className="bg-white text-[var(--sw-brand-dark)] font-bold text-xs px-4 py-1.5 rounded-full flex items-center gap-1 shadow-sm cursor-pointer">
              <span>进入协议专区</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
            <span className="text-[10px] text-gray-300 font-mono">2026 企采通</span>
          </div>
        </div>

        {/* Skeleton State Simulator Toggle */}
        {isLoading ? (
          <div className="space-y-3">
            <div className="h-20 bg-gray-200 rounded-3xl animate-pulse" />
            <div className="grid grid-cols-2 gap-3">
              <div className="h-40 bg-gray-200 rounded-3xl animate-pulse" />
              <div className="h-40 bg-gray-200 rounded-3xl animate-pulse" />
            </div>
          </div>
        ) : (
          /* 2-Column Product Grid (Material 3 Cards) */
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-black text-gray-900 flex items-center gap-1.5">
                <Flame className="w-4 h-4 text-red-500" />
                <span>推荐福利兑换流</span>
              </h3>
              <span className="text-[10px] text-gray-400">下拉刷新同步数据</span>
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              {feedProducts.map((p) => (
                <div key={p.id} onClick={() => setAndroidPage('detail', p.id)} className="bg-white rounded-3xl p-2.5 shadow-2xs border border-gray-100 flex flex-col justify-between cursor-pointer active:scale-98 transition-transform">
                  <div className="relative aspect-square rounded-2xl overflow-hidden bg-gray-50 mb-2">
                    <img src={p.imageUrl} alt={p.title} className="w-full h-full object-cover" />
                    <span className="absolute top-2 left-2 bg-[var(--sw-brand)] text-white text-[9px] font-bold px-1.5 py-0.5 rounded-md shadow-xs">省¥{p.enterpriseSubsidyAmount}</span>
                  </div>

                  <div className="space-y-1.5">
                    <h4 className="text-xs font-bold text-gray-900 line-clamp-2 leading-tight">{p.title}</h4>
                    <p className="text-[10px] text-gray-400 line-clamp-1">{p.subtitle}</p>

                    <div className="flex items-center justify-between pt-1">
                      <div>
                        <div className="text-xs font-black text-[#E5484D] font-mono">¥{p.price}</div>
                        <div className="text-[9px] text-gray-400 line-through">¥{p.originalPrice}</div>
                      </div>

                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          addToCart(p, 1);
                        }}
                        className="w-7 h-7 rounded-xl bg-[var(--sw-brand)] text-white flex items-center justify-center shadow-xs hover:bg-blue-700 cursor-pointer"
                      >
                        <Plus className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <AndroidBottomNav />
    </div>
  );
};
