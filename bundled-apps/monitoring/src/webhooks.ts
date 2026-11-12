// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The `alert` webhook handler — turns a signed external alert delivery into an
// incident row plus a lifecycle event. The manifest's attention translations
// turn the lifecycle events into home-feed items:
//
//   incident:created    → attention (critical=90/urgent, warning=60)
//   incident:reopened   → attention (a resolved alert re-firing is news)
//   incident:escalated  → attention (warning that became critical is news)
//   incident:repeated   → NO translation — a flapping alert bumps `count` on
//                         its ONE incident row and never floods the feed.
//
// Idempotency layers (outermost first):
//   1. Kernel replay protection — the verifier's replayKey (delivery id or
//      body digest) makes an exact redelivery a no-op before the handler runs.
//   2. (source, dedup_key) unique constraint — concurrent first deliveries of
//      the same alert race on the partial unique index; the loser re-reads and
//      folds into the winner's incident.
//   3. Lifecycle fold — an open/acknowledged incident absorbs repeats
//      (count++), a resolved one reopens. Every fold refreshes the title (and
//      the body when the delivery carries one). A reopen is a compare-and-set on
//      (source, dedup_key, status = resolved): only the delivery that wins it
//      archives the previous episode in `incident_comments`.
//
// Every `incident:*` payload carries `ref` / `refLabel` (`INC-<n>`, or null and
// "" while the incident is not numbered yet); a create numbers the new incident.
//
// A resolve envelope (`status: "resolved"` or `event: "resolve"`) is the
// source clearing its own alert: it resolves the live incident for
// (source, dedupKey) with `resolved_by = null` and a "cleared by" note, and
// never creates one. A resolve older than the incident's latest alert is
// stale (an out-of-order delivery must not close a fresh episode).
import type { AppContext, WebhookResult } from "@liaison/app-sdk"
import { type AlertEnvelope, parseEnvelope, type ResolveEnvelope, type Severity, severityRank } from "./envelope"
import { assignMissingRefs, refFields } from "./lib/refs"
import { errSummary } from "./lib/values"

export type { WebhookResult }

const OK: WebhookResult = { status: 200, body: "ok" }

/**
 * Rows numbered by one creating delivery. The delivery runs under the sandbox's 5 s budget, so
 * a backlog (right after deploy) is left to the `assign-refs` job, and so is the new row when
 * another numberer holds the numbering lease. The new row is the newest un-numbered one: it gets a number only when
 * every older one fits in this batch (refs keep `first_seen_at` order), else it stays null.
 */
export const CREATE_REF_BATCH = 10

/**
 * How long a new incident's own run may still be sending its incident:created: past any webhook
 * run's wall clock (the request ceiling caps a run at about 29 s), so a row still marked
 * `created_pending` after this belongs to a run that was killed after its insert.
 */
export const CREATED_LEASE_MS = 45_000

interface IncidentRow {
  id: string
  source: string
  severity: Severity
  status: "open" | "acknowledged" | "resolved"
  count: number
  title: string
  body?: string | null
  dedup_key?: string | null
  ref_number?: number | null
  resolved_at?: unknown
  resolution_note?: string | null
  [k: string]: unknown
}

/**
 * Event payload shape shared by created/reopened/escalated/repeated. The ref comes from the
 * row read in THIS delivery (after any numbering).
 */
function eventData(
  row: { id: string; ref_number?: unknown },
  alert: AlertEnvelope,
  severity: Severity,
  count: number,
) {
  return {
    id: row.id,
    source: alert.source,
    severity,
    title: alert.title,
    url: alert.url ?? null,
    dedupKey: alert.dedupKey ?? null,
    count,
    ...refFields(row.ref_number),
  }
}

/** Attention axis metadata (manifest `attention.filterableAxes`). */
function axes(alert: AlertEnvelope, severity: Severity): Record<string, unknown> {
  return { source: alert.source, severity }
}

async function findByDedupKey(ctx: AppContext, source: string, dedupKey: string): Promise<IncidentRow | null> {
  const rows = (await ctx.db.findMany("incidents", {
    where: { source, dedup_key: dedupKey },
    limit: 1,
  })) as IncidentRow[]
  return rows[0] ?? null
}

async function createIncident(ctx: AppContext, alert: AlertEnvelope): Promise<{ id: string }> {
  const now = new Date().toISOString()
  return ctx.db.insert("incidents", {
    source: alert.source,
    severity: alert.severity,
    title: alert.title,
    body: alert.body ?? null,
    dedup_key: alert.dedupKey ?? null,
    url: alert.url ?? null,
    status: "open",
    count: 1,
    first_seen_at: now,
    last_seen_at: now,
    alert_ts: alert.ts.toISOString(),
    // Cleared once incident:created went out (the event that pages): a run killed between this
    // insert and that emit leaves it set, and the redelivery that folds into the row pages then.
    created_pending: true,
  })
}

