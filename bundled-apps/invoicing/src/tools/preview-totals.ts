// SPDX-License-Identifier: FSL-1.1-ALv2
//
// preview_totals: what a planned vs done card's billed lines would invoice, excluding VAT, the VAT
// and the total including it, and whether an invoice can be made from them at all. Internal: the
// projects app reads it once per card, through its declared cross-app call, so the card shows the
// totals and says what to set (an issuer profile, the project's company, a rate, a currency)
// before anyone presses Create. Nothing is written.

import type { CrossAppExecuteTool } from "../cross-app"
import { type BilledUnit, lineQuantity } from "../line-amount"
import { resolveIssuerProfileOrError } from "../mutations/db-helpers"
import {
  cardMinutes,
  lateItems,
  lateOnOtherCard,
  monthOnRun,
  retainerPlan,
  retainerRecipient,
  retainerScheduleOf,
} from "../mutations/retainer"
import type { MutationsDb } from "../mutations/shared"
import { recipientOf } from "../recipient"
import { type RecipientGap, recipientGaps } from "../recipient-gaps"
import { isRetainerMonth } from "../recurring/retainer"
import { netLinesTotals } from "../tax-plan"

/** What can keep a card from making an invoice. */
export type PreviewMissing =
  | "issuer_profile"
  | "company"
  | "rate"
  | "currency"
  | "counterparty_mismatch"
  | "basis"
  | "retainer"
  | "within_fee"
  | RecipientGap

export interface PreviewTotalsInput {
  projectId?: string
  /** The project's billing basis: daily, hourly and retainer bill by rate; fixed and none do not. */
  basis?: string
  /** The project's company (kernel company id). */
  companyId?: string | null
  /** The contact the invoice would go to, when the project names one. */
  contactId?: string | null
  currency?: string | null
  /** The rate per unit, in minor units. */
  rateMinor?: number | null
  hoursPerDayMinutes?: number | null
  lines?: Array<{ billMinutes?: number; workMonth?: string }>
  /** A card's first day: the month a retainer card bills, and the one earlier hours come before. */
  periodFrom?: string | null
  /** A retainer month's timebox on the project. */
  timeboxMinutes?: number | null
  waiveOverage?: boolean
}

export interface PreviewTotalsCtx {
  db: MutationsDb
  executeTool?: CrossAppExecuteTool
}

export type PreviewTotalsResult =
  | {
      projectId: string
      ready: boolean
      missing: PreviewMissing[]
      /** Minor units; null when the lines cannot be priced (no rate or no currency). */
      excl: number | null
      vat: number | null
      incl: number | null
      rateBp: number | null
      currency: string | null
      /** Steps of the project's billing plan not invoiced yet. */
      openPlanSteps: number
      /** A retainer month: the hours above the included and rolled-in hours, in minutes (what a
       *  waiver would leave off). Absent on any other basis. */
      overageMinutes?: number
      /** A retainer month: what its invoice is made of (the schedule's fee and the hours it
       *  includes, the rate above them), and whether the schedule's month-end run already bills
       *  the month (then Create is refused: a month is billed once). Absent on any other basis. */
      retainer?: {
        feeExclMinor: number
        includedMinutes: number
        usedMinutes: number
        overageRateMinor: number
        billedBySchedule: boolean
      }
      /** A retainer card whose month bills no retainer: only earlier months' later hours bill. */
      lateOnly?: boolean
      message: string
    }
  | { error: { code: string; message: string; retryable: false } }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DAY = /^\d{4}-\d{2}-\d{2}$/
const RATE_BASES = new Set(["daily", "hourly", "retainer"])
const OPEN_STEP = new Set(["planned", "drafted"])
const LIVE_STEP = new Set(["planned", "drafted", "issued", "paid"])

