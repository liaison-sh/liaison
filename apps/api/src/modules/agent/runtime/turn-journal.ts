// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * What a turn journals per COMPLETE step, and what a resume rebuilds from it
 * (S10, C2). The turn ledger (turn-ledger.ts) stores the payload; this module
 * owns its shape.
 *
 * A step is journaled at the SDK's `onStepFinish`, when its assistant message
 * and its tool message both exist. `messages` are the SDK's own response
 * messages for that step (in ai@7 `step.response.messages` is per step, not
 * cumulative), kept verbatim with every part's `providerOptions` (Anthropic
 * thinking signatures, OpenAI item ids, Gemini thought signatures, OpenRouter
 * reasoning_details): a resumed call sends exactly what the uninterrupted
 * turn's next call would have sent.
 *
 * INVARIANT K (B4). The journal holds no more than the persisted reply would:
 * a mail tool's args and result from an encrypted mailbox are redacted the way
 * `kernel.messages.metadata.toolCalls` redacts them (mail-plaintext-redaction.ts),
 * and the decrypted mail the browser hands a turn is never in the SDK's response
 * messages at all (it rides each step's request tail, prepareStep). A redacted
 * step is marked `redacted`: its replay is the redacted form, as a later turn's
 * history is.
 */
import {
  redactMailToolArgs,
  redactMailToolResult,
} from "~/modules/agent/mailbox-plaintext/mail-plaintext-redaction"
import type { TurnTimelineEntry } from "~/modules/agent/runtime/agent-service"

/** A message as the SDK hands it (ModelMessage); opaque here. */
export type JournalMessage = { role: string; content: unknown }

/** One tool call of a step, as the finalize persists it. */
export interface JournalToolCall {
  toolCallId: string
  toolName: string
  args: unknown
  providerMetadata?: unknown
}

/** What the finalize needs from a step that ran in an earlier attempt. */
export interface JournalStepView {
  text: string
  reasoning: string
  timeline: TurnTimelineEntry[]
  toolCalls: JournalToolCall[]
  toolResults: Array<{ toolCallId: string; result: unknown }>
  toolErrors: Array<{ toolCallId: string; error: unknown }>
  finishReason: string | null
  usage: {
    inputTokens: number
    outputTokens: number
    reasoningTokens: number
    cachedInputTokens: number
  }
}

/**
 * The per-turn prepareStep state the next step depends on.
 *
 * As STORED, `midTurnGuideMessages` and `clippedResultIds` hold only what the
 * step ADDED (M7: the cumulative lists would make the journal quadratic in the
 * turn's length). `parseJournal` folds them, so every parsed step carries the
 * state as it stood after it, cumulative.
 */
export interface JournalPrepState {
  discoveredTools: string[]
  sentTools: string[]
  guidePartsDelivered: string[]
  /** Loaded tools the model asked for (their schemas follow); absent in older journals. */
  requestedSchemas?: string[]
  guideNotes: Array<{ afterToolCallId: string | null; content: string }>
  midTurnGuideMessages: Array<{ at: number; content: string }>
  midTurnSkillsDelivered: string[]
  clippedResultIds: Array<[string, unknown]>
  effectKeys: Record<string, number>
  scopes: string[]
  readInternalData: boolean
  originRows: Readonly<Record<string, readonly string[]>>
  taintedToolCallIds: string[]
}

export type JournalStep = {
  /** The step's number in the turn, 1-based, across attempts. */
  stepIndex: number
  messages: JournalMessage[]
  redacted: boolean
  view: JournalStepView
  prep: JournalPrepState
}

type Part = Record<string, unknown> & { type?: string }

/** Redact a step's response messages the way the reply's metadata is redacted. */
export async function redactStepMessages(
  orgId: string,
  messages: readonly JournalMessage[],
): Promise<{ messages: JournalMessage[]; redacted: boolean }> {
  let redacted = false
  const out: JournalMessage[] = []
  for (const message of messages) {
    if (!Array.isArray(message.content)) {
      out.push(message)
      continue
    }
    const parts: unknown[] = []
    for (const raw of message.content as Part[]) {
      if (raw?.type === "tool-call" && typeof raw.toolName === "string") {
        const input = await redactMailToolArgs(orgId, raw.toolName, raw.input)
        if (input !== raw.input) redacted = true
        parts.push(input === raw.input ? raw : { ...raw, input })
      } else if (raw?.type === "tool-result" && typeof raw.toolName === "string") {
        const output = raw.output as { type?: string; value?: unknown } | undefined
        if (output && "value" in output) {
          const value = await redactMailToolResult(orgId, raw.toolName, output.value)
          if (value !== output.value) redacted = true
          parts.push(value === output.value ? raw : { ...raw, output: { ...output, value } })
        } else {
          parts.push(raw)
        }
      } else {
        parts.push(raw)
      }
    }
    out.push({ ...message, content: parts })
  }
  return { messages: out, redacted }
}

/** The finalize view of one finished SDK step, read off its ordered content. */
export async function stepView(orgId: string, step: unknown): Promise<JournalStepView> {
  const s = step as {
    content?: Part[]
    finishReason?: string
    usage?: {
      inputTokens?: number
      outputTokens?: number
      outputTokenDetails?: { reasoningTokens?: number }
      reasoningTokens?: number
      inputTokenDetails?: { cacheReadTokens?: number }
      cachedInputTokens?: number
    }
  }
  const view: JournalStepView = {
    text: "",
    reasoning: "",
    timeline: [],
    toolCalls: [],
    toolResults: [],
    toolErrors: [],
    finishReason: s.finishReason ?? null,
    usage: {
      inputTokens: s.usage?.inputTokens ?? 0,
      outputTokens: s.usage?.outputTokens ?? 0,
      reasoningTokens:
        s.usage?.outputTokenDetails?.reasoningTokens ?? s.usage?.reasoningTokens ?? 0,
      cachedInputTokens:
        s.usage?.inputTokenDetails?.cacheReadTokens ?? s.usage?.cachedInputTokens ?? 0,
    },
  }
  for (const part of s.content ?? []) {
    const last = view.timeline[view.timeline.length - 1]
    if (part.type === "text" && typeof part.text === "string") {
      view.text += part.text
      if (last?.kind === "text") last.text += part.text
      else if (part.text) view.timeline.push({ kind: "text", text: part.text })
    } else if (part.type === "reasoning" && typeof part.text === "string") {
      view.reasoning += part.text
      if (last?.kind === "reasoning") last.text += part.text
      else if (part.text) view.timeline.push({ kind: "reasoning", text: part.text })
    } else if (part.type === "tool-call") {
      const toolName = String(part.toolName ?? "")
      view.toolCalls.push({
        toolCallId: String(part.toolCallId),
        toolName,
        args: await redactMailToolArgs(orgId, toolName, part.input),
        ...(part.providerMetadata ? { providerMetadata: part.providerMetadata } : {}),
      })
      view.timeline.push({ kind: "tool", toolCallId: String(part.toolCallId) })
    } else if (part.type === "tool-result") {
      view.toolResults.push({
        toolCallId: String(part.toolCallId),
        result: await redactMailToolResult(orgId, String(part.toolName ?? ""), part.output),
      })
    } else if (part.type === "tool-error") {
      const error = part.error
      view.toolErrors.push({
        toolCallId: String(part.toolCallId),
        error: error instanceof Error ? { message: error.message, name: error.name } : error,
      })
    }
  }
  return view
}

/** The response messages of the journaled steps, in order, with their guide notes in place. */
export function journaledResponseMessages(steps: readonly JournalStep[]): JournalMessage[] {
  return steps.flatMap((step) => step.messages)
}

/**
 * A step as the journal stores it: its JSON text, byte for byte. The column is
 * JSONB, which reorders object keys (shorter keys first), and a tool result's
 * key order is part of the provider request a resume rebuilds: a resumed turn
 * must send what the uninterrupted one would have sent (S10, C2).
 */
export function journalPayload(step: JournalStep): { json: string } {
  return { json: JSON.stringify(compactView(step)) }
}

/** A view result the step's own messages already hold (M7): stored by reference. */
interface ViewResultRef {
  toolCallId: string
  fromMessages: true
}

/** A step as stored: view results the messages hold are references. */
type StoredJournalStep = Omit<JournalStep, "view"> & {
  view: Omit<JournalStepView, "toolResults"> & {
    toolResults: Array<JournalStepView["toolResults"][number] | ViewResultRef>
  }
}

function messageResults(messages: readonly JournalMessage[]): Map<string, unknown> {
  const out = new Map<string, unknown>()
  for (const message of messages) {
    if (message.role !== "tool" || !Array.isArray(message.content)) continue
    for (const part of message.content as Part[]) {
      if (part?.type !== "tool-result" || typeof part.toolCallId !== "string") continue
      const output = part.output as { type?: string; value?: unknown } | undefined
      if (output?.type === "json" && "value" in output) out.set(part.toolCallId, output.value)
    }
  }
  return out
}

/**
 * Drop the view's copy of a tool result the step's messages carry as the same
 * JSON (the common case): the finalize view and the replayed messages would
 * otherwise store every result twice.
 */
function compactView(step: JournalStep): StoredJournalStep {
  const results = messageResults(step.messages)
  const toolResults = step.view.toolResults.map(
    (r): StoredJournalStep["view"]["toolResults"][number] =>
      results.has(r.toolCallId) &&
      JSON.stringify(results.get(r.toolCallId)) === JSON.stringify(r.result)
        ? { toolCallId: r.toolCallId, fromMessages: true }
        : r,
  )
  return { ...step, view: { ...step.view, toolResults } }
}

function expandView(step: StoredJournalStep): JournalStep {
  const results = messageResults(step.messages)
  return {
    ...step,
    view: {
      ...step.view,
      toolResults: step.view.toolResults.map((r) =>
        "fromMessages" in r ? { toolCallId: r.toolCallId, result: results.get(r.toolCallId) } : r,
      ),
    },
  }
}

/** Parse the event rows of a turn into steps (unknown shapes are skipped, never thrown on). */
export function parseJournal(rows: ReadonlyArray<{ payload: unknown }>): JournalStep[] {
  const steps: JournalStep[] = []
  for (const row of rows) {
    const stored = row.payload as { json?: unknown } | null
    if (!stored || typeof stored.json !== "string") continue
    let p: Partial<StoredJournalStep> | null
    try {
      p = JSON.parse(stored.json) as Partial<StoredJournalStep> | null
    } catch {
      continue
    }
    if (!p || !Array.isArray(p.messages) || !p.view || !p.prep) continue
    if (!Array.isArray(p.view.toolResults)) continue
    steps.push(expandView(p as StoredJournalStep))
  }
  // Fold each step's additions into the cumulative state (M7).
  const clips = new Map<string, unknown>()
  const guides: Array<{ at: number; content: string }> = []
  return steps.map((step) => {
    for (const [id, output] of step.prep.clippedResultIds ?? []) clips.set(id, output)
    guides.push(...(step.prep.midTurnGuideMessages ?? []))
    return {
      ...step,
      prep: { ...step.prep, clippedResultIds: [...clips], midTurnGuideMessages: [...guides] },
    }
  })
}
