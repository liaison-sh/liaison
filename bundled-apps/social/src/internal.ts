// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Internal mutations (§4.4). Ungated and with NO external side-effect — the
// agent triages autonomously. set_triage writes the verdict and advances the
// finding status ONLY from new/triaged; it never downgrades a handled,
// awaiting_approval, or drafted finding (the §8 skip-handled invariant at the
// tool level — a coalesced event-triage burst could otherwise re-process a
// finding a human already handled). correct_triage is the deliberate after-the-
// fact override (§4.5) with no status guard. watch_object backfill-links the
// existing findings on the same parent (§8).

import type { DbBatchOp } from "@liaison/app-sdk"
import type { Platform } from "./adapters/types"
import type { SocialToolCtx } from "./ctx"

interface FindingRow {
  id: string
  status: string
}

/** Statuses past triage in the machine new → triaged → drafted → awaiting_approval → handled. */
const PAST_TRIAGE = new Set(["drafted", "awaiting_approval", "handled", "dismissed"])

export async function setTriage(
  ctx: SocialToolCtx,
  params: {
    finding_id: string
    triage_category: string
    urgency: number
    should_reply: boolean
    triage_reason?: string
  },
): Promise<{ status: "triaged" | "skipped"; reason?: string }> {
  const [finding] = (await ctx.db.findMany("finding", {
    where: { id: params.finding_id },
    limit: 1,
  })) as FindingRow[]
  if (!finding) return { status: "skipped", reason: "not_found" }
  // Skip-handled: never downgrade a finding already past triage.
  if (PAST_TRIAGE.has(finding.status)) {
    const reason =
      finding.status === "handled" || finding.status === "dismissed"
        ? "already_handled"
        : "in_progress"
    // Still record the verdict fields (they are non-destructive) but DO NOT move status.
    await ctx.db.update("finding", finding.id, {
      triage_category: params.triage_category,
      urgency: params.urgency,
      should_reply: params.should_reply,
      triage_reason: params.triage_reason ?? null,
    })
    return { status: "skipped", reason }
  }
  await ctx.db.update("finding", finding.id, {
    triage_category: params.triage_category,
    urgency: params.urgency,
    should_reply: params.should_reply,
    triage_reason: params.triage_reason ?? null,
    status: "triaged",
  })
  return { status: "triaged" }
}

/**
 * Deliberate human re-triage (§4.5). Overwrites the triage fields regardless of
 * the finding's lifecycle status and does NOT move the status — it is an
 * after-the-fact correction, not a re-entry into the machine.
 */
export async function correctTriage(
  ctx: SocialToolCtx,
  params: {
    finding_id: string
    triage_category: string
    urgency: number
    should_reply: boolean
    triage_reason?: string
  },
): Promise<{ status: "corrected"; reason?: string }> {
  const [finding] = (await ctx.db.findMany("finding", {
    where: { id: params.finding_id },
    limit: 1,
  })) as FindingRow[]
  if (!finding) return { status: "corrected", reason: "not_found" }
  await ctx.db.update("finding", finding.id, {
    triage_category: params.triage_category,
    urgency: params.urgency,
    should_reply: params.should_reply,
    triage_reason: params.triage_reason ?? null,
  })
  return { status: "corrected" }
}

export async function dismissFinding(
  ctx: SocialToolCtx,
  params: { finding_id: string },
): Promise<{ status: "dismissed" | "skipped"; reason?: string }> {
  const [finding] = (await ctx.db.findMany("finding", {
    where: { id: params.finding_id },
    limit: 1,
  })) as FindingRow[]
  if (!finding) return { status: "skipped", reason: "not_found" }
  await ctx.db.update("finding", finding.id, { status: "dismissed" })
  return { status: "dismissed" }
}

interface WatchedRow {
  id: string
}

/** Default object_type per platform (§4.6). */
const DEFAULT_OBJECT_TYPE: Record<Platform, string> = {
  youtube: "youtube_video",
  instagram: "instagram_media",
  facebook: "facebook_post",
}

/**
 * Promote an object to a watched_object (idempotent on [platform, external_id])
 * and backfill-LINK the findings already discovered on that parent — writing
 * each sibling's `watched_object_id` so the watch surface immediately reflects
 * the existing thread and §12 Surface-3 can stream "that object's findings"
 * (§8). Re-watching resumes a stopped/decayed watch. `title`, when supplied
 * (e.g. auto-watch promotion passing the triggering finding's video title),
 * is set on FIRST watch only — an already-watched object's title is not
 * overwritten by a re-watch call.
 */
