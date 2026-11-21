// Generated from definitions/operations.yml. Do not edit.
import type { OperationId } from '@shop/contract';
import type { OperationExecutor } from '../OperationDescriptor';
import { createRuntimeOperations, type RuntimeOperations } from './runtime';
import { createIdentityOperations, type IdentityOperations } from './identity';
import { createOrganizationOperations, type OrganizationOperations } from './organization';
import { createProvisioningOperations, type ProvisioningOperations } from './provisioning';
import { createAccessOperations, type AccessOperations } from './access';
import { createCapabilityOperations, type CapabilityOperations } from './capability';
import { createPartnerOperations, type PartnerOperations } from './partner';
import { createMemberOperations, type MemberOperations } from './member';
import { createQualificationOperations, type QualificationOperations } from './qualification';
import { createChannelOperations, type ChannelOperations } from './channel';
import { createCatalogOperations, type CatalogOperations } from './catalog';
import { createPricingOperations, type PricingOperations } from './pricing';
import { createInventoryOperations, type InventoryOperations } from './inventory';
import { createMarketingOperations, type MarketingOperations } from './marketing';
import { createReportingOperations, type ReportingOperations } from './reporting';
import { createExperienceOperations, type ExperienceOperations } from './experience';
import { createCartOperations, type CartOperations } from './cart';
import { createCheckoutOperations, type CheckoutOperations } from './checkout';
import { createOrderOperations, type OrderOperations } from './order';
import { createFulfillmentOperations, type FulfillmentOperations } from './fulfillment';
import { createPaymentOperations, type PaymentOperations } from './payment';
import { createVerificationOperations, type VerificationOperations } from './verification';
import { createVoucherOperations, type VoucherOperations } from './voucher';
import { createBenefitOperations, type BenefitOperations } from './benefit';
import { createFinanceOperations, type FinanceOperations } from './finance';
import { createInvoiceOperations, type InvoiceOperations } from './invoice';
import { createSupportOperations, type SupportOperations } from './support';
import { createNotificationOperations, type NotificationOperations } from './notification';
import { createRiskOperations, type RiskOperations } from './risk';
import { createAuditOperations, type AuditOperations } from './audit';
import { createObservabilityOperations, type ObservabilityOperations } from './observability';
import { createExtensionOperations, type ExtensionOperations } from './extension';
import { createReferralOperations, type ReferralOperations } from './referral';
import { createApprovalOperations, type ApprovalOperations } from './approval';

export type { RuntimeOperations } from './runtime';
export type { IdentityOperations } from './identity';
export type { OrganizationOperations } from './organization';
export type { ProvisioningOperations } from './provisioning';
export type { AccessOperations } from './access';
export type { CapabilityOperations } from './capability';
export type { PartnerOperations } from './partner';
export type { MemberOperations } from './member';
export type { QualificationOperations } from './qualification';
export type { ChannelOperations } from './channel';
export type { CatalogOperations } from './catalog';
export type { PricingOperations } from './pricing';
export type { InventoryOperations } from './inventory';
export type { MarketingOperations } from './marketing';
export type { ReportingOperations } from './reporting';
export type { ExperienceOperations } from './experience';
export type { CartOperations } from './cart';
export type { CheckoutOperations } from './checkout';
export type { OrderOperations } from './order';
export type { FulfillmentOperations } from './fulfillment';
export type { PaymentOperations } from './payment';
export type { VerificationOperations } from './verification';
export type { VoucherOperations } from './voucher';
export type { BenefitOperations } from './benefit';
export type { FinanceOperations } from './finance';
export type { InvoiceOperations } from './invoice';
export type { SupportOperations } from './support';
export type { NotificationOperations } from './notification';
export type { RiskOperations } from './risk';
export type { AuditOperations } from './audit';
export type { ObservabilityOperations } from './observability';
export type { ExtensionOperations } from './extension';
export type { ReferralOperations } from './referral';
export type { ApprovalOperations } from './approval';
export type { OperationMethod } from '../OperationDescriptor';

