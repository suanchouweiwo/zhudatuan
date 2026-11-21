import { createHash, randomUUID } from 'node:crypto';
import type { OperationRequest, OperationResult } from '../../../../foundation/application/OperationHandler';
import type { OperationDatabase } from '../../../../foundation/application/ModuleOperations';
import { bodyRecord } from '../../../../foundation/interface/Validation';
import { domainEvent } from '../../../../foundation/domain/DomainEvent';
import { appendOutbox } from '../../../../foundation/infrastructure/OutboxStore';
import { CheckoutPort, type CheckoutQuote } from '../../../checkout_jiesuan';
import { checkoutSessionPort } from '../../../checkout_jiesuan';
import { InventoryPort } from '../../../inventory';
import { PaymentPort } from '../../../payment_zhifu';
import type { BenefitGateway } from '../../../benefit';
import { marketingPort } from '../../../marketing/MarketingPort';
import { cartPort } from '../../../cart/CartPort';
import type { OrderQuoteStore, StoredQuote } from '../../01_public_gongkai/contracts_qiyue/OrderContractModule';

export interface OrderVoucherGateway {
  reserve(database: OperationDatabase, order: string, member: string, scope: string,
    tenders: readonly Readonly<{ reference: string; amountMinor: number }>[]): Promise<void>;
}

interface OrderRouteContext {
  readonly transaction: string;
  readonly correlation: string;
  readonly operatingNode: string | null;
  readonly operatingLine: string | null;
  readonly operatingSignedLevel: string | null;
  readonly realm: string | null;
  readonly participantNode: string | null;
  readonly participantMembership: string;
  readonly participantMember: string;
  readonly mall: string;
}

interface SavedOrderLine {
  readonly id: string;
  readonly sku: string;
  readonly product: string;
  readonly supplier: string | null;
  readonly supplierRelationship: string | null;
  readonly contract: string | null;
  readonly route: string;
  readonly routeVersion: number;
  readonly payableMinor: number;
}

interface SupplyRouteRow {
  readonly offer_id: string;
  readonly sku_id: string;
  readonly supplier_id: string;
  readonly supplier_relationship_id: string;
  readonly supplier_relationship_version: number;
  readonly contract_id: string;
  readonly contract_version: number;
  readonly route_id: string;
  readonly route_version: number;
  readonly unit_cost_minor: number;
  readonly stockitem_id: string;
  readonly fulfillment_party_id: string;
  readonly settlement_party_id: string;
  readonly invoice_party_id: string;
  readonly effective_at: string;
  readonly steps: readonly Readonly<{ sequenceNo: number; lineId: string; signedLevel: string; nodeId: string | null;
    partyId: string; partyKind: string; edgeKind: string; effectiveAt: string }>[];
}

export class DirectOrderQuoteStore implements OrderQuoteStore {
  async load(database: OperationDatabase, quote: string, membership: string): Promise<StoredQuote> {
    const result = await database.query<StoredQuote>(`select session.id checkout,session.cart_id,session.member_id,session.mall_id,session.application_id,
      session.quote_id,session.quote_hash,session.input,session.version::float8 version,quote.signed_payload,quote.signature
      from checkout.session session join pricing.quote quote on quote.id=session.quote_id
      join access.membership membership on membership.member_id=session.member_id and membership.organization_id=session.mall_id
      join cart.cart cart on cart.id=session.cart_id and cart.member_id=session.member_id and cart.mall_id=session.mall_id
      where session.quote_id=$1 and membership.id=$2 and session.state='quoted' and cart.state='active'
        and session.expires_at>clock_timestamp() and quote.expires_at>clock_timestamp()
      for update of session,cart`, [quote, membership]);
    const row = result.rows[0];
    if (!row) throw new Error('QUOTE_EXPIRED_OR_CONFLICT');
    return row;
  }
}

export class PlaceOrder {
  constructor(
    private readonly checkout: CheckoutPort,
    private readonly benefit: BenefitGateway,
    private readonly voucher: OrderVoucherGateway,
    private readonly quotes: OrderQuoteStore = new DirectOrderQuoteStore(),
    private readonly inventory = new InventoryPort(),
    private readonly payment = new PaymentPort(),
  ) {}

