// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One sale, one legal invoice, whatever app sold it. Every `revenue-stream@1` provider of the
// organization delivers `sale:paid` to `onSaleEvent`; invoicing finds the bound stream, reads the
// sale from its source (`sale_get`, never the event), and runs it through `issueSale`, the single
// issuing flow every stream shares (handlers/shopify-order-paid.ts: numbering, tax checks,
// approvals, parks, PDF, mail).
//
// Keys: the shop's sales keep the order flow's own (`shopify-order:<id>:<scope>`, documents found
// by `shopify_order_id`), so the shop's documents are exactly what they were. A Stripe sale keys
// its invoice `stripe:<payment intent>:<scope>` and claims every name of the sale (`stripe_sales`:
// payment intent, charge, checkout session) with its first document, so the refund handler finds
// it by charge and no second document of the same payment can commit. Any other provider's sale:
// `rs:<app>:<external id>:<scope>`. A park or an approval of a stream sale carries only
// `{ stream_id, external_id }`: its retry reads the sale again from the source.

import {
  type ContractEnvelope,
  REVENUE_STREAM,
  type Sale,
  saleProblems,
} from "@liaison/app-sdk/contracts"
import { park, resolveOpenParks } from "../deferred"
import {
  issueOrderFlow,
  type OrderPaidCtx,
  type OrderPaidResult,
  onShopifyOrderPaid,
  type StreamSaleSource,
} from "../handlers/shopify-order-paid"
import { claimOps, saleDocument } from "../handlers/stripe-sale"
import { attachDocumentsToSale, recordSale } from "../sales-ledger"
import { orderPaidPayloadFromSale } from "./sale-payload"
import {
  ensureShopifyStream,
  type RevenueStream,
  SHOPIFY,
  streamById,
  streamForSale,
  streamsOf,
} from "./streams"

type Row = Record<string, unknown>

export interface SaleCtx extends OrderPaidCtx {
  contracts?: {
    call<T = unknown>(
      contract: string,
      op: string,
      params: Record<string, unknown>,
      opts?: { grant?: string | null; provider?: string | null },
    ): Promise<ContractEnvelope<T>>
  }
}

export const STREAM_SALE_KIND = "revenue_stream_sale"

export type SaleRead =
  | { ok: true; sale: Sale }
  | { ok: false; reason: "not_found" | "unreadable"; detail?: string }

/** The sale as its source answers now (`revenue-stream@1` `sale_get`, through the kernel). */
export async function readSale(
  ctx: SaleCtx,
  provider: string,
  externalId: string,
): Promise<SaleRead> {
  if (!ctx.contracts) return { ok: false, reason: "unreadable", detail: "contracts unavailable" }
  const env = await ctx.contracts.call<{ found?: boolean; sale?: unknown }>(
    REVENUE_STREAM,
    "sale_get",
    { external_id: externalId },
    { provider },
  )
  if (env.status !== "completed") {
    return { ok: false, reason: "unreadable", detail: `${env.error.code}: ${env.error.message}` }
  }
  if (!env.result?.found || !env.result.sale) return { ok: false, reason: "not_found" }
  return { ok: true, sale: env.result.sale as Sale }
}

const streamParkId = (stream: RevenueStream, externalId: string) => `rs:${stream.id}:${externalId}`

/** The names a Stripe sale is known by (payment intent, charge, checkout session). */
export function stripeSaleNames(sale: Sale): string[] {
  return [sale.external_id, sale.refs?.charge_id, sale.refs?.checkout_session_id].filter(
    (x): x is string => typeof x === "string" && x !== "",
  )
}

/** How the issuing flow treats a sale of a stream other than the shop. */
export function streamSource(stream: RevenueStream, sale: Sale): StreamSaleSource {
  const isStripe = stream.provider_app === "stripe"
  const prefix = isStripe ? "stripe" : `rs:${stream.provider_app}`
  const refOf = (scope: "goods" | "software") => `${prefix}:${sale.external_id}:${scope}`
  const names = isStripe ? stripeSaleNames(sale) : []
  const refs = sale.refs ?? {}
  return {
    stream: {
      id: stream.id,
      provider_app: stream.provider_app,
      issuer_profile_id: stream.issuer_profile_id ?? "",
      mode: stream.mode,
      mail: stream.mail,
      label: stream.label,
    },
    parkEventId: streamParkId(stream, sale.external_id),
    parkPayload: { kind: STREAM_SALE_KIND, stream_id: stream.id, external_id: sale.external_id },
    invoiceRef: refOf,
    documentRefs: {
      revenue_stream_id: stream.id,
      sale_provider: stream.provider_app,
      sale_external_id: sale.external_id,
      sold_at: sale.sold_at,
      ...(isStripe ? { stripe_payment_intent_id: sale.external_id } : {}),
      ...(refs.charge_id ? { stripe_charge_id: refs.charge_id } : {}),
      ...(refs.checkout_session_id ? { checkout_session_id: refs.checkout_session_id } : {}),
    },
    async existingDocuments(c) {
      const keyed = (await c.db.findMany("documents", {
        where: { external_ref: { in: [refOf("goods"), refOf("software")] } },
        limit: 10,
      })) as Row[]
      if (names.length === 0) return keyed
      const claimed = await saleDocument(c, names)
      return claimed && !keyed.some((d) => d.id === claimed.id) ? [...keyed, claimed] : keyed
    },
    ...(names.length > 0 ? { claimOps: () => claimOps(names, { $ref: "document" }) } : {}),
  }
}

