// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE VISITOR BUDGET ENGINE: reserve a step's worst cost on four budgets at
// once, settle what it actually cost.
//
// A verified visitor's model call runs on this box's key only against a
// RESERVATION (credit-meter.ts `resolveKey`). A reservation is taken by ONE
// Redis Lua script that checks four budgets and holds the step's full worst
// cost on all of them, or on none:
//
//   email:<keyed address hash>  lifetime          LIAISON_DEMO_BUDGET_PER_EMAIL_EUR
//   net:<network>:<UTC day>     per day           LIAISON_DEMO_BUDGET_PER_NETWORK_EUR
//   box:<UTC day>               per day           LIAISON_DEMO_BOX_DAILY_EUR
//   boxhour:<5-minute bucket>   rolling hour      LIAISON_DEMO_BOX_HOURLY_EUR
//                               (sum of the last 12 buckets)
//
// Admission per budget: spent + this step's max <= cap, where `spent`
// already counts every live hold: a reservation CHARGES its full worst cost
// to the four counters (and to the ledger) when it is taken, and settling it
// hands back the difference to what the step actually cost. So N concurrent
// steps cannot all pass on the same reading (the script is the serialisation
// point, and the loser sees the winner's charge), and a step whose settle
// never comes (a dead process, an aborted stream, a store failure) stays
// counted at its max instead of dropping out.
//
// LAYOUT. `spent` counters are plain integers (no TTL for email, day and hour
// TTLs for the others). Each reservation is its own hash `r:<id>` (TTL 15
// min): `resolveKey` checks it, and a settle claims (deletes) it first, so a
// hold is closed once.
//
// DURABILITY. `kernel.demo_spend` (demo-spend.ts) is the ledger. The hold is
// written there at its max BEFORE the call may run (a ledger failure refuses
// the step), and a settle writes the difference there first and then to
// Redis. A ledger failure at settle leaves both at the max (`alert:
// demo_ledger_write`); a Redis failure after the ledger write drops the four
// counters (retried) so the next reserve rehydrates them from the ledger. A
// reserve that finds a counter missing returns "rehydrate"; the caller reads
// the ledger and retries with its values, which the script sets as
// max(current, ledger), so two concurrent rehydrates end at one value and a
// Redis flush never resets a budget.
//
// OVERSHOOT. Each step is reserved at its full worst cost, so the budget is
// exceeded only when a provider bills beyond that worst cost; settle records
// the actual, and the next reservation sees it. The bound is one step's max.
//
// Also here: the turn slots (8 concurrent box-wide, 2 per email, subruns and
// routine runs included), turns per email per minute, and the web_search
// counters (per turn, per email per UTC day).
import crypto from "node:crypto"
import type { PrivilegedDb } from "~/db"
import { env } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import { REDIS_PREFIX, redis } from "~/lib/redis"
import { demoVisitorSpendState, notifyDemoSpendSettled } from "~/modules/demo/demo-alerts"
import { loadDemoOrg } from "~/modules/demo/demo-org"
import {
  type DemoLedgerCell,
  DemoReservationRequiredError,
  type DemoSpendCode,
  DemoSpendRefusedError,
  demoLedgerAdd,
  demoLedgerPruneNetworkDays,
  demoLedgerRead,
  demoLedgerRekeyPlainEmails,
} from "~/modules/demo/demo-spend"
import { eurToMicroEur } from "~/modules/demo/demo-spend-ceiling"
import {
  demoBudgetEmailKey,
  demoCodeOnRecord,
  demoVerifiedIdentity,
} from "~/modules/demo/demo-verification"
import { serverT } from "~/modules/i18n/server-i18n"

const log = rootLogger.child({ module: "demo-budget" })

/** Who a visitor's spend is charged to (demo-verification.ts `demoVerifiedIdentity`). */
export interface DemoSpendIdentity {
  /** The address's keyed hash (`demoBudgetEmailKey`), never the address. */
  emailNormalized: string
  network: string
}

/** A live hold on the four budgets, the capability `resolveKey` checks. */
export interface DemoReservation {
  id: string
  orgId: string
  provider: "openrouter"
  upstreamId: string
  maxMicroEur: number
  /** Epoch ms after which the hold is void. */
  expiresAt: number
  identity: DemoSpendIdentity
  /** The UTC day and 5-minute bucket the hold was taken in (settle lands there). */
  day: string
  bucket: number
}