export const SDK_OPERATION_IDS = /* @__PURE__ */ Object.freeze([
  "runtime.health.live",
  "runtime.health.ready",
  "runtime.health.startup",
  "runtime.health.dependency",
  "identity.sessions.create",
  "identity.loginintents.create",
  "identity.tickets.exchange",
  "identity.session.read",
  "identity.session.delete",
  "identity.sessions.read",
  "identity.sessions.revoke",
  "identity.challenges.create",
  "identity.invitations.read",
  "identity.invitations.create",
  "identity.invitations.revoke",
  "identity.members.create",
  "identity.members.manage",
  "identity.password.change",
  "identity.password.verify",
  "identity.password.reset",
  "identity.mobile.manage",
  "identity.stepup.start",
  "identity.stepup.complete",
  "identity.wechat.session",
  "identity.wechat.bind",
  "organization.layers.read",
  "provisioning.malls.create",
  "provisioning.malls.read",
  "provisioning.nodetasks.read",
  "provisioning.nodetasks.retry",
  "provisioning.instances.read",
  "provisioning.instances.manage",
  "access.center.read",
  "access.roles.manage",
  "access.scopes.manage",
  "access.administrators.members.read",
  "access.administrators.member.read",
  "access.administrators.scopes.manage",
  "access.administrators.members.note",
  "capability.assignments.read",
  "capability.assignments.manage",
  "partner.partners.read",
  "partner.partners.manage",
  "organization.stores.read",
  "organization.stores.manage",
  "member.members.read",
  "member.storefront.members.read",
  "member.storefront.detail.read",
  "member.storefront.invitees.read",
  "member.storefront.orders.read",
  "member.storefront.config.read",
  "member.storefront.config.manage",
  "member.storefront.custom.read",
  "member.storefront.custom.manage",
  "member.invitations.read",
  "member.profile.read",
  "member.malls.open",
  "member.sovereignty.upgrade",
  "member.addresses.read",
  "member.addresses.manage",
  "member.imports.create",
  "member.imports.read",
  "qualification.center.read",
  "qualification.decisions.preview",
  "qualification.policies.manage",
  "channel.distributors.create",
  "channel.distributors.read",
  "channel.distributors.update",
  "channel.distributors.disable",
  "channel.bindings.manage",
  "channel.quotas.manage",
  "catalog.pools.read",
  "catalog.pools.attach",
  "catalog.pools.detach",
  "catalog.pools.allocate",
  "catalog.products.create",
  "catalog.products.update",
  "catalog.products.archive",
  "catalog.listings.read",
  "catalog.listings.publish",
  "catalog.listings.unpublish",
  "catalog.listings.batch",
  "catalog.imports.create",
  "catalog.imports.read",
  "pricing.rules.create",
  "pricing.rules.publish",
  "pricing.offers.read",
  "inventory.availability.read",
  "inventory.imports.create",
  "inventory.imports.read",
  "marketing.campaigns.read",
  "reporting.dashboard.read",
  "reporting.sales.read",
  "reporting.products.read",
  "reporting.malls.read",
  "reporting.categories.read",
  "reporting.channels.read",
  "reporting.powderclass.read",
  "reporting.voucherconsumption.read",
  "reporting.exports.create",
  "reporting.exports.read",
  "experience.applications.create",
  "experience.published.read",
  "experience.applications.copy",
  "experience.applications.read",
  "experience.applications.update",
  "experience.versions.save",
  "experience.versions.validate",
  "experience.versions.publish",
  "experience.versions.restore",
  "cart.current.read",
  "cart.items.put",
  "cart.items.batch",
  "checkout.quote.create",
  "order.orders.create",
  "order.orders.read",
  "order.orders.receive",
  "order.reminders.create",
  "order.orders.export",
  "order.aftersales.read",
  "order.aftersales.apply",
  "order.aftersales.approve",
  "order.aftersales.reject",
  "fulfillment.shipments.create",
  "fulfillment.tracking.read",
  "fulfillment.returns.receive",
  "fulfillment.returns.inspect",
  "payment.intents.create",
  "payment.intents.read",
  "verification.challenges.issue",
  "verification.sessions.read",
  "verification.challenges.verify",
  "verification.history.read",
  "verification.devices.read",
  "verification.devices.manage",
  "payment.refunds.request",
  "payment.recoveries.read",
  "payment.recoveries.resolve",
  "payment.webhooks.wechat",
  "voucher.cardlibraries.read",
  "voucher.cardlibraries.create",
  "voucher.cardlibraries.allocate",
  "voucher.imports.read",
  "voucher.programs.read",
  "voucher.programs.manage",
  "voucher.reserves.read",
  "voucher.reserves.request",
  "voucher.reserves.decide",
  "voucher.batches.read",
  "voucher.batches.issue",
  "voucher.batches.retry",
  "voucher.status.batch",
  "voucher.statusbatches.read",
  "voucher.bindings.read",
  "voucher.bindings.manage",
  "voucher.redemptions.read",
  "voucher.history.read",
  "voucher.redemptions.reverse",
  "benefit.accounts.read",
  "benefit.ledgers.read",
  "benefit.plans.read",
  "benefit.plans.manage",
  "benefit.budgets.read",
  "benefit.budgets.manage",
  "benefit.grants.create",
  "benefit.grants.decide",
  "benefit.grants.read",
  "benefit.grants.control",
  "benefit.grants.revoke",
  "benefit.lots.read",
  "finance.overview.read",
  "finance.entries.read",
  "finance.statements.read",
  "finance.statements.export",
  "finance.reconciliations.manage",
  "finance.reconciliations.read",
  "finance.settlements.read",
  "finance.settlements.decide",
  "finance.settlements.adjust",
  "finance.withdrawals.read",
  "finance.withdrawals.create",
  "finance.withdrawals.decide",
  "finance.withdrawals.recover",
  "finance.holds.read",
  "finance.periods.read",
  "finance.periods.manage",
  "finance.backfills.read",
  "finance.backfills.decide",
  "finance.policies.manage",
  "invoice.profiles.manage",
  "invoice.profiles.read",
  "invoice.requests.create",
  "invoice.requests.read",
  "invoice.requests.cancel",
  "invoice.requests.decide",
  "invoice.requests.red",
  "support.cases.create",
  "support.cases.read",
  "support.cases.update",
  "support.cases.close",
  "support.cases.reopen",
  "support.messages.send",
  "support.messages.read",
  "support.attachments.create",
  "support.assignments.manage",
  "support.agents.manage",
  "support.agents.read",
  "support.accounts.manage",
  "support.accounts.read",
  "support.rules.read",
  "support.rules.manage",
  "support.slas.read",
  "support.slas.manage",
  "support.history.read",
  "notification.notifications.read",
  "notification.preferences.read",
  "notification.preferences.manage",
  "notification.endpoints.manage",
  "notification.templates.manage",
  "notification.templates.read",
  "notification.announcements.read",
  "notification.announcements.manage",
  "risk.center.read",
  "risk.policies.manage",
  "risk.cases.review",
  "audit.records.read",
  "observability.clienterrors.create",
  "observability.clienterrors.read",
  "channel.connections.read",
  "channel.connections.create",
  "channel.connections.update",
  "channel.connections.test",
  "channel.connections.enable",
  "channel.connections.disable",
  "channel.webhooks.receive",
  "channel.syncruns.start",
  "channel.syncruns.read",
  "channel.syncruns.cancel",
  "channel.operations.read",
  "channel.operations.replay",
  "extension.installations.read",
  "identity.storefronts.read",
  "identity.members.reset",
  "identity.mobile.challenge",
  "access.ownership.read",
  "access.ownership.transfers.preview",
  "access.ownership.transfers.create",
  "access.ownership.transfers.accept.preview",
  "access.ownership.transfers.accept",
  "access.ownership.transfers.cancel",
  "access.ownership.transfers.cancel.preview",
  "referral.settings.read",
  "referral.settings.manage",
  "referral.products.read",
  "referral.products.manage",
  "referral.members.read",
  "referral.members.apply",
  "referral.members.approve",
  "referral.members.disqualify",
  "referral.bindings.read",
  "referral.bindings.create",
  "referral.commissions.read",
  "referral.earnings.read",
  "referral.links.read",
  "referral.withdrawals.read",
  "referral.withdrawals.create",
  "finance.reconciliationrepairs.read",
  "finance.reconciliationrepairs.preview",
  "finance.reconciliationrepairs.submit",
  "finance.reconciliationrepairs.decide",
  "finance.reconciliationrepairs.reverse",
  "finance.policies.preview",
  "finance.policies.read",
  "finance.audit.read",
  "invoice.operatorprofiles.read",
  "partner.customers.create",
  "partner.customers.update",
  "partner.customers.enable",
  "partner.customers.disable",
  "partner.customers.get",
  "partner.customers.list",
  "partner.customeroptions.list",
  "voucher.products.create",
  "voucher.products.revise",
  "voucher.products.enable",
  "voucher.products.disable",
  "voucher.products.get",
  "voucher.products.list",
  "voucher.productoptions.list",
  "voucher.credentialpools.create",
  "voucher.credentials.generate",
  "voucher.credentials.import",
  "voucher.credentialpools.close",
  "voucher.credentialpools.get",
  "voucher.credentialpools.list",
  "voucher.credentials.list",
  "voucher.credentials.get",
  "voucher.credentialexports.create",
  "voucher.jobs.get",
  "voucher.stockrequests.create",
  "voucher.stockrequests.update",
  "voucher.stockrequests.submit",
  "voucher.stockrequests.cancel",
  "voucher.stockrequests.get",
  "voucher.stockrequests.list",
  "voucher.stockrequestoptions.list",
  "approval.templates.create",
  "approval.templates.revise",
  "approval.templates.enable",
  "approval.templates.disable",
  "approval.templates.get",
  "approval.templates.list",
  "approval.tasks.list",
  "approval.tasks.approve",
  "approval.tasks.reject",
  "approval.instances.get",
  "voucher.issueorders.create",
  "voucher.issueorders.update",
  "voucher.issueorders.submit",
  "voucher.issueorders.cancel",
  "voucher.issueorders.get",
  "voucher.issueorders.list",
  "voucher.issuebatches.retry",
  "voucher.issuebatches.get",
  "voucher.issueorderexports.create",
  "voucher.actionbatches.create",
  "voucher.actionbatches.get",
  "voucher.actionbatches.list",
  "voucher.actionbatches.retry",
  "voucher.actionexports.create",
  "voucher.search.read",
  "voucher.activations.secret",
  "voucher.activations.numbersecret",
  "voucher.vouchers.bind",
  "voucher.vouchers.unbind",
  "voucher.vouchers.get",
  "voucher.vouchers.getbynumber",
  "voucher.vouchers.timeline",
  "voucher.redemptions.quote",
  "voucher.tenderholds.create",
  "voucher.tenderholds.consume",
  "voucher.tenderholds.release",
  "voucher.redemptions.create",
  "voucher.refunds.create",
  "voucher.redemptions.get",
  "voucher.searchfacets.read",
  "voucher.searchsnapshots.create",
  "voucher.searchexports.create",
  "voucher.exports.get",
] as const satisfies readonly OperationId[]);

