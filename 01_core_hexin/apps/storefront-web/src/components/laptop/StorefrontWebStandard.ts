import type { AppMode, LaptopPage } from '../../context/MallContext.types';

export const STOREFRONT_WEB_STANDARD_ID = 'smart-wing-storefront-web-v1' as const;

export const STOREFRONT_WEB_PAGES = ['home-1366', 'home-1440', 'category', 'detail', 'cart', 'orders'] as const satisfies readonly LaptopPage[];

export type StorefrontWebSurface = 'laptop' | 'desktop-1920';
export type StorefrontWebPresetId = 'laptop-1366' | 'laptop-1440' | 'desktop-1920';
export type StorefrontWebNavigationBoundary = 'production' | 'showcase';

const PREVIEW_ONLY_DEVICE_MODES = new Set<AppMode>(['mini-program', 'android-app', 'tablet-app']);

export function storefrontDeviceSwitchPolicy(boundary: StorefrontWebNavigationBoundary, mode: AppMode) {
  return {
    disabled: boundary === 'production' && PREVIEW_ONLY_DEVICE_MODES.has(mode),
    preservePath: boundary === 'production',
  } as const;
}

export type StorefrontWebPreset = {
  id: StorefrontWebPresetId;
  surface: StorefrontWebSurface;
  label: string;
  width: number;
  height: number;
  defaultPage: LaptopPage;
};

export const STOREFRONT_WEB_PRESETS = {
  'laptop-1366': {
    id: 'laptop-1366',
    surface: 'laptop',
    label: '13英寸 Laptop',
    width: 1366,
    height: 768,
    defaultPage: 'home-1366',
  },
  'laptop-1440': {
    id: 'laptop-1440',
    surface: 'laptop',
    label: '14英寸 Laptop',
    width: 1440,
    height: 900,
    defaultPage: 'home-1440',
  },
  'desktop-1920': {
    id: 'desktop-1920',
    surface: 'desktop-1920',
    label: '27英寸 Desktop',
    width: 1920,
    height: 1080,
    defaultPage: 'home-1440',
  },
} as const satisfies Record<StorefrontWebPresetId, StorefrontWebPreset>;

export const STOREFRONT_WEB_SURFACE_COPY = {
  laptop: {
    frameBadge: '13/14" Laptop 标准版',
    headerBadge: 'Web 标准版',
    pageSwitcherLabel: 'Web 标准 6 页面:',
    wideHomeBadge: '1440×900 展宽 4列全景版',
    wideHomeNotice: '📢 专为 14" 笔记本 HD 屏优化的四列密度展示 · 自动承载更多企采爆款与近况流',
    wideHomeGridBadge: '14" 四列全景',
    wideHomeContainer: '容器宽度: 1280px',
    wideHomeProductCount: 8,
    cartLayoutLabel: '1366×768 紧凑表单无遮挡',
    ordersLayoutLabel: '1366×768 密集表格布局',
  },
  'desktop-1920': {
    frameBadge: '27" Desktop 标准版',
    headerBadge: '27" Web 标准版',
    pageSwitcherLabel: 'Web 标准 6 页面:',
    wideHomeBadge: '1920×1080 桌面 5列全景版',
    wideHomeNotice: '📢 复用主打团 Web 标准组件，在 27 英寸桌面扩展内容密度与可视范围',
    wideHomeGridBadge: '27" 五列全景',
    wideHomeContainer: '内容容器: 1680px',
    wideHomeProductCount: 10,
    cartLayoutLabel: '1920×1080 宽屏结算无遮挡',
    ordersLayoutLabel: '1920×1080 宽屏订单布局',
  },
} as const satisfies Record<
  StorefrontWebSurface,
  {
    frameBadge: string;
    headerBadge: string;
    pageSwitcherLabel: string;
    wideHomeBadge: string;
    wideHomeNotice: string;
    wideHomeGridBadge: string;
    wideHomeContainer: string;
    wideHomeProductCount: number;
    cartLayoutLabel: string;
    ordersLayoutLabel: string;
  }
>;

export function defaultStorefrontWebPage(surface: StorefrontWebSurface): LaptopPage {
  return surface === 'desktop-1920' ? STOREFRONT_WEB_PRESETS['desktop-1920'].defaultPage : STOREFRONT_WEB_PRESETS['laptop-1366'].defaultPage;
}