/** A reservation refused: which budget, or which load control. */
export class DemoBudgetRefusal extends Error {
  constructor(readonly code: DemoSpendCode) {
    super(code)
    this.name = "DemoBudgetRefusal"
  }
}

const BUCKET_MS = 5 * 60 * 1000
const HOUR_BUCKETS = 12
/** A hold whose step never settled expires: longer than any step, shorter than a session. */
export const RESERVATION_TTL_MS = 15 * 60 * 1000
const DAY_TTL_MS = 3 * 24 * 60 * 60 * 1000
const HOUR_TTL_MS = 2 * 60 * 60 * 1000
/** A turn slot whose turn never released it expires (longer than any turn). */
const TURN_SLOT_TTL_MS = 15 * 60 * 1000

let nowFn: () => number = () => Date.now()
let identityOverride: ((orgId: string) => Promise<DemoSpendIdentity | null>) | null = null
let failCounterAdjust = false

/** Test seams: a fake clock for bucket rolls and expiry; who is verified. */
export const DemoBudgetTestAccess = {
  setNow(fn: (() => number) | null): void {
    nowFn = fn ?? (() => Date.now())
  },
  setVerifiedIdentity(fn: ((orgId: string) => Promise<DemoSpendIdentity | null>) | null): void {
    identityOverride = fn
  },
  /** Make the Redis half of a settle fail (after its ledger write). */
  failCounterAdjust(on: boolean): void {
    failCounterAdjust = on
  },
}

