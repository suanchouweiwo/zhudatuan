// Generated shell from definitions/operations.yml. Do not edit.
import { OperationCatalog, type OperationId } from '@shop/contract';
import { token } from '../../bootstrap/Container';
import type { ModuleContext } from '../../bootstrap/ModuleRegistry';
import type { OperationHandler, OperationInput, OperationResult } from '../application/OperationHandler';
import type { AccessContext } from '../security/AccessContext';
import type { HttpRequest } from './HttpRequest';
import { json } from './HttpResponse';

export const CONTROLLER_OPERATION_IDS = Object.freeze([
  'runtime.health.live',
  'runtime.health.ready',
  'runtime.health.startup',
  'runtime.health.dependency',
  'identity.sessions.create',
  'identity.loginintents.create',
  'identity.tickets.exchange',
  'identity.session.read',
  'identity.session.delete',
  'identity.sessions.read',
  'identity.sessions.revoke',
  'identity.challenges.create',
  'identity.invitations.read',
  'identity.invitations.create',
  'identity.invitations.revoke',
  'identity.members.create',
  'identity.members.manage',
  'identity.password.change',
  'identity.password.verify',
  'identity.password.reset',
  'identity.mobile.manage',
  'identity.stepup.start',
  'identity.stepup.complete',
  'identity.wechat.session',
  'identity.wechat.bind',
  'organization.layers.read',
  'provisioning.malls.create',
  'provisioning.malls.read',
  'provisioning.nodetasks.read',
  'provisioning.nodetasks.retry',
  'access.center.read',
  'access.roles.manage',
  'access.scopes.manage',
  'access.administrators.members.read',
  'access.administrators.member.read',
  'access.administrators.scopes.manage',
  'access.administrators.members.note',
  'capability.assignments.read',
  'capability.assignments.manage',
  'partner.partners.read',
  'partner.partners.manage',
  'organization.stores.read',
  'organization.stores.manage',
  'member.members.read',
  'member.storefront.members.read',
  'member.storefront.detail.read',
  'member.storefront.invitees.read',
  'member.storefront.orders.read',
  'member.storefront.config.read',
  'member.storefront.config.manage',
  'member.storefront.custom.read',
  'member.storefront.custom.manage',
  'member.invitations.read',
  'member.profile.read',
  'member.malls.open',
  'member.sovereignty.upgrade',
  'member.addresses.read',
  'member.addresses.manage',
  'member.imports.create',
  'member.imports.read',
  'qualification.center.read',
  'qualification.decisions.preview',
  'qualification.policies.manage',
  'channel.distributors.create',
  'channel.distributors.read',
  'channel.distributors.update',
  'channel.distributors.disable',
  'channel.bindings.manage',
  'channel.quotas.manage',
  'catalog.pools.read',
  'catalog.pools.attach',
  'catalog.pools.detach',
  'catalog.pools.allocate',
  'catalog.products.create',
  'catalog.products.update',
  'catalog.products.archive',
  'catalog.listings.read',
  'catalog.listings.publish',
  'catalog.listings.unpublish',
  'catalog.listings.batch',
  'catalog.imports.create',
  'catalog.imports.read',
  'pricing.rules.create',
  'pricing.rules.publish',
  'pricing.offers.read',
  'inventory.availability.read',
  'inventory.imports.create',
  'inventory.imports.read',
  'marketing.campaigns.read',
  'reporting.dashboard.read',
  'reporting.sales.read',
  'reporting.products.read',
  'reporting.malls.read',
  'reporting.categories.read',
  'reporting.channels.read',
  'reporting.powderclass.read',
  'reporting.voucherconsumption.read',
  'reporting.exports.create',
  'reporting.exports.read',
  'experience.applications.create',
  'experience.published.read',
  'experience.applications.copy',
  'experience.applications.read',
  'experience.applications.update',
  'experience.versions.save',
  'experience.versions.validate',
  'experience.versions.publish',
  'experience.versions.restore',
  'cart.current.read',
  'cart.items.put',
  'cart.items.batch',
  'checkout.quote.create',
  'order.orders.create',
  'order.orders.read',
  'order.orders.receive',
  'order.reminders.create',
  'order.orders.export',
  'order.aftersales.read',
  'order.aftersales.apply',
  'order.aftersales.approve',
  'order.aftersales.reject',
  'fulfillment.shipments.create',
  'fulfillment.tracking.read',
  'fulfillment.returns.receive',
  'fulfillment.returns.inspect',
  'payment.intents.create',
  'payment.intents.read',
  'verification.challenges.issue',
  'verification.sessions.read',
  'verification.challenges.verify',
  'verification.history.read',
  'verification.devices.read',
  'verification.devices.manage',
  'payment.refunds.request',
  'payment.recoveries.read',
  'payment.recoveries.resolve',
  'payment.webhooks.wechat',
  'voucher.cardlibraries.read',
  'voucher.cardlibraries.create',
  'voucher.cardlibraries.allocate',
  'voucher.imports.read',
  'voucher.programs.read',
  'voucher.programs.manage',
  'voucher.reserves.read',
  'voucher.reserves.request',
  'voucher.reserves.decide',
  'voucher.batches.read',
  'voucher.batches.issue',
  'voucher.batches.retry',
  'voucher.status.batch',
  'voucher.statusbatches.read',
  'voucher.bindings.read',
  'voucher.bindings.manage',
  'voucher.redemptions.read',
  'voucher.history.read',
  'voucher.redemptions.reverse',
  'benefit.accounts.read',
  'benefit.ledgers.read',
  'benefit.plans.read',
  'benefit.plans.manage',
  'benefit.budgets.read',
  'benefit.budgets.manage',
  'benefit.grants.create',
  'benefit.grants.decide',
  'benefit.grants.read',
  'benefit.grants.control',
  'benefit.grants.revoke',
  'benefit.lots.read',
  'finance.overview.read',
  'finance.entries.read',
  'finance.statements.read',
  'finance.statements.export',
  'finance.reconciliations.manage',
  'finance.reconciliations.read',
  'finance.settlements.read',
  'finance.settlements.decide',
  'finance.settlements.adjust',
  'finance.withdrawals.read',
  'finance.withdrawals.create',
  'finance.withdrawals.decide',
  'finance.withdrawals.recover',
  'finance.holds.read',
  'finance.periods.read',
  'finance.periods.manage',
  'finance.backfills.read',
  'finance.backfills.decide',
  'finance.policies.manage',
  'invoice.profiles.manage',
  'invoice.profiles.read',
  'invoice.requests.create',
  'invoice.requests.read',
  'invoice.requests.cancel',
  'invoice.requests.decide',
  'invoice.requests.red',
  'support.cases.create',
  'support.cases.read',
  'support.cases.update',
  'support.cases.close',
  'support.cases.reopen',
  'support.messages.send',
  'support.messages.read',
  'support.attachments.create',
  'support.assignments.manage',
  'support.agents.manage',
  'support.agents.read',
  'support.accounts.manage',
  'support.accounts.read',
  'support.rules.read',
  'support.rules.manage',
  'support.slas.read',
  'support.slas.manage',
  'support.history.read',
  'notification.notifications.read',
  'notification.preferences.read',
  'notification.preferences.manage',
  'notification.endpoints.manage',
  'notification.templates.manage',
  'notification.templates.read',
  'notification.announcements.read',
  'notification.announcements.manage',
  'risk.center.read',
  'risk.policies.manage',
  'risk.cases.review',
  'audit.records.read',
  'observability.clienterrors.create',
  'observability.clienterrors.read',
  'channel.connections.read',
  'channel.connections.create',
  'channel.connections.update',
  'channel.connections.test',
  'channel.connections.enable',
  'channel.connections.disable',
  'channel.webhooks.receive',
  'channel.syncruns.start',
  'channel.syncruns.read',
  'channel.syncruns.cancel',
  'channel.operations.read',
  'channel.operations.replay',
  'extension.installations.read',
  'identity.storefronts.read',
  'identity.members.reset',
  'identity.mobile.challenge',
  'access.ownership.read',
  'access.ownership.transfers.preview',
  'access.ownership.transfers.create',
  'access.ownership.transfers.accept.preview',
  'access.ownership.transfers.accept',
  'access.ownership.transfers.cancel',
  'access.ownership.transfers.cancel.preview',
  'referral.settings.read',
  'referral.settings.manage',
  'referral.products.read',
  'referral.products.manage',
  'referral.members.read',
  'referral.members.apply',
  'referral.members.approve',
  'referral.members.disqualify',
  'referral.bindings.read',
  'referral.bindings.create',
  'referral.commissions.read',
  'referral.earnings.read',
  'referral.links.read',
  'referral.withdrawals.read',
  'referral.withdrawals.create',
  'finance.reconciliationrepairs.read',
  'finance.reconciliationrepairs.preview',
  'finance.reconciliationrepairs.submit',
  'finance.reconciliationrepairs.decide',
  'finance.reconciliationrepairs.reverse',
  'finance.policies.preview',
  'finance.policies.read',
  'finance.audit.read',
  'invoice.operatorprofiles.read',
] as const satisfies readonly OperationId[]);

