// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Intra-run micro-compaction of stale tool results (the Claude Code /
// opencode "[old tool result cleared]" pattern, adapted to keep a clipped
// head instead of erasing).
//
// Problem: within one agent run, every step re-sends the FULL message array.
// A tool result is capped once at capture (LIVE cap, ~48k chars) and then
// rides verbatim through every remaining step — on a 40-step routine tick
// this re-billing of old results was the single largest uncached-token sink
// measured in prod. The aggressive REPLAY cap existed but only fired on
// cross-turn DB reload (context.ts), never on the hot intra-run path.
//
// Mechanism: before each step, tool-result parts older than the last
// KEEP_RECENT_TOOL_RESULTS are clipped with `truncateReplayedToolResult`
// (per-string 2k / total 16k), in batches (STALE_CLIP_BATCH_CHARS). The model saw the full result on the step
// that made the call; older results are reference material, and the clip
// note tells it to re-run the tool with narrower params if it truly needs
// the data again.
//
// CACHE DISCIPLINE: each clip mutates a message at its position, which
// re-anchors the implicit prompt cache from that point, so it must happen
// once and then STAY. The SDK hands prepareStep its own message list, which
// never contains our clips: a result clipped at step N arrives full again at
// step N+1. The caller therefore passes a run-scoped ledger (toolCallId → the
// clipped output, or null for "seen, left as is"), and every call re-applies
// the recorded clip to the same bytes. Before the ledger (a plain set of ids),
// a clipped result came back full on the next step and was clipped again one
// step later: two prefix rewrites per result, each an extra cache write, and
// the full result re-billed in between. Untouched messages keep their
// references (zero-copy).

import { truncateReplayedToolResult } from "~/modules/agent/runtime/result-truncation"

/** Recent tool results kept at full (live-capped) fidelity — the model's working set. */
export const KEEP_RECENT_TOOL_RESULTS = 4

// CLIP IN BATCHES, NOT ONE RESULT PER STEP. A clip rewrites a message in the
// middle of the request, so the provider re-reads, at the full input price,
// everything from it to the end: at least the keep window of recent results.
// Clipping each result the step it left the keep window did that on EVERY step
// of a long turn (up to four live-capped results, ~48k tokens, re-billed per
// step), while what the clip saves is the stale result read FROM CACHE, at a
// tenth to a fiftieth of that price. So stale results wait, unclipped, until
// the ones waiting add up to this many characters, and then all of them are
// clipped in one rewrite: one re-read per batch instead of one per step.
export const STALE_CLIP_BATCH_CHARS = 96_000

function outputChars(value: unknown): number {
  if (typeof value === "string") return value.length
  try {
    return JSON.stringify(value ?? null).length
  } catch {
    return 0
  }
}

interface ToolResultPart {
  type: string
  toolCallId?: string
  output?: { type: string; value: unknown }
}

interface LooseMessage {
  role?: string
  content?: unknown
}

/** Run-scoped clip ledger: toolCallId → its clipped output, or null when the
 *  result was examined and is small enough to ride as is. */
export type ClipLedger = Map<string, ToolResultPart["output"] | null>

/**
 * Clip tool-result parts older than the keep-window down to the replay cap,
 * and re-apply every clip already in `ledger` (byte-identical, same object).
 * Returns new arrays/objects only where a part changed; `clippedCount` is the
 * number of NEW clips, `rewrittenCount` every part replaced in this output
 * (new clips plus re-applied ones): the caller overrides the step's messages
 * whenever it is above zero.
 */
export function clipStaleToolResults(
  messages: unknown[],
  ledger: ClipLedger,
): {
  messages: unknown[]
  clippedCount: number
  rewrittenCount: number
  /**
   * Index of the earliest message a LATER call may still rewrite (the one
   * holding the oldest result not yet examined), or null when every result is
   * final. Everything before it is byte-stable for the rest of the run, which
   * is where a cache breakpoint can sit and still be read next step.
   */
  firstMutableIndex: number | null
} {
  const replacements = new Map<number, Array<{ partIdx: number; part: ToolResultPart }>>()
  const replace = (msgIdx: number, partIdx: number, part: ToolResultPart) => {
    const list = replacements.get(msgIdx) ?? []
    list.push({ partIdx, part })
    replacements.set(msgIdx, list)
  }
  // Re-apply recorded clips; collect the not-yet-examined results, in order.
  const candidates: Array<{ msgIdx: number; partIdx: number; part: ToolResultPart }> = []
  for (let m = 0; m < messages.length; m++) {
    const msg = messages[m] as LooseMessage
    if (msg?.role !== "tool" || !Array.isArray(msg.content)) continue
    for (let p = 0; p < msg.content.length; p++) {
      const part = msg.content[p] as ToolResultPart
      if (part?.type !== "tool-result" || typeof part.toolCallId !== "string") continue
      if (ledger.has(part.toolCallId)) {
        const recorded = ledger.get(part.toolCallId)
        if (recorded && part.output !== recorded) replace(m, p, { ...part, output: recorded })
        continue
      }
      const out = part.output
      if (!out || (out.type !== "json" && out.type !== "text")) continue
      candidates.push({ msgIdx: m, partIdx: p, part })
    }
  }
  const stale = candidates.slice(0, Math.max(0, candidates.length - KEEP_RECENT_TOOL_RESULTS))
  // Small stale results are final as they are (byte-stable, no rewrite); the
  // large ones wait for a batch (STALE_CLIP_BATCH_CHARS above).
  const waiting: Array<{
    msgIdx: number
    partIdx: number
    part: ToolResultPart
    clipped: unknown
  }> = []
  let waitingChars = 0
  for (const { msgIdx, partIdx, part } of stale) {
    const clipped = truncateReplayedToolResult(part.output!.value)
    if (clipped === part.output!.value) {
      ledger.set(part.toolCallId!, null)
      continue
    }
    waiting.push({ msgIdx, partIdx, part, clipped })
    waitingChars += outputChars(part.output!.value)
  }
  let clippedCount = 0
  if (waitingChars >= STALE_CLIP_BATCH_CHARS) {
    for (const { msgIdx, partIdx, part, clipped } of waiting) {
      const output =
        typeof clipped === "string"
          ? { type: "text", value: clipped }
          : { type: part.output!.type, value: clipped }
      ledger.set(part.toolCallId!, output)
      clippedCount++
      replace(msgIdx, partIdx, { ...part, output })
    }
  }
  // The earliest result a later call may still rewrite: a waiting one, else
  // the oldest result in the keep window.
  const firstMutableIndex = candidates.find((c) => !ledger.has(c.part.toolCallId!))?.msgIdx ?? null
  if (replacements.size === 0)
    return { messages, clippedCount: 0, rewrittenCount: 0, firstMutableIndex }

  let rewrittenCount = 0
  const outMessages = messages.map((msg, m) => {
    const reps = replacements.get(m)
    if (!reps) return msg
    const original = msg as LooseMessage
    const content = [...(original.content as unknown[])]
    for (const { partIdx, part } of reps) {
      content[partIdx] = part
      rewrittenCount++
    }
    return { ...original, content }
  })
  return { messages: outMessages, clippedCount, rewrittenCount, firstMutableIndex }
}
