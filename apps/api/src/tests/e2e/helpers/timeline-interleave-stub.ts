// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Interleaved-timeline stub — loaded by the spawned e2e server when the
 * `AGENT_STREAM_STUB` env var points at this file (wired in fixtures/test.ts).
 *
 * It intercepts ONLY prompts containing the unique marker
 * `E2E_TIMELINE_INTERLEAVE` and returns a deterministic stream that interleaves
 * reasoning and tool calls in this exact order:
 *
 *     reasoning → tool-call A → reasoning → tool-call B → answer
 *
 * so the browser test can assert the rendered turn shows the tools anchored
 * BETWEEN the thinking segments (the timeline fix), not dumped after all
 * thinking. Every other prompt is delegated to the real `streamText`, so this
 * stub is inert for the rest of the web e2e suite (no key dependency added, no
 * behavior change).
 */
import { streamText } from "ai"

const MARKER = "E2E_TIMELINE_INTERLEAVE"
// Entity-tag scenario marker — the prompt carries `doc:<uuid>`; the stub
// answers with the wire-format entity tag `@[Label](knowledge:document:<id>)`
// so the browser test can assert it renders as a clickable pill in both the
// agent panel and the promoted thread.
const TAG_MARKER = "E2E_ENTITY_TAG"

function stringify(c: unknown): string {
  return typeof c === "string" ? c : (JSON.stringify(c) ?? "")
}

export default function streamTextStub(opts: { messages?: Array<{ content?: unknown }> }) {
  const allContent = (opts.messages ?? []).map((m) => stringify(m.content)).join("\n")
  if (allContent.includes(TAG_MARKER)) {
    const docId =
      allContent.match(/doc:([0-9a-f-]{36})/i)?.[1] ?? "00000000-0000-0000-0000-000000000000"
    return {
      fullStream: (async function* () {
        yield {
          type: "text-delta",
          text: `Done. I filed @[E2E Tagged Doc](knowledge:document:${docId}) in the Finance collection.`,
        }
        yield {
          type: "finish-step",
          usage: { inputTokens: 50, outputTokens: 20 },
          finishReason: "stop",
        }
        yield { type: "finish", finishReason: "stop" }
      })(),
    }
  }
  if (!allContent.includes(MARKER)) {
    // Not our test — real model behavior for everyone else.
    return streamText(opts as never) as never
  }

  // Small delays between chunks so the live streaming render stays on screen long
  // enough for the browser test to observe the interleave deterministically (an
  // instant stream would flip straight to the persisted render).
  const beat = () => new Promise((r) => setTimeout(r, 350))

  return {
    fullStream: (async function* () {
      // Segment 1 of thinking, then the first tool call.
      yield { type: "reasoning-start" }
      yield { type: "reasoning-delta", text: "First, I need to find the relevant thread." }
      yield { type: "reasoning-end" }
      await beat()
      yield {
        type: "tool-call",
        toolCallId: "call-search",
        toolName: "kernel__thread_search",
        input: { query: "orders" },
      }
      yield { type: "tool-result", toolCallId: "call-search", output: { hits: 1 } }
      await beat()

      // Segment 2 of thinking (AFTER the first tool), then the second tool call.
      yield { type: "reasoning-start" }
      yield { type: "reasoning-delta", text: "Found it. Now I will open that thread to read it." }
      yield { type: "reasoning-end" }
      await beat()
      yield {
        type: "tool-call",
        toolCallId: "call-read",
        toolName: "kernel__thread_read",
        input: { threadId: "t-1" },
      }
      yield { type: "tool-result", toolCallId: "call-read", output: { ok: true } }
      await beat()

      // The final answer.
      yield { type: "text-delta", text: "Here is what I found in your orders thread." }
      yield {
        type: "finish-step",
        usage: { inputTokens: 100, outputTokens: 20, reasoningTokens: 12 },
        finishReason: "stop",
      }
      yield { type: "finish", finishReason: "stop" }
    })(),
  }
}
