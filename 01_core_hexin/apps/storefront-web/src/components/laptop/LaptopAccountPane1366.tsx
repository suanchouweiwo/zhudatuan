import React from 'react';
import { MemberAccountSettings } from '../MemberAccountSettings';
import { ArrowRight, Award, CheckCircle2, Clock, CreditCard, FileText, Gift, ShieldCheck, ShoppingCart, Truck } from 'lucide-react';
import { useMall, type LaptopPage } from '../../context/MallContext';

export const LaptopAccountPane1366: React.FC<{
  onSelectTab: (tab: LaptopPage) => void;
}> = ({ onSelectTab }) => {
  const { user, triggerPendingFeature } = useMall();
  return (
    <>
      {/* 右侧：员工福利账户与操作中心 (宽度 240px) */}
      <div className="sw-web-account-sidebar w-[240px] flex-shrink-0 space-y-2.5">
        {/* 员工账户与余额卡 */}
        <div className="bg-white border border-gray-200 rounded-lg p-3 shadow-2xs">
          <div className="flex items-center gap-2.5 pb-2.5 border-b border-gray-100">
            <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-[var(--sw-brand-dark)] to-[var(--sw-brand)] text-white flex items-center justify-center font-bold text-sm shadow-2xs">{user.name[0]}</div>
            <div className="min-w-0 flex-1">
              <div className="font-extrabold text-xs text-gray-900 truncate">{user.name}</div>
              <div className="text-[10px] text-gray-500 truncate">{user.department}</div>
              {user.identityCode && <div className="text-[9px] text-[var(--sw-brand)] font-bold mt-0.5">会员身份码：{user.identityCode}</div>}
              <MemberAccountSettings />
            </div>
          </div>

          {/* 福利卡余额明细 */}
          <div className="mt-2.5 space-y-2">
            <div className="bg-blue-50/80 border border-blue-200/80 rounded-md p-2">
              <div className="flex items-center justify-between text-[10px] text-gray-500">
                <span className="flex items-center gap-1">
                  <CreditCard className="w-3 h-3 text-[var(--sw-brand)]" />
                  <span>福利卡可用余额</span>
                </span>
                <span className="text-[9px] bg-blue-600 text-white font-bold px-1 rounded">通用抵扣</span>
              </div>
              <div className="text-base font-black text-[var(--sw-brand-dark)] mt-0.5">¥{user.welfareBalance.toFixed(2)}</div>
            </div>

            <div className="bg-emerald-50/80 border border-emerald-200/80 rounded-md p-2">
              <div className="flex items-center justify-between text-[10px] text-gray-500">
                <span className="flex items-center gap-1">
                  <Gift className="w-3 h-3 text-emerald-600" />
                  <span>餐卡可用余额</span>
                </span>
                <span className="text-[9px] bg-emerald-600 text-white font-bold px-1 rounded">生鲜/园区餐饮</span>
              </div>
              <div className="text-base font-black text-emerald-700 mt-0.5">¥{user.mealBalance.toFixed(2)}</div>
            </div>
          </div>

          {/* 快捷跳转入口 */}
          <div className="grid grid-cols-2 gap-1.5 mt-2.5 pt-2 border-t border-gray-100 text-[11px]">
            <button
              onClick={() => triggerPendingFeature('卡券包', '查询您的已领福利券与纸质卡券密码')}
              className="p-1.5 bg-gray-50 hover:bg-blue-50 text-gray-700 hover:text-[var(--sw-brand)] rounded text-center font-bold transition-colors cursor-pointer"
            >
              我的卡券包 (3)
            </button>
            <button
              onClick={() => triggerPendingFeature('账户明细', '查询福利卡与餐卡扣减消费流水记录')}
              className="p-1.5 bg-gray-50 hover:bg-blue-50 text-gray-700 hover:text-[var(--sw-brand)] rounded text-center font-bold transition-colors cursor-pointer"
            >
              账户流水
            </button>
          </div>
        </div>

        {/* 订单进度状态指示卡 */}
        <div className="bg-white border border-gray-200 rounded-lg p-3 shadow-2xs">
          <div className="flex items-center justify-between mb-2 text-xs font-bold text-gray-800">
            <span>我的订单状态</span>
            <button onClick={() => onSelectTab('orders')} className="text-[10px] text-[var(--sw-brand)] hover:underline cursor-pointer">
              全部订单 &gt;
            </button>
          </div>

          <div className="grid grid-cols-3 gap-1 text-center">
            <div onClick={() => onSelectTab('orders')} className="p-1.5 bg-gray-50 hover:bg-blue-50 rounded cursor-pointer transition-colors">
              <div className="text-xs font-black text-[#E5484D]">2</div>
              <div className="text-[10px] text-gray-500">待付款</div>
            </div>
            <div onClick={() => onSelectTab('orders')} className="p-1.5 bg-gray-50 hover:bg-blue-50 rounded cursor-pointer transition-colors">
              <div className="text-xs font-black text-[var(--sw-brand)]">1</div>
              <div className="text-[10px] text-gray-500">待发货</div>
            </div>
            <div onClick={() => onSelectTab('orders')} className="p-1.5 bg-gray-50 hover:bg-blue-50 rounded cursor-pointer transition-colors">
              <div className="text-xs font-black text-emerald-600">3</div>
              <div className="text-[10px] text-gray-500">待收货</div>
            </div>
          </div>
        </div>

        {/* 企业合规采购承诺 */}
        <div className="bg-gradient-to-br from-gray-800 to-gray-900 text-white rounded-lg p-3 text-xs shadow-2xs space-y-2">
          <div className="font-extrabold text-yellow-400 flex items-center gap-1 text-[11px]">
            <ShieldCheck className="w-4 h-4" />
            <span>企业采购合规保障</span>
          </div>
          <p className="text-[10px] text-gray-300 leading-relaxed">全场商品均来自京东供应链及集团自营仓，支持自动对公打款开具增值税专用发票。</p>
          <div className="text-[9px] text-gray-400 pt-1 border-t border-gray-700">技术服务：雍彻科技（SGSYEN TECH）</div>
        </div>
      </div>
    </>
  );
};