/**
 * Clear `created_pending` after incident:created went out. Best effort: the page is already
 * sent, so a failure here is logged and never fails the delivery (a later delivery folding into
 * the row would page once more, never zero times).
 */
async function markCreatedSent(ctx: AppContext, id: string): Promise<void> {
  try {
    await ctx.db.update("incidents", id, { created_pending: null })
  } catch (err) {
    ctx.logger.error("monitoring: could not clear created_pending", { incidentId: id, err: errSummary(err) })
  }
}

/**
 * Insert a fresh incident, number it (`CREATE_REF_BATCH`) and emit `incident:created`. When the
 * numbering, the re-read or the emit fails AFTER the insert, the row is deleted before
 * rethrowing: the handler's 503 commits, and a surviving row would make the sender's retry
 * fold as "repeated", so the feed would never hear `incident:created`. Refs given to older
 * rows stay; the new row's own ref is burned. A double failure (create path AND rollback) is
 * logged; that retry then folds and the feed item is lost, the narrowest possible loss window.
 */
async function createAndEmit(ctx: AppContext, alert: AlertEnvelope): Promise<{ id: string }> {
  const { id } = await createIncident(ctx, alert)
  try {
    await assignMissingRefs(ctx, { limit: CREATE_REF_BATCH })
    const created = (await ctx.db.findOne("incidents", id)) as IncidentRow | null
    await ctx.emit({
      entity: "incident",
      action: "created",
      entityId: id,
      data: eventData(created ?? { id }, alert, alert.severity, 1),
      metadata: axes(alert, alert.severity),
    })
  } catch (createErr) {
    try {
      await ctx.db.delete("incidents", id)
    } catch (rollbackErr) {
      ctx.logger.error("monitoring: created path failed AND rollback failed, feed item may be lost", {
        incidentId: id,
        createErr: errSummary(createErr),
        rollbackErr: errSummary(rollbackErr),
      })
    }
    throw createErr
  }
  await markCreatedSent(ctx, id)
  return { id }
}

/**
 * Archive the previous episode of a reopened incident as an `episode` entry, from values
 * copied out of the row BEFORE the reopen. Best effort: the reopen already landed, so a
 * failure is logged (summary only: the error text carries the row's params) and the delivery
 * continues (the bridge's insert runs in a savepoint, the transaction stays usable).
 */
async function archiveEpisode(ctx: AppContext, previous: IncidentRow): Promise<void> {
  try {
    await ctx.db.insert("incident_comments", {
      incident_id: previous.id,
      kind: "episode",
      body: previous.body ?? null,
      episode_title: previous.title,
      episode_resolved_at: previous.resolved_at ?? null,
      episode_resolution_note: previous.resolution_note ?? null,
      author_id: null,
    })
  } catch (err) {
    ctx.logger.error("monitoring: episode archive failed", { incidentId: previous.id, err: errSummary(err) })
  }
}

/** The lifecycle action a fold emits, and the row it folded into (its id and ref). */
interface FoldResult {
  action: "reopened" | "escalated" | "repeated"
  severity: Severity
  count: number
  row: IncidentRow
}

/** Fields every fold writes: the title always; a newer deep link or body wins, an absent or empty one keeps the old. */
function refreshPatch(alert: AlertEnvelope): Record<string, unknown> {
  return {
    title: alert.title,
    ...(alert.url ? { url: alert.url } : {}),
    ...(alert.body ? { body: alert.body } : {}),
  }
}

/**
 * Reopen a resolved incident: a compare-and-set on (source, dedup_key, status = resolved), with
 * no `where.id` (the bridge refuses it). Returns the result when this delivery won it (and
 * archived the previous episode), or null when a concurrent delivery reopened it first.
 */
async function tryReopen(
  ctx: AppContext,
  row: IncidentRow,
  alert: AlertEnvelope,
  dedupKey: string,
): Promise<FoldResult | null> {
  // The archive is built from this copy, never from a row read after the update.
  const previous = { ...row }
  const now = new Date().toISOString()
  const count = (row.count ?? 0) + 1
  const { count: matched } = await ctx.db.updateMany("incidents", {
    where: { source: row.source, dedup_key: dedupKey, status: "resolved" },
    data: {
      ...refreshPatch(alert),
      status: "open",
      // A fresh episode takes the delivery's severity verbatim.
      severity: alert.severity,
      count,
      last_seen_at: now,
      alert_ts: alert.ts.toISOString(),
      reopened_at: now,
      // A new episode gets fresh triage: clear the previous resolve/ack audit.
      acknowledged_at: null,
      acknowledged_by: null,
      resolved_at: null,
      resolved_by: null,
      resolution_note: null,
    },
  })
  if (matched !== 1) return null
  await archiveEpisode(ctx, previous)
  return { action: "reopened", severity: alert.severity, count, row }
}

