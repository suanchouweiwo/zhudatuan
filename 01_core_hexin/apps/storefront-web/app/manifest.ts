import type { MetadataRoute } from 'next';
import { headers } from 'next/headers';
import { resolveStorefrontNode } from '../src/config/storefrontIdentity';

export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const storefrontHost = (await headers()).get('host');
  const node = resolveStorefrontNode(storefrontHost?.split(':')[0].toLowerCase());
  return {
    name: node.mallName,
    short_name: node.brandName,
    description: '面向企业员工的福利商品、卡券、生活服务和订单管理平台。',
    lang: 'zh-CN',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#F5F7FA',
    theme_color: '#143A8F',
    icons: [
      { src: '/icon1.png?v=zhudatuan-l0', sizes: '192x192', type: 'image/png' },
      { src: '/icon2.png?v=zhudatuan-l0', sizes: '512x512', type: 'image/png' },
    ],
  };
}
