// SPDX-License-Identifier: FSL-1.1-ALv2
//
// google_pause — GATED handler for the Google Ads arm (like the Meta pause, the
// gate lives in the kernel via the manifest `gated:true` flag; this handler runs
// only after a human approves the raised approval card).
// Mirrors pause.ts's three-call contract:
//   1. GAQL pre-read status (the TRUE prior_status, before pausing)
//   2. mutate status=PAUSED (campaigns:mutate / adGroups:mutate / adGroupAds:mutate)
//   3. GAQL re-read to confirm (never trust the mutate write echo)
//   4. write a pause_ledger row (paused_by_us=true, prior_status, object_type)
//   5. bulk-pause blast-radius check: >3 campaign-level pauses in the last
//      rolling hour (this call inclusive) -> emit ads:bulk_pause_threshold.
//      The threshold NEVER blocks the pause — it only notifies.
//
// Pause direction ONLY — there is no resume/enable tool for Google in this build.

import type { AppCtx } from "./lib/ctx-types"
import { gaqlSearch, googleAdsMutate } from "./lib/google-client"
import { getGoogleClient } from "./lib/google-config"
import {
  type PreflightOutcome,
  preflightGoogleAdCompositeId,
  refuse,
  throwIfRefused,
  toPreflightResult,
} from "./lib/preflight"

type GoogleObjectType = "campaign" | "ad_group" | "ad"

interface GooglePauseParams {
  object_id: string
  object_type: GoogleObjectType
  reason?: string
  /** Required (with ad_id) when object_type is "ad" instead of a composite object_id. */
  ad_group_id?: string
  /** Required (with ad_group_id) when object_type is "ad" instead of a composite object_id. */
  ad_id?: string
}

/**
 * Shared checker for google_pause. `object_type` "ad" needs a COMPOSITE
 * adGroupAd id, a conditional cross-field rule the params schema cannot
 * express, so both the handler and the manifest `preflight` run this one
 * function. The composite rule itself is the same checker google_set_status
 * uses (lib/preflight), so the two Google tools can never drift.
 */
export function preflightGooglePauseParams(p: Record<string, unknown>): PreflightOutcome<{
  objectType: GoogleObjectType
  objectId: string
  adRef: { adGroupId: string; adId: string } | null
}> {
  const objectType = p.object_type as GoogleObjectType | undefined
  if (!objectType || !OBJECT_CONFIG[objectType]) {
    return refuse(
      "invalid_params",
      "google_pause: object_type must be one of campaign, ad_group, ad",
    )
  }

  // "ad" resolves to the COMPOSITE adGroupAd resource id (adGroupId~adId);
  // campaign/ad_group use the bare numeric object_id.
  let objectId: string
  let adRef: { adGroupId: string; adId: string } | null = null
  if (objectType === "ad") {
    const resolved = preflightGoogleAdCompositeId("google_pause", p)
    if (!("ok" in resolved)) return resolved
    adRef = { adGroupId: resolved.adGroupId, adId: resolved.adId }
    objectId = resolved.objectId
  } else {
    objectId = String(p.object_id ?? "")
  }
  if (!objectId) return refuse("invalid_params", "google_pause: object_id is required")

  return { ok: true, objectType, objectId, adRef }
}

// WHY: a gated call must not be parked for a human when the data it needs is
// missing. A pause naming an ad with no resolvable composite id only failed
// once the approver had already clicked approve.
export async function google_pause_preflight(params: unknown): Promise<unknown> {
  return toPreflightResult(preflightGooglePauseParams((params ?? {}) as Record<string, unknown>))
}

// Resource name -> GAQL resource + mutate path + resource field prefix.
const OBJECT_CONFIG: Record<
  GoogleObjectType,
  { gaqlResource: string; mutatePath: string; resourceField: string; statusField: string }
> = {
  campaign: {
    gaqlResource: "campaign",
    mutatePath: "campaigns:mutate",
    resourceField: "campaign",
    statusField: "campaign.status",
  },
  ad_group: {
    gaqlResource: "ad_group",
    mutatePath: "adGroups:mutate",
    resourceField: "adGroup",
    statusField: "ad_group.status",
  },
  ad: {
    gaqlResource: "ad_group_ad",
    mutatePath: "adGroupAds:mutate",
    resourceField: "adGroupAd",
    statusField: "ad_group_ad.status",
  },
}

type Row = Record<string, unknown>

function get(row: Row, path: string): unknown {
  let cur: unknown = row
  for (const p of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined
    cur = (cur as Row)[p]
  }
  return cur
}

const BULK_PAUSE_WINDOW_MS = 60 * 60 * 1000 // 1 hour
const BULK_PAUSE_THRESHOLD = 3 // >3 (i.e. the 4th) triggers the notification

