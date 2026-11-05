// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The lead a public demo signup leaves behind.
//
// The visitor types a name and an address into "Start the demo". The address is
// NOT their login (routes.ts gives the account a generated internal address, so
// typing somebody's email can never reach anybody's workspace); it is kept here,
// in `kernel.demo_leads`, as the record of who tried the product.
//
// CONSENT WITHOUT A STEP. The form shows a one-line notice under the button
// saying the address will be used for a few messages about the product and that
// the visitor can opt out at any time. That is information at collection plus an
// easy opt-out, the rule for prospecting a professional about a professional
// product, so there is no checkbox. What the visitor was told is recorded with
// the row (`notice_version`), and every row carries its own unguessable opt-out
// token so any future message can carry a one-click unsubscribe link.
//
// THE ROW OUTLIVES THE ORG. A visitor org expires and the reaper deletes it; the
// lead must not go with it, so `demo_org_id` has no foreign key and the table has
// no `org_id` (which also keeps it out of the per-org reset rules).
//
// WHAT THE PRIVACY NOTICE PROMISES, ENFORCED HERE. An opt-out keeps only the
// address (the name is wiped) so the row works as a do-not-contact entry, and a
// lead nobody opted out of is deleted `DEMO_LEAD_RETENTION_DAYS` after signup
// (`purgeStaleDemoLeads`, run by the hourly demo reaper). Change either and the
// published policy must change with it.
//
// Instance data, not tenant data: written and read only through the privileged
// connection, exported only to the instance operator's org (routes.ts).
import crypto from "node:crypto"
import { and, asc, desc, eq, gte, isNotNull, isNull, lt, sql } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { demoLeads } from "~/db/schema/kernel"
import { env } from "~/lib/env"
import { forwardDemoLeadUpdate, forwardNewDemoLead } from "~/modules/liaison-team/lead-forwarding"

/**
 * The version of the notice a lead is told about: the text shown under the
 * signup button (`kernel.demo.leadNotice` in every locale) and the demo privacy
 * notice it links to. Bump it whenever either changes, so each lead records
 * what it was actually told. 2026-11-02: the privacy notice names the copy kept
 * by the Liaison team, the door picks, the confirmed-address flag and the
 * scenarios opened. 2026-11-05: it names the door's company question, kept with
 * the workspace and counted without a name.
 */
export const DEMO_LEAD_NOTICE_VERSION = "2026-11-05"

export interface DemoLeadRow {
  id: string
  email: string
  name: string
  noticeVersion: string
  demoOrgId: string | null
  optOutToken: string
  optedOutAt: string | null
  createdAt: string
  /** The page a message links for unsubscribing; carries the opt-out token. */
  unsubscribeUrl: string
  /** Did the visitor confirm the address (code or link)? */
  verified: boolean
  verifiedAt: string | null
  /** When the visitor asked to hear about the managed launch, or null. */
  notifyManagedAt: string | null
  /** The needs picked on the door, in pick order. */
  needs: string[]
}

/** How long a lead that never opted out is kept, from signup. Three years. */
export const DEMO_LEAD_RETENTION_DAYS = 3 * 365

/** The web page that opts a lead out (`/demo/unsubscribe` in the web app). */
export function demoLeadUnsubscribeUrl(token: string): string {
  const url = new URL("/demo/unsubscribe", env.BASE_URL)
  url.searchParams.set("token", token)
  return url.toString()
}

/** A fresh per-lead opt-out token: 32 random bytes, url-safe. */
export function newOptOutToken(): string {
  return crypto.randomBytes(32).toString("base64url")
}

/**
 * Record one signup. The address is stored as typed, lowercased, next to the
 * mailbox it normalizes to, the needs picked and the client network of the
 * Start request (which is never changed afterwards).
 */
