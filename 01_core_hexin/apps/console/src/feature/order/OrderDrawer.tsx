import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Button } from 'react-aria-components';
import { useConsoleContext } from '../../entity/session/ConsoleContext';
import { safeQueryError } from '../../shared/api/QueryState';
import { formatMinor } from '../../shared/ui/Format';
import { orderDetailKey, readOrderDetail } from './OrderDetailQuery';
import { OrderDetailTabs } from './OrderDetailTabs';
import { OrderDrawerPanel } from './OrderDrawerPanel';
import { OrderIcon } from './OrderIcon';
import { aftersaleLabel, aftersaleTone, formatOrderTime, fulfillmentLabel, fulfillmentTone, lifecycleLabel, paymentLabel, paymentTone } from './OrderPresentation';
import { OrderPreviewAction } from './OrderPreviewAction';
import { OrderShipmentAction } from './OrderShipmentAction';
import type { OrderDetailTab, OrderRecord } from './OrderSchema';

export function OrderDrawer({
  orderId,
  initialOrder,
  tab,
  previewEnabled,
  mallName,
  memberDirectoryPath,
  productDirectoryPath,
  onTab,
  onClose,
}: Readonly<{
  orderId: string;
  initialOrder: OrderRecord | undefined;
  tab: OrderDetailTab;
  previewEnabled: boolean;
  mallName: string;
  memberDirectoryPath: string;
  productDirectoryPath: string;
  onTab: (tab: OrderDetailTab) => void;
  onClose: () => void;
}>) {
  const context = useConsoleContext();
  const detailRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  const [copied, setCopied] = useState(false);
  const query = useQuery({
    queryKey: orderDetailKey(context, orderId),
    queryFn: ({ signal }) => readOrderDetail(context, orderId, signal),
    enabled: orderId !== '',
    placeholderData: initialOrder,
    staleTime: 30_000,
  });
  const order = query.data;
  const error = safeQueryError(query.error);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    detailRef.current?.focus({ preventScroll: true });
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [orderId]);

  const copyNumber = () => {
    if (order === undefined || navigator.clipboard === undefined) return;
    void navigator.clipboard
      .writeText(order.order_number)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      })
      .catch(() => setCopied(false));
  };

  return (
    <aside ref={detailRef} className="orderdrawer" aria-label={`订单详情 ${order?.order_number ?? '正在读取'}`} tabIndex={-1}>
          <header className="orderdrawerheader">
            <div className="orderdrawerheadline">
              <div className="orderdrawertitleline">
                <h2 id="orderdrawertitle">
                  {order?.order_number ?? '正在读取订单'}
                </h2>
                <button type="button" onClick={copyNumber} disabled={order === undefined} aria-label={copied ? '订单号已复制' : '复制订单号'}>
                  <OrderIcon name={copied ? 'check' : 'copy'} />
                  {copied ? <span className="ordercopyfeedback" role="status">已复制</span> : null}
                </button>
              </div>
              {order === undefined ? null : (
                <div className="orderdraweramount">
                  <span>订单金额</span>
                  <strong>{formatMinor(order.total_minor, order.currency)}</strong>
                </div>
              )}
              <button className="orderdrawerclose" type="button" onClick={onClose} aria-label="关闭订单详情">
                <OrderIcon name="close" />
              </button>
            </div>
            {order === undefined ? null : (
              <>
                <div className="orderdrawerbadges" aria-label="订单状态摘要">
                  <span className="orderstatuspill tone-brand">{lifecycleLabel(order.lifecycle_state)}</span>
                  <span className={`orderstatuspill tone-${paymentTone(order.payment_state)}`}>{paymentLabel(order.payment_state)}</span>
                  <span className={`orderstatuspill tone-${fulfillmentTone(order.fulfillment_state)}`}>{fulfillmentLabel(order.fulfillment_state)}</span>
                  <span className={`orderstatuspill tone-${aftersaleTone(order.aftersale_state)}`}>{aftersaleLabel(order.aftersale_state)}</span>
                </div>
                <div className="orderdrawermeta">
                  <span>所属商城 <strong>{mallName}</strong></span>
                  <span>创建时间 <strong>{formatOrderTime(order.created_at)}</strong></span>
                </div>
              </>
            )}
          </header>

          <OrderDetailTabs selected={tab} onSelectionChange={onTab}>
              {query.isPending ? (
                <p className="orderdrawerstate" role="status">
                  正在读取订单权威快照…
                </p>
              ) : null}
              {query.isError ? (
                <section className="orderdrawererror" role="alert">
                  <strong>订单详情读取失败</strong>
                  <p>{error}</p>
                  <button
                    type="button"
                    onClick={() => {
                      void query.refetch();
                    }}
                  >
                    重试
                  </button>
                </section>
              ) : null}
              {!query.isPending && !query.isError && order === undefined ? (
                <section className="orderdrawerempty" role="status">
                  <strong>未找到订单</strong>
                  <p>当前详情只支持订单精确匹配，请返回目录后重试。</p>
                </section>
              ) : null}
              {order === undefined ? null : <OrderDrawerPanel order={order} tab={tab} previewEnabled={previewEnabled}
                memberDirectoryPath={memberDirectoryPath} productDirectoryPath={productDirectoryPath} />}
          </OrderDetailTabs>

          <footer className="orderdrawerfooter">
            <p id="orderactionboundary" className="sr-only">
              最终动作缺少权限版本重读、服务端预览、Step-up、action-bound proof 与 Operation 回执，当前保持关闭。
            </p>
            <button type="button" onClick={onClose}>
              关闭
            </button>
            <OrderPreviewAction
              ariaLabel="更多"
              title="更多订单操作"
              disabled={!previewEnabled || order === undefined}
              describedBy="orderactionboundary"
              placement="top end"
              triggerTitle={previewEnabled ? '打开更多订单操作预览' : '等待最终动作合同'}
              trigger="更多"
            >
              {(close) => (
                <div className="orderpreviewoptions">
                  <Button
                    type="button"
                    onPress={() => {
                      close();
                      onTab('operations');
                    }}
                  >
                    查看操作记录
                  </Button>
                </div>
              )}
            </OrderPreviewAction>
            <OrderShipmentAction key={orderId} order={order} refreshed={query.isSuccess && !query.isPlaceholderData}
              onShipped={() => onTab('products')} />
          </footer>
    </aside>
  );
}
