// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Burst collapse: many live notifications for one person in a short window
 * reach their devices as ONE summary ("Agent: 23 new messages in 23 tasks"),
 * not as a wall of banners. The items themselves are untouched: every
 * attention row is written and readable in the in-app inbox as before, and
 * the email digest batches on its own cadence. Only the live channels (push,
 * desktop, Web Push) are collapsed.
 *
 * It sits right after the router, at the two places a live notification
 * leaves (push/fanout-consumer.ts for chat messages, dispatch.ts for every
 * other attention row): the router decides whether an item may interrupt the
 * person, then this gate decides whether it interrupts them NOW or joins the
 * burst's summary. A held item's push and desktop channels are logged as
 * `suppressed` with reason `burst` (S1), like any other router hold.
 *
 * The rule, per recipient (org + user):
 *   - a sliding window of BURST_WINDOW_MS (60 s) counts live items;
 *   - the first BURST_THRESHOLD - 1 (3) items of a window notify one by one,
 *     so an ordinary exchange (a few messages a minute) is untouched;
 *   - the BURST_THRESHOLD-th item opens a burst: it and every later item are
 *     held, and the summary goes out once the burst has been quiet for
 *     BURST_QUIET_MS (10 s), or BURST_MAX_WAIT_MS (60 s) after it opened,
 *     whichever comes first, so a stream that never stops still says
 *     something every minute;
 *   - the summary counts the whole burst (the items already shown included),
 *     replaces the previous summary on the device (collapse id / tag), and
 *     a stream that keeps going after a summary is summarized again from its
 *     SECOND item (one message after a summary is just that message);
 *   - a DIRECT ASK (a direct message, an @mention of the person, an urgent
 *     item such as an approval they can decide; router `isDirectAsk`)
 *     notifies individually and is not counted, unless it is the burst's own
 *     actor's: an agent that mentions you in 23 notes is one burst, a
 *     colleague's message in the middle of it is not. An urgent item never
 *     joins a burst.
 *
 * State is five Redis keys per recipient, all in one Cluster hash slot
 * (`{org:user}` tag), changed atomically by Lua scripts run by EVALSHA
 * (several API instances fan out concurrently). The summary is sent by a
 * delayed kernel job (BURST_FLUSH_JOB, retried with backoff), whose arm point
 * is kept in the burst's state: an arm overdue by BURST_ARM_STALE_MS (a lost
 * job) is re-armed by the next held item. The job reads the burst, sends the
 * summary, and only then removes what it covered, so a failed send is retried,
 * never dropped; the keys outlive the burst's due time by BURST_STATE_SLACK_MS
 * so a late queue still finds them. The gate fails OPEN: if Redis is
 * unreachable, or the summary cannot be armed, the item is notified as before
 * (and what the burst held so far is summarized at once).
 */
import { createHash } from "node:crypto"
import type { ShippedLocale } from "@liaison/shared"
import type Redis from "ioredis"
import { enqueueAppJob } from "~/infra/jobs/jobs"
import { rootLogger } from "~/lib/logger"
import { redis as defaultRedis } from "~/lib/redis"
import { serverT } from "~/modules/i18n/server-i18n"
import type { PushPayload } from "~/modules/push/types"
import { type DeliveryRecord, recordDeliveries, routerSuppressionRecords } from "./delivery-log"
import type { DesktopNotifyPayload } from "./desktop-emitter"
import {
  burstHeldDecision,
  burstSummaryDecision,
  notificationIdFor,
  type RouterDecision,
} from "./router"

const log = rootLogger.child({ module: "notifications-burst" })