  async execute(request: OperationRequest, database: OperationDatabase): Promise<OperationResult> {
    const access = request.access;
    if (!access) throw new Error('AUTHENTICATION_REQUIRED');
    if (access.assurance.level < 2) throw new Error('MOBILE_ASSURANCE_REQUIRED');
    const quoteid = text(bodyRecord(request).quote, 'quote');
    const stored = await this.quotes.load(database, quoteid, access.membership.id);
    if (!this.checkout.verify(stored.signed_payload, stored.signature) || stored.signature !== stored.quote_hash) throw new Error('QUOTE_SIGNATURE_INVALID');
    const selection = this.checkout.selection(stored.input);
    const current = await this.checkout.read(database, access.membership.id, selection);
    if (current.cart.id !== stored.cart_id || this.checkout.sign(current) !== stored.signature) throw new Error('PRICE_QUOTE_EXPIRED');
    if (current.rejections.length > 0) throw new Error(`CHECKOUT_REJECTED:${current.rejections.map(({ listing, reasons }) => `${listing}:${reasons.join(',')}`).join(';')}`);
    const order = `order:${randomUUID()}`;
    const transaction = `transaction:${randomUUID()}`;
    const participantNode = access.actor.nodeContext?.node_id ?? null;
    const operatingNode = access.actor.nodeContext?.host_node_id ?? participantNode;
    const routeContext: OrderRouteContext = Object.freeze({
      transaction,
      correlation: access.trace,
      operatingNode,
      operatingLine: access.actor.nodeContext?.line_id ?? null,
      operatingSignedLevel: access.actor.nodeContext?.signed_level ?? null,
      realm: access.actor.realm ?? null,
      participantNode,
      participantMembership: access.membership.id,
      participantMember: current.cart.member,
      mall: current.cart.mall,
    });
    await this.inventory.reserve(database, order, current.cart.mall, current.lines);
    await this.reserveVouchers(database, order, current);
    await this.reserveBenefits(database, order, current);
    await this.reserveMarketing(database, order, current);
    const number = await orderNumber(database);
    const snapshots = await this.snapshots(database, current);
    const saved = await database.query(`insert into ordering.orderrecord(id,order_number,scope_id,member_id,mall_id,checkout_id,currency,total_minor,
      payment_state,fulfillment_state,aftersale_state,lifecycle_state,evidence,address_snapshot,invoice_snapshot,delivery_snapshot,experience_version,
      transaction_id,correlation_id,operating_node_id,operating_line_id,participant_node_id,participant_membership_id,participant_realm_id,
      participant_account_id,participant_snapshot,
      created_at,updated_at,version) values($1,$2,$3,$4,$3,$5,$6,$7,'unpaid','unallocated','none','created',$8::jsonb,$9::jsonb,$10::jsonb,
      $11::jsonb,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb,clock_timestamp(),clock_timestamp(),0) returning *`, [order, number, current.cart.mall, current.cart.member, stored.checkout,
      current.currency, current.payableMinor, JSON.stringify({ quote: stored.quote_id, signature: stored.signature, dependencies: current.evidence,
        selection: current.selection, tenders: current.tenders }), JSON.stringify(snapshots.address), JSON.stringify(snapshots.invoice),
      JSON.stringify(current.selection.delivery), experienceVersion(current), transaction, access.trace, operatingNode,
      routeContext.operatingLine, participantNode, access.membership.id, access.actor.realm ?? null,
      access.actor.account ?? null, JSON.stringify({
        membershipId: access.membership.id,
        memberId: current.cart.member,
        realmId: access.actor.realm ?? null,
        accountId: access.actor.account ?? null,
        nodeId: participantNode,
        nodeProfile: access.actor.nodeContext?.node_profile ?? null,
        hostNodeId: access.actor.nodeContext?.host_node_id ?? null,
        organizationId: current.cart.mall,
        accessVersion: access.accessVersion,
      })]);
    const savedLines = await this.saveLines(database, order, current, routeContext);
    await this.saveSuborders(database, order, routeContext, current.currency);
    await this.saveSupplierFlowFacts(database, order, routeContext);
    const intent = await this.paymentPlan(database, request, order, number, current);
    await checkoutSessionPort.confirm(database, stored.checkout);
    if (selection.items === undefined) await cartPort.convert(database, stored.cart_id);
    else await cartPort.consumeCheckoutItems(database, order);
    await database.query(`insert into runtime.job(id,kind,owner,scope_id,payload,state,priority,available_at,created_at,updated_at)
      values($1,'orderexpiry','order',$2,jsonb_build_object('order',$3::text),'queued',10,clock_timestamp()+interval '30 minutes',clock_timestamp(),clock_timestamp())`,
    [`job:expiry:${order}`, current.cart.mall, order]);
    await this.events(database, request, stored, current, order, number, intent, transaction, savedLines);
    return { status: 201, body: { ...saved.rows[0], payment: { intent, personalMinor: current.personalMinor,
      action: 'payment.intents.create' } }, headers: { etag: '"0"' } };
  }

