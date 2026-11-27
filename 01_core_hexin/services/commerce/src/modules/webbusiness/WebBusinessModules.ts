import { defineSelectedModule } from '../../bootstrap/DefinedModule';
import { cartOperations } from '../cart';
import { fulfillmentOperations } from '../fulfillment/03_application_yingyong/FulfillmentOperations';
import { organizationOperations } from '../organization';
import { webBenefitOperations } from './WebBenefitOperations';
import { webCatalogOperations } from './WebCatalogOperations';
import { webInventoryOperations } from './WebInventoryOperations';
import { webMemberOperations } from './WebMemberOperations';
import { webOrderOperations } from './WebOrderOperations';
import { webPricingOperations } from './WebPricingOperations';
import { webReportingOperations } from './WebReportingOperations';
import {
  WEB_BENEFIT_OPERATION_IDS,
  WEB_CART_OPERATION_IDS,
  WEB_CATALOG_OPERATION_IDS,
  WEB_INVENTORY_OPERATION_IDS,
  WEB_FULFILLMENT_OPERATION_IDS,
  WEB_MEMBER_OPERATION_IDS,
  WEB_ORDER_OPERATION_IDS,
  WEB_ORGANIZATION_OPERATION_IDS,
  WEB_PRICING_OPERATION_IDS,
  WEB_REPORTING_OPERATION_IDS,
} from './WebBusinessOperationIds';

export const WebOrganizationModule = defineSelectedModule(
  'organization', WEB_ORGANIZATION_OPERATION_IDS, organizationOperations,
);
export const WebMemberModule = defineSelectedModule('member', WEB_MEMBER_OPERATION_IDS, webMemberOperations);
export const WebCatalogModule = defineSelectedModule('catalog', WEB_CATALOG_OPERATION_IDS, webCatalogOperations);
export const WebPricingModule = defineSelectedModule('pricing', WEB_PRICING_OPERATION_IDS, webPricingOperations);
export const WebInventoryModule = defineSelectedModule('inventory', WEB_INVENTORY_OPERATION_IDS, webInventoryOperations);
export const WebReportingModule = defineSelectedModule('reporting', WEB_REPORTING_OPERATION_IDS, webReportingOperations);
export const WebCartModule = defineSelectedModule('cart', WEB_CART_OPERATION_IDS, cartOperations);
export const WebOrderModule = defineSelectedModule('order', WEB_ORDER_OPERATION_IDS, webOrderOperations);
const WebFulfillmentModule = defineSelectedModule('fulfillment', WEB_FULFILLMENT_OPERATION_IDS, fulfillmentOperations);
export const WebBenefitModule = defineSelectedModule('benefit', WEB_BENEFIT_OPERATION_IDS, webBenefitOperations);

export const WEB_BUSINESS_MODULES = Object.freeze([
  WebOrganizationModule,
  WebMemberModule,
  WebCatalogModule,
  WebPricingModule,
  WebInventoryModule,
  WebReportingModule,
  WebCartModule,
  WebOrderModule,
  WebFulfillmentModule,
  WebBenefitModule,
]);
