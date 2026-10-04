export type ConsoleReleaseChangeKind = '新增' | '优化' | '修复';

export interface ConsoleReleaseChangeGroup {
  readonly kind: ConsoleReleaseChangeKind;
  readonly items: readonly string[];
}

export interface ConsoleRelease {
  readonly version: `v${number}.${number}.${number}`;
  readonly title: string;
  readonly releasedAt: string;
  readonly surface: string;
  readonly status: 'current' | 'released' | 'infrastructure';
  readonly changes: readonly ConsoleReleaseChangeGroup[];
  readonly channel: string;
  readonly target: string;
  readonly sourceSha?: string;
}

export const CONSOLE_RELEASES = Object.freeze([
  {
    version: 'v1.1.0',
    title: '工程与架构中心正式上线',
    releasedAt: '2026 年 9 月 14 日',
    surface: '主打团 Console',
    status: 'current',
    changes: [
      { kind: '新增', items: ['工程与架构总览', '运行状态与发布版本页面', '故障与技术支持入口', '中文版本更新账本'] },
      { kind: '优化', items: ['个人中心升级为 ZHU-VI 1.5', '个人中心、工程与架构、服务中心统一排列', '左下角增加当前生产版本入口'] },
    ],
    channel: '1.3',
    target: 'hbbtzn-l1 / console',
  },
  {
    version: 'v1.0.4',
    title: '登录体验与首屏速度优化',
    releasedAt: '2026 年 9 月 13 日',
    surface: 'Identity / Auth Web',
    status: 'released',
    changes: [
      { kind: '优化', items: ['移除无效运行配置请求', '登录首屏不再等待品牌字体', '登录 HTML 使用精确边缘缓存规则'] },
    ],
    channel: '1.2',
    target: 'hbbtzn-l1 / auth-web',
    sourceSha: '0c9c7fb9f2040da8d1e10a37c036b0358da88587',
  },
  {
    version: 'v1.0.3',
    title: '部署通道 1.3 正式成立',
    releasedAt: '2026 年 9 月 13 日',
    surface: '交付基础设施',
    status: 'infrastructure',
    changes: [
      { kind: '新增', items: ['GitHub 生成精确制品', '阿里云 OSS 保存不可变制品', '阿里云 ECS 原子切换与自动回滚'] },
    ],
    channel: '1.3',
    target: 'L0 / L1 通用部署通道',
    sourceSha: 'b58fa3ad45dca09aea0ed586bd0f68492aad1a43',
  },
] as const satisfies readonly ConsoleRelease[]);

export const CURRENT_CONSOLE_RELEASE = CONSOLE_RELEASES[0];