/** The verified identity of a visitor org (demo-verification.ts), or null. */
export async function currentVerifiedIdentity(
  orgId: string,
  /** A privileged transaction of this org the caller holds, read on directly. */
  on?: PrivilegedDb,
): Promise<DemoSpendIdentity | null> {
  if (identityOverride) return identityOverride(orgId)
  return demoVerifiedIdentity(orgId, on)
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function bucketOf(ms: number): number {
  return Math.floor(ms / BUCKET_MS) * BUCKET_MS
}

/** The four caps, in µEUR, from env. */
export function demoBudgetCaps(): { email: number; net: number; box: number; hour: number } {
  return {
    email: eurToMicroEur(env.LIAISON_DEMO_BUDGET_PER_EMAIL_EUR),
    net: eurToMicroEur(env.LIAISON_DEMO_BUDGET_PER_NETWORK_EUR),
    box: eurToMicroEur(env.LIAISON_DEMO_BOX_DAILY_EUR),
    hour: eurToMicroEur(env.LIAISON_DEMO_BOX_HOURLY_EUR),
  }
}

const P = "demo:b"
const PLAIN_KEYS_MOVED = `${P}:plain-addresses-moved`
const spentEmail = (e: string) => `${P}:s:email:${e}`
const spentNet = (n: string, day: string) => `${P}:s:net:${n}:${day}`
const spentBox = (day: string) => `${P}:s:box:${day}`
const spentHour = (bucket: number) => `${P}:s:boxhour:${bucket}`
const resvKey = (id: string) => `${P}:r:${id}`

/**
 * Budgets used to be keyed on the plain address. Move the ledger's rows to the
 * keyed form and drop the Redis keys that name an address (a counter rehydrates
 * from the ledger). Runs its work once per Redis; a failure retries next tick.
 */
export async function rekeyPlainBudgetAddresses(): Promise<void> {
  if (await redis.get(PLAIN_KEYS_MOVED)) return
  const moved = await demoLedgerRekeyPlainEmails(demoBudgetEmailKey)
  let cursor = "0"
  let dropped = 0
  do {
    // SCAN takes and returns full keys; every other command adds the prefix itself.
    const [next, keys] = await redis.scan(
      cursor,
      "MATCH",
      `${REDIS_PREFIX}${P}:*email:*@*`,
      "COUNT",
      500,
    )
    cursor = next
    if (keys.length > 0) {
      dropped += await redis.del(...keys.map((k) => k.slice(REDIS_PREFIX.length)))
    }
  } while (cursor !== "0")
  await redis.set(PLAIN_KEYS_MOVED, "1")
  log.info({ moved, dropped }, "demo budgets moved off plain addresses")
}

/** Per-network counters of past days name a network and serve nothing: delete them. */
export async function pruneElapsedNetworkBudgets(now: number = Date.now()): Promise<number> {
  return demoLedgerPruneNetworkDays(utcDay(now))
}

function hourBuckets(bucket: number): number[] {
  return Array.from({ length: HOUR_BUCKETS }, (_, i) => bucket - i * BUCKET_MS)
}

function ledgerCells(
  identity: DemoSpendIdentity,
  day: string,
  buckets: number[],
): DemoLedgerCell[] {
  return [
    { budget: "email", key: identity.emailNormalized, period: "life" },
    { budget: "net", key: identity.network, period: day },
    { budget: "box", key: "box", period: day },
    ...buckets.map((b) => ({ budget: "boxhour" as const, key: "box", period: String(b) })),
  ]
}

// KEYS 1-3 spent email/net/box, 4 resv, 5-16 hour buckets (5 = the hold's own).
// ARGV 1 now, 2 amount, 3-6 caps email/net/box/hour, 7 ttlMs, 8 rehydrate,
//      9-11 ledger email/net/box, 12-23 ledger hour buckets, 24 org, 25 upstream,
//      26 bucket, 27 day, 28 dayTtlMs, 29 hourTtlMs
const RESERVE_LUA = `
local now = tonumber(ARGV[1])
local amount = tonumber(ARGV[2])
local dayTtl = tonumber(ARGV[28])
local hourTtl = tonumber(ARGV[29])
local function raise(key, value, ttl)
  local cur = tonumber(redis.call('GET', key) or '-1')
  if value > cur then redis.call('SET', key, value) end
  if ttl > 0 then redis.call('PEXPIRE', key, ttl) end
end
if ARGV[8] == '1' then
  raise(KEYS[1], tonumber(ARGV[9]), 0)
  raise(KEYS[2], tonumber(ARGV[10]), dayTtl)
  raise(KEYS[3], tonumber(ARGV[11]), dayTtl)
  for i = 1, 12 do raise(KEYS[4 + i], tonumber(ARGV[11 + i]), hourTtl) end
else
  for i = 1, 3 do
    if redis.call('EXISTS', KEYS[i]) == 0 then return {-1} end
  end
  for i = 1, 12 do
    if redis.call('EXISTS', KEYS[4 + i]) == 0 then return {-1} end
  end
end
local spentE = tonumber(redis.call('GET', KEYS[1]) or '0')
local spentN = tonumber(redis.call('GET', KEYS[2]) or '0')
local spentB = tonumber(redis.call('GET', KEYS[3]) or '0')
local spentH = 0
for i = 1, 12 do spentH = spentH + tonumber(redis.call('GET', KEYS[4 + i]) or '0') end
if spentE + amount > tonumber(ARGV[3]) then return {1} end
if spentN + amount > tonumber(ARGV[4]) then return {2} end
if spentB + amount > tonumber(ARGV[5]) then return {3} end
if spentH + amount > tonumber(ARGV[6]) then return {4} end
redis.call('INCRBY', KEYS[1], amount)
redis.call('INCRBY', KEYS[2], amount)
redis.call('PEXPIRE', KEYS[2], dayTtl)
redis.call('INCRBY', KEYS[3], amount)
redis.call('PEXPIRE', KEYS[3], dayTtl)
redis.call('INCRBY', KEYS[5], amount)
redis.call('PEXPIRE', KEYS[5], hourTtl)
local exp = now + tonumber(ARGV[7])
redis.call('HSET', KEYS[4], 'org', ARGV[24], 'upstream', ARGV[25], 'amount', ARGV[2],
  'bucket', ARGV[26], 'day', ARGV[27], 'exp', exp)
redis.call('PEXPIRE', KEYS[4], tonumber(ARGV[7]))
return {0}
`

// KEYS 1-4 spent email/net/box/hour bucket. ARGV 1 delta.
// A counter that is missing is left missing: the next reserve rehydrates it
// from the ledger, which already carries the delta.
const ADJUST_LUA = `
local delta = tonumber(ARGV[1])
for i = 1, 4 do
  if redis.call('EXISTS', KEYS[i]) == 1 then
    local v = redis.call('INCRBY', KEYS[i], delta)
    if v < 0 then redis.call('INCRBY', KEYS[i], -v) end
  end
end
return 1
`

const REFUSAL_BY_RESULT: Record<number, DemoSpendCode> = {
  1: "demo_budget_exhausted",
  2: "demo_network_exhausted",
  3: "demo_box_exhausted",
  4: "demo_box_exhausted",
}

async function evalNumbers(script: string, keys: string[], args: Array<string | number>) {
  const out = (await redis.eval(script, keys.length, ...keys, ...args.map(String))) as unknown
  return Array.isArray(out) ? out.map((v) => Number(v)) : [Number(out)]
}

function holdCells(r: {
  identity: DemoSpendIdentity
  day: string
  bucket: number
}): DemoLedgerCell[] {
  return [
    { budget: "email", key: r.identity.emailNormalized, period: "life" },
    { budget: "net", key: r.identity.network, period: r.day },
    { budget: "box", key: "box", period: r.day },
    { budget: "boxhour", key: "box", period: String(r.bucket) },
  ]
}

function spentKeys(r: { identity: DemoSpendIdentity; day: string; bucket: number }): string[] {
  return [
    spentEmail(r.identity.emailNormalized),
    spentNet(r.identity.network, r.day),
    spentBox(r.day),
    spentHour(r.bucket),
  ]
}

/**
 * Reserve one step's worst cost on all four budgets, atomically, and write it
 * to the ledger as spent (the pending-settle record) before the call may run.
 * Throws `DemoBudgetRefusal` naming the first budget without room, or
 * `demo_unavailable` when the ledger cannot take the hold (fails closed).
 */
export async function reserveStep(
  identity: DemoSpendIdentity,
  upstreamId: string,
  maxMicroEur: number,
  orgId: string,
): Promise<DemoReservation> {
  const now = nowFn()
  const day = utcDay(now)
  const bucket = bucketOf(now)
  const buckets = hourBuckets(bucket)
  const caps = demoBudgetCaps()
  const amount = Math.max(1, Math.ceil(maxMicroEur))
  const id = crypto.randomUUID()
  const keys = [
    spentEmail(identity.emailNormalized),
    spentNet(identity.network, day),
    spentBox(day),
    resvKey(id),
    ...buckets.map(spentHour),
  ]
  const run = (rehydrate: number[] | null) =>
    evalNumbers(RESERVE_LUA, keys, [
      now,
      amount,
      caps.email,
      caps.net,
      caps.box,
      caps.hour,
      RESERVATION_TTL_MS,
      rehydrate ? "1" : "0",
      ...(rehydrate ?? Array.from({ length: 15 }, () => 0)),
      orgId,
      upstreamId,
      bucket,
      day,
      DAY_TTL_MS,
      HOUR_TTL_MS,
    ])
  let [result] = await run(null)
  if (result === -1) {
    // A counter is missing (first use, a new bucket, or a Redis flush): read
    // the ledger and let the script raise each counter to it.
    const ledger = await demoLedgerRead(ledgerCells(identity, day, buckets))
    ;[result] = await run(ledger)
  }
  if (result !== 0) {
    throw new DemoBudgetRefusal(REFUSAL_BY_RESULT[result ?? 3] ?? "demo_box_exhausted")
  }
  const reservation: DemoReservation = {
    id,
    orgId,
    provider: "openrouter",
    upstreamId,
    maxMicroEur: amount,
    expiresAt: now + RESERVATION_TTL_MS,
    identity,
    day,
    bucket,
  }
  try {
    await demoLedgerAdd(holdCells(reservation), amount)
  } catch (err) {
    // No durable record of the hold: the call must not run. Give Redis back
    // its room and refuse.
    log.error(
      { err, alert: "demo_ledger_write", reservationId: id },
      "demo spend ledger write failed at reserve: the step is refused",
    )
    try {
      await redis.del(resvKey(id))
      await evalNumbers(ADJUST_LUA, spentKeys(reservation), [-amount])
    } catch (undoErr) {
      log.warn({ err: undoErr, reservationId: id }, "demo budget: undoing a refused hold failed")
    }
    throw new DemoBudgetRefusal("demo_unavailable")
  }
  return reservation
}

/** Retries of a Redis counter reset after a settle that reached the ledger but not Redis. */
const COUNTER_RESET_RETRY_MS = [1_000, 5_000, 30_000]

/**
 * Drop the four spent counters of a hold so the next reserve rehydrates them
 * from the ledger (best effort: the first try is awaited, later ones are
 * scheduled). Called when a settle reached the ledger and not Redis.
 */
async function resetCounters(keys: string[], attempt = 0): Promise<void> {
  try {
    await redis.del(...keys)
  } catch (err) {
    const wait = COUNTER_RESET_RETRY_MS[attempt]
    if (wait === undefined) {
      log.error(
        { err, alert: "demo_budget_redis" },
        "demo budget counters could not be reset after a settle; they stay over-counted",
      )
      return
    }
    setTimeout(() => void resetCounters(keys, attempt + 1), wait).unref?.()
  }
}

/**
 * Close a hold at `actual`: the hold was charged at its max when reserved
 * (Redis and the ledger), so the difference is handed back to both. Claims
 * the hold first, so a hold closes once. Returns the ledger's new totals, or
 * null when nothing was handed back (already closed, expired, or a store
 * failed: the step then stays counted at its max).
 */
async function closeHold(reservation: DemoReservation, actual: number): Promise<number[] | null> {
  let claimed: number
  try {
    claimed = await redis.del(resvKey(reservation.id))
  } catch (err) {
    log.error(
      { err, alert: "demo_budget_redis", reservationId: reservation.id },
      "demo budget: a hold could not be claimed; the step stays counted at its max",
    )
    return null
  }
  // Expired (or already closed): the step stays counted at its max.
  if (claimed !== 1 || nowFn() > reservation.expiresAt) return null
  const delta = actual - reservation.maxMicroEur
  let totals: number[]
  try {
    totals = await demoLedgerAdd(holdCells(reservation), delta)
  } catch (err) {
    log.error(
      { err, alert: "demo_ledger_write", reservationId: reservation.id, actual },
      "demo spend ledger write failed at settle: the step stays counted at its max",
    )
    return null
  }
  if (delta === 0) return totals
  try {
    if (failCounterAdjust) throw new Error("demo budget counter adjust refused (test)")
    await evalNumbers(ADJUST_LUA, spentKeys(reservation), [delta])
  } catch (err) {
    log.error(
      { err, alert: "demo_budget_redis", reservationId: reservation.id },
      "demo budget settle failed in Redis after the ledger write; the counters are reset",
    )
    await resetCounters(spentKeys(reservation))
  }
  return totals
}

/**
 * Settle a step at what it actually cost (all four cells, in the
 * reservation's own day and bucket). Never throws: the call it settles has
 * already been made. A step whose settle fails anywhere stays counted at its
 * reserved max, in the ledger and in Redis.
 */
export async function settleStep(
  reservation: DemoReservation,
  actualMicroEur: number,
): Promise<void> {
  const actual = Math.max(0, Math.ceil(actualMicroEur))
  const totals = await closeHold(reservation, actual)
  try {
    const box =
      totals?.[2] ??
      (await demoLedgerRead([{ budget: "box", key: "box", period: reservation.day }]))[0] ??
      0
    const hour = await hourSpent(reservation.bucket)
    await notifyDemoSpendSettled({
      day: reservation.day,
      boxDayMicroEur: box,
      boxHourMicroEur: hour,
      caps: demoBudgetCaps(),
    })
  } catch (err) {
    log.warn({ err }, "demo spend alert check failed")
  }
}

/**
 * Drop a hold without spending: ONLY for a step whose request was never sent
 * (a refused or cancelled step). Never throws.
 */
export async function releaseReservation(reservation: DemoReservation): Promise<void> {
  try {
    await closeHold(reservation, 0)
  } catch (err) {
    log.warn({ err, reservationId: reservation.id }, "failed to release a demo reservation")
  }
}

/**
 * Is this reservation still a live hold for `orgId`: its hash exists (not
 * settled, not released, not expired), it names the same org, and its expiry
 * is ahead of now?
 */
export async function isLive(reservation: DemoReservation, orgId?: string): Promise<boolean> {
  const h = await redis.hgetall(resvKey(reservation.id))
  if (!h?.org) return false
  if (h.org !== reservation.orgId) return false
  if (orgId !== undefined && h.org !== orgId) return false
  if (h.upstream !== reservation.upstreamId) return false
  return Number(h.exp) > nowFn()
}

async function hourSpent(bucket: number): Promise<number> {
  const values = await redis.mget(...hourBuckets(bucket).map(spentHour))
  return values.reduce((sum, v) => sum + Number(v ?? 0), 0)
}

/** What an identity has spent and may spend, and whether the box is out (for the budget route). */
export async function snapshot(identity: DemoSpendIdentity): Promise<{
  usedMicroEur: number
  capMicroEur: number
  networkUsedMicroEur: number
  boxExhausted: boolean
}> {
  const now = nowFn()
  const day = utcDay(now)
  const caps = demoBudgetCaps()
  const ledger = await demoLedgerRead([
    { budget: "email", key: identity.emailNormalized, period: "life" },
    { budget: "net", key: identity.network, period: day },
    { budget: "box", key: "box", period: day },
  ])
  const [cachedE, cachedN, cachedB] = await redis.mget(
    spentEmail(identity.emailNormalized),
    spentNet(identity.network, day),
    spentBox(day),
  )
  const used = Math.max(ledger[0] ?? 0, Number(cachedE ?? 0))
  const net = Math.max(ledger[1] ?? 0, Number(cachedN ?? 0))
  const box = Math.max(ledger[2] ?? 0, Number(cachedB ?? 0))
  const hour = await hourSpent(bucketOf(now))
  return {
    usedMicroEur: used,
    capMicroEur: caps.email,
    networkUsedMicroEur: net,
    boxExhausted: box >= caps.box || hour >= caps.hour,
  }
}

/**
 * The budget of a demo org's visitor for `GET /api/demo/budget`: what its
 * verified email has spent of its cap, and whether the box is out. Null when
 * the org has no verified identity (an unverified visitor, a normal org).
 */
export async function demoBudgetSnapshotForOrg(
  orgId: string,
): Promise<{ usedMicroEur: number; capMicroEur: number; boxExhausted: boolean } | null> {
  const identity = await currentVerifiedIdentity(orgId)
  if (!identity) return null
  const s = await snapshot(identity)
  return { usedMicroEur: s.usedMicroEur, capMicroEur: s.capMicroEur, boxExhausted: s.boxExhausted }
}

// ── Turn slots and turn rate ────────────────────────────────────────────────

// KEYS 1 box slots, 2 email slots.
// ARGV 1 now, 2 turn id, 3 slot ttl, 4 box cap, 5 email cap.
// No per-minute turn rate: the spend budget is the visitor's limit, and a
// scenario's own routine runs and resumes used to count against it and refuse
// the person's next message.
const ACQUIRE_TURN_LUA = `
local now = tonumber(ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[4]) then return 2 end
if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[5]) then return 2 end
local exp = now + tonumber(ARGV[3])
redis.call('ZADD', KEYS[1], exp, ARGV[2])
redis.call('ZADD', KEYS[2], exp, ARGV[2])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]))
redis.call('PEXPIRE', KEYS[2], tonumber(ARGV[3]))
return 0
`

/** A turn's slot in the concurrency limits, released when the turn ends. */
export interface DemoTurnSlot {
  id: string
  emailNormalized: string
}

const boxTurns = () => `${P}:t:box`
const emailTurns = (e: string) => `${P}:t:email:${e}`

/**
 * Take a turn slot: refused `demo_busy` when the box or this email has no free
 * slot. Subruns and routine runs are turns here too.
 */
export async function acquireTurnSlot(identity: DemoSpendIdentity): Promise<DemoTurnSlot> {
  const id = crypto.randomUUID()
  const [result] = await evalNumbers(
    ACQUIRE_TURN_LUA,
    [boxTurns(), emailTurns(identity.emailNormalized)],
    [
      nowFn(),
      id,
      TURN_SLOT_TTL_MS,
      env.LIAISON_DEMO_BOX_CONCURRENT_TURNS,
      env.LIAISON_DEMO_EMAIL_CONCURRENT_TURNS,
    ],
  )
  if (result !== 0) throw new DemoBudgetRefusal("demo_busy")
  return { id, emailNormalized: identity.emailNormalized }
}

/** Give a turn slot back. Never throws. */
export async function releaseTurnSlot(slot: DemoTurnSlot): Promise<void> {
  try {
    await redis.zrem(boxTurns(), slot.id)
    await redis.zrem(emailTurns(slot.emailNormalized), slot.id)
  } catch (err) {
    log.warn({ err }, "failed to release a demo turn slot")
  }
}

// ── web_search counters ─────────────────────────────────────────────────────

// KEYS 1 per turn, 2 per email per day. ARGV 1 turn cap, 2 day cap.
const WEB_SEARCH_LUA = `
if tonumber(redis.call('GET', KEYS[1]) or '0') >= tonumber(ARGV[1]) then return 1 end
if tonumber(redis.call('GET', KEYS[2]) or '0') >= tonumber(ARGV[2]) then return 2 end
redis.call('INCR', KEYS[1])
redis.call('PEXPIRE', KEYS[1], 3600000)
redis.call('INCR', KEYS[2])
redis.call('PEXPIRE', KEYS[2], 172800000)
return 0
`

/**
 * Count one web search against the turn's and the email's daily allowance, or
 * refuse it ("turn" | "day"). `turnKey` is the turn's run id.
 */
export async function takeWebSearch(
  identity: DemoSpendIdentity,
  turnKey: string,
): Promise<"ok" | "turn" | "day"> {
  const day = utcDay(nowFn())
  const [result] = await evalNumbers(
    WEB_SEARCH_LUA,
    [`${P}:ws:turn:${turnKey}`, `${P}:ws:email:${identity.emailNormalized}:${day}`],
    [env.LIAISON_DEMO_WEB_SEARCH_PER_TURN, env.LIAISON_DEMO_WEB_SEARCH_PER_EMAIL_PER_DAY],
  )
  if (result === 1) return "turn"
  if (result === 2) return "day"
  return "ok"
}

// ── The visitor entry point ─────────────────────────────────────────────────

/**
 * The spend identity of a visitor org, or a refusal: visitor spend is off
 * (`demo_unavailable`, demo-alerts.ts) or the visitor has not confirmed an
 * email (`demo_verification_required`).
 */
export async function visitorSpendIdentity(orgId: string): Promise<DemoSpendIdentity> {
  const { locale } = await loadDemoOrg(orgId)
  if ((await demoVisitorSpendState()) !== "on") {
    throw new DemoSpendRefusedError("demo_unavailable", locale)
  }
  const identity = await currentVerifiedIdentity(orgId)
  if (!identity) {
    // The line points at the inbox only when a code is there to find: a box
    // that could not send one says so, as the band and the tour step do (D40).
    const sent = await demoCodeOnRecord(orgId).catch(() => true)
    throw new DemoReservationRequiredError(
      "demo_verification_required",
      locale,
      sent ? undefined : serverT(locale, "kernel.demo.refusal.demo_verification_unsent"),
    )
  }
  return identity
}

/**
 * Reserve one step for a visitor org on the box key: identity first, then the
 * four budgets. Throws `DemoSpendRefusedError` with the refusal's code.
 */
export async function reserveVisitorStep(
  orgId: string,
  upstreamId: string,
  maxMicroEur: number,
  identity?: DemoSpendIdentity,
): Promise<DemoReservation> {
  const who = identity ?? (await visitorSpendIdentity(orgId))
  try {
    return await reserveStep(who, upstreamId, maxMicroEur, orgId)
  } catch (err) {
    if (err instanceof DemoBudgetRefusal) {
      const { locale } = await loadDemoOrg(orgId)
      throw new DemoSpendRefusedError(err.code, locale)
    }
    throw err
  }
}

/** A turn slot for a visitor org, or a coded refusal (`demo_busy`, `demo_rate_limited`). */
export async function acquireVisitorTurnSlot(
  orgId: string,
  identity: DemoSpendIdentity,
): Promise<DemoTurnSlot> {
  try {
    return await acquireTurnSlot(identity)
  } catch (err) {
    if (err instanceof DemoBudgetRefusal) {
      const { locale } = await loadDemoOrg(orgId)
      throw new DemoSpendRefusedError(err.code, locale)
    }
    throw err
  }
}
