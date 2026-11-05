// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Per-connection rate cap enforcer.
//
// Managed-edition only: self-hosted bypasses the cap entirely (spec §7 —
// anything credit/quota-shaped is managed-only).
// Uses a fixed-window per-minute counter in Redis: simple, atomic, exact-cap
// enforcement within a minute. The known double-burst across the minute boundary
// is documented in the test suite.

import { isManagedEdition } from "~/lib/edition"
import { redis } from "~/lib/redis"

export type RateCapResult = { allowed: true } | { allowed: false; retryAfterMs: number }

/**
 * Check + atomically increment the per-minute counter for `connectionId`. When
 * the post-increment count exceeds `capPerMinute`, returns `{ allowed: false }`
 * with a `retryAfterMs` pointing to the next minute boundary. On self-hosted,
 * always returns `{ allowed: true }` without touching Redis.
 */
export async function checkAndIncrement(
  connectionId: string,
  capPerMinute: number,
): Promise<RateCapResult> {
  if (!isManagedEdition()) return { allowed: true }
  const now = Date.now()
  const minute = Math.floor(now / 60_000)
  const key = `mcp:ratecap:${connectionId}:${minute}`
  const count = await redis.incr(key)
  // First incr in this minute → set TTL so the key auto-expires after the window.
  if (count === 1) await redis.expire(key, 60)
  if (count > capPerMinute) {
    const retryAfterMs = (minute + 1) * 60_000 - now
    return { allowed: false, retryAfterMs }
  }
  return { allowed: true }
}
