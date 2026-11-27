import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useMall } from '../../context/MallContext';
import { toFrontendProducts, type FrontendProduct } from '../../adapters/frontendData';
import { mapApiProduct } from '../../context/mallMappers';
import { loadProgressiveCatalog } from '../../context/useProductionSync';
import { listPublicProducts } from '../../services/publicCatalogApi';
import type { ApiProduct } from '../../services/productionApi.types';
import { isPaymentRecoveryPending } from '../../services/paymentRecovery';
import type { LaptopPage } from '../../context/MallContext.types';
import { LaptopTopSwitcher } from './LaptopTopSwitcher';
import { LaptopHeader } from './LaptopHeader';
import { LaptopHomePage1366 } from './LaptopHomePage1366';
import { LaptopHomePage1440 } from './LaptopHomePage1440';
import { LaptopCategoryPage } from './LaptopCategoryPage';
import { LaptopDetailPage } from './LaptopDetailPage';
import { CheckoutAddressForm, LaptopCartCheckoutPage } from './LaptopCartCheckoutPage';
import { LaptopOrdersPage } from './LaptopOrdersPage';
import { LaptopAccountSecurityPage, LaptopMemberPage } from './LaptopMemberPage';
import { QuickViewModal } from '../common/QuickViewModal';
import { ToastContainer } from '../common/ToastContainer';
import { Footer } from '../common/Footer';
import { defaultStorefrontWebPage, STOREFRONT_WEB_STANDARD_ID, type StorefrontWebNavigationBoundary, type StorefrontWebSurface } from './StorefrontWebStandard';

type StorefrontWebFrameProps = {
  surface?: StorefrontWebSurface;
  navigationBoundary?: StorefrontWebNavigationBoundary;
};

type CatalogSearch = {
  query: string;
  status: 'loading' | 'error' | 'ready';
  items: readonly ApiProduct[];
};

