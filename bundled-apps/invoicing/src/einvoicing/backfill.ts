// SPDX-License-Identifier: FSL-1.1-ALv2
// Identity backfill for existing customers, and the identity-confirm job.
//
// `einvoicing_backfill_identities` walks every contact that has an invoicing document: it records
// the customer kind the documents support (the same derivation as at issue), reads the SIREN off
// a French VAT id and confirms it against the business registry (§4.4: a single exact hit, active,
// under the counterparty's own name; anything else is never written and stays on the readiness
// list), fills the structured billing address of the contact's latest document and open drafts
// from their own printed address, and backfills the issuer's SIREN / SIRET from a valid
// registration id. Identities recorded by a person or a registry check are never touched.
// Idempotent; `dry_run` (the default) reports the same counts and writes nothing.
//
// The `identity-confirm` job runs the same registry confirmation over derived, unconfirmed SIRENs
// (read off a VAT id at issue time). A confirmation bumps `changed_at`, which re-drives the
// parks waiting on that contact.

import { isValidSiren, isValidSiret, sirenFromFrVat } from "./identity"
import { deriveKind } from "./identity-derive"
import { contactNames, type IdentityToolsCtx, registryColumns } from "./identity-tools"
import {
  candidateMatchesName,
  type RegistryCandidate,
  type RegistryUnconfirmedReason,
  registrySearch,
} from "./lookup"
import { einvoicingReadiness } from "./readiness"

type Row = Record<string, unknown>

export type BackfillCtx = IdentityToolsCtx

function str(v: unknown): string | null {
  if (typeof v !== "string") return null
  const t = v.trim()
  return t ? t : null
}

function digits(v: unknown): string {
  return (str(v) ?? "").replace(/[\s.]/g, "")
}

function upper(v: unknown): string | null {
  return str(v)?.toUpperCase() ?? null
}

/** Documents read per backfill call (the contacts they name are processed in order). */
const PAGE = 200
/** Documents of one contact read to derive its kind, names and latest billing address. */
const CONTACT_DOCS = 50
export const BACKFILL_DEFAULT_LIMIT = 20
export const BACKFILL_MAX_LIMIT = 50
/** Registry checks per identity-confirm run. */
export const CONFIRM_JOB_BATCH = 20
/** A derived SIREN the registry did not confirm is checked again after this long. */
export const CONFIRM_RECHECK_MS = 24 * 60 * 60 * 1000

// ── Registry confirmation (§4.4, D28) ───────────────────────────────────────

export type ConfirmOutcome =
  | { status: "confirmed"; candidate: RegistryCandidate }
  | {
      status: "unconfirmed"
      reason: RegistryUnconfirmedReason | "ambiguous" | "ceased" | "name_mismatch"
    }

/** A SIREN is confirmed only by a single exact registry hit, active, whose registered name
 *  matches one of the names the counterparty is known under. */
export async function confirmSiren(
  ctx: BackfillCtx,
  siren: string,
  names: string[],
): Promise<ConfirmOutcome> {
  const res = await registrySearch(ctx, { siren })
  if (res.status !== "ok") return { status: "unconfirmed", reason: res.reason }
  if (res.candidates.length !== 1) return { status: "unconfirmed", reason: "ambiguous" }
  const candidate = res.candidates[0] as RegistryCandidate
  if (candidate.status !== "A") return { status: "unconfirmed", reason: "ceased" }
  if (!candidateMatchesName(candidate, names))
    return { status: "unconfirmed", reason: "name_mismatch" }
  return { status: "confirmed", candidate }
}

function confirmedColumns(
  candidate: RegistryCandidate,
  siren: string,
  vatId: string | null,
  country: string | null,
  now: Date,
): Row {
  const fromVat = !!vatId && sirenFromFrVat(vatId, { billingCountry: country }) === siren
  return {
    siren,
    ...registryColumns(candidate, now),
    confirmed_via: "auto",
    ...(fromVat ? { source: "vat_derived" } : {}),
  }
}

// ── Printed address parsing ──────────────────────────────────────────────────

const COUNTRY_LINE = /^(france|fr|république française|republique francaise)$/i

/** Structured billing from a printed address: the `NNNNN City` line (the last one, or the one
 *  before a trailing country line), and the street line before it. Null when there is none. */
