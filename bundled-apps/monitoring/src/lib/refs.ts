// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Incident references: the short, immutable, per-org `INC-<n>` name. Format/parse helpers,
// the lock-first numbering protocol over `ctx.sequences.allocate`, and the UUID-or-ref
// resolver every triage tool shares. `ref_number` is nullable: NULL means "not numbered yet"
// and every consumer renders that as "no ref".
import type { AppContext } from "@liaison/app-sdk"

const SEQUENCE_KEY = "monitoring:incident_ref"

type RefsCtx = Pick<AppContext, "db" | "sequences">

/** An incident row as the bridge returns it (snake_case columns). */
export type IncidentRecord = { id: string } & Record<string, unknown>

/** `INC-<n>` for a positive integer `ref_number`; null for anything else (not numbered yet). */
export function formatRef(n: unknown): string | null {
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? `INC-${n}` : null
}

/** `[INC-7] ` (trailing space) or `""`: the notification summaries render it verbatim. */
export function refLabel(ref: string | null): string {
  return ref ? `[${ref}] ` : ""
}

/** The `ref` + `refLabel` pair every `incident:*` event payload carries. */
export function refFields(refNumber: unknown): { ref: string | null; refLabel: string } {
  const ref = formatRef(refNumber)
  return { ref, refLabel: refLabel(ref) }
}

/** `INC-142` (any case, surrounding spaces ignored) to 142; anything else to null. */
export function parseRef(s: unknown): number | null {
  if (typeof s !== "string") return null
  const m = /^INC-(\d{1,9})$/i.exec(s.trim())
  if (!m) return null
  const n = Number(m[1])
  return n > 0 ? n : null
}

/** Allocate the next value of the org's incident sequence (the first value is 1). */
export async function allocateRef(ctx: RefsCtx): Promise<number> {
  const r = (await ctx.sequences.allocate({ key: SEQUENCE_KEY })) as { value?: number; error?: unknown }
  if (typeof r?.value !== "number") throw new Error(`ref_allocation_failed: ${JSON.stringify(r)}`)
  return r.value
}

/**
 * Number the oldest un-numbered incidents (`first_seen_at`, then id), at most `limit` per call.
 * Every caller passes its own bound: the lock is held until the caller's transaction ends, so
 * the batch decides how long other numberers (a creating webhook, the job) wait behind it.
 *
 * Lock-first protocol, in this exact order: (1) an unlocked probe, so a fully numbered org
 * allocates nothing; (2) the first allocation, which takes the org advisory lock until the
 * surrounding transaction ends; (3) the list is read only NOW, under the lock, so it can no
 * longer contain a row another numberer committed meanwhile; (4) the rows are written by id.
 * No compare-and-set is needed (and the bridge refuses `where.id` on `updateMany` anyway).
 * When the list under the lock is empty, another numberer drained it first and the value
 * allocated in step 2 is burned (refs stay unique and immutable; gaps are accepted).
 *
 * HARD RULE: call it only inside ONE ambient transaction (a webhook delivery or an
 * `atomic: true` job), because the lock must cover steps 2 to 4 until commit. Never from a
 * tool or a non-atomic job: there each bridge call is its own short transaction and the lock
 * is released right after the allocation.
 */
export async function assignMissingRefs(
  ctx: RefsCtx,
  { limit }: { limit: number },
): Promise<{ assigned: number; remaining: boolean }> {
  const probe = await ctx.db.findMany("incidents", { where: { ref_number: null }, limit: 1 })
  if (probe.length === 0) return { assigned: 0, remaining: false }

  const first = await allocateRef(ctx)

  const rows = (await ctx.db.findMany("incidents", {
    where: { ref_number: null },
    orderBy: { first_seen_at: "asc", id: "asc" },
    limit,
  })) as Array<{ id: string }>
  if (rows.length === 0) return { assigned: 0, remaining: false }

  for (let i = 0; i < rows.length; i++) {
    const refNumber = i === 0 ? first : await allocateRef(ctx)
    await ctx.db.update("incidents", rows[i]!.id, { ref_number: refNumber })
  }
  return { assigned: rows.length, remaining: rows.length === limit }
}

/**
 * Resolve an incident from its UUID or its `INC-<n>` ref. No UUID check in app code: the
 * bridge answers `null` for a non-UUID id. Org scoping comes from the bridge.
 */
export async function resolveIncident(ctx: Pick<AppContext, "db">, input: string): Promise<IncidentRecord> {
  const trimmed = String(input ?? "").trim()
  const n = parseRef(trimmed)
  const found =
    n != null
      ? ((await ctx.db.findMany("incidents", { where: { ref_number: n }, limit: 1 }))[0] ?? null)
      : await ctx.db.findOne("incidents", trimmed)
  if (!found) throw new Error(`incident_not_found: ${input}`)
  return found as IncidentRecord
}
