// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The per-org WebSocket replay buffer, bounded by size AND age.
//
// Every stored event is kept in a sorted set `ws:events:<org>` scored by its
// replay id, so a reconnecting client can ask for "everything after my cursor".
// The buffer used to be bounded only by `EXPIRE 300` refreshed on every write:
// in a steadily busy org the TTL never lapses and the set grew without bound
// (design audit 2026-09-30, finding 12).
//
// Design:
// - One Lua script per write (one round trip, atomic): ZADD, trim to the newest
//   `REPLAY_BUFFER_MAX_EVENTS`, drop members older than `REPLAY_BUFFER_MAX_AGE_MS`,
//   refresh the TTL.
// - Age needs a time per member, and the score is the replay id, so the member
//   carries its buffering time as a fixed 13-digit millisecond prefix in front
//   of the frame. Lua reads the prefix with `string.sub`, no JSON decoding.
//   `decodeBufferedFrame` strips it; a member without it (written before this
//   change) starts with `{` and is returned as-is, and the script treats it as
//   expired, so the old format drains away on its own.
// - Trimming opens a gap for a client whose cursor is older than what was
//   dropped. The script therefore records the highest dropped replay id in
//   `ws:events-trimmed:{<org>}` (same TTL), and the hello replay forces a full
//   `sync` when the cursor is below it. That watermark is exact: replay ids can
//   legitimately skip (a retried outbox attempt takes a fresh id), so "the first
//   buffered id is not cursor + 1" would resync clients for no reason.
import type Redis from "ioredis"

/** Newest events kept per org. Past it a reconnect resyncs over REST anyway. */
export const REPLAY_BUFFER_MAX_EVENTS = 2_000
/** Oldest event kept, and the idle TTL of the whole buffer. */
export const REPLAY_BUFFER_MAX_AGE_MS = 300_000

const TIME_PREFIX_LENGTH = 13

// Both keys of one org carry the same `{org}` hash tag, so the append script,
// which touches both, stays on one slot if Redis is ever clustered.
export function replayBufferKey(orgId: string | undefined): string {
  return `ws:events:{${orgId ?? "global"}}`
}

export function replayTrimmedKey(orgId: string | undefined): string {
  return `ws:events-trimmed:{${orgId ?? "global"}}`
}

// KEYS[1] buffer, KEYS[2] trim watermark.
// ARGV[1] replay id, ARGV[2] member, ARGV[3] max events, ARGV[4] ttl seconds,
// ARGV[5] cutoff ms (members buffered before it are dropped).
// Returns how many members were dropped.
const APPEND_SCRIPT = `
local key = KEYS[1]
local trimmedKey = KEYS[2]
local maxEvents = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])
local cutoff = tonumber(ARGV[5])
redis.call('ZADD', key, ARGV[1], ARGV[2])
local highest = nil
local dropped = 0
local overflow = redis.call('ZCARD', key) - maxEvents
if overflow > 0 then
  local last = redis.call('ZRANGE', key, overflow - 1, overflow - 1, 'WITHSCORES')
  highest = tonumber(last[2])
  redis.call('ZREMRANGEBYRANK', key, 0, overflow - 1)
  dropped = overflow
end
for _ = 1, 64 do
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  if oldest[1] == nil then break end
  local at = tonumber(string.sub(oldest[1], 1, ${TIME_PREFIX_LENGTH}))
  if at ~= nil and at >= cutoff then break end
  highest = tonumber(oldest[2])
  redis.call('ZREMRANGEBYRANK', key, 0, 0)
  dropped = dropped + 1
end
if highest ~= nil then
  local previous = tonumber(redis.call('GET', trimmedKey) or '0')
  if highest > previous then redis.call('SET', trimmedKey, highest) end
end
redis.call('EXPIRE', key, ttl)
if redis.call('EXISTS', trimmedKey) == 1 then redis.call('EXPIRE', trimmedKey, ttl) end
return dropped
`

export function encodeBufferedFrame(frame: string, now: number): string {
  return String(now).padStart(TIME_PREFIX_LENGTH, "0") + frame
}

/** The frame a buffered member carries, whichever format wrote it. */
export function decodeBufferedFrame(member: string): string {
  return member.startsWith("{") ? member : member.slice(TIME_PREFIX_LENGTH)
}

/**
 * Append one frame to the org's replay buffer and enforce both bounds.
 * `now` is injectable for tests.
 */
export async function appendToReplayBuffer(
  redis: Pick<Redis, "eval">,
  orgId: string | undefined,
  eventId: number,
  frame: string,
  now: number = Date.now(),
): Promise<number> {
  const dropped = await redis.eval(
    APPEND_SCRIPT,
    2,
    replayBufferKey(orgId),
    replayTrimmedKey(orgId),
    eventId,
    encodeBufferedFrame(frame, now),
    REPLAY_BUFFER_MAX_EVENTS,
    Math.ceil(REPLAY_BUFFER_MAX_AGE_MS / 1000),
    now - REPLAY_BUFFER_MAX_AGE_MS,
  )
  return Number(dropped) || 0
}