/** The sliding window live items are counted in. */
export const BURST_WINDOW_MS = 60_000
/** The item of a window that opens a burst (the ones before it notify one by one). */
export const BURST_THRESHOLD = 4
/** The summary waits for this much quiet... */
export const BURST_QUIET_MS = 10_000
/** ...but never longer than this after the burst opened. */
export const BURST_MAX_WAIT_MS = 60_000
/** The most items one burst keeps for its summary (the count goes on past it). */
export const BURST_MAX_ITEMS = 500
/** The kernel job that sends a burst's summary. */
export const BURST_FLUSH_JOB = "notify-burst-flush"

/** What the gate needs to know about one live item. */
export interface BurstItem {
  /** The item's idempotency key (`message:<id>`, `attention:<rowId>`). */
  notifyId: string
  /** Who caused it (`agent:<name>`, `user:<id>`), null when nobody in particular. */
  actorKey: string | null
  /** The actor's display name, for the summary title. */
  actorName: string | null
  /** The conversation it belongs to: a thread id, else the item's route. */
  conversation: string
  /** "task" when the conversation is a task's discussion. */
  conversationKind: "task" | "conversation"
  /** A chat message, or any other attention item. */
  kind: "message" | "notification"
  /** A mention of the person, or an urgent item (an approval they decide). */
  important: boolean
  /** The item's text is redacted (D14): the summary then names nobody. */
  redacted: boolean
}

/** One entry as stored: the item plus what its live channels were going to do. */
interface StoredEntry {
  n: string
  a: string | null
  an: string | null
  c: string
  ck: "task" | "conversation"
  k: "message" | "notification"
  r: boolean
  /** The router delivered push / desktop for it. */
  pushOn: boolean
  desktopOn: boolean
  /** Already shown on its own (it preceded the burst). */
  s?: true
}

export interface BurstFlushJob {
  orgId: string
  userId: string
  /** The burst it summarizes (its `openedAt`). Absent on jobs from before it existed. */
  burstId?: string
}

export interface BurstDeps {
  redis?: Redis
  now?: () => number
  /**
   * Arms the summary for `armAt` (= now + delayMs). Defaults to a delayed
   * kernel job whose id is stable per (burst, armAt), so two arms of the same
   * point are one job. Throwing is a failure to arm (the gate then fails open).
   */
  scheduleFlush?: (job: BurstFlushJob, delayMs: number, armAt: number) => Promise<void>
  /** The delivery log writer. Defaults to `recordDeliveries`. */
  record?: (rows: DeliveryRecord[]) => Promise<void>
}

export type BurstVerdict = "send" | "held"

/**
 * Past its arm point by this much, a summary nobody drained is presumed lost
 * (a dropped job, a queue that refused it) and the next held item re-arms it.
 */
export const BURST_ARM_STALE_MS = 30_000
/**
 * A burst's keys outlive its latest due time by this much, so a queue running
 * minutes late still finds the burst it was armed for.
 */
export const BURST_STATE_SLACK_MS = 15 * 60_000
/** A summary being sent holds the burst this long against a second drain. */
const FLUSH_LEASE_MS = 30_000
/** Attempts of one summary job, with exponential backoff from 2 s. */
const FLUSH_ATTEMPTS = 4

/**
 * The keys of one recipient's burst. Every name carries the `{org:user}` hash
 * tag, so a Redis Cluster puts them in one slot and a script touching several
 * never fails with CROSSSLOT.
 */
export function burstKeys(orgId: string, userId: string) {
  const tag = `{${orgId}:${userId}}`
  return {
    window: `notify-burst:${tag}:w`,
    held: `notify-burst:${tag}:h`,
    open: `notify-burst:${tag}:o`,
    recent: `notify-burst:${tag}:r`,
    /** The `openedAt` of the last burst whose summary went out. */
    done: `notify-burst:${tag}:d`,
  }
}

