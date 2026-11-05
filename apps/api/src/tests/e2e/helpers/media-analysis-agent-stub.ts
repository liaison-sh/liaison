// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * media-analysis-agent stub — loaded by the spawned server when
 * `AGENT_STREAM_STUB` points at this file (set via
 * setupScenario({ serverEnv: { AGENT_STREAM_STUB } })).
 *
 * This is the deterministic BRAIN for the media-analysis-agent scenario's
 * primary (wiring-proof) test. When the prompt carries the literal marker
 * "ANALYZE_MEDIA_FIXTURE fileId=<uuid> context=<...>", it returns a stream
 * that:
 *   1. emits a `kernel__analyze_media` tool-call with the embedded fileId +
 *      context (exactly as a real model would), then
 *   2. invokes the matching tool's REAL `execute(args)` — driving the full
 *      agent-runtime → execute-tool → handleAnalyzeMedia → Gemini path,
 *   3. yields the tool-RESULT (the real Gemini summary flows back into the
 *      loop), then
 *   4. emits a text-delta that quotes a slice of the summary — proving the
 *      agent actually CONSUMED the tool result for its reply (not just that
 *      the tool fired).
 *
 * Every OTHER prompt — including the live-brain test #2 in the same scenario
 * file — is delegated to the real `streamText`, so the natural-language
 * "does the brain choose to call analyze_media?" check hits the real model.
 *
 * Mirrors helpers/agent-tickets-s7-stub.ts (the established stub-injection
 * precedent), extended to carry the fileId + context inline in the marker so
 * the stub needs no out-of-band fixture wiring.
 */
import { streamText } from "ai"

function stringify(c: unknown): string {
  return typeof c === "string" ? c : (JSON.stringify(c) ?? "")
}

const MARKER = "ANALYZE_MEDIA_FIXTURE"

interface ParsedMarker {
  fileId: string
  context: string
}

/**
 * Recover the fileId + context from the marker line embedded in the prompt.
 * Shape: `ANALYZE_MEDIA_FIXTURE fileId=<uuid> context=<rest-of-line>`.
 * Returns null when the marker is absent (→ delegate to the real model).
 */
function parseMarker(allContent: string): ParsedMarker | null {
  if (!allContent.includes(MARKER)) return null
  const fileId = allContent.match(/fileId=([0-9a-f-]{36})/i)?.[1]
  // context= runs to end-of-line (the test puts it last on the marker line).
  const context = allContent.match(/context=([^\n]+)/)?.[1]?.trim()
  if (!fileId || !context) return null
  return { fileId, context }
}

export default function streamTextStub(opts: {
  messages?: Array<{ content?: unknown }>
  tools?: Record<string, { execute?: (args: unknown) => Promise<unknown> }>
}) {
  const allContent = (opts.messages ?? []).map((m) => stringify(m.content)).join("\n")
  const parsed = parseMarker(allContent)
  if (!parsed) {
    // Not the deterministic fixture prompt — delegate to the real LLM so the
    // live-brain test in the same scenario keeps its real-model behavior.
    return streamText(opts as any) as any
  }

  const toolName = "kernel__analyze_media"
  const tool = opts.tools?.[toolName]

  return {
    fullStream: (async function* () {
      if (!tool?.execute) {
        // The tool is NOT in the agent's tool set — scope filtering / registry
        // drift made analyze_media invisible to the agent. Yield an empty step
        // so the route's stream loop closes; the test fails loudly on the
        // "tool-call fired" assertion, which is exactly the signal we want when
        // the agent can't see the tool.
        yield {
          type: "text-delta",
          text: `ERROR: ${toolName} is not available in my tool set.`,
        }
        yield {
          type: "finish-step",
          usage: { inputTokens: 0, outputTokens: 0 },
          finishReason: "stop",
        }
        yield { type: "finish", finishReason: "stop" }
        return
      }

      const args = { fileId: parsed.fileId, context: parsed.context }
      const callId = `call-${toolName}`
      // Step 1 — the agent emits the analyze_media tool-call.
      yield { type: "tool-call", toolCallId: callId, toolName, input: args }
      // Step 2 — the REAL tool executes (executeTool → tool-bridge →
      // handleAnalyzeMedia → real ffmpeg-if-needed + real @google/genai).
      const output = await tool.execute(args)
      // Step 3 — the tool result flows back into the loop.
      yield { type: "tool-result", toolCallId: callId, output }
      // Step 4 — the agent USES the summary: quote a slice of it in the reply
      // so the test can prove the result was consumed, not just fired.
      const summary =
        output && typeof output === "object" && "summary" in output
          ? String((output as { summary: unknown }).summary)
          : ""
      yield {
        type: "text-delta",
        text: summary
          ? `Here's what the customer's attachment shows: ${summary.slice(0, 400)}`
          : "I analyzed the attachment but the model returned no description.",
      }
      yield {
        type: "finish-step",
        usage: { inputTokens: 120, outputTokens: 60 },
        finishReason: "stop",
      }
      yield { type: "finish", finishReason: "stop" }
    })(),
  }
}