  private async reserveVouchers(database: OperationDatabase, order: string, quote: CheckoutQuote): Promise<void> {
    const tenders = quote.tenders.filter((item) => item.kind === 'voucher').sort(byReference);
    await this.voucher.reserve(database, order, quote.cart.member, quote.cart.mall,
      tenders.map(({ reference, amountMinor }) => ({ reference: reference!, amountMinor })));
  }

  private async reserveBenefits(database: OperationDatabase, order: string, quote: CheckoutQuote): Promise<void> {
    const tenders = quote.tenders.filter((item) => item.kind === 'benefit').sort(byReference);
    await this.benefit.reserve(database, order, quote.cart.member, quote.cart.mall,
      tenders.map(({ reference, amountMinor }) => ({ reference: reference!, amountMinor })));
  }

  private async reserveMarketing(database: OperationDatabase, order: string, quote: CheckoutQuote): Promise<void> {
    const values = Array.isArray(quote.evidence.marketing) ? quote.evidence.marketing as readonly Readonly<Record<string, unknown>>[] : [];
    for (const value of [...values].sort((left, right) => String(left.id).localeCompare(String(right.id)))) {
      const id = text(value.id, 'campaign');
      const amount = integer(value.discount, 'campaign.discount');
      await marketingPort.reserve(database, { campaign: id, member: quote.cart.member, order, scope: quote.cart.mall, amountMinor: amount });
    }
  }

  private async snapshots(database: OperationDatabase, quote: CheckoutQuote): Promise<Readonly<{ address: unknown; invoice: unknown }>> {
    const address = quote.selection.address === null ? null : (await database.query(`select id,recipient_ciphertext,mobile_ciphertext,address_ciphertext,
      recipient_masked,mobile_masked,address_masked,region_code,version from checkout.address where id=$1 and member_id=$2 and status='active'`,
    [quote.selection.address, quote.cart.member])).rows[0];
    const invoice = quote.selection.invoice === null ? null : (await database.query(`select id,title_ciphertext,title_key_version,taxid_ciphertext,
      taxid_key_version,address_ciphertext,address_key_version,version from invoice.profile where id=$1 and owner_id=$2 and status='active'`,
    [quote.selection.invoice, quote.cart.member])).rows[0];
    if (quote.selection.address !== null && !address) throw new Error('CHECKOUT_ADDRESS_INVALID');
    if (quote.selection.invoice !== null && !invoice) throw new Error('CHECKOUT_INVOICE_INVALID');
    return Object.freeze({ address: address ?? null, invoice: invoice ?? null });
  }

