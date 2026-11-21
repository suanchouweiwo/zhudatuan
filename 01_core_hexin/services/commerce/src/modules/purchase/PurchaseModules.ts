import { defineSelectedModule } from '../../bootstrap/DefinedModule';
import {
  PURCHASE_ORDER_OPERATION_IDS,
  purchaseCheckoutOperations,
  purchaseOrderOperations,
  purchasePaymentOperations,
} from './PurchaseOperations';

export const PurchaseCheckoutModule = defineSelectedModule(
  'checkout', ['checkout.quote.create'], purchaseCheckoutOperations,
);
export const PurchaseOrderModule = defineSelectedModule(
  'order', PURCHASE_ORDER_OPERATION_IDS, purchaseOrderOperations,
);
export const PurchasePaymentModule = defineSelectedModule(
  'payment', ['payment.intents.create', 'payment.intents.read'], purchasePaymentOperations,
);

export const PURCHASE_MODULES = Object.freeze([
  PurchaseCheckoutModule,
  PurchaseOrderModule,
  PurchasePaymentModule,
]);
