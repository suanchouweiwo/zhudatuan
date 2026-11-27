import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { formatMinor } from '../../shared/ui/Format';
import { OrderIcon } from './OrderIcon';
import { aftersaleLabel, formatOrderTime, fulfillmentLabel, lifecycleLabel, paymentLabel, previewRecord } from './OrderPresentation';
import type { OrderDetailTab, OrderRecord } from './OrderSchema';

export function OrderDrawerPanel({
  order,
  tab,
  previewEnabled,
  memberDirectoryPath,
  productDirectoryPath,
}: Readonly<{
  order: OrderRecord;
  tab: OrderDetailTab;
  previewEnabled: boolean;
  memberDirectoryPath: string;
  productDirectoryPath: string;
}>) {
  if (tab === 'products') return <ProductsPanel order={order} productDirectoryPath={productDirectoryPath} />;
  if (tab === 'payment') return <PaymentPanel order={order} previewEnabled={previewEnabled} />;
  if (tab === 'aftersale') return <AftersalePanel order={order} />;
  if (tab === 'operations') return <OperationsPanel order={order} previewEnabled={previewEnabled} />;
  return <OverviewPanel order={order} previewEnabled={previewEnabled} memberDirectoryPath={memberDirectoryPath} productDirectoryPath={productDirectoryPath} />;
}

function OverviewPanel({
  order,
  previewEnabled,
  memberDirectoryPath,
  productDirectoryPath,
}: Readonly<{
  order: OrderRecord;
  previewEnabled: boolean;
  memberDirectoryPath: string;
  productDirectoryPath: string;
}>) {
  const preview = previewRecord(order, previewEnabled);
  const lines = [...(order.lines ?? [])].sort((left, right) => left.id.localeCompare(right.id));
  const memberLookup = order.participant_membership_id ?? order.member_id;
  return (
    <div className="orderdrawerstack">
      <section className="ordersummarynote">
        <div className="ordersummaryline">
          <span aria-hidden="true"><OrderIcon name="order" /></span>
          <strong>订单说明</strong>
          <p>{preview?.summary ?? `订单为${lifecycleLabel(order.lifecycle_state)}状态；订单、财务、商品为明线，现金结果用于核验财务。`}</p>
        </div>
        <small>{!previewEnabled ? '流程仅展示当前订单快照；没有事实来源的结算、路径和事件时间不会推测。' : '本地预览数据 · 不作为生产业务真值'}</small>
      </section>
      <MilestoneChain order={order} previewEnabled={previewEnabled} />
      <FourFlowSummary order={order} />

      <DetailSection title="消费会员与订单归属">
        <div className="orderdetailgrid">
          <Info label="消费会员" value={preview?.memberName ?? order.member_id ?? '当前读模型未提供'} />
          <Info label="订单会员身份" value={order.participant_membership_id ?? '历史订单未冻结'} />
          <Info label="参与节点" value={order.participant_node_id ?? '历史订单未冻结'} />
          <Info label="身份域 / 账号" value={[order.participant_realm_id, order.participant_account_id].filter(Boolean).join(' / ') || '历史订单未冻结'} />
        </div>
        {memberLookup === null || memberLookup === undefined ? null : (
          <div className="orderrelationaction">
            <Link to={`${memberDirectoryPath}?q=${encodeURIComponent(memberLookup)}`}>查看商城会员档案</Link>
          </div>
        )}
      </DetailSection>

      <DetailSection title="商品明细">
        <div className="orderlinepreview">
          {lines.length === 0 ? (
            <Unavailable text="当前订单快照未返回商品行" />
          ) : (
            lines.slice(0, 2).map((line) => (
              <div key={line.id}>
                <span className="orderproductthumb">
                  <OrderIcon name="package" />
                </span>
                <span className="orderlinepreviewcopy">
                  <strong>{line.title}</strong>
                  <small>
                    规格 {line.sku} · 数量 {line.quantity}
                  </small>
                  <small>{line.supplierId === null || line.supplierId === undefined ? '供应商未冻结' : `供应商 ${line.supplierId}`}</small>
                  <Link to={`${productDirectoryPath}?q=${encodeURIComponent(productLookupKey(line))}`}>查看商品</Link>
                </span>
                <b>{formatMinor(line.payableMinor, order.currency)}</b>
              </div>
            ))
          )}
        </div>
      </DetailSection>

      <EconomicLegs order={order} />

      <DetailSection title="金额与支付">
        <div className="orderdetailgrid">
          <Info label="订单应付" value={formatMinor(order.total_minor, order.currency)} />
          <Info label="支付状态" value={paymentLabel(order.payment_state)} />
          <Info label="实付金额" value={preview === undefined ? '当前读模型未提供' : formatMinor(preview.paidMinor, order.currency)} />
          <Info label="支付拆分" value={preview === undefined ? '当前读模型未提供' : `${preview.paymentMethod} · 已对齐`} />
        </div>
      </DetailSection>

      <DetailSection title="履约">
        <div className="orderdetailgrid">
          <Info label="履约状态" value={fulfillmentLabel(order.fulfillment_state)} />
          <Info label="供应方" value={preview?.supplierName ?? '未关联'} />
          <Info label="收货信息" value={preview?.addressSummary ?? '暂无'} />
        </div>
      </DetailSection>

      <p className="orderrecentoperation">
        最近 Operation：
        {preview?.operation === undefined ? (
          '当前读模型未提供审计时间线'
        ) : (
          <>
            <strong>{preview.operation.label}</strong> · {formatOrderTime(preview.operation.at)}
          </>
        )}
      </p>
    </div>
  );
}

