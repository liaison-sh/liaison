// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Registry of IN-FLIGHT agent runs, keyed by thread, cell-wide (S6).
 *
 * The live `agent_stream` WS events are ephemeral: a client that connects (or
 * opens a thread tab) AFTER a run started has missed every earlier delta —
 * the promoted-agent-chat case, where the thread tab opens mid-run and shows
 * neither the "working" indicator nor the tool calls/thinking already
 * emitted. Every producer records each event here; `GET
 * /api/agent/stream-state/:threadId` serves the folded snapshot so a
 * late-joining view can seed its live block and then continue from the
 * ongoing WS deltas.
 *
 * Storage is Redis, so any process records and any process reads (a turn may
 * run in a job worker while the reader is an API replica; a node turn has two
 * producers when its progress posts land on two replicas). Keys, under the
 * client's key prefix, with `k = sha1(threadId \0 agentId \0 turnId)`:
 * - `agent:turn:{k}`          the turn's events, a Redis Stream (no MAXLEN);
 * - `agent:turn:{k}:seq`      the turn's frame counter;
 * - `agent:turn:{k}:meta`     identity, owner instance, phase, lastSeenAt, item counter;
 * - `agent:turn:{k}:tools`    toolCallId → item index (a re-sent call keeps its item);
 * - `agent:live:thread:{t}`   the live turn keys of a thread;
 * - `agent:live:by-inst:{i}`  the live turn keys an instance owns (the sweep's index).
 *
 * One Lua script records an event: it allocates the frame's `seq` and its item
 * (S28: `r<n>` / `t<n>` / the tool call id, coalescing as the fold does), so
 * two producers of one turn agree on both. Every record refreshes the keys'
 * TTL (660 s + `AGENT_TURN_STREAM_TTL_S`); a terminal event takes the turn off
 * the thread index and leaves the stream readable for `AGENT_TURN_STREAM_TTL_S`.
 * Memory is bounded by a checkpoint every `checkpointEvery` frames (the folded
 * snapshot, its `seq`, the requester pin and the scope tag) followed by an
 * XTRIM MINID up to it (P2-2).
 *
 * Readers drop turns whose owner instance has no heartbeat (A12) or that were
 * not heard from for 660 s. The leader's sweep takes a dead instance's turns
 * off the index and tells listeners `running: false`; it never writes a
 * terminal message (resuming is P3). An instance whose record lapsed puts its
 * own turns back (P2-1). Turn changes reach listeners in every process over
 * `${REDIS_PREFIX}agent:live:changes`. Every Redis call is bounded (P2-3): a
 * read that times out rejects with `LiveTurnTimeout` and the caller picks the
 * direction.
 *
 * ioredis prefixes `KEYS[]` only: every script that builds a key in Lua gets
 * the prefix in ARGV.
 */
import crypto from "node:crypto"
import { INSTANCE_ID } from "~/infra/instance-id"
import {
  type InstanceRegistry,
  LIVE_INSTANCE_LUA,
  onDeadInstance,
  onInstanceRecovered,
} from "~/infra/instance-registry"
import { boundedBy } from "~/lib/bounded"
import { env } from "~/lib/env"
import { isRecord } from "~/lib/guards"
import { rootLogger } from "~/lib/logger"
import { REDIS_PREFIX, redis, redisSub } from "~/lib/redis"
import {
  type AgentStreamVisibility,
  emptySnapshot,
  foldTurn,
  type LiveAgentStreamSnapshot,
  type LiveItemKind,
  readScopeTag,
  TERMINAL_ACTIONS,
  type TurnEntry,
  type TurnIdentity,
} from "./stream-fold"

export {
  type AgentStreamVisibility,
  type LiveAgentStreamSnapshot,
  type LiveItemKind,
  type LiveTimelineEntry,
  type LiveToolCall,
  MAX_SNAPSHOT_TOOL_CALLS,
} from "./stream-fold"

const log = rootLogger.child({ module: "stream-registry" })

// A turn that somehow never emits a terminal event must not stay listed
// forever — cap at the kernel run-timeout ceiling (600s) plus slack.
const STALE_AFTER_MS = 660_000
const STALE_AFTER_S = STALE_AFTER_MS / 1000

/** Frames between two checkpoints of one turn. */
const DEFAULT_CHECKPOINT_EVERY = 500

const turnBase = (k: string) => `agent:turn:${k}`
const threadKey = (threadId: string) => `agent:live:thread:${threadId}`
const byInstKey = (inst: string) => `agent:live:by-inst:${inst}`
const CHANGES_CHANNEL = "agent:live:changes"

/** The turn key: one hash per (thread, agent, turn), so ids never need escaping in Redis. */
export function liveTurnKey(
  threadId: string,
  agentId: string | null | undefined,
  turnId: string | null | undefined,
): string {
  return crypto
    .createHash("sha1")
    .update(`${threadId}\u0000${agentId ?? ""}\u0000${turnId ?? ""}`)
    .digest("hex")
}

// Shared Lua helpers. ARGV[1] is always the prefix.
const LUA_HELPERS = `
local prefix = ARGV[1]
local function by_inst(id) return prefix .. 'agent:live:by-inst:' .. id end
local function turn_base(k) return prefix .. 'agent:turn:' .. k end
local function expire_turn(k, ttl)
  local b = turn_base(k)
  redis.call('EXPIRE', b, ttl)
  redis.call('EXPIRE', b .. ':seq', ttl)
  redis.call('EXPIRE', b .. ':meta', ttl)
  redis.call('EXPIRE', b .. ':tools', ttl)
end
local function is_live(phase) return phase == 'accepted' or phase == 'started' end
`

// KEYS: stream, seq, meta, tools, thread set, own by-inst set.
// ARGV: prefix, k, action, data json, scope tag json, now ms, self, kind
// (reasoning|text|''), opens ('1' | '0'), toolCallId, live ttl s, ended ttl s,
// threadId, orgId, agentId, turnId, askId, requesterId.
// Returns { seq, itemId, itemKind, index changed (0/1), requesterId, requester mismatch (0/1) }.
const RECORD_LUA = `${LUA_HELPERS}
local k, action = ARGV[2], ARGV[3]
local now, self_inst = ARGV[6], ARGV[7]
local live_ttl, ended_ttl = tonumber(ARGV[11]), tonumber(ARGV[12])
local phase = redis.call('HGET', KEYS[3], 'phase')
local function index_ttl(owner)
  redis.call('EXPIRE', KEYS[5], live_ttl)
  if owner then redis.call('EXPIRE', by_inst(owner), live_ttl) end
end
local function take_ownership()
  local old = redis.call('HGET', KEYS[3], 'instanceId')
  if old and old ~= self_inst then redis.call('SREM', by_inst(old), k) end
  redis.call('DEL', KEYS[1], KEYS[4])
end

if action == 'accepted' then
  if is_live(phase) and redis.call('SISMEMBER', KEYS[5], k) == 1 then return { 0, '', '', 0, '', 0 } end
  take_ownership()
  local ask = ARGV[17]
  if ask == '' then ask = ARGV[16] end
  redis.call('HSET', KEYS[3], 'threadId', ARGV[13], 'orgId', ARGV[14], 'agentId', ARGV[15],
    'turnId', ARGV[16], 'askId', ask, 'requesterId', ARGV[18], 'startedAt', now,
    'lastSeenAt', now, 'instanceId', self_inst, 'phase', 'accepted', 'items', 0, 'lastKind', '')
  local added = redis.call('SADD', KEYS[5], k)
  redis.call('SADD', KEYS[6], k)
  expire_turn(k, live_ttl)
  index_ttl(self_inst)
  return { 0, '', '', added, ARGV[18], 0 }
end

if action == 'withdraw' then
  if phase ~= 'accepted' then return { 0, '', '', 0, '', 0 } end
  local removed = redis.call('SREM', KEYS[5], k)
  local owner = redis.call('HGET', KEYS[3], 'instanceId')
  if owner then redis.call('SREM', by_inst(owner), k) end
  redis.call('HSET', KEYS[3], 'phase', 'ended')
  expire_turn(k, ended_ttl)
  return { 0, '', '', removed, redis.call('HGET', KEYS[3], 'requesterId') or '', 0 }
end

if action == 'start' then
  local ask = ARGV[17]
  if ask == '' and is_live(phase) then ask = redis.call('HGET', KEYS[3], 'askId') or '' end
  if ask == '' then ask = ARGV[16] end
  take_ownership()
  redis.call('HSET', KEYS[3], 'threadId', ARGV[13], 'orgId', ARGV[14], 'agentId', ARGV[15],
    'turnId', ARGV[16], 'askId', ask, 'requesterId', ARGV[18], 'startedAt', now,
    'lastSeenAt', now, 'instanceId', self_inst, 'phase', 'started', 'items', 0, 'lastKind', '')
  local added = redis.call('SADD', KEYS[5], k)
  redis.call('SADD', KEYS[6], k)
  local seq = redis.call('INCR', KEYS[2])
  redis.call('XADD', KEYS[1], '*', 'seq', seq, 'a', 'start', 's', ARGV[5], 't', now)
  expire_turn(k, live_ttl)
  index_ttl(self_inst)
  return { seq, '', '', added, ARGV[18], 0 }
end

local seq = redis.call('INCR', KEYS[2])

if action == 'done' or action == 'error' or action == 'clear' then
  local removed = 0
  if is_live(phase) then
    redis.call('XADD', KEYS[1], '*', 'seq', seq, 'a', action, 't', now)
    removed = redis.call('SREM', KEYS[5], k)
    local owner = redis.call('HGET', KEYS[3], 'instanceId')
    if owner then redis.call('SREM', by_inst(owner), k) end
    redis.call('HSET', KEYS[3], 'phase', 'ended')
  end
  expire_turn(k, ended_ttl)
  return { seq, '', '', removed, redis.call('HGET', KEYS[3], 'requesterId') or '', 0 }
end

local item, kind = '', ''
if action == 'tool_call' then
  local tc = ARGV[10]
  if redis.call('HEXISTS', KEYS[4], tc) == 0 then
    local n = redis.call('HINCRBY', KEYS[3], 'items', 1)
    redis.call('HSET', KEYS[4], tc, n - 1)
    redis.call('HSET', KEYS[3], 'lastKind', 'tool')
  end
  item, kind = tc, 'tool'
elseif action == 'tool_result' then
  if ARGV[10] ~= '' then item, kind = ARGV[10], 'tool' end
elseif ARGV[8] == 'reasoning' or ARGV[8] == 'text' then
  local n = nil
  if redis.call('HGET', KEYS[3], 'lastKind') == ARGV[8] then
    n = (tonumber(redis.call('HGET', KEYS[3], 'items')) or 1) - 1
  elseif ARGV[9] == '1' then
    n = redis.call('HINCRBY', KEYS[3], 'items', 1) - 1
    redis.call('HSET', KEYS[3], 'lastKind', ARGV[8])
  end
  if n then
    if ARGV[8] == 'reasoning' then item = 'r' .. n else item = 't' .. n end
    kind = ARGV[8]
  end
end

if not is_live(phase) then
  -- Nothing runs under this key (never started, or already ended): the frame
  -- still gets its seq and item, but nothing is stored to fold.
  if phase == 'ended' then expire_turn(k, ended_ttl) else expire_turn(k, live_ttl) end
  return { seq, item, kind, 0, '', 0 }
end

redis.call('XADD', KEYS[1], '*', 'seq', seq, 'a', action, 'd', ARGV[4], 's', ARGV[5],
  'i', item, 't', now)
redis.call('HSET', KEYS[3], 'lastSeenAt', now)
local pinned = redis.call('HGET', KEYS[3], 'requesterId') or ''
local mismatch = 0
if ARGV[18] ~= '' and ARGV[18] ~= pinned then mismatch = 1 end
expire_turn(k, live_ttl)
index_ttl(redis.call('HGET', KEYS[3], 'instanceId'))
return { seq, item, kind, 0, pinned, mismatch }
`

const META_FIELDS = [
  "threadId",
  "orgId",
  "agentId",
  "turnId",
  "askId",
  "requesterId",
  "startedAt",
  "lastSeenAt",
  "instanceId",
  "phase",
] as const

// KEYS: thread set. ARGV: prefix, self, now ms, stale ms.
// Returns, per live turn, { k, ...META_FIELDS }. Turns whose meta expired or
// that went stale are taken off the index; a dead owner's are skipped (the
// sweep owns their cleanup, and the owner may come back).
const LIST_META_LUA = `${LUA_HELPERS}
${LIVE_INSTANCE_LUA}
local self_inst, now, stale = ARGV[2], tonumber(ARGV[3]), tonumber(ARGV[4])
local out = {}
for _, k in ipairs(redis.call('SMEMBERS', KEYS[1])) do
  local f = redis.call('HMGET', turn_base(k) .. ':meta', ${META_FIELDS.map((f) => `'${f}'`).join(", ")})
  local inst, phase = f[9], f[10]
  if not is_live(phase) then
    redis.call('SREM', KEYS[1], k)
  elseif now - (tonumber(f[8]) or 0) > stale then
    redis.call('SREM', KEYS[1], k)
    if inst then redis.call('SREM', by_inst(inst), k) end
  elseif inst and (inst == self_inst or redis.call('EXISTS', live_inst_key(prefix, inst)) == 1) then
    local row = { k }
    for i = 1, ${META_FIELDS.length} do row[i + 1] = f[i] or '' end
    out[#out + 1] = row
  end
end
return out
`

// KEYS: thread set. ARGV: prefix, agentId, now ms, live ttl s.
const TOUCH_LUA = `${LUA_HELPERS}
for _, k in ipairs(redis.call('SMEMBERS', KEYS[1])) do
  local m = turn_base(k) .. ':meta'
  if redis.call('HGET', m, 'agentId') == ARGV[2] and is_live(redis.call('HGET', m, 'phase')) then
    redis.call('HSET', m, 'lastSeenAt', ARGV[3])
    expire_turn(k, tonumber(ARGV[4]))
  end
end
return 1
`

// KEYS: the dead instance's by-inst set. ARGV: prefix, dead id, ttl s, keep k...
// Returns { threadId, orgId, requesterId } triples of the turns taken off.
// A kept turn (its durable record is running or handed off: a resume will
// take its live entry over, S10 M1) is left exactly as it is.
const DEAD_LUA = `${LUA_HELPERS}
local out = {}
local keep = {}
for i = 4, #ARGV do keep[ARGV[i]] = true end
local kept = 0
for _, k in ipairs(redis.call('SMEMBERS', KEYS[1])) do
  local f = redis.call('HMGET', turn_base(k) .. ':meta', 'threadId', 'orgId', 'requesterId', 'instanceId', 'phase')
  if keep[k] then
    kept = kept + 1
  elseif f[4] == ARGV[2] then
    if is_live(f[5]) and f[1] then
      if redis.call('SREM', prefix .. 'agent:live:thread:' .. f[1], k) == 1 then
        out[#out + 1] = f[1]
        out[#out + 1] = f[2] or ''
        out[#out + 1] = f[3] or ''
      end
    end
    expire_turn(k, tonumber(ARGV[3]))
  end
end
if kept == 0 then redis.call('DEL', KEYS[1]) end
return out
`

// KEYS: meta, seq. ARGV: step. Marks where a step's frames end (S10, M1).
const STEP_BOUNDARY_LUA = `
local seq = redis.call('GET', KEYS[2]) or '0'
if redis.call('EXISTS', KEYS[1]) == 1 then redis.call('HSET', KEYS[1], 'b' .. ARGV[1], seq) end
return tonumber(seq)
`

// KEYS: stream, seq, meta, thread set, own by-inst set.
// ARGV: prefix, k, from instance, self, live ttl s, journaled steps, now ms.
// A resume takes the live entry over (S10, M1): the owner moves from the old
// runner to this one, the entry is live again, and the frames past the last
// journaled step's boundary (the cut step, which the resume re-issues) are
// deleted. A "resume" frame carrying rewindToSeq tells live clients to drop
// what they hold past it. Returns { seq, rewindToSeq } or { 0, -1 } when the
// entry is gone or another process owns it.
const TAKEOVER_LUA = `${LUA_HELPERS}
local k, from, self_inst = ARGV[2], ARGV[3], ARGV[4]
local ttl = tonumber(ARGV[5])
local owner = redis.call('HGET', KEYS[3], 'instanceId')
if not owner then return { 0, -1 } end
if owner ~= from and owner ~= self_inst then return { 0, -1 } end
if owner ~= self_inst then redis.call('SREM', by_inst(owner), k) end
local rewind = tonumber(redis.call('HGET', KEYS[3], 'b' .. ARGV[6]) or '')
if not rewind then rewind = tonumber(redis.call('GET', KEYS[2]) or '0') end
for _, e in ipairs(redis.call('XRANGE', KEYS[1], '-', '+')) do
  local f = e[2]
  local seq, action = nil, nil
  for i = 1, #f, 2 do
    if f[i] == 'seq' then seq = tonumber(f[i + 1]) end
    if f[i] == 'a' then action = f[i + 1] end
  end
  if seq and seq > rewind and action ~= 'checkpoint' then redis.call('XDEL', KEYS[1], e[1]) end
end
redis.call('HSET', KEYS[3], 'instanceId', self_inst, 'phase', 'started', 'lastSeenAt', ARGV[7], 'lastKind', '')
redis.call('SADD', KEYS[4], k)
redis.call('SADD', KEYS[5], k)
local seq = redis.call('INCR', KEYS[2])
redis.call('XADD', KEYS[1], '*', 'seq', seq, 'a', 'resume', 'd', cjson.encode({ rewindToSeq = rewind }), 's', '', 'i', '', 't', ARGV[7])
expire_turn(k, ttl)
redis.call('EXPIRE', KEYS[4], ttl)
redis.call('EXPIRE', KEYS[5], ttl)
return { seq, rewind }
`

// KEYS: own by-inst set. ARGV: prefix, self, live ttl s, k...
// Puts back this instance's live turns; returns triples of those re-added.
const RECOVER_LUA = `${LUA_HELPERS}
local out = {}
local ttl = tonumber(ARGV[3])
for i = 4, #ARGV do
  local k = ARGV[i]
  local f = redis.call('HMGET', turn_base(k) .. ':meta', 'threadId', 'orgId', 'requesterId', 'instanceId', 'phase')
  if f[4] == ARGV[2] and is_live(f[5]) and f[1] then
    local tk = prefix .. 'agent:live:thread:' .. f[1]
    local added = redis.call('SADD', tk, k)
    redis.call('SADD', KEYS[1], k)
    redis.call('EXPIRE', tk, ttl)
    redis.call('EXPIRE', KEYS[1], ttl)
    expire_turn(k, ttl)
    if added == 1 then
      out[#out + 1] = f[1]
      out[#out + 1] = f[2] or ''
      out[#out + 1] = f[3] or ''
    end
  end
end
return out
`

// KEYS: stream. ARGV: seq, snapshot json, stream id of the entry carrying seq.
// Appends the checkpoint, then trims every entry up to and including that one.
// Entries other producers added meanwhile sit between them and are kept: the
// fold applies them after the checkpoint by seq.
const CHECKPOINT_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
redis.call('XADD', KEYS[1], '*', 'seq', ARGV[1], 'a', 'checkpoint', 'd', ARGV[2])
local nxt = redis.call('XRANGE', KEYS[1], '(' .. ARGV[3], '+', 'COUNT', 1)
if #nxt > 0 then redis.call('XTRIM', KEYS[1], 'MINID', nxt[1][1]) end
return 1
`

const scriptShas = new Map<string, string>()

/** The SHA1 Redis files a script under, computed once per script body. */
function scriptSha(body: string): string {
  let sha = scriptShas.get(body)
  if (!sha) {
    sha = crypto.createHash("sha1").update(body).digest("hex")
    scriptShas.set(body, sha)
  }
  return sha
}

/** The ioredis subset the registry uses, so a test can wrap or hang it. */
export interface TurnRedis {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>
  evalsha(sha: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>
  xrange(key: string, start: string, end: string): Promise<[string, string[]][]>
  hmget(key: string, ...fields: string[]): Promise<(string | null)[]>
  publish(channel: string, message: string): Promise<number>
}

/** The subscriber connection the turn-change channel is read on. */
export interface TurnSubscriber {
  subscribe(channel: string): Promise<unknown>
  on(event: "message", fn: (channel: string, message: string) => void): unknown
}

export class LiveTurnTimeout extends Error {
  constructor(what: string, ms: number) {
    super(`live turn registry: Redis did not answer ${what} within ${ms} ms`)
    this.name = "LiveTurnTimeout"
  }
}

function bounded<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return boundedBy(p, ms, () => new LiveTurnTimeout(what, ms))
}

/** What a recorded frame carries (S28): its turn's `seq`, and its item when it has one. */
export interface RecordedFrame {
  seq: number
  itemId?: string
  itemKind?: LiveItemKind
}

/** A live turn's identity and liveness, without its content (P2-13). */
export interface LiveAgentTurnMeta {
  threadId: string
  orgId: string
  agentId: string | null
  turnId: string | null
  askId: string | null
  requesterId: string
  startedAt: number
  lastSeenAt: number
  instanceId: string
  phase: "accepted" | "started"
}

/** A turn began or ended in a thread: what a listener is told. */
export interface LiveAgentTurnChange {
  threadId: string
  orgId: string
  /** The user whose request started the turn; empty when unknown. */
  requesterId: string
  running: boolean
}

export interface LiveTurnRegistryOptions {
  client?: TurnRedis
  /** The connection the change channel is subscribed on. Default: the shared subscriber. */
  subscriber?: TurnSubscriber
  instanceId?: string
  /** The client's key prefix, passed to scripts and the channel name. Default `REDIS_PREFIX`. */
  prefix?: string
  /** Bound on each Redis call (default 1000 ms). */
  commandTimeoutMs?: number
  /** Frames between checkpoints (default 500). */
  checkpointEvery?: number
  /** How long an ended turn's stream stays readable (default `AGENT_TURN_STREAM_TTL_S`). */
  streamTtlS?: number
}

const ITEM_KINDS: ReadonlySet<string> = new Set(["reasoning", "text", "tool"])

function isItemKind(v: string): v is LiveItemKind {
  return ITEM_KINDS.has(v)
}

function parseJson(raw: string | undefined): unknown {
  if (raw === undefined || raw === "") return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

function parseScopes(raw: string | undefined): string[] | null {
  const v = parseJson(raw)
  return Array.isArray(v) && v.every((s) => typeof s === "string") ? v : null
}

function isSnapshot(v: unknown): v is LiveAgentStreamSnapshot {
  return (
    typeof v === "object" &&
    v !== null &&
    "timeline" in v &&
    Array.isArray(v.timeline) &&
    "toolCalls" in v &&
    Array.isArray(v.toolCalls)
  )
}

/** One XRANGE entry → a fold entry, plus its stream id. */
function parseEntry([id, flat]: [string, string[]]): { id: string; entry: TurnEntry } {
  const f: Record<string, string> = {}
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const name = flat[i]
    const value = flat[i + 1]
    if (name !== undefined && value !== undefined) f[name] = value
  }
  const action = f.a ?? ""
  const data = parseJson(f.d)
  const entry: TurnEntry = {
    seq: Number(f.seq ?? 0),
    action,
    data: action !== "checkpoint" && isRecord(data) ? data : {},
    scopes: parseScopes(f.s),
    itemId: f.i ?? "",
    at: Number(f.t ?? 0),
  }
  if (action === "checkpoint" && isSnapshot(data)) entry.checkpoint = data
  return { id, entry }
}

function metaToIdentity(m: LiveAgentTurnMeta): TurnIdentity {
  return {
    threadId: m.threadId,
    orgId: m.orgId,
    agentId: m.agentId,
    turnId: m.turnId,
    askId: m.askId,
    requesterId: m.requesterId,
    startedAt: m.startedAt,
    lastSeenAt: m.lastSeenAt,
  }
}

const nullable = (v: string | null | undefined): string | null => (v ? v : null)

export class LiveTurnRegistry {
  readonly instanceId: string
  private readonly client: TurnRedis
  private readonly subscriberOpt: TurnSubscriber | undefined
  private readonly prefix: string
  private readonly commandTimeoutMs: number
  private readonly checkpointEvery: number
  private readonly streamTtlS: number
  /** Dedups this process's own change messages (the event bus `_msgId` pattern). */
  private readonly origin = crypto.randomUUID()

  /** Per-turn promise chains: one process's events of a turn are recorded in call order. */
  private readonly chains = new Map<string, Promise<unknown>>()
  /** Turns this process started or accepted and has not seen end: what a recovery rewrites. */
  private readonly owned = new Set<string>()
  private readonly listeners = new Set<(change: LiveAgentTurnChange) => void>()
  private subscribing: Promise<void> | null = null

  /**
   * Run a script by its SHA1 (EVALSHA), sending the whole body (EVAL, which also caches it) only
   * when Redis answers NOSCRIPT: after a restart, a failover or a SCRIPT FLUSH. Every frame runs
   * RECORD_LUA, so this keeps a frame's request to its arguments.
   */
  private async script(
    body: string,
    numKeys: number,
    ...args: (string | number)[]
  ): Promise<unknown> {
    try {
      return await this.client.evalsha(scriptSha(body), numKeys, ...args)
    } catch (err) {
      if (!(err instanceof Error) || !err.message.startsWith("NOSCRIPT")) throw err
      return await this.client.eval(body, numKeys, ...args)
    }
  }

  constructor(opts: LiveTurnRegistryOptions = {}) {
    this.client = opts.client ?? redis
    this.subscriberOpt = opts.subscriber
    this.instanceId = opts.instanceId ?? INSTANCE_ID
    this.prefix = opts.prefix ?? REDIS_PREFIX
    this.commandTimeoutMs = opts.commandTimeoutMs ?? 1_000
    this.checkpointEvery = opts.checkpointEvery ?? DEFAULT_CHECKPOINT_EVERY
    this.streamTtlS = opts.streamTtlS ?? env.AGENT_TURN_STREAM_TTL_S
  }

  private get liveTtlS(): number {
    return STALE_AFTER_S + this.streamTtlS
  }

  private get channel(): string {
    return `${this.prefix}${CHANGES_CHANNEL}`
  }

  // ── writes ─────────────────────────────────────────────────────────────

  /** Run `fn` after every earlier call for the same turn in this process. */
  private enqueue<T>(k: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(k) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    this.chains.set(k, next)
    const drop = () => {
      if (this.chains.get(k) === next) this.chains.delete(k)
    }
    next.then(drop, drop)
    return next
  }

  private async runRecord(
    k: string,
    threadId: string,
    orgId: string,
    action: string,
    data: Record<string, unknown>,
    visibility: AgentStreamVisibility,
  ): Promise<{
    seq: number
    itemId: string
    itemKind: string
    changed: boolean
    requesterId: string
    mismatch: boolean
  }> {
    const delta = typeof data.delta === "string" ? data.delta : ""
    const kind = action === "reasoning" ? "reasoning" : action === "delta" ? "text" : ""
    const opens = action === "reasoning" || (action === "delta" && delta !== "") ? "1" : "0"
    const base = turnBase(k)
    const res = await bounded(
      this.script(
        RECORD_LUA,
        6,
        base,
        `${base}:seq`,
        `${base}:meta`,
        `${base}:tools`,
        threadKey(threadId),
        byInstKey(this.instanceId),
        this.prefix,
        k,
        action,
        JSON.stringify(data),
        JSON.stringify(readScopeTag(visibility)),
        String(Date.now()),
        this.instanceId,
        kind,
        opens,
        String(data.toolCallId ?? ""),
        String(this.liveTtlS),
        String(this.streamTtlS),
        threadId,
        orgId,
        visibility.agentId ?? "",
        visibility.turnId ?? "",
        visibility.askId ?? "",
        visibility.requesterId ?? "",
      ),
      this.commandTimeoutMs,
      `record ${action}`,
    )
    const row = Array.isArray(res) ? res : []
    return {
      seq: Number(row[0] ?? 0),
      itemId: String(row[1] ?? ""),
      itemKind: String(row[2] ?? ""),
      changed: Number(row[3] ?? 0) === 1,
      requesterId: String(row[4] ?? ""),
      mismatch: Number(row[5] ?? 0) === 1,
    }
  }

  /**
   * Record one live stream event and allocate its frame's `seq` and item. Call
   * with the SAME action names/payloads the `agent_stream` WS broadcast uses
   * (start/reasoning/delta/tool_call/tool_result/done/error/clear), and put the
   * returned fields on that broadcast.
   */
  record(
    threadId: string,
    orgId: string,
    action: string,
    data: Record<string, unknown> = {},
    visibility: AgentStreamVisibility = {},
  ): Promise<RecordedFrame> {
    const k = liveTurnKey(threadId, visibility.agentId, visibility.turnId)
    const frame = this.enqueue(k, async (): Promise<RecordedFrame> => {
      const r = await this.runRecord(k, threadId, orgId, action, data, visibility)
      if (action === "start") {
        this.owned.add(k)
        if (r.changed) this.tell({ threadId, orgId, requesterId: r.requesterId, running: true })
      } else if (TERMINAL_ACTIONS.has(action)) {
        this.owned.delete(k)
        if (r.changed) this.tell({ threadId, orgId, requesterId: r.requesterId, running: false })
      } else if (r.mismatch) {
        // The requester is pinned at `start` (see `requesterId`), so a later
        // claim is never honoured. A DIFFERENT one is a producer bug worth
        // seeing: an emitter stamping the wrong identity, or two runs colliding.
        log.warn(
          { threadId, action, pinned: r.requesterId },
          "agent stream: ignoring a later requesterId claim, the replay exemption is pinned at start",
        )
      }
      const out: RecordedFrame = { seq: r.seq }
      if (r.itemId && isItemKind(r.itemKind)) {
        out.itemId = r.itemId
        out.itemKind = r.itemKind
      }
      return out
    })
    void frame.then(
      (f) => {
        if (f.seq > 0 && f.seq % this.checkpointEvery === 0) {
          void this.enqueue(k, () => this.checkpoint(k, f.seq)).catch((err) =>
            log.warn({ err, threadId }, "agent stream checkpoint failed"),
          )
        }
      },
      () => {},
    )
    return frame
  }

  /** Fold the turn through `seq`, append it as a checkpoint, trim what it covers (P2-2). */
  private async checkpoint(k: string, seq: number): Promise<void> {
    const base = turnBase(k)
    const [meta, raw] = await Promise.all([
      bounded(
        this.client.hmget(`${base}:meta`, ...META_FIELDS),
        this.commandTimeoutMs,
        "checkpoint meta",
      ),
      bounded(this.client.xrange(base, "-", "+"), this.commandTimeoutMs, "checkpoint xrange"),
    ])
    const m = this.parseMetaRow(meta)
    if (!m) return
    const parsed = raw.map(parseEntry)
    const at = parsed.find((p) => !p.entry.checkpoint && p.entry.seq === seq)
    if (!at) return
    const snap = foldTurn(
      metaToIdentity(m),
      parsed.filter((p) => p.entry.seq <= seq).map((p) => p.entry),
    )
    snap.seq = seq
    await bounded(
      this.script(CHECKPOINT_LUA, 1, base, String(seq), JSON.stringify(snap), at.id),
      this.commandTimeoutMs,
      "checkpoint",
    )
  }

  /**
   * The server has taken a turn on: it runs from now, before its first frame.
   *
   * Setting a turn up (the org's apps, the credit check, compacting a long
   * history) can take many seconds before `start`, and a view loaded in that
   * window (a page reload just after the ask was sent) learns what runs only
   * from this registry. The entry carries no content, and its scopes are
   * unknown (`null`), so the replay route serves it to the turn's requester
   * alone until `start`, under the same key, replaces it. `withdraw` removes it
   * for a turn that ends before `start`, and never touches a started run: it
   * says whether it removed the entry.
   */
  async accept(
    threadId: string,
    orgId: string,
    turn: { agentId: string | null; turnId: string; askId?: string; requesterId: string },
  ): Promise<{ accepted: boolean; withdraw: () => Promise<boolean> }> {
    const visibility: AgentStreamVisibility = {
      agentId: turn.agentId,
      turnId: turn.turnId,
      askId: turn.askId ?? null,
      requesterId: turn.requesterId,
    }
    const k = liveTurnKey(threadId, turn.agentId, turn.turnId)
    const accepted = await this.enqueue(k, async () => {
      const r = await this.runRecord(k, threadId, orgId, "accepted", {}, visibility)
      if (!r.changed) return false
      this.owned.add(k)
      this.tell({ threadId, orgId, requesterId: turn.requesterId, running: true })
      return true
    })
    if (!accepted) return { accepted: false, withdraw: async () => false }
    return {
      accepted: true,
      withdraw: () =>
        this.enqueue(k, async () => {
          const r = await this.runRecord(k, threadId, orgId, "withdraw", {}, visibility)
          if (!r.changed) return false
          this.owned.delete(k)
          this.tell({ threadId, orgId, requesterId: r.requesterId, running: false })
          return true
        }),
    }
  }

  /** The run is still alive though it emitted nothing: keep it past the stale cap from now. */
  async touch(threadId: string, agentId: string | null): Promise<void> {
    await bounded(
      this.script(
        TOUCH_LUA,
        1,
        threadKey(threadId),
        this.prefix,
        agentId ?? "",
        String(Date.now()),
        String(this.liveTtlS),
      ),
      this.commandTimeoutMs,
      "touch",
    )
  }

  // ── reads ──────────────────────────────────────────────────────────────

  private parseMetaRow(f: (string | null | undefined)[]): LiveAgentTurnMeta | null {
    const get = (i: number) => f[i] ?? ""
    const phase = get(9)
    if (phase !== "accepted" && phase !== "started") return null
    return {
      threadId: get(0),
      orgId: get(1),
      agentId: nullable(get(2)),
      turnId: nullable(get(3)),
      askId: nullable(get(4)),
      requesterId: get(5),
      startedAt: Number(get(6)) || 0,
      lastSeenAt: Number(get(7)) || 0,
      instanceId: get(8),
      phase,
    }
  }

  private async listMetaWithKeys(
    threadId: string,
  ): Promise<{ k: string; meta: LiveAgentTurnMeta }[]> {
    const res = await bounded(
      this.script(
        LIST_META_LUA,
        1,
        threadKey(threadId),
        this.prefix,
        this.instanceId,
        String(Date.now()),
        String(STALE_AFTER_MS),
      ),
      this.commandTimeoutMs,
      "list live turns",
    )
    const out: { k: string; meta: LiveAgentTurnMeta }[] = []
    if (!Array.isArray(res)) return out
    for (const row of res) {
      if (!Array.isArray(row)) continue
      const meta = this.parseMetaRow(row.slice(1).map((v) => (v == null ? "" : String(v))))
      if (meta) out.push({ k: String(row[0]), meta })
    }
    return out.sort((a, b) => a.meta.startedAt - b.meta.startedAt)
  }

  /**
   * The live turns of a thread, identity and liveness only (P2-13): one script
   * call, no stream read. For deciders that poll (the supersede wait, tours).
   */
  async listMeta(threadId: string): Promise<LiveAgentTurnMeta[]> {
    return (await this.listMetaWithKeys(threadId)).map((r) => r.meta)
  }

  /** Every in-flight run in one thread, folded, oldest first. */
  async list(threadId: string): Promise<LiveAgentStreamSnapshot[]> {
    const turns = await this.listMetaWithKeys(threadId)
    return Promise.all(
      turns.map(async ({ k, meta }) => {
        const raw = await bounded(
          this.client.xrange(turnBase(k), "-", "+"),
          this.commandTimeoutMs,
          "read live turn",
        )
        const id = metaToIdentity(meta)
        if (raw.length === 0) return emptySnapshot(id, null)
        return foldTurn(
          id,
          raw.map((r) => parseEntry(r).entry),
        )
      }),
    )
  }

  /**
   * ONE in-flight run, or null: the agent's newest turn when an agent is named
   * (an older turn a newer request replaced may still be finishing), else the
   * newest run in the thread.
   */
  async get(threadId: string, agentId?: string | null): Promise<LiveAgentStreamSnapshot | null> {
    const all = await this.list(threadId)
    if (agentId !== undefined) {
      const own = all.filter((snap) => snap.agentId === (agentId ?? null))
      return own[own.length - 1] ?? null
    }
    return all[all.length - 1] ?? null
  }

  // ── turn changes ───────────────────────────────────────────────────────

  /**
   * Be told when a turn starts or ends, in this process or any other.
   * Listeners run synchronously and must not throw (a throw is swallowed).
   */
  onChange(fn: (change: LiveAgentTurnChange) => void): () => void {
    this.listeners.add(fn)
    void this.subscribeChanges().catch((err) =>
      log.warn({ err }, "live turn changes: subscribe failed"),
    )
    return () => this.listeners.delete(fn)
  }

  /** Subscribe to other processes' turn changes. Idempotent; resolves once subscribed. */
  subscribeChanges(): Promise<void> {
    if (!this.subscribing) {
      const sub = this.subscriberOpt ?? redisSub
      const channel = this.channel
      sub.on("message", (ch, message) => {
        if (ch !== channel) return
        this.onRemote(message)
      })
      this.subscribing = sub.subscribe(channel).then(() => {})
      this.subscribing.catch(() => {
        this.subscribing = null
      })
    }
    return this.subscribing
  }

  private onRemote(message: string): void {
    const m = parseJson(message)
    if (!isRecord(m)) return
    if (m.o === this.origin) return
    if (typeof m.threadId !== "string" || typeof m.running !== "boolean") return
    this.fire({
      threadId: m.threadId,
      orgId: typeof m.orgId === "string" ? m.orgId : "",
      requesterId: typeof m.requesterId === "string" ? m.requesterId : "",
      running: m.running,
    })
  }

  private fire(change: LiveAgentTurnChange): void {
    for (const fn of this.listeners) {
      try {
        fn(change)
      } catch {
        // A listener's failure never touches the stream.
      }
    }
  }

  private tell(change: LiveAgentTurnChange): void {
    this.fire(change)
    void this.client
      .publish(this.channel, JSON.stringify({ o: this.origin, ...change }))
      .catch((err) =>
        log.warn({ err, threadId: change.threadId }, "live turn change publish failed"),
      )
  }

  private tellTriples(res: unknown, running: boolean): void {
    if (!Array.isArray(res)) return
    for (let i = 0; i + 2 < res.length; i += 3) {
      this.tell({
        threadId: String(res[i]),
        orgId: String(res[i + 1] ?? ""),
        requesterId: String(res[i + 2] ?? ""),
        running,
      })
    }
  }

  // ── instance liveness hooks ────────────────────────────────────────────

  /** The leader's sweep: take a dead instance's turns off the index; no terminal is written. */
  async cleanupDeadInstance(deadId: string, keep: readonly string[] = []): Promise<void> {
    const res = await bounded(
      this.script(
        DEAD_LUA,
        1,
        byInstKey(deadId),
        this.prefix,
        deadId,
        String(this.streamTtlS),
        ...keep,
      ),
      this.commandTimeoutMs,
      "cleanupDeadInstance",
    )
    this.tellTriples(res, false)
  }

  /** Mark the end of a turn's `step`-th step in its stream (S10, M1). In call order. */
  markStepBoundary(
    threadId: string,
    agentId: string | null,
    turnId: string | null | undefined,
    step: number,
  ): Promise<void> {
    const k = liveTurnKey(threadId, agentId, turnId)
    const base = turnBase(k)
    return this.enqueue(k, async () => {
      await bounded(
        this.script(STEP_BOUNDARY_LUA, 2, `${base}:meta`, `${base}:seq`, String(step)),
        this.commandTimeoutMs,
        "markStepBoundary",
      )
    })
  }

  /** A resume takes a turn's live entry over (see TAKEOVER_LUA). */
  async takeOver(input: {
    threadId: string
    agentId: string | null
    turnId: string | null
    fromInstance: string
    steps: number
  }): Promise<{ seq: number; rewindToSeq: number } | null> {
    const k = liveTurnKey(input.threadId, input.agentId, input.turnId)
    const base = turnBase(k)
    const res = (await bounded(
      this.script(
        TAKEOVER_LUA,
        5,
        base,
        `${base}:seq`,
        `${base}:meta`,
        threadKey(input.threadId),
        byInstKey(this.instanceId),
        this.prefix,
        k,
        input.fromInstance,
        this.instanceId,
        String(this.liveTtlS),
        String(input.steps),
        String(Date.now()),
      ),
      this.commandTimeoutMs,
      "takeOver",
    )) as [number, number] | null
    if (!res || Number(res[0]) === 0) return null
    this.owned.add(k)
    return { seq: Number(res[0]), rewindToSeq: Number(res[1]) }
  }

  /** After a lapse: put back the turns this instance still runs (P2-1). */
  async republishOwn(): Promise<void> {
    if (this.owned.size === 0) return
    const res = await bounded(
      this.script(
        RECOVER_LUA,
        1,
        byInstKey(this.instanceId),
        this.prefix,
        this.instanceId,
        String(this.liveTtlS),
        ...this.owned,
      ),
      this.commandTimeoutMs,
      "republishOwn",
    )
    this.tellTriples(res, true)
  }

  /** Forget local state (tests). */
  resetLocal(): void {
    this.chains.clear()
    this.owned.clear()
  }
}

/** Wire a turn registry into an instance registry's dead-instance and recovery hooks. */
export function registerLiveTurnHooks(
  reg: Pick<InstanceRegistry, "onDeadInstance" | "onInstanceRecovered">,
  turns: LiveTurnRegistry,
): void {
  reg.onDeadInstance("agent-live-turns", async (deadId) =>
    turns.cleanupDeadInstance(deadId, await durableLiveTurnKeys(deadId)),
  )
  reg.onInstanceRecovered("agent-live-turns", () => turns.republishOwn())
}

/**
 * The live keys of a dead instance's turns that a resume will continue
 * (their durable record is running or handed off). Set at boot by the turn
 * runtime (turn-resume.ts); unset (tests, a bare registry) keeps nothing.
 * A failure to read keeps nothing either: the turn's live view is dropped,
 * and the resume's takeover then finds no entry and the turn still finishes.
 */
let durableLiveTurnKeysFn: ((deadId: string) => Promise<string[]>) | null = null

export function setDurableLiveTurnKeys(fn: ((deadId: string) => Promise<string[]>) | null): void {
  durableLiveTurnKeysFn = fn
}

async function durableLiveTurnKeys(deadId: string): Promise<string[]> {
  if (!durableLiveTurnKeysFn) return []
  try {
    return await durableLiveTurnKeysFn(deadId)
  } catch {
    return []
  }
}

// ── the process's registry ────────────────────────────────────────────────

const processTurns = new LiveTurnRegistry()
registerLiveTurnHooks({ onDeadInstance, onInstanceRecovered }, processTurns)

/** Record one live stream event; resolves with the frame's `seq` and item (see `LiveTurnRegistry.record`). */
export function recordAgentStreamEvent(
  threadId: string,
  orgId: string,
  action: string,
  data: Record<string, unknown> = {},
  visibility: AgentStreamVisibility = {},
): Promise<RecordedFrame> {
  return processTurns.record(threadId, orgId, action, data, visibility)
}

/** See `LiveTurnRegistry.markStepBoundary`. */
export function markAgentStreamStepBoundary(
  threadId: string,
  agentId: string | null,
  turnId: string | null | undefined,
  step: number,
): Promise<void> {
  return processTurns.markStepBoundary(threadId, agentId, turnId, step)
}

/** See `LiveTurnRegistry.takeOver`. */
export function takeOverLiveTurn(input: {
  threadId: string
  orgId: string
  agentId: string | null
  turnId: string | null
  fromInstance: string
  steps: number
}): Promise<{ seq: number; rewindToSeq: number } | null> {
  return processTurns.takeOver(input)
}

/** See `LiveTurnRegistry.accept`. */
export function recordAgentTurnAccepted(
  threadId: string,
  orgId: string,
  turn: { agentId: string | null; turnId: string; askId?: string; requesterId: string },
): Promise<{ accepted: boolean; withdraw: () => Promise<boolean> }> {
  return processTurns.accept(threadId, orgId, turn)
}

/** See `LiveTurnRegistry.touch`. */
export function touchAgentStream(threadId: string, agentId: string | null): Promise<void> {
  return processTurns.touch(threadId, agentId)
}

/** See `LiveTurnRegistry.get`. */
export function getLiveAgentStream(
  threadId: string,
  agentId?: string | null,
): Promise<LiveAgentStreamSnapshot | null> {
  return processTurns.get(threadId, agentId)
}

/** Every in-flight run in one thread, oldest first. A room that addressed two
 *  agents has two, and both of them are somebody's turn. */
export function listLiveAgentStreams(threadId: string): Promise<LiveAgentStreamSnapshot[]> {
  return processTurns.list(threadId)
}

/** The live turns of a thread without their content (P2-13); see `LiveTurnRegistry.listMeta`. */
export function listLiveAgentTurns(threadId: string): Promise<LiveAgentTurnMeta[]> {
  return processTurns.listMeta(threadId)
}

/**
 * Be told when a turn starts (accepted, or its first `start`) or ends (done,
 * error, clear, withdrawn, or its process died), in any process. Listeners run
 * synchronously and must not throw (a throw is swallowed). Returns the unsubscribe.
 */
export function onLiveAgentTurnChange(fn: (change: LiveAgentTurnChange) => void): () => void {
  return processTurns.onChange(fn)
}

// ── the org purge ──────────────────────────────────────────────────────────

/** SCAN batch for the org purge's walk over turn keys (see org/purge/external.ts). */
const PURGE_SCAN_COUNT = 5000

interface OrgLiveTurn {
  k: string
  threadId: string | null
  instanceId: string | null
}

/**
 * The live turns of one org, found by the turn key builder's pattern: a turn key
 * is a hash of thread, agent and turn, so its name does not carry the org; its
 * meta hash does. Ended turns stay readable for `AGENT_TURN_STREAM_TTL_S`, so
 * they are found too.
 */
async function orgLiveTurns(orgId: string): Promise<OrgLiveTurn[]> {
  const out: OrgLiveTurn[] = []
  const suffix = ":meta"
  let cursor = "0"
  do {
    const [next, keys] = await redis.scan(
      cursor,
      "MATCH",
      `${REDIS_PREFIX}${turnBase("*")}${suffix}`,
      "COUNT",
      PURGE_SCAN_COUNT,
    )
    cursor = next
    if (keys.length === 0) continue
    // `scan` answers full names; the client prefixes again.
    const metas = keys.map((key) => key.slice(REDIS_PREFIX.length))
    const pipe = redis.pipeline()
    for (const m of metas) pipe.hmget(m, "orgId", "threadId", "instanceId")
    const rows = (await pipe.exec()) ?? []
    rows.forEach(([err, fields], i) => {
      if (err) throw err
      const [org, threadId, instanceId] = fields as (string | null)[]
      if (org !== orgId) return
      const meta = metas[i] as string
      const k = meta.slice(turnBase("").length, -suffix.length)
      out.push({ k, threadId, instanceId })
    })
  } while (cursor !== "0")
  return out
}

/**
 * Delete every live turn of the org (stream, seq, meta, tools) and drop it from
 * its thread and instance indexes. Part of the org purge: a turn holds the org's
 * text, reasoning, tool arguments and results. Returns the turns removed.
 */
export async function purgeOrgLiveTurns(orgId: string): Promise<number> {
  const turns = await orgLiveTurns(orgId)
  for (const t of turns) {
    const b = turnBase(t.k)
    const pipe = redis.pipeline().unlink(b, `${b}:seq`, `${b}:meta`, `${b}:tools`)
    if (t.threadId) pipe.srem(threadKey(t.threadId), t.k)
    if (t.instanceId) pipe.srem(byInstKey(t.instanceId), t.k)
    await pipe.exec()
  }
  return turns.length
}

/** How many live turns of the org Redis still holds (the purge's verify step). */
export async function countOrgLiveTurns(orgId: string): Promise<number> {
  return (await orgLiveTurns(orgId)).length
}

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const AgentStreamRegistryTestAccess = {
  /** Test-only: deletes this namespace's live-turn keys and the local state. */
  async reset(): Promise<void> {
    processTurns.resetLocal()
    for (const pattern of ["agent:turn:*", "agent:live:*"]) {
      let cursor = "0"
      do {
        const [next, keys] = await redis.scan(
          cursor,
          "MATCH",
          `${REDIS_PREFIX}${pattern}`,
          "COUNT",
          500,
        )
        cursor = next
        // `scan` answers full names; `del` would prefix them again.
        if (keys.length > 0) await redis.del(...keys.map((k) => k.slice(REDIS_PREFIX.length)))
      } while (cursor !== "0")
    }
  },
}