export const StorefrontWebFrame: React.FC<StorefrontWebFrameProps> = ({ surface = 'laptop', navigationBoundary = 'showcase' }) => {
  const { laptopPage, setLaptopPage, activePaymentSession, presentationProducts, sessionStatus } = useMall();
  const paymentSessionSeen = useRef<string | null>(null);
  const [search, setSearch] = useState<CatalogSearch | null>(null);
  const [searchProduct, setSearchProduct] = useState<FrontendProduct>();
  const [showShippingAddress, setShowShippingAddress] = useState(() =>
    navigationBoundary === 'production' && typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('view') === 'shipping-address');

  useEffect(() => {
    if (!isPaymentRecoveryPending(activePaymentSession) || paymentSessionSeen.current === activePaymentSession.idempotencyKey) return;
    paymentSessionSeen.current = activePaymentSession.idempotencyKey;
    if (laptopPage !== 'cart' && !showShippingAddress) setLaptopPage('cart');
  }, [activePaymentSession, laptopPage, setLaptopPage, showShippingAddress]);

  const closeShippingAddress = () => {
    if (!showShippingAddress) return;
    setShowShippingAddress(false);
    const url = new URL(window.location.href);
    url.searchParams.delete('view');
    window.history.replaceState(window.history.state, '', url);
  };

  useEffect(() => {
    if (!search || search.status !== 'loading') return;
    const controller = new AbortController();
    const { query } = search;

    void loadProgressiveCatalog(
      (options) => listPublicProducts({ ...options, q: query, signal: controller.signal }),
      () => {},
      async () => {},
      Infinity,
    ).then((items) => {
      if (!controller.signal.aborted) setSearch({ query, status: 'ready', items });
    }, () => {
      if (!controller.signal.aborted) setSearch({ query, status: 'error', items: [] });
    });
    return () => controller.abort();
  }, [search]);

  const searchResults = useMemo(() => {
    if (!search) return undefined;
    const productsById = new Map(presentationProducts.map((product) => [product.id, product]));
    return toFrontendProducts(search.items.map(mapApiProduct))
      .map((product) => productsById.get(product.id) ?? product);
  }, [search, presentationProducts]);

  const handleSelectTab = (tab: LaptopPage) => {
    closeShippingAddress();
    setSearchProduct(undefined);
    setLaptopPage(tab);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleHeaderTab = (tab: LaptopPage) => {
    setSearch(null);
    handleSelectTab(tab);
  };

  const handleSearch = (query: string) => {
    setSearch(query ? { query, status: 'loading', items: [] } : null);
    handleSelectTab('category');
  };

  const openSearchProduct = (product: FrontendProduct) => {
    handleSelectTab('detail');
    setSearchProduct(product);
  };

  const renderLaptopContent = () => {
    if (showShippingAddress) {
      return (
        <section className="sw-web-container mx-auto max-w-[1240px] px-3 py-6">
          <div className="max-w-xl space-y-3 rounded-lg border border-gray-200 bg-white p-4 text-xs">
            <h1 className="text-sm font-extrabold text-gray-900">新增收货地址</h1>
            <CheckoutAddressForm onClose={closeShippingAddress} />
          </div>
        </section>
      );
    }
    const isMemberPage = laptopPage === 'member' || laptopPage === 'account-security';
    const visiblePage = isMemberPage && sessionStatus !== 'authenticated' ? defaultStorefrontWebPage(surface) : laptopPage;
    switch (visiblePage) {
      case 'home-1366':
        return <LaptopHomePage1366 onSelectTab={handleSelectTab} />;
      case 'home-1440':
        return <LaptopHomePage1440 onSelectTab={handleSelectTab} surface={surface} />;
      case 'category':
        return <LaptopCategoryPage
          onSelectTab={handleSelectTab}
          surface={surface}
          searchResults={searchResults}
          searchStatus={search?.status}
          onOpenSearchProduct={search ? openSearchProduct : undefined}
        />;
      case 'detail':
        return <LaptopDetailPage onSelectTab={handleSelectTab} surface={surface} selectedProduct={searchProduct} />;
      case 'cart':
        return <LaptopCartCheckoutPage onSelectTab={handleSelectTab} surface={surface} />;
      case 'orders':
        return <LaptopOrdersPage onSelectTab={handleSelectTab} surface={surface} />;
      case 'member':
        return <LaptopMemberPage onSelectTab={handleSelectTab} surface={surface} />;
      case 'account-security':
        return <LaptopAccountSecurityPage onSelectTab={handleSelectTab} />;
      default:
        return <LaptopHomePage1366 onSelectTab={handleSelectTab} />;
    }
  };

  return (
    <div
      className="min-h-screen bg-[#F5F7FA] text-gray-800 flex flex-col justify-between font-sans overflow-x-hidden selection:bg-[var(--sw-brand)] selection:text-white"
      data-storefront-web-standard={STOREFRONT_WEB_STANDARD_ID}
      data-storefront-web-surface={surface}
    >
      {/* 2. 消费者 Web 标准页头；桌面仅改变密度，不改变组件与交互。 */}
      <LaptopHeader
        activeTab={laptopPage}
        onSelectTab={handleHeaderTab}
        onSearch={navigationBoundary === 'production' ? handleSearch : undefined}
        surface={surface}
      />

      {/* 3. 笔记本端核心 6 页面视图渲染区 */}
      <main className="flex-1 w-full overflow-x-hidden">{renderLaptopContent()}</main>

      {/* 4. 快速预览 Modal 与 Toast 提示框 */}
      <QuickViewModal />
      <ToastContainer />

      {/* 5. 底部版权与服务商标识 (雍彻科技) */}
      <Footer switcher={<LaptopTopSwitcher surface={surface} navigationBoundary={navigationBoundary} />} />
    </div>
  );
};

/** Backward-compatible entry used by the existing /laptop-web showcase. */
export const LaptopFrame: React.FC = () => <StorefrontWebFrame surface="laptop" />;