export interface OperationAuthorizer {
  authorize(headers: Readonly<Record<string, string>>, operation: string, permission: string, resource?: string,
    requireStepUp?: boolean): Promise<AccessContext>;
}

export const OPERATION_HANDLERS = token<Map<OperationId, OperationHandler>>('operation.handlers');
export const OPERATION_AUTHORIZER = token<OperationAuthorizer>('operation.authorizer');

export function registerOperationRoutes(module: string, context: ModuleContext): void {
  registerRoutes(OperationCatalog.all().filter((candidate) => candidate.module === module), context);
}

export function registerSelectedOperationRoutes(operationIds: readonly OperationId[], context: ModuleContext): void {
  registerRoutes(operationIds.map((operationId) => OperationCatalog.get(operationId)), context);
}

function registerRoutes(operations: ReturnType<typeof OperationCatalog.all>, context: ModuleContext): void {
  const handlers = context.container.get(OPERATION_HANDLERS);
  const authorizer = context.container.get(OPERATION_AUTHORIZER);
  for (const operation of operations) {
    const handler = handlers.get(operation.id);
    if (!handler) throw new Error(`OPERATION_HANDLER_MISSING:${operation.id}`);
    context.routes.register({ operation: operation.id, handler: async (request) => {
      const resource = operationResource(operation.id, request);
      const access = await operationAccess(operation, request, resource, authorizer);
      const input = contractOperationInput(operation.id, operationInput(operation.id, request, resource));
      const result: OperationResult = await handler.handle({ type: operation.id, input, access });
      return json(result.status, result.body, result.headers);
    } });
  }
}

