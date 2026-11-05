// SPDX-License-Identifier: FSL-1.1-ALv2
import type Redis from "ioredis"
import { rootLogger } from "~/lib/logger"
import { emitSecurityEvent } from "~/modules/security/security-events"

const MAX_EMAIL_ATTEMPTS = 5
const MAX_IP_ATTEMPTS = 20
const MIN_IP_FOR_EMAIL_BLOCK = 3
const BACKOFF_CAP_SECONDS = 900
const TTL_SECONDS = 3600

// Read-only check — does NOT increment.
// retryAfter honesty: a blocked key stays blocked until it EXPIRES (the
// counter never decays), so the truthful Retry-After is the key's remaining
// TTL — not an exponential backoff. The old 2^(count - max) formula reported
// "1 second" at the first block while the actual lockout was up to an hour,
// and that figure reached user-facing copy ("Try again in 1 seconds"). The
// exponential form survives only as a fallback for a key with no TTL (should
// not happen; INCREMENT_SCRIPT always sets one).
const CHECK_SCRIPT = `
local key = KEYS[1]
local max = tonumber(ARGV[1])
local cap = tonumber(ARGV[2])
local count = tonumber(redis.call('GET', key) or '0')
if count >= max then
  local ttl = redis.call('TTL', key)
  local backoff
  if ttl and ttl > 0 then
    backoff = ttl
  else
    backoff = math.min(math.pow(2, count - max), cap)
  end
  return {0, backoff, count}
end
return {1, 0, count}
`

// Increment only — called after failed auth
const INCREMENT_SCRIPT = `
local key = KEYS[1]
local ttl = tonumber(ARGV[1])
local count = redis.call('INCR', key)
if count == 1 then
  redis.call('EXPIRE', key, ttl)
end
return count
`

/** Read-only brute-force check. Does NOT increment counters. */
export async function checkBruteForce(
  redis: Redis,
  identifier: string,
  ip: string,
): Promise<{ allowed: boolean; retryAfter?: number }> {
  const emailKey = `bruteforce:email:${identifier}`
  const ipKey = `bruteforce:ip:${ip}`

  const [emailResult, ipResult] = await Promise.all([
    redis.eval(CHECK_SCRIPT, 1, emailKey, MAX_EMAIL_ATTEMPTS, BACKOFF_CAP_SECONDS) as Promise<
      [number, number, number]
    >,
    redis.eval(CHECK_SCRIPT, 1, ipKey, MAX_IP_ATTEMPTS, BACKOFF_CAP_SECONDS) as Promise<
      [number, number, number]
    >,
  ])

  const [emailAllowed, emailBackoff, emailCount] = emailResult
  const [ipAllowed, ipBackoff, ipCount] = ipResult

  if (!ipAllowed) {
    rootLogger.warn({ key: ipKey, ip }, "brute-force ip key blocked")
    return { allowed: false, retryAfter: ipBackoff }
  }

  // Email block: triggers when the email exceeds its limit AND the requesting IP
  // has accumulated enough failures to share blame. This prevents a remote attacker
  // from locking out a legitimate user without the IP sharing blame — UNLESS
  // the email counter is far above the threshold (2x), in which case block
  // regardless of IP to stop distributed attacks.
  if (!emailAllowed) {
    if (ipCount >= MIN_IP_FOR_EMAIL_BLOCK || emailCount >= MAX_EMAIL_ATTEMPTS * 2) {
      rootLogger.warn({ key: emailKey, ip, emailCount, ipCount }, "brute-force email key blocked")
      return { allowed: false, retryAfter: emailBackoff }
    }
  }

  return { allowed: true }
}

/** Increment brute-force counters — call AFTER failed authentication. */
export async function recordFailedAttempt(
  redis: Redis,
  identifier: string,
  ip: string,
): Promise<void> {
  const emailKey = `bruteforce:email:${identifier}`
  const ipKey = `bruteforce:ip:${ip}`
  const [identifierCount, ipCount] = (await Promise.all([
    redis.eval(INCREMENT_SCRIPT, 1, emailKey, TTL_SECONDS),
    redis.eval(INCREMENT_SCRIPT, 1, ipKey, TTL_SECONDS),
  ])) as [number, number]
  // The failure that reaches a block threshold sets a lockout: say so, once
  // per crossing (the counters only climb until their TTL resets them).
  if (Number(identifierCount) === MAX_EMAIL_ATTEMPTS) {
    await emitSecurityEvent({ kind: "lockout", scope: "identifier", detail: { key: emailKey } })
  }
  if (Number(ipCount) === MAX_IP_ATTEMPTS) {
    await emitSecurityEvent({ kind: "lockout", scope: "address", detail: { ip } })
  }
}

/** Reset brute-force counters on successful authentication. */
export async function resetAttempts(redis: Redis, identifier: string, ip: string): Promise<void> {
  await redis.del(`bruteforce:email:${identifier}`, `bruteforce:ip:${ip}`)
}

/**
 * Per-account daily budget of wrong answers to one factor.
 *
 * The counters above are hourly and the per-account one is shared with the
 * source address, so a caller rotating addresses gets a fresh allowance every
 * hour. This one counts wrong answers per account and factor over a day,
 * whatever the address, the challenge or the code; past `max` the factor is
 * refused for that account until the window ends. The caller decides which
 * other proof stays open (a recovery code, the emailed link, a password).
 */
export const ACCOUNT_FAILURE_WINDOW_SECONDS = 24 * 60 * 60

function accountFailureKey(factor: string, accountId: string): string {
  return `bruteforce:account:${factor}:${accountId}`
}

/** True when the account has used its daily budget of wrong answers for `factor`. */
export async function accountFailureBudgetExhausted(
  redis: Redis,
  factor: string,
  accountId: string,
  max: number,
): Promise<boolean> {
  const count = Number(await redis.get(accountFailureKey(factor, accountId))) || 0
  if (count >= max) {
    rootLogger.warn({ factor, accountId, count }, "per-account daily failure budget exhausted")
    return true
  }
  return false
}

/** Count one wrong answer for `factor` against the account's daily budget. */
export async function recordAccountFailure(
  redis: Redis,
  factor: string,
  accountId: string,
): Promise<number> {
  return Number(
    await redis.eval(
      INCREMENT_SCRIPT,
      1,
      accountFailureKey(factor, accountId),
      ACCOUNT_FAILURE_WINDOW_SECONDS,
    ),
  )
}
