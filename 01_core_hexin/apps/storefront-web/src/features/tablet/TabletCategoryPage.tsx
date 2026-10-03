import React, { useState } from 'react';
import { useMall } from '../../context/MallContext';
import { Grid, Filter, Check, ChevronRight, Plus, ShoppingCart, Sparkles, ShieldCheck, Tag, Search, Building2, SlidersHorizontal } from 'lucide-react';

export const TabletCategoryPage: React.FC = () => {
  const { setTabletPage, addToCart, cart, cartCount, triggerPendingFeature, presentationProducts: MOCK_PRODUCTS, presentationCategories: MOCK_CATEGORIES } = useMall();

  const [selectedCatId, setSelectedCatId] = useState<string>('c_101');
  const [selectedBrand, setSelectedBrand] = useState<string>('all');
  const [selectedType, setSelectedType] = useState<string>('all');

  const selectedCat = MOCK_CATEGORIES.find((c) => c.id === selectedCatId) || MOCK_CATEGORIES[0];

  const categoryProducts = MOCK_PRODUCTS.filter((p) => {
    const matchCat = selectedCatId === 'all' || p.categoryId === selectedCatId;
    const matchBrand = selectedBrand === 'all' || p.brand === selectedBrand;
    const matchType = selectedType === 'all' || p.itemType === selectedType;
    return matchCat && matchBrand && matchType;
  });

  const cartTotal = cart.reduce((sum, item) => sum + item.product.priceMall * item.quantity, 0);

  return (
    <div className="bg-[#F5F7FA] h-full flex font-sans text-gray-800 overflow-hidden">
      {/* MASTER PANE: Primary Categories Navigation (Width ~ 220px) */}
      <div className="w-56 bg-white border-r border-gray-200 p-3 flex flex-col justify-between overflow-y-auto shrink-0 shadow-2xs">
        <div className="space-y-3">
          <div className="text-xs font-black text-gray-400 uppercase tracking-wider px-2 flex items-center justify-between">
            <span>企采一级分类</span>
            <span className="text-[10px] bg-blue-50 text-[var(--sw-brand)] font-bold px-1.5 py-0.2 rounded">Master</span>
          </div>

          <div className="space-y-1">
            <button
              onClick={() => setSelectedCatId('all')}
              className={`w-full text-left px-3 py-3 rounded-xl text-xs font-bold flex items-center justify-between transition-colors cursor-pointer min-h-[44px] ${
                selectedCatId === 'all' ? 'bg-[var(--sw-brand)] text-white shadow-sm' : 'text-gray-700 hover:bg-gray-100'
              }`}
            >
              <span>🔥 全部精选商品</span>
              <span className="text-[10px] font-mono">{MOCK_PRODUCTS.length}</span>
            </button>

            {MOCK_CATEGORIES.map((cat) => {
              const count = MOCK_PRODUCTS.filter((p) => p.categoryId === cat.id).length;
              const isActive = selectedCatId === cat.id;
              return (
                <button
                  key={cat.id}
                  onClick={() => setSelectedCatId(cat.id)}
                  className={`w-full text-left px-3 py-3 rounded-xl text-xs font-bold flex items-center justify-between transition-colors cursor-pointer min-h-[44px] ${
                    isActive ? 'bg-[var(--sw-brand)] text-white shadow-sm' : 'text-gray-700 hover:bg-gray-100'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-base">{cat.icon}</span>
                    <span>{cat.name}</span>
                  </div>
                  <span className={`text-[10px] font-mono ${isActive ? 'text-blue-100' : 'text-gray-400'}`}>{count}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* B2B Filter Guarantee Card */}
        <div className="bg-blue-50/80 rounded-2xl p-3 border border-blue-100 space-y-2 text-[11px] text-blue-950">
          <div className="font-black text-xs text-[var(--sw-brand-dark)] flex items-center gap-1.5">
            <ShieldCheck className="w-4 h-4 text-[var(--sw-brand)]" />
            <span>企采分类筛选</span>
          </div>
          <p className="text-[10px] text-gray-600 leading-snug">支持按企采发票类型、品牌特惠和兑换门槛精确筛选。</p>
        </div>
      </div>

      {/* DETAIL PANE: Sub-categories, Brand Filters & Product Grid (flex-1) */}
      <div className="flex-1 p-4 overflow-y-auto space-y-4">
        {/* Sub-category Header & Quick Filter Tags */}
        <div className="bg-white rounded-2xl p-3.5 shadow-2xs border border-gray-200 space-y-3">
          <div className="flex items-center justify-between border-b border-gray-100 pb-2">
            <div>
              <h1 className="text-sm font-black text-gray-900 flex items-center gap-2">
                <span>{selectedCat?.name || '全部精选商品'}</span>
                <span className="text-xs text-gray-400 font-normal">({categoryProducts.length} 款可兑换商品)</span>
              </h1>
              <p className="text-[11px] text-gray-500 mt-0.5">{selectedCat?.description || 'MORVIA enterprise welfare marketplace products.'}</p>
            </div>

            <button
              onClick={() => triggerPendingFeature('平板高阶多维筛选', '调起价格区间、发票类型与库存位置的自定义筛选项。')}
              className="bg-gray-100 hover:bg-gray-200 text-gray-700 font-bold text-xs px-3 py-2 rounded-xl flex items-center gap-1.5 transition-colors cursor-pointer min-h-[40px]"
            >
              <SlidersHorizontal className="w-4 h-4 text-[var(--sw-brand)]" />
              <span>多维筛选</span>
            </button>
          </div>

          {/* Sub-category tags row */}
          <div className="flex items-center gap-2 flex-wrap text-xs">
            <span className="text-gray-400 font-bold mr-1">履约类型:</span>
            <button
              onClick={() => setSelectedType('all')}
              className={`px-3 py-1.5 rounded-xl font-bold transition-colors cursor-pointer ${selectedType === 'all' ? 'bg-blue-50 text-[var(--sw-brand)] border border-[var(--sw-brand)]' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
            >
              不限类型
            </button>
            <button
              onClick={() => setSelectedType('physical')}
              className={`px-3 py-1.5 rounded-xl font-bold transition-colors cursor-pointer ${selectedType === 'physical' ? 'bg-blue-50 text-[var(--sw-brand)] border border-[var(--sw-brand)]' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
            >
              实物直邮
            </button>
            <button
              onClick={() => setSelectedType('virtual_coupon')}
              className={`px-3 py-1.5 rounded-xl font-bold transition-colors cursor-pointer ${selectedType === 'virtual_coupon' ? 'bg-blue-50 text-[var(--sw-brand)] border border-[var(--sw-brand)]' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
            >
              虚拟兑换券
            </button>
          </div>
        </div>

        {/* Product Grid (3 Columns in Tablet Master-Detail Layout) */}
        {categoryProducts.length === 0 ? (
          <div className="bg-white rounded-2xl p-12 text-center text-gray-400 text-xs space-y-2 border border-gray-200">
            <Tag className="w-8 h-8 text-gray-300 mx-auto" />
            <div>当前筛选条件无对应商品</div>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-3">
            {categoryProducts.map((p) => (
              <div key={p.id} onClick={() => setTabletPage('detail', p.id)} className="bg-white rounded-2xl p-3 border border-gray-200 shadow-2xs hover:shadow-md transition-shadow flex flex-col justify-between cursor-pointer space-y-2">
                <div className="aspect-square rounded-xl overflow-hidden bg-gray-50 relative">
                  <img src={p.imageUrl} alt={p.title} className="w-full h-full object-cover" />
                  {p.itemType === 'virtual_coupon' && <span className="absolute top-1.5 right-1.5 bg-purple-600 text-white text-[9px] font-black px-1.5 py-0.5 rounded">虚拟券</span>}
                  {p.enterpriseSubsidyAmount > 0 && <span className="absolute top-1.5 left-1.5 bg-[#E5484D] text-white text-[9px] font-black px-1.5 py-0.5 rounded">补贴 ¥{p.enterpriseSubsidyAmount}</span>}
                </div>

                <div className="space-y-1">
                  <div className="text-xs font-bold text-gray-900 line-clamp-2 leading-snug">{p.title}</div>
                  <div className="flex items-baseline gap-1 font-mono text-xs">
                    <span className="text-[#E5484D] font-black">¥{p.price}</span>
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
                  <span>兑换加购</span>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* RIGHT PANE: Selected Filters Summary & Cart Quick View (~250px) */}
      <div className="w-64 bg-white border-l border-gray-200 p-3.5 flex flex-col justify-between overflow-y-auto shrink-0 shadow-2xs space-y-4">
        <div className="space-y-3">
          <div className="text-xs font-black text-gray-900 border-b border-gray-100 pb-2 flex items-center justify-between">
            <span>筛选条件汇总</span>
            <span className="text-[10px] bg-amber-100 text-amber-800 font-bold px-1.5 py-0.2 rounded">Tablet View</span>
          </div>

          <div className="bg-gray-50 rounded-2xl p-3 space-y-2 text-xs text-gray-700">
            <div className="flex justify-between">
              <span className="text-gray-400">当前分类:</span>
              <span className="font-bold text-[var(--sw-brand)]">{selectedCat?.name}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">履约方式:</span>
              <span className="font-bold">{selectedType === 'all' ? '全部方式' : selectedType === 'physical' ? '实物直邮' : '虚拟卡券'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">匹配商品:</span>
              <span className="font-mono font-bold text-emerald-600">{categoryProducts.length} 件</span>
            </div>
          </div>
        </div>

        {/* Quick Cart Summary in Right Pane */}
        <div className="bg-gray-50 rounded-2xl p-3 border border-gray-200 space-y-3">
          <div className="flex items-center justify-between border-b border-gray-200 pb-2">
            <span className="text-xs font-bold text-gray-900 flex items-center gap-1">
              <ShoppingCart className="w-4 h-4 text-[var(--sw-brand)]" />
              <span>已选福利</span>
            </span>
            <span className="text-xs font-mono font-bold text-[#E5484D]">¥{cartTotal.toFixed(2)}</span>
          </div>

          <button
            onClick={() => setTabletPage('cart')}
            disabled={cartCount === 0}
            className={`w-full font-bold text-xs py-2.5 rounded-xl shadow-md transition-all flex items-center justify-center gap-1 cursor-pointer min-h-[44px] ${
              cartCount > 0 ? 'bg-[var(--sw-brand)] hover:bg-blue-600 text-white' : 'bg-gray-200 text-gray-400 cursor-not-allowed'
            }`}
          >
            <span>去购物车结算 ({cartCount})</span>
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
};
