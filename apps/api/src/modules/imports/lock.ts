// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Import runs of the same (org, kind) are serialized (A13, R8): a run holds a
 * Redis `SET NX PX` lock per kind it imports, renewed every 60 s while it runs
 * and released (compare-and-delete) when it ends. A run that dies stops
 * renewing and its lock expires. The dedup precheck plus this lock is what
 * keeps two concurrent runs from creating the same record twice.
 */
import { randomUUID } from "node:crypto"
import { redis } from "~/lib/redis"

const LOCK_TTL_MS = 180_000
const RENEW_EVERY_MS = 60_000
const POLL_MS = 500

const RELEASE_LUA = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`
const RENEW_LUA = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end`

export function importLockKey(orgId: string, kind: string): string {
  return `imports:lock:${orgId}:${kind}`
}

export interface ImportLocks {
  release(): Promise<void>
}

async function tryTake(keys: string[], token: string): Promise<boolean> {
  const taken: string[] = []
  for (const key of keys) {
    const got = await redis.set(key, token, "PX", LOCK_TTL_MS, "NX")
    if (got !== "OK") {
      for (const k of taken) await redis.eval(RELEASE_LUA, 1, k, token)
      return false
    }
    taken.push(key)
  }
  return true
}

/**
 * Take the locks of every kind of a run (sorted, all or nothing). Waits up to
 * `waitMs` (0: one attempt). `null` when another run holds one of them.
 */
export async function acquireImportLocks(
  orgId: string,
  kinds: string[],
  waitMs: number,
): Promise<ImportLocks | null> {
  const keys = [...new Set(kinds)].sort().map((k) => importLockKey(orgId, k))
  const token = randomUUID()
  const deadline = Date.now() + waitMs
  for (;;) {
    if (await tryTake(keys, token)) break
    if (Date.now() >= deadline) return null
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
  const timer = setInterval(() => {
    for (const key of keys) {
      redis.eval(RENEW_LUA, 1, key, token, String(LOCK_TTL_MS)).catch(() => {})
    }
  }, RENEW_EVERY_MS)
  timer.unref?.()
  return {
    async release() {
      clearInterval(timer)
      for (const key of keys) await redis.eval(RELEASE_LUA, 1, key, token)
    },
  }
}
