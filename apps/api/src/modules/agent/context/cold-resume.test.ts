// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P4c-T22: the cold resume rule as pure functions (no database access).
import { describe, expect, it } from "bun:test"
import type { HistoryMessageRow } from "~/modules/agent/context/checkpoint"
import {
  COLD_TAIL_TOKEN_BUDGET,
  coldTailBoundaryIndex,
  isColdResume,
  isRetrievalTool,
  RESUME_LINE,
  WARM_WINDOW_MS,
} from "~/modules/agent/context/cold-resume"
import { ANTHROPIC_CACHE_TTL_MS } from "~/modules/agent/context/context"

const ORG_ID = "4c000000-0000-4000-8000-000000000001"
const AGENT_ID = "4c000000-0000-4000-8000-000000000003"
const USER_ID = "4c000000-0000-4000-8000-000000000002"

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** Minimal HistoryMessageRow stand-in, only the fields cold-resume.ts reads. */
function row(params: {
  authorType: "user" | "agent" | "system"
  content: string
  createdAt?: Date
  authorAgentId?: string | null
}): HistoryMessageRow {
  return {
    id: crypto.randomUUID(),
    threadId: "4c000000-0000-4000-8000-000000000099",
    orgId: ORG_ID,
    authorId: params.authorType === "user" ? USER_ID : AGENT_ID,
    authorType: params.authorType,
    authorAgentId: params.authorAgentId ?? (params.authorType === "user" ? null : AGENT_ID),
    content: params.content,
    createdAt: params.createdAt ?? new Date("2026-09-15T00:00:00Z"),
  } as unknown as HistoryMessageRow
}

describe("isColdResume", () => {
  it("61 minutes after the last agent turn is cold, 59 is warm", () => {
    const lastAgentTurnCompletedAt = new Date("2026-09-15T00:00:00Z")

    expect(
      isColdResume({
        lastAgentTurnCompletedAt,
        now: new Date(lastAgentTurnCompletedAt.getTime() + 61 * 60_000),
      }),
    ).toBe(true)

    expect(
      isColdResume({
        lastAgentTurnCompletedAt,
        now: new Date(lastAgentTurnCompletedAt.getTime() + 59 * 60_000),
      }),
    ).toBe(false)
  })

  it("never turned is warm", () => {
    expect(isColdResume({ lastAgentTurnCompletedAt: null, now: new Date() })).toBe(false)
  })
})

describe("coldTailBoundaryIndex", () => {
  it("the cold boundary leaves at most 8000 tokens", () => {
    // 20 small messages, each far under budget individually; the last message is from the
    // agent so the last-user floor does not force the boundary any lower than the budget does.
    const rows: HistoryMessageRow[] = []
    for (let i = 0; i < 20; i++) {
      const authorType = i % 2 === 0 ? "user" : "agent"
      rows.push(row({ authorType, content: "x".repeat(2_000) }))
    }
    // Force the very last row to be an agent message so the floor rule is a no-op here.
    rows.push(row({ authorType: "agent", content: "y".repeat(2_000) }))

    const boundary = coldTailBoundaryIndex(rows, estimateTokens)
    const tailTokens = rows
      .slice(boundary)
      .reduce((sum, r) => sum + estimateTokens(r.content ?? ""), 0)

    expect(tailTokens).toBeLessThanOrEqual(COLD_TAIL_TOKEN_BUDGET)
  })

  it("the cold boundary never cuts the last human message or the reply after it", () => {
    const rows: HistoryMessageRow[] = []
    for (let i = 0; i < 10; i++) {
      rows.push(row({ authorType: i % 2 === 0 ? "user" : "agent", content: "x".repeat(500) }))
    }
    // 9,000 tokens ~= 36,000 chars: alone this exceeds the whole 8,000 token tail budget.
    const lastUserIndex = rows.length
    rows.push(row({ authorType: "user", content: "z".repeat(9_000 * 4) }))
    rows.push(row({ authorType: "agent", content: "the reply" }))

    const boundary = coldTailBoundaryIndex(rows, estimateTokens)

    expect(boundary).toBeLessThanOrEqual(lastUserIndex)
    // Both the last human message and the agent's reply after it survive in the tail.
    const tail = rows.slice(boundary)
    expect(tail).toContain(rows[lastUserIndex])
    expect(tail).toContain(rows[rows.length - 1])
  })
})

describe("P4c-T28 warm window / cache lifetime alignment", () => {
  it("the warm window equals the default cache lifetime", () => {
    // Alignment is the whole point of T28: a resume inside WARM_WINDOW_MS must
    // still be inside the provider's cache lifetime, or the cache is dead weight
    // that never pays for itself before the resume rule already calls it cold.
    expect(ANTHROPIC_CACHE_TTL_MS["1h"]).toBe(WARM_WINDOW_MS)
  })
})

describe("isRetrievalTool", () => {
  it("retrieval tools are named, business tools are not", () => {
    expect(isRetrievalTool("memory_search")).toBe(true)
    expect(isRetrievalTool("memory_open")).toBe(true)
    expect(isRetrievalTool("memory_episode")).toBe(true)
    expect(isRetrievalTool("threads_search")).toBe(true)

    expect(isRetrievalTool("tickets_reply")).toBe(false)
    expect(isRetrievalTool("shopify_orders_search")).toBe(false)
    expect(isRetrievalTool("threads_reply")).toBe(false)
    expect(isRetrievalTool("memory_write")).toBe(false)
  })
})

describe("the resume line matches the spec table", () => {
  it("Resume line (model facing)", () => {
    expect(RESUME_LINE.replace("{duration}", "3 hours")).toBe(
      "Resumed after 3 hours. Earlier messages are summarized above; search the transcript for exact wording.",
    )
  })
})
