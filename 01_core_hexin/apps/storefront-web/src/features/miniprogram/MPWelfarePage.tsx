import React from 'react';
import { ChevronRight, CreditCard, Gift, Plus, Ticket, Utensils } from 'lucide-react';
import { WeChatCapsule } from '../../components/mobile/WeChatCapsule';
import { useMall } from '../../context/MallContext';
import { storefrontImageUrl } from '../../services/storefrontImageUrl';

const WELFARE_CHANNELS = [
  { label: '福利卡专区', note: '实物与生活服务', icon: CreditCard, tone: 'bg-blue-50 text-blue-600' },
  { label: '餐卡专区', note: '餐饮与到店核销', icon: Utensils, tone: 'bg-orange-50 text-orange-600' },
  { label: '员工礼遇', note: '卡券与节日福利', icon: Gift, tone: 'bg-rose-50 text-rose-600' },
  { label: '影音卡券', note: '数字权益即时达', icon: Ticket, tone: 'bg-violet-50 text-violet-600' },
] as const;

export const MPWelfarePage: React.FC = () => {
  const { addToCart, presentationProducts, sessionStatus, setMpPage, user } = useMall();
  const featuredProducts = presentationProducts.slice(0, 4);
  const balance = (value: number) => sessionStatus === 'authenticated'
    ? `¥${value.toLocaleString('zh-CN', { minimumFractionDigits: 2 })}`
    : '登录后查看';

  return (
    <div className="min-h-full bg-[#F5F7FA] pb-5 font-sans text-gray-800">
      <WeChatCapsule title="企业福利" />

      <div className="space-y-3 p-3">
        <section className="overflow-hidden rounded-2xl bg-gradient-to-br from-[var(--sw-brand-dark)] to-[#2767F4] p-4 text-white shadow-md">
          <div className="text-[10px] font-bold text-blue-100">主打团 会员专享</div>
          <h1 className="mt-1 text-lg font-black tracking-tight">企业福利中心</h1>
          <p className="mt-1 text-[11px] text-blue-100">按账户额度选购，结算时自动核对可用权益</p>
          <div className="mt-4 grid grid-cols-2 divide-x divide-white/20 rounded-xl bg-white/10 py-2.5">
            <button type="button" onClick={() => setMpPage('profile')} className="px-3 text-left">
              <span className="block text-[10px] text-blue-100">福利卡余额</span>
              <span className="mt-0.5 block text-sm font-black">{balance(user.welfareBalance)}</span>
            </button>
            <button type="button" onClick={() => setMpPage('profile')} className="px-3 text-left">
              <span className="block text-[10px] text-blue-100">餐卡余额</span>
              <span className="mt-0.5 block text-sm font-black">{balance(user.mealBalance)}</span>
            </button>
          </div>
        </section>

        <section className="rounded-2xl border border-gray-100 bg-white p-3 shadow-xs">
          <div className="mb-2.5 flex items-center justify-between">
            <h2 className="text-xs font-black text-gray-900">福利入口</h2>
            <button type="button" onClick={() => setMpPage('category')} className="flex items-center text-[10px] font-bold text-[var(--sw-brand)]">
              查看全部 <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {WELFARE_CHANNELS.map(({ icon: Icon, label, note, tone }) => (
              <button key={label} type="button" onClick={() => setMpPage('category')} className="flex min-h-14 items-center gap-2 rounded-xl bg-gray-50 px-2.5 text-left active:bg-blue-50">
                <span className={`flex h-8 w-8 flex-none items-center justify-center rounded-xl ${tone}`}>
                  <Icon className="h-4 w-4" />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[11px] font-bold text-gray-800">{label}</span>
                  <span className="block truncate text-[9px] text-gray-400">{note}</span>
                </span>
              </button>
            ))}
          </div>
        </section>

        <section className="rounded-2xl border border-gray-100 bg-white p-3 shadow-xs">
          <div className="mb-2.5 flex items-center justify-between">
            <div>
              <h2 className="text-xs font-black text-gray-900">企业专享精选</h2>
              <p className="mt-0.5 text-[9px] text-gray-400">协议价格与履约范围以结算页为准</p>
            </div>
            <button type="button" onClick={() => setMpPage('category')} className="text-[10px] font-bold text-[var(--sw-brand)]">更多商品</button>
          </div>

          {featuredProducts.length === 0 ? (
            <div className="rounded-xl bg-gray-50 py-8 text-center text-xs text-gray-400">福利商品正在同步…</div>
          ) : (
            <div className="space-y-2">
              {featuredProducts.map((product) => (
                <div key={product.id} onClick={() => setMpPage('detail', product.id)} className="flex items-center gap-2.5 rounded-xl border border-gray-100 p-2 active:bg-gray-50">
                  <img
                    src={storefrontImageUrl(product.imageUrl, 144)}
                    srcSet={`${storefrontImageUrl(product.imageUrl, 144)} 2x, ${storefrontImageUrl(product.imageUrl, 216)} 3x`}
                    alt={product.title}
                    width={72}
                    height={72}
                    loading="lazy"
                    decoding="async"
                    className="h-[72px] w-[72px] flex-none rounded-xl bg-gray-50 object-cover"
                  />
                  <div className="min-w-0 flex-1">
                    <h3 className="line-clamp-1 text-xs font-bold text-gray-900">{product.title}</h3>
                    <p className="mt-0.5 line-clamp-1 text-[10px] text-gray-400">{product.subtitle}</p>
                    <div className="mt-2 flex items-end justify-between">
                      <div>
                        <span className="text-sm font-black text-[#E5484D]">¥{product.price}</span>
                        <span className="ml-1 text-[9px] text-gray-400 line-through">¥{product.originalPrice}</span>
                      </div>
                      <button
                        type="button"
                        aria-label={`加入购物车：${product.title}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          addToCart(product, 1);
                        }}
                        className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--sw-brand)] text-white active:bg-[var(--sw-brand-dark)]"
                      >
                        <Plus className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
