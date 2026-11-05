// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P4c-T22: the cold resume rule as pure functions (no database access).

import { isRequestRow } from "~/modules/agent/context/agent-attribution"
import type { HistoryMessageRow } from "~/modules/agent/context/checkpoint"

/** A turn is cold once more than this much wall time has passed since the agent last completed a turn. */
export const WARM_WINDOW_MS = 60 * 60_000

/** How much of the raw tail (in estimated tokens) a cold resume keeps verbatim before the rest gets summarized. */
export const COLD_TAIL_TOKEN_BUDGET = 8_000

/** Token budget for the "who/what/why" core brief assembled on a cold resume. */
export const BRIEF_CORE_TOKEN_BUDGET = 400

/** Token budget for the most recent episode summary folded into a cold resume brief. */
export const BRIEF_EPISODE_TOKEN_BUDGET = 300

/** Token budget for memory recalled specifically to prime a cold resume. */
export const COLD_RECALL_TOKEN_BUDGET = 800

/** Token budget for the reconstructed conversation context on a cold resume. */
export const COLD_CONVERSATION_TOKEN_BUDGET = 9_500

/**
 * Total token budget for a cold-resume turn's CONVERSATION-SCOPED reconstruction:
 * the same content COLD_CONVERSATION_TOKEN_BUDGET measures (brief + tail + recall)
 * plus the agent's own memory calls that turn. The cached system prefix (identity,
 * apps, deferred-tool catalog, charter, skills, user identity, time, first-run
 * overlay) is deliberately EXCLUDED: it is stable across turns via provider
 * prompt caching, was never grown or shrunk by the cold-resume rule, and is
 * outside that rule's influence — comparing it against a conversation-scoped
 * budget fired `cold_resume_over_budget` on every cold turn even when the cold
 * rule performed perfectly (context.ts's `logMemoryBudgets` still logs the
 * excluded prefix and the full request size as `systemTokens` / `requestTokens`,
 * so neither number goes dark).
 */
export const COLD_TURN_TOKEN_BUDGET = 14_000

/** How many memory tool calls a single turn may make, cold or warm. */
export const MAX_MEMORY_CALLS_PER_TURN = 3

/**
 * A turn is a cold resume when more than WARM_WINDOW_MS has elapsed since the agent's last
 * completed turn; an agent that has never turned in this thread has nothing to summarize, so
 * that case is warm rather than cold.
 */
export function isColdResume(params: {
  lastAgentTurnCompletedAt: Date | null
  now: Date
}): boolean {
  const { lastAgentTurnCompletedAt, now } = params
  if (lastAgentTurnCompletedAt === null) return false
  return now.getTime() - lastAgentTurnCompletedAt.getTime() > WARM_WINDOW_MS
}

/**
 * The newest completed turn by the given agent, taken as the createdAt of the newest row it
 * authored; null when the agent has never authored a row in this history.
 */
export function lastAgentTurnCompletedAt(rows: HistoryMessageRow[], agentId: string): Date | null {
  let newest: Date | null = null
  for (const row of rows) {
    if (row.authorAgentId !== agentId) continue
    if (newest === null || row.createdAt.getTime() > newest.getTime()) newest = row.createdAt
  }
  return newest
}

/**
 * The boundary index in `rows` such that everything from that index onward is kept verbatim as
 * the cold tail: it fits COLD_TAIL_TOKEN_BUDGET, but is floored so the tail always starts at or
 * before the last user message, meaning the last human message and every reply after it (the
 * agent's last answer) are never candidates for summarization.
 */
export function coldTailBoundaryIndex(
  rows: HistoryMessageRow[],
  estimateTokens: (text: string) => number,
): number {
  if (rows.length === 0) return 0

  let lastUserIndex = -1
  for (let i = rows.length - 1; i >= 0; i--) {
    if (isRequestRow(rows[i])) {
      lastUserIndex = i
      break
    }
  }

  let tokens = 0
  let boundary = rows.length
  for (let i = rows.length - 1; i >= 0; i--) {
    tokens += estimateTokens(rows[i].content ?? "")
    if (tokens > COLD_TAIL_TOKEN_BUDGET) break
    boundary = i
  }

  if (lastUserIndex !== -1 && boundary > lastUserIndex) boundary = lastUserIndex
  return boundary
}

/** The kernel memory/thread retrieval tools, as opposed to business tools that act on real data. */
export function isRetrievalTool(name: string): boolean {
  return (
    name === "memory_search" ||
    name === "memory_open" ||
    name === "memory_episode" ||
    name === "threads_search"
  )
}

/**
 * The resume line's template (P4c-T29, spec.md's copy table row "Resume line
 * (model facing)"), byte for byte with `{duration}` as the only placeholder.
 * context.ts's `resumeLine` renders it with `formatResumeGap`'s output; kept
 * here as a constant so the wording is asserted once, not duplicated at the
 * render site.
 */
export const RESUME_LINE =
  "Resumed after {duration}. Earlier messages are summarized above; search the transcript for exact wording."