/**
 * The sale's lines against its stated totals (when the source states them): net lines, their
 * tax and the total must agree within one minor unit per line (each line rounds on its own).
 * A gap means the lines do not say what the buyer paid: a person looks before anything issues.
 */
export function totalsMismatch(
  sale: Sale,
): { lines_minor: string; tax_minor: string; total_minor: string; stated: Sale["totals"] } | null {
  let net = 0n
  let tax = 0n
  for (const l of sale.lines) {
    const q = l.quantity.includes(".") ? null : BigInt(l.quantity)
    if (q === null) return null // a fractional quantity: the issuing flow's own rounding decides
    net += BigInt(l.unit_price_minor) * q - BigInt(l.discount_minor ?? "0")
    tax += BigInt(l.tax?.amount_minor ?? "0")
  }
  const tol = BigInt(Math.max(1, sale.lines.length))
  const far = (a: bigint, b: bigint) => (a > b ? a - b : b - a) > tol
  const t = sale.totals
  const off =
    (t.subtotal_minor != null && !sale.prices_include_tax && far(net, BigInt(t.subtotal_minor))) ||
    (t.tax_minor != null && far(tax, BigInt(t.tax_minor))) ||
    (!sale.prices_include_tax && t.tax_minor != null && far(net + tax, BigInt(t.total_minor)))
  return off
    ? {
        lines_minor: net.toString(),
        tax_minor: tax.toString(),
        total_minor: t.total_minor,
        stated: t,
      }
    : null
}

/** Resolve the buyer's kernel contact (resolve-or-create), as the order flow always did. */
async function withContact(
  ctx: SaleCtx,
  payload: ReturnType<typeof orderPaidPayloadFromSale>,
): Promise<void> {
  const c = payload.customer
  if (!c || c.contact_id || !(c.email || c.id)) return
  try {
    const resolved = (await ctx.resolveContact({
      email: c.email ?? undefined,
      name: c.legal_name ?? undefined,
      externalId: c.id ?? undefined,
    })) as { id?: string } | null
    c.contact_id = resolved?.id ?? null
  } catch {
    // Left null: the flow parks the sale awaiting its contact.
  }
}

/**
 * Issue the invoice(s) of one sale of one stream. The shop's sales go through the order flow
 * unchanged (issuer by shop mapping); every other stream's through the same flow with the stream's
 * issuer and the sale's own keys.
 */
export async function issueSale(
  stream: RevenueStream,
  sale: Sale,
  ctx: SaleCtx,
): Promise<OrderPaidResult> {
  const problems = saleProblems(sale)
  if (problems.length > 0) {
    const def = await park(
      { db: ctx.db },
      {
        event_id: streamParkId(stream, String(sale?.external_id ?? "")),
        event_payload_json: {
          kind: STREAM_SALE_KIND,
          stream_id: stream.id,
          external_id: String(sale?.external_id ?? ""),
        },
        status: "awaiting_data",
        reason: "sale_invalid",
        blocked_on: { kind: "sale_invalid", stream_id: stream.id, problems: problems.slice(0, 10) },
      },
    )
    return { status: "deferred", deferred_id: def.id, reason: "awaiting_data" }
  }
  const totalsGap = stream.provider_app === SHOPIFY ? null : totalsMismatch(sale)
  if (totalsGap) {
    const def = await park(
      { db: ctx.db },
      {
        event_id: streamParkId(stream, sale.external_id),
        event_payload_json: {
          kind: STREAM_SALE_KIND,
          stream_id: stream.id,
          external_id: sale.external_id,
        },
        status: "awaiting_data",
        reason: "sale_totals_mismatch",
        blocked_on: { kind: "sale_totals", stream_id: stream.id, ...totalsGap },
      },
    )
    return { status: "deferred", deferred_id: def.id, reason: "awaiting_data" }
  }
  if (stream.provider_app !== SHOPIFY && sale.paid.status === "cancelled") {
    await resolveOpenParks(
      { db: ctx.db, emit: ctx.emit },
      streamParkId(stream, sale.external_id),
      "sale_cancelled",
    )
    return { status: "skipped", reason: "order_cancelled" }
  }
  const payload = orderPaidPayloadFromSale(sale)
  await withContact(ctx, payload)
  if (stream.provider_app === SHOPIFY) return onShopifyOrderPaid(payload, ctx)
  const result = await issueOrderFlow(payload, ctx, streamSource(stream, sale))
  // The sale and who bought it, for the buyer's own reads (sales-ledger.ts): its invoices point
  // at it. The shop's sales are matched by the ledger's own fallback.
  if (result.status === "ok" && stream.issuer_profile_id) {
    const { sale_id } = await recordSale(ctx.db, {
      issuer_profile_id: stream.issuer_profile_id,
      stream: stream.provider_app,
      external_id: sale.external_id,
      source_ref: sale.refs?.checkout_session_id ?? sale.external_id,
      source_name: sale.refs?.order_name ?? null,
      sold_on: sale.sold_at.slice(0, 10),
      buyer: {
        email: sale.buyer.email,
        shopify_customer_id: sale.buyer.ids?.shopify_customer_id ?? null,
        hub_user_id: sale.buyer.ids?.hub_user_id ?? null,
      },
      total_minor: sale.totals.total_minor,
      currency: sale.currency,
      state: "issued",
    })
    await attachDocumentsToSale(
      ctx.db,
      sale_id,
      result.documents.map((d) => d.document_id),
    )
  }
  // A Stripe payment the stream invoiced no longer waits as an unmatched payment for a person.
  if (stream.provider_app === "stripe" && result.status === "ok" && sale.refs?.charge_id) {
    await resolveOpenParks(
      { db: ctx.db, emit: ctx.emit },
      `stripe:${sale.refs.charge_id}`,
      "invoiced_by_revenue_stream",
    )
  }
  return result
}

