// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The catch-up of a revenue stream: the sales a provider took before the stream was bound (or
// that no event brought), invoiced in sale-date order. Two tools:
//
//   sales_catch_up_preview  read only: every sale paid in the window (`sales_list` from
//     the provider, each one as `sale_get` would answer), with its buyer, country, tax treatment,
//     lines, tax as computed against the tax the source reported, totals, refunds, blockers, and
//     the document it already has. Nothing is written.
//     Each sale still to invoice also runs through the issue path itself on a context that writes
//     nothing and renders nothing (`previewSale`, render off), so its blockers name every reason
//     the issue would park or refuse it, and `run_effect` says what the run would do with it.
//   sales_catch_up          gated, never auto-approved: a person approves the run. It
//     sorts the window's sales by sale date (oldest first), issues each one through `issueSale`
//     (one number each, today's issue date, the sale date on the document's references), then a
//     credit note for each refund of it. The rule when a sale cannot issue:
//       - parked on its OWN data (the park waits `awaiting_data`: buyer address or email, VAT
//         number, identity, tax or totals of that sale): the sale is HELD (it waits in its park
//         for the fix) and the run goes on with the next sale;
//       - any other cause (the issuer profile, a configuration, an exchange rate, an approval, a
//         refused issue, an unreadable sale, a refused credit note) is shared by the sales after it:
//         the run STOPS there and leaves the later sales unissued.
//     The sales that do issue are numbered strictly in sale-date order within the run, and every
//     one is issued today, so the series stays chronological by issue date; a held sale is issued
//     by its park's retry or a later run, with a later number and that day's issue date.
//     `exclude` (each with a person's reason) skips sales and records them as excluded in the
//     sales ledger, with a `sale:excluded` audit event: no later run, event or park retry invoices
//     them until `reinclude` names them. The run can be approved again once a cause is fixed:
//     sales already invoiced are skipped.
//
// The run is the person's decision for each sale it issues (the approval re-enters with
// `ctx.approval`), so a review stream asks nothing more and `issue_from` does not apply.

import {
  type ContractEnvelope,
  REVENUE_STREAM,
  type Sale,
  saleProblems,
} from "@liaison/app-sdk/contracts"
import { resolveOpenParks } from "../deferred"
import { cachedRate, type FxFetchCtx, fetchEcbRate } from "../einvoicing/fx"
import {
  findIssuerById,
  streamLineSourceTax,
  streamRateMismatches,
} from "../handlers/shopify-order-paid"
import { counterpartyCompletenessError, type PreviewParent } from "../issue"
import { lineSubtotal, lineTax } from "../money"
import type { MutationsCtx } from "../mutations/shared"
import { overseasLineTax } from "../overseas-tax"
import { supplyDateOf } from "../sale-tax"
import { excludeRecordedSale, recordSale, reincludeSale, saleExclusion } from "../sales-ledger"
import { classify, isUntaxedIntraEuSaleWithoutVat, lineRateBp } from "../tax"
import { vatTerritoryOf } from "../vat-territory"
import { issueSale, type SaleCtx, streamParkId, streamSource, totalsMismatch } from "./issue-sale"
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

export interface CatchUpRunInput extends CatchUpInput {
  /** Sales a person decided not to invoice, each with the reason. */
  exclude?: Array<{ externalId?: unknown; reason?: unknown }>
  /** Sales excluded earlier, to invoice again. */
  reinclude?: unknown[]
}

/** How long a preview PDF stays readable before its row is removed. */
export const PREVIEW_TTL_DAYS = 7

/** The ledger key of a stream's sale. */
function ledgerKey(stream: RevenueStream, externalId: string) {
  return {
    issuer_profile_id: stream.issuer_profile_id ?? "",
    stream: stream.provider_app,
    external_id: externalId,
  }
}

