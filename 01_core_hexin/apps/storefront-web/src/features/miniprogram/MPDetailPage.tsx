import React, { useState } from 'react';
import { useMall } from '../../context/MallContext';
import { WeChatCapsule } from '../../components/mobile/WeChatCapsule';
import { InstantCartAddButton } from '../../components/mobile/InstantCartAddButton';
import { preloadMiniProgramPage } from '../../components/mobile/miniProgramPageLoaders';
import { Share2, Headphones, ShoppingCart, ShieldCheck, Truck, CheckCircle2, ChevronRight, Heart, Store, CreditCard } from 'lucide-react';

export const MPDetailPage: React.FC = () => {
  const { mobileProductId, setMpPage, addToCart, cartCount, prepareCart, triggerPendingFeature, presentationProducts: MOCK_PRODUCTS } = useMall();
  const [selectedImageIndex, setSelectedImageIndex] = useState(0);
  const [selectedSpec, setSelectedSpec] = useState<Record<string, string>>({});
  const [quantity, setQuantity] = useState(1);
  const [isFav, setIsFav] = useState(false);

  const product = MOCK_PRODUCTS.find((p) => p.id === mobileProductId) || MOCK_PRODUCTS[0];

  if (!product) {
    return (
      <div className="flex min-h-full flex-col bg-[#F5F7FA] font-sans text-gray-800">
        <WeChatCapsule title="企业福利" showBack={true} onBack={() => setMpPage('home')} />
        <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
          <div className="h-12 w-12 animate-pulse rounded-2xl bg-blue-100" />
          <h1 className="mt-4 text-sm font-bold text-gray-800">企业福利商品正在同步</h1>
          <p className="mt-1 text-xs leading-5 text-gray-500">页面会保留当前位置，网络恢复后商品将自动出现。</p>
          <button type="button" onClick={() => setMpPage('home')} className="mt-5 min-h-11 touch-manipulation rounded-xl bg-[var(--sw-brand)] px-6 text-xs font-bold text-white active:opacity-70">
            返回首页
          </button>
        </div>
      </div>
    );
  }

  const images = [product.imageUrl, ...(product.gallery || [])];

  const handleBuyNow = () => {
    if (addToCart(product, quantity, selectedSpec)) setMpPage('cart');
  };

  return (
    <div className="bg-[#F5F7FA] min-h-full flex flex-col font-sans text-gray-800 pb-16">
      <WeChatCapsule title="商品详情" showBack={true} onBack={() => setMpPage('home')} />

      {/* Main Image Gallery */}
      <div className="relative bg-white aspect-square w-full">
        <img src={images[selectedImageIndex] || product.imageUrl} alt={product.title} width={640} height={640} decoding="async" fetchPriority="high" className="w-full h-full object-cover" />

        {/* Floating image index badge */}
        <div className="absolute bottom-3 right-3 bg-black/60 text-white text-[10px] font-bold px-2 py-0.5 rounded-full backdrop-blur-xs">
          {selectedImageIndex + 1} / {images.length}
        </div>

        {/* Floating Share button */}
        <button
          type="button"
          aria-label={`分享商品：${product.title}`}
          onClick={() => triggerPendingFeature('微信小程序页面卡片与朋友圈分享', '调起微信原生 ShareSheet 分享商品口令或海报卡片。')}
          className="absolute top-3 right-3 w-8 h-8 rounded-full bg-black/40 text-white flex items-center justify-center backdrop-blur-xs hover:bg-black/60 cursor-pointer"
        >
          <Share2 className="w-4 h-4" />
        </button>
      </div>

      {/* Product Price & Enterprise Subsidy Banner */}
      <div className="bg-gradient-to-r from-[var(--sw-brand-dark)] to-[var(--sw-brand)] text-white p-3.5 flex items-center justify-between shadow-xs">
        <div>
          <div className="flex items-baseline gap-1.5 font-mono">
            <span className="text-xs font-bold">福利特惠价 ¥</span>
            <span className="text-2xl font-black">{product.price}</span>
            <span className="text-xs text-blue-200 line-through">¥{product.originalPrice}</span>
          </div>
          <div className="text-[10px] text-yellow-300 font-semibold flex items-center gap-1 mt-0.5">
            <CreditCard className="w-3 h-3" />
            <span>中国建筑集团协议内购 · 支持福利卡/餐卡抵扣</span>
          </div>
        </div>

        <div className="bg-yellow-400 text-gray-900 px-2.5 py-1 rounded-lg text-center flex-shrink-0">
          <div className="text-[9px] font-bold">企采内购补贴</div>
          <div className="text-xs font-black">立省 ¥{product.enterpriseSubsidyAmount}</div>
        </div>
      </div>

      {/* Product Title & Basic Info */}
      <div className="bg-white p-3.5 space-y-2 border-b border-gray-200/80">
        <div className="flex items-start justify-between gap-2">
          <h1 className="text-sm font-bold text-gray-900 leading-snug">{product.title}</h1>
          <button
            type="button"
            aria-label={isFav ? `取消收藏：${product.title}` : `收藏：${product.title}`}
            aria-pressed={isFav}
            onClick={() => setIsFav(!isFav)}
            className="p-1.5 text-gray-400 hover:text-red-500 transition-colors flex-shrink-0 cursor-pointer"
          >
            <Heart className={`w-5 h-5 ${isFav ? 'fill-red-500 text-red-500' : ''}`} />
          </button>
        </div>

        <p className="text-xs text-gray-500">{product.subtitle}</p>

        <div className="flex items-center gap-2 pt-1 text-[10px]">
          <span className="bg-blue-50 text-[var(--sw-brand)] font-bold px-2 py-0.5 rounded border border-blue-100">
            {product.itemType === 'virtual_coupon' ? '虚拟电子码' : product.itemType === 'nearby_store' ? '到店扫码核销' : '实物包邮配送'}
          </span>
          <span className="text-gray-400">品牌: {product.brand || '主打团 精选'}</span>
          <span className="text-gray-400">库存: {product.stockCount} 件</span>
        </div>
      </div>

      {/* Guarantee Tags */}
      <div className="bg-white px-3.5 py-2.5 mt-2 border-y border-gray-200/80 flex items-center justify-between text-[11px] text-gray-600">
        <div className="flex items-center gap-1">
          <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
          <span>正品保障</span>
        </div>
        <div className="flex items-center gap-1">
          <Truck className="w-3.5 h-3.5 text-blue-600" />
          <span>企采内网开票</span>
        </div>
        <div className="flex items-center gap-1">
          <CheckCircle2 className="w-3.5 h-3.5 text-orange-600" />
          <span>支持卡包余额抵扣</span>
        </div>
      </div>

      {/* Specs Picker */}
      {product.specOptions && Object.keys(product.specOptions).length > 0 && (
        <div className="bg-white p-3.5 mt-2 border-y border-gray-200/80 space-y-3">
          <div className="text-xs font-bold text-gray-900">商品规格选择</div>
          {Object.entries(product.specOptions).map(([specKey, specValues]) => (
            <div key={specKey} className="space-y-1.5">
              <div className="text-[11px] text-gray-500 font-medium">{specKey}:</div>
              <div className="flex items-center gap-2 flex-wrap">
                {specValues.map((val) => {
                  const isSelected = selectedSpec[specKey] === val || (!selectedSpec[specKey] && specValues[0] === val);
                  return (
                    <button
                      key={val}
                      onClick={() => setSelectedSpec((prev) => ({ ...prev, [specKey]: val }))}
                      className={`px-3 py-1 rounded-lg text-xs font-medium border transition-colors cursor-pointer ${isSelected ? 'border-[var(--sw-brand)] bg-blue-50 text-[var(--sw-brand)] font-bold' : 'border-gray-200 text-gray-700 bg-gray-50'}`}
                    >
                      {val}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}

          {/* Quantity selector */}
          <div className="flex items-center justify-between pt-2 border-t border-gray-100 text-xs">
            <span className="font-bold text-gray-700">兑换数量</span>
            <div className="flex items-center border border-gray-200 rounded-lg overflow-hidden">
              <button onClick={() => setQuantity(Math.max(1, quantity - 1))} className="px-2.5 py-1 bg-gray-50 text-gray-600 hover:bg-gray-100 font-bold">
                -
              </button>
              <span className="px-3 py-1 font-bold font-mono text-gray-800">{quantity}</span>
              <button onClick={() => setQuantity(quantity + 1)} className="px-2.5 py-1 bg-gray-50 text-gray-600 hover:bg-gray-100 font-bold">
                +
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Product Description */}
      <div className="bg-white p-3.5 mt-2 border-y border-gray-200/80 space-y-2">
        <h3 className="text-xs font-bold text-gray-900 border-l-2 border-[var(--sw-brand)] pl-2">商品企采说明与参数</h3>
        <p className="text-xs text-gray-600 leading-relaxed">{product.description || '本商品属于主打团商城企采直供商品，支持员工使用企业发放的福利卡或餐卡进行全额扣减兑换，支持在线开具企业普通发票或增值税发票。'}</p>

        {product.parameters && (
          <div className="mt-3 bg-gray-50 rounded-xl p-3 divide-y divide-gray-200/60 text-xs text-gray-700">
            {Object.entries(product.parameters).map(([k, v]) => (
              <div key={k} className="py-1.5 flex justify-between">
                <span className="text-gray-400">{k}</span>
                <span className="font-medium text-gray-800">{v}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Fixed Bottom Action Bar */}
      <div className="fixed bottom-0 left-0 right-0 max-w-[430px] mx-auto bg-white border-t border-gray-200/90 p-2 z-50 flex items-center gap-2 shadow-2xl">
        <button
          onClick={() => triggerPendingFeature('微信小程序在线企业客服', '调起微信客服组件（企业微信客服接入）。')}
          className="flex flex-col items-center justify-center p-1.5 text-gray-500 hover:text-gray-800 text-[10px] cursor-pointer"
        >
          <Headphones className="w-4 h-4" />
          <span>客服</span>
        </button>

        <button
          onPointerDown={() => {
            preloadMiniProgramPage('cart');
            prepareCart();
          }}
          onClick={() => setMpPage('cart')}
          className="flex flex-col items-center justify-center p-1.5 text-gray-500 hover:text-gray-800 text-[10px] relative cursor-pointer"
        >
          <ShoppingCart className="w-4 h-4" />
          <span>购物车</span>
          {cartCount > 0 && <span className="absolute top-0 right-1 bg-[#E5484D] text-white text-[9px] font-bold w-3.5 h-3.5 rounded-full flex items-center justify-center">{cartCount}</span>}
        </button>

        <InstantCartAddButton
          ariaLabel={`加入购物车：${product.title}`}
          className="flex min-h-10 flex-1 items-center justify-center rounded-xl bg-[var(--sw-brand)] px-3 text-xs font-bold text-white shadow-[0_5px_14px_rgba(37,99,235,0.18)] disabled:bg-slate-200 disabled:text-slate-400 disabled:shadow-none"
          disabled={product.stockCount <= 0 || product.purchasable === false}
          label="加入购物车"
          listingId={product.id}
          onAdd={() => addToCart(product, quantity, selectedSpec)}
        />

        <button onClick={handleBuyNow} className="flex-1 bg-gradient-to-r from-[var(--sw-brand)] to-[var(--sw-brand-dark)] text-white font-bold text-xs py-2.5 rounded-xl shadow-md shadow-blue-500/20 transition-all cursor-pointer">
          福利卡直接兑换
        </button>
      </div>
    </div>
  );
};