// KEYS: window, held, open, recent
// ARGV: now, window ms, threshold, entry json, important, actor key, quiet ms,
//       max wait ms, slack ms, max items, arm stale ms
// Returns {"send"} | {"held", arm, openedAt, armAt}: arm "1" when the caller
// must arm the summary for armAt (the burst opened, or its armed summary is
// overdue and presumed lost).
const ADMIT_SCRIPT = `
local now = tonumber(ARGV[1])
local win = tonumber(ARGV[2])
local thr = tonumber(ARGV[3])
local entry = ARGV[4]
local important = ARGV[5] == "1"
local actor = ARGV[6]
local quiet = tonumber(ARGV[7])
local maxWait = tonumber(ARGV[8])
local slack = tonumber(ARGV[9])
local maxItems = tonumber(ARGV[10])
local stale = tonumber(ARGV[11])
redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", now - win)
local function onlyActor(list)
  if actor == "" then return false end
  for _, e in ipairs(list) do
    local ok, d = pcall(cjson.decode, e)
    if not ok or d.a ~= actor then return false end
  end
  return true
end
local function sameActorHeld()
  if actor == "" then return false end
  for _, e in ipairs(redis.call("LRANGE", KEYS[2], 0, -1)) do
    local ok, d = pcall(cjson.decode, e)
    if ok and d.a == actor and not d.s then return true end
  end
  return false
end
local function hold(state)
  state.total = (state.total or 0) + 1
  state.lastAt = now
  if redis.call("LLEN", KEYS[2]) < maxItems then redis.call("RPUSH", KEYS[2], entry) end
  local arm = "0"
  local armedAt = tonumber(state.armAt or 0)
  if armedAt == 0 or now > armedAt + stale then
    state.armAt = math.min(now + quiet, state.openedAt + maxWait)
    if state.armAt < now then state.armAt = now end
    arm = "1"
  end
  local ttl = math.max(state.openedAt + maxWait - now, 0) + slack
  redis.call("SET", KEYS[3], cjson.encode(state), "PX", ttl)
  redis.call("PEXPIRE", KEYS[2], ttl)
  return {"held", arm, tostring(state.openedAt), tostring(state.armAt)}
end
local open = redis.call("GET", KEYS[3])
if open then
  -- A direct ask from anyone but the burst's own actor notifies on its own
  -- and is not counted.
  if important and not sameActorHeld() then return {"send"} end
  redis.call("ZADD", KEYS[1], now, entry)
  redis.call("PEXPIRE", KEYS[1], win)
  return hold(cjson.decode(open))
end
local before = redis.call("ZRANGE", KEYS[1], 0, -1)
-- A direct ask joins the count only when the window is its actor's own
-- stream (an agent mentioning the person in every note).
if important and not onlyActor(before) then return {"send"} end
redis.call("ZADD", KEYS[1], now, entry)
redis.call("PEXPIRE", KEYS[1], win)
local n = #before + 1
-- Right after a summary the next burst opens on the second item: one message
-- on its own is that message, not a "1 new message" summary.
local need = thr
if redis.call("EXISTS", KEYS[4]) == 1 then need = 2 end
if n < need then return {"send"} end
local state = { openedAt = now, total = 0 }
-- The items of the window already shown join the summary's count.
for _, e in ipairs(before) do
  local ok, d = pcall(cjson.decode, e)
  if ok then
    d.s = true
    if redis.call("LLEN", KEYS[2]) < maxItems then redis.call("RPUSH", KEYS[2], cjson.encode(d)) end
    state.total = state.total + 1
  end
end
return hold(state)
`

