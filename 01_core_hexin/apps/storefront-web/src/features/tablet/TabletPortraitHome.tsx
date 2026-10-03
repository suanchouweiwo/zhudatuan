import React, { useState } from 'react';
import { useMall } from '../../context/MallContext';
import { Search, Scan, Gift, Building2, CreditCard, Utensils, ChevronRight, ShoppingCart, ShieldCheck, Truck, Sparkles, MapPin, Clock, CheckCircle, Plus, ArrowRight, SlidersHorizontal, Flame, Coffee, Laptop } from 'lucide-react';

export const TabletPortraitHome: React.FC = () => {
  const { user, currentMall, setTabletPage, addToCart, cart, cartCount, triggerPendingFeature, presentationProducts: MOCK_PRODUCTS, presentationCategories: MOCK_CATEGORIES } = useMall();
  const [activeCategory, setActiveCategory] = useState('all');
  const [searchKey, setSearchKey] = useState('');
  const filteredProducts = activeCategory === 'all' ? MOCK_PRODUCTS : MOCK_PRODUCTS.filter((product) => product.categoryId === activeCategory);
  const cartTotal = cart.reduce((sum, item) => sum + item.product.priceMall * item.quantity, 0);

  return (
    <div className="bg-[#F5F7FA] min-h-full flex flex-col font-sans text-gray-800 pb-20 overflow-y-auto">
      {/* Top Header Section */}
      <div className="bg-[var(--sw-brand-dark)] text-white p-4 space-y-3 shadow-md">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <img src="/brand/morvia-master-lockup-white.svg" alt="MORVIA · zhudatuan 主打团" className="h-10 w-40 object-contain" />
            <div>
              <div className="text-sm font-black tracking-wide flex items-center gap-2">
                <span className="bg-yellow-400 text-gray-900 text-[9px] font-extrabold px-2 py-0.5 rounded-full">平板竖屏端</span>
              </div>
              <div className="text-xs text-blue-200 flex items-center gap-1">
                <Building2 className="w-3.5 h-3.5 text-amber-300" />
                <span>{user.enterpriseName}</span>
              </div>
            </div>
          </div>

          {/* Quick Balances Chips */}
          <div className="flex items-center gap-2">
            <div onClick={() => triggerPendingFeature('平板福利卡账单', '查看企业福利卡实时扣款历史。')} className="bg-white/10 hover:bg-white/20 px-3 py-1.5 rounded-xl border border-white/20 text-right cursor-pointer">
              <div className="text-[10px] text-blue-200">福利卡</div>
              <div className="text-xs font-black font-mono text-yellow-300">¥{user.welfareBalance.toFixed(0)}</div>
            </div>
            <div onClick={() => triggerPendingFeature('平板餐卡账单', '查看餐卡消费明细。')} className="bg-white/10 hover:bg-white/20 px-3 py-1.5 rounded-xl border border-white/20 text-right cursor-pointer">
              <div className="text-[10px] text-blue-200">餐卡</div>
              <div className="text-xs font-black font-mono text-amber-300">¥{user.mealBalance.toFixed(0)}</div>
            </div>
          </div>
        </div>

        {/* Search Bar */}
        <div className="flex items-center gap-2">
          <div className="flex-1 bg-white rounded-2xl px-3.5 py-2.5 flex items-center gap-2 text-gray-800 shadow-inner">
            <Search className="w-4 h-4 text-gray-400" />
            <input type="text" placeholder="搜索企采福利、办公室咖啡、礼品卡券..." value={searchKey} onChange={(e) => setSearchKey(e.target.value)} className="w-full text-xs bg-transparent outline-none font-medium" />
          </div>
          <button
            onClick={() => triggerPendingFeature('平板扫码核销', '调起相机扫描企业兑换码。')}
            className="bg-blue-600 hover:bg-blue-500 text-white px-3.5 py-2.5 rounded-2xl text-xs font-bold flex items-center gap-1 cursor-pointer min-h-[44px]"
          >
            <Scan className="w-4 h-4" />
            <span>扫码</span>
          </button>
        </div>
      </div>

      {/* Categories Bar */}
      <div className="bg-white border-b border-gray-200 p-2.5 px-4 flex items-center gap-2 overflow-x-auto shadow-2xs">
        <button
          onClick={() => setActiveCategory('all')}
          className={`px-4 py-2 rounded-xl text-xs font-bold whitespace-nowrap transition-colors cursor-pointer min-h-[40px] ${activeCategory === 'all' ? 'bg-[var(--sw-brand)] text-white shadow-xs' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}
        >
          全部推荐
        </button>
        {MOCK_CATEGORIES.map((cat) => (
          <button
            key={cat.id}
            onClick={() => setActiveCategory(cat.id)}
            className={`px-4 py-2 rounded-xl text-xs font-bold whitespace-nowrap transition-colors cursor-pointer min-h-[40px] ${
              activeCategory === cat.id ? 'bg-[var(--sw-brand)] text-white shadow-xs' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            {cat.name}
          </button>
        ))}
      </div>

      {/* Main Content Area */}
      <div className="p-4 space-y-4">
        {/* Banner Hero */}
        <div className="bg-gradient-to-r from-[var(--sw-brand-dark)] to-[var(--sw-brand)] rounded-3xl p-5 text-white shadow-md relative overflow-hidden flex items-center justify-between">
          <div className="space-y-2 max-w-[65%] z-10">
            <span className="bg-amber-400 text-gray-900 text-[10px] font-black px-2.5 py-1 rounded-full uppercase tracking-wider">企业员工专属福利日</span>
            <h2 className="text-xl font-black leading-tight">全场正品好物 企采补贴立省 30%</h2>
            <p className="text-xs text-blue-100 leading-relaxed">支持企业福利卡与餐卡余额无缝全额冲抵，开具增值税专用发票。</p>
            <button
              onClick={() => setTabletPage('category')}
              className="bg-white text-[var(--sw-brand-dark)] hover:bg-yellow-300 transition-colors font-bold text-xs px-4 py-2 rounded-xl flex items-center gap-1 shadow-sm cursor-pointer min-h-[40px]"
            >
              <span>进入福利专区</span>
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
          <Gift className="w-28 h-28 text-white/20 absolute -right-2 -bottom-2" />
        </div>

        {/* Product Grid (3 Columns in Portrait Tablet) */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="font-black text-sm text-gray-900 flex items-center gap-1.5">
              <Flame className="w-4 h-4 text-orange-500" />
              <span>热门企业兑换商品 ({filteredProducts.length})</span>
            </h3>
            <span className="text-xs text-gray-400">触控放大查看</span>
          </div>

          <div className="grid grid-cols-3 gap-3">
            {filteredProducts.map((p) => (
              <div key={p.id} onClick={() => setTabletPage('detail', p.id)} className="bg-white rounded-2xl p-3 border border-gray-100 shadow-2xs hover:shadow-md transition-shadow flex flex-col justify-between cursor-pointer space-y-2">
                <div className="aspect-square rounded-xl overflow-hidden bg-gray-50 relative">
                  <img src={p.imageUrl} alt={p.title} className="w-full h-full object-cover" />
                  {p.enterpriseSubsidyAmount > 0 && <span className="absolute top-1.5 left-1.5 bg-[#E5484D] text-white text-[9px] font-extrabold px-1.5 py-0.5 rounded">补贴 ¥{p.enterpriseSubsidyAmount}</span>}
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
                  <span>加购物车</span>
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Bottom Persistent Quick Cart Bar */}
      {cartCount > 0 && (
        <div className="fixed bottom-14 left-0 right-0 max-w-[800px] mx-auto bg-gray-900 text-white p-3 px-5 z-20 flex items-center justify-between shadow-2xl border-t border-gray-800">
          <div className="flex items-center gap-3">
            <div className="relative bg-[var(--sw-brand)] p-2.5 rounded-2xl">
              <ShoppingCart className="w-5 h-5 text-white" />
              <span className="absolute -top-1.5 -right-1.5 bg-[#E5484D] text-white text-[10px] font-black w-5 h-5 rounded-full flex items-center justify-center">{cartCount}</span>
            </div>
            <div>
              <div className="text-xs text-gray-300">购物车小计</div>
              <div className="text-base font-black font-mono text-amber-300">¥{cartTotal.toFixed(2)}</div>
            </div>
          </div>

          <button
            onClick={() => setTabletPage('cart')}
            className="bg-[var(--sw-brand)] hover:bg-blue-600 text-white font-bold text-xs px-6 py-2.5 rounded-2xl shadow-md transition-colors cursor-pointer flex items-center gap-1.5 min-h-[44px]"
          >
            <span>立即去结算</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
};