function MilestoneChain({ order, previewEnabled }: Readonly<{ order: OrderRecord; previewEnabled: boolean }>) {
  const preview = previewRecord(order, previewEnabled);
  const milestones = preview?.milestones ?? snapshotFlow(order);
  return (
    <section className="orderflow" aria-labelledby="orderflowtitle">
      <div className="orderflowheading">
        <h3 id="orderflowtitle">订单流程</h3>
        <span>{preview === undefined ? '当前订单快照' : '事件时间线'}</span>
      </div>
      <ol className="ordermilestones" aria-label="订单流程">
        {milestones.map((item, index) => {
          const detail = item.at === undefined ? '—' : item.at.includes('T') ? formatOrderTime(item.at) : item.at;
          return (
          <li key={item.key} className={`is-${item.state}`} aria-label={`${item.label}：${flowStateLabel(item.state)}，${detail}`}>
            <span>
              {item.state === 'complete' ? <OrderIcon name="check" /> : item.state === 'warning' ? <OrderIcon name="clock" /> : index + 1}
            </span>
            <strong>{item.label}</strong>
            <small>
              <span>{detail}</span>
              <b>{flowStateLabel(item.state)}</b>
            </small>
          </li>
          );
        })}
      </ol>
    </section>
  );
}

function flowStateLabel(state: 'complete' | 'current' | 'pending' | 'warning'): string {
  return ({ complete: '已完成', current: '进行中', pending: '待进行', warning: '异常' } as const)[state];
}

function snapshotFlow(order: OrderRecord) {
  const paymentState = order.payment_state === 'failed'
    ? 'warning'
    : ['paid', 'partially_refunded', 'refunded'].includes(order.payment_state) ? 'complete' : 'current';
  const fulfillmentState = ['cancelled', 'returned'].includes(order.fulfillment_state)
    ? 'warning'
    : order.fulfillment_state === 'delivered' ? 'complete' : paymentState === 'complete' ? 'current' : 'pending';
  const aftersaleState = order.aftersale_state === 'resolved'
    ? 'complete'
    : order.aftersale_state === 'rejected' ? 'warning' : order.aftersale_state === 'none' ? 'pending' : 'current';
  const completionState = order.lifecycle_state === 'completed' || order.lifecycle_state === 'closed'
    ? 'complete'
    : order.lifecycle_state === 'cancelled' ? 'warning' : 'pending';
  return [
    { key: 'placed', label: '下单', state: 'complete' as const, at: formatOrderTime(order.created_at) },
    { key: 'payment', label: '支付', state: paymentState, at: undefined },
    { key: 'fulfillment', label: '履约', state: fulfillmentState, at: undefined },
    { key: 'aftersale', label: '售后', state: aftersaleState, at: undefined },
    { key: 'completion', label: '完成', state: completionState, at: undefined },
  ] as const;
}

