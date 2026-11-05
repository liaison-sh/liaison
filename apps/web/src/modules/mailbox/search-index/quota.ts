// SPDX-License-Identifier: FSL-1.1-ALv2
//
// How much of a mailbox this device can index, and what to do when the answer
// is "not all of it" (blueprint task 10.4, spec section 5.5).
//
// Every number here descends from ONE measurement, taken with
// `measure-index-size.ts` and recorded in spec section 5.5. Nothing in this
// file is a guess, and a future library change is expected to re-run the
// measurement and edit the constant rather than nudge a threshold.

/**
 * MEASURED, flexsearch@0.8.212 with this product's settings, 8000 synthetic
 * messages carrying 9,461,383 bytes of indexable text.
 *
 *   index bytes per text byte : 1.089
 *   index bytes per message   : 1288
 *
 * The corpus is described in `measure-index-size.ts`. It is synthetic, because
 * a real mailbox cannot be committed, and it deliberately includes quoted reply
 * chains, which are the property that makes real mail cheaper to index than its
 * raw size suggests.
 */
export const INDEX_BYTES_PER_MESSAGE_MEASURED = 1288

/**
 * What a message costs ON DISK: the shard is sealed and stored as base64, which
 * is 4 bytes for every 3. The AES-GCM overhead (a 12 byte IV, a 16 byte tag and
 * a 2 byte header per shard) is amortised over a whole shard and rounds away.
 */
export const STORED_BYTES_PER_MESSAGE = Math.ceil((INDEX_BYTES_PER_MESSAGE_MEASURED * 4) / 3)

/**
 * How much of the free quota the index may plan to take. The rest is for the
 * rest of the product, and for the browser's own eviction headroom: an origin
 * that sits at its ceiling is the first one evicted.
 */
export const QUOTA_SAFETY_FRACTION = 0.8

/** The reduced window the spec offers when the whole mailbox will not fit. */
export const REDUCED_WINDOW_MONTHS = 12

export interface StorageEstimate {
  usage: number
  quota: number
}

/** `null` when the browser will not say, which several will not. */
export async function estimateIndexStorage(): Promise<StorageEstimate | null> {
  const storage = (
    globalThis as { navigator?: { storage?: { estimate?: () => Promise<unknown> } } }
  ).navigator?.storage
  if (!storage?.estimate) return null
  try {
    const estimate = (await storage.estimate()) as { usage?: number; quota?: number }
    if (typeof estimate?.usage !== "number" || typeof estimate?.quota !== "number") return null
    return { usage: estimate.usage, quota: estimate.quota }
  } catch {
    return null
  }
}

/** The browser signals a full origin by name, across every storage API. */
export function isQuotaExceededError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  return (error as { name?: unknown }).name === "QuotaExceededError"
}

export type IndexCapacityMode = "full" | "reduced-window" | "metadata-only"

export interface IndexCapacityPlan {
  mode: IndexCapacityMode
  /** How many months of mail to index, or null for all of it. */
  windowMonths: number | null
  projectedBytes: number
  availableBytes: number | null
  estimateAvailable: boolean
}

export interface IndexCapacityInput {
  /** Messages in the mailbox. */
  messageCount: number
  /** Messages inside the reduced window, when the caller knows. */
  messagesInWindow?: number
  estimate: StorageEstimate | null
}

/**
 * Decide between indexing everything, indexing the last year, or giving up on
 * bodies and keeping metadata search.
 *
 * An UNKNOWN quota indexes in full. Refusing on ignorance would disable search
 * on every browser without the Storage API, and the `QuotaExceededError` path
 * catches the real failure with certainty rather than by projection.
 */
export function planIndexCapacity(input: IndexCapacityInput): IndexCapacityPlan {
  const projectedBytes = input.messageCount * STORED_BYTES_PER_MESSAGE
  if (!input.estimate) {
    return {
      mode: "full",
      windowMonths: null,
      projectedBytes,
      availableBytes: null,
      estimateAvailable: false,
    }
  }
  const free = Math.max(0, input.estimate.quota - input.estimate.usage)
  const availableBytes = Math.floor(free * QUOTA_SAFETY_FRACTION)
  if (projectedBytes <= availableBytes) {
    return {
      mode: "full",
      windowMonths: null,
      projectedBytes,
      availableBytes,
      estimateAvailable: true,
    }
  }
  // The window count is an estimate when the caller does not know it: a year
  // of a mailbox, assuming an even spread, is the fallback.
  const windowCount = input.messagesInWindow ?? Math.ceil(input.messageCount / 4)
  const windowBytes = windowCount * STORED_BYTES_PER_MESSAGE
  if (windowBytes <= availableBytes) {
    return {
      mode: "reduced-window",
      windowMonths: REDUCED_WINDOW_MONTHS,
      projectedBytes: windowBytes,
      availableBytes,
      estimateAvailable: true,
    }
  }
  return {
    mode: "metadata-only",
    windowMonths: null,
    projectedBytes: 0,
    availableBytes,
    estimateAvailable: true,
  }
}