// KEYS: held, open
// ARGV: now, quiet ms, max wait ms, lease ms, force
// Reads a due burst WITHOUT removing it (COMMIT does, once the summary is out).
// Returns {"none"} | {"busy"} | {"wait", ms, openedAt, armAt}
//       | {"flush", total, openedAt, count, entry...}
const DRAIN_SCRIPT = `
local now = tonumber(ARGV[1])
local quiet = tonumber(ARGV[2])
local maxWait = tonumber(ARGV[3])
local lease = tonumber(ARGV[4])
local force = ARGV[5] == "1"
local open = redis.call("GET", KEYS[2])
if not open then return {"none"} end
local s = cjson.decode(open)
local ttl = redis.call("PTTL", KEYS[2])
if ttl < 1 then ttl = 60000 end
if not force then
  if s.flushing and now < s.flushing + lease then return {"busy"} end
  local due = math.min(s.lastAt + quiet, s.openedAt + maxWait)
  if now < due then
    s.armAt = due
    redis.call("SET", KEYS[2], cjson.encode(s), "PX", ttl)
    return {"wait", tostring(due - now), tostring(s.openedAt), tostring(due)}
  end
end
s.flushing = now
redis.call("SET", KEYS[2], cjson.encode(s), "PX", ttl)
local items = redis.call("LRANGE", KEYS[1], 0, -1)
local out = {"flush", tostring(s.total or #items), tostring(s.openedAt), tostring(#items)}
for _, e in ipairs(items) do out[#out + 1] = e end
return out
`

// KEYS: held, open, window, recent, done
// ARGV: now, openedAt, count, total, window ms, quiet ms, max wait ms, slack ms
// The summary of (openedAt) went out: drop the `count` items it covered. Items
// held while it was sent start the next burst.
// Returns {"gone"} | {"done"} | {"rearm", ms, openedAt, armAt}
const COMMIT_SCRIPT = `
local now = tonumber(ARGV[1])
local count = tonumber(ARGV[3])
local total = tonumber(ARGV[4])
local win = tonumber(ARGV[5])
local quiet = tonumber(ARGV[6])
local maxWait = tonumber(ARGV[7])
local slack = tonumber(ARGV[8])
local open = redis.call("GET", KEYS[2])
if not open then return {"gone"} end
local s = cjson.decode(open)
if tostring(s.openedAt) ~= ARGV[2] then return {"gone"} end
redis.call("SET", KEYS[5], ARGV[2], "PX", win + slack)
-- A stream that goes on after this summary is summarized again, not
-- restarted with single banners.
redis.call("SET", KEYS[4], "1", "PX", win)
redis.call("LTRIM", KEYS[1], count, -1)
local rest = redis.call("LLEN", KEYS[1])
local after = (s.total or 0) - total
if rest == 0 and after <= 0 then
  redis.call("DEL", KEYS[1], KEYS[2], KEYS[3])
  return {"done"}
end
local n = { openedAt = now, total = math.max(rest, after), lastAt = s.lastAt or now }
n.armAt = math.min(now + quiet, now + maxWait)
local ttl = maxWait + slack
redis.call("SET", KEYS[2], cjson.encode(n), "PX", ttl)
redis.call("PEXPIRE", KEYS[1], ttl)
redis.call("DEL", KEYS[3])
return {"rearm", tostring(n.armAt - now), tostring(n.openedAt), tostring(n.armAt)}
`

// KEYS: open
// ARGV: openedAt
// The summary of (openedAt) failed: free it for the job's retry, and mark its
// arm overdue so a later item re-arms it if every retry is lost too.
const RELEASE_SCRIPT = `
local open = redis.call("GET", KEYS[1])
if not open then return 0 end
local s = cjson.decode(open)
if tostring(s.openedAt) ~= ARGV[1] then return 0 end
s.flushing = nil
s.armAt = 1
local ttl = redis.call("PTTL", KEYS[1])
if ttl < 1 then ttl = 60000 end
redis.call("SET", KEYS[1], cjson.encode(s), "PX", ttl)
return 1
`

interface Script {
  source: string
  sha: string
}

const script = (source: string): Script => ({
  source,
  sha: createHash("sha1").update(source).digest("hex"),
})

const ADMIT = script(ADMIT_SCRIPT)
const DRAIN = script(DRAIN_SCRIPT)
const COMMIT = script(COMMIT_SCRIPT)
const RELEASE = script(RELEASE_SCRIPT)