/**
 * Fold a delivery into a live (open/acknowledged) incident: "escalated" when the severity went
 * up, else "repeated" (the no-attention path). Severity only ratchets UP on a live incident.
 */
async function foldLive(ctx: AppContext, row: IncidentRow, alert: AlertEnvelope): Promise<FoldResult> {
  const count = (row.count ?? 0) + 1
  const escalated = severityRank(alert.severity) > severityRank(row.severity)
  const severity = escalated ? alert.severity : row.severity
  await ctx.db.update("incidents", row.id, {
    ...refreshPatch(alert),
    severity,
    count,
    last_seen_at: new Date().toISOString(),
    alert_ts: alert.ts.toISOString(),
  })
  return { action: escalated ? "escalated" : "repeated", severity, count, row }
}

/**
 * Fold a repeat delivery into an existing incident. A resolved incident reopens; when a
 * concurrent delivery won the reopen first, the fresh row is re-read and folded into ONCE (a
 * live row takes the live path; a row resolved again whose compare-and-set is lost a second
 * time is `reopen_conflict`, and a vanished row `incident_not_found`: both answer 503 so the
 * sender retries). Only the winner of a reopen archives an episode.
 */
async function foldIntoExisting(
  ctx: AppContext,
  row: IncidentRow,
  alert: AlertEnvelope,
  dedupKey: string,
): Promise<FoldResult> {
  if (row.status !== "resolved") return foldLive(ctx, row, alert)
  const reopened = await tryReopen(ctx, row, alert, dedupKey)
  if (reopened) return reopened

  const fresh = await findByDedupKey(ctx, row.source, dedupKey)
  if (!fresh) throw new Error(`incident_not_found: ${row.id}`)
  if (fresh.status !== "resolved") return foldLive(ctx, fresh, alert)
  const again = await tryReopen(ctx, fresh, alert, dedupKey)
  if (again) return again
  throw new Error(`reopen_conflict: ${row.id}`)
}

function json(body: Record<string, unknown>): WebhookResult {
  return { status: 200, body: JSON.stringify(body) }
}

function timeMs(v: unknown): number {
  if (v == null) return Number.NaN
  return (v instanceof Date ? v : new Date(String(v))).getTime()
}

/**
 * Resolve the live incident for (source, dedupKey). Staleness compares the
 * resolve's signed `ts` with the latest alert's own `ts` (`alert_ts`, the same
 * sender clock), falling back to `last_seen_at` for rows without one. When the
 * emit fails the row is restored before rethrowing, so the sender's retry
 * (503) finds the incident still live and resolves it again; the restore is a
 * compare-and-set, so it never undoes a write that landed in between.
 */
async function resolveFromSource(ctx: AppContext, resolve: ResolveEnvelope): Promise<WebhookResult> {
  const row = await findByDedupKey(ctx, resolve.source, resolve.dedupKey)
  if (!row || row.status === "resolved") return json({ resolved: false })

  const latest = timeMs(row.alert_ts ?? row.last_seen_at)
  if (Number.isFinite(latest) && resolve.ts.getTime() < latest) return json({ resolved: false, stale: true })

  const note = `cleared by ${resolve.source} at ${resolve.ts.toISOString()}`
  const previous = {
    status: row.status,
    resolved_at: row.resolved_at ?? null,
    resolved_by: row.resolved_by ?? null,
    resolution_note: row.resolution_note ?? null,
  }
  await ctx.db.update("incidents", row.id, {
    status: "resolved",
    resolved_at: new Date().toISOString(),
    resolved_by: null,
    resolution_note: note,
  })
  try {
    await ctx.emit({
      entity: "incident",
      action: "resolved",
      entityId: row.id,
      // Same shape as the incidents_resolve tool (the manifest's resolveWhen
      // translations key on `status`), plus `auto` for a source-side clear.
      data: {
        id: row.id,
        status: "resolved",
        source: row.source,
        title: row.title,
        resolutionNote: note,
        auto: true,
        ...refFields(row.ref_number),
      },
      metadata: { source: row.source, severity: row.severity },
    })
  } catch (emitErr) {
    try {
      // Compare-and-set: ctx.db has no transaction, so a delivery folded between the resolve
      // and this restore (a re-fire reopening the incident, a user resolving it) must win.
      // Restore only while the row still carries exactly what this resolve wrote; the
      // (source, dedup_key) pair is unique, and the note embeds this resolve's own ts.
      await ctx.db.updateMany("incidents", {
        where: { source: row.source, dedup_key: resolve.dedupKey, status: "resolved", resolution_note: note },
        data: previous,
      })
    } catch (restoreErr) {
      ctx.logger.error("monitoring: resolved-emit failed AND restore failed", {
        incidentId: row.id,
        emitErr: errSummary(emitErr),
        restoreErr: errSummary(restoreErr),
      })
    }
    throw emitErr
  }
  return json({ resolved: true, id: row.id })
}