export async function recordDemoLead(input: {
  email: string
  name: string
  demoOrgId: string
  noticeVersion?: string
  emailNormalized?: string
  emailCapKey?: string | null
  needs?: readonly string[]
  signupNetwork?: string
}): Promise<{ id: string }> {
  const [row] = await withSystemDb("demo-lead-record", (tx) =>
    tx
      .insert(demoLeads)
      .values({
        email: input.email.trim().toLowerCase(),
        name: input.name.trim(),
        noticeVersion: input.noticeVersion ?? DEMO_LEAD_NOTICE_VERSION,
        demoOrgId: input.demoOrgId,
        optOutToken: newOptOutToken(),
        emailNormalized: input.emailNormalized ?? null,
        emailCapKey: input.emailCapKey ?? null,
        needs: input.needs ? [...input.needs] : [],
        signupNetwork: input.signupNetwork ?? null,
      })
      .returning({ id: demoLeads.id }),
  )
  // To the Liaison team's outbox, when that is on for this server (never throws).
  await forwardNewDemoLead(row.id)
  return { id: row.id }
}

/** Every lead, oldest first. Operator export only. */
export async function listDemoLeads(): Promise<DemoLeadRow[]> {
  const rows = await withSystemDb("demo-lead-export", (tx) =>
    tx.select().from(demoLeads).orderBy(asc(demoLeads.createdAt), asc(demoLeads.id)),
  )
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    name: r.name,
    noticeVersion: r.noticeVersion,
    demoOrgId: r.demoOrgId,
    optOutToken: r.optOutToken,
    optedOutAt: r.optedOutAt ? r.optedOutAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
    unsubscribeUrl: demoLeadUnsubscribeUrl(r.optOutToken),
    verified: r.verifiedAt !== null,
    verifiedAt: r.verifiedAt ? r.verifiedAt.toISOString() : null,
    notifyManagedAt: r.notifyManagedAt ? r.notifyManagedAt.toISOString() : null,
    needs: r.needs,
  }))
}

/** The lead of one demo org, as the verification and budget paths read it. */
export interface DemoOrgLead {
  id: string
  email: string
  name: string
  emailNormalized: string | null
  emailCapKey: string | null
  verifiedAt: Date | null
  notifyManagedAt: Date | null
  signupNetwork: string | null
  needs: string[]
}

/** The lead a demo org was created with (the latest, should there be two). */
export async function leadForDemoOrg(orgId: string): Promise<DemoOrgLead | null> {
  const [row] = await withSystemDb("demo-lead-for-org", (tx) =>
    tx
      .select({
        id: demoLeads.id,
        email: demoLeads.email,
        name: demoLeads.name,
        emailNormalized: demoLeads.emailNormalized,
        emailCapKey: demoLeads.emailCapKey,
        verifiedAt: demoLeads.verifiedAt,
        notifyManagedAt: demoLeads.notifyManagedAt,
        signupNetwork: demoLeads.signupNetwork,
        needs: demoLeads.needs,
      })
      .from(demoLeads)
      .where(eq(demoLeads.demoOrgId, orgId))
      .orderBy(desc(demoLeads.createdAt))
      .limit(1),
  )
  return row ?? null
}

/**
 * Hand a lead over to the workspace its visitor started over in. One person,
 * one lead: the row moves with them (confirmed address, picks, opt-out, the
 * signup network the spend budget is keyed on), so the new workspace is
 * confirmed from its first second and the lead export never counts them twice.
 */
export async function moveDemoLead(leadId: string, toOrgId: string): Promise<void> {
  await withSystemDb("demo-lead-move", (tx) =>
    tx.update(demoLeads).set({ demoOrgId: toOrgId }).where(eq(demoLeads.id, leadId)),
  )
}

/**
 * Set "tell me when managed launches" on the org's lead. Verified leads only;
 * idempotent (the first time is kept). Returns false when the lead is absent
 * or unverified.
 */
export async function setDemoLeadNotifyManaged(orgId: string): Promise<boolean> {
  const lead = await leadForDemoOrg(orgId)
  if (!lead?.verifiedAt) return false
  if (lead.notifyManagedAt) return true
  const changed = await withSystemDb("demo-lead-notify-managed", (tx) =>
    tx
      .update(demoLeads)
      .set({ notifyManagedAt: sql`now()` })
      .where(and(eq(demoLeads.id, lead.id), isNull(demoLeads.notifyManagedAt)))
      .returning({ id: demoLeads.id }),
  )
  if (changed.length > 0) await forwardDemoLeadUpdate(lead.id, { notifyManaged: true })
  return true
}