function ProductsPanel({ order, productDirectoryPath }: Readonly<{ order: OrderRecord; productDirectoryPath: string }>) {
  const lines = [...(order.lines ?? [])].sort((left, right) => left.id.localeCompare(right.id));
  const reservations = [...(order.inventory_reservations ?? [])].sort((left, right) => left.id.localeCompare(right.id));
  const aftersales = [...(order.aftersales ?? [])].sort((left, right) => right.requestedAt.localeCompare(left.requestedAt));
  return (
    <div className="orderdrawerstack">
      <DetailSection title="商品与履约快照">
        {lines.length === 0 ? (
          <Unavailable text="服务端未返回商品行" />
        ) : (
          <div className="orderlinelist">
            {lines.map((line) => (
              <article key={line.id} className="orderproductrecord">
                <div className="orderproductrecordmain">
                  <span className="orderproductthumb">
                    <OrderIcon name="package" />
                  </span>
                  <span>
                    <strong>{line.title}</strong>
                    <small>规格 {line.sku} · 数量 {line.quantity} · 单价 {formatMinor(line.unitMinor, order.currency)}</small>
                  </span>
                  <b>{formatMinor(line.payableMinor, order.currency)}</b>
                  <Link to={`${productDirectoryPath}?q=${encodeURIComponent(productLookupKey(line))}`}>查看商品</Link>
                </div>
                <div className="orderproductfacts">
                  <Info label="商品主权" value={line.product ?? line.listing ?? '历史订单未冻结'} />
                  <Info label="可售记录" value={line.listing ?? '历史订单未冻结'} />
                  <Info label="经营路径" value={line.routeId === null || line.routeId === undefined ? '历史订单未冻结' : `${line.routeId} · v${line.routeVersion ?? '—'}`} />
                  <Info label="供应与责任" value={`${line.supplierId ?? line.partner ?? '供应商未冻结'} · 履约 ${line.fulfillmentPartyId ?? '合同未指定'} · 结算 ${line.settlementPartyId ?? '合同未指定'}`} />
                  <Info label="合同" value={line.contractId ?? '历史订单未冻结'} />
                </div>
              </article>
            ))}
          </div>
        )}
      </DetailSection>
      <DetailSection title="库存事实">
        {reservations.length === 0 ? (
          <Unavailable text="当前授权范围没有返回库存占用记录。" />
        ) : (
          <div className="orderdetailgrid">
            {reservations.map((reservation, index) => (
              <Info key={reservation.id} label={`库存占用 ${index + 1}`} value={`${reservation.state} · ${reservation.quantity} 件`} />
            ))}
          </div>
        )}
      </DetailSection>
      <DetailSection title="退换货事实">
        {aftersales.length === 0 ? (
          <Unavailable text="当前订单没有退货、换货或退款申请。" />
        ) : (
          <div className="orderdetailgrid">
            {aftersales.map((aftersale) => (
              <Info key={aftersale.id} label={`${aftersaleKindLabel(aftersale.kind)} · ${aftersale.state}`} value={`${aftersale.quantity ?? '整单'} · ${aftersale.reason}`} />
            ))}
          </div>
        )}
      </DetailSection>
      <DetailSection title="发货运单">
        {(order.fulfillments ?? []).flatMap((item) => item.milestones.filter((step) => step.kind === 'shipment' && step.tracking)
          .map((step) => <Info key={step.id} label="运单号" value={step.tracking!} />))}
        {!(order.fulfillments ?? []).some((item) => item.milestones.some((step) => step.kind === 'shipment' && step.tracking))
          ? <Unavailable text="暂无发货运单。" /> : null}
      </DetailSection>
    </div>
  );
}

function productLookupKey(line: NonNullable<OrderRecord['lines']>[number]): string {
  return line.product ?? line.listing ?? line.sku;
}

