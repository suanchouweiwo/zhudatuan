import React from 'react';
import { ArrowRight, Award, CheckCircle2, Clock, CreditCard, FileText, Gift, ShieldCheck, ShoppingCart, Truck } from 'lucide-react';
import { useMall, type LaptopPage } from '../../context/MallContext';

export const LaptopAccountPane1440: React.FC<{
  onSelectTab: (tab: LaptopPage) => void;
}> = ({ onSelectTab }) => {
  const { user, triggerPendingFeature } = useMall();
  return (
    <>
      {/* 右侧：员工福利账户与近况流 (宽度 250px) */}
      <div className="sw-web-account-sidebar w-[250px] flex-shrink-0 space-y-3">
        {/* 员工信息卡 */}
        <div className="bg-white border border-gray-200 rounded-lg p-3.5 shadow-2xs">
          <div className="flex items-center gap-3 pb-3 border-b border-gray-100">
            <div className="w-11 h-11 rounded-full bg-gradient-to-tr from-[var(--sw-brand-dark)] to-[var(--sw-brand)] text-white flex items-center justify-center font-bold text-base shadow-2xs">{user.name[0]}</div>
            <div className="min-w-0 flex-1">
              <div className="font-extrabold text-xs text-gray-900 truncate">{user.name}</div>
              <div className="text-[11px] text-gray-500 truncate">{user.department}</div>
              {user.identityCode && <div className="text-[10px] text-[var(--sw-brand)] font-bold mt-0.5">会员身份码：{user.identityCode}</div>}
            </div>
          </div>

          {/* 账户余额卡片 */}
          <div className="mt-3 space-y-2">
            <div className="bg-blue-50/80 border border-blue-200/80 rounded-md p-2.5">
              <div className="flex items-center justify-between text-xs text-gray-500">
                <span className="flex items-center gap-1">
                  <CreditCard className="w-3.5 h-3.5 text-[var(--sw-brand)]" />
                  <span>福利卡可用余额</span>
                </span>
                <span className="text-[9px] bg-blue-600 text-white font-bold px-1 rounded">通用扣减</span>
              </div>
              <div className="text-lg font-black text-[var(--sw-brand-dark)] mt-1">¥{user.welfareBalance.toFixed(2)}</div>
            </div>

            <div className="bg-emerald-50/80 border border-emerald-200/80 rounded-md p-2.5">
              <div className="flex items-center justify-between text-xs text-gray-500">
                <span className="flex items-center gap-1">
                  <Gift className="w-3.5 h-3.5 text-emerald-600" />
                  <span>餐卡可用余额</span>
                </span>
                <span className="text-[9px] bg-emerald-600 text-white font-bold px-1 rounded">生鲜/园区</span>
              </div>
              <div className="text-lg font-black text-emerald-700 mt-1">¥{user.mealBalance.toFixed(2)}</div>
            </div>
          </div>

          {/* 快捷按钮 */}
          <div className="grid grid-cols-2 gap-1.5 mt-3 pt-2.5 border-t border-gray-100 text-xs">
            <button
              onClick={() => triggerPendingFeature('卡券包', '查询您的已领福利券与纸质卡券密码')}
              className="p-1.5 bg-gray-50 hover:bg-blue-50 text-gray-700 hover:text-[var(--sw-brand)] rounded font-bold transition-colors cursor-pointer text-center"
            >
              我的卡券包 (3)
            </button>
            <button
              onClick={() => triggerPendingFeature('流水明细', '查看福利账户实时扣款与变动记录')}
              className="p-1.5 bg-gray-50 hover:bg-blue-50 text-gray-700 hover:text-[var(--sw-brand)] rounded font-bold transition-colors cursor-pointer text-center"
            >
              账户流水
            </button>
          </div>
        </div>

        {/* 订单动态卡片 */}
        <div className="bg-white border border-gray-200 rounded-lg p-3.5 shadow-2xs">
          <div className="flex items-center justify-between mb-2 text-xs font-bold text-gray-800">
            <span>最近订单追踪</span>
            <button onClick={() => onSelectTab('orders')} className="text-[10px] text-[var(--sw-brand)] hover:underline cursor-pointer">
              订单中心 &gt;
            </button>
          </div>

          <div className="bg-gray-50 rounded-md p-2 border border-gray-100 text-xs space-y-1">
            <div className="flex items-center justify-between text-[11px]">
              <span className="font-bold text-gray-700">NO.20260722881</span>
              <span className="text-emerald-600 font-bold text-[10px]">运输中</span>
            </div>
            <div className="text-[10px] text-gray-500 truncate">戴尔27寸4K专业显示器 x1 ...</div>
            <div className="text-[9px] text-gray-400">京东快递 · 预估明日14:00送达</div>
          </div>
        </div>
      </div>
    </>
  );
};