async function operationAccess(operation: ReturnType<typeof OperationCatalog.get>, request: HttpRequest, resource: string | undefined,
  authorizer: OperationAuthorizer): Promise<AccessContext | null> {
  if (operation.id === 'identity.wechat.session' && authenticatedWechatMode(request.body)) {
    const currentSession = OperationCatalog.get('identity.session.read');
    return authorizer.authorize(request.headers, currentSession.id, currentSession.permission ?? currentSession.id, resource);
  }
  if (operation.audience === 'public' || operation.audience === 'provider') return null;
  if (isAdministratorOffboard(operation.id, request.body)) {
    return authorizer.authorize(request.headers, operation.id, operation.permission, resource, false);
  }
  if (operation.id === 'provisioning.instances.manage') {
    return authorizer.authorize(request.headers, operation.id, operation.permission, resource, operation.stepup);
  }
  return authorizer.authorize(request.headers, operation.id, operation.permission, resource);
}

function isAdministratorOffboard(operation: string, body: unknown): boolean {
  return operation === 'access.roles.manage' && body !== null && typeof body === 'object'
    && !Array.isArray(body) && Reflect.get(body, 'action') === 'offboard';
}

function authenticatedWechatMode(body: unknown): boolean {
  return body !== null && typeof body === 'object' && !Array.isArray(body) && Reflect.get(body, 'mode') === 'authenticated';
}

function operationInput(operation: string, request: HttpRequest, resource: string | undefined): OperationInput {
  const idempotency = request.headers['idempotency-key'];
  if (OperationCatalog.get(operation as OperationId).idempotency === 'required' && idempotency === undefined) throw new Error('IDEMPOTENCY_KEY_REQUIRED');
  const header = request.headers['if-match'];
  const normalized = header?.replace(/^W\//, '').replace(/^"|"$/g, '');
  const expectedVersion = normalized === undefined ? undefined : Number(normalized);
  if (normalized !== undefined && (!Number.isSafeInteger(expectedVersion) || expectedVersion! < 0)) throw new Error('EXPECTED_VERSION_INVALID');
  if (OperationCatalog.get(operation as OperationId).expectedVersion === 'required' && expectedVersion === undefined) throw new Error('EXPECTED_VERSION_REQUIRED');
  return { path: request.parameters, query: queryObject(request.query), headers: request.headers, body: request.body, rawBody: request.rawBody, deadline: request.deadline, signal: request.signal,
    ...(resource === undefined ? {} : { resource }), ...(idempotency === undefined ? {} : { idempotency }), ...(expectedVersion === undefined ? {} : { expectedVersion }) };
}

function contractOperationInput(operation: OperationId, input: OperationInput): OperationInput {
  void operation;
  return Object.freeze({ ...input });
}

function operationResource(operation: string, request: HttpRequest): string | undefined {
  if (isAdministratorOffboard(operation, request.body)) return undefined;
  // A new policy id is not resolvable before its first approved revision. The selected Scope is the authorization resource; the path id remains bound by ExpectedVersion and the canonical request hash.
  if (operation === 'finance.policies.manage' || operation === 'finance.policies.preview') return undefined;
  // Member targets remain path IDs; authorization resolves the selected mall.
  if (['member.storefront.detail.read', 'member.storefront.invitees.read', 'member.storefront.orders.read',
    'member.storefront.custom.read', 'member.storefront.custom.manage'].includes(operation)) return undefined;
  const pathResource = Object.values(request.parameters)[0];
  if (operation === 'catalog.imports.read' && pathResource?.startsWith('catalogpublication:')) return undefined;
  if (pathResource !== undefined) return pathResource;
  if (!['finance.withdrawals.create', 'invoice.requests.create'].includes(operation) || request.body === null || typeof request.body !== 'object' || Array.isArray(request.body)) return undefined;
  const settlement = Reflect.get(request.body, 'settlement');
  return typeof settlement === 'string' && settlement.length > 0 ? settlement : undefined;
}

function queryObject(parameters: URLSearchParams): Readonly<Record<string, string | readonly string[]>> {
  const result: Record<string, string | readonly string[]> = {};
  for (const key of new Set(parameters.keys())) {
    const values = parameters.getAll(key);
    result[key] = values.length === 1 ? values[0]! : Object.freeze(values);
  }
  return Object.freeze(result);
}
