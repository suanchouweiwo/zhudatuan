import { useEffect, useState } from 'react';
import { loadProductionApi } from '../../services/productionApiLoader';
import type { ApiOrderReturn } from '../../services/productionApi.types';

const returnStatus: Readonly<Record<string, string>> = {
  requested: '待审核', approved: '已受理', rejected: '审核未通过',
  processing: '退货处理中', completed: '退货已完成', cancelled: '已取消',
};

export function OrderReturnProgress({ orderId }: Readonly<{ orderId: string }>) {
  const [open, setOpen] = useState(true);
  const [returns, setReturns] = useState<ApiOrderReturn[]>([]);

  useEffect(() => {
    let current = true;
    loadProductionApi().then((api) => api.readOrderReturns(orderId)).then((result) => {
      if (current) setReturns(result);
    }).catch(() => { if (current) setReturns([]); });
    return () => { current = false; };
  }, [orderId]);

  if (returns.length === 0) return null;
  return <section aria-label="退货进度" className="space-y-1 border-t border-blue-100 bg-blue-50/60 px-3 py-2.5 text-[11px] text-gray-700">
    <div className="flex flex-wrap items-center gap-2">
      <span className="rounded bg-blue-100 px-2 py-1 font-bold text-[var(--sw-brand-dark)]">有退货记录</span>
      <button type="button" aria-expanded={open} onClick={() => setOpen((previous) => !previous)}
        className="rounded border border-gray-300 bg-white px-2.5 py-1 font-bold text-gray-700">查看退货进度</button>
    </div>
    {open && returns.map((sale) => (
      <div key={sale.id} className="space-y-1">
        <h2 className="font-bold text-gray-900">{sale.title}</h2>
        <p>{returnStatus[sale.state] ?? '退货处理中'}</p>
        {sale.refunds.map((refund) => (
          <p key={refund.id}><strong>退款成功 · {new Intl.NumberFormat('zh-CN', {
            style: 'currency', currency: refund.currency,
          }).format(refund.amountMinor / 100)}</strong> · {refund.id}</p>
        ))}
      </div>
    ))}
  </section>;
}
