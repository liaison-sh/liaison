// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The catch-up of a revenue stream: the sales a provider took before the stream was bound (or
// that no event brought), invoiced in sale-date order. Two tools:
//
//   sales_catch_up_preview  read only: every sale paid in the window (`sales_list` from
//     the provider, each one as `sale_get` would answer), with its buyer, country, tax treatment,
//     lines, tax as computed against the tax the source reported, totals, refunds, blockers, and
//     the document it already has. Nothing is written.
//   sales_catch_up          gated, never auto-approved: a person approves the run. It
//     sorts the window's sales by sale date (oldest first), issues each one through `issueSale`
//     (one number each, today's issue date, the sale date on the document's references), then a
//     credit note for each refund of it, and STOPS at the first sale it cannot issue (parked,
//     refused, unreadable): the later sales stay unissued, so numbers keep sale-date order. The
//     run can be approved again once the cause is fixed: sales already invoiced are skipped.
//
// The run is the person's decision for each sale it issues (the approval re-enters with
// `ctx.approval`), so a review stream asks nothing more and `issue_from` does not apply.

import {
  type ContractEnvelope,
  REVENUE_STREAM,
  type Sale,
  saleProblems,
} from "@liaison/app-sdk/contracts"
import { cachedRate, type FxFetchCtx, fetchEcbRate } from "../einvoicing/fx"
import { findIssuerById, streamRateMismatches } from "../handlers/shopify-order-paid"
import { counterpartyCompletenessError } from "../issue"
import { lineSubtotal, lineTax } from "../money"
import type { MutationsCtx } from "../mutations/shared"
import { classify, isUntaxedIntraEuSaleWithoutVat } from "../tax"
import { issueSale, type SaleCtx, streamSource, totalsMismatch } from "./issue-sale"
import { creditSaleRefund } from "./refunds"
import { orderPaidPayloadFromSale } from "./sale-payload"
import { previewSale, type SalePreview } from "./sale-preview"
import { type RevenueStream, SHOPIFY, streamById } from "./streams"

type Row = Record<string, unknown>

export type CatchUpCtx = SaleCtx & MutationsCtx

const MAX_PAGES = 50
const MAX_SALES = 500

const fail = (code: string, message: string) => ({
  status: "error" as const,
  error: { code, message },
})

export interface CatchUpInput {
  streamId?: string
  paidFrom?: string
  paidTo?: string
}

async function salesOf(
  ctx: SaleCtx,
  stream: RevenueStream,
  from: string,
  to: string,
): Promise<{ ok: true; sales: Sale[] } | { ok: false; code: string; message: string }> {
  if (!ctx.contracts) return { ok: false, code: "contracts_unavailable", message: "no contracts" }
  const out: Sale[] = []
  let cursor: string | null = null
  for (let page = 0; page < MAX_PAGES; page++) {
    const env: ContractEnvelope<{ sales?: unknown[]; next?: string | null }> =
      await ctx.contracts.call<{ sales?: unknown[]; next?: string | null }>(
        REVENUE_STREAM,
        "sales_list",
        { paid_from: from, paid_to: to, cursor },
        { provider: stream.provider_app },
      )
    if (env.status !== "completed")
      return { ok: false, code: env.error.code, message: env.error.message }
    for (const s of env.result?.sales ?? []) out.push(s as Sale)
    cursor = env.result?.next ?? null
    if (!cursor || out.length >= MAX_SALES) break
  }
  const from_ = Date.parse(from)
  const to_ = Date.parse(to)
  const inWindow = out.filter((s) => {
    const at = Date.parse(String(s?.sold_at ?? ""))
    return !Number.isNaN(at) && at >= from_ && at < to_
  })
  // Oldest first; equal instants by id, so two runs order alike.
  inWindow.sort(
    (a, b) =>
      Date.parse(a.sold_at) - Date.parse(b.sold_at) || a.external_id.localeCompare(b.external_id),
  )
  return { ok: true, sales: inWindow }
}