  private async saveLines(database: OperationDatabase, order: string, quote: CheckoutQuote, context: OrderRouteContext): Promise<readonly SavedOrderLine[]> {
    const accepted = quote.lines.filter(({ accepted }) => accepted);
    const supplyOfferIds = accepted.map(({ versions }) => versions.supplyOffer).filter((id): id is string => typeof id === 'string');
    const supplyRows = await database.query<SupplyRouteRow>(`select offer.id offer_id,offer.sku_id,offer.supplier_id,
      relationship.relationship_id supplier_relationship_id,relationship.relationship_version::float8 supplier_relationship_version,
      contract.contract_id,contract.contract_version::float8 contract_version,offer.route_id,offer.route_version::float8 route_version,
      offer.unit_cost_minor::float8 unit_cost_minor,offer.stockitem_id,contract.fulfillment_party_id,contract.settlement_party_id,contract.invoice_party_id,
      route.effective_at::text effective_at,coalesce(jsonb_agg(jsonb_build_object('sequenceNo',step.sequence_no,'lineId',step.line_id,
        'signedLevel',step.signed_level,'nodeId',step.node_id,'partyId',step.party_id,'partyKind',step.party_kind,
        'edgeKind',step.edge_kind,'effectiveAt',step.effective_at) order by step.sequence_no),'[]'::jsonb) steps
      from catalog.supplyoffer offer join partner.supplierrelationship relationship on relationship.id=offer.supplier_relationship_id
      join partner.suppliercontract contract on contract.id=offer.contract_id
      join partner.supplyroute route on route.route_id=offer.route_id and route.route_version=offer.route_version
      join partner.supplyroutestep step on step.route_id=route.route_id and step.route_version=route.route_version
      where offer.mall_id=$1 and offer.id=any($2::text[])
      group by offer.id,offer.sku_id,offer.supplier_id,relationship.relationship_id,relationship.relationship_version,contract.contract_id,
        contract.contract_version,offer.route_id,offer.route_version,offer.unit_cost_minor,offer.stockitem_id,contract.fulfillment_party_id,
        contract.settlement_party_id,contract.invoice_party_id,route.effective_at
      order by offer.id`, [context.mall, supplyOfferIds]);
    const supplies = new Map(supplyRows.rows.map((row) => [row.offer_id, row]));
    const lines = accepted.map((line) => {
      const quotedSupplyOffer = line.versions.supplyOffer;
      const supply = typeof quotedSupplyOffer === 'string' ? supplies.get(quotedSupplyOffer) : undefined;
      if (typeof quotedSupplyOffer === 'string' && !supply) throw new Error('QUOTE_SUPPLY_SNAPSHOT_MISSING');
      const route = supply?.route_id ?? routeId(context, line);
      const id = `line:${randomUUID()}`;
      const routeVersion = supply?.route_version ?? 1;
      const supplier = supply?.supplier_id ?? line.partner ?? context.mall;
      const supplierRelationship = supply?.supplier_relationship_id ?? line.supplierRelationship ?? `relationship:self:${context.mall}`;
      const supplierRelationshipVersion = supply?.supplier_relationship_version ?? 1;
      const contract = supply?.contract_id ?? line.contract ?? `contract:self:${context.mall}`;
      const contractVersion = supply?.contract_version ?? 1;
      const fulfillmentParty = supply?.fulfillment_party_id ?? line.fulfillmentParty ?? supplier;
      const settlementParty = supply?.settlement_party_id ?? line.settlementParty ?? supplier;
      const invoiceParty = supply?.invoice_party_id ?? line.invoiceParty ?? supplier;
      const stockitem = supply?.stockitem_id ?? line.stockitem;
      const effectiveAt = supply?.effective_at ?? new Date().toISOString();
      const steps = supply?.steps ?? routeSteps(context, supplier, effectiveAt);
      return Object.freeze({ ...line, id, route, routeVersion, supplier, supplierRelationship, supplierRelationshipVersion,
        contract, contractVersion, fulfillmentParty, settlementParty, invoiceParty, stockitem,
        costMinor: (supply?.unit_cost_minor ?? line.unitMinor)*line.quantity,
        routeSnapshot: {
        schemaVersion: 'sfl.order-line-route.v1',
        transactionId: context.transaction,
        correlationId: context.correlation,
        routeId: route,
        routeVersion,
        lineId: context.operatingLine ?? `line:${context.mall}`,
        operatingNodeId: context.operatingNode,
        operatingMallId: context.mall,
        participantNodeId: context.participantNode,
        participantMembershipId: context.participantMembership,
        participantMemberId: context.participantMember,
        supplierId: supplier,
        supplierRelationshipId: supplierRelationship,
        supplierRelationshipVersion,
        contractId: contract,
        contractVersion,
        contractHash: line.contractHash,
        fulfillmentPartyId: fulfillmentParty,
        settlementPartyId: settlementParty,
        invoicePartyId: invoiceParty,
        effectiveAt,
        steps,
      } });
    });
    await database.query(`insert into ordering.line(id,order_id,sku_id,listing_id,product_id,title_snapshot,quantity,unit_minor,total_minor,discount_minor,
      qualification_evidence_id,provider,partner_id,evidence,route_id,route_version,operating_node_id,operating_line_id,participant_node_id,
      participant_membership_id,supplier_id,supplier_relationship_id,contract_id,contract_hash,fulfillment_party_id,settlement_party_id,
      invoice_party_id,route_snapshot,stockitem_id,supplier_relationship_version,contract_version,cost_minor,shipping_minor,tax_minor)
      select line.id,$1,line.sku,line.listing,line.product,line.title,line.quantity,line."unitMinor",
      line."totalMinor",line."discountMinor",null,line.provider,line.partner,line.versions,line.route,line."routeVersion",line."operatingNode",
      line."operatingLine",line."participantNode",line."participantMembership",line.partner,line."supplierRelationship",line.contract,
      line."contractHash",line."fulfillmentParty",line."settlementParty",line."invoiceParty",line."routeSnapshot",line.stockitem,
      line."supplierRelationshipVersion",line."contractVersion",line."costMinor",0,0
      from jsonb_to_recordset($2::jsonb) as line(id text,sku text,listing text,product text,title text,quantity bigint,"unitMinor" bigint,
      "totalMinor" bigint,"discountMinor" bigint,provider text,partner text,versions jsonb,route text,"routeVersion" bigint,
      "operatingNode" text,"operatingLine" text,"participantNode" text,"participantMembership" text,"supplierRelationship" text,
      contract text,"contractHash" text,"fulfillmentParty" text,"settlementParty" text,"invoiceParty" text,"routeSnapshot" jsonb,
      stockitem text,"supplierRelationshipVersion" bigint,"contractVersion" bigint,"costMinor" bigint)`,
    [order, JSON.stringify(lines.map((line) => ({ ...line, operatingNode: context.operatingNode, operatingLine: context.operatingLine,
      participantNode: context.participantNode, participantMembership: context.participantMembership, partner: line.supplier,
      supplierRelationship: line.supplierRelationship, contract: line.contract })))]);
    const routeStepRows = lines.flatMap((line) => line.routeSnapshot.steps.map((step) => ({ ...step, orderLineId: line.id,
      routeId: line.route, routeVersion: line.routeVersion, mallId: context.mall, supplierId: line.supplier,
      supplierRelationshipId: line.supplierRelationship, supplierRelationshipVersion: line.supplierRelationshipVersion,
      contractId: line.contract, contractVersion: line.contractVersion, fulfillmentPartyId: line.fulfillmentParty,
      settlementPartyId: line.settlementParty, invoicePartyId: line.invoiceParty })));
    await database.query(`insert into ordering.lineroutestep(order_line_id,route_id,route_version,sequence_no,line_id,signed_level,node_id,
      party_id,party_kind,mall_id,supplier_id,supplier_relationship_id,supplier_relationship_version,contract_id,contract_version,
      edge_kind,fulfillment_party_id,settlement_party_id,invoice_party_id,effective_at)
      select step."orderLineId",step."routeId",step."routeVersion",step."sequenceNo",step."lineId",step."signedLevel",step."nodeId",
        step."partyId",step."partyKind",step."mallId",step."supplierId",step."supplierRelationshipId",step."supplierRelationshipVersion",
        step."contractId",step."contractVersion",step."edgeKind",step."fulfillmentPartyId",step."settlementPartyId",step."invoicePartyId",
        step."effectiveAt" from jsonb_to_recordset($1::jsonb) as step("orderLineId" text,"routeId" text,"routeVersion" bigint,
        "sequenceNo" integer,"lineId" text,"signedLevel" text,"nodeId" text,"partyId" text,"partyKind" text,"mallId" text,
        "supplierId" text,"supplierRelationshipId" text,"supplierRelationshipVersion" bigint,"contractId" text,"contractVersion" bigint,
        "edgeKind" text,"fulfillmentPartyId" text,"settlementPartyId" text,"invoicePartyId" text,"effectiveAt" timestamptz)`,
    [JSON.stringify(routeStepRows)]);
    return lines.map((line) => Object.freeze({ id: line.id, sku: line.sku, product: line.product, supplier: line.supplier,
      supplierRelationship: line.supplierRelationship, contract: line.contract, route: line.route, routeVersion: line.routeVersion,
      payableMinor: line.payableMinor }));
  }