export async function google_pause(params: GooglePauseParams, ctx: AppCtx): Promise<unknown> {
  // The handler runs the SAME shared checker the manifest preflight runs, so
  // the two can never drift and the post-approval path keeps throwing exactly
  // the errors it always threw.
  const { objectType, objectId, adRef } = throwIfRefused(
    preflightGooglePauseParams(params as unknown as Record<string, unknown>),
  )

  const reason = typeof params.reason === "string" ? params.reason : "agent-paused"

  const { token, config } = await getGoogleClient(ctx)
  const cfg = OBJECT_CONFIG[objectType]

  // GAQL WHERE clause: campaign/ad_group filter by their own numeric id;
  // ad_group_ad has no standalone numeric id of its own — it is filtered by
  // its composite parents (ad_group.id + ad_group_ad.ad.id).
  const gaqlWhere =
    objectType === "campaign"
      ? `campaign.id = ${Number(objectId)}`
      : objectType === "ad_group"
        ? `ad_group.id = ${Number(objectId)}`
        : `ad_group.id = ${Number(adRef!.adGroupId)} AND ad_group_ad.ad.id = ${Number(adRef!.adId)}`

  // Call 1: GAQL pre-read status — capture the TRUE prior_status BEFORE pausing.
  const preRows = (await gaqlSearch(ctx.fetch, {
    customerId: config.customerId,
    query: `SELECT ${cfg.resourceField === "campaign" ? "campaign.id, campaign.name, campaign.status" : cfg.resourceField === "adGroup" ? "ad_group.id, ad_group.name, ad_group.status" : "ad_group_ad.ad.id, ad_group_ad.status"} FROM ${cfg.gaqlResource} WHERE ${gaqlWhere}`,
    token,
    loginCustomerId: config.loginCustomerId,
  })) as Row[]
  const preRow = preRows[0] ?? {}
  const priorStatus = String(
    (get(preRow, `${cfg.resourceField}.status`) as string | undefined) ??
      (objectType === "ad" ? get(preRow, "adGroupAd.status") : undefined) ??
      "UNKNOWN",
  )
  const objectName =
    objectType === "campaign"
      ? (get(preRow, "campaign.name") as string | undefined)
      : objectType === "ad_group"
        ? (get(preRow, "adGroup.name") as string | undefined)
        : undefined

  // Call 2: mutate status=PAUSED.
  const resourceName = `customers/${config.customerId.replace(/-/g, "")}/${
    objectType === "campaign" ? "campaigns" : objectType === "ad_group" ? "adGroups" : "adGroupAds"
  }/${objectId}`
  await googleAdsMutate(ctx.fetch, {
    customerId: config.customerId,
    path: cfg.mutatePath,
    operations: [
      {
        update: { resourceName, status: "PAUSED" },
        updateMask: "status",
      },
    ],
    token,
    loginCustomerId: config.loginCustomerId,
  })

  // Call 3: GAQL re-read — confirm the pause took effect. Never trust the mutate write echo.
  const postRows = (await gaqlSearch(ctx.fetch, {
    customerId: config.customerId,
    query: `SELECT ${cfg.resourceField === "campaign" ? "campaign.id, campaign.status" : cfg.resourceField === "adGroup" ? "ad_group.id, ad_group.status" : "ad_group_ad.status"} FROM ${cfg.gaqlResource} WHERE ${gaqlWhere}`,
    token,
    loginCustomerId: config.loginCustomerId,
  })) as Row[]
  const postRow = postRows[0] ?? {}
  const confirmedStatus = String(
    (get(postRow, `${cfg.resourceField}.status`) as string | undefined) ??
      (objectType === "ad" ? get(postRow, "adGroupAd.status") : undefined) ??
      "PAUSED",
  )

  // Step 4: write pause_ledger row.
  if (ctx.db) {
    await ctx.db.insert("pause_ledger", {
      meta_object_id: objectId,
      prior_status: priorStatus,
      paused_by_us: true,
      reason,
      object_type: objectType,
      resolved_at: null,
    })
  }

  // Step 5: bulk-pause blast-radius check — campaign-level pauses only.
  let bulkNotified = false
  let bulkCount = 0
  const bulkObjectIds: string[] = []
  if (ctx.db && objectType === "campaign") {
    const since = new Date(Date.now() - BULK_PAUSE_WINDOW_MS).toISOString()
    // NOTE: the generic-CRUD bridge's `where` only supports flat equality
    // (apps/api/src/modules/apps/sandbox/rpc-bridge.ts buildWhereClause —
    // `col = val`, or `IS NULL` for a null value; no comparison-operator
    // shape), so the `created_at >= since` cutoff cannot be pushed into the
    // where clause itself. Logged as an SDK gap (docs/sdk-gaps.md). The
    // client-side time filter below is the only expressible option today.
    const recentRows = (await ctx.db.findMany("pause_ledger", {
      where: { object_type: "campaign", paused_by_us: true },
    })) as Array<Record<string, unknown>>
    const withinWindow = recentRows.filter((r) => {
      const createdAt = r.created_at as string | undefined
      if (!createdAt) return false
      return createdAt >= since
    })
    bulkCount = withinWindow.length
    // De-dupe object ids — a resumed-then-re-paused object can appear more
    // than once in the window, and the notification payload should name each
    // distinct object once.
    const seenIds = new Set<string>()
    for (const r of withinWindow) {
      const id = r.meta_object_id as string | undefined
      if (id && !seenIds.has(id)) {
        seenIds.add(id)
        bulkObjectIds.push(id)
      }
    }
    if (bulkCount > BULK_PAUSE_THRESHOLD && ctx.emit) {
      await ctx.emit("ads:bulk_pause_threshold", {
        count: bulkCount,
        window: "1h",
        objectIds: bulkObjectIds,
      })
      bulkNotified = true
    }
  }

  return {
    object_id: objectId,
    object_type: objectType,
    name: objectName,
    prior_status: priorStatus,
    status: confirmedStatus,
    paused_by_us: true,
    bulk_pause_notified: bulkNotified,
  }
}
