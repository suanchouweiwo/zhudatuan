import { can } from './auth';
import { PERMISSIONS } from '@smart-wing/api-contract';
import { apiError } from './http';
import { json, methodNotAllowed } from './http';
import { loadMemberAssurance } from './identityAssurance';
import { authorizationScope } from './routerSupport';
import { callRpc } from './postgresRpc';
import type { AuthorizationContext, WorkerEnv } from './types';

interface BootstrapRow {
  mallName: string;
  brandName: string;
  enterpriseName: string;
}

interface MemberProfileRow {
  displayName: string;
  employeeNo: string;
  departmentName: string | null;
  phoneMasked: string | null;
}

interface AccountRow {
  id: string;
  account_type: string;
  balance_cents: number;
  status: string;
  updated_at: string;
}

export async function handleBootstrap(request: Request, env: WorkerEnv, authorization: AuthorizationContext, requestId: string): Promise<Response> {
  if (request.method !== 'GET') return methodNotAllowed(['GET'], requestId);
  if (!can(authorization, PERMISSIONS.catalogRead)) return apiError(403, 'FORBIDDEN', '没有读取商城初始化信息的权限', requestId);
  const [scope, assurance, profile] = await Promise.all([
    callRpc<BootstrapRow | null>(env, 'api_bootstrap', authorizationScope(authorization)),
    loadMemberAssurance(env, authorization.membership.memberId),
    callRpc<MemberProfileRow | null>(env, 'api_storefront_member_profile', authorizationScope(authorization, true)),
  ]);
  if (!profile) return apiError(403, 'MEMBER_PROFILE_UNAVAILABLE', '当前会员资料不可用', requestId);
  return json({
    actor: {
      userId: authorization.userId,
      employeeNo: profile.employeeNo,
      displayName: profile.displayName,
      departmentName: profile.departmentName,
      phoneMasked: profile.phoneMasked,
      roles: authorization.roles,
      permissions: authorization.permissions,
      assurance: assurance ?? {
        level: 'account',
        accountAuthenticated: true,
        accountAuthenticatedAt: '',
        phoneVerified: false,
        phoneVerifiedAt: null,
        phoneVerificationMethod: null,
        paymentEligible: false,
        restrictedCapabilities: ['order.create', 'payment.execute'],
      },
    },
    scope: {
      tenantId: authorization.tenantId,
      enterpriseId: authorization.enterpriseId,
      mallId: authorization.mallId,
      mallCode: authorization.mallCode,
      mallName: scope?.mallName ?? '',
      brandName: scope?.brandName ?? '',
      enterpriseName: scope?.enterpriseName ?? '',
    },
    requestId,
  });
}

export async function handleAccounts(request: Request, env: WorkerEnv, authorization: AuthorizationContext, requestId: string): Promise<Response> {
  if (request.method !== 'GET') return methodNotAllowed(['GET'], requestId);
  if (!can(authorization, PERMISSIONS.orderRead)) return apiError(403, 'FORBIDDEN', '没有查看账户的权限', requestId);
  const rows = await callRpc<AccountRow[]>(env, 'api_accounts', authorizationScope(authorization, true));
  return json({
    items: rows.map((row) => ({
      id: row.id,
      type: row.account_type,
      balanceCents: Number(row.balance_cents),
      status: row.status,
      updatedAt: row.updated_at,
    })),
    requestId,
  });
}

export async function handleAccountLedgers(request: Request, env: WorkerEnv, authorization: AuthorizationContext, requestId: string): Promise<Response> {
  if (request.method !== 'GET') return methodNotAllowed(['GET'], requestId);
  if (!can(authorization, PERMISSIONS.orderRead)) return apiError(403, 'FORBIDDEN', '没有查看账户流水的权限', requestId);
  const rows = await callRpc<Array<Record<string, unknown>>>(env, 'api_account_ledgers', authorizationScope(authorization, true));
  return json({ items: rows, requestId });
}
