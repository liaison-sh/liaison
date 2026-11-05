// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHAT ONE LOCAL TURN DID, out of the SDK lines the sidecar forwards.
//
// A cloud turn is stored as one agent message whose metadata holds its tool
// calls, its reasoning and tool interleave, its usage and its model
// (`agent-service.ts` finalize). A local turn used to leave only its final text:
// the activity rows lived in the window's memory, so a relaunch, another device
// or the web app showed the question with an answer and nothing in between, and
// the history the next turn replays, the checkpoint budget and the compaction
// trigger all saw a turn that did nothing.
//
// This records the turn from the same stream the rows are drawn from, into the
// shared record (`@liaison/shared/threads/local-turn`) the server stores in the
// cloud shape. The text is every top level assistant text of the turn, in order,
// which is what a cloud turn's text is (it accumulates every step's text); the
// SDK's `result` is the fallback for a turn whose text never came as a block.
//
// Redaction happens here, before anything leaves the machine, and again on the
// server, which never trusts a client to have done it.

import {
  type LocalTurnRecord,
  type LocalTurnTimelineEntry,
  normalizeLocalToolName,
  sanitizeLocalTurnRecord,
} from "@liaison/shared/threads/local-turn"
import type { SidecarEvent } from "./sidecar-client"

/** One finished turn: the reply text and the record stored with it. */
export interface LocalTurnTranscript {
  text: string
  record: LocalTurnRecord
}

interface SdkBlock {
  type?: string
  text?: unknown
  thinking?: unknown
  id?: unknown
  name?: unknown
  input?: unknown
  tool_use_id?: unknown
  content?: unknown
  is_error?: unknown
}

interface SdkUsage {
  input_tokens?: unknown
  output_tokens?: unknown
  cache_read_input_tokens?: unknown
  cache_creation_input_tokens?: unknown
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0
}

/** The whole prompt one SDK request carried: fresh, cache read and cache write. */
function promptTokens(usage: SdkUsage | undefined): number {
  if (!usage) return 0
  return (
    count(usage.input_tokens) +
    count(usage.cache_read_input_tokens) +
    count(usage.cache_creation_input_tokens)
  )
}

interface RecordedCall {
  toolCallId: string
  toolName: string
  args: unknown
  result: unknown
  /** Null while it runs: a call that never returned is stored as failed, as a cloud one is. */
  status: "completed" | "error" | null
  error?: { message: string }
}

export interface LocalTurnRecorder {
  /** Feeds one sidecar line. Anything that is not an SDK message is ignored. */
  apply(event: SidecarEvent): void
  /** The turn so far, sanitized: what would be stored if it ended now. */
  snapshot(): LocalTurnTranscript
}