function windowOf(input: CatchUpInput): { from: string; to: string } | null {
  const from = Date.parse(String(input.paidFrom ?? ""))
  const to = Date.parse(String(input.paidTo ?? ""))
  if (Number.isNaN(from) || Number.isNaN(to) || from >= to) return null
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() }
}

async function streamOf(ctx: SaleCtx, input: CatchUpInput) {
  if (!input.streamId) return null
  return streamById(ctx.db, input.streamId)
}

/** What one sale would become, read only. */
type FxPreview = { currency: string; rate: string | null; rate_date: string | null }

/** The ECB rate an issue today would use (the cache, else the ECB), read only: nothing cached. */
async function fxPreview(ctx: SaleCtx, currency: string, today: string): Promise<FxPreview> {
  const hit = await cachedRate(ctx.db, currency, today).catch(() => null)
  if (hit) return { currency, ...hit }
  const res = await fetchEcbRate(ctx as SaleCtx & FxFetchCtx, currency, today)
  return res.ok
    ? { currency, rate: res.rate, rate_date: res.rate_date }
    : { currency, rate: null, rate_date: null }
}

async function previewOne(
  ctx: SaleCtx,
  stream: RevenueStream,
  issuerCountry: string,
  sale: Sale,
  fxOf: (currency: string) => Promise<FxPreview>,
) {
  const problems = saleProblems(sale)
  if (problems.length > 0) {
    return {
      external_id: String(sale?.external_id ?? ""),
      blockers: problems.map((p) => `invalid: ${p}`),
    }
  }
  const payload = orderPaidPayloadFromSale(sale)
  const c = payload.customer
  const counterpartyCountry = c?.tax_country ?? c?.country ?? issuerCountry
  const classification = classify({
    issuer_country: issuerCountry,
    counterparty_country: counterpartyCountry,
    has_vat_id: !!c?.vat_id,
  })
  let net = 0n
  let computedTax = 0n
  let reportedTax = 0n
  for (const li of payload.line_items) {
    const sub =
      lineSubtotal({
        quantity: li.quantity,
        unit_price_minor: BigInt(String(li.unit_price_minor)),
      }) - BigInt(String(li.discount_minor ?? "0"))
    const rate =
      typeof li.tax_rate_bp === "number" ? li.tax_rate_bp : classification.default_rate_bp
    net += sub
    computedTax += lineTax({ subtotal_minor: sub, tax_rate_bp: rate })
    reportedTax += BigInt(String(li.shopify_tax_minor ?? "0"))
  }
  const blockers: string[] = []
  if (!c?.email) blockers.push("buyer email missing")
  const incomplete = c
    ? counterpartyCompletenessError(
        {
          legal_name: c.legal_name ?? c.email ?? "",
          country: c.country ?? counterpartyCountry,
          address: c.address ?? null,
          email: c.email ?? null,
          customer_kind: c.kind === "individual" ? "individual" : null,
          vat_id: c.vat_id ?? null,
        },
        payload.line_items,
      )
    : { message: "no buyer" }
  if (incomplete) blockers.push(`buyer incomplete: ${incomplete.message}`)
  if (classification.treatment === "unconfigured") blockers.push("tax regime not configured")
  if (c?.vat_id && classification.treatment === "eu_reverse_charge")
    blockers.push(`VAT number ${c.vat_id} to validate (vat_validate) before issuing`)
  const chargesNoTax =
    payload.line_items.length > 0 && payload.line_items.every((li) => li.tax_rate_bp === 0)
  if (isUntaxedIntraEuSaleWithoutVat(classification.treatment, chargesNoTax))
    blockers.push("EU buyer charged no VAT and gave no VAT number")
  for (const m of streamRateMismatches(payload.line_items, classification))
    blockers.push(
      `"${m.description}" charged at ${m.tax_rate_bp} bp, ${classification.treatment} is ${classification.default_rate_bp} bp`,
    )
  const diff = computedTax > reportedTax ? computedTax - reportedTax : reportedTax - computedTax
  if (diff > BigInt(Math.max(1, payload.line_items.length)))
    blockers.push(`tax computed ${computedTax} differs from the source's ${reportedTax}`)
  const totals = totalsMismatch(sale)
  if (totals)
    blockers.push(
      `lines (${totals.lines_minor} + ${totals.tax_minor}) do not add up to ${totals.total_minor}`,
    )
  // A foreign currency is priced in EUR at issue (the issue flow warms the ECB rate of the issue
  // date; an e-invoice the ECB cannot price waits for it): shown, never a blocker here.
  const fx = sale.currency !== "EUR" ? await fxOf(sale.currency) : null
  const existing = await streamSource(stream, sale).existingDocuments(ctx)
  const invoiced = existing.find((d) => d.type !== "credit_note") ?? null
  return {
    external_id: sale.external_id,
    sold_at: sale.sold_at,
    buyer: {
      name: c?.legal_name ?? null,
      email: c?.email ?? null,
      country: counterpartyCountry,
      vat_id: c?.vat_id ?? null,
      kind: sale.buyer.kind ?? null,
    },
    treatment: classification.treatment,
    currency: sale.currency,
    lines: sale.lines.map((l) => ({
      description: l.description,
      quantity: l.quantity,
      unit_price_minor: l.unit_price_minor,
      discount_minor: l.discount_minor ?? "0",
      rate_bp: l.tax?.rate_bp ?? null,
    })),
    net_minor: net.toString(),
    tax_minor: computedTax.toString(),
    source_tax_minor: reportedTax.toString(),
    total_minor: sale.totals.total_minor,
    fx,
    refunds: (sale.refunds ?? []).map((r) => ({
      refund_id: r.refund_id,
      amount_minor: r.amount_minor,
      at: r.at,
    })),
    already_invoiced: invoiced ? String(invoiced.number ?? invoiced.id) : null,
    blockers,
  }
}

