/**
 * 主打团 - 认证与权限 Mock 服务 (auth.ts)
 * 职责：模拟统一登录认证段、会员关系查询、Step-Up 二次验证、跨域票据交换及安全审计
 * 技术服务方：雍彻科技
 */

import { Membership, PreAuthContext, LockoutState } from '../types';
export { resolveAdminLoginOrigin, resolveStorefrontLoginOrigin } from './originPolicy';

// 内存中维护的登录失败记录（模拟服务端 Redis / DB 锁定策略）
interface FailureRecord {
  attempts: number;
  lockedUntil: number; // 时间戳
}

const failureMap: Record<string, FailureRecord> = {};
export const MAX_LOGIN_FAILURES = 10;
// 模拟审计日志
const auditLogs: Array<{ timestamp: string; identifier: string; reason: string }> = [];

export function buildCredentialLoginAction(targetOrigin: string): string {
  const action = new URL('/api/v1/auth/login', targetOrigin);
  action.searchParams.set('redirect', '/');
  return action.toString();
}

/**
 * Credential discovery currently returns one authoritative authorization.
 * Multiple usable memberships require a server-bound selection token; until
 * that contract exists the UI may display them, but it must not choose one in
 * the browser and silently create a session for another membership.
 */
export function requiresAuthoritativeMembershipSelection(memberships: Membership[]): boolean {
  return memberships.filter((membership) => membership.status === 'active' || membership.status === 'invited').length > 1;
}

// 模拟不同场景的预设会员关系数据集
const MOCK_MEMBERSHIPS_MAP: Record<string, Membership[]> = {
  // 13800138000: 综合多身份账号（混合员工与管理身份）
  '13800138000': [
    {
      id: 'mem_emp_001',
      target: 'storefront',
      status: 'active',
      enterpriseName: '腾讯科技（深圳）有限公司',
      storeName: '主打团·腾讯员工福利专区',
      roleName: '正式员工',
      dataScope: '个人福利包',
      accountTypeLabel: '福利账户',
    },
    {
      id: 'mem_emp_002',
      target: 'storefront',
      status: 'active',
      enterpriseName: '腾讯科技（深圳）有限公司',
      storeName: '主打团·园区美食餐厅',
      roleName: '正式员工',
      dataScope: '每日餐补',
      accountTypeLabel: '餐卡',
    },
    {
      id: 'mem_adm_001',
      target: 'admin',
      status: 'active',
      enterpriseName: '腾讯科技（深圳）有限公司',
      storeName: '主打团·企业福利运营后台',
      roleName: '企业福利超级管理员',
      dataScope: '全公司（12,500人）',
      subjectScope: '企业',
      keyPermissions: ['order.refund', 'role.grant', 'audit.read'],
      authorizedBy: '雍彻科技安全审计部 (admin_01)',
      expireAt: '2027-12-31',
      requiresStepUp: true,
    },
    {
      id: 'mem_adm_002',
      target: 'admin',
      status: 'active',
      enterpriseName: '雍彻科技（上海）有限公司',
      storeName: '主打团·特约供应商中心',
      roleName: '商品运营专员',
      dataScope: '华东大区专区',
      subjectScope: '供应商',
      keyPermissions: ['goods.publish', 'order.view'],
      authorizedBy: '张主管 (mgr_888)',
      expireAt: '2026-12-31',
      requiresStepUp: false,
    },
  ],

  // 13900139000: 单一高阶管理账号（1条记录且需StepUp，测试自动进入第3段）
  '13900139000': [
    {
      id: 'mem_adm_sys',
      target: 'admin',
      status: 'active',
      enterpriseName: '主打团（总部）运营中心',
      storeName: '主打团全域统一管理后台',
      roleName: '全域系统风控合规总监',
      dataScope: '全平台所有租户与企业',
      subjectScope: '租户',
      keyPermissions: ['order.refund', 'role.grant', 'audit.read', 'system.config'],
      authorizedBy: '雍彻科技首席安全官',
      expireAt: '2028-06-30',
      requiresStepUp: true,
    },
  ],

  // 13700137000: 单一员工账号（1条记录，测试自动跳过第2段直接完成）
  '13700137000': [
    {
      id: 'mem_emp_single',
      target: 'storefront',
      status: 'active',
      enterpriseName: '阿里巴巴（中国）有限公司',
      storeName: '主打团·阿里专享福利商城',
      roleName: '资深专家',
      dataScope: '个人专享额度',
      accountTypeLabel: '福利账户',
    },
  ],

  // 13600136000: 多种特殊状态账号（包含 invited, suspended, offboarded, expired）
  '13600136000': [
    {
      id: 'mem_status_invited',
      target: 'storefront',
      status: 'invited',
      enterpriseName: '美团点评集团',
      storeName: '主打团·美团员工特惠商城',
      roleName: '待入职员工',
      dataScope: '新员工礼包',
      accountTypeLabel: '福利账户',
    },
    {
      id: 'mem_status_suspended',
      target: 'storefront',
      status: 'suspended',
      enterpriseName: '字节跳动科技有限公司',
      storeName: '主打团·字节福利专区',
      roleName: '正式员工',
      dataScope: '暂停发放',
      accountTypeLabel: '福利账户',
    },
    {
      id: 'mem_status_offboarded',
      target: 'storefront',
      status: 'offboarded',
      enterpriseName: '百度在线网络技术公司',
      storeName: '主打团·百度福利商城',
      roleName: '离职员工',
      dataScope: '已归档',
      accountTypeLabel: '福利账户',
    },
    {
      id: 'mem_status_expired',
      target: 'storefront',
      status: 'expired',
      enterpriseName: '华为技术有限公司',
      storeName: '主打团·华为2025年度节日商城',
      roleName: '合约用户',
      dataScope: '2025周期已截止',
      accountTypeLabel: '福利账户',
    },
  ],

  // 13500135000: 无任何有效企业福利计划
  '13500135000': [],
};

