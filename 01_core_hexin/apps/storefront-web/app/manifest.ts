import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'MORVIA 主打团商城',
    short_name: 'MORVIA',
    description: '面向企业员工的福利商品、卡券、生活服务和订单管理平台。',
    lang: 'zh-CN',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#F5F7FA',
    theme_color: '#143A8F',
    icons: [
      { src: '/icon1.png?v=morvia-l0', sizes: '192x192', type: 'image/png' },
      { src: '/icon2.png?v=morvia-l0', sizes: '512x512', type: 'image/png' },
    ],
  };
}