/** EVALSHA, loading the script (EVAL) when this Redis has not cached it yet. */
async function runScript(
  r: Redis,
  s: Script,
  keys: readonly string[],
  args: readonly string[],
): Promise<unknown> {
  try {
    return await r.evalsha(s.sha, keys.length, ...keys, ...args)
  } catch (err) {
    if (!(err instanceof Error) || !err.message.startsWith("NOSCRIPT")) throw err
    return await r.eval(s.source, keys.length, ...keys, ...args)
  }
}

/** The logical job id of one arm of one burst's summary (stable: re-arming the same point is one job). */
export function burstFlushJobId(job: BurstFlushJob, armAt: number): string {
  return `notify-burst:${job.orgId}:${job.userId}:${job.burstId ?? "0"}:${armAt}`
}

const defaultScheduleFlush = async (
  job: BurstFlushJob,
  delayMs: number,
  armAt: number,
): Promise<void> => {
  await enqueueAppJob("kernel", BURST_FLUSH_JOB, job, {
    jobId: burstFlushJobId(job, armAt),
    delay: Math.max(0, delayMs),
    attempts: FLUSH_ATTEMPTS,
    backoff: { type: "exponential", delay: 2_000 },
  })
}

function storedOf(item: BurstItem, decision: RouterDecision): StoredEntry {
  return {
    n: item.notifyId,
    a: item.actorKey,
    an: item.actorName,
    c: item.conversation,
    ck: item.conversationKind,
    k: item.kind,
    r: item.redacted,
    pushOn: decision.channels.push.deliver,
    desktopOn: decision.channels.desktop.deliver,
  }
}

/**
 * The gate. True when the item is HELD for the burst's summary: the producer
 * then sends nothing live for it (its in-app row is already written), and the
 * hold is logged here. False: the item notifies now with the router's own
 * decision. An item that was not going live anyway is not counted, nor is an
 * urgent one (an approval the person decides). Never throws, and fails OPEN:
 * when Redis or the summary's arming fails, the item notifies now and what
 * the burst held so far is summarized at once.
 */
export async function admitBurst(
  decision: RouterDecision,
  item: BurstItem,
  deps: BurstDeps = {},
): Promise<boolean> {
  if (!decision.channels.push.deliver && !decision.channels.desktop.deliver) return false
  if (decision.urgent) return false
  const r = deps.redis ?? defaultRedis
  const now = (deps.now ?? Date.now)()
  const k = burstKeys(decision.orgId, decision.userId)
  let reply: string[]
  try {
    reply = (await runScript(
      r,
      ADMIT,
      [k.window, k.held, k.open, k.recent],
      [
        String(now),
        String(BURST_WINDOW_MS),
        String(BURST_THRESHOLD),
        JSON.stringify(storedOf(item, decision)),
        item.important ? "1" : "0",
        item.actorKey ?? "",
        String(BURST_QUIET_MS),
        String(BURST_MAX_WAIT_MS),
        String(BURST_STATE_SLACK_MS),
        String(BURST_MAX_ITEMS),
        String(BURST_ARM_STALE_MS),
      ],
    )) as string[]
  } catch (err) {
    log.warn({ err, userId: decision.userId }, "burst gate unavailable, notifying")
    return false
  }
  if (reply[0] !== "held") return false
  const job: BurstFlushJob = {
    orgId: decision.orgId,
    userId: decision.userId,
    burstId: reply[2] ?? "0",
  }
  if (reply[1] === "1") {
    const armAt = Number(reply[3])
    try {
      await (deps.scheduleFlush ?? defaultScheduleFlush)(job, armAt - now, armAt)
    } catch (err) {
      // Fail open: nothing would drain the burst. This item notifies now, and
      // what the burst held before it is summarized at once.
      log.error(
        { err, userId: decision.userId, notifyId: item.notifyId },
        "burst summary could not be armed, notifying now",
      )
      try {
        await runBurstFlush(job, deps, { force: true, exclude: item.notifyId })
      } catch (flushErr) {
        log.error(
          { err: flushErr, userId: decision.userId },
          "burst ended with held notifications not delivered (arming failed, inline summary failed)",
        )
      }
      return false
    }
  }
  // S1: the live channels it would have used are logged as held for the burst.
  await (deps.record ?? recordDeliveries)(
    routerSuppressionRecords(burstHeldDecision(decision), item.notifyId),
  )
  return true
}

