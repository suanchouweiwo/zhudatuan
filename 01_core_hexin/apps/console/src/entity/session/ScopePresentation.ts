import type { ConsoleScope } from './ConsoleSession';

const scopeLabels = Object.freeze({
  platform: '平台',
  distributor: '分销组织',
  tenant: '商户',
  enterprise: '集团',
  mall: '商城',
  department: '部门',
  supplier: '供应商',
  brand: '品牌',
  store: '门店',
  owner: '个人',
  self: '本人',
} satisfies Record<ConsoleScope['kind'], string>);

export function scopeKindLabel(kind: string): string {
  return kind in scopeLabels
    ? scopeLabels[kind as ConsoleScope['kind']]
    : normalizeConsoleCopy(kind);
}

export function scopeDisplayName(scope: Pick<ConsoleScope, 'kind' | 'id' | 'name'>): string {
  return scope.name === undefined
    ? scopeIdentifierLabel(scope.kind, scope.id)
    : normalizeConsoleCopy(scope.name);
}

export function scopeIdentifierLabel(kind: string, id: string): string {
  const prefix = new RegExp(`^${escapeRegExp(kind)}[:_-]?`, 'i');
  const withoutKind = id.replace(prefix, '');
  return normalizeConsoleCopy(withoutKind || id);
}

export function normalizeConsoleCopy(value: string): string {
  return value
    .replace(/(?:MORVIA[\s·_-]*)?(?:zhudatuan[\s·_-]*)?主打团|MORVIA|Smart[\s_-]*Wing|智慧翼|築店|福福网|zhudatuan/gi, '主打团')
    .replace(/租户/g, '商户');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