export function createLocalTurnRecorder(modelId: string | null): LocalTurnRecorder {
  const texts: string[] = []
  const calls = new Map<string, RecordedCall>()
  const timeline: LocalTurnTimelineEntry[] = []
  const steps = new Set<string>()
  let reasoning = ""
  let lastStepInputTokens = 0
  let summedInput = 0
  let summedOutput = 0
  let summedCached = 0
  let resultText: string | null = null
  let totals: SdkUsage | null = null
  let numTurns: number | null = null
  let finishReason = "stop"

  function onAssistant(payload: Record<string, unknown>) {
    const message = payload.message as
      | { id?: unknown; content?: unknown; usage?: SdkUsage }
      | undefined
    // A sub agent's lines (the SDK's Task tool) carry the parent call's id:
    // their tool calls are part of what the turn did, their words are not the
    // agent's answer.
    const topLevel = !payload.parent_tool_use_id
    const id = typeof message?.id === "string" ? message.id : null
    // The SDK repeats one API response's id across the lines it splits it into,
    // with the same usage on each: a step is counted once.
    if (id && !steps.has(id)) {
      steps.add(id)
      if (topLevel) {
        const prompt = promptTokens(message?.usage)
        if (prompt > 0) lastStepInputTokens = prompt
        summedInput += prompt
        summedOutput += count(message?.usage?.output_tokens)
        summedCached += count(message?.usage?.cache_read_input_tokens)
      }
    }
    const content = Array.isArray(message?.content) ? (message.content as SdkBlock[]) : []
    for (const block of content) {
      if (block?.type === "text" && topLevel && typeof block.text === "string") {
        const text = block.text.trim()
        if (!text) continue
        texts.push(text)
        // WHERE the words came, between the tools: the thread view draws them
        // there instead of every tool first and every sentence after.
        const last = timeline[timeline.length - 1]
        if (last?.kind === "text") last.text += `\n\n${text}`
        else timeline.push({ kind: "text", text })
      } else if (block?.type === "thinking" && typeof block.thinking === "string") {
        const text = block.thinking
        if (!text.trim()) continue
        reasoning += reasoning ? `\n\n${text}` : text
        const last = timeline[timeline.length - 1]
        if (last?.kind === "reasoning") last.text += `\n\n${text}`
        else timeline.push({ kind: "reasoning", text })
      } else if (block?.type === "tool_use" && typeof block.id === "string") {
        if (calls.has(block.id)) continue
        calls.set(block.id, {
          toolCallId: block.id,
          toolName: normalizeLocalToolName(typeof block.name === "string" ? block.name : "tool"),
          args: block.input ?? {},
          result: null,
          status: null,
        })
        timeline.push({ kind: "tool", toolCallId: block.id })
      }
    }
  }

  function onUser(payload: Record<string, unknown>) {
    const message = payload.message as { content?: unknown } | undefined
    const content = Array.isArray(message?.content) ? (message.content as SdkBlock[]) : []
    for (const block of content) {
      if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") continue
      const call = calls.get(block.tool_use_id)
      if (!call) continue
      call.result = block.content ?? null
      if (block.is_error === true) {
        call.status = "error"
        const text =
          typeof block.content === "string"
            ? block.content
            : Array.isArray(block.content)
              ? (block.content as SdkBlock[])
                  .map((part) => (typeof part?.text === "string" ? part.text : ""))
                  .join("\n")
              : ""
        call.error = { message: text || "the tool failed" }
      } else {
        call.status = "completed"
      }
    }
  }

  function onResult(payload: Record<string, unknown>) {
    if (typeof payload.result === "string") resultText = payload.result
    if (payload.usage && typeof payload.usage === "object") totals = payload.usage as SdkUsage
    if (typeof payload.num_turns === "number") numTurns = payload.num_turns
    if (payload.is_error === true || (payload.subtype && payload.subtype !== "success")) {
      finishReason = "error"
    }
  }

  return {
    apply(event) {
      if (event.type !== "message") return
      const payload = event.payload as Record<string, unknown> | undefined
      if (!payload || typeof payload !== "object") return
      // The SDK message's own type first; the sidecar's classification of the
      // line (`sidecar/index.ts` classifyMessage) for a payload that lacks one.
      const kind = event.event
      if (payload.type === "result" || kind === "result") onResult(payload)
      else if (payload.type === "user" || kind === "tool_result") onUser(payload)
      else if (
        payload.type === "assistant" ||
        kind === "text" ||
        kind === "tool_use" ||
        kind === "thinking"
      ) {
        onAssistant(payload)
      }
    },
    snapshot() {
      // The SDK's `result` repeats the last text block; a result that is not
      // one of the blocks (a session whose answer never came as a block) is
      // the answer's last part, never dropped.
      const final = resultText?.trim() ?? ""
      const resultIsExtra = !!final && texts[texts.length - 1] !== final
      const parts = resultIsExtra ? [...texts, final] : texts
      const text = parts.join("\n\n").trim()
      // The timeline's words are the reply's words, the extra result included.
      const entries: LocalTurnTimelineEntry[] = resultIsExtra
        ? [...timeline, { kind: "text", text: final }]
        : timeline
      const usage = totals
        ? {
            inputTokens: promptTokens(totals),
            outputTokens: count(totals.output_tokens),
            cachedInputTokens: count(totals.cache_read_input_tokens),
          }
        : { inputTokens: summedInput, outputTokens: summedOutput, cachedInputTokens: summedCached }
      const record = sanitizeLocalTurnRecord({
        modelId,
        toolCalls: [...calls.values()].map((call) => ({
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          args: call.args,
          result: call.result,
          status: call.status ?? "error",
          ...(call.error ? { error: call.error } : {}),
        })),
        timeline: entries,
        reasoning,
        stepCount: numTurns ?? Math.max(1, steps.size),
        usage: {
          ...usage,
          ...(lastStepInputTokens > 0 ? { lastStepInputTokens } : {}),
        },
        finishReason,
      })
      return { text, record }
    },
  }
}