export interface CommerceClient {
  readonly runtime: RuntimeOperations;
  readonly identity: IdentityOperations;
  readonly organization: OrganizationOperations;
  readonly provisioning: ProvisioningOperations;
  readonly access: AccessOperations;
  readonly capability: CapabilityOperations;
  readonly partner: PartnerOperations;
  readonly member: MemberOperations;
  readonly qualification: QualificationOperations;
  readonly channel: ChannelOperations;
  readonly catalog: CatalogOperations;
  readonly pricing: PricingOperations;
  readonly inventory: InventoryOperations;
  readonly marketing: MarketingOperations;
  readonly reporting: ReportingOperations;
  readonly experience: ExperienceOperations;
  readonly cart: CartOperations;
  readonly checkout: CheckoutOperations;
  readonly order: OrderOperations;
  readonly fulfillment: FulfillmentOperations;
  readonly payment: PaymentOperations;
  readonly verification: VerificationOperations;
  readonly voucher: VoucherOperations;
  readonly benefit: BenefitOperations;
  readonly finance: FinanceOperations;
  readonly invoice: InvoiceOperations;
  readonly support: SupportOperations;
  readonly notification: NotificationOperations;
  readonly risk: RiskOperations;
  readonly audit: AuditOperations;
  readonly observability: ObservabilityOperations;
  readonly extension: ExtensionOperations;
  readonly referral: ReferralOperations;
  readonly approval: ApprovalOperations;
}

