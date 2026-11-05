// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The effect sink: where a load org's outside effects go instead of outside.
 *
 * A load org (lib/load-harness.ts `isLoadOrg`) sends no mail, webhook or push
 * off the box. What an app sends is kept on the box by the demo egress
 * lockdown, not here: the harness key boots only on a demo box (lib/env.ts). Each sender asks `isLoadOrg` first and, for a load org, calls
 * `recordSinkEffect` with the effect's idempotency key: the sink counts the
 * key (`INCR`) and appends it to a time-ordered log, and the stress report
 * reads both. A key counted more than once is a doubled effect (spec A13
 * `doubledEffects`), which is the measurement S11 is about.
 *
 * Detail is kept only where the harness must read it back to go on (the demo
 * door's verification code), under a one-hour TTL. Nothing here is ever sent
 * anywhere.
 */
import { redis } from "~/lib/redis"

export type SinkEffectKind = "mail" | "webhook" | "push" | "demo-code"

/** Counts and details live a day: a stress run reads them right after it ends. */
const COUNT_TTL_S = 24 * 3600
const DETAIL_TTL_S = 3600
const LOG_KEY = "load-harness:sink:log"
const LOG_MAX = 100_000
/**
 * Each org also has its own log, which is what the harness reads back: a read
 * touches only that org's entries, and a busy box's other orgs can never evict
 * the first copy of a doubled effect before it is read.
 */
const ORG_LOG_MAX = 20_000

function orgLogKey(orgId: string): string {
  return `load-harness:sink:log:${orgId}`
}

function countKey(orgId: string, kind: SinkEffectKind, key: string): string {
  return `load-harness:sink:count:${orgId}:${kind}:${key}`
}

function detailKey(orgId: string, kind: SinkEffectKind, key: string): string {
  return `load-harness:sink:detail:${orgId}:${kind}:${key}`
}

/**
 * Count one effect a load org would have caused. Returns the key's count
 * after this one (1 the first time; above 1 means the effect was doubled).
 */
export async function recordSinkEffect(
  orgId: string,
  kind: SinkEffectKind,
  key: string,
  detail?: string,
): Promise<number> {
  const ck = countKey(orgId, kind, key)
  const now = Date.now()
  // A sorted set keeps one copy of a member: two effects in the same
  // millisecond would collapse into one, hiding exactly the doubled effect the
  // sink exists to find. The nonce keeps each occurrence its own member.
  const member = `${now}:${crypto.randomUUID().slice(0, 8)}|${orgId}|${kind}|${key}`
  const ok = orgLogKey(orgId)
  const tx = redis
    .multi()
    .incr(ck)
    .expire(ck, COUNT_TTL_S)
    .zadd(LOG_KEY, now, member)
    .zremrangebyrank(LOG_KEY, 0, -(LOG_MAX + 1))
    .expire(LOG_KEY, COUNT_TTL_S)
    .zadd(ok, now, member)
    .zremrangebyrank(ok, 0, -(ORG_LOG_MAX + 1))
    .expire(ok, COUNT_TTL_S)
  if (detail !== undefined) tx.set(detailKey(orgId, kind, key), detail, "EX", DETAIL_TTL_S)
  const res = await tx.exec()
  const count = res?.[0]?.[1]
  return typeof count === "number" ? count : Number(count ?? 0)
}

/** How many times the sink saw this effect (0 when never). */
export async function sinkCount(orgId: string, kind: SinkEffectKind, key: string): Promise<number> {
  const v = await redis.get(countKey(orgId, kind, key))
  return v ? Number(v) : 0
}

/** The detail recorded with an effect, or null. */
export async function sinkDetail(
  orgId: string,
  kind: SinkEffectKind,
  key: string,
): Promise<string | null> {
  return redis.get(detailKey(orgId, kind, key))
}

export interface SinkLogEntry {
  at: number
  orgId: string
  kind: SinkEffectKind
  key: string
}

/** The sink's log since `sinceMs`, oldest first (at most `limit` entries). */
export async function sinkLog(sinceMs = 0, limit = 10_000): Promise<SinkLogEntry[]> {
  return parseLog(await redis.zrangebyscore(LOG_KEY, sinceMs, "+inf", "LIMIT", 0, limit))
}

function parseLog(members: string[]): SinkLogEntry[] {
  return members.map((m) => {
    const [stamp, orgId, kind, ...rest] = m.split("|")
    const at = (stamp ?? "").split(":")[0]
    return { at: Number(at), orgId: orgId ?? "", kind: kind as SinkEffectKind, key: rest.join("|") }
  })
}

/** The keys seen more than once since `sinceMs`: the doubled effects. */
export async function sinkDoubled(sinceMs = 0): Promise<Array<SinkLogEntry & { count: number }>> {
  const seen = new Map<string, SinkLogEntry & { count: number }>()
  for (const entry of await sinkLog(sinceMs, LOG_MAX)) {
    const id = `${entry.orgId}|${entry.kind}|${entry.key}`
    const prev = seen.get(id)
    if (prev) prev.count++
    else seen.set(id, { ...entry, count: 1 })
  }
  return [...seen.values()].filter((e) => e.count > 1)
}

export interface SinkOrgEntry {
  kind: SinkEffectKind
  key: string
  /** How many times the sink saw it (above 1 = doubled). */
  count: number
  firstAt: number
  lastAt: number
}

/**
 * One org's sink entries since `sinceMs`, one per effect key with its count,
 * oldest first, read from the org's own log (never a scan of the box-wide
 * one). The harness's read route (modules/demo/routes.ts) serves it
 * for a load org only.
 */
export async function sinkEntriesForOrg(orgId: string, sinceMs = 0): Promise<SinkOrgEntry[]> {
  const byKey = new Map<string, SinkOrgEntry>()
  const members = await redis.zrangebyscore(
    orgLogKey(orgId),
    sinceMs,
    "+inf",
    "LIMIT",
    0,
    ORG_LOG_MAX,
  )
  for (const entry of parseLog(members)) {
    const id = `${entry.kind}|${entry.key}`
    const prev = byKey.get(id)
    if (prev) {
      prev.count++
      prev.lastAt = entry.at
    } else {
      byKey.set(id, {
        kind: entry.kind,
        key: entry.key,
        count: 1,
        firstAt: entry.at,
        lastAt: entry.at,
      })
    }
  }
  return [...byKey.values()]
}
