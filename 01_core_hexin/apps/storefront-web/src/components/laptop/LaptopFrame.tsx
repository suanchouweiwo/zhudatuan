import React from 'react';
import { useMall } from '../../context/MallContext';
import type { LaptopPage } from '../../context/MallContext.types';
import { LaptopTopSwitcher } from './LaptopTopSwitcher';
import { LaptopHeader } from './LaptopHeader';
import { LaptopHomePage1366 } from './LaptopHomePage1366';
import { LaptopHomePage1440 } from './LaptopHomePage1440';
import { LaptopCategoryPage } from './LaptopCategoryPage';
import { LaptopDetailPage } from './LaptopDetailPage';
import { LaptopCartCheckoutPage } from './LaptopCartCheckoutPage';
import { LaptopOrdersPage } from './LaptopOrdersPage';
import { QuickViewModal } from '../common/QuickViewModal';
import { ToastContainer } from '../common/ToastContainer';
import { Footer } from '../common/Footer';
import { STOREFRONT_WEB_STANDARD_ID, type StorefrontWebNavigationBoundary, type StorefrontWebSurface } from './StorefrontWebStandard';
import { PaymentResultPage } from '../common/PaymentResultPage';

type StorefrontWebFrameProps = {
  surface?: StorefrontWebSurface;
  navigationBoundary?: StorefrontWebNavigationBoundary;
};

export const StorefrontWebFrame: React.FC<StorefrontWebFrameProps> = ({ surface = 'laptop', navigationBoundary = 'showcase' }) => {
  const { laptopPage, setLaptopPage, activePaymentId, activePaymentSession } = useMall();

  const handleSelectTab = (tab: LaptopPage) => {
    setLaptopPage(tab);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const renderLaptopContent = () => {
    if (activePaymentSession) return <PaymentResultPage session={activePaymentSession} />;
    if (activePaymentId) return <PaymentResultPage paymentId={activePaymentId} />;
    switch (laptopPage) {
      case 'home-1366':
        return <LaptopHomePage1366 onSelectTab={handleSelectTab} />;
      case 'home-1440':
        return <LaptopHomePage1440 onSelectTab={handleSelectTab} surface={surface} />;
      case 'category':
        return <LaptopCategoryPage onSelectTab={handleSelectTab} surface={surface} />;
      case 'detail':
        return <LaptopDetailPage onSelectTab={handleSelectTab} surface={surface} />;
      case 'cart':
        return <LaptopCartCheckoutPage onSelectTab={handleSelectTab} surface={surface} />;
      case 'orders':
        return <LaptopOrdersPage onSelectTab={handleSelectTab} surface={surface} />;
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
      <LaptopHeader activeTab={laptopPage} onSelectTab={handleSelectTab} surface={surface} />

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