/**
 * `alert` webhook topic handler — `(payload, ctx, headers?)` per the manifest
 * webhook contract. The kernel has already verified the HMAC signature and
 * kernel-level replay key before this runs.
 */
export async function alertWebhookHandler(
  payload: unknown,
  ctx: AppContext,
  _headers?: Record<string, string | undefined>,
): Promise<WebhookResult> {
  const parsed = parseEnvelope(payload)
  if (parsed.kind === "invalid") {
    // Malformed input is the SENDER's bug — 400 (do not ask for a retry).
    return { status: 400, body: `invalid alert envelope: ${parsed.detail}` }
  }
  if (parsed.kind === "resolve") {
    try {
      return await resolveFromSource(ctx, parsed.resolve)
    } catch (err) {
      ctx.logger.error("monitoring resolve webhook failed", {
        source: parsed.resolve.source,
        dedupKey: parsed.resolve.dedupKey,
        err: errSummary(err),
      })
      return { status: 503, body: "resolve processing failed" }
    }
  }
  const alert = parsed.alert

  try {
    // No dedup identity → every delivery opens its own incident.
    if (!alert.dedupKey) {
      await createAndEmit(ctx, alert)
      return OK
    }

    let row = await findByDedupKey(ctx, alert.source, alert.dedupKey)
    // The row's incident:created has not gone out yet. Within the lease the run that inserted it
    // may still be sending it: answer 503 so this delivery is retried and folds once that run is
    // done. Past the lease that run was killed, and this delivery sends the page (below).
    let sendCreated = false
    if (row && row.created_pending === true && row.status !== "resolved") {
      const insertedAt = timeMs(row.first_seen_at)
      if (Number.isFinite(insertedAt) && Date.now() - insertedAt <= CREATED_LEASE_MS) {
        return { status: 503, body: "incident creation in progress" }
      }
      sendCreated = true
    }
    if (!row) {
      let insertErr: unknown = null
      try {
        await createAndEmit(ctx, alert)
        return OK
      } catch (err) {
        insertErr = err
      }
      // Unique-constraint race: another concurrent delivery inserted the
      // (source, dedup_key) row first → re-read and fold into it. (An
      // emit-failure inside createAndEmit rolled its own row back, so the
      // re-read finds nothing and we rethrow → 503 → the sender retries.)
      row = await findByDedupKey(ctx, alert.source, alert.dedupKey)
      if (!row) throw insertErr
    }

    const fold = await foldIntoExisting(ctx, row, alert, alert.dedupKey)
    // The row's own incident:created never went out (its run was killed after the insert): this
    // delivery sends it now instead of a repeat or escalation, so the incident still pages.
    if (sendCreated) {
      await assignMissingRefs(ctx, { limit: CREATE_REF_BATCH })
      const numbered = ((await ctx.db.findOne("incidents", fold.row.id)) as IncidentRow | null) ?? fold.row
      await ctx.emit({
        entity: "incident",
        action: "created",
        entityId: fold.row.id,
        data: eventData(numbered, alert, fold.severity, fold.count),
        metadata: axes(alert, fold.severity),
      })
      await markCreatedSent(ctx, fold.row.id)
      return OK
    }
    await ctx.emit({
      entity: "incident",
      action: fold.action,
      entityId: fold.row.id,
      data: eventData(fold.row, alert, fold.severity, fold.count),
      metadata: axes(alert, fold.severity),
    })
    // A reopen pages on its own event: a created that never went out is moot now.
    if (fold.action === "reopened" && row.created_pending === true) await markCreatedSent(ctx, fold.row.id)
    return OK
  } catch (err) {
    ctx.logger.error("monitoring alert webhook failed", {
      source: alert.source,
      dedupKey: alert.dedupKey,
      err: errSummary(err),
    })
    // 503 → the alert source's retry schedule re-delivers.
    return { status: 503, body: "alert processing failed" }
  }
}
