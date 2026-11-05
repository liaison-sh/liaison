// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * One config change at a time per org and write group. Two approved calls of
 * the same section (or of sections writing the same rows) would otherwise
 * interleave their plan and apply. A Redis `SET NX PX` lease, renewed every
 * minute while the apply runs and released in `finally` with a compare-and-
 * delete on the holder's token, so a lease that expired and was taken by
 * someone else is never deleted by the late holder. Not an advisory lock:
 * those are session-scoped and PgBouncer pools sessions.
 */
import { randomUUID } from "node:crypto"
import { redis } from "~/lib/redis"
import type { ConfigToolSection } from "~/modules/provisioning/config-tool-input"

export const CONFIG_LEASE_TTL_MS = 10 * 60 * 1000
export const CONFIG_LEASE_RENEW_MS = 60 * 1000

/** Sections that write the same rows share a group: the mail provider
 *  switches and the Google client are written by mail, tickets and apps. */
export function configLeaseGroup(section: ConfigToolSection): string {
  return section === "mail" || section === "tickets" || section === "apps"
    ? "mail-providers"
    : section
}

export class ConfigLeaseBusyError extends Error {
  constructor(readonly section: ConfigToolSection) {
    super(`another change to ${section} is running; try again when it finishes`)
    this.name = "ConfigLeaseBusyError"
  }
}

/** Compare-and-delete: deletes KEYS[1] only while it holds ARGV[1]. */
export const RELEASE_LUA = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`
/** Compare-and-PEXPIRE: renews KEYS[1] to ARGV[2] ms only while it holds ARGV[1]. */
export const RENEW_LUA = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end`

function leaseKey(orgId: string, group: string): string {
  return `config-lease:${orgId}:${group}`
}

export class ConfigLeaseLostError extends Error {
  constructor(readonly section: ConfigToolSection) {
    super(
      `the lock on ${section} was lost while the change ran (it expired or another change took it); ` +
        "nothing more was written: check the result and propose again",
    )
    this.name = "ConfigLeaseLostError"
  }
}

/** A held lease: `assertHeld` throws ConfigLeaseLostError once it is not ours. */
export interface ConfigLease {
  assertHeld(): Promise<void>
}

/**
 * Run `fn` holding the section's lease; throws ConfigLeaseBusyError when held.
 * The lease is renewed every `renewMs`; a renewal that fails (the key expired
 * or now belongs to someone else, or Redis refused) is RECORDED, and
 * `lease.assertHeld()`, called before each write step, then refuses to go on,
 * even if the key is held again by another change by then.
 */
export async function withConfigLease<T>(
  orgId: string,
  section: ConfigToolSection,
  fn: (lease: ConfigLease) => Promise<T>,
  opts: { ttlMs?: number; renewMs?: number } = {},
): Promise<T> {
  const key = leaseKey(orgId, configLeaseGroup(section))
  const token = randomUUID()
  const ttlMs = opts.ttlMs ?? CONFIG_LEASE_TTL_MS
  const got = await redis.set(key, token, "PX", ttlMs, "NX")
  if (got !== "OK") throw new ConfigLeaseBusyError(section)
  let lost = false
  const renew = setInterval(() => {
    redis
      .eval(RENEW_LUA, 1, key, token, String(ttlMs))
      .then((renewed) => {
        if (Number(renewed) !== 1) lost = true
      })
      .catch(() => {
        lost = true
      })
  }, opts.renewMs ?? CONFIG_LEASE_RENEW_MS)
  const lease: ConfigLease = {
    async assertHeld() {
      if (lost || (await redis.get(key)) !== token) {
        lost = true
        throw new ConfigLeaseLostError(section)
      }
    },
  }
  try {
    return await fn(lease)
  } finally {
    clearInterval(renew)
    await redis.eval(RELEASE_LUA, 1, key, token)
  }
}
