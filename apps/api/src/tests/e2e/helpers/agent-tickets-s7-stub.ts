// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * agent-tickets S7 stub — loaded by the spawned server when
 * `AGENT_STREAM_STUB` env var points at this file. For S7's two-turn
 * prompts (which include the literal markers "tickets__get" /
 * "Now reply to that ticket"), returns a deterministic stream that
 * invokes the matching tool. Every other prompt — including the
 * single-turn S1–S6 tests in the same scenario file — is delegated
 * to the real `streamText` so non-S7 paths keep their LLM behavior.
 *
 * Looking at the full message history (not just the last message)
 * avoids SSE/compaction races where `messages.at(-1)` is an
 * assistant/tool turn from a mid-step continuation instead of the
 * user prompt. That race was the S7 flake (~1/6 under strobe's
 * combined run): Haiku occasionally interpreted turn 2 as a continuation
 * and never invoked tickets__reply.
 *
 * The server reads this path via `import(env.AGENT_STREAM_STUB)`. The
 * test seeds the env via setupScenario({ serverEnv: { AGENT_STREAM_STUB } }).
 */
import { streamText } from "ai"

function stringify(c: unknown): string {
  return typeof c === "string" ? c : (JSON.stringify(c) ?? "")
}

function extractTicketId(text: string): string | null {
  // The test prompts include the ticket UUID in turn 1
  // ("Fetch the messages on ticket id <uuid>"); turn 2 references "that
  // ticket" so we recover the id from the earlier turn in the history.
  const m = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
  return m ? m[0] : null
}

// S7's prompts each include "tickets__get" (turn 1) or
// "Now reply to that ticket" (turn 2). Anything else is some other test's
// prompt that should hit the real model.
function isS7Prompt(allContent: string): "get" | "reply" | null {
  if (allContent.includes("Now reply to that ticket")) return "reply"
  if (allContent.includes("Fetch the messages on ticket id")) return "get"
  return null
}

export default function streamTextStub(opts: {
  messages?: Array<{ content?: unknown }>
  tools?: Record<string, { execute?: (args: unknown) => Promise<unknown> }>
}) {
  const allContent = (opts.messages ?? []).map((m) => stringify(m.content)).join("\n")
  const kind = isS7Prompt(allContent)
  if (!kind) {
    // Not an S7 turn — delegate to the real LLM so the other tests
    // (S1–S6, S8…) in the same scenario keep their real-model behavior.
    return streamText(opts as any) as any
  }
  return {
    fullStream: (async function* () {
      const isReplyTurn = kind === "reply"
      const toolName = isReplyTurn ? "tickets__reply" : "tickets__get"
      const ticketId = extractTicketId(allContent) ?? "00000000-0000-0000-0000-000000000000"
      const args = isReplyTurn
        ? { ticketId, textBody: "Refund initiated, expect it in 3-5 business days." }
        : { ticketId }
      const tool = opts.tools?.[toolName]
      if (!tool?.execute) {
        // No matching tool — yield an empty step so the route's stream loop
        // closes cleanly. The test will fail loudly on the assertion side,
        // which is what we want when scope filtering / registry drift made
        // the tool invisible to the agent.
        yield {
          type: "finish-step",
          usage: { inputTokens: 0, outputTokens: 0 },
          finishReason: "stop",
        }
        yield { type: "finish", finishReason: "stop" }
        return
      }
      yield { type: "tool-call", toolCallId: `call-${toolName}`, toolName, input: args }
      const output = await tool.execute(args)
      yield { type: "tool-result", toolCallId: `call-${toolName}`, output }
      yield {
        type: "text-delta",
        text: isReplyTurn ? "Queued the refund reply for approval." : "I have the messages.",
      }
      yield {
        type: "finish-step",
        usage: { inputTokens: 100, outputTokens: 20 },
        finishReason: "stop",
      }
      yield { type: "finish", finishReason: "stop" }
    })(),
  }
}
