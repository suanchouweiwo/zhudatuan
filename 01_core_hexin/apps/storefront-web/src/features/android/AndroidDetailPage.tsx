import React, { useState } from 'react';
import { useMall } from '../../context/MallContext';
import { AndroidStatusBar } from '../../components/mobile/AndroidStatusBar';
import { AndroidBottomNav } from '../../components/mobile/AndroidBottomNav';
import { Share2, Heart, ShoppingCart, ShieldCheck, Truck, CheckCircle2, CreditCard, X, ChevronRight, Headphones, SlidersHorizontal } from 'lucide-react';

export const AndroidDetailPage: React.FC = () => {
  const { mobileProductId, setAndroidPage, addToCart, cartCount, triggerPendingFeature, presentationProducts: MOCK_PRODUCTS } = useMall();
  const [selectedSpec, setSelectedSpec] = useState<Record<string, string>>({});
  const [quantity, setQuantity] = useState(1);
  const [showSpecBottomSheet, setShowSpecBottomSheet] = useState(false);
  const [isFav, setIsFav] = useState(false);

  const product = MOCK_PRODUCTS.find((p) => p.id === mobileProductId) || MOCK_PRODUCTS[0];

  const handleBuyNow = () => {
    addToCart(product, quantity, selectedSpec);
    setAndroidPage('checkout');
  };

  return (
    <div className="bg-[#F5F7FA] min-h-full flex flex-col font-sans text-gray-800 relative pb-16">
      <AndroidStatusBar title="商品详情" showBack={true} onBack={() => setAndroidPage('home')} />

      {/* Main Image Header */}
      <div className="relative bg-white aspect-square w-full">
        <img src={product.imageUrl} alt={product.title} className="w-full h-full object-cover" />

        <div className="absolute top-3 right-3 flex items-center gap-2">
          <button onClick={() => setIsFav(!isFav)} className="w-9 h-9 rounded-full bg-black/40 text-white flex items-center justify-center backdrop-blur-xs cursor-pointer">
            <Heart className={`w-5 h-5 ${isFav ? 'fill-red-500 text-red-500' : ''}`} />
          </button>
          <button
            onClick={() => triggerPendingFeature('Android 系统原生 Intent 分享', '调用 Android Intent.ACTION_SEND 挂载商品卡片图片与企采链接。')}
            className="w-9 h-9 rounded-full bg-black/40 text-white flex items-center justify-center backdrop-blur-xs cursor-pointer"
          >
            <Share2 className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Material 3 Price Banner Container */}
      <div className="bg-[var(--sw-brand-dark)] text-white p-4 shadow-sm flex items-center justify-between">
        <div>
          <div className="flex items-baseline gap-1.5 font-mono">
            <span className="text-xs font-bold">企采内购价 ¥</span>
            <span className="text-2xl font-black">{product.price}</span>
            <span className="text-xs text-blue-200 line-through">¥{product.originalPrice}</span>
          </div>
          <div className="text-[10px] text-yellow-300 font-bold mt-0.5 flex items-center gap-1">
            <CreditCard className="w-3.5 h-3.5" />
            <span>支持福利卡/餐卡额度全额冲抵</span>
          </div>
        </div>

        <div className="bg-amber-400 text-gray-900 px-3 py-1 rounded-xl text-center flex-shrink-0">
          <div className="text-[9px] font-bold">企采补贴</div>
          <div className="text-xs font-black">立省 ¥{product.enterpriseSubsidyAmount}</div>
        </div>
      </div>

      {/* Product Title Card */}
      <div className="p-3 space-y-3 flex-1 overflow-y-auto">
        <div className="bg-white rounded-3xl p-4 shadow-2xs border border-gray-100 space-y-2">
          <h1 className="text-sm font-bold text-gray-900 leading-snug">{product.title}</h1>
          <p className="text-xs text-gray-500">{product.subtitle}</p>

          <div className="flex items-center gap-2 pt-1 text-[10px]">
            <span className="bg-blue-50 text-[var(--sw-brand)] font-bold px-2 py-0.5 rounded-md">{product.itemType === 'virtual_coupon' ? '虚拟卡券码' : '实物直邮'}</span>
            <span className="text-gray-400">品牌: {product.brand || '主打团 精选'}</span>
            <span className="text-gray-400">库存: {product.stockCount}</span>
          </div>
        </div>

        {/* Spec Bottom Sheet Trigger Button */}
        <div
          onClick={() => setShowSpecBottomSheet(true)}
          className="bg-white rounded-2xl p-3.5 shadow-2xs border border-gray-100 flex items-center justify-between text-xs font-bold text-gray-800 cursor-pointer hover:bg-gray-50 transition-colors"
        >
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="w-4 h-4 text-[var(--sw-brand)]" />
            <span>选择规格与兑换数量</span>
          </div>
          <span className="text-gray-400 text-[10px] flex items-center">
            <span>
              {Object.values(selectedSpec)[0] || '默认规格'} / x{quantity}
            </span>
            <ChevronRight className="w-4 h-4 ml-1" />
          </span>
        </div>

        {/* Service Guarantee Card */}
        <div className="bg-white rounded-2xl p-3 shadow-2xs border border-gray-100 grid grid-cols-3 gap-2 text-center text-[10px] text-gray-600 font-medium">
          <div className="flex items-center justify-center gap-1">
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
            <span>100% 正品保证</span>
          </div>
          <div className="flex items-center justify-center gap-1">
            <Truck className="w-3.5 h-3.5 text-blue-600" />
            <span>企采内网开票</span>
          </div>
          <div className="flex items-center justify-center gap-1">
            <CheckCircle2 className="w-3.5 h-3.5 text-orange-600" />
            <span>福利卡无损扣减</span>
          </div>
        </div>

        {/* Product Details Description */}
        <div className="bg-white rounded-3xl p-4 shadow-2xs border border-gray-100 space-y-2 text-xs">
          <h3 className="font-bold text-gray-900 border-l-2 border-[var(--sw-brand)] pl-2">图文详情与企采说明</h3>
          <p className="text-gray-600 leading-relaxed">{product.description || '主打团商城为企业员工提供一站式福利兑换服务。'}</p>

          {product.parameters && (
            <div className="bg-gray-50 rounded-2xl p-3 space-y-1.5 text-xs text-gray-700 mt-2">
              {Object.entries(product.parameters).map(([k, v]) => (
                <div key={k} className="flex justify-between">
                  <span className="text-gray-400">{k}</span>
                  <span className="font-bold text-gray-800">{v}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Material 3 Spec Bottom Sheet */}
      {showSpecBottomSheet && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-end justify-center animate-in fade-in duration-200">
          <div className="bg-white rounded-t-3xl max-w-[430px] w-full p-4 space-y-4 shadow-2xl border-t border-gray-200 animate-in slide-in-from-bottom duration-300">
            <div className="w-12 h-1.5 bg-gray-300 rounded-full mx-auto" />

            <div className="flex items-center justify-between border-b border-gray-100 pb-2">
              <h3 className="font-bold text-sm text-gray-900">选择产品规格</h3>
              <button onClick={() => setShowSpecBottomSheet(false)} className="p-1 text-gray-400">
                <X className="w-5 h-5" />
              </button>
            </div>

            {product.specOptions &&
              Object.entries(product.specOptions).map(([specKey, specValues]) => (
                <div key={specKey} className="space-y-1.5">
                  <label className="text-xs font-bold text-gray-700">{specKey}</label>
                  <div className="flex items-center gap-2 flex-wrap">
                    {specValues.map((val) => (
                      <button
                        key={val}
                        onClick={() => setSelectedSpec((prev) => ({ ...prev, [specKey]: val }))}
                        className={`px-3 py-1.5 rounded-xl text-xs font-bold border transition-colors cursor-pointer ${
                          selectedSpec[specKey] === val || (!selectedSpec[specKey] && specValues[0] === val) ? 'border-[var(--sw-brand)] bg-blue-50 text-[var(--sw-brand)]' : 'border-gray-200 text-gray-700 bg-gray-50'
                        }`}
                      >
                        {val}
                      </button>
                    ))}
                  </div>
                </div>
              ))}

            <div className="flex items-center justify-between pt-2 border-t border-gray-100">
              <span className="text-xs font-bold text-gray-700">兑换数量</span>
              <div className="flex items-center border border-gray-200 rounded-xl overflow-hidden">
                <button onClick={() => setQuantity(Math.max(1, quantity - 1))} className="px-3 py-1 bg-gray-100 font-bold text-gray-700">
                  -
                </button>
                <span className="px-4 py-1 font-mono font-bold">{quantity}</span>
                <button onClick={() => setQuantity(quantity + 1)} className="px-3 py-1 bg-gray-100 font-bold text-gray-700">
                  +
                </button>
              </div>
            </div>

            <button onClick={() => setShowSpecBottomSheet(false)} className="w-full bg-[var(--sw-brand)] hover:bg-blue-700 text-white font-bold text-xs py-3 rounded-2xl shadow-md cursor-pointer">
              确定规格配置
            </button>
          </div>
        </div>
      )}

      {/* Fixed Bottom Action Bar */}
      <div className="fixed bottom-12 left-0 right-0 max-w-[430px] mx-auto bg-white border-t border-gray-200 p-2 z-40 flex items-center gap-2 shadow-2xl">
        <button onClick={() => triggerPendingFeature('Android 在线客服系统', '调起内置 WebRTC / 客服即时通讯通道。')} className="p-2 text-gray-500 hover:text-gray-800 text-[10px] flex flex-col items-center cursor-pointer">
          <Headphones className="w-4 h-4" />
          <span>客服</span>
        </button>

        <button onClick={() => setAndroidPage('checkout')} className="p-2 text-gray-500 hover:text-gray-800 text-[10px] flex flex-col items-center relative cursor-pointer">
          <ShoppingCart className="w-4 h-4" />
          <span>购物车</span>
          {cartCount > 0 && <span className="absolute top-0 right-1 bg-[#E5484D] text-white text-[9px] font-bold w-3.5 h-3.5 rounded-full flex items-center justify-center">{cartCount}</span>}
        </button>

        <button onClick={() => addToCart(product, quantity, selectedSpec)} className="flex-1 bg-[var(--sw-brand-light)] text-[var(--sw-brand)] font-bold text-xs py-2.5 rounded-2xl cursor-pointer">
          加购物车
        </button>

        <button onClick={handleBuyNow} className="flex-1 bg-gradient-to-r from-[var(--sw-brand)] to-[var(--sw-brand-dark)] text-white font-bold text-xs py-2.5 rounded-2xl shadow-md cursor-pointer">
          福利卡直接兑换
        </button>
      </div>

      <AndroidBottomNav />
    </div>
  );
};