  private async saveSuborders(database: OperationDatabase, order: string, context: OrderRouteContext, currency: string): Promise<void> {
    await database.query(`insert into ordering.suborder(id,order_id,partner_id,provider,state,version,route_id,route_version,supplier_id,
      supplier_relationship_id,contract_id,fulfillment_party_id,settlement_party_id,invoice_party_id,amount_minor,transaction_id,
      correlation_id,realm_id,line_id,operating_node_id,merchandise_minor,discount_minor,shipping_minor,tax_minor,cost_minor,currency)
      select 'suborder:'||md5(concat_ws('|',$1::text,line.supplier_id,line.supplier_relationship_id,line.contract_id,line.route_id,
        line.route_version::text,line.fulfillment_party_id,line.settlement_party_id,line.invoice_party_id)),$1,min(line.partner_id),
        min(line.provider),'pending',0,line.route_id,line.route_version,line.supplier_id,line.supplier_relationship_id,line.contract_id,
        line.fulfillment_party_id,line.settlement_party_id,line.invoice_party_id,sum(line.payable_minor),$2,$3,$4,$5,$6,
        sum(line.total_minor),sum(line.discount_minor),sum(line.shipping_minor),sum(line.tax_minor),sum(line.cost_minor),$7
      from ordering.line line where line.order_id=$1
      group by line.route_id,line.route_version,line.supplier_id,line.supplier_relationship_id,line.contract_id,line.fulfillment_party_id,
        line.settlement_party_id,line.invoice_party_id`, [order, context.transaction, context.correlation, context.realm,
      context.operatingLine ?? `line:${context.mall}`, context.operatingNode, currency]);
    await database.query(`update ordering.line line set supplier_leg_id=leg.id from ordering.suborder leg where line.order_id=$1
      and leg.order_id=line.order_id and leg.route_id=line.route_id and leg.route_version=line.route_version
      and leg.supplier_id is not distinct from line.supplier_id
      and leg.supplier_relationship_id is not distinct from line.supplier_relationship_id
      and leg.contract_id is not distinct from line.contract_id
      and leg.fulfillment_party_id is not distinct from line.fulfillment_party_id
      and leg.settlement_party_id is not distinct from line.settlement_party_id
      and leg.invoice_party_id is not distinct from line.invoice_party_id`, [order]);
  }

