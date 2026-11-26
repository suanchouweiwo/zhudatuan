import { useEffect, useRef } from 'react';
import { useMall } from '../../context/MallContext';

export function MobileShippingAddressEntry({ responsive = false }: { responsive?: boolean }) {
  const { setMpPage } = useMall();
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;
    handled.current = true;
    if (responsive && window.matchMedia('(min-width: 768px)').matches) return;
    if (new URLSearchParams(window.location.search).get('view') === 'shipping-address') {
      setMpPage('address');
    }
  }, [responsive, setMpPage]);

  return null;
}