/** What a verification count is scoped to. */
export type DemoVerifiedScope =
  | { kind: "box" }
  | { kind: "domain"; capKey: string }
  | { kind: "network"; network: string }

/** How many leads in `scope` were verified at or after `since`. */
export async function countDemoVerifiedSince(
  scope: DemoVerifiedScope,
  since: Date,
): Promise<number> {
  const scoped =
    scope.kind === "domain"
      ? eq(demoLeads.emailCapKey, scope.capKey)
      : scope.kind === "network"
        ? eq(demoLeads.signupNetwork, scope.network)
        : undefined
  const [row] = await withSystemDb("demo-lead-verified-count", (tx) =>
    tx
      .select({ n: sql<number>`count(*)::int` })
      .from(demoLeads)
      .where(and(isNotNull(demoLeads.verifiedAt), gte(demoLeads.verifiedAt, since), scoped)),
  )
  return row?.n ?? 0
}

/**
 * Opt the lead holding this token out, wiping the name: what stays is the
 * address and the time, which is all a do-not-contact list needs. Idempotent:
 * the first opt-out's time is kept. Returns whether a lead holds the token, which the public route does NOT
 * reveal (it answers the same either way).
 */
export async function optOutDemoLead(token: string): Promise<boolean> {
  if (token.length < 32 || token.length > 128) return false
  const first = await withSystemDb("demo-lead-opt-out", async (tx) => {
    const updated = await tx
      .update(demoLeads)
      .set({ optedOutAt: sql`now()`, name: "" })
      .where(sql`${eq(demoLeads.optOutToken, token)} AND ${isNull(demoLeads.optedOutAt)}`)
      .returning({ id: demoLeads.id })
    if (updated.length > 0) return { leadId: updated[0]?.id ?? null, found: true }
    const [existing] = await tx
      .select({ id: demoLeads.id })
      .from(demoLeads)
      .where(eq(demoLeads.optOutToken, token))
      .limit(1)
    return { leadId: null, found: existing !== undefined }
  })
  // The first opt-out only: the Liaison team's copy is told once (never throws).
  if (first.leadId) await forwardDemoLeadUpdate(first.leadId, { optedOut: true })
  return first.found
}

/**
 * Delete every lead older than the retention window that never opted out.
 * Opted-out rows stay: they are the do-not-contact list, and they hold no name.
 * Returns how many rows went.
 */
export async function purgeStaleDemoLeads(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - DEMO_LEAD_RETENTION_DAYS * 24 * 60 * 60 * 1000)
  const deleted = await withSystemDb("demo-lead-purge", (tx) =>
    tx
      .delete(demoLeads)
      .where(and(isNull(demoLeads.optedOutAt), lt(demoLeads.createdAt, cutoff)))
      .returning({ id: demoLeads.id }),
  )
  return deleted.length
}

const CSV_COLUMNS: Array<[keyof DemoLeadRow, string]> = [
  ["email", "email"],
  ["name", "name"],
  ["createdAt", "created_at"],
  ["noticeVersion", "notice_version"],
  ["demoOrgId", "demo_org_id"],
  ["optedOutAt", "opted_out_at"],
  ["optOutToken", "opt_out_token"],
  ["unsubscribeUrl", "unsubscribe_url"],
  ["verified", "verified"],
  ["verifiedAt", "verified_at"],
  ["notifyManagedAt", "notify_managed_at"],
  ["needs", "needs"],
]

/**
 * One CSV cell. Quoted when it needs to be, and a value a spreadsheet would read
 * as a formula (a visitor typed the name, so it is untrusted) is prefixed with a
 * quote so opening the export cannot run anything.
 */
function csvCell(raw: string | null | boolean | string[]): string {
  if (raw === null) return ""
  const value = typeof raw === "boolean" ? String(raw) : Array.isArray(raw) ? raw.join(" ") : raw
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

export function demoLeadsCsv(rows: DemoLeadRow[]): string {
  const header = CSV_COLUMNS.map(([, h]) => h).join(",")
  const lines = rows.map((r) => CSV_COLUMNS.map(([k]) => csvCell(r[k])).join(","))
  return `${[header, ...lines].join("\r\n")}\r\n`
}
