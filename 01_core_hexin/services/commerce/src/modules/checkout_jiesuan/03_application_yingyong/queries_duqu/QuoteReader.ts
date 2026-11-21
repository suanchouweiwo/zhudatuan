import { createHash } from 'node:crypto';
import type { OperationDatabase } from '../../../../foundation/application/ModuleOperations';
import type { CheckoutQuote, CheckoutSelection, QuoteLine } from '../../02_domain_yewu/models_moxing/CheckoutQuote';
import { CheckoutPolicy, type CampaignRule } from '../../02_domain_yewu/policies_guize/CheckoutPolicy';
import type { BenefitChoice, BenefitGateway } from '../../../benefit';
import type { QuoteCartContext, QuoteContextReader } from '../../01_public_gongkai/contracts_qiyue/CheckoutContractModule';

export interface QuoteVoucherChoice {
  readonly id: string;
  readonly remaining_minor: number;
  readonly version: number;
  readonly program: string;
}

export interface QuoteVoucherGateway {
  preview(database: OperationDatabase, vouchers: readonly string[], member: string, scope: string): Promise<readonly QuoteVoucherChoice[]>;
}

interface LineRow {
  readonly listing_id: string; readonly sku_id: string; readonly quantity: number; readonly cart_listing_version: string;
  readonly listing_title: string | null; readonly listing_version: number | null; readonly listing_status: string | null;
  readonly product_id: string | null; readonly product_type: string | null; readonly category_id: string | null;
  readonly product_version: number | null; readonly sku_version: number | null; readonly unit_minor: number | null;
  readonly price_version: string | null; readonly stockitem_id: string | null; readonly onhand: number | null;
  readonly safety: number | null; readonly reserved: number | null; readonly stock_version: number | null; readonly provider: string | null;
  readonly partner_id: string | null;
  readonly supplier_relationship_id: string | null; readonly contract_id: string | null; readonly contract_hash: string | null;
  readonly fulfillment_party_id: string | null; readonly settlement_party_id: string | null; readonly invoice_party_id: string | null;
  readonly supply_offer_id: string | null; readonly supplier_relationship_version: number | null; readonly contract_version: number | null;
  readonly supply_route_id: string | null; readonly supply_route_version: number | null; readonly supply_unit_cost_minor: number | null;
}
interface PolicyRow {
  readonly id: string; readonly version: number; readonly rule_hash: string; readonly rule: Record<string, unknown>;
  readonly resources: readonly Readonly<{ kind: string; id: string }>[]; readonly subjects: readonly Readonly<Record<string, unknown>>[];
  readonly period: string | null; readonly quantity: number | null; readonly amount_minor: number | null;
}
interface PurchaseRow { readonly listing_id: string; readonly day_quantity: number; readonly week_quantity: number; readonly month_quantity: number; readonly lifetime_quantity: number; readonly day_minor: number; readonly week_minor: number; readonly month_minor: number; readonly lifetime_minor: number }
interface PurchaseHistoryQuery { readonly mall_id: string; readonly member_id: string }
interface CampaignRow { readonly id: string; readonly version: number; readonly rule: Record<string, unknown>; readonly remaining_budget: number }
interface PriceRuleRow { readonly id: string; readonly version: number; readonly priority: number; readonly kind: string; readonly condition: unknown; readonly effect: unknown }

export class QuoteReader {
  constructor(
    private readonly benefit: BenefitGateway,
    private readonly voucher: QuoteVoucherGateway,
    private readonly policy = new CheckoutPolicy(),
    private readonly context: QuoteContextReader | null = null,
  ) {}

