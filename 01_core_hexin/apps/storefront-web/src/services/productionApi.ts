import { canonicalCall, canonicalClient, anonymousContext, anonymousIdempotentContext, clearCanonicalSession, rememberCanonicalSession, sessionContext } from './canonicalApiClient';
import { beginBrowserAuthorization } from '@shop/sdk/browser-authorization';
import { createSecureId } from '@shop/sdk/context';
import { checkoutWithCanonicalPayment, continueWithCanonicalPayment } from './canonicalCheckout';
import { readCanonicalPaymentResult } from './canonicalPaymentResult';
import { mapCanonicalProductPage } from './canonicalCatalogMapper';
import { mapCanonicalAccounts, mapCanonicalCart, mapCanonicalLedgers, mapCanonicalOrders } from './canonicalCommerceMapper';
import { mapCanonicalAddresses, mapCanonicalBootstrap, mapCanonicalSession } from './canonicalIdentityMapper';
import { boolean, nextCursor, nonNegativeInteger, optionalText, pageItems, record, text } from './canonicalShape';
import { ProductionApiError } from './productionApi.error';
import type { ApiAccount, ApiAccountLedger, ApiActor, ApiBootstrap, ApiCartItem, ApiDeliveryAddress, ApiHomeSnapshot, ApiOrder, ApiProduct, LoginRequest } from './productionApi.types';
import { resolveStorefrontApplication, resolveStorefrontAuthTarget, resolveStorefrontPresentationIdentity } from '../config/storefrontIdentity';
import { listPublicProducts } from './publicCatalogApi';

export { ProductionApiError } from './productionApi.error';
export type { ApiAccount, ApiAccountLedger, ApiActor, ApiAfterSale, ApiBootstrap, ApiCartItem, ApiDeliveryAddress, ApiHomeSnapshot, ApiOrder, ApiPaymentResult, ApiPaymentResultState, ApiProduct, ApiSecurityCenter, CreateOrderRequest, LoginRequest } from './productionApi.types';

type CatalogOptions = { category?: string; cursor?: string; limit?: number };


interface StorefrontAuthorization {
  request: Readonly<{ state: string; nonce: string; challenge: string }>;
  secret: Readonly<{ nonce: string; verifier: string }>;
}

async function beginStorefrontAuthorization(): Promise<StorefrontAuthorization> {
  return beginBrowserAuthorization();
}

async function createStorefrontSession(input: LoginRequest, membership?: string): Promise<void> {
  const subject = (input.username ?? input.accessCode)?.trim();
  const password = input.password ?? input.accessCode;
  if (!subject || !password) throw new Error('请输入账号和密码');

  const authorization = await beginStorefrontAuthorization();
  const application = resolveStorefrontApplication();
  const value = record(await canonicalCall(() => canonicalClient().identity.sessionsCreate({ body: {
    provider: 'password',
    subject,
    password,
    target: resolveStorefrontAuthTarget(application),
    application,
    ...(membership ? { membership } : {}),
    authorization: authorization.request,
  } }, anonymousIdempotentContext())), 'identity.sessions.create');

  if (Array.isArray(value.memberships)) {
    const memberships = value.memberships.map((item, index) => record(item, `identity.sessions.create.memberships[${index}]`));
    const candidate = memberships.find((item) => optionalText(item.client) === 'storefront') ?? memberships[0];
    if (!candidate) throw new Error('该账号没有可用的商城身份');
    await createStorefrontSession(input, text(candidate.id, 'identity.sessions.create.membership.id'));
    return;
  }

  if (text(value.target, 'identity.sessions.create.target') !== 'storefront') throw new Error('登录身份不属于消费者商城');
  const callback = record(value.callback, 'identity.sessions.create.callback');
  await canonicalCall(() => canonicalClient().identity.ticketsExchange({ body: {
    ticket: text(callback.ticket, 'identity.sessions.create.callback.ticket'),
    state: text(callback.state, 'identity.sessions.create.callback.state'),
    nonce: authorization.secret.nonce,
    verifier: authorization.secret.verifier,
  } }, anonymousIdempotentContext()));
}