/** `sales_catch_up_preview`: what the run would issue, in order. Writes nothing. */
export async function revenueStreamCatchUpPreview(ctx: SaleCtx, input: CatchUpInput) {
  const stream = await streamOf(ctx, input)
  if (!stream) return fail("stream_not_found", "streamId names no revenue stream.")
  if (stream.provider_app === SHOPIFY)
    return fail(
      "shop_catch_up_elsewhere",
      "The shop's missed orders are caught up by its own order updates.",
    )
  const window = windowOf(input)
  if (!window) return fail("invalid_window", "paidFrom and paidTo are ISO dates, paidFrom first.")
  const issuer = await findIssuerById(ctx.db, stream.issuer_profile_id ?? "")
  if (!issuer) return fail("issuer_profile_not_found", "The stream's issuer profile is gone.")
  const read = await salesOf(ctx, stream, window.from, window.to)
  if (!read.ok) return fail(read.code, `The provider did not list its sales: ${read.message}`)
  const rows: Array<Awaited<ReturnType<typeof previewOne>>> = []
  const today = new Date().toISOString().slice(0, 10)
  const rates = new Map<string, Promise<FxPreview>>()
  const fxOf = (cur: string) => {
    const known = rates.get(cur)
    if (known) return known
    const p = fxPreview(ctx, cur, today)
    rates.set(cur, p)
    return p
  }
  for (const s of read.sales) rows.push(await previewOne(ctx, stream, issuer.country, s, fxOf))
  const toIssue = rows.filter((r) => !("already_invoiced" in r && r.already_invoiced))
  return {
    status: "completed" as const,
    dryRun: true,
    stream: { streamId: stream.id, providerApp: stream.provider_app, issuerProfileId: issuer.id },
    window,
    counts: {
      sales: rows.length,
      alreadyInvoiced: rows.length - toIssue.length,
      toIssue: toIssue.length,
      blocked: toIssue.filter((r) => r.blockers.length > 0).length,
      refunds: rows.reduce((n, r) => n + ("refunds" in r && r.refunds ? r.refunds.length : 0), 0),
    },
    sales: rows,
    summary:
      `${rows.length} sale(s) of ${stream.label ?? stream.provider_app} paid between ${window.from} and ${window.to}: ` +
      `${toIssue.length} to invoice in sale-date order, ${rows.length - toIssue.length} already invoiced, ` +
      `${toIssue.filter((r) => r.blockers.length > 0).length} with a blocker. Nothing was written.`,
  }
}