const WHAT_TO_SET: Record<PreviewMissing, string> = {
  issuer_profile: "the company's issuer profile in invoicing settings",
  company: "the project's company",
  rate: "the project's rate",
  currency: "the project's currency",
  counterparty_mismatch:
    "a contact of the project's own company (the contact named belongs to another one)",
  basis: "nothing: this project bills by a fixed price or a billing plan, not from planned vs done",
  retainer: "the project's retainer on its recurring schedule in invoicing",
  within_fee:
    "nothing: the hours of earlier months are within what their retainer included, so there is nothing to bill",
  billing_address: "the customer's billing address",
  email: "the customer's email address",
  siren: "the customer's SIREN",
}

/** The unit a basis bills its lines in. */
export function unitOfBasis(basis: string): BilledUnit {
  return basis === "daily" ? "day" : "hour"
}

async function companyOfContact(
  ctx: PreviewTotalsCtx,
  contactId: string,
): Promise<string | null | undefined> {
  if (!ctx.executeTool) return undefined
  try {
    const env = await ctx.executeTool("kernel:contacts_identity", { contactId })
    if (env.status !== "completed") return undefined
    const c = ((env.result ?? {}) as { contact?: Record<string, unknown> }).contact ?? {}
    const id = c.companyId ?? c.company_id
    return typeof id === "string" && id !== "" ? id : null
  } catch {
    return undefined
  }
}

export async function previewTotals(
  ctx: PreviewTotalsCtx,
  input: PreviewTotalsInput,
): Promise<PreviewTotalsResult> {
  const projectId = typeof input.projectId === "string" ? input.projectId : ""
  if (!UUID.test(projectId)) {
    return {
      error: {
        code: "invalid_project",
        message: `projectId ${projectId || "(none)"} is not a project id. Nothing was read.`,
        retryable: false,
      },
    }
  }
  const basis = typeof input.basis === "string" ? input.basis : "none"
  const missing: PreviewMissing[] = []

  const steps = (await ctx.db.findMany("billing_steps", {
    where: { billing_project_id: projectId },
    limit: 500,
  })) as Array<{ state?: unknown }>
  const openPlanSteps = steps.filter((s) => OPEN_STEP.has(String(s.state))).length
  const livePlan = steps.some((s) => LIVE_STEP.has(String(s.state)))
  if (!RATE_BASES.has(basis) || livePlan) missing.push("basis")

  const issuer = await resolveIssuerProfileOrError(ctx.db, null)
  if (!issuer.ok) missing.push("issuer_profile")

  const companyId =
    typeof input.companyId === "string" && input.companyId !== "" ? input.companyId : null
  if (!companyId) missing.push("company")
  const contactId =
    typeof input.contactId === "string" && input.contactId !== "" ? input.contactId : null
  if (companyId && contactId) {
    const ofContact = await companyOfContact(ctx, contactId)
    if (ofContact && ofContact !== companyId) missing.push("counterparty_mismatch")
  }

  if (basis === "retainer" && !missing.includes("basis"))
    return retainerPreview(
      ctx,
      input,
      projectId,
      missing,
      openPlanSteps,
      issuer,
      companyId,
      contactId,
    )

  const rateMinor =
    typeof input.rateMinor === "number" && Number.isFinite(input.rateMinor) && input.rateMinor > 0
      ? Math.round(input.rateMinor)
      : null
  const hpd =
    typeof input.hoursPerDayMinutes === "number" && input.hoursPerDayMinutes > 0
      ? input.hoursPerDayMinutes
      : null
  // A daily rate needs the project's hours per day to turn minutes into days.
  if ((rateMinor === null || (basis === "daily" && hpd === null)) && !missing.includes("basis"))
    missing.push("rate")
  const currency =
    typeof input.currency === "string" && /^[A-Z]{3}$/.test(input.currency) ? input.currency : null
  if (!currency) missing.push("currency")

  let excl: number | null = null
  let vat: number | null = null
  let incl: number | null = null
  let rateBp: number | null = null
  if (
    rateMinor !== null &&
    currency &&
    issuer.ok &&
    !missing.includes("rate") &&
    RATE_BASES.has(basis)
  ) {
    const unit = unitOfBasis(basis)
    // Hours of a retainer month told after its invoice: priced as that month's, not at this rate.
    const { late } = cardMinutes(input.lines ?? [])
    const from = typeof input.periodFrom === "string" ? input.periodFrom : ""
    const other =
      late.length > 0 && DAY.test(from)
        ? await lateOnOtherCard(ctx, { projectId, before: from.slice(0, 7), late })
        : null
    const lateLines = other ? lateItems(other.late, 0) : []
    if (late.length > 0 && (!other || other.unknown.length > 0)) missing.push("retainer")
    if (lateLines.length > 0 && other && other.currency !== currency) missing.push("currency")
    const recipient =
      companyId || contactId ? await recipientOf(ctx, { contactId, companyId }) : null
    const ownLines = (input.lines ?? [])
      .filter((l) => typeof l.workMonth !== "string")
      .map((l) => Math.max(0, Math.round(Number(l.billMinutes) || 0)))
      .filter((m) => m > 0)
      .map((m) => ({
        quantity: lineQuantity(m, unit, hpd ?? 60),
        unit_price_minor: BigInt(rateMinor),
      }))
    const plan = netLinesTotals({
      issuerCountry: issuer.issuer.country,
      taxCountry: recipient?.counterparty_country ?? null,
      hasVatId: !!recipient?.counterparty_vat_id,
      lines: [...ownLines, ...(lateLines as never[])],
    })
    excl = Number(plan.subtotal_minor)
    vat = Number(plan.tax_minor)
    incl = Number(plan.total_minor)
    rateBp = plan.rate_bp
    // The customer the Create would draft to, with or without a contact named: an invoice to a
    // company alone carries no address or email either, and its issue would refuse it.
    if (recipient && missing.length === 0)
      missing.push(...(await recipientGaps(ctx, issuer.issuer, contactId, recipient)))
  }
  const ready = missing.length === 0
  const message = ready
    ? `An invoice can be made from these lines: ${excl} excl. VAT, ${vat} VAT, ${incl} incl. VAT (minor units, ${currency}). Nothing was created.`
    : `No invoice can be made from these lines yet. Set ${missing.map((m) => WHAT_TO_SET[m]).join("; ")}. Nothing was created.`
  return {
    projectId,
    ready,
    missing,
    excl,
    vat,
    incl,
    rateBp,
    currency,
    openPlanSteps,
    message,
  }
}

