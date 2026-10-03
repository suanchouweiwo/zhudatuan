import { ResourcePanel } from '@shop/design';
import { useParams } from 'react-router';

export function Component() {
  const productId = useParams().productId ?? '';
  return <ResourcePanel title="商品详情" eyebrow="MORVIA PRODUCT DETAIL"
    description={`商品 ${productId} 暂不读取列表结果冒充详情。`} condition="failure" error="PRODUCT_DETAIL_OPERATION_REQUIRED"
    >
    <section className="capabilitynote" aria-labelledby="productdetailblocker"><h2 id="productdetailblocker">合同阻塞</h2>
      <p>当前合同缺少按商品 ID 读取详情、价格呈现、库存呈现和来源责任的单一 Operation；补齐前保持 fail-closed。</p></section>
  </ResourcePanel>;
}
