// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * A tool call the model WROTE instead of MAKING.
 *
 * Weaker or confused models (seen on Gemini in a live walk, 2026-09-22) now
 * and then answer a step with text that spells out a tool call instead of
 * emitting a function call:
 *
 *     {"calls":[{"tool":"tool_search","arguments":{"query":"select:kpi_run"}}]}
 *
 * The SDK sees a text-only step, ends the loop, and that JSON is persisted and
 * rendered as the agent's ANSWER. The provider adapters are not at fault (the
 * wire carried text); the fix belongs at the model seam, so every provider and
 * every caller of the agent loop is covered.
 *
 * This middleware holds back a step's text while it could still be such a
 * block (it starts with `{` or a code fence) and, when the step ends, if the
 * WHOLE text is a pseudo call naming tools the step was offered, replaces it
 * with real `tool-call` parts and a `tool-calls` finish. The loop then runs
 * the calls and continues as if the model had called them properly. Any other
 * text is released unchanged: ordinary prose streams without delay, and a JSON
 * answer that does not name offered tools (a user asked for JSON) is kept.
 */
import { type LanguageModelMiddleware, wrapLanguageModel } from "ai"
import { rootLogger } from "~/lib/logger"
import { resolveHeldToolName } from "~/modules/agent/tools/tool-name-resolve"
import { isWrappableModel } from "./wrappable-model"

const log = rootLogger.child({ module: "text-tool-calls" })

type WrapStream = NonNullable<LanguageModelMiddleware["wrapStream"]>
type StreamResult = Awaited<ReturnType<WrapStream>>
type ModelStreamPart = StreamResult["stream"] extends ReadableStream<infer P> ? P : never
type WrappableModel = Parameters<typeof wrapLanguageModel>[0]["model"]

/** Past this much held text it is prose (or a document), not a call. */
const MAX_HELD_CHARS = 20_000

export interface TextToolCall {
  toolName: string
  input: Record<string, unknown>
}

const NAME_KEYS = ["tool", "name", "toolName", "tool_name", "function"] as const
const ARG_KEYS = ["arguments", "args", "input", "parameters", "params"] as const

/**
 * Parse `text` as a written-out tool call. Returns null unless the WHOLE text
 * (optionally in one code fence) is one, and every named tool resolves to one
 * of `offered` (exactly, or unambiguously per `resolveHeldToolName`).
 */
export function parseTextToolCalls(
  text: string,
  offered: readonly string[],
): TextToolCall[] | null {
  let body = text.trim()
  const fence = body.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/)
  if (fence) body = fence[1].trim()
  if (!body.startsWith("{") && !body.startsWith("[")) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  const rawCalls: unknown[] = Array.isArray(parsed)
    ? parsed
    : isObject(parsed) && Array.isArray(parsed.calls)
      ? parsed.calls
      : isObject(parsed) && Array.isArray(parsed.tool_calls)
        ? parsed.tool_calls
        : [parsed]
  if (rawCalls.length === 0) return null
  const calls: TextToolCall[] = []
  for (const raw of rawCalls) {
    if (!isObject(raw)) return null
    const name = pickName(raw)
    if (!name) return null
    const toolName = resolveToolName(name, offered)
    if (!toolName) return null
    const args = pickArgs(raw)
    if (args === null) return null
    calls.push({ toolName, input: args })
  }
  return calls
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function pickName(raw: Record<string, unknown>): string | null {
  for (const key of NAME_KEYS) {
    const v = raw[key]
    if (typeof v === "string" && v.length > 0) return v
    // OpenAI-shaped {"function": {"name": ..., "arguments": ...}}
    if (key === "function" && isObject(v) && typeof v.name === "string") return v.name
  }
  return null
}

function pickArgs(raw: Record<string, unknown>): Record<string, unknown> | null {
  const source = isObject(raw.function) ? raw.function : raw
  for (const key of ARG_KEYS) {
    const v = source[key]
    if (v === undefined) continue
    if (isObject(v)) return v
    if (typeof v === "string") {
      try {
        const p = JSON.parse(v)
        return isObject(p) ? p : null
      } catch {
        return null
      }
    }
    return null
  }
  return {}
}

function resolveToolName(name: string, offered: readonly string[]): string | null {
  const r = resolveHeldToolName(name, offered)
  return r.kind === "exact" || r.kind === "resolved" ? r.name : null
}

let callSeq = 0
function nextCallId(): string {
  callSeq += 1
  return `text-call-${Date.now().toString(36)}-${callSeq}`
}

export const textToolCallMiddleware: LanguageModelMiddleware = {
  specificationVersion: "v4",
  wrapStream: async ({ doStream, params }) => {
    const result = await doStream()
    const offered = (params.tools ?? []).filter((t) => t.type === "function").map((t) => t.name)
    if (offered.length === 0) return result

    // "undecided": nothing but whitespace seen yet; "holding": the text so far
    // could be a written call; "passthrough": it cannot, release everything.
    let mode: "undecided" | "holding" | "passthrough" = "undecided"
    let held: ModelStreamPart[] = []
    let text = ""

    const release = (controller: TransformStreamDefaultController<ModelStreamPart>) => {
      for (const p of held) controller.enqueue(p)
      held = []
      mode = "passthrough"
    }

    const stream = result.stream.pipeThrough(
      new TransformStream<ModelStreamPart, ModelStreamPart>({
        transform(part, controller) {
          if (mode === "passthrough") {
            controller.enqueue(part)
            return
          }
          if (part.type === "text-start" || part.type === "text-end") {
            held.push(part)
            return
          }
          if (part.type === "text-delta") {
            held.push(part)
            text += part.delta
            const head = text.trimStart()
            if (head.length === 0) return
            if (
              (head[0] !== "{" && head[0] !== "[" && head[0] !== "`") ||
              text.length > MAX_HELD_CHARS
            ) {
              release(controller)
              return
            }
            mode = "holding"
            return
          }
          if (
            part.type === "tool-call" ||
            part.type === "tool-input-start" ||
            part.type === "tool-input-delta" ||
            part.type === "tool-input-end"
          ) {
            // A real call in the same step: the text is commentary, not a call.
            release(controller)
            controller.enqueue(part)
            return
          }
          if (part.type === "finish" && mode === "holding") {
            const calls = parseTextToolCalls(text, offered)
            if (calls) {
              log.warn(
                { tools: calls.map((c) => c.toolName) },
                "Model wrote its tool call as text; executing it as a real call",
              )
              held = []
              for (const call of calls) {
                controller.enqueue({
                  type: "tool-call",
                  toolCallId: nextCallId(),
                  toolName: call.toolName,
                  input: JSON.stringify(call.input),
                })
              }
              controller.enqueue({
                ...part,
                finishReason: { ...part.finishReason, unified: "tool-calls" },
              })
              mode = "passthrough"
              return
            }
            release(controller)
            controller.enqueue(part)
            return
          }
          // Reasoning, metadata, sources, errors: never held.
          controller.enqueue(part)
        },
        flush(controller) {
          if (held.length > 0) release(controller)
        },
      }),
    )
    return { ...result, stream }
  },
}

/** Wrap a model object; a model given by id string is left to the SDK. */
export function withTextToolCalls<M>(model: M): M {
  if (isWrappableModel(model)) {
    return wrapLanguageModel({
      model: model as unknown as WrappableModel,
      middleware: textToolCallMiddleware,
    }) as unknown as M
  }
  return model
}
