// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Webhook upstream probe: tells the kernel when Boxtal last saw a parcel move.
//
// The kernel pages "webhook-ingest" when an app's webhooks go silent, but a
// silence window alone cannot tell a quiet week (no parcel moved) from a dead
// subscription. This job gives it the missing evidence: the newest tracking
// status change Boxtal reports, read LIVE from Boxtal for our recent shipments.
// The kernel pages only when that change is newer than our last accepted
// delivery by more than its grace.
//
// What counts as activity: a tracking STATUS CHANGE (an event whose status
// differs from the one before it), because that is what the TRACKING_CHANGED
// subscription delivers. Repeated checkpoints under the same status may or may
// not produce a delivery, so they are left out. DOCUMENT_CREATED is left out
// too: Boxtal's shipping-document read carries no timestamp.
//
// Boxtal has no endpoint that lists an account's shipping orders, so the
// shipments to ask about come from our own index (their ids only); every
// timestamp comes from Boxtal's tracking read. Bounded: the in-flight fleet plus
// the most recently created shipments, newest first, at most PROBE_LIMIT reads.
//
// Contract: `{ upstreamActivityAt: ISO }` when a status change was found,
// `{ upstreamActivityAt: null }` when there is no live sender (Boxtal not
// connected, no shipment to track, or no status change reported yet), and
// `{ probed: false, reason }` when Boxtal could not be read, so the kernel never
// reads an unreachable Boxtal as a quiet one.

import type { UpstreamProbeResult } from "@liaison/app-sdk"
import type { BoxtalToolCtx } from "./ctx"
import type { NormalizedTracking } from "./lib/boxtal-v3-client"
import { BoxtalApiError } from "./lib/boxtal-v3-client"
import { getClientOrError, hasBoxtalConnection } from "./lib/get-client"
import { findShipmentsInAny } from "./queues"
import { isBoxtalNotReady } from "./reads"

export type { UpstreamProbeResult }

/** Boxtal tracking reads per run. */
export const PROBE_LIMIT = 15
/** Recently created shipments always probed, terminal or not, so a parcel the
 *  reconcile job already marked DELIVERED still shows its last change. */
const RECENT_LIMIT = 10
/** Accepted clock skew before an event counts as "in the future" and is ignored. */
const FUTURE_SKEW_MS = 5 * 60 * 1000
/**
 * Boxtal returns carrier checkpoint times WITHOUT a zone ("2026-07-24 17:03:00"),
 * in the carrier's local time. Read as UTC, such a time can be up to 14 hours
 * later than the real instant (UTC+14), which would make the kernel page on a
 * delivery that has not happened yet. Shifting it back by the widest offset
 * keeps the report a lower bound: a dead pipe is still caught, a few hours late.
 */
const NAIVE_TIME_SHIFT_MS = 14 * 60 * 60 * 1000

const LIVE_ORDER_STATUSES = ["PENDING", "REQUESTED", "CONFIRMED"]
/** Tracking states still moving: the same in-flight set reconcile-tracking polls. */
const NON_TERMINAL_TRACKING = [
  "",
  "ANNOUNCED",
  "SHIPPED",
  "IN_TRANSIT",
  "OUT_FOR_DELIVERY",
  "FAILED_ATTEMPT",
  "REACHED_DELIVERY_PICKUP_POINT",
  "EXCEPTION",
  "INCIDENT",
]

interface ProbeRow {
  id: string | number
  boxtal_order_id?: string | null
  order_status?: string | null
  tracking_status?: string | null
  created_at?: string | null
}

/** An event time as epoch ms, made a lower bound when it carries no zone. */
export function eventInstantMs(at: string | null | undefined): number | null {
  if (typeof at !== "string" || at.trim() === "") return null
  const s = at.trim()
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(s)
  if (hasZone) {
    const ms = Date.parse(s)
    return Number.isFinite(ms) ? ms : null
  }
  const ms = Date.parse(`${s.replace(" ", "T")}Z`)
  return Number.isFinite(ms) ? ms - NAIVE_TIME_SHIFT_MS : null
}

/** Newest status change in one parcel's history (any order), or null. */
export function newestStatusChangeMs(tracking: NormalizedTracking, nowMs: number): number | null {
  const timed = tracking.events
    .map((e) => ({ status: e.status, ms: eventInstantMs(e.at) }))
    .filter(
      (e): e is { status: NormalizedTracking["events"][number]["status"]; ms: number } =>
        e.ms !== null,
    )
    .sort((a, b) => a.ms - b.ms)
  let newest: number | null = null
  let prev: string | null = null
  for (const e of timed) {
    if (e.status !== prev && e.ms <= nowMs + FUTURE_SKEW_MS) newest = e.ms
    prev = e.status
  }
  return newest
}

