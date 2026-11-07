// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The ONE reader of `/credits/balance` and `/credits/models` in the web app.
 *
 * Both endpoints used to be read by a per-ThreadView `createResource`. Every
 * mounted conversation surface (a Home thread, each expanded dock tab, the
 * phone Chats sheet, every remount of any of them) therefore asked for its own
 * copy, and the box logged 15 500 balance reads and 6 800 model reads in forty
 * minutes from two or three browsers, most of them answered 429. That storm
 * starves every other request on the same limiter, and because the resource
 * was READ DURING RENDER it also suspended whatever Suspense boundary was
 * above it for as long as the rate limiter held the answer.
 *
 * So the data is session state, not per-component state:
 *
 *  - Models are a property of the org's provider keys and of what its admin
 *    switched on. They are fetched ONCE per session, and again only when an
 *    admin changes either (`refreshAvailableModels`). The whole served list
 *    (labels, providers, reasoning) is installed for every picker through
 *    `setServedModels` in `~/lib/model-groups`.
 *  - The balance moves, but slowly, and only a turn moves it perceptibly. It
 *    is refreshed at most once a minute, plus immediately after a turn
 *    (`creditsBalanceStale()`), and never by rendering.
 *  - Every read is single-flight: ten chips mounting in the same tick share one
 *    in-flight promise.
 *  - A 429 stops the traffic instead of feeding it. The endpoint is parked
 *    until `Retry-After` (or an exponentially growing backoff, capped at five
 *    minutes), and nothing asks again before then. The last known value stays
 *    on screen.
 *
 * Readers are plain signals, so nothing here can suspend a render.
 */
import { createSignal } from "solid-js"
import type { ApiClient } from "~/lib/api-client"
import { ApiError } from "~/lib/api-error"
import { parseServedModels, setServedModels } from "~/lib/model-groups"
import { onSessionTeardown } from "~/lib/session-lifecycle"

export interface CreditsBalance {
  included: string
  purchased: string
  /** Self-hosted only: a managed cell's balance is credits, with no currency (S18). */
  currency?: string
  tier?: string
}

/** A managed cell's `/credits/balance`, read as the pickers' balance (included, purchased). */
export function toCreditsBalance(raw: unknown): CreditsBalance | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  if (r.mode === "managed" && r.credits && typeof r.credits === "object") {
    const c = r.credits as { included?: unknown; purchased?: unknown }
    return {
      included: String(c.included ?? "0"),
      purchased: String(c.purchased ?? "0"),
      ...(typeof r.tier === "string" ? { tier: r.tier } : {}),
    }
  }
  return raw as CreditsBalance
}

/** The balance is worth re-asking at most this often. */
export const BALANCE_MAX_AGE_MS = 60_000
/** First backoff step after a retryable failure with no Retry-After. */
const BACKOFF_BASE_MS = 30_000
/** Ceiling on the backoff, so a long outage still recovers within a coffee. */
const BACKOFF_MAX_MS = 300_000

const [balance, setBalance] = createSignal<CreditsBalance | null>(null)
const [availableModelIds, setAvailableModelIds] = createSignal<Set<string> | null>(null)

export { availableModelIds, balance as creditsBalance }

/** Per-endpoint throttle state. `until` is a wall clock deadline; `failures`
 *  only grows on retryable failures and resets on any success. */
interface Gate {
  inFlight: Promise<void> | null
  fetchedAt: number
  until: number
  failures: number
}

const balanceGate: Gate = { inFlight: null, fetchedAt: 0, until: 0, failures: 0 }
const modelsGate: Gate = { inFlight: null, fetchedAt: 0, until: 0, failures: 0 }

function now(): number {
  return Date.now()
}

/** How long to stay away after a failure: the server's own Retry-After when it
 *  gave one, otherwise a doubling backoff. Never shorter than the base step,
 *  which is what makes a 429 stop the storm rather than pace it. */
function backoffFor(err: unknown, gate: Gate): number {
  const retryAfter = err instanceof ApiError ? err.retryAfter : undefined
  if (typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, BACKOFF_MAX_MS)
  }
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, gate.failures - 1), BACKOFF_MAX_MS)
}