/** Most sales one `sales_preview_pdfs` call renders (each is a PDF render). */
export const PREVIEW_PDF_MAX = 8

export interface PreviewPdfsInput extends CatchUpInput {
  /** The sales to render (payment ids as the preview lists them); else the window's first ones. */
  externalIds?: string[]
}

/**
 * `sales_preview_pdfs`: each listed sale of the window that has no invoice yet, run through the
 * issue path on a context that writes nothing, and rendered as the unnumbered document it would
 * become, watermarked "PREVIEW, not an invoice" (sales/sale-preview.ts). The PDFs are internal
 * files: never mailed, never linked to a buyer. A sale that would park says why instead.
 */
export async function revenueStreamPreviewPdfs(ctx: SaleCtx, input: PreviewPdfsInput) {
  const stream = await streamOf(ctx, input)
  if (!stream) return fail("stream_not_found", "streamId names no revenue stream.")
  if (stream.provider_app === SHOPIFY)
    return fail(
      "shop_catch_up_elsewhere",
      "The shop's missed orders are caught up by its own order updates.",
    )
  const window = windowOf(input)
  if (!window) return fail("invalid_window", "paidFrom and paidTo are ISO dates, paidFrom first.")
  const read = await salesOf(ctx, stream, window.from, window.to)
  if (!read.ok) return fail(read.code, `The provider did not list its sales: ${read.message}`)
  const wanted = Array.isArray(input.externalIds)
    ? new Set(input.externalIds.filter((x): x is string => typeof x === "string"))
    : null
  const chosen = read.sales.filter((s) => !wanted || wanted.has(s.external_id))
  const rows: Array<{
    external_id: string
    sold_at: string
    already_invoiced?: string
    preview?: SalePreview
    unreadable?: true
  }> = []
  let rendered = 0
  let more = 0
  for (const listed of chosen) {
    if (rendered >= PREVIEW_PDF_MAX) {
      more++
      continue
    }
    const env = ctx.contracts
      ? await ctx.contracts.call<{ found?: boolean; sale?: Sale }>(
          REVENUE_STREAM,
          "sale_get",
          { external_id: listed.external_id },
          { provider: stream.provider_app },
        )
      : null
    const sale =
      env?.status === "completed" && env.result?.found && env.result.sale ? env.result.sale : null
    if (!sale) {
      rows.push({ external_id: listed.external_id, sold_at: listed.sold_at, unreadable: true })
      continue
    }
    const existing = (await streamSource(stream, sale).existingDocuments(ctx)).find(
      (d) => d.type !== "credit_note",
    )
    if (existing) {
      rows.push({
        external_id: sale.external_id,
        sold_at: sale.sold_at,
        already_invoiced: String(existing.number ?? existing.id),
      })
      continue
    }
    rendered++
    rows.push({
      external_id: sale.external_id,
      sold_at: sale.sold_at,
      preview: await previewSale(stream, sale, ctx),
    })
  }
  return {
    status: "completed" as const,
    stream: { streamId: stream.id, providerApp: stream.provider_app },
    window,
    sales: rows,
    notRendered: more,
    summary:
      `${rendered} sale(s) rendered as unnumbered previews (watermarked, nothing issued or sent)` +
      (more > 0 ? `; ${more} more: call again with their externalIds.` : "."),
  }
}

export type CatchUpStep =
  | {
      external_id: string
      sold_at: string
      outcome: "issued"
      numbers: string[]
      credit_notes: string[]
    }
  | { external_id: string; sold_at: string; outcome: "already_invoiced"; credit_notes: string[] }
  | { external_id: string; sold_at: string; outcome: "stopped"; reason: string }

