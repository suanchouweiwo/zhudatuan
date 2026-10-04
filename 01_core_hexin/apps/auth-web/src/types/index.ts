/**
 * 主打团商城 - 类型定义
 * 技术服务方：雍彻科技
 */

export type MembershipStatus = 'invited' | 'active' | 'suspended' | 'offboarded' | 'expired';

export type MembershipTarget = 'storefront' | 'admin';

export type LoginMethod = 'otp' | 'password' | 'work_weixin' | 'sso';

export interface Membership {
  id: string;
  target: MembershipTarget;
  status: MembershipStatus;
  enterpriseName: string;
  storeName: string;
  roleName: string;
  dataScope: string;
  accountTypeLabel?: '福利账户' | '餐卡' | string;
  subjectScope?: '租户' | '企业' | '供应商' | '商城';
  keyPermissions?: string[];
  authorizedBy?: string;
  expireAt?: string;
  requiresStepUp?: boolean;
}

export interface PreAuthContext {
  phone?: string;
  identifier?: string;
  loginMethod: LoginMethod;
  requiresPasswordReset?: boolean;
  memberships: Membership[];
}

export interface LockoutState {
  isLocked: boolean;
  remainingSeconds: number;
  failedAttempts: number;
}

export type DomainType = string;

export interface MallContextType {
  currentDomain: DomainType;
  acceptedTerms: boolean;
  setAcceptedTerms: (accepted: boolean) => void;
}
