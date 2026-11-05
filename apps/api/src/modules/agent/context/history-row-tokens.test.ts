// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `historyRowTokens` counts what a stored row costs when it is REPLAYED: its
// text, its tool calls with the provider state they carry (reasoning), the
// replay-clipped results, and the guide notes the turn was sent. Measured
// against `convertToCoreMessages` itself, so the budget and the request agree.
import { describe, expect, it } from "bun:test"
import { historyRowTokens } from "~/modules/agent/context/checkpoint"
import { estimateTokens } from "~/modules/agent/context/compaction"
import { convertToCoreMessages } from "~/modules/agent/context/context"

/** What the replay renders for `row`, measured the way the budget measures: chars / 4. */
function renderedTokens(row: { authorType: string; content: string; metadata: unknown }): number {
  let text = ""
  for (const m of convertToCoreMessages([row])) {
    if (typeof m.content === "string") {
      text += `\n${m.content}`
      continue
    }
    for (const part of m.content as Array<Record<string, unknown>>) {
      if (part.type === "text") text += `\n${String(part.text)}`
      else if (part.type === "tool-call") {
        text += `\n${String(part.toolName)}\n${JSON.stringify(part.input ?? null)}`
        if (part.providerOptions) text += `\n${JSON.stringify(part.providerOptions)}`
      } else if (part.type === "tool-result") {
        const out = part.output as { type: string; value: unknown }
        text += `\n${typeof out.value === "string" ? out.value : JSON.stringify(out.value)}`
      }
    }
  }
  return estimateTokens(text)
}

const GUIDE = `<runtime-context parts="tickets">${"Tickets guide. ".repeat(800)}</runtime-context>`
const REASONING = "Let me think about which ticket to open first. ".repeat(300)

const agentRow = {
  authorType: "agent",
  content: "Found it: ticket 42 is the one.",
  metadata: {
    toolCalls: [
      {
        toolCallId: "call_1",
        toolName: "tickets__search",
        args: { query: "carrier" },
        result: { items: [{ id: 42, subject: "Carrier delay" }] },
        providerMetadata: {
          openrouter: { reasoning_details: [{ type: "reasoning.text", text: REASONING }] },
        },
      },
    ],
    guideNotes: [{ afterToolCallId: null, content: GUIDE }],
  },
}

describe("historyRowTokens", () => {
  it("counts the guide notes a turn replays", () => {
    const withoutNotes = {
      ...agentRow,
      metadata: { ...agentRow.metadata, guideNotes: [] },
    }
    expect(historyRowTokens(agentRow) - historyRowTokens(withoutNotes)).toBeGreaterThanOrEqual(
      estimateTokens(GUIDE) - 2,
    )
  })

  it("counts the reasoning replayed with a tool call", () => {
    const withoutReasoning = {
      ...agentRow,
      metadata: {
        ...agentRow.metadata,
        toolCalls: agentRow.metadata.toolCalls.map(({ providerMetadata: _p, ...tc }) => tc),
      },
    }
    expect(historyRowTokens(agentRow) - historyRowTokens(withoutReasoning)).toBeGreaterThanOrEqual(
      estimateTokens(REASONING) - 2,
    )
  })

  it("matches what convertToCoreMessages replays for the row, within 5 percent", () => {
    const counted = historyRowTokens(agentRow)
    const rendered = renderedTokens(agentRow)
    expect(Math.abs(counted - rendered) / rendered).toBeLessThanOrEqual(0.05)
  })

  it("counts a replay-clipped result, not the stored one", () => {
    const huge = {
      authorType: "agent",
      content: "",
      metadata: {
        toolCalls: [
          {
            toolCallId: "call_2",
            toolName: "web_fetch",
            args: { url: "https://example.com" },
            result: { content: "x".repeat(400_000) },
          },
        ],
      },
    }
    const counted = historyRowTokens(huge)
    expect(counted).toBeLessThan(400_000 / 4)
    expect(Math.abs(counted - renderedTokens(huge)) / renderedTokens(huge)).toBeLessThanOrEqual(
      0.05,
    )
  })
})