  async read(database: OperationDatabase, membership: string, selection: CheckoutSelection): Promise<CheckoutQuote> {
    const cart = this.context === null
      ? await this.cart(database, membership, selection)
      : await this.context.read(database, membership, selection);
    const [lines, policies, purchases, tags, campaigns, priceRules, vouchers, benefits] = await Promise.all([
      this.lines(database, cart, selection.items), this.policies(database, cart.mall_id),
      this.purchases(database, { mall_id: cart.mall_id, member_id: cart.member_id }), this.tags(database, cart.member_id),
      this.campaigns(database, cart.mall_id), this.priceRules(database, cart.mall_id), this.vouchers(database, cart, selection), this.benefits(database, cart, selection),
    ]);
    if (lines.length === 0) throw new Error('CART_EMPTY');
    const evaluated = lines.map((line) => this.line(line, cart, policies, purchases, tags));
    const subtotal = evaluated.filter(({ accepted }) => accepted).reduce((sum, line) => sum + line.totalMinor, 0);
    const promotion = this.policy.promotionDiscount(subtotal, campaigns.map(campaignRule));
    const priced = allocateLineDiscount(evaluated, promotion.amount, subtotal);
    const payable = subtotal - promotion.amount;
    const allocation = this.policy.allocateTenders(payable,
      vouchers.map(({ id, remaining_minor }) => ({ id, amount: remaining_minor })),
      benefits.map(({ id, available_minor }) => ({ id, amount: selection.benefits.find(({ account }) => account === id)!.amountMinor })));
    const evidence = Object.freeze({
      cart: { version: cart.version }, profile: { version: cart.profile_version, city: cart.city_code },
      address: selection.address === null ? null : { id: selection.address, version: cart.address_version, region: cart.address_region },
      invoice: selection.invoice === null ? null : { id: selection.invoice, version: cart.invoice_version },
      experience: { version: cart.experience_version, hash: cart.experience_hash },
      qualification: policies.map(({ id, version, rule_hash }) => ({ id, version, hash: rule_hash })),
      pricing: priceRules, marketing: promotion.evidence,
      vouchers: vouchers.map(({ id, version, program, remaining_minor }) => ({ id, version, program, remainingMinor: remaining_minor })),
      benefits: benefits.map(({ id, version, kind, available_minor }) => ({ id, version, kind, availableMinor: available_minor })),
    });
    return Object.freeze({ cart: Object.freeze({ id: cart.id, member: cart.member_id, mall: cart.mall_id, application: cart.application_id, version: cart.version }),
      selection, lines: priced, subtotalMinor: subtotal, discountMinor: promotion.amount, payableMinor: payable,
      personalMinor: allocation.personal, currency: 'CNY', tenders: Object.freeze(allocation.tenders.map(({ kind, reference, amount }) => ({ kind, reference, amountMinor: amount }))),
      evidence, rejections: Object.freeze(priced.filter(({ accepted }) => !accepted).map(({ listing, reasons }) => Object.freeze({ listing, reasons }))) });
  }

  private async cart(database: OperationDatabase, membership: string, selection: CheckoutSelection): Promise<QuoteCartContext> {
    const result = await database.query<QuoteCartContext>(`select cart.id,cart.member_id,cart.mall_id,cart.application_id,cart.version::float8 version,
      profile.status profile_status,qualification.version::float8 profile_version,qualification.city_code,
      address.version::float8 address_version,address.region_code address_region,invoice.version::float8 invoice_version,
      publication.version_id experience_version,publication.content_hash experience_hash
      from access.membership membership join member.profile profile on profile.id=membership.member_id
      join cart.cart cart on cart.member_id=profile.id and cart.mall_id=membership.organization_id and cart.state='active'
      left join qualification.profile qualification on qualification.member_id=profile.id and qualification.scope_id=cart.mall_id
      left join checkout.address address on address.id=$2 and address.member_id=profile.id and address.status='active'
      left join invoice.profile invoice on invoice.id=$3 and invoice.owner_id=profile.id and invoice.status='active'
      left join experience.publication publication on publication.application_id=cart.application_id and publication.state='active'
      where membership.id=$1`, [membership, selection.address, selection.invoice]);
    const row = result.rows[0];
    if (!row) throw new Error('CART_EMPTY');
    if (selection.address !== null && row.address_version === null) throw new Error('CHECKOUT_ADDRESS_INVALID');
    if (selection.invoice !== null && row.invoice_version === null) throw new Error('CHECKOUT_INVOICE_INVALID');
    return row;
  }