/** What a burst's summary says, in the recipient's language. */
export interface BurstSummary {
  title: string
  body: string
  /** The one conversation of the burst, when there is only one. */
  conversation: string | null
}

/** One actor "dominates" a burst when at least this share of its items are theirs. */
const DOMINANT_SHARE = 2 / 3

/** The summary text of a drained burst. Pure: the tests pin every wording. */
export function burstSummaryText(
  locale: ShippedLocale,
  total: number,
  entries: readonly Pick<StoredEntry, "a" | "an" | "c" | "ck" | "k" | "r">[],
): BurstSummary {
  const conversations = new Set(entries.map((e) => e.c))
  const byActor = new Map<string, { name: string | null; count: number }>()
  for (const e of entries) {
    if (!e.a) continue
    const seen = byActor.get(e.a) ?? { name: e.an, count: 0 }
    seen.count += 1
    byActor.set(e.a, seen)
  }
  const top = [...byActor.values()].sort((x, y) => y.count - x.count)[0]
  const redacted = entries.some((e) => e.r)
  const actor =
    !redacted && top?.name && entries.length > 0 && top.count / entries.length >= DOMINANT_SHARE
      ? top.name
      : null
  const allMessages = entries.every((e) => e.k === "message")
  const allTasks = entries.length > 0 && entries.every((e) => e.ck === "task")
  const params = { count: total, conversations: conversations.size }
  let body: string
  if (total === 1)
    body = serverT(
      locale,
      allMessages
        ? "kernel.notifications.burst.oneMessage"
        : "kernel.notifications.burst.oneNotification",
    )
  else if (!allMessages) body = serverT(locale, "kernel.notifications.burst.notifications", params)
  else if (conversations.size <= 1)
    body = serverT(locale, "kernel.notifications.burst.messages", params)
  else if (allTasks) body = serverT(locale, "kernel.notifications.burst.messagesInTasks", params)
  else body = serverT(locale, "kernel.notifications.burst.messagesInConversations", params)
  return {
    title: actor ?? serverT(locale, "kernel.notifications.burst.title"),
    body,
    conversation: conversations.size === 1 ? ([...conversations][0] ?? null) : null,
  }
}

export interface BurstFlushDeps extends BurstDeps {
  locale?: (orgId: string, userId: string) => Promise<ShippedLocale>
  /** Sends the summary push. Defaults to the fanout's `deliverPayloadToUser`. */
  push?: (
    decision: RouterDecision,
    notifyId: string,
    build: (badgeCount: number) => PushPayload,
  ) => Promise<number>
  /** Raises the summary on the computer. Defaults to `onDesktopDecision`. */
  desktop?: (decision: RouterDecision, payload: DesktopNotifyPayload) => Promise<void>
}

/** The collapse id / tag every summary of one recipient shares (the newer replaces). */
export function burstCollapseId(orgId: string): string {
  return `burst:${orgId}`
}

/** Test seam: the senders, clock and Redis a job-run summary uses (the job handler passes none). */
let flushDepsOverride: BurstFlushDeps | null = null

/**
 * The summary job: drain the burst once it is due, else re-arm for when it
 * will be. Sends one push (to every device) and one computer notification,
 * and only then removes the items it covered: a send that throws leaves the
 * burst intact and fails the job, whose retry (attempts with backoff) sends it.
 *
 * `force` (the gate, when arming failed): drain now whatever is held, leaving
 * out `exclude`, the item the gate is about to notify on its own.
 */