/** Public-test fixtures mirror the real Membership IDs seeded in Supabase. */
export const TEST_ACCOUNT_MEMBERSHIPS: Record<string, Membership[]> = {
  业主测试员: [
    {
      id: 'membership-test-storefront',
      target: 'storefront',
      status: 'active',
      enterpriseName: '示范企业',
      storeName: '主打团',
      roleName: '测试员工',
      dataScope: '个人福利账户',
      accountTypeLabel: '福利账户',
    },
  ],
  福宝: [
    {
      id: 'membership-test-fubao-admin',
      target: 'admin',
      status: 'active',
      enterpriseName: '示范企业',
      storeName: '主打团运营后台',
      roleName: '商城管理员',
      dataScope: '主打团',
      subjectScope: '商城',
      keyPermissions: ['product.publish', 'order.ship'],
      authorizedBy: '测试租户管理员',
      expireAt: '2027-12-31',
      requiresStepUp: true,
    },
  ],
  经理1: [
    {
      id: 'membership-test-manager-admin',
      target: 'admin',
      status: 'active',
      enterpriseName: '示范企业',
      storeName: '主打团运营后台',
      roleName: '企业运营经理',
      dataScope: '示范企业 / 主打团',
      subjectScope: '企业',
      keyPermissions: ['order.refund', 'finance.reconcile'],
      authorizedBy: '测试租户管理员',
      expireAt: '2027-12-31',
      requiresStepUp: true,
    },
  ],
  onewr: [
    {
      id: 'membership-test-owner-admin',
      target: 'admin',
      status: 'active',
      enterpriseName: '主打团福利平台',
      storeName: '主打团运营后台',
      roleName: '平台业主',
      dataScope: '全租户',
      subjectScope: '租户',
      keyPermissions: ['tenant.manage', 'role.grant', 'order.refund'],
      authorizedBy: '系统初始化',
      expireAt: '2027-12-31',
      requiresStepUp: true,
    },
  ],
  李厚亿: [],
};
if (import.meta.env.DEV) TEST_ACCOUNT_MEMBERSHIPS.李厚亿 = TEST_ACCOUNT_MEMBERSHIPS.onewr;

