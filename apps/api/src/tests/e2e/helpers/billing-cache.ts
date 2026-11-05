// SPDX-License-Identifier: FSL-1.1-ALv2
import type { WorkerEnv } from "@liaison/test-helpers"

/**
 * Delete the prefixed billing-state cache keys for an org in a worker-isolated
 * Redis namespace. Tests must NEVER call `env.redis.redis.del(...)` directly
 * on unprefixed keys — the worker prefix is required to keep parallel workers
 * isolated.
 *
 * Production cache keys (see `apps/api/src/modules/billing-state/index.ts`):
 *   billingState:${orgId}        — live key (60s TTL)
 *   billingState:last:${orgId}   — last-known stale fallback (no TTL)
 *
 * Production prepends `REDIS_PREFIX` (set per-worker by `createWorkerEnv`)
 * via the ioredis keyPrefix; in tests we read the raw ioredis client so we
 * must prepend `env.redisPrefix` manually.
 */
export async function deleteBillingStateCache(
  env: WorkerEnv,
  orgId: string,
  opts: { live?: boolean; last?: boolean } = { live: true },
): Promise<void> {
  const live = opts.live ?? true
  const last = opts.last ?? false
  const keys: string[] = []
  if (live) keys.push(`${env.redisPrefix}billingState:${orgId}`)
  if (last) keys.push(`${env.redisPrefix}billingState:last:${orgId}`)
  if (keys.length === 0) return
  await env.redis.redis.del(...keys)
}
