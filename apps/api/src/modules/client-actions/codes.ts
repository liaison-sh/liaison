// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The emailed code and the proof it buys. Both live in Redis only, as hashes:
// the code as SHA-256 of `<action id>:<code>` for 10 minutes, a new one
// replacing the old; the proof as SHA-256 of a 32-byte token for 20 minutes,
// bound to the action and to a hash of the browser that verified.
//
// Budgets: a code is sent first on demand, then at most one per 60 s, 5 per hour
// and 10 per day per action. Five wrong answers to one code pause the action 15
// minutes and spend that code; 20 wrong in total lock the link for good (the
// total lives on the row, so a new code or a new address resets nothing).

import { createHash, timingSafeEqual } from "node:crypto"
import { generateNumericCode, generateToken, hashToken } from "~/lib/crypto"
import { redis } from "~/lib/redis"

export const CODE_TTL_SECONDS = 10 * 60
export const PROOF_TTL_SECONDS = 20 * 60
export const SEND_GAP_SECONDS = 60
export const SENDS_PER_HOUR = 5
export const SENDS_PER_DAY = 10
export const WRONG_PER_CODE = 5
export const PAUSE_SECONDS = 15 * 60
export const WRONG_TOTAL_LOCK = 20
/** Pauses in a row that tell the sender. */
export const PAUSES_TO_TELL = 3

const k = {
  code: (id: string) => `ca:code:${id}`,
  wrong: (id: string) => `ca:code:wrong:${id}`,
  pause: (id: string) => `ca:code:pause:${id}`,
  pauses: (id: string) => `ca:code:pauses:${id}`,
  gap: (id: string) => `ca:code:gap:${id}`,
  hour: (id: string) => `ca:code:hour:${id}`,
  day: (id: string) => `ca:code:day:${id}`,
  proof: (hash: string) => `ca:proof:${hash}`,
}

/** Every Redis key a code or a proof of this action may sit under (for tests and revocation). */
export function codeKeysOf(actionId: string): string[] {
  return [k.code(actionId), k.wrong(actionId), k.pause(actionId), k.pauses(actionId)]
}

function codeHash(actionId: string, code: string): string {
  return createHash("sha256").update(`${actionId}:${code}`).digest("hex")
}

function sameHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex")
  const y = Buffer.from(b, "hex")
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y)
}

export type SendBudget = { ok: true } | { ok: false; retryAt: Date }

/** Takes one code send from the action's budget. */
export async function takeCodeSend(actionId: string): Promise<SendBudget> {
  const gapTtl = await redis.ttl(k.gap(actionId))
  if (gapTtl > 0) return { ok: false, retryAt: new Date(Date.now() + gapTtl * 1000) }
  const hour = await redis.incr(k.hour(actionId))
  if (hour === 1) await redis.expire(k.hour(actionId), 3600)
  const day = await redis.incr(k.day(actionId))
  if (day === 1) await redis.expire(k.day(actionId), 86_400)
  if (hour > SENDS_PER_HOUR || day > SENDS_PER_DAY) {
    const ttl = await redis.ttl(hour > SENDS_PER_HOUR ? k.hour(actionId) : k.day(actionId))
    return { ok: false, retryAt: new Date(Date.now() + Math.max(ttl, 1) * 1000) }
  }
  await redis.set(k.gap(actionId), "1", "EX", SEND_GAP_SECONDS)
  return { ok: true }
}

/** A new code for the action, replacing any earlier one. The raw code goes to the mail only. */
export async function issueCode(actionId: string): Promise<string> {
  const code = generateNumericCode(6)
  await redis
    .multi()
    .set(k.code(actionId), codeHash(actionId, code), "EX", CODE_TTL_SECONDS)
    .del(k.wrong(actionId))
    .exec()
  return code
}

export async function pausedUntil(actionId: string): Promise<Date | null> {
  const ttl = await redis.ttl(k.pause(actionId))
  return ttl > 0 ? new Date(Date.now() + ttl * 1000) : null
}

export type CodeCheck =
  | { ok: true }
  | { ok: false; reason: "paused"; until: Date }
  | { ok: false; reason: "no_code" }
  | { ok: false; reason: "wrong"; wrongForCode: number; pausedNow: boolean; pausesInARow: number }

