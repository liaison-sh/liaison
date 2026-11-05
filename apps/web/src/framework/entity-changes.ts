// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Client invalidation hook. Views that load once (onMount fetch, module store
// filled on first open) subscribe here to hear about the entities they show
// and refetch or patch in place. Zero domain imports, like app-registry.ts.
//
// - `dispatchWsEventMessage` calls `notifyEntityChange` for every WS event,
//   after the registered entity handlers ran.
// - A resync (WS `sync` frame, reconnect, resume) delivers one synthetic
//   `{ key: "*", action: "resync", resync: true }` batch to every live
//   subscription, so whatever was missed while disconnected self-heals.
//
// Callbacks receive the BATCH of events of a debounce window: refetch-style
// consumers keep the default debounce (one refetch per burst), patch-style
// consumers pass `debounceMs: 0` and get each event alone.
import { getOwner, onCleanup } from "solid-js"
import { log } from "~/lib/logger"
import { subscribeResync } from "./resync"

export interface EntityChangeEvent {
  /** `<app>:<entity>`; kernel entities use `kernel:<entity>`; `*` on resync. */
  key: string
  app: string
  entity: string
  action: string
  data: unknown
  actorId?: string | null
  /** True only on the synthetic resync event. */
  resync?: boolean
}

export interface EntityChangeOptions {
  /** Quiet period before a batch is delivered. Default 150 ms; 0 = each event alone. */
  debounceMs?: number
  /** A continuous stream still delivers at least this often. Default 1 s; never
   *  below the debounce. Count surfaces pass a wider pair (e.g. 1.5 s / 4 s). */
  maxWaitMs?: number
}

export const DEFAULT_ENTITY_CHANGE_DEBOUNCE_MS = 150
/** Default max-wait: a continuous stream still delivers at least this often. */
export const ENTITY_CHANGE_MAX_WAIT_MS = 1_000

interface Subscription {
  patterns: string[]
  cb: (events: EntityChangeEvent[]) => void
  debounceMs: number
  maxWaitMs: number
  pending: EntityChangeEvent[]
  quietTimer: ReturnType<typeof setTimeout> | null
  maxTimer: ReturnType<typeof setTimeout> | null
}

const subscriptions = new Set<Subscription>()

/** `app:entity` exact, `app:*` any entity of the app, `*` everything. */
export function entityKeyMatches(pattern: string, key: string): boolean {
  if (pattern === "*" || pattern === key) return true
  if (pattern.endsWith(":*")) return key.startsWith(pattern.slice(0, -1))
  return false
}

function clearTimers(sub: Subscription): void {
  if (sub.quietTimer !== null) clearTimeout(sub.quietTimer)
  if (sub.maxTimer !== null) clearTimeout(sub.maxTimer)
  sub.quietTimer = null
  sub.maxTimer = null
}

function deliver(sub: Subscription, events: EntityChangeEvent[]): void {
  if (!subscriptions.has(sub) || events.length === 0) return
  try {
    sub.cb(events)
  } catch (err) {
    log.error({ err, keys: sub.patterns }, "entity-change subscriber threw")
  }
}

function flush(sub: Subscription): void {
  clearTimers(sub)
  const batch = sub.pending
  sub.pending = []
  deliver(sub, batch)
}

/**
 * Subscribe to entity changes. Inside a reactive owner the subscription is
 * disposed with it; outside one, call the returned disposer.
 */
export function onEntityChange(
  keys: string | string[],
  cb: (events: EntityChangeEvent[]) => void,
  opts?: EntityChangeOptions,
): () => void {
  const sub: Subscription = {
    patterns: Array.isArray(keys) ? [...keys] : [keys],
    cb,
    debounceMs: Math.max(0, opts?.debounceMs ?? DEFAULT_ENTITY_CHANGE_DEBOUNCE_MS),
    maxWaitMs: Math.max(
      opts?.maxWaitMs ?? ENTITY_CHANGE_MAX_WAIT_MS,
      opts?.debounceMs ?? DEFAULT_ENTITY_CHANGE_DEBOUNCE_MS,
    ),
    pending: [],
    quietTimer: null,
    maxTimer: null,
  }
  subscriptions.add(sub)
  const dispose = () => {
    clearTimers(sub)
    sub.pending = []
    subscriptions.delete(sub)
  }
  if (getOwner()) onCleanup(dispose)
  return dispose
}

/** Fan one event out to every matching subscription. */
export function notifyEntityChange(ev: EntityChangeEvent): void {
  for (const sub of [...subscriptions]) {
    if (!sub.patterns.some((p) => entityKeyMatches(p, ev.key))) continue
    if (sub.debounceMs === 0) {
      deliver(sub, [ev])
      continue
    }
    sub.pending.push(ev)
    if (sub.quietTimer !== null) clearTimeout(sub.quietTimer)
    sub.quietTimer = setTimeout(() => flush(sub), sub.debounceMs)
    if (sub.maxTimer === null) {
      sub.maxTimer = setTimeout(() => flush(sub), sub.maxWaitMs)
    }
  }
}

/** Deliver the synthetic resync batch to every live subscription, once. */
export function notifyEntityResync(): void {
  for (const sub of [...subscriptions]) {
    // A refetch covers whatever was pending: drop it rather than deliver twice.
    clearTimers(sub)
    sub.pending = []
    deliver(sub, [{ key: "*", app: "*", entity: "*", action: "resync", data: null, resync: true }])
  }
}

subscribeResync(() => notifyEntityResync())

/** Test access: drop every subscription and its timers. */
export const EntityChangesTestAccess = {
  reset(): void {
    for (const sub of subscriptions) clearTimers(sub)
    subscriptions.clear()
  },
}