const ROLE_TEST_MEMBERSHIP_DEFINITIONS: ReadonlyArray<{
  prefix: string;
  target: Membership['target'];
  roleName: string;
  dataScope: string;
  subjectScope?: Membership['subjectScope'];
  keyPermissions: string[];
  requiresStepUp: boolean;
}> = [
  { prefix: 'buyer', target: 'storefront', roleName: '测试买家', dataScope: '个人福利账户', keyPermissions: ['catalog.read', 'order.create', 'order.read'], requiresStepUp: false },
  { prefix: 'seller', target: 'admin', roleName: '测试商家', dataScope: '央企供应链', subjectScope: '供应商', keyPermissions: ['catalog.read', 'product.publish', 'order.read', 'order.ship'], requiresStepUp: false },
  { prefix: 'ops', target: 'admin', roleName: '测试运营', dataScope: '主打团', subjectScope: '商城', keyPermissions: ['catalog.read', 'product.publish', 'order.read', 'order.ship', 'audit.read'], requiresStepUp: false },
  { prefix: 'cs', target: 'admin', roleName: '测试客服', dataScope: '主打团', subjectScope: '商城', keyPermissions: ['catalog.read', 'order.read', 'member.read'], requiresStepUp: false },
  {
    prefix: 'admin',
    target: 'admin',
    roleName: '测试企业管理员',
    dataScope: '示范企业 / 主打团',
    subjectScope: '企业',
    keyPermissions: ['member.invite', 'member.disable', 'finance.reconcile', 'audit.read'],
    requiresStepUp: false,
  },
];

if (import.meta.env.DEV) {
  for (const definition of ROLE_TEST_MEMBERSHIP_DEFINITIONS) {
    for (let index = 1; index <= 5; index += 1) {
      const suffix = String(index).padStart(3, '0');
      TEST_ACCOUNT_MEMBERSHIPS[`${definition.prefix}${suffix}`] = [
        {
          id: `membership-test-${definition.prefix}-${suffix}`,
          target: definition.target,
          status: 'active',
          enterpriseName: '示范企业',
          storeName: definition.target === 'storefront' ? '主打团' : '主打团运营后台',
          roleName: definition.roleName,
          dataScope: definition.dataScope,
          accountTypeLabel: definition.target === 'storefront' ? '福利账户' : undefined,
          subjectScope: definition.subjectScope,
          keyPermissions: definition.keyPermissions,
          authorizedBy: '测试租户管理员',
          expireAt: '2027-12-31',
          requiresStepUp: definition.requiresStepUp,
        },
      ];
    }
  }
}

/**
 * 获取账号当前锁定状态
 */
export function getLockoutState(identifier: string): LockoutState {
  const record = failureMap[identifier];
  if (!record) {
    return { isLocked: false, remainingSeconds: 0, failedAttempts: 0 };
  }

  const now = Date.now();
  if (record.lockedUntil > now) {
    const remainingSeconds = Math.ceil((record.lockedUntil - now) / 1000);
    return {
      isLocked: true,
      remainingSeconds,
      failedAttempts: record.attempts,
    };
  }

  // 锁定时间已过，重置状态
  if (record.attempts >= MAX_LOGIN_FAILURES && record.lockedUntil <= now) {
    delete failureMap[identifier];
  }

  return {
    isLocked: false,
    remainingSeconds: 0,
    failedAttempts: record?.attempts || 0,
  };
}

/**
 * 上报登录失败记录（安全审计要求）
 */
export async function reportLoginFailure(identifier: string, reason: string): Promise<void> {
  const timestamp = new Date().toISOString();
  auditLogs.push({ timestamp, identifier, reason });
  console.warn(`[SECURITY AUDIT LOG] Login failure for "${identifier}": ${reason} at ${timestamp}`);

  // 增加失败计数
  if (!failureMap[identifier]) {
    failureMap[identifier] = { attempts: 1, lockedUntil: 0 };
  } else {
    failureMap[identifier].attempts += 1;
  }

  // 与服务端数据库策略一致：连续失败10次，锁定15分钟。
  if (failureMap[identifier].attempts >= MAX_LOGIN_FAILURES) {
    failureMap[identifier].lockedUntil = Date.now() + 15 * 60 * 1000;
    console.error(`[SECURITY ALERT] Identifier "${identifier}" locked for 15 minutes due to ${MAX_LOGIN_FAILURES} consecutive failures.`);
  }
}

/**
 * 1. 发送短信验证码
 */
export async function requestOtp(phone: string): Promise<{ success: boolean; message: string }> {
  // 校验手机号格式
  const cleanPhone = phone.trim();
  if (!/^1[3-9]\d{9}$/.test(cleanPhone)) {
    throw new Error('请输入正确的11位手机号码');
  }

  const lockout = getLockoutState(cleanPhone);
  if (lockout.isLocked) {
    throw new Error(`账号已锁定，请在 ${Math.ceil(lockout.remainingSeconds / 60)} 分钟后重试`);
  }

  throw new Error('短信验证码登录正在接入运营商，请先使用密码登录；新用户可使用注册验证码');
}