export function parseBillingBlob(
  blob: string | null | undefined,
): { line1: string | null; postcode: string; city: string } | null {
  const lines = (blob ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  if (lines.length > 0 && COUNTRY_LINE.test(lines[lines.length - 1] as string)) lines.pop()
  const last = lines[lines.length - 1]
  if (!last) return null
  // "street, 75001 City" on one line, or "75001 City" on its own line.
  const m = /^(?:(.*?),\s*)?(\d{5})\s+(.+)$/.exec(last)
  if (!m) return null
  const inlineStreet = str(m[1])
  const street = inlineStreet ?? (lines.length >= 2 ? (lines[lines.length - 2] as string) : null)
  return { line1: street, postcode: m[2] as string, city: (m[3] as string).trim() }
}

// ── The backfill ─────────────────────────────────────────────────────────────

interface Counts {
  identities_created: number
  identities_updated: number
  confirmed: number
  unconfirmed: number
  kept: number
  billing_filled: number
  billing_unparsed: number
  issuers: number
  /** Issuer profiles whose SIREN the caller may not write (issuer settings need
   *  invoicing:settings:write). */
  issuers_not_written: number
  lookups: number
}

function parseCursor(cursor: unknown): { offset: number; after: string | null } {
  const s = str(cursor)
  if (!s) return { offset: 0, after: null }
  const [o, a] = s.split(":")
  const offset = Number(o)
  return { offset: Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0, after: str(a) }
}

function cursorOf(offset: number, after: string | null): string {
  return `${offset}:${after ?? ""}`
}

function docTime(d: Row): string {
  const v = d.issued_at ?? d.created_at ?? null
  if (v instanceof Date) return v.toISOString()
  return typeof v === "string" ? v : ""
}

/** The contact's latest document: the most recent issued one, else the most recent of any. */
function latestDocument(docs: Row[]): Row | null {
  const sorted = [...docs].sort((a, b) =>
    docTime(a) < docTime(b) ? 1 : docTime(a) > docTime(b) ? -1 : 0,
  )
  return sorted.find((d) => d.status !== "draft") ?? sorted[0] ?? null
}

async function kernelCompany(ctx: BackfillCtx, contactId: string): Promise<string | null> {
  if (!ctx.executeTool) return null
  try {
    const env = await ctx.executeTool("kernel:contacts_read", { contactId })
    if (env.status !== "completed") return null
    return str(
      (env.result as { contact?: { company?: unknown } } | null | undefined)?.contact?.company,
    )
  } catch {
    return null
  }
}

interface Step {
  /** Applied only on a real run; false when the write did not take (row not writable). */
  apply(): Promise<boolean | undefined | void>
}

async function issuerSteps(ctx: BackfillCtx, counts: Counts): Promise<Step[]> {
  const rows = (await ctx.db.findMany("issuer_profiles", { limit: 50 })) as Row[]
  const steps: Step[] = []
  for (const r of rows) {
    if (str(r.siren)) continue
    if (upper(r.country_code) !== "FR" && upper(r.country) !== "FR") continue
    const id = digits(r.tax_registration_id)
    let patch: Row | null = null
    if (id.length === 14 && isValidSiret(id))
      patch = { siren: id.slice(0, 9), ...(str(r.siret) ? {} : { siret: id }) }
    else if (id.length === 9 && isValidSiren(id)) patch = { siren: id }
    if (!patch) continue
    counts.issuers += 1
    const p = patch
    steps.push({
      apply: async () => {
        await ctx.db.update("issuer_profiles", String(r.id), p)
        // Row-level security drops an update the caller's scopes do not cover without an error:
        // read it back so the report never claims a write that did not happen.
        const after = (await ctx.db.findMany("issuer_profiles", {
          where: { id: r.id },
          limit: 1,
        })) as Row[]
        if (str(after[0]?.siren) === p.siren) return true
        counts.issuers_not_written += 1
        return false
      },
    })
  }
  return steps
}

/** Billing patches for the contact's latest document and its open drafts, each from its own
 *  printed address; only empty columns are filled. */
function billingSteps(ctx: BackfillCtx, docs: Row[], latest: Row | null, counts: Counts): Step[] {
  const targets = docs.filter((d) => d === latest || d.status === "draft")
  const steps: Step[] = []
  for (const d of targets) {
    if (str(d.billing_postcode) && str(d.billing_city)) continue
    const parsed = parseBillingBlob(str(d.counterparty_address))
    if (!parsed) {
      counts.billing_unparsed += 1
      continue
    }
    const patch: Row = {}
    if (!str(d.billing_line1) && parsed.line1) patch.billing_line1 = parsed.line1
    if (!str(d.billing_postcode)) patch.billing_postcode = parsed.postcode
    if (!str(d.billing_city)) patch.billing_city = parsed.city
    const country = upper(d.billing_country_code) ?? upper(d.counterparty_country)
    if (!str(d.billing_country_code) && country) patch.billing_country_code = country
    counts.billing_filled += 1
    steps.push({ apply: async () => void (await ctx.db.update("documents", String(d.id), patch)) })
  }
  return steps
}

interface ContactPlan {
  /** A SIREN to confirm against the registry before writing it (null: no lookup needed). */
  sirenToConfirm: string | null
  run(lookup: (siren: string) => Promise<ConfirmOutcome>): Promise<Step[]>
}

async function planContact(
  ctx: BackfillCtx,
  contactId: string,
  counts: Counts,
  now: Date,
): Promise<ContactPlan> {
  const [identities, docs] = await Promise.all([
    ctx.db.findMany("counterparty_identities", {
      where: { contact_id: contactId },
      limit: 1,
    }) as Promise<Row[]>,
    ctx.db.findMany("documents", {
      where: { counterparty_contact_id: contactId },
      limit: CONTACT_DOCS,
    }) as Promise<Row[]>,
  ])
  const existing = identities[0] ?? null
  const latest = latestDocument(docs)
  const country = upper(latest?.billing_country_code) ?? upper(latest?.counterparty_country)
  const vat =
    str(existing?.vat_id) ?? docs.map((d) => str(d.counterparty_vat_id)).find((v) => !!v) ?? null
  // A person or a registry check recorded this identity: never touched.
  const recorded = !!existing && existing.source !== "derived"

  let kind = str(existing?.customer_kind)
  if (!kind && !recorded) {
    const company = vat ? null : await kernelCompany(ctx, contactId)
    kind = deriveKind({
      vat_id: vat,
      company,
      legal_name: str(latest?.buyer_legal_name) ?? str(latest?.counterparty_name),
      country,
      origin: docs.some((d) => str(d.shopify_order_id)) ? "shopify" : "manual",
    })
  }
  const billing =
    kind === "business" && country === "FR" ? billingSteps(ctx, docs, latest, counts) : []

  if (recorded) {
    counts.kept += 1
    return { sirenToConfirm: null, run: async () => billing }
  }

  const patch: Row = {}
  if (!str(existing?.customer_kind) && kind) patch.customer_kind = kind
  if (!str(existing?.vat_id) && vat) patch.vat_id = vat
  const siren =
    str(existing?.siren) ??
    (kind === "business" ? sirenFromFrVat(vat, { billingCountry: country }) : null)
  const sirenToConfirm =
    kind === "business" && siren && isValidSiren(siren) && !existing?.confirmed_via ? siren : null

  return {
    sirenToConfirm,
    run: async (lookup) => {
      if (sirenToConfirm) {
        const outcome = await lookup(sirenToConfirm)
        if (outcome.status === "confirmed") {
          counts.confirmed += 1
          Object.assign(
            patch,
            confirmedColumns(outcome.candidate, sirenToConfirm, vat, country, now),
          )
        } else {
          counts.unconfirmed += 1
        }
      }
      if (Object.keys(patch).length === 0) return billing
      const steps = [...billing]
      // Every identity write bumps changed_at: the parks waiting on this contact are re-driven.
      const data = { ...patch, changed_at: now }
      if (existing) {
        counts.identities_updated += 1
        steps.push({
          apply: async () =>
            void (await ctx.db.update("counterparty_identities", String(existing.id), data)),
        })
      } else if (patch.customer_kind) {
        counts.identities_created += 1
        steps.push({
          apply: async () =>
            void (await ctx.db.insert("counterparty_identities", {
              contact_id: contactId,
              source: "derived",
              siren: null,
              confirmed_via: null,
              ...data,
            })),
        })
      }
      return steps
    },
  }
}

export async function backfillIdentities(
  ctx: BackfillCtx,
  input: { dry_run?: boolean | null; cursor?: string | null; limit?: number | null } = {},
): Promise<Row> {
  const dryRun = input?.dry_run !== false
  const requested = Number(input?.limit ?? BACKFILL_DEFAULT_LIMIT)
  const limit = Math.min(
    BACKFILL_MAX_LIMIT,
    Math.max(1, Number.isFinite(requested) ? Math.floor(requested) : BACKFILL_DEFAULT_LIMIT),
  )
  const { offset, after } = parseCursor(input?.cursor)
  const now = new Date()
  const counts: Counts = {
    identities_created: 0,
    identities_updated: 0,
    confirmed: 0,
    unconfirmed: 0,
    kept: 0,
    billing_filled: 0,
    billing_unparsed: 0,
    issuers: 0,
    issuers_not_written: 0,
    lookups: 0,
  }
  const steps: Step[] = await issuerSteps(ctx, counts)

  const page = (await ctx.db.findMany("documents", {
    orderBy: { counterparty_contact_id: "asc", id: "asc" },
    limit: PAGE,
    offset,
  } as never)) as Row[]
  const contacts: Array<{ id: string; index: number }> = []
  const seen = new Set<string>()
  page.forEach((d, index) => {
    const id = str(d.counterparty_contact_id)
    if (!id || seen.has(id)) return
    seen.add(id)
    contacts.push({ id, index })
  })

  let scanned = 0
  let lastDone: string | null = null
  let nextCursor: string | null = null
  let stopped = false
  const lookup = async (siren: string, names: () => Promise<string[]>) => {
    counts.lookups += 1
    return confirmSiren(ctx, siren, await names())
  }
  for (const c of contacts) {
    // The previous call finished this contact; its remaining documents open this page.
    if (c.id === after) continue
    const plan = await planContact(ctx, c.id, counts, now)
    if (plan.sirenToConfirm && counts.lookups >= limit) {
      nextCursor = cursorOf(offset + c.index, null)
      stopped = true
      break
    }
    scanned += 1
    steps.push(...(await plan.run((siren) => lookup(siren, () => contactNames(ctx, c.id)))))
    lastDone = c.id
  }
  if (!stopped && page.length === PAGE) nextCursor = cursorOf(offset + page.length, lastDone)

  let written = 0
  if (!dryRun) for (const s of steps) if ((await s.apply()) !== false) written += 1
  const readiness = (await einvoicingReadiness(ctx, { limit: 1 })) as { count?: number }
  return {
    status: "ok",
    dry_run: dryRun,
    scanned,
    ...(dryRun ? { would_write: steps.length } : { written }),
    counts,
    limit,
    readiness_count: readiness.count ?? 0,
    next_cursor: nextCursor,
    message: dryRun
      ? "Dry run: nothing was written. Run again with dry_run false to write these changes."
      : [
          nextCursor
            ? "Partial run: call again with next_cursor to continue."
            : "Backfill complete. Counterparties still blocking e-invoicing are on einvoicing_readiness.",
          ...(counts.issuers_not_written > 0
            ? [
                "The issuer's SIREN / SIRET was not recorded: issuer settings need invoicing:settings:write. An administrator runs this again, or records them in the issuer profile settings.",
              ]
            : []),
        ].join(" "),
  }
}

// ── identity-confirm job ─────────────────────────────────────────────────────

function checkedRecently(row: Row, now: Date): boolean {
  const v = row.registry_checked_at
  if (v == null || v === "") return false
  const at = v instanceof Date ? v : new Date(String(v))
  return !Number.isNaN(at.getTime()) && now.getTime() - at.getTime() < CONFIRM_RECHECK_MS
}

/** Confirm derived, unconfirmed SIRENs against the registry (≤ `CONFIRM_JOB_BATCH` per run). */
export async function identityConfirmJob(
  ctx: BackfillCtx,
  opts: { now?: Date } = {},
): Promise<{ checked: number; confirmed: number }> {
  const now = opts.now ?? new Date()
  const rows = (await ctx.db.findMany("counterparty_identities", {
    where: { source: "derived" },
    limit: 500,
  })) as Row[]
  const due = rows
    .filter((r) => {
      const siren = str(r.siren)
      return !!siren && isValidSiren(siren) && !r.confirmed_via && !checkedRecently(r, now)
    })
    .slice(0, CONFIRM_JOB_BATCH)
  let confirmed = 0
  for (const r of due) {
    const contactId = String(r.contact_id)
    const siren = str(r.siren) as string
    const outcome = await confirmSiren(ctx, siren, await contactNames(ctx, contactId))
    if (outcome.status === "confirmed") {
      confirmed += 1
      await ctx.db.update("counterparty_identities", String(r.id), {
        ...confirmedColumns(outcome.candidate, siren, str(r.vat_id), null, now),
        changed_at: now,
      })
    } else {
      // Not confirmed: remember the check (no changed_at bump, nothing re-driven).
      await ctx.db.update("counterparty_identities", String(r.id), { registry_checked_at: now })
    }
  }
  return { checked: due.length, confirmed }
}

/** Manifest `jobs.identity-confirm` handler (kernel `(payload, ctx)` shape). */
export async function identityConfirmJobHandler(
  _payload: unknown,
  ctx: BackfillCtx,
): Promise<{ checked: number; confirmed: number }> {
  return identityConfirmJob(ctx)
}
