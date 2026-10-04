/** 后台视觉参数只引用 console-theme.css；不声明认证、业务数据或实例配置。 */
export const defaultTokens = {
  brand: {
    name: '主打团', englishName: '主打团', subTitle: '运营管理后台',
    domain: { portal: 'www.zhudatuan.com', console: 'console.zhudatuan.com', accounts: 'accounts.zhudatuan.com' },
    colors: {
      deepBlue: 'var(--console-brand)', deepBlueHover: 'var(--console-brand-hover)',
      accentBlue: 'var(--console-accent)', accentBlueHover: 'var(--console-accent-hover)',
      accentBlueSubtle: 'var(--console-accent-subtle)', accentBlueBorder: 'var(--console-accent-border)',
    },
  },
  neutrals: {
    canvas: 'var(--console-canvas)', surface: 'var(--console-surface)', surfaceSubtle: 'var(--console-subtle)',
    border: 'var(--console-border)', borderSubtle: 'var(--console-border)', borderStrong: 'var(--console-border-strong)',
    textPrimary: 'var(--console-text)', textSecondary: 'var(--console-text-secondary)', textMuted: 'var(--console-text-muted)', textDisabled: 'var(--console-text-disabled)',
  },
  states: {
    success: { main: 'var(--console-success)', bg: 'var(--console-success-bg)', border: 'var(--console-success-border)', text: 'var(--console-success-text)' },
    warning: { main: 'var(--console-warning)', bg: 'var(--console-warning-bg)', border: 'var(--console-warning-border)', text: 'var(--console-warning-text)' },
    error: { main: 'var(--console-danger)', bg: 'var(--console-danger-bg)', border: 'var(--console-danger-border)', text: 'var(--console-danger-text)' },
    info: { main: 'var(--console-info)', bg: 'var(--console-info-bg)', border: 'var(--console-info-border)', text: 'var(--console-info-text)' },
  },
  geometry: { radiusDefault: 'var(--console-radius)', radiusContainer: 'var(--console-radius)', radiusCircle: 'var(--console-radius-circle)', borderWidth: 'var(--console-border-width)' },
  spacing: { xs: 'var(--console-space-xs)', sm: 'var(--console-space-sm)', md: 'var(--console-space-md)', lg: 'var(--console-space-lg)', xl: 'var(--console-space-xl)', xxl: 'var(--console-space-xxl)', xxxl: 'var(--console-space-xxxl)' },
  typography: {
    fontSans: 'var(--console-font-sans)', fontMono: 'var(--console-font-mono)',
    sizes: { caption: 'var(--console-font-caption)', bodySm: 'var(--console-font-body-sm)', body: 'var(--console-font-size)', subhead: 'var(--console-font-subhead)', title: 'var(--console-font-title)', pageTitle: 'var(--console-font-page-title)' },
  },
  density: {
    comfortable: { tableRowHeight: 'var(--console-row-height-comfortable)', tablePaddingY: 'var(--console-table-padding-comfortable)', inputHeight: 'var(--console-input-height-comfortable)', buttonPaddingY: 'var(--console-button-padding-comfortable)', fontSize: 'var(--console-font-size-comfortable)' },
    compact: { tableRowHeight: 'var(--console-row-height-compact)', tablePaddingY: 'var(--console-table-padding-compact)', inputHeight: 'var(--console-input-height-compact)', buttonPaddingY: 'var(--console-button-padding-compact)', fontSize: 'var(--console-font-size-compact)' },
  },
} as const;

export type DesignTokens = typeof defaultTokens;

export const BLUE_SEMANTIC_GUIDE = [
  { role: '品牌蓝', category: '品牌与结构', scenarios: ['正式品牌资产与系统层级标记', '导航选中态的结构锚点'], description: '正式 M 图形使用现有资产，不根据界面色值重新绘制。' },
  { role: '交互蓝', category: '交互与状态', scenarios: ['主要按钮、链接、输入焦点', '选中页签、复选框与图表主线'], description: '由当前浅色或深色主题的语义参数提供。' },
] as const;