/**
 * 2. 手机号 + 短信验证码登录
 */
export async function loginWithOtp(phone: string, code: string): Promise<PreAuthContext> {
  const cleanPhone = phone.trim();
  const cleanCode = code.trim();

  // 检查锁定
  const lockout = getLockoutState(cleanPhone);
  if (lockout.isLocked) {
    throw new Error(`账号连续失败过多，已被锁定。剩余解封时间：${lockout.remainingSeconds} 秒`);
  }

  void cleanCode;
  throw new Error('短信验证码登录正在接入运营商，请先使用密码登录');
}

/**
 * 3. 工号/邮箱 + 密码登录
 */
export async function loginWithPassword(identifier: string, password: string): Promise<PreAuthContext> {
  const cleanId = identifier.trim();

  if (!cleanId || password.length === 0) {
    throw new Error('请输入账号与密码');
  }

  // 检查锁定
  const lockout = getLockoutState(cleanId);
  if (lockout.isLocked) {
    throw new Error(`账号已被锁定，请在 ${Math.ceil(lockout.remainingSeconds / 60)} 分钟后再试`);
  }

  const response = await fetch('/api/v1/auth/credential/discover', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: cleanId, password }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    await reportLoginFailure(cleanId, '密码验证失败');
    throw new Error(payload?.error?.message || '账号或密码不正确');
  }
  const membershipId = payload?.authorization?.membershipId;
  const target = payload?.authorization?.target;
  if (typeof membershipId !== 'string' || (target !== 'storefront' && target !== 'admin')) throw new Error('会员身份未正确建立');
  delete failureMap[cleanId];
  return {
    identifier: cleanId,
    loginMethod: 'password',
    requiresPasswordReset: payload.requiresPasswordReset === true,
    memberships: [
      {
        id: membershipId,
        target,
        status: 'active',
        enterpriseName: '已绑定企业',
        storeName: target === 'admin' ? '主打团运营后台' : '主打团商城',
        roleName: target === 'admin' ? '企业管理会员' : '企业员工会员',
        dataScope: target === 'admin' ? '已授权业务范围' : '个人福利账户',
        accountTypeLabel: target === 'storefront' ? '福利账户' : undefined,
      },
    ],
  };
}

export async function changeInitialPassword(username: string, password: string, newPassword: string): Promise<void> {
  const response = await fetch('/api/v1/auth/password/initial-change', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, newPassword }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error?.message || '初始密码修改失败');
}

export interface RegistrationOtpResult {
  challengeId: string;
  expiresInSeconds: number;
  resendAfterSeconds: number;
  debugCode?: string;
}

export async function requestRegistrationOtp(mobile: string): Promise<RegistrationOtpResult> {
  const response = await fetch('/api/v1/auth/registration/otp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mobile }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error?.message || '验证码发送失败');
  return payload as RegistrationOtpResult;
}

export async function registerMember(input: { mobile: string; challengeId: string; code: string; password: string; displayName: string; inviteCode: string }): Promise<{ registered: true; employeeNo: string }> {
  const response = await fetch('/api/v1/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error?.message || '注册失败');
  return payload;
}

export async function registerUsernameMember(input: {
  username: string;
  password: string;
  displayName: string;
  inviteCode: string;
  acceptedTerms: true;
}): Promise<{ registered: true; username: string; employeeNo: string; phoneBound: false }> {
  const response = await fetch('/api/v1/auth/register/username', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error?.message || '注册失败');
  return payload;
}

/**
 * 4. 接受邀请 API
 */
export async function acceptInvitation(_preAuthToken?: string, _membershipId?: string): Promise<never> {
  throw new Error('邀请接受服务尚未接通；浏览器不会模拟授权成功');
}

/**
 * 5. Step-Up 动态二次验证 (TOTP 6位)
 */
export async function verifyStepUp(_preAuthToken?: string, _membershipId?: string, _totpCode?: string): Promise<never> {
  throw new Error('正式二次验证服务尚未接通；系统不会接受固定口令或签发浏览器票据');
}
