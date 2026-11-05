// SPDX-License-Identifier: FSL-1.1-ALv2
import { LIVE_INSTANCE_LUA, LIVE_INSTANCES_SET } from "~/infra/instance-registry"
import { boundedBy } from "~/lib/bounded"
import { eventsLogger as log } from "~/lib/logger"
import type { LiveConn, MailAccessAccount, MailboxAnswerers, MailboxUnlockEntry } from "./types"

/**
 * The cell-wide WebSocket connection state (S5, A12, D5).
 *
 * Keys (all under the client's key prefix):
 * - `ws:i:{inst}:conns`            hash connId → JSON `LiveConn`, one per instance
 * - `ws:org:{org}:conns`           set of `{inst}|{connId}|{userId}`
 * - `ws:user:{org}:{user}:conns`   set of `{inst}|{connId}`
 * - `ws:mailboxUnlock:{user}`      JSON map connection → `{ e, v }` (expiry ms, the
 *                                  connection's `MailboxUnlockEntry` as JSON), TTL-bound
 *
 * A set member counts only while its instance has a heartbeat record
 * (`live:inst:{inst}`) and its hash entry exists, so a SIGKILLed replica's
 * sockets drop out as soon as its record lapses, before the leader's sweep
 * (`cleanupInstance`) deletes them. The reading instance counts its own
 * entries live: it is running, whatever its record says.
 *
 * ioredis prefixes `KEYS[]` only, so every script that builds a key name in
 * Lua receives the prefix as `ARGV[1]`.
 *
 * Every call is bounded (`commandTimeoutMs`, 1 s by default) and rejects on
 * timeout, except the two reads whose failure direction is fixed here: mail
 * access answers false (closed), a mailbox unlock reads absent (locked).
 * Callers that decide on the others choose their own fallback.
 */

/** The ioredis subset this module uses, so a test can hand it a client that hangs. */
export interface LiveRedis {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>
  get(key: string): Promise<string | null>
  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>
  del(...keys: string[]): Promise<number>
}

export class LiveStateTimeout extends Error {
  constructor(what: string, ms: number) {
    super(`live state: Redis did not answer ${what} within ${ms} ms`)
    this.name = "LiveStateTimeout"
  }
}

/** `p`, or a `LiveStateTimeout` rejection once `ms` pass without an answer. */
export function bounded<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return boundedBy(p, ms, () => new LiveStateTimeout(what, ms))
}

const instConnsKey = (inst: string) => `ws:i:${inst}:conns`
const orgConnsKey = (orgId: string) => `ws:org:${orgId}:conns`
const userConnsKey = (orgId: string, userId: string) => `ws:user:${orgId}:${userId}:conns`
const unlockKey = (userId: string) => `ws:mailboxUnlock:${userId}`
/**
 * One connection's mailbox assertion in the user's map (KEYS[1]). ARGV[1] the
 * connection, ARGV[2] its entry as JSON ("" withdraws it), ARGV[3] now (ms),
 * ARGV[4] the entry's expiry (ms). Expired members are pruned on every write,
 * and the key lives as long as its longest-lived member. The entry stays an
 * opaque string here: cjson would turn an empty `keyIds` array into an object.
 */
const SET_UNLOCK_LUA = `
local now = tonumber(ARGV[3])
local held = {}
local raw = redis.call('GET', KEYS[1])
if raw then
  local ok, decoded = pcall(cjson.decode, raw)
  if ok and type(decoded) == 'table' then held = decoded end
end
local out = {}
local maxExp = 0
for member, slot in pairs(held) do
  if member ~= ARGV[1] and type(slot) == 'table' and type(slot.v) == 'string' then
    local e = tonumber(slot.e)
    if e and e > now then
      out[member] = { e = e, v = slot.v }
      if e > maxExp then maxExp = e end
    end
  end
end
if ARGV[2] ~= '' then
  local e = tonumber(ARGV[4])
  if e and e > now then
    out[ARGV[1]] = { e = e, v = ARGV[2] }
    if e > maxExp then maxExp = e end
  end
end
if maxExp <= now then
  redis.call('DEL', KEYS[1])
  return 0
end
redis.call('SET', KEYS[1], cjson.encode(out), 'PX', math.min(maxExp - now, 3600000))
return 1
`

const orgMember = (c: LiveConn) => `${c.instanceId}|${c.connId}|${c.userId}`
const userMember = (c: LiveConn) => `${c.instanceId}|${c.connId}`

