import type { ConsoleModuleManifest } from '../../entity/navigation/ConsoleModuleManifest';

export const applicationsModule = {
  id: 'applications',
  status: 'enabled',
  navigation: {
    placement: 'main',
    group: 'commerce',
    order: 30,
    label: '商城与应用',
    icon: 'building',
    labelByScopeKind: {
      platform: '主打团 · 商城管理',
      distributor: '应用治理',
      tenant: '应用治理',
      enterprise: '主打团 · 商城管理',
      mall: '店铺装修',
    },
  },
  routes: [{
    id: 'applications.index',
    path: 'applications',
    kind: 'entry',
    lazy: () => import('./ApplicationRoute'),
    operations: [
      'experience.applications.read',
      'experience.applications.create',
      'experience.applications.update',
      'experience.applications.copy',
      'provisioning.malls.create',
    ],
    presentation: {
      title: '商城与应用',
      summary: '按当前范围管理商城、应用、装修与发布',
      byScopeKind: {
        platform: { title: '应用治理', summary: '跨商城查看应用、版本、发布状态、域名绑定与治理异常。' },
        distributor: { title: '应用治理', summary: '跨商城查看应用、版本、发布状态、域名绑定与治理异常。' },
        tenant: { title: '应用治理', summary: '跨商城查看应用、版本、发布状态、域名绑定与治理异常。' },
        enterprise: { title: '商城管理', summary: '创建、复制、进入和管理集团旗下商城，并跟踪开店与发布进度。' },
        mall: { title: '店铺装修', summary: '管理页面、模板、导航、预览和发布，让当前商城形成完整消费入口。' },
      },
    },
  }],
} as const satisfies ConsoleModuleManifest<'applications'>;