export function createCommerceClient(client: OperationExecutor): CommerceClient {
  return Object.freeze({
    runtime: createRuntimeOperations(client),
    identity: createIdentityOperations(client),
    organization: createOrganizationOperations(client),
    provisioning: createProvisioningOperations(client),
    access: createAccessOperations(client),
    capability: createCapabilityOperations(client),
    partner: createPartnerOperations(client),
    member: createMemberOperations(client),
    qualification: createQualificationOperations(client),
    channel: createChannelOperations(client),
    catalog: createCatalogOperations(client),
    pricing: createPricingOperations(client),
    inventory: createInventoryOperations(client),
    marketing: createMarketingOperations(client),
    reporting: createReportingOperations(client),
    experience: createExperienceOperations(client),
    cart: createCartOperations(client),
    checkout: createCheckoutOperations(client),
    order: createOrderOperations(client),
    fulfillment: createFulfillmentOperations(client),
    payment: createPaymentOperations(client),
    verification: createVerificationOperations(client),
    voucher: createVoucherOperations(client),
    benefit: createBenefitOperations(client),
    finance: createFinanceOperations(client),
    invoice: createInvoiceOperations(client),
    support: createSupportOperations(client),
    notification: createNotificationOperations(client),
    risk: createRiskOperations(client),
    audit: createAuditOperations(client),
    observability: createObservabilityOperations(client),
    extension: createExtensionOperations(client),
    referral: createReferralOperations(client),
    approval: createApprovalOperations(client),
  });
}
