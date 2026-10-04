/**
 * 主打团企业福利商城 - 快速预览 Modal 组件
 * 技术服务方：雍彻科技
 */

import React, { useState } from 'react';
import { useMall } from '../../context/MallContext';
import { X, ShoppingCart, Heart, Truck, ShieldCheck, CreditCard, Utensils } from 'lucide-react';
import { getInventoryStatus, getOutOfStockActionHint } from '../../utils/inventory';

export const QuickViewModal: React.FC = () => {
  const { quickViewProduct, setQuickViewProduct, addToCart, navigateTo, favorites, toggleFavorite } = useMall();
  const [quantity, setQuantity] = useState(1);
  const [selectedSpecs, setSelectedSpecs] = useState<Record<string, string>>({});

  if (!quickViewProduct) return null;

  const product = quickViewProduct;
  const isFav = favorites.includes(product.id);
  const inventory = getInventoryStatus(product.stock, Boolean(product.isTest));

  const handleSpecSelect = (specName: string, option: string) => {
    setSelectedSpecs((prev) => ({ ...prev, [specName]: option }));
  };

  const handleAddToCart = () => {
    if (quantity > product.stock) return;
    if (!inventory.canPurchase) return;
    addToCart(product, quantity, selectedSpecs);
    setQuickViewProduct(null);
  };

  const handleBuyNow = () => {
    if (quantity > product.stock) return;
    if (!inventory.canPurchase) return;
    addToCart(product, quantity, selectedSpecs);
    setQuickViewProduct(null);
    navigateTo('cart');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 animate-in fade-in duration-200">
      <div className="bg-white rounded-lg shadow-2xl max-w-3xl w-full max-h-[90vh] overflow-y-auto border border-gray-200 relative p-6">
        <button onClick={() => setQuickViewProduct(null)} className="absolute top-4 right-4 text-gray-400 hover:text-gray-700 bg-gray-100 p-1.5 rounded-full transition-colors cursor-pointer">
          <X className="w-5 h-5" />
        </button>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* 左侧商品大图 */}
          <div className="space-y-3">
            <div className="aspect-square bg-gray-50 rounded-md overflow-hidden border border-gray-200">
              <img src={product.images[0]} alt={product.title} className="w-full h-full object-cover" />
            </div>
            <div className="flex items-center gap-2 overflow-x-auto pb-1">
              {product.images.map((img, idx) => (
                <img key={idx} src={img} alt="" className="w-14 h-14 rounded object-cover border border-gray-200 cursor-pointer hover:border-blue-500" />
              ))}
            </div>
          </div>

          {/* 右侧核心规格与加购 */}
          <div className="flex flex-col justify-between space-y-4">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span className="bg-[var(--sw-brand)] text-white text-[11px] font-bold px-2 py-0.5 rounded">{product.supplierName}</span>
                <span className="text-xs text-gray-500 font-medium">品牌：{product.brand}</span>
              </div>

              <h2 className="text-base font-bold text-gray-900 leading-snug">{product.title}</h2>
              <p className="text-xs text-gray-500 mt-1">{product.subtitle}</p>

              {/* 价格框 */}
              <div className="bg-[var(--sw-brand-light)]/60 border border-blue-100 rounded-md p-3 mt-3">
                <div className="flex items-baseline gap-2">
                  <span className="text-xs text-[#FF7A00] font-bold">企业福利专享价</span>
                  <span className="text-2xl font-black text-[#FF7A00]">¥{product.priceWelfare.toFixed(2)}</span>
                  <span className="text-xs text-gray-400 line-through ml-2">市场价 ¥{product.priceMarket.toFixed(2)}</span>
                </div>

                <div className="flex items-center gap-2 text-xs text-blue-800 mt-2 font-medium">
                  {product.allowedAccounts.includes('welfare') && (
                    <span className="flex items-center gap-1 bg-white px-2 py-0.5 rounded border border-blue-200">
                      <CreditCard className="w-3.5 h-3.5 text-[var(--sw-brand)]" /> Welfare Balance Deductible
                    </span>
                  )}
                  {product.allowedAccounts.includes('meal') && (
                    <span className="flex items-center gap-1 bg-white px-2 py-0.5 rounded border border-orange-200 text-orange-700">
                      <Utensils className="w-3.5 h-3.5 text-[#FF7A00]" /> Meal Card Deductible
                    </span>
                  )}
                </div>
              </div>

              {/* 履约说明 */}
              <div className="text-xs text-gray-600 space-y-1.5 mt-3 pt-3 border-t border-gray-100">
                <div className="flex items-center gap-2">
                  <Truck className="w-4 h-4 text-blue-600" />
                  <span>
                    配送与履约：<strong>{product.deliverySla}</strong> ({inventory.availabilityText})
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4 text-green-600" />
                  <span>服务保障：国企采买正品验货 · 发票保障 · 专属售后</span>
                </div>
              </div>

              {/* 规格选择 */}
              {product.specs && product.specs.length > 0 && (
                <div className="mt-4 space-y-3">
                  {product.specs.map((spec) => (
                    <div key={spec.name}>
                      <div className="text-xs font-semibold text-gray-700 mb-1.5">{spec.name}：</div>
                      <div className="flex flex-wrap gap-2">
                        {spec.options.map((opt) => {
                          const isSelected = selectedSpecs[spec.name] === opt;
                          return (
                            <button
                              key={opt}
                              onClick={() => handleSpecSelect(spec.name, opt)}
                              className={`px-3 py-1 text-xs rounded border transition-colors cursor-pointer ${isSelected ? 'border-[var(--sw-brand)] bg-blue-50 text-[var(--sw-brand)] font-bold' : 'border-gray-200 text-gray-700 hover:border-gray-300'}`}
                            >
                              {opt}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* 数量调整 */}
              <div className="mt-4 flex items-center gap-3">
                <span className="text-xs font-semibold text-gray-700">购买数量：</span>
                <div className="flex items-center border border-gray-300 rounded overflow-hidden">
                  <button onClick={() => setQuantity(Math.max(1, quantity - 1))} className="px-2.5 py-1 bg-gray-100 hover:bg-gray-200 text-xs font-bold">
                    -
                  </button>
                  <span className="px-3 py-1 text-xs font-semibold">{quantity}</span>
                  <button
                    onClick={() => setQuantity(Math.min(product.stock, quantity + 1))}
                    disabled={quantity >= product.stock}
                    className={`px-2.5 py-1 bg-gray-100 text-xs font-bold ${quantity >= product.stock ? 'text-gray-300 cursor-not-allowed' : 'hover:bg-gray-200'}`}
                  >
                    +
                  </button>
                </div>
              </div>
            </div>

            {/* 底部按钮组 */}
            <div className="flex items-center gap-3 pt-3 border-t border-gray-100">
              <button
                onClick={handleAddToCart}
                disabled={!inventory.canPurchase}
                className={`flex-1 border border-blue-200 font-bold py-2.5 rounded text-xs flex items-center justify-center gap-1.5 transition-colors ${
                  inventory.canPurchase ? 'bg-blue-50 hover:bg-blue-100 text-[var(--sw-brand)] cursor-pointer' : 'bg-gray-100 text-gray-400 cursor-not-allowed'
                }`}
              >
                <ShoppingCart className="w-4 h-4" />
                {inventory.canPurchase ? '加入购物车' : inventory.actionButtonStateText}
              </button>
              <button
                onClick={handleBuyNow}
                disabled={!inventory.canPurchase}
                className={`flex-1 font-bold py-2.5 rounded text-xs transition-colors ${inventory.canPurchase ? 'bg-[var(--sw-brand)] hover:bg-blue-700 text-white cursor-pointer' : 'bg-gray-300 text-gray-600 cursor-not-allowed'}`}
              >
                {inventory.canPurchase ? '立即兑换/购买' : inventory.actionButtonStateText}
              </button>
              <button onClick={() => toggleFavorite(product.id)} className={`p-2.5 rounded border transition-colors cursor-pointer ${isFav ? 'bg-red-50 border-red-200 text-red-500' : 'border-gray-200 text-gray-500 hover:bg-gray-50'}`}>
                <Heart className="w-4 h-4 fill-current" />
              </button>
            </div>

            {(quantity > product.stock || !inventory.canPurchase) && <div className="text-[11px] text-red-600 mt-2">{product.isTest ? inventory.actionButtonStateText : getOutOfStockActionHint(1)}</div>}
          </div>
        </div>
      </div>
    </div>
  );
};
