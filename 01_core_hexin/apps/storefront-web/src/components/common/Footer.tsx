/**
 * 主打团商城 - 页脚 Footer 组件
 * 彰显 B2B2C 企业福利架构与平台公信力
 * 标注技术服务方：雍彻科技
 */

import React from 'react';
import { useMall } from '../../context/MallContext';
import { ShieldCheck, Truck, CreditCard, Headphones, Award, Building2, Lock, Sparkles } from 'lucide-react';

export const Footer: React.FC = () => {
  const { currentMall, navigateTo } = useMall();

  return (
    <footer className="w-full bg-[#111827] text-gray-300 text-xs font-sans mt-12 border-t border-gray-800 select-none">
      {/* 1. 顶部四大承诺与保障 */}
      <div className="border-b border-gray-800 bg-gray-900/60 py-6">
        <div className="sw-web-container max-w-[1280px] mx-auto px-4 grid grid-cols-1 md:grid-cols-4 gap-6">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-blue-500/10 border border-blue-500/30 flex items-center justify-center text-[var(--sw-brand)]">
              <ShieldCheck className="w-5 h-5 text-[var(--sw-brand)]" />
            </div>
            <div>
              <div className="font-bold text-white text-sm">央国企采买正品验货</div>
              <div className="text-gray-400 text-[11px] mt-0.5">自营仓+品牌一级代理直供</div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-blue-500/10 border border-blue-500/30 flex items-center justify-center text-[var(--sw-brand)]">
              <CreditCard className="w-5 h-5 text-[var(--sw-brand)]" />
            </div>
            <div>
              <div className="font-bold text-white text-sm">多维福利统筹抵扣</div>
              <div className="text-gray-400 text-[11px] mt-0.5">支持福利卡/餐卡/微信混合结算</div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-blue-500/10 border border-blue-500/30 flex items-center justify-center text-[var(--sw-brand)]">
              <Truck className="w-5 h-5 text-[var(--sw-brand)]" />
            </div>
            <div>
              <div className="font-bold text-white text-sm">极速履约与电子发码</div>
              <div className="text-gray-400 text-[11px] mt-0.5">物理次日达 · 卡券即时发码核销</div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-blue-500/10 border border-blue-500/30 flex items-center justify-center text-[var(--sw-brand)]">
              <Headphones className="w-5 h-5 text-[var(--sw-brand)]" />
            </div>
            <div>
              <div className="font-bold text-white text-sm">集团专属客服保障</div>
              <div className="text-gray-400 text-[11px] mt-0.5">7x12小时人工企业对公售后</div>
            </div>
          </div>
        </div>
      </div>

      {/* 2. 底部栏目链接 */}
      <div className="sw-web-container max-w-[1280px] mx-auto px-4 py-10 grid grid-cols-2 md:grid-cols-5 gap-8">
        <div>
          <div className="font-bold text-white text-sm mb-3 border-l-2 border-[var(--sw-brand)] pl-2">关于商城</div>
          <ul className="space-y-2 text-gray-400">
            <li className="hover:text-white transition-colors cursor-pointer" onClick={() => navigateTo('home')}>
              商城简介
            </li>
            <li className="hover:text-white transition-colors cursor-pointer" onClick={() => navigateTo('home')}>
              企业福利解决方案
            </li>
            <li className="hover:text-white transition-colors cursor-pointer" onClick={() => navigateTo('architecture')}>
              系统 Canvas 架构图
            </li>
            <li className="hover:text-white transition-colors cursor-pointer" onClick={() => navigateTo('home')}>
              供应商入驻标准
            </li>
            <li className="hover:text-white transition-colors cursor-pointer" onClick={() => navigateTo('home')}>
              分销服务商政策 (distributorId)
            </li>
          </ul>
        </div>

        <div>
          <div className="font-bold text-white text-sm mb-3 border-l-2 border-[var(--sw-brand)] pl-2">福利与账户</div>
          <ul className="space-y-2 text-gray-400">
            <li className="hover:text-white transition-colors cursor-pointer" onClick={() => navigateTo('balance', { accountTab: 'welfare' })}>
              福利卡充值与规则
            </li>
            <li className="hover:text-white transition-colors cursor-pointer" onClick={() => navigateTo('balance', { accountTab: 'meal' })}>
              餐卡使用规则与补差
            </li>
            <li className="hover:text-white transition-colors cursor-pointer" onClick={() => navigateTo('coupons')}>
              电子卡券与核销指南
            </li>
            <li className="hover:text-white transition-colors cursor-pointer" onClick={() => navigateTo('balance')}>
              账户交易日志查询
            </li>
          </ul>
        </div>

        <div>
          <div className="font-bold text-white text-sm mb-3 border-l-2 border-[var(--sw-brand)] pl-2">购物与配送</div>
          <ul className="space-y-2 text-gray-400">
            <li className="hover:text-white transition-colors cursor-pointer" onClick={() => navigateTo('orders')}>
              订单查询与跟踪
            </li>
            <li className="hover:text-white transition-colors cursor-pointer" onClick={() => navigateTo('cart')}>
              合并结算与供应商拆单
            </li>
            <li className="hover:text-white transition-colors cursor-pointer" onClick={() => navigateTo('home')}>
              发票开具（企业/个人）
            </li>
            <li className="hover:text-white transition-colors cursor-pointer" onClick={() => navigateTo('home')}>
              配送时效与运费说明
            </li>
          </ul>
        </div>

        <div>
          <div className="font-bold text-white text-sm mb-3 border-l-2 border-[var(--sw-brand)] pl-2">售后与保障</div>
          <ul className="space-y-2 text-gray-400">
            <li className="hover:text-white transition-colors cursor-pointer" onClick={() => navigateTo('orders', { statusFilter: 'after_sale' })}>
              退换货流程与申请
            </li>
            <li className="hover:text-white transition-colors cursor-pointer" onClick={() => navigateTo('home')}>
              虚拟卡券挂失与补发
            </li>
            <li className="hover:text-white transition-colors cursor-pointer" onClick={() => navigateTo('home')}>
              线下门店核销维权
            </li>
            <li className="hover:text-white transition-colors cursor-pointer" onClick={() => navigateTo('home')}>
              隐私保护与合规承诺
            </li>
          </ul>
        </div>

        {/* 平台授权与技术服务方 */}
        <div className="bg-gray-800/60 p-4 rounded-md border border-gray-700/60 flex flex-col justify-between">
          <div>
            <div className="flex items-center gap-1.5 text-white font-bold text-sm mb-2">
              <Building2 className="w-4 h-4 text-[var(--sw-brand)]" />
              <span>{currentMall.enterpriseName}</span>
            </div>
            <p className="text-[11px] text-gray-400 leading-relaxed">
              本商城由【{currentMall.enterpriseName}
              】统一授权搭建，专为集团员工提供全品类福利兑换与特惠商品采购服务。
            </p>
          </div>

          <div className="mt-4 pt-3 border-t border-gray-700/80">
            <div className="text-[11px] text-gray-400">项目状态：</div>
            <img src="/brand/morvia-master-lockup-white.svg" alt="主打团" className="mt-1 h-10 w-40 object-contain" />
            <div className="text-[10px] text-gray-500 mt-1">技术服务：雍彻科技</div>
          </div>
        </div>
      </div>

      {/* 3. 版权、备案与技术服务方标志 */}
      <div className="border-t border-gray-800 bg-gray-950 py-5 text-center text-gray-500 text-[11px]">
        <div className="sw-web-container max-w-[1280px] mx-auto px-4 space-y-2">
          <div className="flex items-center justify-center gap-4 flex-wrap text-gray-400">
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 bg-[#18A058] rounded-full inline-block animate-pulse"></span>
              网络连接正常
            </span>
            <span>·</span>
            <span>安全连接 · 隐私保护</span>
            <span>·</span>
            <span className="font-bold text-white bg-blue-900/60 border border-blue-500/30 px-2 py-0.5 rounded flex items-center gap-1">
              <Sparkles className="w-3 h-3 text-yellow-300" />
              技术服务方：雍彻科技 (SGSYEN TECH)
            </span>
          </div>

          <div>© 2026 主打团企业福利商城。保留所有权利。 技术服务：雍彻科技</div>

          <div className="text-gray-600 text-[10px]">商品、库存、企业权益与订单状态以登录账户的实时数据为准。</div>
        </div>
      </div>
    </footer>
  );
};
