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
import type { MutationsDb } from "../mutations/shared"
import { recipientOf } from "../recipient"
import { planTax } from "../tax-plan"

/** What can keep a card from making an invoice. */
export type PreviewMissing =
  | "issuer_profile"
  | "company"
  | "rate"
  | "currency"
  | "counterparty_mismatch"
  | "basis"

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
  lines?: Array<{ billMinutes?: number }>
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
      message: string
    }
  | { error: { code: string; message: string; retryable: false } }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
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
    const env = await ctx.executeTool("kernel:contacts_read", { contactId })
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
    const recipient =
      companyId || contactId ? await recipientOf(ctx, { contactId, companyId }) : null
    const lines = (input.lines ?? [])
      .map((l) => Math.max(0, Math.round(Number(l.billMinutes) || 0)))
      .filter((m) => m > 0)
      .map((m) => ({
        quantity: lineQuantity(m, unit, hpd ?? 60),
        unit_price_minor: BigInt(rateMinor),
      }))
    const plan = planTax({
      issuerCountry: issuer.issuer.country,
      pricesIncludeTax: false,
      taxCountry: recipient?.counterparty_country ?? null,
      hasVatId: !!recipient?.counterparty_vat_id,
      lines,
      linesAreNet: true,
    })
    excl = Number(plan.subtotal_minor)
    vat = Number(plan.tax_minor)
    incl = Number(plan.total_minor)
    rateBp = plan.rate_bp
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