  private async saveSupplierFlowFacts(database: OperationDatabase, order: string, context: OrderRouteContext): Promise<void> {
    await database.query(`insert into inventory.supplierreservationfact(id,reservation_id,order_id,order_line_id,supplier_leg_id,stockitem_id,
      transaction_id,correlation_id,route_id,route_version,supplier_id,quantity,state,created_at)
      select 'supplier-reservation:'||line.id,reservation.id,line.order_id,line.id,line.supplier_leg_id,line.stockitem_id,$2,$3,line.route_id,
        line.route_version,line.supplier_id,line.quantity,'reserved',clock_timestamp()
      from ordering.line line join inventory.reservation reservation on reservation.mall_id=$4 and reservation.owner_type='order'
        and reservation.owner_id=line.order_id and reservation.stockitem_id=line.stockitem_id
      where line.order_id=$1 and line.supplier_id is not null and line.supplier_leg_id is not null`,
    [order, context.transaction, context.correlation, context.mall]);
    await database.query(`insert into fulfillment.supplierresponsibility(id,order_id,supplier_leg_id,transaction_id,correlation_id,route_id,
      route_version,supplier_id,fulfillment_party_id,settlement_party_id,invoice_party_id,state,created_at)
      select 'supplier-responsibility:'||leg.id,leg.order_id,leg.id,leg.transaction_id,leg.correlation_id,leg.route_id,leg.route_version,
        leg.supplier_id,leg.fulfillment_party_id,leg.settlement_party_id,leg.invoice_party_id,'pending',clock_timestamp()
      from ordering.suborder leg where leg.order_id=$1 and leg.supplier_id is not null`, [order]);
  }

  private async paymentPlan(database: OperationDatabase, request: OperationRequest, order: string, number: string, quote: CheckoutQuote): Promise<string> {
    return this.payment.plan(database, { mall: quote.cart.mall, order, orderNumber: number, member: quote.cart.member, currency: quote.currency,
      amountMinor: quote.payableMinor, idempotency: request.input.idempotency!, tenders: quote.tenders });
  }

