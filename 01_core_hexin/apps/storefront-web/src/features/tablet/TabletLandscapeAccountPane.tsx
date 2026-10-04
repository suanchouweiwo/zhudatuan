import React from 'react';
import { ArrowRight, CheckCircle, Clock, CreditCard, ShoppingCart, Truck, Utensils } from 'lucide-react';
import { useMall } from '../../context/MallContext';

export const TabletLandscapeAccountPane: React.FC = () => {
  const { user, setTabletPage, cart, cartCount, triggerPendingFeature } = useMall();
  const cartTotal = cart.reduce((sum, item) => sum + item.product.priceMall * item.quantity, 0);
  return (
    <>
      {/* RIGHT PANE: Employee Info, Balances, Orders, Cart Summary (~280px) */}
      <div className="w-72 bg-white border-l border-gray-200 p-3.5 flex flex-col justify-between overflow-y-auto shrink-0 space-y-4 shadow-2xs">
        {/* User Card */}
        <div className="bg-gradient-to-br from-[var(--sw-brand-dark)] to-[var(--sw-brand)] text-white rounded-2xl p-3.5 shadow-sm space-y-2">
          <div className="flex items-center gap-3">
            {user.avatar ? (
              <img src={user.avatar} alt={user.name} className="w-11 h-11 rounded-2xl object-cover border-2 border-white/80 flex-shrink-0" />
            ) : (
              <div className="w-11 h-11 rounded-2xl bg-white/20 text-white flex items-center justify-center font-black border-2 border-white/80 flex-shrink-0">{user.name.slice(0, 1)}</div>
            )}
            <div className="overflow-hidden space-y-0.5">
              <div className="flex items-center gap-1.5">
                <span className="font-black text-sm">{user.name}</span>
                <span className="bg-amber-400 text-gray-900 text-[8px] font-extrabold px-1.5 py-0.2 rounded">{user.jobTitle}</span>
              </div>
              <div className="text-[10px] text-blue-100 truncate">{user.enterpriseName}</div>
              {user.identityCode && <div className="text-[10px] font-mono text-blue-100">会员身份码：{user.identityCode}</div>}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 pt-2 border-t border-white/20">
            <div onClick={() => triggerPendingFeature('平板福利卡充值与扣费记录', '调起福利卡账户详情')} className="bg-white/10 hover:bg-white/20 p-2 rounded-xl cursor-pointer">
              <div className="text-[9px] text-blue-200 flex items-center gap-1">
                <CreditCard className="w-3 h-3 text-yellow-300" />
                <span>福利卡余额</span>
              </div>
              <div className="text-sm font-black font-mono text-yellow-300 mt-0.5">¥{user.welfareBalance.toFixed(0)}</div>
            </div>

            <div onClick={() => triggerPendingFeature('平板餐卡记录', '调起餐卡详情')} className="bg-white/10 hover:bg-white/20 p-2 rounded-xl cursor-pointer">
              <div className="text-[9px] text-blue-200 flex items-center gap-1">
                <Utensils className="w-3 h-3 text-amber-300" />
                <span>餐卡余额</span>
              </div>
              <div className="text-sm font-black font-mono text-amber-300 mt-0.5">¥{user.mealBalance.toFixed(0)}</div>
            </div>
          </div>
        </div>

        {/* Quick Orders Status */}
        <div className="bg-gray-50 rounded-2xl p-3 border border-gray-100 space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-bold text-gray-900">企采订单流程</span>
            <button onClick={() => setTabletPage('orders')} className="text-[10px] text-[var(--sw-brand)] hover:underline font-bold">
              全部订单 &gt;
            </button>
          </div>

          <div className="grid grid-cols-3 gap-1 text-center text-[10px]">
            <div onClick={() => setTabletPage('orders')} className="p-1.5 bg-white rounded-xl border border-gray-200 cursor-pointer hover:bg-blue-50">
              <Clock className="w-4 h-4 text-blue-600 mx-auto" />
              <span className="text-gray-600 mt-1 block">待付款 (1)</span>
            </div>
            <div onClick={() => setTabletPage('orders')} className="p-1.5 bg-white rounded-xl border border-gray-200 cursor-pointer hover:bg-blue-50">
              <Truck className="w-4 h-4 text-amber-600 mx-auto" />
              <span className="text-gray-600 mt-1 block">待发货 (2)</span>
            </div>
            <div onClick={() => setTabletPage('orders')} className="p-1.5 bg-white rounded-xl border border-gray-200 cursor-pointer hover:bg-blue-50">
              <CheckCircle className="w-4 h-4 text-emerald-600 mx-auto" />
              <span className="text-gray-600 mt-1 block">已完成</span>
            </div>
          </div>
        </div>

        {/* Persistent Cart Summary List */}
        <div className="flex-1 flex flex-col justify-between bg-white rounded-2xl border border-gray-200 p-3 space-y-2">
          <div className="flex items-center justify-between border-b border-gray-100 pb-2">
            <span className="text-xs font-bold text-gray-900 flex items-center gap-1.5">
              <ShoppingCart className="w-4 h-4 text-[var(--sw-brand)]" />
              <span>当前购物车</span>
            </span>
            <span className="text-[10px] text-gray-400 font-mono">共 {cartCount} 件</span>
          </div>

          {cart.length === 0 ? (
            <div className="text-center py-8 text-gray-400 text-xs">购物车暂无福利商品</div>
          ) : (
            <div className="space-y-2 max-h-[160px] overflow-y-auto pr-1">
              {cart.map((item) => (
                <div key={item.id} className="flex items-center justify-between text-xs gap-2 border-b border-gray-50 pb-1.5">
                  <div className="truncate flex-1">
                    <div className="font-bold text-gray-800 truncate">{item.product.title}</div>
                    <div className="text-[10px] text-gray-400">数量: x{item.quantity}</div>
                  </div>
                  <div className="font-mono font-bold text-[#E5484D] text-right">¥{(item.product.priceMall * item.quantity).toFixed(2)}</div>
                </div>
              ))}
            </div>
          )}

          <div className="border-t border-gray-100 pt-2 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-gray-500">应付小计</span>
              <span className="text-base font-black font-mono text-[#E5484D]">¥{cartTotal.toFixed(2)}</span>
            </div>

            <button
              onClick={() => setTabletPage('cart')}
              disabled={cartCount === 0}
              className={`w-full font-bold text-xs py-2.5 rounded-xl shadow-md transition-all flex items-center justify-center gap-1.5 cursor-pointer min-h-[44px] ${
                cartCount > 0 ? 'bg-gradient-to-r from-[var(--sw-brand)] to-[var(--sw-brand-dark)] text-white hover:opacity-95' : 'bg-gray-200 text-gray-400 cursor-not-allowed'
              }`}
            >
              <span>快速福利结算</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </>
  );
};