/** What the run does with a sale the issue path would park: hold it (its own data) or stop. */
export function parkEffect(status: string | null | undefined): "held" | "stops_run" {
  return status === "awaiting_data" ? "held" : "stops_run"
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
  fxOf: (currency: string, soldAt: string) => Promise<FxPreview>,
  pricesIncludeTax = false,
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
  const rawTaxCountry = c?.tax_country ?? c?.country ?? issuerCountry
  const counterpartyCountry = vatTerritoryOf(
    rawTaxCountry,
    c?.delivery?.postcode && (c.delivery.country_code ?? rawTaxCountry) === rawTaxCountry
      ? c.delivery.postcode
      : c?.billing?.postcode,
  )
  const classification = classify({
    issuer_country: issuerCountry,
    counterparty_country: counterpartyCountry,
    has_vat_id: !!c?.vat_id,
    line_kinds: payload.line_items.map((li) => li.line_kind ?? "goods"),
  })
  // As the issue does: the French overseas rules check (and may extract) each line's tax.
  const overseas = overseasLineTax(payload.line_items, classification, {
    territory: counterpartyCountry,
    consumer: !c?.vat_id && c?.kind !== "company",
    pricesIncludeTax: pricesIncludeTax || payload.prices_include_tax === true,
  })
  const lineItems = overseas.ok ? overseas.lines : payload.line_items
  let net = 0n
  let computedTax = 0n
  let reportedTax = 0n
  // VAT the overseas rules took out of a tax-inclusive gross the source left untaxed: on the
  // invoice, never on the source's side of the comparison.
  let extractedTax = 0n
  for (const li of lineItems) {
    const sub =
      lineSubtotal({
        quantity: li.quantity,
        unit_price_minor: BigInt(String(li.unit_price_minor)),
      }) - BigInt(String(li.discount_minor ?? "0"))
    const rate = lineRateBp(classification, {
      line_kind: li.line_kind,
      tax_rate_bp_override: li.tax_rate_bp,
    })
    net += sub
    // As the issue does: the line's own tax when within a unit of its rate (streamLineSourceTax).
    const lineTaxMinor =
      streamLineSourceTax(li) ?? lineTax({ subtotal_minor: sub, tax_rate_bp: rate })
    computedTax += lineTaxMinor
    if (li.tax_from_gross) extractedTax += lineTaxMinor
    else reportedTax += BigInt(String(li.shopify_tax_minor ?? "0"))
  }
  const blockers: string[] = []
  if (!overseas.ok) blockers.push(`${overseas.reason}: ${overseas.message}`)
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
  // The overseas rules checked every line against its kind's rate already.
  for (const m of classification.rate_bp_by_kind
    ? []
    : streamRateMismatches(payload.line_items, classification))
    blockers.push(
      `"${m.description}" charged at ${m.tax_rate_bp} bp, ${classification.treatment} is ${classification.default_rate_bp} bp`,
    )
  const checked = computedTax - extractedTax
  const diff = checked > reportedTax ? checked - reportedTax : reportedTax - checked
  if (diff > BigInt(Math.max(1, payload.line_items.length)))
    blockers.push(`tax computed ${computedTax} differs from the source's ${reportedTax}`)
  const totals = totalsMismatch(sale)
  if (totals)
    blockers.push(
      `lines (${totals.lines_minor} + ${totals.tax_minor}) do not add up to ${totals.total_minor}`,
    )
  // A foreign currency is priced in EUR at issue (the issue flow warms the ECB rate of the issue
  // date; an e-invoice the ECB cannot price waits for it): shown, never a blocker here.
  const fx = sale.currency !== "EUR" ? await fxOf(sale.currency, sale.sold_at) : null
  const existing = await streamSource(stream, sale).existingDocuments(ctx)
  const invoiced = existing.find((d) => d.type !== "credit_note") ?? null
  const excluded = stream.issuer_profile_id
    ? await saleExclusion(ctx.db, ledgerKey(stream, sale.external_id))
    : null
  // The issue path itself, writing and rendering nothing: what it would park or refuse.
  let runEffect: "issues" | "held" | "stops_run" | "excluded" | "already_invoiced" = invoiced
    ? "already_invoiced"
    : excluded
      ? "excluded"
      : "issues"
  if (runEffect === "issues") {
    const dry = await previewSale(stream, sale, ctx, { render: false })
    if (dry.outcome === "would_park") {
      const b = (dry.blocked_on ?? {}) as { missing_fields?: unknown }
      const missing = Array.isArray(b.missing_fields) ? ` (${b.missing_fields.join(", ")})` : ""
      runEffect = parkEffect(dry.status)
      blockers.push(
        `the issue would park: ${dry.reason}${missing}; ${runEffect === "held" ? "the run holds this sale and goes on" : "the run stops here"}`,
      )
    } else if (dry.outcome === "refused") {
      runEffect = "stops_run"
      blockers.push(`the issue would be refused: ${dry.error}; the run stops here`)
    } else if (dry.outcome === "not_issued" && dry.status !== "skipped") {
      runEffect = "stops_run"
      blockers.push(
        `the issue would not complete (${dry.status}${dry.reason ? `: ${dry.reason}` : ""}); the run stops here`,
      )
    }
  }
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
    excluded: excluded ? { reason: excluded.reason } : null,
    run_effect: runEffect,
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
  // The rate of each sale's own date (the day its tax became chargeable), as the issue takes it.
  const rates = new Map<string, Promise<FxPreview>>()
  const fxOf = async (cur: string, soldAt: string) => {
    const day = await supplyDateOf(ctx, issuer, soldAt).catch(() => soldAt.slice(0, 10))
    const key = `${cur}:${day}`
    const known = rates.get(key)
    if (known) return known
    const p = fxPreview(ctx, cur, day)
    rates.set(key, p)
    return p
  }
  for (const s of read.sales)
    rows.push(
      await previewOne(ctx, stream, issuer.country, s, fxOf, issuer.prices_include_tax === true),
    )
  const toIssue = rows.filter(
    (r) => !("already_invoiced" in r && r.already_invoiced) && !("excluded" in r && r.excluded),
  )
  const effect = (e: string) => rows.filter((r) => "run_effect" in r && r.run_effect === e).length
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
      held: effect("held"),
      stopsRun: effect("stops_run"),
      excluded: effect("excluded"),
      refunds: rows.reduce((n, r) => n + ("refunds" in r && r.refunds ? r.refunds.length : 0), 0),
    },
    sales: rows,
    summary:
      `${rows.length} sale(s) of ${stream.label ?? stream.provider_app} paid between ${window.from} and ${window.to}: ` +
      `${toIssue.length} to invoice in sale-date order, ${rows.length - toIssue.length} already invoiced, ` +
      `${toIssue.filter((r) => r.blockers.length > 0).length} with a blocker (${effect("held")} the run would hold, ${effect("stops_run")} that would stop it), ${effect("excluded")} excluded. Nothing was written.`,
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
export async function revenueStreamPreviewPdfs(ctx: CatchUpCtx, input: PreviewPdfsInput) {
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
  await dropPreviews(ctx, (r) => expired(r, Date.now()))
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
    // A sale's new preview replaces its previous ones.
    await dropPreviews(ctx, (r) => r.stream_id === stream.id && r.external_id === sale.external_id)
    const renderedAt = new Date().toISOString()
    rows.push({
      external_id: sale.external_id,
      sold_at: sale.sold_at,
      preview: await previewSale(stream, sale, ctx, {
        parent: (scope): PreviewParent => ({
          entityType: "sale_preview",
          commitRow: {
            values: {
              stream_id: stream.id,
              external_id: sale.external_id,
              scope,
              rendered_at: renderedAt,
            },
            fileIdColumn: "pdf_file_id",
          },
        }),
      }),
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

/** True when a preview row is older than PREVIEW_TTL_DAYS. */
function expired(row: Row, now: number): boolean {
  const at = Date.parse(String(row.rendered_at ?? ""))
  return Number.isNaN(at) || now - at > PREVIEW_TTL_DAYS * 86_400_000
}

/** Remove the preview rows `which` selects: their files are no longer readable by anyone. */
async function dropPreviews(ctx: CatchUpCtx, which: (row: Row) => boolean): Promise<number> {
  const rows = (await ctx.db.findMany("sale_previews", { limit: 500 })) as Row[]
  let n = 0
  for (const r of rows.filter(which)) {
    await ctx.db.delete("sale_previews", String(r.id))
    n++
  }
  return n
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
  | { external_id: string; sold_at: string; outcome: "held"; reason: string }
  | { external_id: string; sold_at: string; outcome: "excluded"; reason: string | null }
  | { external_id: string; sold_at: string; outcome: "skipped"; reason: string }

type Exclusion = { externalId: string; reason: string }

/** The run's exclusions, each with a reason a person wrote; an error names the bad entry. */
function exclusionsOf(
  input: CatchUpRunInput,
): { ok: true; list: Exclusion[] } | { ok: false; message: string } {
  const list: Exclusion[] = []
  for (const e of input.exclude ?? []) {
    const externalId = typeof e?.externalId === "string" ? e.externalId.trim() : ""
    const reason = typeof e?.reason === "string" ? e.reason.trim() : ""
    if (!externalId) return { ok: false, message: "Each exclude entry names a sale by externalId." }
    if (reason.length < 5)
      return {
        ok: false,
        message: `Excluding ${externalId} needs the reason a person decided it (at least 5 characters).`,
      }
    list.push({ externalId, reason })
  }
  return { ok: true, list }
}

/** Record a sale a person excluded: ledger row `excluded` with the reason, its open park closed,
 *  and the `sale:excluded` audit event. False when the sale already has its invoice. */
async function excludeSale(
  ctx: CatchUpCtx,
  stream: RevenueStream,
  sale: Sale,
  reason: string,
  timezone: string | null,
): Promise<boolean> {
  if (!stream.issuer_profile_id) return false
  const by = ctx.approval?.approvalDeciderId ?? null
  const { sale_id } = await recordSale(ctx.db, {
    issuer_profile_id: stream.issuer_profile_id,
    stream: stream.provider_app,
    external_id: sale.external_id,
    source_ref: sale.external_id,
    source_name: sale.refs?.order_name ?? null,
    sold_on: await supplyDateOf(ctx, { timezone }, sale.sold_at).catch(() =>
      sale.sold_at.slice(0, 10),
    ),
    buyer: {
      email: sale.buyer?.email ?? null,
      shopify_customer_id: sale.buyer?.ids?.shopify_customer_id ?? null,
      hub_user_id: sale.buyer?.ids?.hub_user_id ?? null,
    },
    total_minor: sale.totals?.total_minor ?? null,
    currency: sale.currency,
  })
  const at = new Date().toISOString()
  if (!(await excludeRecordedSale(ctx.db, sale_id, { reason, by, at }))) return false
  await resolveOpenParks(
    { db: ctx.db, emit: ctx.emit },
    streamParkId(stream, sale.external_id),
    "sale_excluded",
  )
  await ctx.emit?.({
    entity: "sale",
    action: "excluded",
    entityId: sale_id,
    data: {
      sale_id,
      stream_id: stream.id,
      provider_app: stream.provider_app,
      external_id: sale.external_id,
      reason,
      excluded_by: by,
      approval_request_id: ctx.approval?.approvalRequestId ?? null,
    },
  })
  return true
}

/** `sales_catch_up`: the approved run (see the header). */
export async function revenueStreamCatchUp(ctx: CatchUpCtx, input: CatchUpRunInput) {
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
  const exclusions = exclusionsOf(input)
  if (!exclusions.ok) return fail("invalid_params", exclusions.message)
  const excludeNow = new Map(exclusions.list.map((e) => [e.externalId, e.reason]))
  const issuerTz = (await findIssuerById(ctx.db, stream.issuer_profile_id ?? ""))?.timezone ?? null
  const reincluded: string[] = []
  for (const id of input.reinclude ?? []) {
    if (typeof id !== "string" || id.trim() === "" || excludeNow.has(id.trim())) continue
    if (await reincludeSale(ctx.db, ledgerKey(stream, id.trim()))) {
      reincluded.push(id.trim())
      await ctx.emit?.({
        entity: "sale",
        action: "reincluded",
        entityId: id.trim(),
        data: {
          stream_id: stream.id,
          external_id: id.trim(),
          by: ctx.approval.approvalDeciderId ?? null,
          approval_request_id: ctx.approval.approvalRequestId ?? null,
        },
      })
    }
  }
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
    const toExclude = excludeNow.get(sale.external_id)
    if (had.length === 0 && toExclude !== undefined) {
      await excludeSale(ctx, stream, sale, toExclude, issuerTz)
      steps.push({
        external_id: sale.external_id,
        sold_at: sale.sold_at,
        outcome: "excluded",
        reason: toExclude,
      })
      continue
    }
    if (had.length === 0 && stream.issuer_profile_id) {
      const excluded = await saleExclusion(ctx.db, ledgerKey(stream, sale.external_id))
      if (excluded) {
        steps.push({
          external_id: sale.external_id,
          sold_at: sale.sold_at,
          outcome: "excluded",
          reason: excluded.reason,
        })
        continue
      }
    }
    let numbers: string[] = []
    if (had.length === 0) {
      const r = await issueSale(stream, sale, ctx)
      if (r.status === "skipped") {
        // Nothing to invoice (a cancelled sale, a zero total): the next sale goes on.
        steps.push({
          external_id: sale.external_id,
          sold_at: sale.sold_at,
          outcome: "skipped",
          reason: r.reason,
        })
        continue
      }
      if (r.status === "deferred") {
        const park = (await ctx.db.findOne("deferred_events", r.deferred_id)) as Row | null
        const why = String(park?.reason ?? r.reason)
        if (parkEffect(typeof park?.status === "string" ? park.status : null) === "held") {
          // The sale's own data: it waits in its park for the fix; the later sales go on.
          steps.push({
            external_id: sale.external_id,
            sold_at: sale.sold_at,
            outcome: "held",
            reason: `parked: ${why}`,
          })
          continue
        }
        steps.push({
          external_id: sale.external_id,
          sold_at: sale.sold_at,
          outcome: "stopped",
          reason: `parked: ${why}`,
        })
        stoppedAt = i
        break
      }
      if (r.status !== "ok") {
        const reason =
          r.status === "pending_approval"
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
  const held = steps.filter((s) => s.outcome === "held").map((s) => s.external_id)
  const excluded = steps.filter((s) => s.outcome === "excluded").map((s) => s.external_id)
  const tail =
    (held.length > 0
      ? ` ${held.length} held on their own data (${held.join(", ")}): each waits in its park.`
      : "") +
    (excluded.length > 0 ? ` ${excluded.length} excluded, not invoiced.` : "") +
    (reincluded.length > 0 ? ` Included again: ${reincluded.join(", ")}.` : "")
  return {
    status: "completed" as const,
    dryRun: false,
    stream: { streamId: stream.id, providerApp: stream.provider_app },
    window,
    steps,
    stopped: stoppedAt !== null,
    notIssued: left,
    held,
    excluded,
    reincluded,
    summary:
      (stoppedAt === null
        ? `${issued} sale(s) invoiced in sale-date order; ${steps.filter((s) => s.outcome === "already_invoiced").length} already had their invoice.`
        : `Stopped at ${read.sales[stoppedAt]?.external_id} (${(steps[steps.length - 1] as { reason?: string }).reason}): a cause the later sales share. ${issued} invoiced before it, ${left.length} later sale(s) left unissued so the numbers keep sale-date order. Fix the cause and approve the run again.`) +
      tail,
  }
}

export type { Row }