// ARGV[1] prefix, ARGV[2] the reading instance (always live).
const MEMBER_LUA = `${LIVE_INSTANCE_LUA}
local prefix = ARGV[1]
local self_inst = ARGV[2]
local live_cache = {}
local function inst_live(inst)
  if inst == self_inst then return true end
  local c = live_cache[inst]
  if c == nil then
    c = redis.call('EXISTS', live_inst_key(prefix, inst)) == 1
    live_cache[inst] = c
  end
  return c
end
local function member_live(m)
  local inst, conn = string.match(m, '^([^|]+)|([^|]+)')
  if not inst then return false end
  if not inst_live(inst) then return false end
  return redis.call('HEXISTS', prefix .. 'ws:i:' .. inst .. ':conns', conn) == 1
end
local function any_live(key, except)
  for _, m in ipairs(redis.call('SMEMBERS', key)) do
    if m ~= except and member_live(m) then return 1 end
  end
  return 0
end
`

// KEYS: inst conns, org set, user set. ARGV: prefix, self, connId, json, org member, user member.
// Returns 1 when the user already had a live socket in the org (wasOnline).
const ADD_LUA = `${MEMBER_LUA}
local was = any_live(KEYS[3], ARGV[6])
redis.call('HSET', KEYS[1], ARGV[3], ARGV[4])
redis.call('SADD', KEYS[2], ARGV[5])
redis.call('SADD', KEYS[3], ARGV[6])
return was
`

// KEYS: inst conns, org set, user set. ARGV: prefix, self, connId, org member, user member.
// Returns 1 when the user still has a live socket in the org.
const REMOVE_LUA = `${MEMBER_LUA}
redis.call('HDEL', KEYS[1], ARGV[3])
redis.call('SREM', KEYS[2], ARGV[4])
redis.call('SREM', KEYS[3], ARGV[5])
return any_live(KEYS[3], '')
`

// KEYS: user set. ARGV: prefix, self.
const IS_ONLINE_LUA = `${MEMBER_LUA}
return any_live(KEYS[1], '')
`

// KEYS: org set. ARGV: prefix, self, cap. Distinct user ids, live sockets only.
const ONLINE_USERS_LUA = `${MEMBER_LUA}
local cap = tonumber(ARGV[3])
local seen = {}
local out = {}
for _, m in ipairs(redis.call('SMEMBERS', KEYS[1])) do
  if #out >= cap then break end
  local user = string.match(m, '^[^|]+|[^|]+|(.+)$')
  if user and not seen[user] and member_live(m) then
    seen[user] = true
    out[#out + 1] = user
  end
end
return out
`

// KEYS: org set. ARGV: prefix, self. The JSON of every live socket in the org.
const ORG_CONNS_LUA = `${MEMBER_LUA}
local out = {}
for _, m in ipairs(redis.call('SMEMBERS', KEYS[1])) do
  local inst, conn = string.match(m, '^([^|]+)|([^|]+)')
  if inst and inst_live(inst) then
    local raw = redis.call('HGET', prefix .. 'ws:i:' .. inst .. ':conns', conn)
    if raw then out[#out + 1] = raw end
  end
end
return out
`

// ARGV: prefix, self, dead instance id. Deletes every entry of the dead
// instance; returns a flat {orgId, userId, ...} of the users it left offline.
const CLEANUP_LUA = `${MEMBER_LUA}
local dead = ARGV[3]
local hkey = prefix .. 'ws:i:' .. dead .. ':conns'
local all = redis.call('HGETALL', hkey)
local touched = {}
for i = 1, #all, 2 do
  local conn_id = all[i]
  local ok, c = pcall(cjson.decode, all[i + 1])
  if ok and type(c) == 'table' and type(c.orgId) == 'string' and type(c.userId) == 'string' then
    redis.call('SREM', prefix .. 'ws:org:' .. c.orgId .. ':conns', dead .. '|' .. conn_id .. '|' .. c.userId)
    redis.call('SREM', prefix .. 'ws:user:' .. c.orgId .. ':' .. c.userId .. ':conns', dead .. '|' .. conn_id)
    touched[c.orgId .. '\\n' .. c.userId] = { c.orgId, c.userId }
  end
end
redis.call('DEL', hkey)
local out = {}
for _, ou in pairs(touched) do
  if any_live(prefix .. 'ws:user:' .. ou[1] .. ':' .. ou[2] .. ':conns', '') == 0 then
    out[#out + 1] = ou[1]
    out[#out + 1] = ou[2]
  end
end
return out
`

