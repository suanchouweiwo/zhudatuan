import React, { useState } from 'react';
import { useMall } from '../../context/MallContext';
import { Heart, Share2, ShieldCheck, Truck, CreditCard, Utensils, MapPin, ShoppingCart, SlidersHorizontal, CheckCircle2, Headphones, Building2, Info, ChevronRight, Sparkles } from 'lucide-react';

export const TabletDetailPage: React.FC = () => {
  const { mobileProductId, setTabletPage, addToCart, cartCount, triggerPendingFeature, presentationProducts: MOCK_PRODUCTS } = useMall();

  const product = MOCK_PRODUCTS.find((p) => p.id === mobileProductId) || MOCK_PRODUCTS[0];

  const [selectedSpec, setSelectedSpec] = useState<Record<string, string>>({});
  const [quantity, setQuantity] = useState(1);
  const [isFav, setIsFav] = useState(false);

  const handleBuyNow = () => {
    addToCart(product, quantity, selectedSpec);
    setTabletPage('cart');
  };

  return (
    <div className="bg-[#F5F7FA] h-full flex font-sans text-gray-800 overflow-hidden">
      {/* LEFT COLUMN: Product Image Gallery, Graphic Detail & Service Guarantees (~50%) */}
      <div className="w-1/2 p-4 overflow-y-auto space-y-4 border-r border-gray-200 bg-white">
        {/* Main Hero Image */}
        <div className="aspect-square w-full rounded-3xl bg-gray-50 border border-gray-100 overflow-hidden relative shadow-2xs">
          <img src={product.imageUrl} alt={product.title} className="w-full h-full object-cover" />

          <div className="absolute top-3 right-3 flex items-center gap-2">
            <button onClick={() => setIsFav(!isFav)} className="w-10 h-10 rounded-full bg-black/40 text-white flex items-center justify-center backdrop-blur-xs cursor-pointer hover:bg-black/60 transition-colors">
              <Heart className={`w-5 h-5 ${isFav ? 'fill-red-500 text-red-500' : ''}`} />
            </button>
            <button
              onClick={() => triggerPendingFeature('平板原生 Intent 分享', '通过 Tablet Android System Share Sheet 挂载商品卡片。')}
              className="w-10 h-10 rounded-full bg-black/40 text-white flex items-center justify-center backdrop-blur-xs cursor-pointer hover:bg-black/60 transition-colors"
            >
              <Share2 className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Service Guarantees Card */}
        <div className="bg-blue-50/70 rounded-2xl p-3.5 border border-blue-100 grid grid-cols-3 gap-2 text-center text-xs text-gray-700 font-bold">
          <div className="flex items-center justify-center gap-1.5">
            <ShieldCheck className="w-4 h-4 text-[var(--sw-brand)]" />
            <span>100% 正品开票</span>
          </div>
          <div className="flex items-center justify-center gap-1.5">
            <Truck className="w-4 h-4 text-emerald-600" />
            <span>企采统仓直邮</span>
          </div>
          <div className="flex items-center justify-center gap-1.5">
            <CreditCard className="w-4 h-4 text-amber-600" />
            <span>福利卡无损扣减</span>
          </div>
        </div>

        {/* Product Parameters & Details */}
        <div className="bg-gray-50 rounded-2xl p-4 space-y-3 text-xs border border-gray-200">
          <h3 className="font-black text-gray-900 text-xs border-l-3 border-[var(--sw-brand)] pl-2 flex items-center justify-between">
            <span>企采图文详情与规格说明</span>
            <span className="text-[10px] text-gray-400 font-normal">编号: {product.id}</span>
          </h3>

          <p className="text-gray-600 leading-relaxed">{product.description || '主打团商城为企业员工提供一站式福利兑换与全额扣减服务。'}</p>

          {product.parameters && (
            <div className="divide-y divide-gray-200 border-t border-gray-200 pt-2 space-y-1.5">
              {Object.entries(product.parameters).map(([k, v]) => (
                <div key={k} className="flex justify-between py-1">
                  <span className="text-gray-400">{k}</span>
                  <span className="font-bold text-gray-800">{v}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* RIGHT COLUMN: Title, Pricing, Specs, Delivery & Actions (~50%) */}
      <div className="w-1/2 p-5 overflow-y-auto flex flex-col justify-between space-y-4 bg-[#F5F7FA]">
        <div className="space-y-4">
          {/* Price Banner Container */}
          <div className="bg-gradient-to-r from-[var(--sw-brand-dark)] to-[var(--sw-brand)] text-white p-4 rounded-3xl shadow-sm flex items-center justify-between">
            <div>
              <div className="text-[10px] text-blue-200 uppercase font-black tracking-wider">企采专享内购价</div>
              <div className="flex items-baseline gap-1.5 font-mono mt-0.5">
                <span className="text-xs font-bold">¥</span>
                <span className="text-3xl font-black">{product.price}</span>
                <span className="text-xs text-blue-200 line-through">¥{product.originalPrice}</span>
              </div>
            </div>

            <div className="bg-amber-400 text-gray-900 px-3.5 py-1.5 rounded-2xl text-center shadow-xs">
              <div className="text-[9px] font-black">企采补贴</div>
              <div className="text-sm font-black">立省 ¥{product.enterpriseSubsidyAmount}</div>
            </div>
          </div>

          {/* Title & Subtitle Card */}
          <div className="bg-white rounded-3xl p-4 shadow-2xs border border-gray-200 space-y-2">
            <h1 className="text-base font-black text-gray-900 leading-snug">{product.title}</h1>
            <p className="text-xs text-gray-500">{product.subtitle}</p>

            <div className="flex items-center gap-2 pt-2 text-xs">
              <span className="bg-blue-50 text-[var(--sw-brand)] font-bold px-2.5 py-1 rounded-lg">{product.itemType === 'virtual_coupon' ? '虚拟兑换券' : '实物直邮仓'}</span>
              <span className="text-gray-400">品牌: {product.brand || '主打团 精选'}</span>
              <span className="text-gray-400">库存: {product.stockCount} 件</span>
            </div>
          </div>

          {/* Spec Options Card */}
          {product.specOptions && (
            <div className="bg-white rounded-3xl p-4 shadow-2xs border border-gray-200 space-y-3">
              <div className="text-xs font-black text-gray-900 flex items-center justify-between border-b border-gray-100 pb-2">
                <span>选择产品规格</span>
                <span className="text-gray-400 text-[10px]">平板触控极速勾选</span>
              </div>

              {Object.entries(product.specOptions).map(([specKey, specValues]) => (
                <div key={specKey} className="space-y-1.5">
                  <label className="text-xs font-bold text-gray-700">{specKey}</label>
                  <div className="flex items-center gap-2 flex-wrap">
                    {specValues.map((val) => {
                      const isSelected = selectedSpec[specKey] === val || (!selectedSpec[specKey] && specValues[0] === val);
                      return (
                        <button
                          key={val}
                          onClick={() => setSelectedSpec((prev) => ({ ...prev, [specKey]: val }))}
                          className={`px-3.5 py-2 rounded-xl text-xs font-bold border transition-all cursor-pointer min-h-[40px] ${
                            isSelected ? 'border-[var(--sw-brand)] bg-blue-50 text-[var(--sw-brand)] shadow-2xs' : 'border-gray-200 text-gray-700 bg-gray-50 hover:bg-gray-100'
                          }`}
                        >
                          {val}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}

              {/* Quantity Counter */}
              <div className="flex items-center justify-between pt-2 border-t border-gray-100">
                <span className="text-xs font-bold text-gray-700">兑换数量</span>
                <div className="flex items-center border border-gray-200 rounded-xl overflow-hidden bg-gray-50">
                  <button onClick={() => setQuantity(Math.max(1, quantity - 1))} className="px-3.5 py-1.5 bg-gray-100 font-black text-gray-700 hover:bg-gray-200 min-h-[40px]">
                    -
                  </button>
                  <span className="px-5 py-1.5 font-mono font-bold text-xs">{quantity}</span>
                  <button onClick={() => setQuantity(quantity + 1)} className="px-3.5 py-1.5 bg-gray-100 font-black text-gray-700 hover:bg-gray-200 min-h-[40px]">
                    +
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Enterprise Address Selector */}
          <div
            onClick={() => triggerPendingFeature('平板企业地址选择器', '切换公司总部、园区宿舍与个人收货地址。')}
            className="bg-white rounded-2xl p-3.5 shadow-2xs border border-gray-200 flex items-center justify-between cursor-pointer hover:bg-gray-50 transition-colors"
          >
            <div className="flex items-center gap-2.5 text-xs">
              <MapPin className="w-4 h-4 text-[var(--sw-brand)]" />
              <div>
                <span className="font-bold text-gray-900">默认配送至：</span>
                <span className="text-gray-600">北京市朝阳区中国建筑大厦 12F 企采仓</span>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-gray-400" />
          </div>
        </div>

        {/* Action Buttons Bar */}
        <div className="bg-white rounded-3xl p-3 shadow-md border border-gray-200 flex items-center gap-3">
          <button onClick={() => triggerPendingFeature('平板客服', '调起企业专属 1 对 1 客服通道。')} className="p-3 text-gray-500 hover:text-gray-800 text-xs flex flex-col items-center cursor-pointer min-h-[44px]">
            <Headphones className="w-5 h-5 text-[var(--sw-brand)]" />
            <span className="text-[10px]">客服</span>
          </button>

          <button onClick={() => addToCart(product, quantity, selectedSpec)} className="flex-1 bg-blue-50 hover:bg-blue-100 text-[var(--sw-brand)] font-black text-xs py-3 rounded-2xl transition-colors cursor-pointer min-h-[48px]">
            加入购物车 ({cartCount})
          </button>

          <button
            onClick={handleBuyNow}
            className="flex-1 bg-gradient-to-r from-[var(--sw-brand)] to-[var(--sw-brand-dark)] hover:opacity-95 text-white font-black text-xs py-3 rounded-2xl shadow-md transition-all cursor-pointer min-h-[48px]"
          >
            福利卡全额兑换
          </button>
        </div>
      </div>
    </div>
  );
};
