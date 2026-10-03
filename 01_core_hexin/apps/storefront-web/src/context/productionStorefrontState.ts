import type { EnterpriseMall, UserProfile } from '../types';

export const UNRESOLVED_MALL: EnterpriseMall = {
  id: 'unresolved',
  enterpriseId: '',
  enterpriseName: '尚未连接企业',
  mallName: 'MORVIA 主打团',
  logoText: 'MORVIA',
  badge: '数据库连接未建立',
  welcomeBanner: '登录后从生产数据库加载企业商品与权益。',
};

export const EMPTY_GUEST_PROFILE: UserProfile = {
  id: 'guest',
  employeeId: '未登录',
  name: '访客',
  avatar: '',
  phone: '未绑定',
  jobTitle: '访客',
  department: '未登录',
  enterpriseId: '',
  enterpriseName: '尚未连接企业',
  currentMallId: UNRESOLVED_MALL.id,
  welfareBalance: 0,
  mealBalance: 0,
  couponCount: 0,
  assuranceLevel: 'account',
  phoneVerified: false,
  paymentEligible: false,
};