function PaymentPanel({ order, previewEnabled }: Readonly<{ order: OrderRecord; previewEnabled: boolean }>) {
  const preview = previewRecord(order, previewEnabled);
  const payment = order.payment_fact;
  const journals = order.finance_facts ?? [];
  return (
    <div className="orderdrawerstack">
      <DetailSection title="支付快照">
        <div className="orderdetailgrid">
          <Info label="订单应付" value={formatMinor(order.total_minor, order.currency)} />
          <Info label="支付意图" value={payment?.intentId ?? '当前没有支付意图'} />
          <Info label="现金结果" value={payment?.paymentState ?? paymentLabel(order.payment_state)} />
          <Info label="实付金额" value={payment?.capturedMinor === null || payment?.capturedMinor === undefined
            ? preview === undefined ? '当前读模型未提供' : formatMinor(preview.paidMinor, order.currency)
            : formatMinor(payment.capturedMinor, order.currency)} />
          <Info label="已退款" value={payment?.refundedMinor === null || payment?.refundedMinor === undefined ? '—' : formatMinor(payment.refundedMinor, order.currency)} />
          <Info label="财务凭证" value={journals.length === 0 ? '尚未形成' : `${journals.length} 笔 · ${journals.map(({ state }) => state).join(' / ')}`} />
          <Info label="支付方式" value={preview?.paymentMethod ?? '当前读模型未提供'} />
          <Info label="福利账户" value={preview === undefined ? '当前读模型未提供' : formatMinor(preview.benefitMinor, order.currency)} />
          <Info label="微信支付" value={preview === undefined ? '当前读模型未提供' : formatMinor(preview.wechatMinor, order.currency)} />
        </div>
      </DetailSection>
      {payment === null || payment === undefined ? <Unavailable text="当前订单尚未形成支付事实。" /> : null}
    </div>
  );
}

function FourFlowSummary({ order }: Readonly<{ order: OrderRecord }>) {
  const routeCount = new Set((order.lines ?? []).map(({ routeId }) => routeId).filter(Boolean)).size;
  const fulfillmentCount = order.fulfillments?.length ?? 0;
  const journalCount = order.finance_facts?.length ?? 0;
  return (
    <DetailSection title="四流合一">
      <div className="orderdetailgrid">
        <Info label="订单流" value={lifecycleLabel(order.lifecycle_state)} />
        <Info label="商品流" value={`${order.lines?.length ?? 0} 个商品行 · ${routeCount} 条经营路径 · ${fulfillmentCount} 个履约单`} />
        <Info label="现金流" value={order.payment_fact?.paymentState ?? order.payment_fact?.intentState ?? paymentLabel(order.payment_state)} />
        <Info label="财务流" value={journalCount === 0 ? '尚未形成凭证' : `${journalCount} 笔权威凭证`} />
      </div>
    </DetailSection>
  );
}

function EconomicLegs({ order }: Readonly<{ order: OrderRecord }>) {
  const legs = order.economic_legs ?? [];
  return (
    <DetailSection title="供应商经济腿">
      {legs.length === 0 ? (
        <Unavailable text="历史订单尚未冻结供应商经济腿。" />
      ) : (
        <div className="orderdetailgrid">
          {legs.map((leg) => (
            <Info key={leg.id} label={leg.supplierId ?? '商城自营'}
              value={`${formatMinor(leg.amountMinor ?? 0, order.currency)} · ${leg.contractId ?? '合同未指定'} · ${leg.state}`} />
          ))}
        </div>
      )}
    </DetailSection>
  );
}

function aftersaleKindLabel(kind: 'cancel' | 'return' | 'refund' | 'exchange' | 'claim'): string {
  return ({ cancel: '取消', return: '退货', refund: '退款', exchange: '换货', claim: '理赔' } as const)[kind];
}