export async function watchObject(
  ctx: SocialToolCtx,
  params: {
    platform: Platform
    external_id: string
    object_type?: string
    reason?: "auto_hot" | "auto_own" | "manual"
    priority?: number
    title?: string | null
    permalink?: string | null
    metadata?: Record<string, unknown>
    cadence_seconds?: number
  },
): Promise<{ status: "watching"; backfilled: number }> {
  const existing = (await ctx.db.findMany("watched_object", {
    where: { platform: params.platform, external_id: params.external_id },
    limit: 1,
  })) as WatchedRow[]
  const siblings = (await ctx.db.findMany("finding", {
    where: { platform: params.platform, parent_external_id: params.external_id },
  })) as Array<{ id: string; watched_object_id?: string | null }>
  // The watch and its backfilled links commit together (no transaction is held across the run):
  // a failed call never leaves a watch whose existing findings are half linked.
  const watchedId = existing[0]?.id
  const watchedRef: string | { $ref: string } = watchedId ?? { $ref: "watched" }
  const ops: DbBatchOp[] = watchedId
    ? // Re-watching resumes a stopped/decayed watch.
      [
        {
          update: "watched_object",
          id: watchedId,
          data: { status: "active", new_findings_count: siblings.length },
        },
      ]
    : [
        {
          insert: "watched_object",
          as: "watched",
          data: {
            platform: params.platform,
            external_id: params.external_id,
            object_type: params.object_type ?? DEFAULT_OBJECT_TYPE[params.platform],
            reason: params.reason ?? "manual",
            status: "active",
            priority: params.priority ?? 50,
            title: params.title ?? null,
            ...(params.permalink ? { permalink: params.permalink } : {}),
            ...(params.metadata ? { metadata: params.metadata } : {}),
            ...(params.cadence_seconds !== undefined
              ? { cadence_seconds: params.cadence_seconds }
              : {}),
            // Keep the watch's new_findings_count in sync with its linked findings (§4.6).
            new_findings_count: siblings.length,
          },
        },
      ]
  // Backfill-link the existing sibling findings to this watched object.
  let backfilled = 0
  for (const s of siblings) {
    if (watchedId && s.watched_object_id === watchedId) continue
    ops.push({ update: "finding", id: s.id, data: { watched_object_id: watchedRef } })
    backfilled += 1
  }
  await ctx.db.batch({ ops })
  return { status: "watching", backfilled }
}

export async function unwatchObject(
  ctx: SocialToolCtx,
  params: { platform: Platform; external_id: string },
): Promise<{ status: "stopped" | "skipped"; reason?: string }> {
  const [row] = (await ctx.db.findMany("watched_object", {
    where: { platform: params.platform, external_id: params.external_id },
    limit: 1,
  })) as WatchedRow[]
  if (!row) return { status: "skipped", reason: "not_found" }
  await ctx.db.update("watched_object", row.id, { status: "stopped" })
  return { status: "stopped" }
}

interface MonitorTermRow {
  id: string
  kind: string
  value: string
  platform: Platform | null
  enabled: boolean
  notes?: string | null
}

/**
 * Add (or re-enable) a brand monitor term. Upserts on the [platform, kind,
 * value] unique key — re-adding a previously-disabled term flips it back to
 * enabled rather than erroring, matching watch_object's re-watch-resumes
 * idempotency (§7-analog). `platform` defaults to `null` (all platforms).
 */
export async function addMonitorTerm(
  ctx: SocialToolCtx,
  params: {
    value: string
    kind?: "keyword" | "handle" | "hashtag"
    platform?: Platform
    notes?: string
  },
): Promise<{ status: "created" | "enabled" | "unchanged"; term: MonitorTermRow }> {
  const kind = params.kind ?? "keyword"
  const platform = params.platform ?? null
  const existing = (await ctx.db.findMany("monitor_term", {
    where: { platform, kind, value: params.value },
    limit: 1,
  })) as MonitorTermRow[]
  if (existing[0]) {
    if (existing[0].enabled) {
      return { status: "unchanged", term: existing[0] }
    }
    await ctx.db.update("monitor_term", existing[0].id, {
      enabled: true,
      notes: params.notes ?? existing[0].notes ?? null,
    })
    const [row] = (await ctx.db.findMany("monitor_term", {
      where: { id: existing[0].id },
      limit: 1,
    })) as MonitorTermRow[]
    return { status: "enabled", term: row ?? { ...existing[0], enabled: true } }
  }
  const inserted = await ctx.db.insert("monitor_term", {
    kind,
    value: params.value,
    platform,
    enabled: true,
    notes: params.notes ?? null,
  })
  return { status: "created", term: inserted as unknown as MonitorTermRow }
}

/**
 * Remove a monitor term, identified either by `id` or by its
 * [platform, kind, value] key. Hard-delete (mirrors the app's other terms/
 * watch write tools — there's no soft-disable surface for terms besides the
 * `enabled` flag toggled internally by add).
 */
export async function removeMonitorTerm(
  ctx: SocialToolCtx,
  params: { id?: string; value?: string; kind?: string; platform?: Platform },
): Promise<{ status: "removed" | "skipped"; reason?: string }> {
  let row: MonitorTermRow | undefined
  if (params.id) {
    const [byId] = (await ctx.db.findMany("monitor_term", {
      where: { id: params.id },
      limit: 1,
    })) as MonitorTermRow[]
    row = byId
  } else if (params.value) {
    const [byKey] = (await ctx.db.findMany("monitor_term", {
      where: {
        value: params.value,
        kind: params.kind ?? "keyword",
        platform: params.platform ?? null,
      },
      limit: 1,
    })) as MonitorTermRow[]
    row = byKey
  }
  if (!row) return { status: "skipped", reason: "not_found" }
  await ctx.db.delete("monitor_term", row.id)
  return { status: "removed" }
}
