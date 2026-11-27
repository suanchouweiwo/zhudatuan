import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createIdempotencyKey } from '@shop/sdk/context';
import { createFetchFulfillmentShipmentsCreate } from '@shop/sdk/fulfillment';
import { useRef, useState } from 'react';
import { Button, Dialog, DialogTrigger, Heading, Popover } from 'react-aria-components';
import { useConsoleContext } from '../../entity/session/ConsoleContext';
import { consoleCommand } from '../../shared/api/Client';
import { safeQueryError } from '../../shared/api/QueryState';
import { appConfig } from '../../shared/config/AppConfig';
import { OrderIcon } from './OrderIcon';
import { orderDetailKey } from './OrderDetailQuery';
import type { OrderRecord } from './OrderSchema';

const createShipment = createFetchFulfillmentShipmentsCreate(appConfig.apiBaseUrl);

export function OrderShipmentAction({ order, refreshed, onShipped }: Readonly<{
  order: OrderRecord | undefined;
  refreshed: boolean;
  onShipped: () => void;
}>) {
  const context = useConsoleContext();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState('');
  const [tracking, setTracking] = useState('');
  const [notice, setNotice] = useState('');
  const request = useRef<{ fulfillmentId: string; tracking: string; key: string } | null>(null);
  const eligible = (order?.fulfillments ?? []).filter((item) => item.kind === 'shipment'
    && !['cancelled', 'completed'].includes(item.state)
    && !item.milestones.some((step) => step.kind === 'shipment' && step.state === 'shipped'));
  const fulfillmentId = eligible.some((item) => item.id === selected) ? selected : eligible[0]?.id;
  const canShip = refreshed && order?.payment_state === 'paid' && order.lifecycle_state === 'active' && fulfillmentId !== undefined;

  const mutation = useMutation({
    mutationFn: ({ fulfillmentId, tracking, key }: NonNullable<typeof request.current>) => createShipment(
      { path: { fulfillmentid: fulfillmentId }, body: { tracking } },
      consoleCommand(context.scope, {
        accessVersion: context.session.accessVersion,
        idempotencyKey: key,
        ...(context.session.csrf === undefined ? {} : { csrfToken: context.session.csrf }),
      }),
    ),
    onSuccess: async () => {
      if (order) {
        await queryClient.invalidateQueries({ queryKey: orderDetailKey(context, order.id).slice(0, 5) });
      }
    },
  });

  return (
    <span className="orderpreviewtrigger" title={canShip ? undefined : '订单已付款且有可发货的履约单时可操作'}>
      <span className="sr-only" role="status">{notice}</span>
      <DialogTrigger>
        <Button type="button" isDisabled={!canShip || mutation.isPending} className="orderconfirmbutton">
          <OrderIcon name="truck" />确认发货
        </Button>
        <Popover className="orderpreviewpopover" placement="top end" offset={8}>
          <Dialog className="orderpreviewdialog" aria-label="录入运单并确认发货">
            {({ close }) => (
              <>
                <Heading slot="title">录入运单并确认发货</Heading>
                <p>订单 {order?.order_number}</p>
                <form className="orderpreviewdialog ordershipmentform" onSubmit={(event) => {
                  event.preventDefault();
                  const value = tracking.trim();
                  if (!canShip || !fulfillmentId || !value || mutation.isPending) return;
                  if (request.current?.fulfillmentId !== fulfillmentId || request.current.tracking !== value) {
                    request.current = { fulfillmentId, tracking: value, key: createIdempotencyKey() };
                  }
                  mutation.mutate(request.current, { onSuccess: () => {
                    setNotice(`已确认发货，运单号 ${value}`);
                    setTracking('');
                    request.current = null;
                    close();
                    onShipped();
                  } });
                }}>
                  {eligible.length > 1 ? (
                    <label>履约单<select value={fulfillmentId ?? ''} disabled={mutation.isPending} onChange={(event) => setSelected(event.target.value)}>
                      {eligible.map((item) => <option key={item.id} value={item.id}>{item.id}</option>)}
                    </select></label>
                  ) : <p>履约单 {fulfillmentId}</p>}
                  <label>运单号<input value={tracking} onChange={(event) => setTracking(event.target.value)}
                    required maxLength={128} disabled={mutation.isPending} /></label>
                  {mutation.error ? <p role="alert">发货提交失败 · {safeQueryError(mutation.error)}</p> : null}
                  <div className="orderpreviewdialogactions">
                    <Button type="button" onPress={close} isDisabled={mutation.isPending}>取消</Button>
                    <Button type="submit" isDisabled={!canShip || !tracking.trim() || mutation.isPending}>
                      {mutation.isPending ? '正在提交…' : '确认发货'}
                    </Button>
                  </div>
                </form>
              </>
            )}
          </Dialog>
        </Popover>
      </DialogTrigger>
    </span>
  );
}