/**
 * Whether a connection's dimension grants reach an organization mailbox: a
 * `mail:inbox` grant naming it (or `*`), or the global `{"*": ["*"]}` grant an
 * administrator carries, which RLS honours for the same rows. Reading only the
 * `mail:inbox` key withheld every mailbox frame from an admin, so Settings > Mail
 * never heard that a shared mailbox connected or disconnected until a reload.
 */
export function mailInboxGrantAllows(
  dimensionGrants: Record<string, string[]>,
  accountId: string,
): boolean {
  if ((dimensionGrants["*"] ?? []).includes("*")) return true
  const inboxGrants = dimensionGrants["mail:inbox"] ?? []
  return inboxGrants.includes("*") || inboxGrants.includes(accountId)
}

function readMailAccessConn(raw: unknown): Pick<LiveConn, "userId" | "dimensionGrants"> | null {
  if (typeof raw !== "string") return null
  try {
    const c = JSON.parse(raw) as Partial<LiveConn>
    if (typeof c.userId !== "string" || !c.dimensionGrants) return null
    return { userId: c.userId, dimensionGrants: c.dimensionGrants }
  } catch {
    return null
  }
}

/**
 * How many connection entries one liveOrgIds call examines at most. The script
 * runs inside Redis, which serves nothing else meanwhile: past this many
 * sockets it returns the orgs found so far (a warm-up hint, not a census).
 */
export const LIVE_ORGS_MAX_EXAMINED = 10_000

// ARGV[1] prefix, ARGV[2] cap, ARGV[3] most entries examined. Every org with
// a socket on a live instance of the registry's set, once each, at most `cap`.
// HSCAN pages the hashes so the walk stops at the budget instead of loading
// each instance's whole hash (an entry HSCAN repeats only repeats an org seen).
const LIVE_ORGS_LUA = `${LIVE_INSTANCE_LUA}
local prefix = ARGV[1]
local cap = tonumber(ARGV[2])
local budget = tonumber(ARGV[3])
local examined = 0
local seen = {}
local out = {}
for _, inst in ipairs(redis.call('SMEMBERS', prefix .. '${LIVE_INSTANCES_SET}')) do
  if redis.call('EXISTS', live_inst_key(prefix, inst)) == 1 then
    local key = prefix .. 'ws:i:' .. inst .. ':conns'
    local cursor = '0'
    repeat
      local page = redis.call('HSCAN', key, cursor, 'COUNT', 500)
      cursor = page[1]
      local kv = page[2]
      for i = 2, #kv, 2 do
        if examined >= budget then return out end
        examined = examined + 1
        local ok, c = pcall(cjson.decode, kv[i])
        if ok and type(c) == 'table' and type(c.orgId) == 'string' and not seen[c.orgId] then
          seen[c.orgId] = true
          out[#out + 1] = c.orgId
          if #out >= cap then return out end
        end
      end
    until cursor == '0'
  end
end
return out`

export class RedisLiveState {
  private readonly commandTimeoutMs: number

  constructor(
    private readonly redis: LiveRedis,
    readonly instanceId: string,
    private readonly prefix: string,
    opts: { commandTimeoutMs?: number } = {},
  ) {
    this.commandTimeoutMs = opts.commandTimeoutMs ?? 1_000
  }

  private run(what: string, script: string, keys: string[], args: (string | number)[]) {
    return bounded(
      this.redis.eval(script, keys.length, ...keys, ...args),
      this.commandTimeoutMs,
      what,
    )
  }

  private writeArgs(c: LiveConn): { keys: string[]; args: string[] } {
    return {
      keys: [instConnsKey(c.instanceId), orgConnsKey(c.orgId), userConnsKey(c.orgId, c.userId)],
      args: [
        this.prefix,
        this.instanceId,
        c.connId,
        JSON.stringify(c),
        orgMember(c),
        userMember(c),
      ],
    }
  }

  /** Record a socket; `wasOnline` says whether the user already had a live one in the org. */
  async addConnection(c: LiveConn): Promise<{ wasOnline: boolean }> {
    const { keys, args } = this.writeArgs(c)
    const res = await this.run("addConnection", ADD_LUA, keys, args)
    return { wasOnline: Number(res) === 1 }
  }