export async function runBurstFlush(
  job: BurstFlushJob,
  callerDeps: BurstFlushDeps = {},
  opts: { force?: boolean; exclude?: string } = {},
): Promise<"none" | "busy" | "waiting" | "sent" | "nothing_to_send"> {
  const deps: BurstFlushDeps = { ...(flushDepsOverride ?? {}), ...callerDeps }
  const r = deps.redis ?? defaultRedis
  const now = (deps.now ?? Date.now)()
  const k = burstKeys(job.orgId, job.userId)
  const schedule = deps.scheduleFlush ?? defaultScheduleFlush
  const reply = (await runScript(
    r,
    DRAIN,
    [k.held, k.open],
    [
      String(now),
      String(BURST_QUIET_MS),
      String(BURST_MAX_WAIT_MS),
      String(FLUSH_LEASE_MS),
      opts.force ? "1" : "0",
    ],
  )) as string[]
  if (reply[0] === "none") {
    await reportExpired(r, job)
    return "none"
  }
  // Another run is sending this burst's summary right now.
  if (reply[0] === "busy") return "busy"
  if (reply[0] === "wait") {
    const armAt = Number(reply[3])
    try {
      await schedule({ ...job, burstId: reply[2] }, Number(reply[1]), armAt)
    } catch (err) {
      // Throw: the job fails and its retry re-arms; a later held item re-arms
      // too once this arm is overdue.
      log.error({ err, userId: job.userId }, "burst summary could not be re-armed")
      throw err
    }
    return "waiting"
  }
  const openedAt = reply[2] ?? "0"
  const count = Number(reply[3]) || 0
  const covered = Number(reply[1]) || 0
  const seen = new Set<string>()
  const entries: StoredEntry[] = []
  for (const raw of reply.slice(4)) {
    try {
      const e = JSON.parse(raw) as StoredEntry
      if (seen.has(e.n)) continue
      seen.add(e.n)
      if (opts.exclude && e.n === opts.exclude) continue
      entries.push(e)
    } catch {
      // A malformed entry is skipped; the count still includes it.
    }
  }
  const commit = async (): Promise<void> => {
    const done = (await runScript(
      r,
      COMMIT,
      [k.held, k.open, k.window, k.recent, k.done],
      [
        String(now),
        openedAt,
        String(count),
        String(covered),
        String(BURST_WINDOW_MS),
        String(BURST_QUIET_MS),
        String(BURST_MAX_WAIT_MS),
        String(BURST_STATE_SLACK_MS),
      ],
    )) as string[]
    if (done[0] !== "rearm") return
    // Items held while the summary went out are the next burst.
    const armAt = Number(done[3])
    await schedule(
      { orgId: job.orgId, userId: job.userId, burstId: done[2] },
      Number(done[1]),
      armAt,
    )
  }
  const pending = entries.filter((e) => !e.s)
  const push = pending.some((e) => e.pushOn)
  const desktop = pending.some((e) => e.desktopOn)
  if (!push && !desktop) {
    await commit()
    return "nothing_to_send"
  }
  const total = Math.max(covered - (opts.exclude ? 1 : 0), entries.length)
  try {
    const fanout = await import("~/modules/push/fanout-consumer")
    let locale: ShippedLocale = "en"
    try {
      locale = await (deps.locale ?? fanout.recipientLocale)(job.orgId, job.userId)
    } catch (err) {
      log.warn({ err, userId: job.userId }, "burst summary locale unavailable, in English")
    }
    const summary = burstSummaryText(locale, total, entries)
    const decision = burstSummaryDecision({
      orgId: job.orgId,
      userId: job.userId,
      push,
      desktop,
    })
    // One id per burst: a retried send is the same notification.
    const notifyId = `burst:${job.userId}:${openedAt}`
    const collapseId = burstCollapseId(job.orgId)
    // One conversation: the tap opens it. Several: the app opens on its inbox.
    const threadId =
      summary.conversation && !summary.conversation.includes("/") ? summary.conversation : null
    if (push)
      await (deps.push ?? fanout.deliverPayloadToUser)(decision, notifyId, (badgeCount) => ({
        type: "attention",
        ...(threadId ? { threadId } : {}),
        deepLink: threadId ? `liaison://thread/${threadId}` : "liaison://attention",
        badgeCount,
        title: summary.title,
        body: summary.body,
        collapseId,
        groupId: collapseId,
        notificationId: notificationIdFor(job.userId, notifyId),
      }))
    if (desktop) {
      const { onDesktopDecision } = await import("./desktop-hook")
      await (deps.desktop ?? onDesktopDecision)(decision, {
        notifyId,
        title: summary.title,
        body: summary.body,
        route: threadId ? `thread/${threadId}` : "",
        tag: collapseId,
      })
    }
  } catch (err) {
    // Keep the burst for the retry; if no retry is left the items stay held
    // until a later item re-arms the summary or the keys lapse: say so loudly.
    log.error(
      { err, userId: job.userId, orgId: job.orgId, held: pending.length },
      "burst summary send failed, held notifications not delivered yet",
    )
    await runScript(r, RELEASE, [k.open], [openedAt]).catch((releaseErr: unknown) => {
      log.error({ err: releaseErr, userId: job.userId }, "burst summary could not be released")
    })
    throw err
  }
  await commit()
  return "sent"
}