export type SaleEventResult =
  | OrderPaidResult
  | {
      status: "skipped"
      reason: "no_stream" | "stream_off" | "before_stream" | "sale_not_found" | "not_an_event"
    }
  | { status: "error"; reason: "sale_unreadable"; detail?: string }

/**
 * `contract:revenue-stream@1/sale:paid`: a provider says a sale was paid. Invoicing issues it only
 * when a stream binds the provider, the stream is not off, and the sale was paid since the stream
 * was bound (older ones go through the catch-up).
 */
export async function onSaleEvent(
  event: { app?: string; data?: { external_id?: unknown } },
  ctx: SaleCtx,
): Promise<SaleEventResult> {
  const provider = typeof event?.app === "string" ? event.app : ""
  const externalId =
    typeof event?.data?.external_id === "string" ? event.data.external_id.trim() : ""
  if (!provider || !externalId) return { status: "skipped", reason: "not_an_event" }
  if (provider === SHOPIFY) await ensureShopifyStream(ctx.db)
  const streams = await streamsOf(ctx.db, provider)
  if (streams.length === 0) return { status: "skipped", reason: "no_stream" }
  const read = await readSale(ctx, provider, externalId)
  if (!read.ok) {
    if (read.reason === "not_found") return { status: "skipped", reason: "sale_not_found" }
    // Thrown, so the bus retries the delivery: the source was not readable just now.
    throw new Error(`revenue stream ${provider}: sale ${externalId} unreadable (${read.detail})`)
  }
  const stream = streamForSale(streams, read.sale.refs?.account)
  if (!stream) return { status: "skipped", reason: "no_stream" }
  if (stream.mode === "off") return { status: "skipped", reason: "stream_off" }
  if (stream.issue_from && Date.parse(read.sale.sold_at) < Date.parse(stream.issue_from)) {
    return { status: "skipped", reason: "before_stream" }
  }
  return issueSale(stream, read.sale, ctx)
}

/**
 * A stream sale parked or awaiting approval, run again: the sale is read again from its source.
 * The approval of a stream sale re-enters here (`invoicing:revenue_stream_sale_issue`, a gated
 * tool, so its card is decided by a holder of its own scope) with `ctx.approval`.
 */
export async function rerunStreamSale(
  payload: { stream_id?: unknown; external_id?: unknown },
  ctx: SaleCtx,
): Promise<SaleEventResult> {
  const stream =
    typeof payload?.stream_id === "string" ? await streamById(ctx.db, payload.stream_id) : null
  const externalId = typeof payload?.external_id === "string" ? payload.external_id : ""
  if (!stream || !externalId) return { status: "skipped", reason: "no_stream" }
  if (stream.mode === "off") return { status: "skipped", reason: "stream_off" }
  const read = await readSale(ctx, stream.provider_app, externalId)
  if (!read.ok) {
    return read.reason === "not_found"
      ? { status: "skipped", reason: "sale_not_found" }
      : { status: "error", reason: "sale_unreadable", detail: read.detail }
  }
  return issueSale(stream, read.sale, ctx)
}

export const onSaleApproved = rerunStreamSale

/** True when a park is a stream sale's (its payload names the stream and the sale). */
export function isStreamSalePark(row: { event_payload_json?: unknown }): boolean {
  return (row.event_payload_json as { kind?: unknown } | null)?.kind === STREAM_SALE_KIND
}
