import type { ReactElement } from 'react';

const assets = Object.freeze({
  lockup: {
    normal: new URL('./brand/brand-lockup-horizontal.svg', import.meta.url).href,
    inverse: new URL('./brand/brand-lockup-horizontal-white.svg', import.meta.url).href,
  },
  mark: {
    normal: new URL('./brand/brand-mark.svg', import.meta.url).href,
    inverse: new URL('./brand/brand-mark-white.svg', import.meta.url).href,
  },
});

export interface BrandProps {
  readonly variant?: keyof typeof assets;
  readonly product?: string;
  readonly inverse?: boolean;
}

export function Brand({ variant = 'lockup', product, inverse = false }: BrandProps): ReactElement<{ readonly className: string }> {
  return <span className={`swbrand swbrand-${variant}${inverse ? ' swbrand-inverse' : ''}`}>
    <img src={assets[variant][inverse ? 'inverse' : 'normal']} alt={variant === 'lockup' ? 'MORVIA · zhudatuan 主打团' : 'MORVIA'} />
    {product === undefined ? null : <span className="swbrandcopy"><strong>MORVIA</strong><small>{product}</small></span>}
  </span>;
}