/** A job found no burst: fine if its burst was summarized, loud if it lapsed unsent. */
async function reportExpired(r: Redis, job: BurstFlushJob): Promise<void> {
  if (!job.burstId) return
  try {
    const done = Number(await r.get(burstKeys(job.orgId, job.userId).done))
    if (Number.isFinite(done) && done >= Number(job.burstId)) return
    log.error(
      { userId: job.userId, orgId: job.orgId, burstId: job.burstId },
      "burst ended with held notifications not delivered (its state lapsed before the summary)",
    )
  } catch {
    // Redis down: the drain itself would have thrown first.
  }
}

/**
 * Test access: forget a recipient's burst state, so a file's earlier cases
 * do not open a burst in a later one. Production code never calls it.
 */
export const BurstTestAccess = {
  /** The senders, clock and Redis a summary run by the job handler uses (null: the real ones). */
  setFlushDeps(deps: BurstFlushDeps | null): void {
    flushDepsOverride = deps
  },
  /** The logical job id of a recipient's currently armed summary. */
  async armedJobId(orgId: string, userId: string, r: Redis = defaultRedis): Promise<string | null> {
    const raw = await r.get(burstKeys(orgId, userId).open)
    if (!raw) return null
    const s = JSON.parse(raw) as { openedAt: number; armAt: number }
    return burstFlushJobId({ orgId, userId, burstId: String(s.openedAt) }, s.armAt)
  },
  async reset(orgId: string, userIds: readonly string[], r: Redis = defaultRedis): Promise<void> {
    const all = userIds.flatMap((u) => Object.values(burstKeys(orgId, u)))
    if (all.length > 0) await r.del(...all)
  },
  /** Every recipient's burst state in one org (a file whose users are made per run). */
  async resetOrg(orgId: string, r: Redis = defaultRedis): Promise<void> {
    // SCAN does not apply the client's key prefix, DEL does: match with it,
    // delete without it.
    const prefix = r.options.keyPrefix ?? ""
    let cursor = "0"
    do {
      const [next, found] = await r.scan(
        cursor,
        "MATCH",
        `${prefix}notify-burst:{${orgId}:*`,
        "COUNT",
        500,
      )
      cursor = next
      if (found.length > 0) await r.del(...found.map((k) => k.slice(prefix.length)))
    } while (cursor !== "0")
  },
}
