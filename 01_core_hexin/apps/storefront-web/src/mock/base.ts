/**
 * 主打团企业福利商城 - Mock 数据集
 * 包含 30+ 条涵盖实物、电影票、虚拟卡券、商超、生活服务、附近门店核销的完整真实感商品数据
 * 技术服务方：雍彻科技
 */

import { Product, Category, EnterpriseMall, UserProfile, DeliveryAddress, Order, AccountLog, UserCoupon, AfterSaleRecord, Supplier } from '../types';

export const MOCK_SUPPLIERS: Supplier[] = [
  { id: 'sup_01', name: '京东供应链', type: 'third_party', code: 'JD-API' },
  { id: 'sup_02', name: '平台自营仓', type: 'self_operated', code: 'SGSYEN-SELF' },
  { id: 'sup_03', name: '集团特选供应', type: 'group_owned', code: 'GROUP-SPECIAL' },
];

export const MOCK_ENTERPRISE_MALLS: EnterpriseMall[] = [
  {
    id: 'mall_gw',
    enterpriseId: 'ent_gw',
    enterpriseName: '国家电网有限公司',
    mallName: '国网员工企业福利专享商城',
    logoText: '国网福利',
    badge: '央企专属福利',
    welcomeBanner: '国网员工专项福利补贴已发放，支持福利卡与餐卡通兑！',
    distributorId: 'DIST-001-GW',
  },
  {
    id: 'mall_zh',
    enterpriseId: 'ent_zh',
    enterpriseName: '中国航空工业集团',
    mallName: '中航工业职工特惠商城',
    logoText: '中航特惠',
    badge: '军工企业尊享',
    welcomeBanner: '中航工业2026年二季度劳保与健康关怀福利专场已开启',
    distributorId: 'DIST-002-ZH',
  },
];

export const MOCK_USER: UserProfile = {
  id: 'usr_88902',
  employeeId: 'FW-88902',
  name: '张建国',
  avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&auto=format&fit=crop&q=80',
  phone: '138****9281',
  jobTitle: '高级工程师',
  department: '数字化推进部',
  enterpriseId: 'ent_gw',
  enterpriseName: '国家电网有限公司',
  currentMallId: 'mall_gw',
  welfareBalance: 3280.0,
  mealBalance: 850.5,
  couponCount: 6,
  assuranceLevel: 'phone',
  phoneVerified: true,
  paymentEligible: true,
  distributorId: 'DIST-001-GW',
};

export const MOCK_ADDRESSES: DeliveryAddress[] = [
  {
    id: 'addr_01',
    name: '张建国',
    phone: '13812349281',
    province: '北京市',
    city: '北京市',
    district: '西城区',
    detail: '金融大街1号 国家电网大厦 1208室',
    isDefault: true,
    tag: '公司',
  },
  {
    id: 'addr_02',
    name: '张建国',
    phone: '13812349281',
    province: '北京市',
    city: '北京市',
    district: '海淀区',
    detail: '中关村南大街18号 紫竹花园 3号楼2单元601',
    isDefault: false,
    tag: '家庭',
  },
];