  private async lines(database: OperationDatabase, cart: QuoteCartContext, items: CheckoutSelection['items']): Promise<readonly LineRow[]> {
    const result = await database.query<LineRow>(`select item.listing_id,item.sku_id,item.quantity::float8 quantity,item.listing_version cart_listing_version,
      listing.title listing_title,listing.version::float8 listing_version,listing.status listing_status,product.id product_id,product.product_type,
      product.category_id,product.version::float8 product_version,sku.version::float8 sku_version,price.amount_minor::float8 unit_minor,
      price.effective_at::text price_version,stock.id stockitem_id,stock.onhand::float8 onhand,stock.safety::float8 safety,
      stock.reserved::float8 reserved,stock.version::float8 stock_version,source.provider,
      coalesce(supply.supplier_id,product.owner_partner_id) partner_id,
      coalesce(supply.relationship_id,agreement.id) supplier_relationship_id,
      coalesce(supply.contract_id,agreement.contract_ref) contract_id,agreement.contract_hash,
      coalesce(supply.fulfillment_party_id,case when agreement.capabilities ? 'fulfillment' then product.owner_partner_id end) fulfillment_party_id,
      coalesce(supply.settlement_party_id,case when agreement.capabilities ? 'settlement' then product.owner_partner_id end) settlement_party_id,
      coalesce(supply.invoice_party_id,case when agreement.capabilities ? 'invoice' then product.owner_partner_id end) invoice_party_id,
      supply.supply_offer_id,supply.relationship_version::float8 supplier_relationship_version,
      supply.contract_version::float8 contract_version,supply.route_id supply_route_id,
      supply.route_version::float8 supply_route_version,supply.unit_cost_minor::float8 supply_unit_cost_minor
      from cart.item item left join catalog.listing listing on listing.id=item.listing_id and listing.scope_id=$2
        and listing.status='published' and (listing.effective_at is null or listing.effective_at<=clock_timestamp())
        and (listing.expires_at is null or listing.expires_at>clock_timestamp())
      left join catalog.sku sku on sku.id=item.sku_id and sku.id=listing.sku_id and sku.status='active'
      left join catalog.product product on product.id=sku.product_id and product.status='active'
      left join lateral(select price.amount_minor,price.effective_at from pricing.pricebook book join pricing.price price on price.book_id=book.id
        where book.scope_id=$2 and book.status='active' and price.sku_id=item.sku_id and price.effective_at<=clock_timestamp()
          and (price.expires_at is null or price.expires_at>clock_timestamp()) order by price.effective_at desc,book.id limit 1) price on true
      left join lateral(select offer.id supply_offer_id,offer.supplier_id,relationship.relationship_id,
        relationship.relationship_version,contract.contract_id,contract.contract_version,offer.route_id,offer.route_version,
        offer.stockitem_id,offer.unit_cost_minor,contract.fulfillment_party_id,contract.settlement_party_id,contract.invoice_party_id
        from catalog.supplyoffer offer join partner.supplierrelationship relationship on relationship.id=offer.supplier_relationship_id
        join partner.suppliercontract contract on contract.id=offer.contract_id
        join partner.supplyroute route on route.route_id=offer.route_id and route.route_version=offer.route_version
        where offer.mall_id=$2 and offer.sku_id=item.sku_id and offer.status='active'
          and offer.effective_at<=clock_timestamp() and (offer.superseded_at is null or offer.superseded_at>clock_timestamp())
          and relationship.status='active' and relationship.effective_at<=clock_timestamp()
          and (relationship.superseded_at is null or relationship.superseded_at>clock_timestamp())
          and contract.status='active' and contract.effective_at<=clock_timestamp()
          and (contract.superseded_at is null or contract.superseded_at>clock_timestamp())
          and route.status='active' and route.effective_at<=clock_timestamp()
          and (route.superseded_at is null or route.superseded_at>clock_timestamp())
        order by (offer.supplier_id=product.owner_partner_id) desc,offer.effective_at desc,offer.id limit 1) supply on true
      left join lateral(select candidate.id,candidate.onhand,candidate.safety,candidate.version,coalesce(sum(reservation.quantity)
        filter(where reservation.state='active' and reservation.expires_at>clock_timestamp()),0) reserved
        from inventory.stockitem candidate left join inventory.reservation reservation on reservation.stockitem_id=candidate.id
        where candidate.scope_id=$2 and candidate.sku_id=item.sku_id and candidate.status='active'
          and (supply.stockitem_id is null or candidate.id=supply.stockitem_id) group by candidate.id
        order by candidate.onhand-candidate.safety-coalesce(sum(reservation.quantity) filter(where reservation.state='active'
          and reservation.expires_at>clock_timestamp()),0) desc,candidate.id limit 1) stock on true
      left join lateral(select provider from catalog.sourcelisting where sku_id=item.sku_id and scope_id=$2 and status='mapped'
        order by observed_at desc,id limit 1) source on true
      left join lateral(select agreement.id,agreement.contract_ref,agreement.contract_hash,agreement.capabilities
        from partner.agreement agreement where agreement.partner_id=product.owner_partner_id and agreement.mall_id=$2 and agreement.status='active'
          and agreement.effective_at<=clock_timestamp() and (agreement.expires_at is null or agreement.expires_at>clock_timestamp())
        order by agreement.effective_at desc,agreement.id limit 1) agreement on true
      where item.cart_id=$1 and ($3::text[] is null or item.listing_id=any($3::text[]))
      order by item.sku_id,item.listing_id`, [cart.id, cart.mall_id, items?.map(({ listingId }) => listingId) ?? null]);
    if (items !== undefined) {
      const quantities = new Map(result.rows.map(({ listing_id, quantity }) => [listing_id, quantity]));
      if (items.some(({ listingId, quantity }) => quantities.get(listingId) !== quantity)) throw new Error('CHECKOUT_VERSION_CONFLICT:cart');
    }
    return result.rows;
  }