  /** Rewrite a socket's copy after its scopes or grants changed locally. */
  async updateConnection(c: LiveConn): Promise<void> {
    const { keys, args } = this.writeArgs(c)
    await this.run("updateConnection", ADD_LUA, keys, args)
  }

  /** Forget a socket; `userStillOnline` says whether another live one remains in the org. */
  async removeConnection(c: LiveConn): Promise<{ userStillOnline: boolean }> {
    const res = await this.run(
      "removeConnection",
      REMOVE_LUA,
      [instConnsKey(c.instanceId), orgConnsKey(c.orgId), userConnsKey(c.orgId, c.userId)],
      [this.prefix, this.instanceId, c.connId, orgMember(c), userMember(c)],
    )
    return { userStillOnline: Number(res) === 1 }
  }

  async isUserOnline(orgId: string, userId: string): Promise<boolean> {
    const res = await this.run(
      "isUserOnline",
      IS_ONLINE_LUA,
      [userConnsKey(orgId, userId)],
      [this.prefix, this.instanceId],
    )
    return Number(res) === 1
  }

  /** Users with a live socket in the org, deduplicated, at most `cap`. */
  async onlineUsers(orgId: string, cap: number): Promise<string[]> {
    const res = await this.run(
      "onlineUsers",
      ONLINE_USERS_LUA,
      [orgConnsKey(orgId)],
      [this.prefix, this.instanceId, cap],
    )
    return Array.isArray(res) ? res.filter((u): u is string => typeof u === "string") : []
  }

  /**
   * The orgs with a socket on a live instance, each once, at most `cap`: the
   * orgs whose people a process about to serve meets first (a deploy closes
   * the old processes' sockets and they reconnect to it). It examines at
   * most `maxExamined` connection entries, so the script never holds Redis
   * for a census of every socket.
   */
  async liveOrgIds(cap: number, maxExamined = LIVE_ORGS_MAX_EXAMINED): Promise<string[]> {
    const res = await this.run("liveOrgIds", LIVE_ORGS_LUA, [], [this.prefix, cap, maxExamined])
    return Array.isArray(res) ? res.filter((o): o is string => typeof o === "string") : []
  }

  /**
   * Whether any live socket in the cell may read this account's mail: its
   * owner for a personal account, a `mail:inbox` grant (or the admin wildcard)
   * for an org mailbox. Fails closed: no answer reads as nobody.
   */
  async hasOnlineUserWithMailAccess(orgId: string, account: MailAccessAccount): Promise<boolean> {
    try {
      if (account.ownerType === "user") {
        return account.ownerId ? await this.isUserOnline(orgId, account.ownerId) : false
      }
      const res = await this.run(
        "orgConnections",
        ORG_CONNS_LUA,
        [orgConnsKey(orgId)],
        [this.prefix, this.instanceId],
      )
      if (!Array.isArray(res)) return false
      return res.some((raw) => {
        const c = readMailAccessConn(raw)
        return c !== null && mailInboxGrantAllows(c.dimensionGrants, account.id)
      })
    } catch (err) {
      log.warn({ err, orgId, accountId: account.id }, "mail access check failed: answering none")
      return false
    }
  }

  /**
   * Delete every entry of a dead instance (the leader's sweep, or this
   * instance's own release on shutdown). Returns the users it left with no
   * live socket in their org, for the offline broadcast.
   */
  async cleanupInstance(deadId: string): Promise<Array<{ orgId: string; userId: string }>> {
    const res = await this.redis.eval(CLEANUP_LUA, 0, this.prefix, this.instanceId, deadId)
    const out: Array<{ orgId: string; userId: string }> = []
    if (!Array.isArray(res)) return out
    for (let i = 0; i + 1 < res.length; i += 2) {
      const [orgId, userId] = [res[i], res[i + 1]]
      if (typeof orgId === "string" && typeof userId === "string") out.push({ orgId, userId })
    }
    return out
  }

  /**
   * Rewrite this instance's sockets from its local table, after its record
   * lapsed (P2-1). Each entry is written on its own: one that fails is logged
   * and skipped, the rest are still written. Never rejects.
   */
  async republish(conns: LiveConn[]): Promise<void> {
    for (const conn of conns) {
      const { keys, args } = this.writeArgs(conn)
      try {
        await this.run("republish", ADD_LUA, keys, args)
      } catch (err) {
        log.warn({ err, connId: conn.connId, userId: conn.userId }, "ws republish: entry skipped")
      }
    }
  }

