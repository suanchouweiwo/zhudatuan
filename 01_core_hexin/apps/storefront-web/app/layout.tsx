import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import './globals.css';

export const dynamic = 'force-dynamic';

const firstPaintGuardCss = `
  html {
    min-width: 320px;
    background: #f5f7fa;
  }

  body {
    margin: 0;
    background: #f5f7fa;
    color: #172033;
    font-family: Arial, "PingFang SC", "Microsoft YaHei", sans-serif;
  }

  body > * {
    visibility: hidden;
  }

  #sw-first-paint {
    position: fixed;
    inset: 0;
    z-index: 2147483647;
    display: flex;
    visibility: visible;
    align-items: center;
    justify-content: center;
    background: #f5f7fa;
  }

  #sw-first-paint-card {
    display: flex;
    width: min(78vw, 280px);
    align-items: center;
    gap: 14px;
    border: 1px solid #dbe7ff;
    border-radius: 18px;
    background: #ffffff;
    padding: 18px;
    box-shadow: 0 8px 28px rgba(20, 58, 143, 0.10);
  }

  #sw-first-paint-mark {
    display: flex;
    width: 42px;
    height: 42px;
    flex: 0 0 42px;
    align-items: center;
    justify-content: center;
    border-radius: 14px;
    background: #143A8F;
    color: #ffffff;
    font-size: 22px;
    font-weight: 800;
  }

  #sw-first-paint-copy {
    min-width: 0;
  }

  #sw-first-paint-title,
  #sw-first-paint-note {
    display: block;
  }

  #sw-first-paint-title {
    color: #172033;
    font-size: 15px;
    font-weight: 800;
  }

  #sw-first-paint-note {
    margin-top: 4px;
    color: #64748b;
    font-size: 12px;
  }

  @media (prefers-reduced-motion: no-preference) {
    #sw-first-paint-mark {
      animation: sw-first-paint-pulse 1.2s ease-in-out infinite alternate;
    }
  }

  @keyframes sw-first-paint-pulse {
    from { opacity: 0.72; transform: scale(0.96); }
    to { opacity: 1; transform: scale(1); }
  }
`;

const publicCatalogBootstrapScript = `
  (function () {
    if (location.pathname !== '/' && location.pathname !== '/h5') return;
    try {
      var request = fetch('/api/v1/catalog/public/products?limit=100', {
        method: 'GET',
        headers: { accept: 'application/json' },
        credentials: 'omit',
        redirect: 'error'
      });
      self.__SW_PUBLIC_CATALOG_RESPONSE__ = request.catch(function () { return null; });
      request.then(function (response) {
        if (!response.ok) return;
        return response.clone().json().then(function (payload) {
          var item = payload && payload.items && payload.items[0];
          if (!item || !item.coverUrl) return;
          var imageUrl = new URL(item.coverUrl, location.href);
          if (imageUrl.hostname === 'images.unsplash.com') {
            imageUrl.searchParams.set('w', devicePixelRatio >= 2.5 ? '168' : '112');
            imageUrl.searchParams.set('q', '72');
            imageUrl.searchParams.set('auto', 'format');
            imageUrl.searchParams.set('fit', 'crop');
          }
          var preload = document.createElement('link');
          preload.rel = 'preload';
          preload.as = 'image';
          preload.href = imageUrl.href;
          preload.setAttribute('fetchpriority', 'high');
          document.head.appendChild(preload);
        });
      }).catch(function () {});
    } catch (_) {}
  }());
`;

export async function generateMetadata(): Promise<Metadata> {
  const storefrontHost = (await headers()).get('host') ?? 'www.zhudatuan.com';
  const hostname = storefrontHost.split(':')[0].toLowerCase();
  const storefrontOrigin = hostname === 'zhudatuan.com' || hostname === 'www.zhudatuan.com'
    ? 'https://www.zhudatuan.com'
    : `https://${storefrontHost}`;

  return {
    metadataBase: new URL(storefrontOrigin),
    alternates: { canonical: '/' },
    title: '主打团商城｜企业员工福利平台',
    description: '面向企业员工的福利商品、卡券、生活服务和订单管理平台，由雍彻科技提供技术服务。',
    applicationName: '主打团商城',
    manifest: '/manifest.webmanifest',
    icons: {
      icon: [{ url: '/icon.svg?v=zhudatuan-l0', type: 'image/svg+xml' }],
      apple: [{ url: '/apple-icon.png?v=zhudatuan-l0', sizes: '180x180', type: 'image/png' }],
    },
    openGraph: {
      type: 'website',
      locale: 'zh_CN',
      url: '/',
      siteName: '主打团',
      title: '主打团商城｜企业员工福利平台',
      description: '面向企业员工的福利商品、卡券、生活服务和订单管理平台。',
      images: [{ url: '/opengraph-image.png?v=zhudatuan-l0', width: 1600, height: 400, alt: '主打团商城' }],
    },
    twitter: {
      card: 'summary_large_image',
      title: '主打团商城｜企业员工福利平台',
      description: '面向企业员工的福利商品、卡券、生活服务和订单管理平台。',
      images: ['/opengraph-image.png?v=zhudatuan-l0'],
    },
    formatDetection: { email: false, address: false, telephone: false },
  };
}

export const viewport: Viewport = {
  colorScheme: 'light',
  themeColor: '#143A8F',
  viewportFit: 'cover',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const nodeRegistry = process.env.SFL_STOREFRONT_IDENTITY_NODE_REGISTRY
    ?? process.env.NEXT_PUBLIC_IDENTITY_NODE_REGISTRY;
  const nodeRuntimeScript = nodeRegistry?.trim()
    ? `window.__SFL_STOREFRONT_IDENTITY_NODE_REGISTRY__=${escapeInlineJson(nodeRegistry)};`
    : '';
  return (
    <html lang="zh-CN">
      <head>
        <link rel="preconnect" href="https://images.unsplash.com" crossOrigin="anonymous" />
        <style id="sw-first-paint-guard" dangerouslySetInnerHTML={{ __html: firstPaintGuardCss }} />
        <script id="sw-node-runtime" dangerouslySetInnerHTML={{ __html: nodeRuntimeScript }} />
        <script id="sw-public-catalog-bootstrap" dangerouslySetInnerHTML={{ __html: publicCatalogBootstrapScript }} />
      </head>
      <body>
        <div id="sw-first-paint" role="status" aria-live="polite" aria-label="商城正在加载">
          <div id="sw-first-paint-card">
            <span id="sw-first-paint-mark" aria-hidden="true"><img src="/brand/morvia-mark-white.svg" alt="" width="32" height="32" /></span>
            <span id="sw-first-paint-copy">
              <strong id="sw-first-paint-title">主打团商城</strong>
              <span id="sw-first-paint-note">网络较慢，正在准备商城…</span>
            </span>
          </div>
        </div>
        {children}
      </body>
    </html>
  );
}

function escapeInlineJson(source: string): string {
  try {
    return JSON.stringify(JSON.parse(source)).replaceAll('<', '\\u003c');
  } catch {
    return 'null';
  }
}