  private line(source: LineRow, cart: QuoteCartContext, policies: readonly PolicyRow[], purchases: ReadonlyMap<string, PurchaseRow>, tags: ReadonlySet<string>): QuoteLine {
    const reasons: string[] = [];
    if (!source.listing_id || source.listing_status !== 'published' || source.product_id === null) reasons.push('LISTING_NOT_PURCHASABLE');
    if (source.listing_version === null || source.cart_listing_version !== String(source.listing_version)) reasons.push('LISTING_VERSION_CHANGED');
    if (source.unit_minor === null) reasons.push('PRICE_UNAVAILABLE');
    if (source.stockitem_id === null) reasons.push('INVENTORY_UNAVAILABLE');
    else if ((source.onhand ?? 0) - (source.safety ?? 0) - (source.reserved ?? 0) < source.quantity) reasons.push('INVENTORY_INSUFFICIENT');
    if (cart.profile_status !== 'active' || cart.profile_version === null) reasons.push('QUALIFICATION_PROFILE_INACTIVE');
    if (cart.experience_version === null) reasons.push('EXPERIENCE_NOT_PUBLISHED');
    if (source.product_type === 'physical' && cart.address_version === null) reasons.push('ADDRESS_REQUIRED');
    for (const policy of policies) if (applies(policy, source) && !eligible(policy, source, cart, purchases.get(source.listing_id), tags)) reasons.push(`QUALIFICATION_DENIED:${policy.id}`);
    const unit = source.unit_minor ?? 0;
    return Object.freeze({ listing: source.listing_id, sku: source.sku_id, product: source.product_id ?? '', productType: source.product_type ?? 'unknown',
      category: source.category_id ?? '', title: source.listing_title ?? source.listing_id, quantity: source.quantity, unitMinor: unit,
      totalMinor: unit * source.quantity, discountMinor: 0, payableMinor: unit * source.quantity, provider: source.provider,
      partner: source.partner_id, supplierRelationship: source.supplier_relationship_id, contract: source.contract_id,
      contractHash: source.contract_hash, fulfillmentParty: source.fulfillment_party_id, settlementParty: source.settlement_party_id,
      invoiceParty: source.invoice_party_id, stockitem: source.stockitem_id,
      versions: Object.freeze({ listing: source.listing_version ?? -1, product: source.product_version ?? -1, sku: source.sku_version ?? -1,
        price: source.price_version ?? '', stock: source.stock_version ?? -1,
        ...(source.supply_offer_id == null ? {} : { supplyOffer: source.supply_offer_id,
          supplierRelationship: source.supplier_relationship_version ?? -1, contract: source.contract_version ?? -1,
          route: source.supply_route_id ?? '', routeVersion: source.supply_route_version ?? -1,
          unitCostMinor: source.supply_unit_cost_minor ?? -1 }) }), accepted: reasons.length === 0, reasons: Object.freeze(reasons) });
  }