  /**
   * Record ONE connection's assertion. Each connection of the user holds its
   * own, so a client that opens with its mailbox locked withdraws only its own
   * and never masks another client that is unlocked. A locked, expired or null
   * entry withdraws the connection's assertion: an expired one is never stored,
   * or a dead tab would vouch for an unlocked mailbox.
   */
  async setMailboxUnlock(
    userId: string,
    connection: string,
    entry: MailboxUnlockEntry | null,
  ): Promise<void> {
    const now = Date.now()
    // A locked connection is kept too (it never counts as unlocked): it may
    // still own a turn, and its own answer to that turn is the one that counts.
    const live = entry && entry.expiresAt > now ? entry : null
    await this.run(
      "mailboxUnlock",
      SET_UNLOCK_LUA,
      [unlockKey(userId)],
      [connection, live ? JSON.stringify(live) : "", now, live ? live.expiresAt : 0],
    )
  }

  /**
   * Unlocked while ANY live connection of the user asserts it (key ids of all
   * of them), undefined (locked) when none does or Redis does not answer.
   */
  async getMailboxUnlock(userId: string): Promise<MailboxUnlockEntry | undefined> {
    const live = await this.liveUnlockEntries(userId)
    const unlocked = live.filter((e) => e.unlocked)
    if (unlocked.length === 0) return undefined
    const keyIds = [...new Set(unlocked.flatMap((e) => e.keyIds))].sort((a, b) => a - b)
    const expiresAt = Math.max(...unlocked.map((e) => e.expiresAt))
    return { unlocked: true, keyIds, expiresAt }
  }

  /**
   * Which of the user's live connections can still answer a request of
   * `turnNonce`: the unlocked ones, split into the turn's own window and the
   * others. `unknown` when Redis does not answer: the caller keeps waiting.
   */
  async getMailboxAnswerers(userId: string, turnNonce: string): Promise<MailboxAnswerers> {
    let live: MailboxUnlockEntry[]
    try {
      live = await this.liveUnlockEntries(userId, { throwOnError: true })
    } catch {
      return "unknown"
    }
    const unlocked = live.filter((e) => e.unlocked)
    const turnWindow = unlocked.filter((e) => e.turns?.includes(turnNonce) === true)
    return {
      turnWindowUnlocked: turnWindow.length > 0,
      otherUnlocked: unlocked.length - turnWindow.length,
    }
  }

  private async liveUnlockEntries(
    userId: string,
    opts: { throwOnError?: boolean } = {},
  ): Promise<MailboxUnlockEntry[]> {
    let raw: string | null
    try {
      raw = await bounded(this.redis.get(unlockKey(userId)), this.commandTimeoutMs, "mailboxUnlock")
    } catch (err) {
      if (opts.throwOnError) throw err
      log.warn({ err, userId }, "mailbox unlock read failed: answering locked")
      return []
    }
    if (!raw) return []
    const now = Date.now()
    const live: MailboxUnlockEntry[] = []
    try {
      const held: unknown = JSON.parse(raw)
      if (!held || typeof held !== "object" || Array.isArray(held)) return []
      for (const slot of Object.values(held as Record<string, unknown>)) {
        const entry = readUnlockSlot(slot, now)
        if (entry) live.push(entry)
      }
    } catch {
      return []
    }
    return live
  }
}

/** One member of the user's unlock map, when it is a live (unexpired) assertion. */
function readUnlockSlot(slot: unknown, now: number): MailboxUnlockEntry | null {
  if (!slot || typeof slot !== "object") return null
  const v = (slot as { v?: unknown }).v
  if (typeof v !== "string") return null
  try {
    const entry: unknown = JSON.parse(v)
    if (!entry || typeof entry !== "object") return null
    const { unlocked, keyIds, expiresAt, turns } = entry as Record<string, unknown>
    if (typeof unlocked !== "boolean" || typeof expiresAt !== "number" || expiresAt <= now) {
      return null
    }
    const ids = Array.isArray(keyIds)
      ? keyIds.filter((k): k is number => typeof k === "number")
      : []
    const out: MailboxUnlockEntry = { unlocked, keyIds: ids, expiresAt }
    if (Array.isArray(turns)) out.turns = turns.filter((t): t is string => typeof t === "string")
    return out
  } catch {
    return null
  }
}