function AftersalePanel({ order }: Readonly<{ order: OrderRecord }>) {
  const aftersales = order.aftersales ?? [];
  return (
    <div className="orderdrawerstack">
      {order.aftersale_state === 'none' ? (
        <div className="orderaftersaleempty">
          <OrderIcon name="check" />
          <span>
            <strong>当前订单暂无售后</strong>
            <small>订单仍可按支付与履约状态继续核验</small>
          </span>
        </div>
      ) : null}
      <DetailSection title="售后状态">
        <div className="orderdetailgrid">
          <Info label="聚合售后状态" value={aftersaleLabel(order.aftersale_state)} />
          <Info label="订单状态" value={lifecycleLabel(order.lifecycle_state)} />
        </div>
      </DetailSection>
      <DetailSection title="关联状态">
        <div className="orderdetailgrid">
          <Info label="支付状态" value={paymentLabel(order.payment_state)} />
          <Info label="履约状态" value={fulfillmentLabel(order.fulfillment_state)} />
        </div>
      </DetailSection>
      <DetailSection title="原路售后">
        {aftersales.length === 0 ? (
          <Unavailable text="当前订单没有售后记录。" />
        ) : (
          <div className="orderdetailgrid">
            {aftersales.map((aftersale) => (
              <Info key={aftersale.id} label={`${aftersaleKindLabel(aftersale.kind)} · ${aftersale.state}`}
                value={`${aftersale.lineId ?? '整单'} · ${aftersale.routeSnapshot === null || aftersale.routeSnapshot === undefined ? '历史订单未冻结路径' : '已绑定原商品路径'}`} />
            ))}
          </div>
        )}
      </DetailSection>
    </div>
  );
}

function OperationsPanel({ order, previewEnabled }: Readonly<{ order: OrderRecord; previewEnabled: boolean }>) {
  const operations = order.operations ?? [];
  return (
    <DetailSection title="操作记录">
      {operations.length === 0 ? (
        <Unavailable text={previewEnabled ? '当前预览订单没有责任人操作记录。' : '当前订单没有可读取的责任人操作记录。'} />
      ) : (
        <div className="orderoperationtimeline" aria-label="订单责任人操作时间线">
          {operations.map((operation) => {
            const presentation = operationPresentation(operation.kind, operation.result);
            return (
              <article className="orderoperationitem" key={operation.id}>
                <span className={`orderoperationmarker is-${presentation.tone}`} aria-hidden="true">
                  <OrderIcon name={presentation.icon} />
                </span>
                <div className="orderoperationcontent">
                  <header>
                    <strong>{presentation.action}</strong>
                    <span className={`orderoperationresult is-${presentation.tone}`}>{presentation.result}</span>
                  </header>
                  <div className="orderoperationmeta">
                    <span className="orderoperationrole">{presentation.role}</span>
                    <b>{operation.actor_name ?? operation.actor_id ?? '主体未记录'}</b>
                    <time dateTime={operation.occurred_at}>{formatOrderTime(operation.occurred_at)}</time>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </DetailSection>
  );
}

function operationPresentation(kind: NonNullable<OrderRecord['operations']>[number]['kind'], result: string) {
  const resultLabels: Readonly<Record<string, string>> = {
    created: '已创建', shipped: '已发货', approved: '已通过', rejected: '已驳回', requested: '待审核',
  };
  const base = {
    placed: { action: '提交订单', role: '下单人', icon: 'order' as const, tone: 'complete' },
    shipment: { action: '确认发货', role: '发货人', icon: 'package' as const, tone: 'complete' },
    aftersale_request: { action: '提交售后申请', role: '申请人', icon: 'clock' as const, tone: 'pending' },
    aftersale_approved: { action: '售后审核通过', role: '审核人', icon: 'check' as const, tone: 'complete' },
    aftersale_rejected: { action: '售后审核驳回', role: '审核人', icon: 'close' as const, tone: 'failed' },
  }[kind];
  return { ...base, result: resultLabels[result] ?? result };
}

function DetailSection({ title, children }: Readonly<{ title: string; children: ReactNode }>) {
  return (
    <section className="orderdetailsection">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function Info({ label, value }: Readonly<{ label: string; value: string }>) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Unavailable({ text }: Readonly<{ text: string }>) {
  return (
    <p className="orderunavailable">
      <OrderIcon name="clock" />
      {text}
    </p>
  );
}
