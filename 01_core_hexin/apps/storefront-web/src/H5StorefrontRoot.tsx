'use client';

import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { ProductionMobileFrame } from './components/mobile/ProductionMobileFrame';
import { MallProvider, useMall } from './context/MallContext';

const H5WechatIdentityBridge = lazy(() => import('./components/mobile/H5WechatIdentityBridge').then(({ H5WechatIdentityBridge }) => ({ default: H5WechatIdentityBridge })));

/** The dedicated consumer H5 entry never renders a desktop storefront. */
export function H5StorefrontRoot() {
  return (
    <MallProvider initialPath="/mini-program">
      <H5DocumentTitle />
      <H5ShippingAddressEntry />
      <DeferredWechatIdentityBridge />
      <ProductionMobileFrame />
    </MallProvider>
  );
}

function H5ShippingAddressEntry() {
  const { setMpPage } = useMall();
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;
    handled.current = true;
    if (new URLSearchParams(window.location.search).get('view') === 'shipping-address') {
      setMpPage('address');
    }
  }, [setMpPage]);

  return null;
}

function DeferredWechatIdentityBridge() {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    if (/MicroMessenger/i.test(navigator.userAgent)) setEnabled(true);
  }, []);

  return enabled ? <Suspense fallback={null}><H5WechatIdentityBridge /></Suspense> : null;
}

function H5DocumentTitle() {
  const { currentMall } = useMall();

  useEffect(() => {
    document.title = `${currentMall.mallName}｜消费者商城`;
  }, [currentMall.mallName]);

  return null;
}