export const MOCK_CATEGORIES: Category[] = [
  {
    id: 'cat_food',
    name: '食品饮料',
    iconName: 'UtensilsCrossed',
    hotKeywords: ['坚果礼盒', '五常大米', '有机压榨油', '精品茶叶', '特仑苏牛奶'],
    children: [
      { id: 'sub_food_1', name: '米面粮油', items: ['有机大米', '橄榄油', '面粉', '杂粮礼盒'] },
      {
        id: 'sub_food_2',
        name: '休闲零食',
        items: ['坚果炒货', '进口巧克力', '肉干肉脯', '糕点饼干'],
      },
      {
        id: 'sub_food_3',
        name: '冲调茶饮',
        items: ['西湖龙井', '云南普洱', '挂耳咖啡', '乳品饮料'],
      },
    ],
  },
  {
    id: 'cat_appliance',
    name: '家用电器',
    iconName: 'Tv',
    hotKeywords: ['戴森吸尘器', '空气炸锅', '破壁机', '咖啡机', '扫地机器人'],
    children: [
      { id: 'sub_app_1', name: '厨房小电', items: ['空气炸锅', '破壁机', '电饭煲', '养生壶'] },
      { id: 'sub_app_2', name: '生活电器', items: ['吸尘器', '空气净化器', '除螨仪', '电风扇'] },
      { id: 'sub_app_3', name: '个护健康', items: ['电动牙刷', '按摩仪', '吹风机', '剃须刀'] },
    ],
  },
  {
    id: 'cat_digital',
    name: '数码办公',
    iconName: 'Laptop',
    hotKeywords: ['降噪耳机', '机械键盘', '显示器', '移动硬盘', '智能手表'],
    children: [
      {
        id: 'sub_dig_1',
        name: '电脑外设',
        items: ['机械键盘', '无线鼠标', '高刷新率显示器', '扩展坞'],
      },
      {
        id: 'sub_dig_2',
        name: '影音数码',
        items: ['蓝牙耳机', '头戴降噪耳机', '户外音箱', '录音笔'],
      },
      { id: 'sub_dig_3', name: '办公用品', items: ['打印纸', '高端钢笔', '文件柜', '碎纸机'] },
    ],
  },
  {
    id: 'cat_home',
    name: '家居日用',
    iconName: 'Home',
    hotKeywords: ['桑蚕丝被', '乳胶枕', '膳魔师保温杯', '纯棉毛巾礼盒', '香氛礼盒'],
    children: [
      { id: 'sub_home_1', name: '家纺用品', items: ['蚕丝被', '乳胶枕', '四件套', '纯棉毛巾'] },
      {
        id: 'sub_home_2',
        name: '餐具水具',
        items: ['保温杯', '骨瓷餐具礼盒', '茶具套组', '红酒杯'],
      },
      { id: 'sub_home_3', name: '收纳清洁', items: ['垃圾桶', '收纳箱', '衣架套组', '香氛点缀'] },
    ],
  },
  {
    id: 'cat_personal',
    name: '个护清洁',
    iconName: 'Sparkles',
    hotKeywords: ['飞利浦剃须刀', 'SK-II礼盒', '洗护套装', '电动牙刷头', '洗发水'],
    children: [
      {
        id: 'sub_per_1',
        name: '面部护理',
        items: ['男士护肤礼盒', '保湿面霜', '防晒霜', '面膜套组'],
      },
      { id: 'sub_per_2', name: '洗发护发', items: ['防脱洗发水', '发膜', '沐浴露礼盒', '洗手液'] },
    ],
  },
  {
    id: 'cat_movie',
    name: '电影娱乐',
    iconName: 'Film',
    hotKeywords: ['全国影院通兑', 'IMAX 3D观影券', '万达影城双人票', '博纳影城电子券'],
    children: [
      {
        id: 'sub_mov_1',
        name: '电影通兑',
        items: ['全国2D/3D通用卷', 'VIP厅兑换券', '双人观影套餐'],
      },
      { id: 'sub_mov_2', name: '演出剧场', items: ['话剧门票', '音乐会门票', '儿童剧'] },
    ],
  },
  {
    id: 'cat_virtual',
    name: '虚拟卡券',
    iconName: 'CreditCard',
    hotKeywords: ['星巴克100元卡', '京东E卡', '爱奇艺年卡', '腾讯视频VIP', '猫眼电影卡'],
    children: [
      {
        id: 'sub_vir_1',
        name: '商超/饮品卡',
        items: ['星巴克电子卡', '瑞幸咖啡券', '沃尔玛礼品卡'],
      },
      {
        id: 'sub_vir_2',
        name: '音视频会员',
        items: ['爱奇艺年卡', '腾讯视频年卡', '网易云音乐VIP', '哔哩哔哩大会员'],
      },
    ],
  },
  {
    id: 'cat_apparel',
    name: '服饰鞋包',
    iconName: 'Shirt',
    hotKeywords: ['通勤鞋靴', '品质箱包', '珠宝饰品', '运动户外'],
    children: [
      { id: 'sub_apparel_1', name: '鞋靴服饰', items: ['运动鞋', '商务鞋', '休闲服饰'] },
      { id: 'sub_apparel_2', name: '箱包配饰', items: ['双肩包', '旅行箱', '帽子配饰'] },
      { id: 'sub_apparel_3', name: '珠宝饰品', items: ['戒指', '项链', '耳饰'] },
    ],
  },
  {
    id: 'cat_supermarket',
    name: '商超商品',
    iconName: 'ShoppingBag',
    hotKeywords: ['永辉超市直提', '盒马鲜生礼品券', '大润发商品特惠', '沃尔玛购物卡'],
    children: [{ id: 'sub_sup_1', name: '连锁商超', items: ['盒马专区', '永辉超市', '山姆代购特惠'] }],
  },
  {
    id: 'cat_nearby',
    name: '附近门店',
    iconName: 'Store',
    hotKeywords: ['洗车美容', '家政清洁', '附近品质餐饮', '健身房周卡', '连锁烘焙券'],
    children: [
      { id: 'sub_near_1', name: '汽车服务', items: ['精细洗车', '汽车保养', '轮胎检测'] },
      { id: 'sub_near_2', name: '本地美食', items: ['烘焙套餐', '双人自助餐', '商务套餐'] },
      { id: 'sub_near_3', name: '生活保养', items: ['3小时深度保洁', '健身房周卡', '洗衣护理'] },
    ],
  },
  {
    id: 'cat_welfare_zone',
    name: '企业福利专区',
    iconName: 'Gift',
    hotKeywords: ['端午粽子礼盒', '中秋月饼礼盒', '年货大礼包', '员工防暑降温套装'],
    children: [
      { id: 'sub_wel_1', name: '节日礼盒', items: ['中秋月饼', '端午礼粽', '年货礼包'] },
      { id: 'sub_wel_2', name: '劳保关怀', items: ['防暑降温包', '健康体检套餐', '清凉饮料箱'] },
    ],
  },
];
