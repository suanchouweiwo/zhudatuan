import React, { useState } from 'react';
import { LaptopBreadcrumb } from './LaptopBreadcrumb';
import { useMall, LaptopPage } from '../../context/MallContext';
import { ShoppingCart, Zap, CreditCard, Gift, ShieldCheck, Truck, CheckCircle2, FileText, Star, MapPin, Minus, Plus, Building, Heart, Share2 } from 'lucide-react';
import { defaultStorefrontWebPage, type StorefrontWebSurface } from './StorefrontWebStandard';
import type { FrontendProduct } from '../../adapters/frontendData';

interface LaptopDetailPageProps {
  onSelectTab: (tab: LaptopPage) => void;
  surface?: StorefrontWebSurface;
  selectedProduct?: FrontendProduct;
}

export const LaptopDetailPage: React.FC<LaptopDetailPageProps> = ({ onSelectTab, surface = 'laptop', selectedProduct }) => {
  const { user, addToCart, showToast, presentationProducts: MOCK_PRODUCTS } = useMall();
  const homePage = defaultStorefrontWebPage(surface);

  // Selected product (default to Lenovo ThinkPad or first product)
  const product = selectedProduct ?? MOCK_PRODUCTS[0];
  const [quantity, setQuantity] = useState<number>(1);
  const [selectedSpec, setSelectedSpec] = useState<string>('i7-13700H / 32G / 1TB');
  const [activeTab, setActiveTab] = useState<'detail' | 'spec' | 'reviews' | 'aftersale'>('detail');

  const handleAddToCart = () => {
    addToCart(product, quantity);
    showToast(`已成功将 ${quantity} 件「${product.title}」加入购物车`, 'success');
  };

  const handleBuyNow = () => {
    addToCart(product, quantity);
    onSelectTab('cart');
  };

  return (
    <div className="w-full bg-[#F5F7FA] min-h-[80vh] pb-8 font-sans">
      <div className="sw-web-container max-w-[1240px] mx-auto pt-3 px-3 space-y-3">
        <LaptopBreadcrumb productTitle={product.title} onSelectTab={onSelectTab} homePage={homePage} />

        <div className="sw-web-detail-grid bg-white border border-gray-200 rounded-lg p-4 shadow-2xs grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="space-y-3">
            <div className="sw-web-detail-media w-full h-[300px] bg-gray-50 rounded-lg border border-gray-200 p-4 flex items-center justify-center relative overflow-hidden">
              <span className="absolute top-2 left-2 bg-[#E5484D] text-white text-[10px] font-black px-2 py-0.5 rounded shadow-2xs">企业特惠补贴 20%</span>
              <img src={product.image} alt={product.title} className="max-h-full max-w-full object-contain" />
            </div>

            <div className="flex items-center gap-2 overflow-x-auto pb-1">
              {[product.image, product.image, product.image].map((img, i) => (
                <div key={i} className="w-14 h-14 rounded border-2 border-[var(--sw-brand)] bg-gray-50 p-1 flex-shrink-0 cursor-pointer">
                  <img src={img} alt="thumb" className="w-full h-full object-contain" />
                </div>
              ))}
            </div>

            <div className="bg-blue-50/60 border border-blue-100 rounded-lg p-2.5 grid grid-cols-3 gap-2 text-[11px] text-gray-700 text-center">
              <div className="flex items-center justify-center gap-1">
                <CheckCircle2 className="w-3.5 h-3.5 text-[var(--sw-brand)]" />
                <span>增值税专票</span>
              </div>
              <div className="flex items-center justify-center gap-1">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
                <span>全国联保质保</span>
              </div>
              <div className="flex items-center justify-center gap-1">
                <Truck className="w-3.5 h-3.5 text-amber-600" />
                <span>京东极速送达</span>
              </div>
            </div>
          </div>

          <div className="space-y-3 flex flex-col justify-between">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="bg-[var(--sw-brand-dark)] text-white font-bold text-[10px] px-1.5 py-0.2 rounded">{product.supplierName || '京东自营'}</span>
                <span className="text-[11px] text-emerald-700 font-bold bg-emerald-50 px-1.5 py-0.2 rounded">企业福利卡通用</span>
              </div>

              <h1 className="text-base sm:text-lg font-black text-gray-900 leading-snug">{product.title}</h1>
              <p className="text-xs text-gray-500 mt-1">高性能企业办公标配，支持福利卡全额扣减与对公专票直开。</p>

              <div className="bg-gradient-to-r from-red-50 via-orange-50 to-blue-50 border border-red-200/80 rounded-lg p-3 mt-3 space-y-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-xs font-bold text-[#E5484D]">企采福利价:</span>
                  <span className="text-2xl font-black text-[#E5484D]">¥{product.welfarePrice.toFixed(2)}</span>
                  <span className="text-xs text-gray-400 line-through">官网原价 ¥{product.marketPrice.toFixed(2)}</span>
                </div>

                <div className="text-[11px] text-gray-700 flex items-center gap-3 pt-1 border-t border-red-100">
                  <span className="flex items-center gap-1">
                    <CreditCard className="w-3.5 h-3.5 text-[var(--sw-brand)]" />
                    <span>
                      福利卡余额可扣: <strong className="text-[var(--sw-brand-dark)]">¥{user.welfareBalance.toFixed(2)}</strong>
                    </span>
                  </span>
                  {product.allowMealCard && (
                    <span className="flex items-center gap-1 text-emerald-700">
                      <Gift className="w-3.5 h-3.5" />
                      <span>餐卡支持</span>
                    </span>
                  )}
                </div>
              </div>

              <div className="mt-3 space-y-2 text-xs">
                <div className="font-bold text-gray-800">选择规格配置:</div>
                <div className="flex flex-wrap gap-2">
                  {['i7-13700H / 32G / 1TB', 'i5-13500H / 16G / 512G', 'i9-13900H / 64G / 2TB'].map((spec) => (
                    <button
                      key={spec}
                      onClick={() => setSelectedSpec(spec)}
                      className={`px-3 py-1.5 rounded border text-xs font-bold transition-all cursor-pointer ${selectedSpec === spec ? 'border-[var(--sw-brand)] bg-blue-50 text-[var(--sw-brand)]' : 'border-gray-200 text-gray-700 hover:border-gray-300'}`}
                    >
                      {spec}
                    </button>
                  ))}
                </div>
              </div>

              <div className="mt-3 text-xs flex items-center gap-2 text-gray-700">
                <MapPin className="w-4 h-4 text-[var(--sw-brand)] flex-shrink-0" />
                <span>配送至：</span>
                <span className="font-bold text-gray-800">北京市东城区国家电网总部大楼 (员工专送)</span>
              </div>

              <div className="mt-3 flex items-center gap-3 text-xs">
                <span className="font-bold text-gray-800">购买数量:</span>
                <div className="flex items-center border border-gray-300 rounded overflow-hidden">
                  <button onClick={() => setQuantity(Math.max(1, quantity - 1))} className="px-2 py-1 bg-gray-100 hover:bg-gray-200 cursor-pointer">
                    <Minus className="w-3 h-3" />
                  </button>
                  <span className="px-3 font-bold text-gray-800">{quantity}</span>
                  <button onClick={() => setQuantity(quantity + 1)} className="px-2 py-1 bg-gray-100 hover:bg-gray-200 cursor-pointer">
                    <Plus className="w-3 h-3" />
                  </button>
                </div>
              </div>
            </div>

            <div className="pt-3 border-t border-gray-100 flex items-center gap-3">
              <button
                onClick={handleAddToCart}
                className="flex-1 bg-blue-50 hover:bg-blue-100 border border-[var(--sw-brand)] text-[var(--sw-brand)] font-black py-2.5 rounded-lg flex items-center justify-center gap-1.5 text-xs transition-colors cursor-pointer shadow-2xs"
              >
                <ShoppingCart className="w-4 h-4" />
                <span>加入购物车</span>
              </button>

              <button onClick={handleBuyNow} className="flex-1 bg-[var(--sw-brand)] hover:bg-blue-700 text-white font-black py-2.5 rounded-lg flex items-center justify-center gap-1.5 text-xs transition-colors cursor-pointer shadow-sm">
                <Zap className="w-4 h-4 text-yellow-300" />
                <span>福利卡全额购买</span>
              </button>
            </div>
          </div>
        </div>

        <div className="bg-white border border-gray-200 rounded-lg shadow-2xs overflow-hidden">
          <div className="flex border-b border-gray-200 bg-gray-50 text-xs font-bold text-gray-700">
            {[
              { id: 'detail', name: '商品详情' },
              { id: 'spec', name: '规格参数' },
              { id: 'reviews', name: '企采评价 (99%好评)' },
              { id: 'aftersale', name: '售后与专票规则' },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={`px-5 py-2.5 transition-colors cursor-pointer border-b-2 ${activeTab === tab.id ? 'border-[var(--sw-brand)] bg-white text-[var(--sw-brand)]' : 'border-transparent hover:text-black'}`}
              >
                {tab.name}
              </button>
            ))}
          </div>

          <div className="p-4 text-xs text-gray-700 leading-relaxed">
            {activeTab === 'detail' && (
              <div className="space-y-3">
                <p>本商品为国家电网及央国企定制采购标配产品，经过集团质量检测认证，保障办公与日常使用体验。</p>
                <div className="grid grid-cols-2 gap-3 bg-gray-50 p-3 rounded border border-gray-200">
                  <div>
                    <strong>品牌：</strong>联想/戴尔官方授权
                  </div>
                  <div>
                    <strong>质保：</strong>3年企业级现场上门服务
                  </div>
                  <div>
                    <strong>发票：</strong>开具13%增值税专用发票
                  </div>
                  <div>
                    <strong>支付：</strong>支持企业福利卡/餐卡/对公转账
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'spec' && (
              <table className="w-full border-collapse text-left border border-gray-200">
                <tbody>
                  <tr className="border-b border-gray-200 bg-gray-50">
                    <th className="p-2 w-1/4 font-bold">处理器</th>
                    <td className="p-2">Intel Core i7-13700H 标压处理器</td>
                  </tr>
                  <tr className="border-b border-gray-200">
                    <th className="p-2 font-bold">内存容量</th>
                    <td className="p-2">32GB DDR5 5200MHz 双通道</td>
                  </tr>
                  <tr className="border-b border-gray-200 bg-gray-50">
                    <th className="p-2 font-bold">存储硬盘</th>
                    <td className="p-2">1TB PCIe 4.0 高速固态硬盘</td>
                  </tr>
                </tbody>
              </table>
            )}

            {activeTab === 'reviews' && (
              <div className="space-y-2">
                <div className="p-2 bg-blue-50/50 rounded border border-blue-100">
                  <div className="font-bold text-gray-800">李** (华北分部)：</div>
                  <p className="text-gray-600 mt-0.5">直接用福利卡额度下的单，第二天京东就送到了，发票自动合并上传集团财务，非常方便！</p>
                </div>
              </div>
            )}

            {activeTab === 'aftersale' && (
              <div className="space-y-1.5">
                <p>1. 支持全国7天无理由退换货（须不影响二次销售）。</p>
                <p>2. 发票在确认收货后3个工作日内自动开具电子专票。</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
