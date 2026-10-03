import React, { useEffect, useRef, useState } from 'react';
import { useMall } from '../../context/MallContext';
import { WeChatCapsule } from '../../components/mobile/WeChatCapsule';
import { MPProductFeed } from './MPProductFeed';
import { CreditCard, Utensils, Search, ChevronRight, Flame, Store, Ticket, ShoppingBag, Gift, Tv, Coffee, Sparkles, Plus, ShieldCheck, Building2, Tag } from 'lucide-react';
import { storefrontAuthHref } from '../../config/storefrontAuth';
import { MPAuthStatusCard } from './MPAuthStatusCard';
import { storefrontImageUrl } from '../../services/storefrontImageUrl';

export const HOME_CAMPAIGN_AUTOPLAY_MS = 5200;
export const HOME_CAMPAIGN_TRANSITION_MS = 760;
export const HOME_CAMPAIGN_INTERACTION_PAUSE_MS = 9000;

const HOME_CAMPAIGNS = [
  {
    id: 'mid-autumn-care',
    eyebrow: '月满主打团 · 员工团圆礼',
    title: '中秋关怀',
    desc: '月饼粮油与团圆好礼 · 福利卡全额兑换',
    cta: '领取团圆礼',
    color: 'from-[#123A85] via-[#1858C7] to-[#2C7DF0]',
    icon: Sparkles,
  },
  {
    id: 'golden-autumn-hongtai',
    eyebrow: 'MORVIA 主打团 · 秋日焕新',
    title: '金秋主打团',
    desc: '品质粮油与暖心家电 · 金秋好礼直达',
    cta: '逛金秋好礼',
    color: 'from-[#8F450E] via-[#C77516] to-[#E6A32D]',
    icon: ShoppingBag,
  },
  {
    id: 'double-festival',
    eyebrow: '中秋 × 国庆 · 双节同庆',
    title: '双喜临门',
    desc: '双节精选礼遇 · 家国同庆好事成双',
    cta: '开启双节礼',
    color: 'from-[#9D2130] via-[#CF3D3A] to-[#F06A3D]',
    icon: Gift,
  },
  {
    id: 'wuhan-gifts',
    eyebrow: '江城心意 · 企业定制礼',
    title: '大武汉礼品',
    desc: '武汉风味与城市文创 · 把江城心意带回家',
    cta: '选武汉好礼',
    color: 'from-[#173B70] via-[#28658F] to-[#A94E55]',
    icon: Building2,
  },
] as const;

export function homeCampaignIndexForScroll(scrollLeft: number, viewportWidth: number): number {
  if (!Number.isFinite(scrollLeft) || !Number.isFinite(viewportWidth) || viewportWidth <= 0) return 0;
  return Math.max(0, Math.min(HOME_CAMPAIGNS.length - 1, Math.round(scrollLeft / viewportWidth)));
}

