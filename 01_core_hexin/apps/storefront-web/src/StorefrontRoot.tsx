'use client';

import { lazy, Suspense, useEffect, useState } from 'react';
import { ProductionMobileFrame } from './components/mobile/ProductionMobileFrame';
import { MobileShippingAddressEntry } from './components/mobile/MobileShippingAddressEntry';
import { MallProvider, useMall } from './context/MallContext';

const StorefrontWebFrame = lazy(() => import('./components/laptop/LaptopFrame')
  .then(({ StorefrontWebFrame: Component }) => ({ default: Component })));

function ProductionStorefrontFrame() {
  const { appMode } = useMall();
  const surface = appMode === 'pc' ? 'desktop-1920' : 'laptop';
  const desktopMounted = useDesktopMount();

  return (
    <>
      <div className="md:hidden">
        <MobileShippingAddressEntry responsive />
        <ProductionMobileFrame />
      </div>
      <div className="hidden md:block">
        {desktopMounted ? (
          <Suspense fallback={<div className="min-h-screen bg-[#F5F7FA]" aria-label="正在打开商城" />}>
            <StorefrontWebFrame surface={surface} navigationBoundary="production" />
          </Suspense>
        ) : null}
      </div>
    </>
  );
}

function useDesktopMount(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const media = window.matchMedia('(min-width: 768px)');
    const sync = () => setMounted(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);
  return mounted;
}

/**
 * The only production consumer-Web entry.
 *
 * It uses the approved smart-wing-storefront-web-v1 component tree while
 * keeping production data authoritative. Demo data remains isolated behind
 * the explicit device-preview routes.
 */
export function StorefrontRoot() {
  return (
    <MallProvider initialPath="/desktop-1920">
      <ProductionStorefrontFrame />
    </MallProvider>
  );
}