function isProbeable(row: ProbeRow): boolean {
  return (
    typeof row.boxtal_order_id === "string" &&
    row.boxtal_order_id.length > 0 &&
    row.order_status !== "CANCELLED"
  )
}

/** A 401/403 from Boxtal, in-process or flattened to its message across the worker IPC. */
function isAuthRefused(err: unknown): boolean {
  const status = err instanceof BoxtalApiError ? err.status : undefined
  const message = err instanceof Error ? err.message : String(err)
  return status === 401 || status === 403 || /\((?:401|403)\)|\b401 after refresh\b/.test(message)
}

function createdMs(row: ProbeRow): number {
  const ms = Date.parse(String(row.created_at ?? ""))
  return Number.isFinite(ms) ? ms : 0
}

export async function probeWebhookUpstream(
  ctx: BoxtalToolCtx,
  opts: { limit?: number; now?: () => number } = {},
): Promise<UpstreamProbeResult> {
  const limit = opts.limit ?? PROBE_LIMIT
  const nowMs = (opts.now ?? (() => Date.now()))()

  let client: Awaited<ReturnType<typeof getClientOrError>>
  try {
    client = await getClientOrError(ctx)
  } catch (err) {
    return { probed: false, reason: `no client: ${String(err)}` }
  }
  if ("error" in client) {
    // Null only when Boxtal is genuinely not connected. A connection row whose
    // credentials cannot be read is a sender we could not look at.
    let present: boolean | null
    try {
      present = await hasBoxtalConnection(ctx)
    } catch (err) {
      return { probed: false, reason: `connection state unreadable: ${String(err)}` }
    }
    if (present)
      return { probed: false, reason: `Boxtal credentials unusable: ${client.error.message}` }
    return { upstreamActivityAt: null }
  }

  let rows: ProbeRow[]
  try {
    const [inFlight, recent] = await Promise.all([
      findShipmentsInAny(ctx, [
        { order_status: { in: LIVE_ORDER_STATUSES }, tracking_status: null },
        {
          order_status: { in: LIVE_ORDER_STATUSES },
          tracking_status: { in: NON_TERMINAL_TRACKING },
        },
      ]),
      ctx.db.findMany("shipment", {
        orderBy: { createdAt: "desc", id: "desc" },
        limit: RECENT_LIMIT,
      }),
    ])
    const seen = new Set<string>()
    rows = []
    for (const r of [...(recent as ProbeRow[]), ...(inFlight as ProbeRow[])]) {
      if (seen.has(String(r.id))) continue
      seen.add(String(r.id))
      rows.push(r)
    }
  } catch (err) {
    return { probed: false, reason: `shipment index unreadable: ${String(err)}` }
  }

  const batch = rows
    .filter(isProbeable)
    .sort((a, b) => createdMs(b) - createdMs(a))
    .slice(0, limit)
  if (batch.length === 0) return { upstreamActivityAt: null }

  let newest: number | null = null
  let failures = 0
  let lastError = ""
  for (const row of batch) {
    try {
      const tracking = await client.v3.getTracking(String(row.boxtal_order_id))
      const ms = newestStatusChangeMs(tracking, nowMs)
      if (ms !== null && (newest === null || ms > newest)) newest = ms
    } catch (err) {
      // No carrier tracking yet is a parcel with nothing to report, not a failed read.
      if (isBoxtalNotReady(err, "tracking")) continue
      // Refused credentials fail every read the same way: stop and say we could not look.
      if (isAuthRefused(err))
        return { probed: false, reason: `Boxtal refused the credentials: ${String(err)}` }
      failures++
      lastError = String(err)
    }
  }

  if (newest !== null) return { upstreamActivityAt: new Date(newest).toISOString() }
  // Nothing found, but some reads failed: we could not look, so we cannot claim quiet.
  if (failures > 0) {
    ctx.logger?.warn?.("boxtal probe-webhook-upstream: tracking reads failed", {
      failures,
      lastError,
    })
    return {
      probed: false,
      reason: `${failures} of ${batch.length} tracking reads failed: ${lastError}`,
    }
  }
  return { upstreamActivityAt: null }
}

/** Kernel-shaped `(payload, ctx)` wrapper the manifest `jobs` entry names. */
export const probeWebhookUpstreamJob = (
  _payload: Record<string, unknown> | undefined,
  ctx: BoxtalToolCtx,
): Promise<UpstreamProbeResult> => probeWebhookUpstream(ctx)