async function sessionBootstrap(): Promise<ApiBootstrap> {
  const client = canonicalClient();
  const session = mapCanonicalSession(await canonicalCall(() => client.identity.sessionRead({}, anonymousContext())));
  rememberCanonicalSession(session);
  let profile: unknown;
  try {
    profile = await canonicalCall(() => client.member.profileRead({}, sessionContext()));
  } catch {
    // The identity session is already authoritative. A delayed or denied
    // profile read must not erase the member shell and show the user as a guest.
    // Only identity-verified claims are used here; no profile field is invented.
    profile = {
      id: session.membership,
      employee_no: session.membership,
      display_name: session.phoneMasked ?? session.membership,
    };
  }
  return mapCanonicalBootstrap(session, profile, resolveStorefrontPresentationIdentity());
}

async function accounts(): Promise<ApiAccount[]> {
  const value = await canonicalCall(() => canonicalClient().benefit.accountsRead({ query: { limit: 100 } }, sessionContext()));
  return mapCanonicalAccounts(value);
}

async function ledgers(currentAccounts: readonly ApiAccount[]): Promise<ApiAccountLedger[]> {
  try {
    const value = await canonicalCall(() => canonicalClient().benefit.ledgersRead({ query: { limit: 100 } }, sessionContext()));
    return mapCanonicalLedgers(value, currentAccounts);
  } catch (error) {
    // The canonical contract exists, but the current public WebBusiness
    // allowlist has not exposed it yet. Keep the rest of the account snapshot
    // usable without manufacturing ledger rows.
    if (error instanceof ProductionApiError && error.status === 404) return [];
    throw error;
  }
}

async function orders(): Promise<ApiOrder[]> {
  const items: ApiOrder[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 60; page += 1) {
    const value = await canonicalCall(() => canonicalClient().order.ordersRead({ query: { limit: 100, ...(cursor ? { cursor } : {}) } }, sessionContext()));
    const mapped = mapCanonicalOrders(value);
    items.push(...mapped.items);
    if (!mapped.nextCursor || mapped.nextCursor === cursor) return items;
    cursor = mapped.nextCursor;
  }
  throw new ProductionApiError('订单分页超过安全上限', 502, 'ORDER_PAGE_LIMIT_EXCEEDED');
}

async function inventory(skus: readonly string[]): Promise<{ items: unknown[] }> {
  const items: unknown[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 20; page += 1) {
    const value = await canonicalCall(() => canonicalClient().inventory.availabilityRead({
      query: { sku: skus, limit: 100, ...(cursor ? { cursor } : {}) },
    }, sessionContext()));
    items.push(...pageItems(value, 'inventory.availability'));
    const next = nextCursor(value);
    if (!next || next === cursor) return { items };
    cursor = next;
  }
  throw new ProductionApiError('库存分页超过安全上限', 502, 'INVENTORY_PAGE_LIMIT_EXCEEDED');
}

async function publicStorefront(): Promise<{ id: string; name: string }> {
  const value = await canonicalCall(() => canonicalClient().identity.storefrontsRead({
    body: { application: resolveStorefrontApplication() },
  }, anonymousIdempotentContext()));
  const payload = record(value, 'identity.storefront');
  return {
    id: text(payload.organization_id, 'identity.storefront.organization_id'),
    name: text(payload.organization_name, 'identity.storefront.organization_name'),
  };
}

async function qualifiedCatalog(options: CatalogOptions): Promise<{ items: ApiProduct[]; pagination: { nextCursor: string | null } }> {
  const query = { limit: options.limit ?? 100, ...(options.cursor ? { cursor: options.cursor } : {}), ...(options.category ? { category: options.category } : {}) };
  const listings = await canonicalCall(() => canonicalClient().catalog.listingsRead({ query }, sessionContext()));
  const skus = pageItems(listings, 'catalog.listings').map((item) => text(item.sku_id, 'catalog.listing.sku_id'));
  if (skus.length === 0) return { items: [], pagination: { nextCursor: nextCursor(listings) } };
  const [offerValue, inventoryValue] = await Promise.all([
    canonicalCall(() => canonicalClient().pricing.offersRead({ query: { sku: skus } }, sessionContext())),
    inventory(skus),
  ]);
  return mapCanonicalProductPage(listings, offerValue, inventoryValue);
}

