// SPDX-License-Identifier: FSL-1.1-ALv2
//
// TOOL CALLS AND RESULTS ARE SENT IN THE KEY ORDER THEY ARE STORED IN.
//
// A turn's tool calls and results are stored in a jsonb column, and jsonb keeps
// an object's keys in its own order (shorter keys first, then byte order), not
// the order they were written in. A later turn replays them from there, so its
// request wrote `{"hint":…,"note":…,"query":…}` where the turn itself had sent
// `{"query":…,"note":…,"hint":…}`: the same object, other bytes, and the
// provider's cache stopped at the previous turn's first tool call, every turn.
//
// So every request writes the objects of its tool calls and results in the
// stored order. A step sends its previous steps' calls and results in that
// order already, and the next turn's replay reads them back in the same one.
import { type LanguageModelMiddleware, wrapLanguageModel } from "ai"
import { isWrappableModel } from "./wrappable-model"

type TransformParams = NonNullable<LanguageModelMiddleware["transformParams"]>
type CallParams = Parameters<TransformParams>[0]["params"]

const encoder = new TextEncoder()

/** jsonb's key order: shorter keys first (in bytes), then byte by byte. */
function compareStoredKeys(a: string, b: string): number {
  const ab = encoder.encode(a)
  const bb = encoder.encode(b)
  if (ab.length !== bb.length) return ab.length - bb.length
  for (let i = 0; i < ab.length; i++) {
    if (ab[i] !== bb[i]) return (ab[i] as number) - (bb[i] as number)
  }
  return 0
}

/**
 * `value` with every object's keys in the order jsonb stores them. Keys whose
 * value is undefined are left out, as JSON leaves them out. A value already in
 * that order is returned as it is (same object).
 */
export function inStoredKeyOrder(value: unknown): unknown {
  if (Array.isArray(value)) {
    let changed = false
    const out = value.map((item) => {
      const next = inStoredKeyOrder(item)
      if (next !== item) changed = true
      return next
    })
    return changed ? out : value
  }
  if (typeof value !== "object" || value === null) return value
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return value
  const keys = Object.keys(value)
  const sorted = keys
    .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
    .sort(compareStoredKeys)
  let changed = sorted.length !== keys.length || sorted.some((k, i) => k !== keys[i])
  const out: Record<string, unknown> = {}
  for (const key of sorted) {
    const item = (value as Record<string, unknown>)[key]
    const next = inStoredKeyOrder(item)
    if (next !== item) changed = true
    out[key] = next
  }
  return changed ? out : value
}

/** `prompt` with its tool call inputs and JSON tool results in stored key order. */
export function promptInStoredKeyOrder(prompt: CallParams["prompt"]): CallParams["prompt"] {
  let changed = false
  const out = prompt.map((message) => {
    if (message.role !== "assistant" && message.role !== "tool") return message
    if (!Array.isArray(message.content)) return message
    let touched = false
    const content = message.content.map((part) => {
      if (part.type === "tool-call") {
        const input = inStoredKeyOrder(part.input)
        if (input === part.input) return part
        touched = true
        return { ...part, input }
      }
      if (
        part.type === "tool-result" &&
        (part.output.type === "json" || part.output.type === "error-json")
      ) {
        const value = inStoredKeyOrder(part.output.value)
        if (value === part.output.value) return part
        touched = true
        return { ...part, output: { ...part.output, value } as typeof part.output }
      }
      return part
    })
    if (!touched) return message
    changed = true
    return { ...message, content } as typeof message
  })
  return changed ? out : prompt
}

/** The middleware that writes every request's tool calls and results in stored key order. */
export const storedKeyOrderMiddleware: LanguageModelMiddleware = {
  specificationVersion: "v4",
  transformParams: async ({ params }) => {
    const prompt = promptInStoredKeyOrder(params.prompt)
    return prompt === params.prompt ? params : { ...params, prompt }
  },
}

type WrappableModel = Parameters<typeof wrapLanguageModel>[0]["model"]

/** Wrap a model so its requests carry tool calls and results in stored key order. */
export function withStoredKeyOrder<M>(model: M): M {
  if (!isWrappableModel(model)) return model
  return wrapLanguageModel({
    model: model as unknown as WrappableModel,
    middleware: storedKeyOrderMiddleware,
  }) as unknown as M
}
