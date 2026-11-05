// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The tail cut. The rule that matters: the cut NEVER lands between the last
// user message and the rows that follow it. A tail that starts with an agent
// reply to a question the model cannot see is worse than a slightly larger
// tail, and it is exactly the failure a small budget invites.
import { renderRow } from "./corpus"
import { estimateTokens } from "./tokens"
import type { CorpusRow } from "./types"

export interface TailCut {
  /** The rows fed verbatim. */
  tail: CorpusRow[]
  /** Everything before them, what the summary or brief is built from. */
  head: CorpusRow[]
}

/** The index of the last row with authorType "user", or 0 when there is none. */
export function lastUserIndex(rows: CorpusRow[]): number {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i]?.authorType === "user") return i
  }
  return 0
}

/**
 * Take the last `budgetTokens` of transcript, then walk the start back to the
 * last user message if the cut fell after it.
 */
export function cutTail(rows: CorpusRow[], budgetTokens: number): TailCut {
  if (rows.length === 0) return { tail: [], head: [] }
  let start = rows.length
  let tokens = 0
  while (start > 0) {
    const next = estimateTokens(`${renderRow(rows[start - 1] as CorpusRow)}\n`)
    if (tokens + next > budgetTokens && start < rows.length) break
    tokens += next
    start--
  }
  const anchor = lastUserIndex(rows)
  if (start > anchor) start = anchor
  return { tail: rows.slice(start), head: rows.slice(0, start) }
}
