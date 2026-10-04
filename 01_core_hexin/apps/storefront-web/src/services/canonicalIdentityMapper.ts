import type { RequestScope } from '@shop/sdk';
import type { ApiBootstrap, ApiDeliveryAddress } from './productionApi.types';
import type { CanonicalSessionContext } from './canonicalApiClient';
import { asDate, optionalText, pageItems, record, records, text, version } from './canonicalShape';
import { ProductionApiError } from './productionApi.error';
import type { StorefrontPresentationIdentity } from '../config/storefrontIdentity';

const SCOPE_KINDS = new Set(['platform', 'distributor', 'tenant', 'enterprise', 'mall', 'department', 'supplier', 'brand', 'store', 'owner', 'self']);

export interface CanonicalSessionProjection extends CanonicalSessionContext {
  readonly permissions: readonly string[];
  readonly target: string;
  readonly assuranceLevel: number;
  readonly phoneMasked: string | null;
  readonly syncedAt: string;
}

export function mapCanonicalSession(value: unknown): CanonicalSessionProjection {
  const source = record(value, 'identity.session');
  const target = text(source.target, 'identity.session.target');
  if (target !== 'storefront') throw new ProductionApiError('当前会话不属于消费者商城', 403, 'IDENTITY_TARGET_MISMATCH');
  const identityScope = mapScope(source.scope, 'identity.session.scope');
  const scopes = source.scopes === undefined ? [identityScope] : records(source.scopes, 'identity.session.scopes').map((item, index) => mapScope(item, `identity.session.scopes[${index}]`));
  const scope = scopes.find((candidate) => candidate.kind === 'mall') ?? identityScope;
  const assurance = record(source.assurance, 'identity.session.assurance');
  const security = source.security === undefined ? {} : record(source.security, 'identity.session.security');
  return Object.freeze({
    actor: text(source.actor, 'identity.session.actor'),
    session: text(source.session, 'identity.session.session'),
    membership: text(source.membership, 'identity.session.membership'),
    scope,
    scopes: Object.freeze(scopes),
    accessVersion: version(source.accessVersion, 'identity.session.accessVersion'),
    permissions: Object.freeze(stringList(source.permissions)),
    target,
    assuranceLevel: version(assurance.level, 'identity.session.assurance.level'),
    phoneMasked: optionalText(security.phoneMasked),
    syncedAt: asDate(source.syncedAt),
    ...(optionalText(source.csrf) ? { csrf: optionalText(source.csrf)! } : {}),
  });
}

export function mapCanonicalBootstrap(
  session: CanonicalSessionProjection,
  profileValue: unknown,
  presentation: StorefrontPresentationIdentity = { mallName: '主打团商城', brandName: '主打团' },
): ApiBootstrap {
  const profile = record(profileValue, 'member.profile');
  const mall = session.scopes.find((scope) => scope.kind === 'mall') ?? (session.scope.kind === 'mall' ? session.scope : session.scope);
  const mallName = optionalText(profile.organization_name) ?? presentation.mallName;
  const enterprise = session.scopes.find((scope) => scope.kind === 'enterprise');
  const tenant = session.scopes.find((scope) => scope.kind === 'tenant');
  const phoneVerified = session.assuranceLevel >= 2;
  return {
    actor: {
      userId: text(profile.id, 'member.profile.id'),
      employeeNo: optionalText(profile.employee_no) ?? session.membership,
      displayName: text(profile.display_name, 'member.profile.display_name'),
      departmentName: null,
      phoneMasked: session.phoneMasked,
      roles: [],
      permissions: [...session.permissions],
      assurance: {
        level: phoneVerified ? 'phone' : 'account',
        accountAuthenticated: true,
        accountAuthenticatedAt: session.syncedAt,
        phoneVerified,
        phoneVerifiedAt: phoneVerified ? session.syncedAt : null,
        phoneVerificationMethod: phoneVerified ? 'session_assurance' : null,
        paymentEligible: phoneVerified,
        restrictedCapabilities: phoneVerified ? [] : ['order.create', 'payment.execute'],
      },
    },
    scope: {
      tenantId: tenant?.id ?? '',
      enterpriseId: enterprise?.id ?? mall.id,
      mallId: mall.id,
      mallCode: mall.id,
      mallName,
      brandName: presentation.brandName,
      enterpriseName: '已授权企业',
    },
  };
}

export function mapCanonicalAddresses(value: unknown): ApiDeliveryAddress[] {
  return pageItems(value, 'member.addresses').map((item) => {
    const region = optionalText(item.region_code) ?? '';
    const [province = region, city = '', district = ''] = region.split('/');
    return {
      id: text(item.id, 'member.address.id'),
      name: optionalText(item.recipient_masked) ?? '已加密',
      phone: optionalText(item.mobile_masked) ?? '已加密',
      province,
      city,
      district,
      detail: optionalText(item.address_masked) ?? '地址已加密',
      tag: '已加密地址',
      isDefault: item.is_default === true,
      version: version(item.version, 'member.address.version'),
    };
  }).sort((left, right) => Number(right.isDefault) - Number(left.isDefault) || left.id.localeCompare(right.id));
}

function mapScope(value: unknown, label: string): RequestScope {
  const source = record(value, label);
  const kind = text(source.kind, `${label}.kind`);
  if (!SCOPE_KINDS.has(kind)) throw new ProductionApiError('登录会话返回了无效的数据范围', 502, 'IDENTITY_SCOPE_KIND_INVALID');
  return Object.freeze({ kind: kind as RequestScope['kind'], id: text(source.id, `${label}.id`) });
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}
