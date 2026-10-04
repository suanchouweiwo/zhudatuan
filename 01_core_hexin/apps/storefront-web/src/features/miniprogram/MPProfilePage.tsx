import React from 'react';
import { MemberAccountSettings } from '../../components/MemberAccountSettings';
import { useMall } from '../../context/MallContext';
import { WeChatCapsule } from '../../components/mobile/WeChatCapsule';
import { CreditCard, Utensils, Clock, Truck, CheckCircle, HelpCircle, Ticket, MapPin, FileText, BellRing, Headphones, ShieldCheck, ChevronRight, Building2, Smartphone, LogOut } from 'lucide-react';
import { OrderFlowIcon } from '../../components/mobile/OrderFlowIcon';
import { matchesMobileOrderFilter, selectMobileOrderFilter, type MobileOrderFilter } from '../../components/mobile/mobileOrderFilters';
import { summarizeMobileFulfillment } from '../../components/mobile/mobileOrderFulfillment';
import { preloadMiniProgramPage } from '../../components/mobile/miniProgramPageLoaders';

export const MPProfilePage: React.FC = () => {
  const { user, currentMall, sessionStatus, logout, presentationOrders, mobileFulfillmentSimulationStage, triggerPendingFeature, setMpPage } = useMall();

  const openOrders = (statusFilter: MobileOrderFilter) => {
    preloadMiniProgramPage('orders');
    selectMobileOrderFilter(statusFilter);
    setMpPage('orders');
  };

  const orderCount = (statusFilter: MobileOrderFilter) => presentationOrders.filter((order) => (
    matchesMobileOrderFilter(order.status, statusFilter)
  )).length;
  const fulfillment = React.useMemo(
    () => summarizeMobileFulfillment(presentationOrders, mobileFulfillmentSimulationStage),
    [mobileFulfillmentSimulationStage, presentationOrders],
  );
  return (
    <div className="bg-[#F5F7FA] min-h-full flex flex-col font-sans text-gray-800 pb-16">
      <WeChatCapsule title="个人中心" />

      {/* Profile Header Header Box */}
      <div className="bg-gradient-to-b from-[var(--sw-brand-dark)] to-[var(--sw-brand)] text-white p-4 pt-2 shadow-sm space-y-3">
        {/* User Card */}
        <div className="flex items-center gap-3">
          {user.avatar ? (
            <img src={user.avatar} alt={user.name} width={56} height={56} decoding="async" className="w-14 h-14 rounded-full object-cover border-2 border-white/80 shadow-md flex-shrink-0" />
          ) : (
            <div className="w-14 h-14 rounded-full bg-white/20 text-white flex items-center justify-center text-xl font-black border-2 border-white/80 shadow-md flex-shrink-0">{user.name.slice(0, 1)}</div>
          )}
          <div className="overflow-hidden space-y-1">
            <div className="flex items-center gap-2">
              <h2 className="text-base font-black text-white">{user.name}</h2>
              <span className="bg-yellow-400 text-gray-900 text-[9px] font-bold px-1.5 py-0.2 rounded">{user.jobTitle}</span>
            </div>
            {user.identityCode && <div className="text-xs font-mono text-blue-100">会员身份码：{user.identityCode}</div>}
            <MemberAccountSettings />
            <div className="text-[11px] text-blue-100 flex items-center gap-1">
              <Building2 className="w-3 h-3 text-yellow-300" />
              <span className="truncate">{user.enterpriseName}</span>
            </div>
            <div className="text-[10px] text-emerald-200 flex items-center gap-1">
              <Smartphone className="w-3 h-3 text-emerald-300" />
              <span>登录手机号：{user.phone}</span>
            </div>
          </div>
        </div>

        {/* Welfare Balances Row inside header */}
        <div className="grid grid-cols-2 gap-2 pt-1">
          <div
            onClick={() => triggerPendingFeature('微信小程序 福利卡账单', '查看企业按月发放的福利卡明细。')}
            className="bg-white/15 backdrop-blur-xs p-2.5 rounded-xl border border-white/20 cursor-pointer active:bg-white/25 transition-colors"
          >
            <div className="flex items-center justify-between text-[10px] text-blue-100">
              <span className="flex items-center gap-1">
                <CreditCard className="w-3.5 h-3.5 text-yellow-300" />
                福利卡余额
              </span>
              <span>明细 &gt;</span>
            </div>
            <div className="text-base font-black text-white font-mono mt-0.5">¥{user.welfareBalance.toLocaleString('zh-CN', { minimumFractionDigits: 2 })}</div>
          </div>

          <div onClick={() => triggerPendingFeature('微信小程序 餐卡账单', '查看餐卡专享扣减明细。')} className="bg-white/15 backdrop-blur-xs p-2.5 rounded-xl border border-white/20 cursor-pointer active:bg-white/25 transition-colors">
            <div className="flex items-center justify-between text-[10px] text-blue-100">
              <span className="flex items-center gap-1">
                <Utensils className="w-3.5 h-3.5 text-amber-300" />
                餐卡余额
              </span>
              <span>明细 &gt;</span>
            </div>
            <div className="text-base font-black text-white font-mono mt-0.5">¥{user.mealBalance.toLocaleString('zh-CN', { minimumFractionDigits: 2 })}</div>
          </div>
        </div>
      </div>

      <div className="p-3 space-y-3 flex-1 overflow-y-auto">
        {/* Orders Status Grid */}
        <div className="space-y-3 rounded-[22px] border border-white bg-white p-3.5 shadow-[0_10px_28px_rgba(33,52,78,0.045)]">
          <div className="flex items-center justify-between text-xs">
            <h3 className="flex items-center gap-2 font-black text-slate-900">
              <OrderFlowIcon className="h-6 w-6 text-[#5B7CA4]" />
              <span>我的订单</span>
            </h3>
            <button onPointerDown={() => preloadMiniProgramPage('orders')} onClick={() => openOrders('all')} className="flex touch-manipulation items-center text-[10px] text-gray-400 transition-transform duration-100 hover:text-[var(--sw-brand)] active:scale-95">
              <span>查看全部</span>
              <ChevronRight className="w-3 h-3" />
            </button>
          </div>

          <div className="grid grid-cols-4 gap-1 rounded-[18px] bg-[#F8FAFC] px-1 py-2 text-center text-xs">
            <button onPointerDown={() => preloadMiniProgramPage('orders')} onClick={() => openOrders('pending_payment')} className="relative cursor-pointer touch-manipulation rounded-[14px] py-1.5 transition-[background-color,transform] duration-150 active:scale-95 active:bg-white">
              <div className="mx-auto flex h-9 w-9 items-center justify-center rounded-full bg-blue-50 font-bold text-[var(--sw-brand)]">
                <Clock className="w-4 h-4" />
              </div>
              {orderCount('pending_payment') > 0 && <OrderCountBadge count={orderCount('pending_payment')} />}
              <div className="mt-1.5 text-[10px] font-semibold text-slate-600">待付款</div>
            </button>

            <button onPointerDown={() => preloadMiniProgramPage('orders')} onClick={() => openOrders('pending_shipment')} className="relative cursor-pointer touch-manipulation rounded-[14px] py-1.5 transition-[background-color,transform] duration-150 active:scale-95 active:bg-white">
              <div className="mx-auto flex h-9 w-9 items-center justify-center rounded-full bg-amber-50 font-bold text-amber-600">
                <Truck className="h-4 w-4" />
              </div>
              {fulfillment.count > 0 && <OrderCountBadge count={fulfillment.count} />}
              <div key={fulfillment.label} aria-live="polite" className="mt-1.5 text-[10px] font-semibold text-slate-600">{fulfillment.label}</div>
            </button>

            <button onPointerDown={() => preloadMiniProgramPage('orders')} onClick={() => openOrders('completed')} className="relative cursor-pointer touch-manipulation rounded-[14px] py-1.5 transition-[background-color,transform] duration-150 active:scale-95 active:bg-white">
              <div className="mx-auto flex h-9 w-9 items-center justify-center rounded-full bg-emerald-50 font-bold text-emerald-600">
                <CheckCircle className="w-4 h-4" />
              </div>
              {orderCount('completed') > 0 && <OrderCountBadge count={orderCount('completed')} />}
              <div className="mt-1.5 text-[10px] font-semibold text-slate-600">已完成</div>
            </button>

            <button onPointerDown={() => preloadMiniProgramPage('orders')} onClick={() => openOrders('after_sale')} className="relative cursor-pointer touch-manipulation rounded-[14px] py-1.5 transition-[background-color,transform] duration-150 active:scale-95 active:bg-white">
              <div className="mx-auto flex h-9 w-9 items-center justify-center rounded-full bg-purple-50 font-bold text-purple-600">
                <HelpCircle className="w-4 h-4" />
              </div>
              {orderCount('after_sale') > 0 && <OrderCountBadge count={orderCount('after_sale')} />}
              <div className="mt-1.5 text-[10px] font-semibold text-slate-600">售后</div>
            </button>
          </div>
        </div>

        {/* Welfare Tools & Cards */}
        <div className="bg-white rounded-2xl p-3 shadow-xs border border-gray-100 space-y-2 text-xs">
          <div className="text-[11px] text-gray-400 font-bold px-1 uppercase tracking-wider">企采资产与常用工具</div>

          <div className="divide-y divide-gray-100 text-gray-700">
            <button
              onClick={() => triggerPendingFeature('我的虚拟卡券包', '出示核销二维码或管理已领取的星巴克代金券/电影票。')}
              className="w-full py-2.5 flex items-center justify-between hover:bg-gray-50 px-1 rounded-lg transition-colors cursor-pointer"
            >
              <div className="flex items-center gap-2 font-medium">
                <Ticket className="w-4 h-4 text-orange-500" />
                <span>我的卡券包</span>
              </div>
              <span className="text-[var(--sw-brand)] font-bold flex items-center text-[10px]">
                <span>3 张可用</span>
                <ChevronRight className="w-3.5 h-3.5 text-gray-300 ml-0.5" />
              </span>
            </button>

            <button onClick={() => setMpPage('address')} className="w-full py-2.5 flex items-center justify-between hover:bg-gray-50 px-1 rounded-lg transition-colors cursor-pointer">
              <div className="flex items-center gap-2 font-medium">
                <MapPin className="w-4 h-4 text-blue-500" />
                <span>收货地址管理</span>
              </div>
              <ChevronRight className="w-3.5 h-3.5 text-gray-300" />
            </button>

            <button
              onClick={() => triggerPendingFeature('企业发票抬头信息', '自动填充中国建筑集团增值税专票抬头。')}
              className="w-full py-2.5 flex items-center justify-between hover:bg-gray-50 px-1 rounded-lg transition-colors cursor-pointer"
            >
              <div className="flex items-center gap-2 font-medium">
                <FileText className="w-4 h-4 text-emerald-500" />
                <span>开票信息配置</span>
              </div>
              <span className="text-gray-400 text-[10px]">专票/普票抬头 &gt;</span>
            </button>
          </div>
        </div>

        {/* Extended Mobile Native Settings (接口待接入) */}
        <div className="bg-white rounded-2xl p-3 shadow-xs border border-gray-100 space-y-2 text-xs">
          <div className="text-[11px] text-gray-400 font-bold px-1 uppercase tracking-wider">平台设置与支持</div>

          <div className="divide-y divide-gray-100 text-gray-700">
            <button
              onClick={() => triggerPendingFeature('微信小程序服务通知消息订阅', '开启端内订单物流变动与福利卡发放通知。')}
              className="w-full py-2.5 flex items-center justify-between hover:bg-gray-50 px-1 rounded-lg transition-colors cursor-pointer"
            >
              <div className="flex items-center gap-2 font-medium">
                <BellRing className="w-4 h-4 text-purple-500" />
                <span>服务通知推送订阅</span>
              </div>
              <span className="text-xs text-amber-600 bg-amber-50 font-bold px-1.5 py-0.2 rounded border border-amber-200">接口待接入</span>
            </button>

            <button onClick={() => triggerPendingFeature('微信企微客服', '调起企业微信客服小助手。')} className="w-full py-2.5 flex items-center justify-between hover:bg-gray-50 px-1 rounded-lg transition-colors cursor-pointer">
              <div className="flex items-center gap-2 font-medium">
                <Headphones className="w-4 h-4 text-indigo-500" />
                <span>企采专属客服专线</span>
              </div>
              <span className="text-gray-400 text-[10px]">工作日 09:00-18:00 &gt;</span>
            </button>

            <button
              onClick={() => triggerPendingFeature('企业员工身份验证状态', '核验当前微信账号与集团 HR 系统的绑定状态。')}
              className="w-full py-2.5 flex items-center justify-between hover:bg-gray-50 px-1 rounded-lg transition-colors cursor-pointer"
            >
              <div className="flex items-center gap-2 font-medium">
                <ShieldCheck className="w-4 h-4 text-blue-600" />
                <span>企业安全认证凭证</span>
              </div>
              <span className={`${user.phoneVerified ? 'text-emerald-600' : 'text-amber-600'} font-bold text-[10px]`}>{user.phoneVerified ? '手机已验证' : '手机待验证'} &gt;</span>
            </button>
          </div>
        </div>

        {sessionStatus === 'authenticated' && (
          <button
            type="button"
            onClick={() => void logout()}
            aria-label="退出当前会员账户"
            className="flex w-full items-center justify-center gap-2 rounded-2xl border border-red-100 bg-white py-3 text-xs font-bold text-red-500 shadow-xs active:bg-red-50"
          >
            <LogOut className="h-4 w-4" />
            <span>退出当前账号</span>
          </button>
        )}

        <div className="text-center py-2 text-[10px] text-gray-400">
          <div>主打团商城 v2.8.0</div>
          <div>技术服务方：雍彻科技（SGSYEN TECH）</div>
        </div>
      </div>

    </div>
  );
};

function OrderCountBadge({ count }: Readonly<{ count: number }>) {
  return (
    <span className="absolute right-1.5 top-0 flex h-4 min-w-4 items-center justify-center rounded-full border border-white bg-[#E5EFFB] px-1 text-[8px] font-black text-[#426891]">
      {count > 99 ? '99+' : count}
    </span>
  );
}
