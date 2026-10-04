import type { ConsoleScope } from '../../entity/session/ConsoleSession';

export type CommerceWorkspaceMode = 'governance' | 'management' | 'design';

export interface CommerceScopePresentation {
  readonly mode: CommerceWorkspaceMode;
  readonly navigationLabel: string;
  readonly title: string;
  readonly eyebrow: string;
  readonly description: string;
  readonly primaryAction: string;
  readonly ownership: string;
  readonly ownershipDetail: string;
}

const governance: CommerceScopePresentation = Object.freeze({
  mode: 'governance',
  navigationLabel: '应用治理',
  title: '应用治理',
  eyebrow: 'COMMERCE GOVERNANCE',
  description: '跨商城查看应用、版本、发布状态、域名绑定与治理异常。',
  primaryAction: '查看准入边界',
  ownership: '平台治理视角',
  ownershipDetail: '平台只负责应用与商城准入，不代替商户创建、装修或自行审批。',
});

const management: CommerceScopePresentation = Object.freeze({
  mode: 'management',
  navigationLabel: '商城管理',
  title: '商城管理',
  eyebrow: '主打团',
  description: '创建、查找和管理独立商城，并跟踪开店草稿与发布状态。',
  primaryAction: '创建商城',
  ownership: '商城控制面',
  ownershipDetail: '平台原子建立商城身份、初始商品池和开店草稿；商城建立后可独立装修与经营。',
});

const design: CommerceScopePresentation = Object.freeze({
  mode: 'design',
  navigationLabel: '店铺装修',
  title: '店铺装修',
  eyebrow: 'STOREFRONT DESIGN',
  description: '管理页面、模板、导航、预览和发布，让当前商城形成完整消费入口。',
  primaryAction: '进入装修',
  ownership: '商城装修视角',
  ownershipDetail: '当前范围只管理本商城页面与发布版本，不越权修改集团或其他商城。',
});

export function applicationScopePresentation(kind: ConsoleScope['kind']): CommerceScopePresentation {
  if (kind === 'distributor' || kind === 'tenant') return governance;
  if (kind === 'mall') return design;
  return management;
}
