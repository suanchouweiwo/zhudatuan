import type { EnterpriseMall, UserProfile } from '../types';
import { resolveStorefrontPresentationIdentity } from '../config/storefrontIdentity';

const presentation = resolveStorefrontPresentationIdentity();

export const UNRESOLVED_MALL: EnterpriseMall = {
  id: 'unresolved',
  enterpriseId: '',
  enterpriseName: presentation.brandName,
  mallName: presentation.mallName,
  logoText: presentation.brandName,
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
  enterpriseName: presentation.brandName,
  currentMallId: UNRESOLVED_MALL.id,
  welfareBalance: 0,
  mealBalance: 0,
  couponCount: 0,
  assuranceLevel: 'account',
  phoneVerified: false,
  paymentEligible: false,
};
