import type { UserProfile } from '../types';
import type { ApiBootstrap } from '../services/productionApi.types';

export function mergeAuthenticatedMemberProfile(previous: UserProfile, bootstrap: ApiBootstrap): UserProfile {
  return {
    ...previous,
    id: bootstrap.actor.userId,
    identityCode: bootstrap.actor.identityCode,
    employeeId: bootstrap.actor.employeeNo,
    name: bootstrap.actor.displayName,
    avatar: '',
    phone: bootstrap.actor.phoneMasked ?? '未绑定',
    jobTitle: '员工会员',
    department: bootstrap.actor.departmentName ?? '未分配部门',
    enterpriseId: bootstrap.scope.enterpriseId,
    enterpriseName: bootstrap.scope.enterpriseName,
    currentMallId: bootstrap.scope.mallId,
    assuranceLevel: bootstrap.actor.assurance.level,
    phoneVerified: bootstrap.actor.assurance.phoneVerified,
    paymentEligible: bootstrap.actor.assurance.paymentEligible,
    couponCount: 0,
  };
}