/**
 * Checks a typed code. A right code is spent; a wrong one counts against the
 * code (the caller counts the action's total on its row). During a pause every
 * code fails, the right one included.
 */
export async function checkCode(actionId: string, typed: string): Promise<CodeCheck> {
  const until = await pausedUntil(actionId)
  if (until) return { ok: false, reason: "paused", until }
  const stored = await redis.get(k.code(actionId))
  if (!stored) return { ok: false, reason: "no_code" }
  // Every guess takes its place before it is compared: guesses sent at once count one by one,
  // and one past the code's budget is never compared.
  const wrong = await redis.incr(k.wrong(actionId))
  if (wrong === 1) await redis.expire(k.wrong(actionId), CODE_TTL_SECONDS)
  if (wrong > WRONG_PER_CODE) return { ok: false, reason: "no_code" }
  if (/^\d{6}$/.test(typed) && sameHex(stored, codeHash(actionId, typed))) {
    // One use: only the caller whose delete removed it goes on.
    if ((await redis.del(k.code(actionId))) !== 1) return { ok: false, reason: "no_code" }
    await redis.del(k.wrong(actionId), k.pauses(actionId))
    return { ok: true }
  }
  if (wrong >= WRONG_PER_CODE) {
    // The guess count stays until it expires or a new code replaces it: a guess sent at
    // the same moment that read the code before this delete then counts past the budget
    // and is never compared, instead of starting a fresh count of its own.
    await redis
      .multi()
      .set(k.pause(actionId), "1", "EX", PAUSE_SECONDS)
      .del(k.code(actionId))
      .exec()
    const pauses = await redis.incr(k.pauses(actionId))
    await redis.expire(k.pauses(actionId), 86_400)
    return {
      ok: false,
      reason: "wrong",
      wrongForCode: wrong,
      pausedNow: true,
      pausesInARow: pauses,
    }
  }
  return { ok: false, reason: "wrong", wrongForCode: wrong, pausedNow: false, pausesInARow: 0 }
}

function uaHash(userAgent: string | null | undefined): string {
  return createHash("sha256")
    .update(userAgent ?? "")
    .digest("hex")
}

/** A proof that this browser passed the code for this action, with the name it gave. */
export async function issueProof(
  actionId: string,
  userAgent: string | null | undefined,
  name: string,
  capacity: string | null,
): Promise<string> {
  const proof = generateToken(32)
  await redis.set(
    k.proof(hashToken(proof)),
    JSON.stringify({ actionId, ua: uaHash(userAgent), name, capacity }),
    "EX",
    PROOF_TTL_SECONDS,
  )
  return proof
}

export type ProofCheck = { ok: true; name: string; capacity: string | null } | { ok: false }

/**
 * Spends a proof: valid only for this action and the browser that verified, and
 * only once. The row is re-checked by the caller, so a proof dies on revoke.
 */
export async function spendProof(
  actionId: string,
  proof: string | undefined,
  userAgent: string | null | undefined,
): Promise<ProofCheck> {
  if (!proof || proof.length > 128) return { ok: false }
  const key = k.proof(hashToken(proof))
  const raw = await redis.get(key)
  if (!raw) return { ok: false }
  const v = JSON.parse(raw) as {
    actionId: string
    ua: string
    name: string
    capacity: string | null
  }
  if (v.actionId !== actionId || !sameHex(v.ua, uaHash(userAgent))) return { ok: false }
  if ((await redis.del(key)) !== 1) return { ok: false }
  return { ok: true, name: v.name, capacity: v.capacity }
}

/** Puts a spent proof back (the decide that spent it was refused before writing). */
export async function restoreProof(
  actionId: string,
  proof: string,
  userAgent: string | null | undefined,
  name: string,
  capacity: string | null,
): Promise<void> {
  await redis.set(
    k.proof(hashToken(proof)),
    JSON.stringify({ actionId, ua: uaHash(userAgent), name, capacity }),
    "EX",
    PROOF_TTL_SECONDS,
  )
}