export const MPHomePage: React.FC = () => {
  const { user, currentMall, mpPage, sessionError, sessionStatus, catalogSyncStatus, refreshProductionData, setMpPage, addToCart, triggerPendingFeature, presentationProducts: MOCK_PRODUCTS } = useMall();
  const [activeBanner, setActiveBanner] = useState(0);
  const [searchKeyword, setSearchKeyword] = useState('');
  const [authHref, setAuthHref] = useState<string | undefined>(undefined);
  const campaignTrackRef = useRef<HTMLDivElement>(null);
  const campaignResumeAtRef = useRef(0);
  const campaignScrollFrameRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    setAuthHref(storefrontAuthHref(window.location.hostname));
  }, []);

  useEffect(() => {
    if (mpPage !== 'home' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;

    let timer: number | undefined;
    const scheduleNextCampaign = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      if (document.visibilityState !== 'visible') return;
      const interactionPauseRemaining = Math.max(0, campaignResumeAtRef.current - Date.now());
      timer = window.setTimeout(
        () => {
          if (Date.now() < campaignResumeAtRef.current) {
            scheduleNextCampaign();
            return;
          }
          const next = (activeBanner + 1) % HOME_CAMPAIGNS.length;
          const track = campaignTrackRef.current;
          if (track) track.scrollTo({ left: next * track.clientWidth, behavior: 'smooth' });
          setActiveBanner(next);
        },
        interactionPauseRemaining || HOME_CAMPAIGN_AUTOPLAY_MS,
      );
    };

    scheduleNextCampaign();
    document.addEventListener('visibilitychange', scheduleNextCampaign);
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', scheduleNextCampaign);
    };
  }, [activeBanner, mpPage]);

  useEffect(() => () => {
    if (campaignScrollFrameRef.current !== undefined) window.cancelAnimationFrame(campaignScrollFrameRef.current);
  }, []);

  const pauseCampaignAutoplay = () => {
    campaignResumeAtRef.current = Date.now() + HOME_CAMPAIGN_INTERACTION_PAUSE_MS;
  };

  const syncCampaignFromScroll = () => {
    if (campaignScrollFrameRef.current !== undefined) window.cancelAnimationFrame(campaignScrollFrameRef.current);
    campaignScrollFrameRef.current = window.requestAnimationFrame(() => {
      const track = campaignTrackRef.current;
      if (!track) return;
      const next = homeCampaignIndexForScroll(track.scrollLeft, track.clientWidth);
      setActiveBanner((current) => current === next ? current : next);
    });
  };

  const scrollToCampaign = (index: number, initiatedByUser = false) => {
    if (initiatedByUser) pauseCampaignAutoplay();
    const track = campaignTrackRef.current;
    if (track) track.scrollTo({ left: index * track.clientWidth, behavior: 'smooth' });
    setActiveBanner(index);
  };

  // Quick 8 categories (Meituan B2C info architecture style)
  const quickCategories = [
    { name: '福利卡专区', icon: CreditCard, color: 'text-blue-600 bg-blue-50' },
    { name: '餐卡专区', icon: Utensils, color: 'text-orange-600 bg-orange-50' },
    { name: '影音卡券', icon: Ticket, color: 'text-purple-600 bg-purple-50' },
    { name: '星巴克/咖啡', icon: Coffee, color: 'text-emerald-600 bg-emerald-50' },
    { name: '米面粮油', icon: ShoppingBag, color: 'text-amber-600 bg-amber-50' },
    { name: '附近门店', icon: Store, color: 'text-cyan-600 bg-cyan-50' },
    { name: '数码办公', icon: Tv, color: 'text-indigo-600 bg-indigo-50' },
    { name: '全员礼品', icon: Gift, color: 'text-rose-600 bg-rose-50' },
  ];

  const enterpriseExclusives = MOCK_PRODUCTS.filter((p) => p.isEnterpriseExclusive).slice(0, 4);
  const nearbyServices = MOCK_PRODUCTS.filter((p) => p.itemType === 'nearby_store').slice(0, 2);
  const catalogPending = MOCK_PRODUCTS.length === 0 && (catalogSyncStatus === 'idle' || catalogSyncStatus === 'syncing');

  return (
    <div className="bg-[#F5F7FA] min-h-full flex flex-col font-sans text-gray-800">
      {/* 顶部胶囊 Header */}
      <WeChatCapsule />

      <MPAuthStatusCard
        authHref={authHref}
        sessionError={sessionError}
        sessionStatus={sessionStatus}
        user={user}
        onRetry={() => {
          void refreshProductionData().catch(() => undefined);
        }}
      />

      {/* 搜索框区 */}
      <div className="bg-[var(--sw-brand-dark)] px-3 pb-3 pt-1">
        <div className="relative flex items-center">
          <input
            type="text"
            value={searchKeyword}
            onChange={(e) => setSearchKeyword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && setMpPage('category')}
            placeholder="搜索福利卡可兑商品、米面粮油、影音卡券..."
            className="w-full border border-transparent bg-white text-gray-900 placeholder-gray-400 text-xs pl-8 pr-16 py-2 focus:border-blue-300 focus:outline-none shadow-inner font-medium transition-colors"
          />
          <Search className="w-4 h-4 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
          <button onClick={() => setMpPage('category')} className="absolute right-1 top-1/2 -translate-y-1/2 border border-blue-400 bg-[var(--sw-brand)] hover:border-blue-200 hover:bg-blue-700 hover:shadow-sm text-white font-bold text-xs px-3 py-1 cursor-pointer transition-[background-color,border-color,box-shadow]">
            搜索
          </button>
        </div>
      </div>

      {/* 活动轮播图 */}
      <div className="px-3 mt-3">
        <section
          aria-label="首页福利活动"
          aria-roledescription="carousel"
          className="relative h-[124px] overflow-hidden border border-blue-800 bg-[var(--sw-brand-dark)] text-white shadow-sm"
          data-home-campaign-carousel
        >
          <div
            ref={campaignTrackRef}
            data-home-campaign-track
            tabIndex={0}
            onPointerDown={pauseCampaignAutoplay}
            onWheel={pauseCampaignAutoplay}
            onScroll={syncCampaignFromScroll}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
              event.preventDefault();
              const direction = event.key === 'ArrowRight' ? 1 : -1;
              const next = (activeBanner + direction + HOME_CAMPAIGNS.length) % HOME_CAMPAIGNS.length;
              scrollToCampaign(next, true);
            }}
            className="flex h-full w-full snap-x snap-mandatory overflow-x-auto overscroll-x-contain scroll-smooth [scrollbar-width:none] [&::-webkit-scrollbar]:hidden motion-reduce:scroll-auto"
          >
            {HOME_CAMPAIGNS.map((campaign, index) => {
              const Icon = campaign.icon;
              const isActive = activeBanner === index;
              return (
                <article
                  key={campaign.id}
                  aria-hidden={!isActive}
                  data-campaign-slide={campaign.id}
                  data-active={isActive ? 'true' : 'false'}
                  className={`relative h-full min-w-full snap-center snap-always overflow-hidden bg-gradient-to-br ${campaign.color} p-4`}
                >
                  <div aria-hidden="true" className="absolute -right-5 -top-8 h-28 w-28 rotate-12 bg-white/10" />
                  <div aria-hidden="true" className="absolute bottom-1 right-7 h-12 w-12 -rotate-6 bg-white/8" />
                  <Icon aria-hidden="true" className="absolute right-5 top-5 h-12 w-12 text-white/18" strokeWidth={1.35} />

                  <div className="relative z-10 max-w-[78%]">
                    <span className="inline-flex border border-white/20 bg-white/14 px-2 py-0.5 text-[9px] font-bold text-amber-100">
                      {campaign.eyebrow}
                    </span>
                    <h2 className="mt-1 text-base font-black leading-tight tracking-tight">{campaign.title}</h2>
                    <p className="mt-0.5 truncate text-[10px] font-medium text-white/78">{campaign.desc}</p>
                  </div>

                  <button
                    type="button"
                    tabIndex={isActive ? 0 : -1}
                    onClick={() => setMpPage('category')}
                    className="absolute bottom-3 left-4 z-10 flex min-h-7 items-center gap-0.5 border border-white bg-white px-3 text-[10px] font-bold text-[var(--sw-brand-dark)] shadow-xs transition-[border-color,box-shadow] hover:border-amber-100 hover:shadow-sm"
                  >
                    <span>{campaign.cta}</span>
                    <ChevronRight className="h-3 w-3" />
                  </button>
                </article>
              );
            })}
          </div>

          <span className="sr-only" aria-live="polite">第 {activeBanner + 1} 页，共 {HOME_CAMPAIGNS.length} 页</span>
          <div className="absolute bottom-2.5 right-3 z-20 flex items-center gap-1 border border-white/10 bg-black/10 px-1.5" aria-label="选择活动页">
            {HOME_CAMPAIGNS.map((campaign, index) => (
              <button
                key={campaign.id}
                type="button"
                aria-label={`切换到活动：${campaign.title}`}
                aria-pressed={activeBanner === index}
                onClick={() => scrollToCampaign(index, true)}
                className="flex h-5 w-2.5 items-center justify-center active:bg-white/10"
              >
                <span
                  aria-hidden="true"
                  style={{ transitionDuration: `${HOME_CAMPAIGN_TRANSITION_MS}ms` }}
                  className={`h-1 transition-[width,background-color,opacity] ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none ${
                    activeBanner === index ? 'w-3 bg-amber-100 opacity-100' : 'w-1 bg-white/50 opacity-80'
                  }`}
                />
              </button>
            ))}
          </div>
        </section>
      </div>

      {/* 金刚区：8大分类入口 (Meituan mobile architecture) */}
      <div className="px-3 mt-3">
        <div className="bg-white p-3 shadow-xs grid grid-cols-4 gap-3 text-center border border-gray-100">
          {quickCategories.map((cat) => {
            const Icon = cat.icon;
            return (
              <button type="button" key={cat.name} onClick={() => setMpPage('category')}
                className="flex flex-col items-center gap-1.5 cursor-pointer border border-transparent py-1 transition-[background-color,border-color,box-shadow] hover:border-blue-100 hover:bg-blue-50/40 hover:shadow-xs">
                <div className={`w-10 h-10 flex items-center justify-center shadow-xs ${cat.color}`}>
                  <Icon className="w-5 h-5" />
                </div>
                <span className="text-[11px] font-bold text-gray-700 truncate w-full">{cat.name}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* 企业专享补贴栏 */}
      <div className="px-3 mt-3">
        <div className="bg-white p-3 shadow-xs border border-gray-100">
          <div className="flex items-center justify-between mb-2 pb-2 border-b border-gray-100">
            <div className="flex items-center gap-1.5">
              <span className="bg-[var(--sw-brand-dark)] text-white text-[10px] font-bold px-1.5 py-0.5">企采协议</span>
              <h3 className="text-xs font-black text-gray-900">企业大客户内购补贴</h3>
            </div>
            <button onClick={() => setMpPage('category')} className="text-[10px] text-[var(--sw-brand)] font-bold flex items-center">
              <span>查看全部</span>
              <ChevronRight className="w-3 h-3" />
            </button>
          </div>

          <div className="grid min-h-[72px] grid-cols-2 gap-2">
            {enterpriseExclusives.map((p, index) => (
              <div key={p.id} onClick={() => setMpPage('detail', p.id)} className="bg-gray-50/80 p-2 flex gap-2 border border-gray-100 cursor-pointer hover:border-blue-200 active:bg-blue-50/50 transition-[background-color,border-color,box-shadow] hover:shadow-xs">
                <img
                  src={storefrontImageUrl(p.imageUrl, 112)}
                  srcSet={`${storefrontImageUrl(p.imageUrl, 112)} 2x, ${storefrontImageUrl(p.imageUrl, 168)} 3x`}
                  alt={p.title}
                  width={56}
                  height={56}
                  loading={index === 0 ? 'eager' : 'lazy'}
                  fetchPriority={index === 0 ? 'high' : 'auto'}
                  decoding="async"
                  className="w-14 h-14 object-cover flex-shrink-0"
                />
                <div className="overflow-hidden flex flex-col justify-between flex-1">
                  <div className="text-[11px] font-bold text-gray-800 truncate">{p.title}</div>
                  <div>
                    <span className="text-[9px] text-[var(--sw-brand)] bg-blue-50 font-bold px-1 py-0.2">省¥{p.enterpriseSubsidyAmount}</span>
                    <div className="text-xs font-black text-[#E5484D] font-mono mt-0.5">¥{p.price}</div>
                  </div>
                </div>
              </div>
            ))}
            {catalogPending ? [0, 1].map((item) => <div key={item} aria-hidden="true"
              className="h-[72px] animate-pulse border border-gray-100 bg-gray-50/80" />) : null}
          </div>
        </div>
      </div>

      {/* 美团风格：附近门店凭码核销 */}
      <div className="px-3 mt-3">
        <div className="bg-gradient-to-r from-blue-50 to-indigo-50/60 p-3 border border-blue-100 shadow-xs">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-1.5">
              <Store className="w-4 h-4 text-[var(--sw-brand)]" />
              <h3 className="text-xs font-black text-gray-900">附近门店凭码即刻核销</h3>
              <span className="text-[9px] bg-blue-100 text-[var(--sw-brand)] font-bold px-1.5 py-0.2">免运费 · 到店出示二维码</span>
            </div>
            <button onClick={() => triggerPendingFeature('微信小程序 LBS 位置定位', '定位附近的加盟美发、烘焙甜品、健身房核销门店。')} className="text-[10px] text-gray-500 hover:text-blue-600 flex items-center">
              定位: 北京朝阳 &gt;
            </button>
          </div>

          <div className="min-h-[68px] space-y-2">
            {nearbyServices.map((p) => (
              <div key={p.id} onClick={() => setMpPage('detail', p.id)} className="bg-white p-2.5 flex items-center justify-between gap-2 shadow-xs border border-gray-100 hover:border-blue-200 hover:shadow-sm transition-[border-color,box-shadow] cursor-pointer">
                <div className="flex items-center gap-2.5 overflow-hidden">
                  <img
                    src={storefrontImageUrl(p.imageUrl, 96)}
                    srcSet={`${storefrontImageUrl(p.imageUrl, 96)} 2x, ${storefrontImageUrl(p.imageUrl, 144)} 3x`}
                    alt={p.title}
                    width={48}
                    height={48}
                    loading="lazy"
                    decoding="async"
                    className="w-12 h-12 object-cover flex-shrink-0"
                  />
                  <div className="overflow-hidden">
                    <div className="text-xs font-bold text-gray-900 truncate">{p.title}</div>
                    <div className="text-[10px] text-gray-500 truncate mt-0.5">{p.applicableStoreName || '包含朝阳区国贸店、三里屯店等28家门店'}</div>
                    <div className="text-[10px] text-emerald-600 font-medium flex items-center gap-1 mt-0.5">
                      <ShieldCheck className="w-3 h-3" />
                      <span>企采卡券包全额抵扣</span>
                    </div>
                  </div>
                </div>

                <div className="text-right flex-shrink-0">
                  <div className="text-xs font-black text-[#E5484D]">¥{p.price}</div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      addToCart(p, 1);
                    }}
                    className="mt-1 border border-blue-500 bg-[var(--sw-brand)] text-white text-[10px] font-bold px-2 py-0.5 shadow-xs hover:border-blue-300 hover:shadow-sm transition-[border-color,box-shadow] cursor-pointer"
                  >
                    兑换卡券
                  </button>
                </div>
              </div>
            ))}
            {catalogPending ? <div aria-hidden="true" className="h-[68px] animate-pulse border border-blue-100 bg-white/70" /> : null}
          </div>
        </div>
      </div>

      <MPProductFeed />

    </div>
  );
};