  private async policies(database: OperationDatabase, scope: string): Promise<readonly PolicyRow[]> {
    return (await database.query<PolicyRow>(`select policy.id,policy.active_version version,version.rule_hash,version.rule,
      coalesce((select jsonb_agg(jsonb_build_object('kind',resource.kind,'id',resource.resource_id) order by resource.kind,resource.resource_id)
        from qualification.resource resource where resource.policy_id=policy.id and resource.policy_version=policy.active_version),'[]') resources,
      coalesce((select jsonb_agg(subject.selector order by subject.kind,subject.selector::text) from qualification.subject subject
        where subject.policy_id=policy.id and subject.policy_version=policy.active_version),'[]') subjects,
      limits.period,limits.quantity::float8 quantity,limits.amount_minor::float8 amount_minor from qualification.policy policy
      join qualification.policyversion version on version.policy_id=policy.id and version.version=policy.active_version
      left join lateral(select period,quantity,amount_minor from qualification.purchaselimit where policy_id=policy.id
        and policy_version=policy.active_version order by period limit 1) limits on true
      where policy.scope_id=$1 and policy.status='published' order by policy.id`, [scope])).rows;
  }

  private async purchases(database: OperationDatabase, query: PurchaseHistoryQuery): Promise<ReadonlyMap<string, PurchaseRow>> {
    const rows = (await database.query<PurchaseRow>(`select line.listing_id,
      coalesce(sum(line.quantity) filter(where orders.created_at>=date_trunc('day',clock_timestamp())),0)::float8 day_quantity,
      coalesce(sum(line.quantity) filter(where orders.created_at>=date_trunc('week',clock_timestamp())),0)::float8 week_quantity,
      coalesce(sum(line.quantity) filter(where orders.created_at>=date_trunc('month',clock_timestamp())),0)::float8 month_quantity,
      coalesce(sum(line.quantity),0)::float8 lifetime_quantity,
      coalesce(sum(line.payable_minor) filter(where orders.created_at>=date_trunc('day',clock_timestamp())),0)::float8 day_minor,
      coalesce(sum(line.payable_minor) filter(where orders.created_at>=date_trunc('week',clock_timestamp())),0)::float8 week_minor,
      coalesce(sum(line.payable_minor) filter(where orders.created_at>=date_trunc('month',clock_timestamp())),0)::float8 month_minor,
      coalesce(sum(line.payable_minor),0)::float8 lifetime_minor from ordering.orderrecord orders join ordering.line line on line.order_id=orders.id
      where orders.mall_id=$1 and orders.member_id=$2 and orders.lifecycle_state not in('cancelled','closed') group by line.listing_id`,
    [query.mall_id, query.member_id])).rows;
    return new Map(rows.map((row) => [row.listing_id, row]));
  }

  private async tags(database: OperationDatabase, member: string): Promise<ReadonlySet<string>> {
    return new Set((await database.query<{ code: string }>(`select code from qualification.tag where member_id=$1
      and (effective_at is null or effective_at<=clock_timestamp()) and (expires_at is null or expires_at>clock_timestamp()) order by code`, [member])).rows.map(({ code }) => code));
  }

  private async campaigns(database: OperationDatabase, scope: string): Promise<readonly CampaignRow[]> {
    return (await database.query<CampaignRow>(`select id,version::float8 version,rule,(budget_minor-spent_minor)::float8 remaining_budget
      from marketing.campaign where scope_id=$1 and state='active' and effective_at<=clock_timestamp()
      and (expires_at is null or expires_at>clock_timestamp()) and budget_minor>spent_minor order by id`, [scope])).rows;
  }

  private async priceRules(database: OperationDatabase, scope: string): Promise<readonly PriceRuleRow[]> {
    return (await database.query<PriceRuleRow>(`select id,version,priority,kind,condition,effect from pricing.rule where scope_id=$1 and status='published'
      and (effective_at is null or effective_at<=clock_timestamp()) order by priority,id`, [scope])).rows;
  }

  private async vouchers(database: OperationDatabase, cart: QuoteCartContext, selection: CheckoutSelection): Promise<readonly QuoteVoucherChoice[]> {
    if (selection.vouchers.length === 0) return [];
    const rows = await this.voucher.preview(database, selection.vouchers, cart.member_id, cart.mall_id);
    if (rows.length !== selection.vouchers.length) throw new Error('VOUCHER_NOT_USABLE');
    return rows;
  }

  private async benefits(database: OperationDatabase, cart: QuoteCartContext, selection: CheckoutSelection): Promise<readonly BenefitChoice[]> {
    if (selection.benefits.length === 0) return [];
    const ids = selection.benefits.map(({ account }) => account);
    const rows = await this.benefit.preview(database, cart.member_id, cart.mall_id, ids);
    if (rows.length !== ids.length || rows.some((row) => row.available_minor < selection.benefits.find(({ account }) => account === row.id)!.amountMinor)) throw new Error('BENEFIT_BALANCE_INSUFFICIENT');
    return rows;
  }
}

