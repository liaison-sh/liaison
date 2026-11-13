// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Meta pause handler for the ads app.
//
// `pause` — GATED like every other spend-affecting write (the gate lives in the
//   kernel, keyed off the manifest `gated:true` flag; this handler runs only
//   AFTER a human approves the raised approval card). Pauses one or more objects,
//   re-reads effective_status to confirm, and writes a pause_ledger row.
//
// Uses (params, ctx) — the kernel convention.

import type { AppCtx } from "./lib/ctx-types"
import { getMetaClient } from "./lib/get-client"
import { metaFetch } from "./lib/meta-client"
import { type PreflightOutcome, refuse, throwIfRefused, toPreflightResult } from "./lib/preflight"

// ─── pause (gated) ────────────────────────────────────────────────────────────

interface PauseResult {
  object_id: string
  name: string | undefined
  prior_status: string | undefined
  effective_status: string | undefined
  paused_by_us: boolean
}

/**
 * Pauses one or more Meta objects (campaigns, adsets, ads).
 * GATED — pausing stops delivery, so like every other spend-affecting write it
 * raises an approval card; this handler executes only after the human approves.
 *
 * Contract (pinned by tests) — three calls per object, in this order:
 *   - calls[0]: GET pre-pause status   → captures the TRUE prior_status (e.g. ACTIVE)
 *   - calls[1]: POST status=PAUSED     → the pause write
 *   - calls[2]: GET effective_status   → confirms delivery state (never trust write echo)
 *
 * The pre-pause GET is load-bearing: prior_status MUST be read BEFORE the pause,
 * otherwise the ledger records the post-pause status (PAUSED) instead of the
 * true prior delivery state.
 */
/**
 * Shared checker for pause. The target is a one-of (object_id OR object_ids[]),
 * a cross-field rule the params schema cannot express, so both the handler and
 * the manifest `preflight` run this one function.
 */
export function preflightPauseParams(
  p: Record<string, unknown>,
): PreflightOutcome<{ ids: string[] }> {
  // Support single object_id OR bulk object_ids[]
  const ids: string[] = []
  if (typeof p.object_id === "string" && p.object_id) {
    ids.push(p.object_id)
  }
  if (Array.isArray(p.object_ids)) {
    for (const id of p.object_ids) {
      if (typeof id === "string" && id && !ids.includes(id)) ids.push(id)
    }
  }
  if (ids.length === 0) {
    return refuse("invalid_params", "pause: provide object_id or object_ids[]")
  }
  return { ok: true, ids }
}

// WHY: a gated call must not be parked for a human when the data it needs is
// missing. A pause naming nothing to pause used to sit on the approval queue
// and then fail the moment someone approved it.
export async function pause_preflight(params: unknown): Promise<unknown> {
  return toPreflightResult(preflightPauseParams((params ?? {}) as Record<string, unknown>))
}

export async function pause(params: unknown, ctx: AppCtx): Promise<unknown> {
  const p = params as Record<string, unknown>
  const { ids } = throwIfRefused(preflightPauseParams(p))

  const { auth } = await getMetaClient(ctx)

  const reason = typeof p.reason === "string" ? p.reason : "agent-paused"

  const results: PauseResult[] = []

  for (const objectId of ids) {
    // Call 1: GET pre-pause status — capture the TRUE prior_status BEFORE pausing.
    // Also read `name` so the result is self-documenting: the agent's reply should
    // enumerate each paused object BY NAME (a vague "all paused" fails the rubric).
    const before = (await metaFetch(ctx.fetch, {
      path: `/${objectId}`,
      method: "GET",
      params: { fields: "id,name,status,effective_status" },
      auth,
    })) as { id?: string; name?: string; status?: string; effective_status?: string }
    const priorStatus = before.status
    const objectName = before.name

    // Call 2: POST status=PAUSED
    await metaFetch(ctx.fetch, {
      path: `/${objectId}`,
      method: "POST",
      params: { status: "PAUSED" },
      auth,
    })

    // Call 3: GET re-read — confirm effective_status; do NOT trust the write echo.
    const after = (await metaFetch(ctx.fetch, {
      path: `/${objectId}`,
      method: "GET",
      params: { fields: "id,status,effective_status" },
      auth,
    })) as { id?: string; status?: string; effective_status?: string }

    const effectiveStatus = after.effective_status

    // Write pause_ledger row if db is available
    if (ctx.db) {
      await ctx.db.insert("pause_ledger", {
        meta_object_id: objectId,
        prior_status: priorStatus ?? "UNKNOWN",
        paused_by_us: true,
        reason,
        // created_at is auto-injected by the app DDL (TIMESTAMPTZ DEFAULT NOW())
        // and is NOT a manifest-declared field, so ctx.db.insert rejects it as
        // "Unknown field". Let the DB default it.
        resolved_at: null,
      })
    }

    results.push({
      object_id: objectId,
      name: objectName,
      prior_status: priorStatus,
      effective_status: effectiveStatus,
      paused_by_us: true,
    })
  }

  // Self-documenting reporting hint — the effective_status here is the VERIFIED
  // post-write re-read (call 3), NOT an untrustworthy write echo, so the agent
  // should cite it directly (no separate campaigns_list needed) and enumerate
  // each paused object BY NAME. A vague "all paused" reply fails the bulk-pause
  // reporting rubric.
  const enumerated = results
    .map((r) => `${r.name ?? r.object_id} (${r.object_id}) → ${r.effective_status ?? "PAUSED"}`)
    .join("; ")
  const reportingHint =
    `Paused ${results.length} object(s): ${enumerated}. ` +
    "Report these to the user BY NAME and cite each confirmed effective_status above " +
    "(it is the verified post-write re-read, so no separate re-list is needed). " +
    "Name separately any object you did NOT pause because it was already paused."

  if (ids.length === 1) {
    return { ...results[0], reportingHint }
  }
  return { paused: results, count: results.length, reportingHint }
}
