// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Rolling Anthropic cache breakpoints for the steps of one agent run.
//
// An agent turn is a tool loop: every step resends the whole request plus the
// tool results the previous step produced. The breakpoints set at assembly
// (system block, newest persisted message; for a sub-run the dispatch prompt)
// stop where the run starts, so before this every step re-billed the run's own
// tail (runtime context, every assistant step, every tool result) at the full
// input rate, once per remaining step.
//
// Two 5-minute breakpoints are placed on each step's request, AFTER the stale
// result clipper ran (so the bytes they cover are the ones the next step sends):
//
//   END  the newest message of the step (before any per-step injection: the
//        mailbox plaintext, a mid-run guide or skill, all of which are gone or
//        moved by the next step). The next step reads everything up to here.
//   PRE  the message just before the oldest tool result the clipper has not
//        examined yet. A step that clips that result rewrites bytes BEFORE the
//        previous END, so END misses; PRE is the last point the clip cannot
//        reach, and the step reads up to it instead of re-writing the run.
//
// Without PRE, a loop past KEEP_RECENT_TOOL_RESULTS steps that clips one large
// result per step would miss on every step and re-write its whole tail at the
// write premium: more than not caching at all (the cost model is in the commit
// that introduced this file).
//
// Budget: Anthropic honours 4 breakpoints per request. Assembly sets 2 (system
// + transcript, or system + dispatch prompt), these add at most 2. TTL order:
// a longer TTL must precede a shorter one, so neither mark is ever placed at or
// before an existing (assembly) mark. Marked messages are fresh copies, and a
// copy handed back by the SDK on the next step is mapped back to its original
// first, so the marks never accumulate across steps.

import { type ClipLedger, clipStaleToolResults } from "~/modules/agent/runtime/stale-result-clipper"

/** The one TTL these marks use: a step reads its predecessor within seconds. */
export const ROLLING_CACHE_PROVIDER_OPTIONS = {
  anthropic: { cacheControl: { type: "ephemeral", ttl: "5m" } },
} as const

interface LooseMessage {
  role?: string
  content?: unknown
  providerOptions?: { anthropic?: { cacheControl?: unknown } & Record<string, unknown> } & Record<
    string,
    unknown
  >
}

const originalOf = new WeakMap<object, unknown>()

/** Map every copy this module marked back to the message it was made from. */
export function unmarkRollingBreakpoints(messages: unknown[]): unknown[] {
  let changed = false
  const out = messages.map((m) => {
    const original = m && typeof m === "object" ? originalOf.get(m) : undefined
    if (original === undefined) return m
    changed = true
    return original
  })
  return changed ? out : messages
}

function hasCacheMark(msg: LooseMessage | undefined): boolean {
  if (msg?.providerOptions?.anthropic?.cacheControl != null) return true
  return (
    Array.isArray(msg?.content) &&
    (msg.content as Array<{ providerOptions?: { anthropic?: { cacheControl?: unknown } } }>).some(
      (p) => p?.providerOptions?.anthropic?.cacheControl != null,
    )
  )
}

/** The provider puts a message-level mark on the message's LAST part; a
 *  thinking block cannot carry one, so only these parts are eligible. */
const MARKABLE_PARTS = new Set(["text", "tool-call", "tool-result", "image", "file"])
function isMarkable(msg: LooseMessage | undefined): boolean {
  if (!msg || typeof msg !== "object") return false
  if (typeof msg.content === "string") return msg.content.length > 0
  if (!Array.isArray(msg.content) || msg.content.length === 0) return false
  const last = msg.content[msg.content.length - 1] as { type?: string } | undefined
  return typeof last?.type === "string" && MARKABLE_PARTS.has(last.type)
}

function marked(msg: LooseMessage): LooseMessage {
  const copy: LooseMessage = {
    ...msg,
    providerOptions: {
      ...(msg.providerOptions ?? {}),
      anthropic: {
        ...(msg.providerOptions?.anthropic ?? {}),
        ...ROLLING_CACHE_PROVIDER_OPTIONS.anthropic,
      },
    },
  }
  originalOf.set(copy, msg)
  return copy
}

/**
 * Place the END and PRE marks on a step's (already clipped) message list.
 * `firstMutableIndex` is the clipper's: the earliest message a later step may
 * still rewrite. Returns the list unchanged (same array) when nothing is marked.
 */
export function markRollingBreakpoints(
  messages: unknown[],
  firstMutableIndex: number | null,
): unknown[] {
  const list = messages as LooseMessage[]
  let lastExisting = -1
  for (let i = list.length - 1; i >= 0; i--) {
    if (hasCacheMark(list[i])) {
      lastExisting = i
      break
    }
  }
  const targets = new Set<number>()
  const end = list.length - 1
  if (end > lastExisting && isMarkable(list[end])) targets.add(end)
  if (firstMutableIndex !== null) {
    const pre = firstMutableIndex - 1
    if (pre > lastExisting && pre < end && isMarkable(list[pre])) targets.add(pre)
  }
  if (targets.size === 0) return messages
  return list.map((m, i) => (targets.has(i) ? marked(m) : m))
}

/**
 * One step's message list for the provider: earlier marks dropped, stale tool
 * results clipped (stale-result-clipper.ts), then the rolling marks placed when
 * `rollingCache` (an Anthropic model). Returns `messages` itself when nothing
 * changed, so a caller can skip the override.
 */
export function clipAndMarkStepMessages(
  messages: unknown[],
  ledger: ClipLedger,
  rollingCache: boolean,
): unknown[] {
  const pruned = clipStaleToolResults(unmarkRollingBreakpoints(messages), ledger)
  return rollingCache
    ? markRollingBreakpoints(pruned.messages, pruned.firstMutableIndex)
    : pruned.messages
}
