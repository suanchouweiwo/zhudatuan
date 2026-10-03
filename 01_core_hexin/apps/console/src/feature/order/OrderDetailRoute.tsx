import { Button, ResourcePanel } from '@shop/design';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { useConsoleContext } from '../../entity/session/ConsoleContext';
import { queryCondition, safeQueryError } from '../../shared/api/QueryState';
import { DataTable, type DataColumn } from '../../shared/ui/DataTable';
import { formatDate, formatMinor } from '../../shared/ui/Format';
import { MetricCards } from '../../shared/ui/MetricCards';
import { orderDetailKey, readOrderDetail } from './OrderDetailQuery';
import type { OrderLine } from './OrderSchema';

const columns: readonly DataColumn<OrderLine>[] = [
  { key: 'title', label: '商品', render: (row) => row.title },
  { key: 'sku', label: 'SKU', render: (row) => row.sku },
  { key: 'quantity', label: '数量', render: (row) => row.quantity },
  { key: 'unit', label: '单价快照', render: (row) => formatMinor(row.unitMinor) },
  { key: 'discount', label: '优惠快照', render: (row) => formatMinor(row.discountMinor) },
  { key: 'payable', label: '应付快照', render: (row) => formatMinor(row.payableMinor) },
  { key: 'provider', label: '履约来源', render: (row) => row.provider ?? row.partner ?? '—' },
];

export function Component() {
  const context = useConsoleContext();
  const orderId = useParams().orderId ?? '';
  const query = useQuery({ queryKey: orderDetailKey(context, orderId), queryFn: ({ signal }) => readOrderDetail(context, orderId, signal), enabled: orderId !== '' });
  const data = query.data;
  const error = safeQueryError(query.error);
  const state = queryCondition({ pending: query.isPending, fetching: query.isFetching, error: query.error, hasData: data !== undefined, empty: data === undefined && !query.isPending && query.error === null, stale: query.isStale });
  return (
    <ResourcePanel
      title="订单详情"
      eyebrow="MORVIA ORDER DETAIL"
      description={`内部订单 ID ${orderId} 的权威快照；当前合同不支持使用展示订单号反查。`}
      condition={state}
      {...(error === undefined ? {} : { error })}
      retry={() => {
        void query.refetch();
      }}
      actions={
        <Button
          onPress={() => {
            void query.refetch();
          }}
        >
          刷新订单
        </Button>
      }
    >
      {data === undefined ? (
        <span />
      ) : (
        <div className="featurestack">
          <MetricCards
            items={[
              { label: '订单号', value: data.order_number },
              { label: '服务端应付', value: formatMinor(data.total_minor, data.currency) },
              { label: '支付状态', value: data.payment_state },
              { label: '履约状态', value: data.fulfillment_state },
              { label: '售后状态', value: data.aftersale_state },
              { label: '版本', value: String(data.version), detail: formatDate(data.updated_at) },
            ]}
          />
          <section className="capabilitynote" aria-labelledby="orderdetailboundary">
            <h2 id="orderdetailboundary">最终动作保持关闭</h2>
            <p>发货、退款与售后审批缺完整 Preview、Step-up、expectedVersion 和 action-bound proof 时不执行。</p>
          </section>
          <DataTable caption="订单商品明细" columns={columns} rows={data.lines ?? []} rowKey={(row) => row.id} />
        </div>
      )}
    </ResourcePanel>
  );
}