  private async events(database: OperationDatabase, request: OperationRequest, stored: StoredQuote, quote: CheckoutQuote, order: string,
    number: string, intent: string, transaction: string, lines: readonly SavedOrderLine[]): Promise<void> {
    const access = request.access!;
    const scopes = await database.query<{ ids: readonly string[] }>('select jsonb_agg(ancestor_id order by depth) ids from organization.unitclosure where descendant_id=$1', [quote.cart.mall]);
    const timezone = await database.query<{ timezone: string }>('select timezone from organization.organization where id=$1', [quote.cart.mall]);
    const base = { tenant: quote.cart.mall, occurred: new Date().toISOString(), trace: access.trace } as const;
    await appendOutbox(database, domainEvent({ event: `event:${randomUUID()}`, type: 'checkout.quote.confirmed', version: 1,
      aggregate: { type: 'checkout', id: stored.checkout }, ...base, payload: { transaction, correlation: access.trace,
        checkout: stored.checkout, quote: stored.quote_id, order, intent } }));
    await appendOutbox(database, domainEvent({ event: `event:${randomUUID()}`, type: 'inventory.stock.reserved', version: 1,
      aggregate: { type: 'order', id: order }, ...base, payload: { transaction, correlation: access.trace, order,
        lines: quote.lines.map(({ sku, stockitem, quantity }) => ({ sku, stockitem, quantity })) } }));
    await appendOutbox(database, domainEvent({ event: `event:${randomUUID()}`, type: 'order.placed', version: 1,
      aggregate: { type: 'order', id: order }, ...base, payload: { transaction, correlation: access.trace, order, number,
        mall: quote.cart.mall, application: quote.cart.application, participantMembership: access.membership.id,
        scopes: scopes.rows[0]?.ids, timezone: timezone.rows[0]?.timezone, totalMinor: quote.payableMinor, currency: quote.currency,
        evidenceHash: this.checkout.digest(quote.evidence), tenders: quote.tenders,
        lines } }));
  }
}

function routeId(context: OrderRouteContext, line: CheckoutQuote['lines'][number]): string {
  const digest = createHash('sha256').update(JSON.stringify([context.operatingLine, context.operatingNode, context.participantNode,
    line.partner, line.supplierRelationship, line.contract, line.fulfillmentParty, line.settlementParty, line.invoiceParty])).digest('hex');
  return `route:${digest.slice(0, 32)}`;
}

function routeSteps(context: OrderRouteContext, supplier: string | null, effectiveAt: string): readonly Readonly<Record<string, unknown>>[] {
  const steps: Readonly<Record<string, unknown>>[] = [];
  const lineId = context.operatingLine ?? `line:${context.mall}`;
  if (supplier !== null) steps.push(Object.freeze({ sequenceNo: 1, lineId, partyKind: 'supplier', partyId: supplier, nodeId: null,
    signedLevel: 'L-1', edgeKind: 'supplier_contract', effectiveAt }));
  steps.push(Object.freeze({ sequenceNo: steps.length + 1, partyKind: 'operating_owner', partyId: context.mall,
    lineId, nodeId: context.operatingNode, signedLevel: context.operatingSignedLevel ?? 'L0', edgeKind: 'operates', effectiveAt }));
  steps.push(Object.freeze({ sequenceNo: steps.length + 1, partyKind: 'participant', partyId: context.participantMembership,
    lineId, nodeId: context.participantNode, signedLevel: context.operatingSignedLevel ?? 'L0', edgeKind: 'participates', effectiveAt }));
  return Object.freeze(steps);
}

function experienceVersion(quote: CheckoutQuote): string | null {
  const value = quote.evidence.experience;
  return value !== null && typeof value === 'object' && !Array.isArray(value) && typeof (value as Record<string, unknown>).version === 'string'
    ? (value as Record<string, string>).version ?? null : null;
}
function text(value: unknown, field: string): string { if (typeof value !== 'string' || value.length === 0 || value.length > 255) throw new Error(`VALIDATION_FAILED:${field}`); return value; }
function integer(value: unknown, field: string): number { if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`VALIDATION_FAILED:${field}`); return value as number; }
function byReference(left: Readonly<{ reference: string | null }>, right: Readonly<{ reference: string | null }>): number { return (left.reference ?? '').localeCompare(right.reference ?? ''); }
async function orderNumber(database: OperationDatabase): Promise<string> {
  const row = (await database.query<{ number: string }>(`select 'SW'||to_char(clock_timestamp(),'YYYYMMDD')||lpad(nextval('ordering.order_number_seq')::text,12,'0') number`)).rows[0];
  if (!row) throw new Error('ORDER_NUMBER_GENERATION_FAILED');
  return row.number;
}
