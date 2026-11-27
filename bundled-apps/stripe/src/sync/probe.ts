// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Is Stripe's webhook still reaching us? (`probe-webhook-upstream`, every 15 min.)
//
// EVIDENCE, NOT SILENCE. A quiet account sends nothing for days and is fine. So
// the probe asks the Events API for events newer than the last one we received.
// The connection is `stalled` only when there are such events AND none reached
// us for 2 hours (and the oldest missed one is more than 5 minutes old, so a
// delivery still in flight does not count). A quiet account with no newer event
// upstream is never stalled.
//
// CATCH-UP. While stalled, each probe plays the missed events, oldest first,
// through the same dispatch as a webhook (ledger, re-fetch, mirror, events), so
// the mirror and invoicing do not wait for the webhook to be fixed. A replayed
// event is not a delivery: it leaves the connection's last-event record and the
// `stalled` mark alone, so the state keeps saying the webhook is broken until a
// real delivery arrives.
//
// ONLY SUBSCRIBED TYPES. The account emits many event types the endpoint never
// selects (payment_intent.*, balance.*, payouts, ...): Stripe would never send
// those, so they are not missed. The probe asks only for `WEBHOOK_EVENTS`.
//
// The kernel reads the answer too (`webhookHealth`): the newest upstream event
// we have not received, `null` when there is none (nothing to miss), or
// `probed: false` when Stripe could not be asked. Never our own last-event time:
// that is when WE recorded the delivery, a moment after the kernel heard it, so
// every quiet half hour after a delivery would read as a missed delivery.
import type { UpstreamProbeResult } from "@liaison/app-sdk"
import { decodeState } from "../connection"
import { handleStripeEvent, type IngestCtx } from "../dispatch"
import { StripeApiError, stripeFetch } from "../http"
import { blockedOverlay, type Install, importInProgress, moveState, readInstall } from "../states"
import { WEBHOOK_EVENTS } from "../webhook-events"
import { Budget, DEFAULT_BUDGET_MS, type SyncCtx, type SyncOptions } from "./common"

type Obj = Record<string, unknown>

/** No delivery for this long, with newer events upstream: stalled. */
export const STALL_AFTER_MS = 2 * 60 * 60 * 1000
/** A missed event younger than this may still be on its way. */
export const IN_FLIGHT_MS = 5 * 60 * 1000
/** Missed events replayed per probe. */
const REPLAY_PER_RUN = 100
/** Stripe's limit on `types[]` values in one Events API list call. */
const TYPES_PER_CALL = 20

/** The subscribed event types, split to fit Stripe's `types[]` limit. */
export function eventTypeChunks(): string[][] {
  const chunks: string[][] = []
  for (let i = 0; i < WEBHOOK_EVENTS.length; i += TYPES_PER_CALL)
    chunks.push(WEBHOOK_EVENTS.slice(i, i + TYPES_PER_CALL))
  return chunks
}

function msOf(v: unknown): number {
  if (v instanceof Date) return v.getTime()
  return typeof v === "string" ? Date.parse(v) : Number.NaN
}

export interface ProbeOutcome extends Record<string, unknown> {
  stalled: boolean
  missed: number
  replayed: number
}

export async function runProbe(
  ctx: SyncCtx,
  opts: SyncOptions = {},
): Promise<UpstreamProbeResult & Partial<ProbeOutcome>> {
  const now = opts.now ?? (() => new Date())
  const install = await readInstall(ctx.db)
  if (!install || decodeState(install.state).base === "not_connected")
    return { upstreamActivityAt: null }
  if (blockedOverlay(install))
    return { probed: false, reason: `the connection reads ${String(install.state)}` }

  const lastMs = msOf(install.last_event_at)
  const sinceMs = Number.isFinite(lastMs) ? lastMs : msOf(install.connected_at)
  const listed: Obj[] = []
  try {
    for (const types of eventTypeChunks()) {
      const page = await stripeFetch<{ data?: Obj[] }>(ctx, "/v1/events", {
        params: {
          limit: REPLAY_PER_RUN,
          types,
          ...(Number.isFinite(sinceMs) ? { "created[gt]": Math.floor(sinceMs / 1000) } : {}),
        },
      })
      if (Array.isArray(page.data)) listed.push(...page.data)
    }
  } catch (err) {
    if (err instanceof StripeApiError && err.code === "key_invalid") {
      await moveState(ctx, install, [{ kind: "key_refused" }])
    }
    return {
      probed: false,
      reason: err instanceof Error ? err.message : "Stripe could not be asked",
    }
  }
  // Newest first, as Stripe lists them; merged across the type chunks.
  const missed = listed
    .filter((e) => typeof e.id === "string" && typeof e.created === "number")
    .sort((a, b) => (b.created as number) - (a.created as number))
    .slice(0, REPLAY_PER_RUN)
  if (missed.length === 0)
    return { upstreamActivityAt: null, stalled: false, missed: 0, replayed: 0 }
  const upstreamActivityAt = new Date((missed[0]?.created as number) * 1000).toISOString()

  const oldestMissedMs = (missed[missed.length - 1]?.created as number) * 1000
  const t = now().getTime()
  const silentFor = Number.isFinite(sinceMs) ? t - sinceMs : Number.POSITIVE_INFINITY
  const stalled = silentFor >= STALL_AFTER_MS && t - oldestMissedMs >= IN_FLIGHT_MS
  if (!stalled) return { upstreamActivityAt, stalled: false, missed: missed.length, replayed: 0 }

  if (decodeState(install.state).overlay !== "stalled")
    await moveState(ctx, install, [{ kind: "stalled" }])
  // During the first import the objects come from the import itself.
  if (await importInProgress(ctx.db))
    return { upstreamActivityAt, stalled: true, missed: missed.length, replayed: 0 }
  const budget = new Budget(now, opts.budgetMs ?? DEFAULT_BUDGET_MS)
  const replayed = await replayEvents(ctx, install, [...missed].reverse(), budget)
  return { upstreamActivityAt, stalled: true, missed: missed.length, replayed }
}

/**
 * Play events through the dispatch with the connection's delivery record left
 * alone: an update that records an event (`last_event_at`) is not written, and
 * the state change it would announce is not announced.
 */
export async function replayEvents(
  ctx: SyncCtx,
  _install: Install,
  events: Obj[],
  budget: Budget,
): Promise<number> {
  let skipNextStateChange = false
  const replayCtx: IngestCtx = {
    fetch: (url, o) => ctx.fetch(url, o),
    emit: async (e) => {
      if (e.entity === "connection" && e.action === "state_changed" && skipNextStateChange) {
        skipNextStateChange = false
        return
      }
      await ctx.emit(e)
    },
    db: {
      findMany: (e, o) => ctx.db.findMany(e, o),
      insert: (e, d) => ctx.db.insert(e, d),
      updateMany: (e, o) => ctx.db.updateMany(e, o),
      update: async (e, id, d) => {
        if (e === "install_metadata" && "last_event_at" in d) {
          skipNextStateChange = true
          return
        }
        skipNextStateChange = false
        await ctx.db.update(e, id, d)
      },
    },
  }
  let n = 0
  for (const event of events) {
    if (budget.spent) break
    await handleStripeEvent(event, replayCtx)
    n++
  }
  return n
}