function campaignRule(row: CampaignRow): CampaignRule {
  const rule = row.rule;
  return { id: row.id, version: row.version, fixedMinor: integer(rule.fixedMinor, 0, 0), basisPoints: integer(rule.basisPoints, 0, 10_000),
    minimumSubtotal: integer(rule.minimumSubtotal, 0, 0), maximumMinor: rule.maximumMinor === undefined ? null : integer(rule.maximumMinor, 0, 0),
    remainingBudget: row.remaining_budget, stackable: rule.stackable === true, group: typeof rule.exclusiveGroup === 'string' ? rule.exclusiveGroup : row.id };
}

function applies(policy: PolicyRow, line: LineRow): boolean {
  return policy.resources.length === 0 || policy.resources.some((resource) => resource.id === line.listing_id || resource.id === line.sku_id || resource.id === line.product_id);
}

function eligible(policy: PolicyRow, line: LineRow, cart: QuoteCartContext, purchase: PurchaseRow | undefined, tags: ReadonlySet<string>): boolean {
  const rule = policy.rule;
  if (rule.effect === 'deny' || rule.allowed === false) return false;
  const cities = strings(rule.cityCodes);
  if (cities.length > 0 && !cities.includes(cart.address_region ?? cart.city_code ?? '')) return false;
  const required = [...strings(rule.requiredTags), ...policy.subjects.flatMap((subject) => typeof subject.tag === 'string' ? [subject.tag] : [])];
  if (required.some((tag) => !tags.has(tag)) || strings(rule.excludedTags).some((tag) => tags.has(tag))) return false;
  if (policy.period === null) return true;
  const priorQuantity = period(purchase, policy.period, 'quantity');
  const priorMinor = period(purchase, policy.period, 'minor');
  return (policy.quantity === null || priorQuantity + line.quantity <= policy.quantity)
    && (policy.amount_minor === null || priorMinor + (line.unit_minor ?? 0) * line.quantity <= policy.amount_minor);
}

function period(row: PurchaseRow | undefined, value: string, kind: 'quantity' | 'minor'): number {
  if (!row || value === 'order') return 0;
  const key = `${value}_${kind}` as keyof PurchaseRow;
  const result = row[key];
  return typeof result === 'number' ? result : 0;
}

function strings(value: unknown): readonly string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []; }
function integer(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || maximum > 0 && (value as number) > maximum) throw new Error('MARKETING_RULE_INVALID');
  return value as number;
}

export function quoteDigest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

function allocateLineDiscount(lines: readonly QuoteLine[], discount: number, subtotal: number): readonly QuoteLine[] {
  if (discount === 0) return Object.freeze(lines.map((line) => Object.freeze({ ...line })));
  if (subtotal <= 0 || discount < 0 || discount > subtotal) throw new Error('CHECKOUT_DISCOUNT_INVALID');
  const allocations = lines.map((line, index) => {
    if (!line.accepted) return { index, amount: 0, remainder: 0 };
    const numerator = line.totalMinor * discount;
    return { index, amount: Math.floor(numerator / subtotal), remainder: numerator % subtotal };
  });
  let remaining = discount - allocations.reduce((sum, allocation) => sum + allocation.amount, 0);
  const priority = allocations.filter(({ index }) => lines[index]!.accepted)
    .sort((left, right) => right.remainder - left.remainder
      || lines[left.index]!.sku.localeCompare(lines[right.index]!.sku)
      || lines[left.index]!.listing.localeCompare(lines[right.index]!.listing));
  if (remaining > priority.length) throw new Error('CHECKOUT_DISCOUNT_ALLOCATION_FAILED');
  for (let index = 0; index < remaining; index += 1) priority[index]!.amount += 1;
  const result = lines.map((line, index) => {
    const lineDiscount = allocations[index]!.amount;
    return Object.freeze({ ...line, discountMinor: lineDiscount, payableMinor: line.totalMinor - lineDiscount });
  });
  remaining = result.reduce((sum, line) => sum + line.discountMinor, 0);
  if (remaining !== discount || result.reduce((sum, line) => sum + (line.accepted ? line.payableMinor : 0), 0) !== subtotal - discount) {
    throw new Error('CHECKOUT_DISCOUNT_ALLOCATION_FAILED');
  }
  return Object.freeze(result);
}
