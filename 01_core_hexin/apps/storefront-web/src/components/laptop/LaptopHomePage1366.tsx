import React from 'react';
import { LaptopAccountPane1366 } from './LaptopAccountPane1366';
import { useMall, LaptopPage } from '../../context/MallContext';
import { Sparkles, CreditCard, Gift, ChevronRight, TrendingUp, ShieldCheck, Zap, Tag, Clock, ArrowRight, FileText, Truck, CheckCircle2, Building, Coffee, Ticket, Smartphone, Flame, Award } from 'lucide-react';

interface LaptopHomePage1366Props {
  onSelectTab: (tab: LaptopPage) => void;
}

export const LaptopHomePage1366: React.FC<LaptopHomePage1366Props> = ({ onSelectTab }) => {
  const { user, addToCart, triggerPendingFeature, showToast, presentationProducts: MOCK_PRODUCTS } = useMall();

  // Categories list for left sidebar
  const categories = [
    { name: '企采高频与办公设备', sub: '电脑/打印机/人体工学椅', badge: '企业专享' },
    { name: '员工米面粮油与生鲜', sub: '五常大米/鲁花花生油/三月红', badge: '餐卡可用' },
    { name: '居家家电与劳保关怀', sub: '空气净化器/除螨仪/按压壶', badge: '福利卡' },
    { name: '虚拟卡券与商超卡', sub: '京东E卡/盒马卡/沃尔玛', badge: '秒到账' },
    { name: '电影票务与生活服务', sub: '全国通兑/在线选座/水电缴费', badge: '实时核销' },
    { name: '园区咖啡与快餐便利', sub: '瑞幸/星巴克/肯德基', badge: '餐卡支持' },
  ];

  // Pick top featured products
  const hotProducts = MOCK_PRODUCTS.slice(0, 6);

  const handleAddToCart = (product: any, e: React.MouseEvent) => {
    e.stopPropagation();
    addToCart(product, 1);
    showToast(`已成功将「${product.title}」加入购物车`, 'success');
  };

  return (
    <div className="w-full bg-[#F5F7FA] pb-6 font-sans">
      <div className="max-w-[1240px] mx-auto pt-2.5 px-3">
        <div className="bg-gradient-to-r from-blue-900 via-[var(--sw-brand-dark)] to-indigo-900 text-white text-[11px] px-3 py-1 rounded-md mb-2 flex items-center justify-between shadow-2xs">
          <div className="flex items-center gap-2">
            <span className="bg-yellow-400 text-gray-900 font-bold px-1.5 py-0.2 rounded text-[10px]">1366×768 首屏紧凑版</span>
            <span className="text-blue-100 font-medium truncate max-w-[600px]">📢 国家电网员工二季度福利积分发放完成，本周下单享企业专享补差补贴与免费送货上门！</span>
          </div>
          <div className="flex items-center gap-2 text-[10px] text-yellow-300 font-bold">
            <ShieldCheck className="w-3.5 h-3.5" />
            <span>无横向滚动条 · Windows 125% 缩放完美适配</span>
          </div>
        </div>

        <div className="flex gap-2.5 items-start">
          <div className="w-[200px] flex-shrink-0 bg-white border border-gray-200 rounded-lg shadow-2xs overflow-hidden">
            <div className="bg-[var(--sw-brand-dark)] text-white px-3 py-2 font-bold text-xs flex items-center justify-between">
              <span>商品全部分类</span>
              <span className="text-[10px] text-blue-200">B2B2C 密集</span>
            </div>

            <div className="divide-y divide-gray-100 text-xs">
              {categories.map((cat, idx) => (
                <div key={idx} onClick={() => onSelectTab('category')} className="p-2 hover:bg-blue-50/70 transition-colors cursor-pointer group flex items-center justify-between">
                  <div className="min-w-0 pr-1">
                    <div className="font-bold text-gray-800 group-hover:text-[var(--sw-brand)] truncate text-[11px] leading-tight">{cat.name}</div>
                    <div className="text-[10px] text-gray-400 truncate mt-0.5">{cat.sub}</div>
                  </div>
                  <span className="text-[9px] bg-blue-50 text-[var(--sw-brand)] border border-blue-200 font-medium px-1 rounded flex-shrink-0">{cat.badge}</span>
                </div>
              ))}
            </div>

            <div className="p-2 bg-gradient-to-br from-blue-50 to-indigo-50 border-t border-blue-100">
              <div onClick={() => onSelectTab('category')} className="bg-[var(--sw-brand)] hover:bg-blue-700 text-white rounded p-2 cursor-pointer transition-colors text-center shadow-2xs">
                <div className="text-[11px] font-black flex items-center justify-center gap-1">
                  <Zap className="w-3.5 h-3.5 text-yellow-300" />
                  <span>企业福利专区入口</span>
                </div>
                <div className="text-[9px] text-blue-100 mt-0.5">全套福利卡/餐卡全额抵扣</div>
              </div>
            </div>
          </div>

          <div className="flex-1 min-w-0 space-y-2.5">
            <div className="relative rounded-lg overflow-hidden bg-gradient-to-r from-[var(--sw-brand-dark)] via-[var(--sw-brand)] to-indigo-800 text-white p-4 h-[220px] flex flex-col justify-between shadow-xs border border-blue-900">
              <div className="absolute top-0 right-0 opacity-15 pointer-events-none transform translate-x-8 -translate-y-6">
                <Sparkles className="w-48 h-48 text-yellow-300" />
              </div>

              <div className="relative z-10">
                <div className="inline-flex items-center gap-1.5 bg-yellow-400/90 text-gray-900 font-black text-[10px] px-2 py-0.5 rounded-full mb-1.5 shadow-2xs">
                  <Flame className="w-3 h-3 text-red-600 fill-red-600" />
                  <span>国家电网员工专享 · 二季度劳保关怀礼包</span>
                </div>

                <h1 className="text-xl sm:text-2xl font-black tracking-tight leading-tight text-white drop-shadow-xs">主打团专场 · 积分无门槛抵扣</h1>
                <p className="text-xs text-blue-100 mt-1 max-w-[480px]">包含办公设备、粮油生鲜、防暑降温与商超卡券，支持福利卡/餐卡联合结算，专票直开！</p>
              </div>

              <div className="relative z-10 flex items-center justify-between border-t border-white/20 pt-2.5">
                <div className="flex items-center gap-3 text-[11px] text-blue-100">
                  <span className="flex items-center gap-1">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                    <span>福利卡全额抵扣</span>
                  </span>
                  <span className="flex items-center gap-1">
                    <Truck className="w-3.5 h-3.5 text-yellow-300" />
                    <span>京东/自营极速送达</span>
                  </span>
                  <span className="flex items-center gap-1">
                    <FileText className="w-3.5 h-3.5 text-cyan-300" />
                    <span>自动打通企业报销</span>
                  </span>
                </div>

                <button onClick={() => onSelectTab('category')} className="bg-yellow-400 hover:bg-yellow-300 text-gray-900 font-extrabold px-3 py-1.5 rounded-md text-xs transition-all cursor-pointer flex items-center gap-1 shadow-sm">
                  <span>立即选购专享福利</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            <div className="bg-white border border-gray-200 rounded-lg p-2 shadow-2xs grid grid-cols-4 sm:grid-cols-8 gap-1.5 text-center text-xs">
              {[
                { icon: Coffee, label: '园区咖啡', color: 'bg-amber-100 text-amber-700' },
                { icon: Smartphone, label: '企采数码', color: 'bg-blue-100 text-blue-700' },
                { icon: Ticket, label: '电影通兑', color: 'bg-purple-100 text-purple-700' },
                { icon: Gift, label: '米面粮油', color: 'bg-emerald-100 text-emerald-700' },
                { icon: Tag, label: '虚拟卡券', color: 'bg-rose-100 text-rose-700' },
                { icon: Building, label: '生活缴费', color: 'bg-cyan-100 text-cyan-700' },
                { icon: Award, label: '劳保用品', color: 'bg-indigo-100 text-indigo-700' },
                { icon: Zap, label: '秒杀特惠', color: 'bg-red-100 text-red-700' },
              ].map((item, i) => (
                <div key={i} onClick={() => onSelectTab('category')} className="p-1.5 hover:bg-blue-50/60 rounded-md transition-colors cursor-pointer group flex flex-col items-center">
                  <div className={`w-7 h-7 rounded-lg ${item.color} flex items-center justify-center mb-1 group-hover:scale-110 transition-transform`}>
                    <item.icon className="w-4 h-4" />
                  </div>
                  <span className="text-[11px] font-bold text-gray-700 group-hover:text-[var(--sw-brand)] truncate w-full">{item.label}</span>
                </div>
              ))}
            </div>

            <div className="bg-white border border-gray-200 rounded-lg p-3 shadow-2xs">
              <div className="flex items-center justify-between mb-2.5 pb-2 border-b border-gray-100">
                <div className="flex items-center gap-2">
                  <div className="w-2.5 h-4 bg-[var(--sw-brand)] rounded-xs" />
                  <h2 className="font-extrabold text-sm text-gray-900 flex items-center gap-1.5">
                    <span>企业员工专享福利商品</span>
                    <span className="text-[10px] bg-[var(--sw-brand-light)] text-[var(--sw-brand)] font-bold px-1.5 py-0.2 rounded">福利卡/餐卡全额抵扣</span>
                  </h2>
                </div>
                <button onClick={() => onSelectTab('category')} className="text-xs text-[var(--sw-brand)] hover:underline font-bold flex items-center gap-0.5 cursor-pointer">
                  <span>查看全部 30+ 企采商品</span>
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>

              <div className="grid grid-cols-3 gap-2.5">
                {hotProducts.map((product) => (
                  <div
                    key={product.id}
                    onClick={() => onSelectTab('detail')}
                    className="border border-gray-200 hover:border-[var(--sw-brand)] rounded-lg p-2.5 bg-white hover:shadow-md transition-all cursor-pointer flex flex-col justify-between group relative"
                  >
                    <div className="absolute top-2 left-2 z-10 flex flex-col gap-1">
                      <span className="bg-[#E5484D] text-white text-[9px] font-bold px-1.5 py-0.2 rounded shadow-2xs">福利价</span>
                      {product.allowMealCard && <span className="bg-emerald-600 text-white text-[9px] font-bold px-1.5 py-0.2 rounded shadow-2xs">餐卡可用</span>}
                    </div>

                    <div>
                      <div className="w-full h-[120px] rounded-md overflow-hidden bg-gray-50 mb-2 flex items-center justify-center p-1">
                        <img src={product.image} alt={product.title} className="max-h-full max-w-full object-contain group-hover:scale-105 transition-transform duration-300" />
                      </div>

                      <div className="text-[10px] text-gray-400 mb-1 flex items-center gap-1">
                        <span className="bg-gray-100 text-gray-600 px-1 py-0.2 rounded font-medium">{product.supplierName || '平台自营仓'}</span>
                        <span>·</span>
                        <span className="text-emerald-600 font-medium">开票无忧</span>
                      </div>

                      <h3 className="font-bold text-xs text-gray-800 group-hover:text-[var(--sw-brand)] line-clamp-2 leading-tight min-h-[32px]">{product.title}</h3>
                    </div>

                    <div className="mt-2 pt-2 border-t border-gray-100 flex items-center justify-between">
                      <div>
                        <div className="flex items-baseline gap-1">
                          <span className="text-[10px] font-bold text-[#E5484D]">¥</span>
                          <span className="text-base font-black text-[#E5484D] leading-none">{product.welfarePrice.toFixed(2)}</span>
                        </div>
                        <div className="text-[10px] text-gray-400 line-through mt-0.5">官网价 ¥{product.marketPrice.toFixed(2)}</div>
                      </div>

                      <button
                        onClick={(e) => handleAddToCart(product, e)}
                        className="bg-[var(--sw-brand)] hover:bg-blue-700 text-white font-bold text-xs px-2.5 py-1.5 rounded transition-colors cursor-pointer flex items-center gap-1 shadow-2xs flex-shrink-0"
                      >
                        <span>加购物车</span>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <LaptopAccountPane1366 onSelectTab={onSelectTab} />
        </div>
      </div>
    </div>
  );
};