/** A retainer card priced as its draft will be: the schedule's fee, then any overage. */
async function retainerPreview(
  ctx: PreviewTotalsCtx,
  input: PreviewTotalsInput,
  projectId: string,
  missing: PreviewMissing[],
  openPlanSteps: number,
  issuer: Awaited<ReturnType<typeof resolveIssuerProfileOrError>>,
  companyId: string | null,
  contactId: string | null,
): Promise<PreviewTotalsResult> {
  const from =
    typeof input.periodFrom === "string" && DAY.test(input.periodFrom) ? input.periodFrom : null
  const s = await retainerScheduleOf(ctx, projectId, from?.slice(0, 7) ?? "")
  const card = cardMinutes(input.lines ?? [])
  let within = false
  // A month that bills no retainer from its card can still bill earlier months' later hours, alone.
  if (from && issuer.ok && card.late.length > 0) {
    const month = from.slice(0, 7)
    const onCard = !!s && isRetainerMonth(s, month) && !(await monthOnRun(ctx, String(s.id), month))
    const alone = onCard
      ? null
      : await lateOnOtherCard(ctx, { projectId, before: month, late: card.late })
    const items = alone ? lateItems(alone.late, 0) : []
    within = !!alone && alone.unknown.length === 0 && alone.late.length > 0 && items.length === 0
    if (alone?.schedule && items.length > 0) {
      const who = retainerRecipient(alone.schedule, { contactId, companyId })
      const recipient = who.companyId || who.contactId ? await recipientOf(ctx, who) : null
      const tax = netLinesTotals({
        issuerCountry: issuer.issuer.country,
        taxCountry: recipient?.counterparty_country ?? null,
        hasVatId: !!recipient?.counterparty_vat_id,
        lines: items as never,
      })
      if (alone.unknown.length > 0) missing.push("retainer")
      if (recipient && missing.length === 0)
        missing.push(...(await recipientGaps(ctx, issuer.issuer, who.contactId, recipient)))
      return {
        projectId,
        ready: missing.length === 0,
        missing,
        excl: Number(tax.subtotal_minor),
        vat: Number(tax.tax_minor),
        incl: Number(tax.total_minor),
        rateBp: tax.rate_bp,
        currency: alone.currency,
        openPlanSteps,
        lateOnly: true,
        message: `Only the hours of earlier months entered after their invoices bill from this card: ${Number(tax.subtotal_minor)} excl. VAT (minor units, ${alone.currency}). Nothing was created.`,
      }
    }
  }
  // The earlier hours are inside their fee and the month bills no retainer: there is nothing to set.
  if (within) {
    return {
      projectId,
      ready: false,
      missing: ["within_fee"],
      excl: null,
      vat: null,
      incl: null,
      rateBp: null,
      currency: null,
      openPlanSteps,
      message: `The hours of earlier months on this card are within what their retainer included, and this month bills no retainer, so there is nothing to bill. Nothing was created.`,
    }
  }
  if (!s || !from) missing.push("retainer")
  let excl: number | null = null
  let vat: number | null = null
  let incl: number | null = null
  let rateBp: number | null = null
  let currency: string | null = null
  let overageMinutes = 0
  let retainer: Extract<PreviewTotalsResult, { ready: boolean }>["retainer"]
  if (s && from && issuer.ok) {
    const { used, late } = card
    const [y, m] = from.split("-").map(Number) as [number, number]
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
    const plan = await retainerPlan(ctx, s, {
      projectId,
      period: { from, to: `${from.slice(0, 8)}${String(last).padStart(2, "0")}` },
      usedMinutes: used,
      late,
      timeboxMinutes: input.timeboxMinutes ?? null,
      waived: input.waiveOverage === true,
    })
    currency = plan.currency
    overageMinutes = plan.fig.overageMinutes + plan.late.reduce((a, l) => a + l.overage_minutes, 0)
    if (plan.unknown.length > 0) missing.push("retainer")
    const month = from.slice(0, 7)
    const billedBySchedule =
      !isRetainerMonth(s, month) || (await monthOnRun(ctx, String(s.id), month))
    retainer = {
      feeExclMinor: (plan.items as Array<Record<string, unknown>>)
        .filter((i) => String(i.external_id ?? "").startsWith("retainer_fee:"))
        .reduce((a, i) => a + Number(i.unit_price_minor) * Number(i.quantity), 0),
      includedMinutes: plan.fig.includedMinutes,
      usedMinutes: plan.fig.usedMinutes,
      overageRateMinor: Number(plan.overageRate),
      billedBySchedule,
    }
    // The customer the retainer's Create drafts to: the schedule's contact and company first.
    const who = retainerRecipient(s, { contactId, companyId })
    const recipient = who.companyId || who.contactId ? await recipientOf(ctx, who) : null
    const tax = netLinesTotals({
      issuerCountry: issuer.issuer.country,
      taxCountry: recipient?.counterparty_country ?? null,
      hasVatId: !!recipient?.counterparty_vat_id,
      lines: plan.items as never,
    })
    excl = Number(tax.subtotal_minor)
    vat = Number(tax.tax_minor)
    incl = Number(tax.total_minor)
    rateBp = tax.rate_bp
    if (recipient && missing.length === 0)
      missing.push(...(await recipientGaps(ctx, issuer.issuer, who.contactId, recipient)))
  }
  const ready = missing.length === 0
  return {
    projectId,
    ready,
    missing,
    excl,
    vat,
    incl,
    rateBp,
    currency,
    openPlanSteps,
    overageMinutes,
    ...(retainer ? { retainer } : {}),
    message: ready
      ? `The retainer month can be invoiced: ${excl} excl. VAT, ${vat} VAT, ${incl} incl. VAT (minor units, ${currency}). Nothing was created.`
      : `No invoice can be made for this retainer month yet. Set ${missing.map((m) => WHAT_TO_SET[m]).join("; ")}. Nothing was created.`,
  }
}