export const productionApi = {
  async login(input: LoginRequest): Promise<void> {
    await createStorefrontSession(input);
  },

  async getSession(): Promise<{ authenticated: true; actor: ApiActor; bootstrap: ApiBootstrap }> {
    const bootstrap = await sessionBootstrap();
    return { authenticated: true, actor: bootstrap.actor, bootstrap };
  },

  async logout(): Promise<{ authenticated: false }> {
    try {
      await canonicalCall(() => canonicalClient().identity.sessionDelete({}, sessionContext({ write: true, idempotencyKey: createSecureId(), includeScope: false })));
      return { authenticated: false };
    } finally {
      clearCanonicalSession();
    }
  },

  async getHomeSnapshot(preloadedBootstrap?: ApiBootstrap): Promise<ApiHomeSnapshot> {
    const bootstrap = preloadedBootstrap ?? await sessionBootstrap();
    const [accountItems, orderItems] = await Promise.all([accounts(), orders()]);
    const ledgerItems = await ledgers(accountItems);
    return { bootstrap, accounts: { items: accountItems }, orders: { items: orderItems }, accountLedgers: { items: ledgerItems } };
  },

  async listAccounts(): Promise<{ items: ApiAccount[] }> {
    return { items: await accounts() };
  },

  async listAccountLedgers(): Promise<{ items: ApiAccountLedger[] }> {
    const accountItems = await accounts();
    return { items: await ledgers(accountItems) };
  },

  async listPublicProducts(options: CatalogOptions = {}): Promise<{ items: ApiProduct[]; pagination: { nextCursor: string | null } }> {
    return listPublicProducts(options);
  },

  async listProducts(options: CatalogOptions = {}): Promise<{ items: ApiProduct[]; pagination: { nextCursor: string | null } }> {
    return qualifiedCatalog(options);
  },

  async getPublicStorefront(): Promise<{ id: string; name: string }> {
    return publicStorefront();
  },

  async listQualifiedProducts(options: CatalogOptions = {}) {
    return qualifiedCatalog(options);
  },

  async listOrders(): Promise<{ items: ApiOrder[] }> {
    return { items: await orders() };
  },

  async listCart(): Promise<{ items: ApiCartItem[] }> {
    const value = await canonicalCall(() => canonicalClient().cart.currentRead({}, sessionContext()));
    return { items: mapCanonicalCart(value).items };
  },

  async upsertCartItem(input: { listingId: string; quantity: number }): Promise<{ saved: true }> {
    await canonicalCall(() => canonicalClient().cart.itemsPut({ path: { listingid: input.listingId }, body: { quantity: input.quantity } }, sessionContext({
      write: true,
      idempotencyKey: createSecureId(),
    })));
    return { saved: true };
  },

  async deleteCartItem(listingId: string): Promise<{ removed: true }> {
    await productionApi.upsertCartItem({ listingId, quantity: 0 });
    return { removed: true };
  },

  async listAddresses(): Promise<{ items: ApiDeliveryAddress[] }> {
    const value = await canonicalCall(() => canonicalClient().member.addressesRead({ query: { limit: 100 } }, sessionContext()));
    return { items: mapCanonicalAddresses(value) };
  },

  async upsertAddress(input: ApiDeliveryAddress): Promise<{ id: string; isDefault: boolean; version: number }> {
    const id = input.id || `address:${createSecureId()}`;
    const body = { recipient: input.name, mobile: input.phone, address: input.detail, region: [input.province, input.city, input.district].filter(Boolean).join('/'), isDefault: input.isDefault, status: 'active' };
    const value = await canonicalCall(() => canonicalClient().member.addressesManage({ path: { addressid: id }, body }, sessionContext({
      write: true,
      idempotencyKey: createSecureId(),
      ...(input.version === undefined ? {} : { expectedVersion: input.version }),
    })));
    const result = record(value, 'member.address.manage');
    return {
      id: text(result.id, 'member.address.manage.id'),
      isDefault: boolean(result.is_default),
      version: nonNegativeInteger(result.version, 'member.address.manage.version'),
    };
  },

  async setDefaultAddress(addressId: string, expectedVersion?: number): Promise<{ id: string; isDefault: boolean; version: number }> {
    const value = await canonicalCall(() => canonicalClient().member.addressesManage({
      path: { addressid: addressId },
      body: { isDefault: true },
    }, sessionContext({
      write: true,
      idempotencyKey: createSecureId(),
      ...(expectedVersion === undefined ? {} : { expectedVersion }),
    })));
    const result = record(value, 'member.address.default');
    return {
      id: text(result.id, 'member.address.default.id'),
      isDefault: boolean(result.is_default),
      version: nonNegativeInteger(result.version, 'member.address.default.version'),
    };
  },

  async deleteAddress(addressId: string, expectedVersion?: number): Promise<{ removed: true }> {
    await canonicalCall(() => canonicalClient().member.addressesManage({ path: { addressid: addressId }, body: { status: 'deleted' } }, sessionContext({
      write: true,
      idempotencyKey: createSecureId(),
      ...(expectedVersion === undefined ? {} : { expectedVersion }),
    })));
    return { removed: true };
  },

  async startPaymentPhoneVerification(): Promise<{ challengeId: string; expiresAt: string }> {
    const value = record(await canonicalCall(() => canonicalClient().identity.stepupStart({ body: {} }, sessionContext({
      write: true,
      idempotencyKey: createSecureId(),
    }))), 'identity.stepup.start');
    return {
      challengeId: text(value.id, 'identity.stepup.start.id'),
      expiresAt: text(value.expires_at, 'identity.stepup.start.expires_at'),
    };
  },

  async changeMemberPassword(currentPassword: string, newPassword: string): Promise<void> {
    await canonicalCall(() => canonicalClient().identity.passwordVerify({ body: { password: currentPassword } }, sessionContext({ write: true, idempotencyKey: createSecureId() })));
    await canonicalCall(() => canonicalClient().identity.passwordChange({ body: { currentPassword, newPassword } }, sessionContext({ write: true, idempotencyKey: createSecureId() })));
  },

  async startMemberMobileBinding(mobile: string, password: string): Promise<string> {
    await canonicalCall(() => canonicalClient().identity.passwordVerify({ body: { password } }, sessionContext({ write: true, idempotencyKey: createSecureId() })));
    const challenge = record(await canonicalCall(() => canonicalClient().identity.mobileChallenge({ body: { destination: mobile } }, sessionContext({ write: true, idempotencyKey: createSecureId() }))), 'identity.mobile.challenge');
    return text(challenge.id, 'identity.mobile.challenge.id');
  },

  async completeMemberMobileBinding(mobile: string, challenge: string, code: string): Promise<void> {
    await canonicalCall(() => canonicalClient().identity.mobileManage({ body: { mobile, challenge, code } }, sessionContext({ write: true, idempotencyKey: createSecureId() })));
  },

  async completePaymentPhoneVerification(challengeId: string, code: string, bindingToken?: string): Promise<{ verified: true }> {
    await canonicalCall(() => canonicalClient().identity.stepupComplete({
      body: { challenge: challengeId, code, ...(bindingToken === undefined ? {} : { bindingToken }) },
    }, sessionContext({
      write: true,
      idempotencyKey: createSecureId(),
    })));
    return { verified: true };
  },

  checkout: checkoutWithCanonicalPayment,
  continuePayment: continueWithCanonicalPayment,
  readPaymentResult: readCanonicalPaymentResult,
};