function noteFailure(gate: Gate, err: unknown): void {
  // A permission or not-found answer is not going to change by being asked
  // again in thirty seconds, but it is not a reason to hammer either: both
  // paths park the endpoint, the retryable one with a growing backoff.
  gate.failures += 1
  gate.until = now() + backoffFor(err, gate)
}

function noteSuccess(gate: Gate): void {
  gate.failures = 0
  gate.until = 0
  gate.fetchedAt = now()
}

/** The one models read, single-flight through `modelsGate`. */
function readModels(api: ApiClient): Promise<void> {
  const run = (async () => {
    try {
      const served = parseServedModels(await api.get<unknown>("/credits/models"))
      setServedModels(served)
      setAvailableModelIds(new Set(served.models.map((m) => m.key)))
      noteSuccess(modelsGate)
    } catch (err) {
      noteFailure(modelsGate, err)
    } finally {
      modelsGate.inFlight = null
    }
  })()
  modelsGate.inFlight = run
  return run
}

/**
 * The org's usable model ids, fetched at most once per session.
 *
 * Returns the in-flight promise when one is running, so N callers in the same
 * tick issue ONE request. `null` while unknown means "hide nothing", which is
 * the contract ModelSelector already had.
 */
export function ensureAvailableModels(api: ApiClient): Promise<void> {
  if (availableModelIds() !== null) return Promise.resolve()
  if (modelsGate.inFlight) return modelsGate.inFlight
  if (now() < modelsGate.until) return Promise.resolve()
  return readModels(api)
}

/**
 * Re-read the usable models NOW: the org's provider keys just changed (a key
 * saved or removed). "Once per session" is right for everything else, but a
 * visitor who pastes their first key must see its models in the picker at
 * once, not after a reload. The last known set stays on screen until the
 * answer lands, and the backoff still wins: a 429 is never argued with.
 */
export function refreshAvailableModels(api: ApiClient): Promise<void> {
  if (modelsGate.inFlight) {
    // A read that started before the key changed may answer with the old set.
    return modelsGate.inFlight.then(() => refreshAvailableModels(api))
  }
  if (now() < modelsGate.until) return Promise.resolve()
  return readModels(api)
}

/**
 * The credit balance, at most once a minute and at most one request at a time.
 * `force` is for the one caller that knows the number moved (a finished turn)
 * and still respects the backoff: a 429 is never argued with.
 */
export function ensureCreditsBalance(
  api: ApiClient,
  opts: { force?: boolean } = {},
): Promise<void> {
  if (balanceGate.inFlight) return balanceGate.inFlight
  if (now() < balanceGate.until) return Promise.resolve()
  const fresh = balanceGate.fetchedAt > 0 && now() - balanceGate.fetchedAt < BALANCE_MAX_AGE_MS
  if (fresh && !opts.force) return Promise.resolve()
  const run = (async () => {
    try {
      const res = await api.get<CreditsBalance | { data?: CreditsBalance }>("/credits/balance")
      const value = res && typeof res === "object" && "data" in res ? res.data : res
      setBalance(toCreditsBalance(value))
      noteSuccess(balanceGate)
    } catch (err) {
      // The last known balance stays on screen: a rate limited read is not
      // news that the org ran out of credit.
      noteFailure(balanceGate, err)
    } finally {
      balanceGate.inFlight = null
    }
  })()
  balanceGate.inFlight = run
  return run
}

/** Mark the balance as worth re-reading before its minute is up: a turn just
 *  finished. The next `ensureCreditsBalance` with `force` does the work; the
 *  backoff still wins over this. */
export function creditsBalanceStale(): void {
  balanceGate.fetchedAt = 0
}

/** @internal — tests and session teardown. */
export function resetCreditsStore(): void {
  setBalance(null)
  setAvailableModelIds(null)
  setServedModels(null)
  for (const gate of [balanceGate, modelsGate]) {
    gate.inFlight = null
    gate.fetchedAt = 0
    gate.until = 0
    gate.failures = 0
  }
}

onSessionTeardown(resetCreditsStore)
