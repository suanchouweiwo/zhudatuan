import React, { useState } from 'react';
import { useMall } from '../../context/MallContext';
import { TabletLandscapeAccountPane } from './TabletLandscapeAccountPane';
import { Search, Scan, Gift, Building2, CreditCard, Utensils, ChevronRight, ShoppingCart, ShieldCheck, Truck, Sparkles, MapPin, Clock, CheckCircle, Plus, ArrowRight, SlidersHorizontal, Flame, Coffee, Laptop } from 'lucide-react';

export const TabletLandscapeHome: React.FC = () => {
  const { user, currentMall, setTabletPage, addToCart, cart, cartCount, triggerPendingFeature, presentationProducts: MOCK_PRODUCTS, presentationCategories: MOCK_CATEGORIES } = useMall();
  const [activeCategory, setActiveCategory] = useState('all');
  const [searchKey, setSearchKey] = useState('');
  const filteredProducts = activeCategory === 'all' ? MOCK_PRODUCTS : MOCK_PRODUCTS.filter((product) => product.categoryId === activeCategory);
  const cartTotal = cart.reduce((sum, item) => sum + item.product.priceMall * item.quantity, 0);

  return (
    <div className="bg-[#F5F7FA] h-full flex font-sans text-gray-800 overflow-hidden">
      {/* LEFT PANE: Categories, Perks, Nearby (~220px) */}
      <div className="w-56 bg-white border-r border-gray-200 p-3 flex flex-col justify-between overflow-y-auto shrink-0 shadow-2xs space-y-4">
        <div className="space-y-3">
          <div className="text-xs font-black text-gray-400 uppercase tracking-wider px-2">一级企采分类</div>
          <div className="space-y-1">
            <button
              onClick={() => setActiveCategory('all')}
              className={`w-full text-left px-3 py-2.5 rounded-xl text-xs font-bold flex items-center justify-between transition-colors cursor-pointer min-h-[44px] ${
                activeCategory === 'all' ? 'bg-blue-50 text-[var(--sw-brand)] border-l-4 border-[var(--sw-brand)]' : 'text-gray-700 hover:bg-gray-100'
              }`}
            >
              <span>🔥 全部推荐</span>
              <span className="text-[10px] font-mono text-gray-400">{MOCK_PRODUCTS.length}</span>
            </button>

            {MOCK_CATEGORIES.map((cat) => (
              <button
                key={cat.id}
                onClick={() => setActiveCategory(cat.id)}
                className={`w-full text-left px-3 py-2.5 rounded-xl text-xs font-bold flex items-center justify-between transition-colors cursor-pointer min-h-[44px] ${
                  activeCategory === cat.id ? 'bg-blue-50 text-[var(--sw-brand)] border-l-4 border-[var(--sw-brand)]' : 'text-gray-700 hover:bg-gray-100'
                }`}
              >
                <span>{cat.name}</span>
                <ChevronRight className="w-3.5 h-3.5 text-gray-300" />
              </button>
            ))}
          </div>

          <div className="border-t border-gray-100 pt-3 space-y-2">
            <div className="text-xs font-black text-gray-400 uppercase tracking-wider px-2">企采专区保障</div>
            <div className="bg-blue-50/60 rounded-2xl p-2.5 text-[11px] space-y-2 border border-blue-100">
              <div className="flex items-center gap-2 text-[var(--sw-brand-dark)] font-bold">
                <ShieldCheck className="w-4 h-4 text-[var(--sw-brand)]" />
                <span>100% 正品开票</span>
              </div>
              <div className="flex items-center gap-2 text-[var(--sw-brand-dark)] font-bold">
                <Truck className="w-4 h-4 text-emerald-600" />
                <span>企采统仓极速直邮</span>
              </div>
              <div className="flex items-center gap-2 text-[var(--sw-brand-dark)] font-bold">
                <CreditCard className="w-4 h-4 text-amber-600" />
                <span>福利卡/餐卡全额冲抵</span>
              </div>
            </div>
          </div>
        </div>

        {/* Nearby Services Entry */}
        <div className="bg-amber-50 rounded-2xl p-3 border border-amber-200 space-y-1.5">
          <div className="text-xs font-black text-amber-900 flex items-center gap-1.5">
            <MapPin className="w-4 h-4 text-amber-600" />
            <span>园区本地生活服务</span>
          </div>
          <p className="text-[10px] text-amber-800 leading-snug">扫码即享园区食堂、咖啡洗车、高德打车企业月结。</p>
          <button
            onClick={() => triggerPendingFeature('平板园区服务地图', '加载高德 SDK 园区合作商户与餐卡核销点。')}
            className="w-full bg-amber-400 hover:bg-amber-500 text-gray-900 font-bold text-[11px] py-1.5 rounded-xl transition-colors cursor-pointer min-h-[36px]"
          >
            查看附近核销点
          </button>
        </div>
      </div>

      {/* MIDDLE PANE: Search, Banner, 4-Column Grid (flex-1) */}
      <div className="flex-1 p-4 overflow-y-auto space-y-4">
        {/* Search Bar & Scanner */}
        <div className="bg-white rounded-2xl p-2.5 shadow-2xs border border-gray-200 flex items-center gap-3">
          <div className="flex-1 flex items-center gap-2 px-2">
            <Search className="w-4 h-4 text-gray-400" />
            <input type="text" placeholder="搜索企业福利商品、电子礼券、办公设备..." value={searchKey} onChange={(e) => setSearchKey(e.target.value)} className="w-full text-xs font-medium outline-none bg-transparent" />
          </div>
          <button
            onClick={() => triggerPendingFeature('平板扫码核销', '调起硬件或后置摄像头扫描商品条形码。')}
            className="bg-gray-100 hover:bg-gray-200 text-gray-700 px-3 py-2 rounded-xl text-xs font-bold flex items-center gap-1 cursor-pointer min-h-[40px]"
          >
            <Scan className="w-4 h-4 text-[var(--sw-brand)]" />
            <span>扫码购</span>
          </button>
        </div>

        {/* Hero Banner */}
        <div className="bg-gradient-to-r from-[var(--sw-brand-dark)] via-[var(--sw-brand)] to-blue-600 rounded-3xl p-5 text-white shadow-md relative overflow-hidden flex items-center justify-between">
          <div className="space-y-2 z-10 max-w-[70%]">
            <div className="inline-flex items-center gap-1.5 bg-amber-400 text-gray-900 text-[10px] font-black px-2.5 py-0.5 rounded-full">
              <Sparkles className="w-3 h-3" />
              <span>TABLET COMMERCE UI · MORVIA 主打团</span>
            </div>
            <h1 className="text-xl font-black leading-tight">中国建筑大厦 员工福利专享月</h1>
            <p className="text-xs text-blue-100">企采直发、福利卡全额扣减、支持开具电子发票与专票。</p>
          </div>
          <div className="flex items-center gap-2 z-10">
            <button onClick={() => setTabletPage('category')} className="bg-white text-[var(--sw-brand-dark)] hover:bg-yellow-300 font-bold text-xs px-4 py-2.5 rounded-2xl shadow-sm transition-colors cursor-pointer min-h-[44px]">
              浏览全部分类
            </button>
          </div>
        </div>

        {/* 4-Column Product Grid */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="font-black text-sm text-gray-900 flex items-center gap-2">
              <Flame className="w-4 h-4 text-orange-500" />
              <span>推荐福利商品 ({filteredProducts.length})</span>
            </h2>
            <span className="text-xs text-gray-400 font-medium">双击卡片快速加入</span>
          </div>

          <div className="grid grid-cols-4 gap-3">
            {filteredProducts.map((p) => (
              <div
                key={p.id}
                onClick={() => setTabletPage('detail', p.id)}
                className="bg-white rounded-2xl p-3 border border-gray-100 shadow-2xs hover:shadow-md transition-shadow flex flex-col justify-between cursor-pointer space-y-2 group"
              >
                <div className="aspect-square rounded-xl overflow-hidden bg-gray-50 relative">
                  <img src={p.imageUrl} alt={p.title} className="w-full h-full object-cover group-hover:scale-105 transition-transform" />
                  {p.enterpriseSubsidyAmount > 0 && <span className="absolute top-1.5 left-1.5 bg-[#E5484D] text-white text-[9px] font-black px-1.5 py-0.5 rounded">企采立省 ¥{p.enterpriseSubsidyAmount}</span>}
                </div>

                <div className="space-y-1">
                  <div className="text-xs font-bold text-gray-900 line-clamp-2 leading-snug">{p.title}</div>
                  <div className="flex items-baseline gap-1 font-mono text-xs">
                    <span className="text-[#E5484D] font-extrabold">¥{p.price}</span>
                    <span className="text-[10px] text-gray-400 line-through">¥{p.originalPrice}</span>
                  </div>
                </div>

                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    addToCart(p, 1);
                  }}
                  className="w-full bg-blue-50 hover:bg-[var(--sw-brand)] hover:text-white text-[var(--sw-brand)] font-bold text-xs py-2 rounded-xl transition-colors flex items-center justify-center gap-1 cursor-pointer min-h-[40px]"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>加入购物车</span>
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>

      <TabletLandscapeAccountPane />
    </div>
  );
};