/** `sales_catch_up`: the approved run (see the header). */
export async function revenueStreamCatchUp(ctx: CatchUpCtx, input: CatchUpInput) {
  if (!ctx.approval)
    return fail(
      "approval_required",
      "The catch-up issues legal invoices: a person approves the run.",
    )
  const stream = await streamOf(ctx, input)
  if (!stream) return fail("stream_not_found", "streamId names no revenue stream.")
  if (stream.provider_app === SHOPIFY)
    return fail(
      "shop_catch_up_elsewhere",
      "The shop's missed orders are caught up by its own order updates.",
    )
  if (stream.mode === "off") return fail("stream_off", "The stream is off: nothing is invoiced.")
  const window = windowOf(input)
  if (!window) return fail("invalid_window", "paidFrom and paidTo are ISO dates, paidFrom first.")
  const read = await salesOf(ctx, stream, window.from, window.to)
  if (!read.ok) return fail(read.code, `The provider did not list its sales: ${read.message}`)
  const steps: CatchUpStep[] = []
  let stoppedAt: number | null = null
  for (const [i, listed] of read.sales.entries()) {
    // The sale as the source answers now (the list may be a page old).
    const env = ctx.contracts
      ? await ctx.contracts.call<{ found?: boolean; sale?: Sale }>(
          REVENUE_STREAM,
          "sale_get",
          { external_id: listed.external_id },
          { provider: stream.provider_app },
        )
      : null
    const sale =
      env?.status === "completed" && env.result?.found && env.result.sale ? env.result.sale : null
    if (!sale) {
      steps.push({
        external_id: listed.external_id,
        sold_at: listed.sold_at,
        outcome: "stopped",
        reason: "sale_unreadable",
      })
      stoppedAt = i
      break
    }
    const before = await streamSource(stream, sale).existingDocuments(ctx)
    const had = before.filter((d) => d.type !== "credit_note")
    let numbers: string[] = []
    if (had.length === 0) {
      const r = await issueSale(stream, sale, ctx)
      if (r.status !== "ok") {
        const reason =
          r.status === "deferred"
            ? `parked: ${r.reason}`
            : r.status === "pending_approval"
              ? "waits for an approval"
              : `${r.status}: ${"reason" in r ? r.reason : ""}`
        steps.push({
          external_id: sale.external_id,
          sold_at: sale.sold_at,
          outcome: "stopped",
          reason,
        })
        stoppedAt = i
        break
      }
      numbers = r.documents.map((d) => d.number)
    }
    const docs = (await streamSource(stream, sale).existingDocuments(ctx)).filter(
      (d) => d.type !== "credit_note",
    )
    const credit: string[] = []
    let refused: string | null = null
    for (const refund of sale.refunds ?? []) {
      const primary = docs[0]
      if (!primary) break
      const c = await creditSaleRefund(ctx, stream, primary, refund)
      if (c.outcome === "issued") credit.push(c.number)
      else if (c.outcome === "refused") {
        refused = c.reason
        break
      }
    }
    if (refused) {
      steps.push({
        external_id: sale.external_id,
        sold_at: sale.sold_at,
        outcome: "stopped",
        reason: `credit note refused: ${refused}`,
      })
      stoppedAt = i
      break
    }
    steps.push(
      had.length === 0
        ? {
            external_id: sale.external_id,
            sold_at: sale.sold_at,
            outcome: "issued",
            numbers,
            credit_notes: credit,
          }
        : {
            external_id: sale.external_id,
            sold_at: sale.sold_at,
            outcome: "already_invoiced",
            credit_notes: credit,
          },
    )
  }
  const left = stoppedAt === null ? [] : read.sales.slice(stoppedAt + 1).map((s) => s.external_id)
  const issued = steps.filter((s) => s.outcome === "issued").length
  return {
    status: "completed" as const,
    dryRun: false,
    stream: { streamId: stream.id, providerApp: stream.provider_app },
    window,
    steps,
    stopped: stoppedAt !== null,
    notIssued: left,
    summary:
      stoppedAt === null
        ? `${issued} sale(s) invoiced in sale-date order; ${steps.length - issued} already had their invoice.`
        : `Stopped at ${read.sales[stoppedAt]?.external_id} (${(steps[steps.length - 1] as { reason?: string }).reason}); ${issued} invoiced before it, ${left.length} later sale(s) left unissued so the numbers keep sale-date order. Fix the cause and approve the run again.`,
  }
}

export type { Row }
