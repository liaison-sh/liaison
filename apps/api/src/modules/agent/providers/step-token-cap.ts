// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * A hard OUTPUT limit on ONE model request of the agent loop, and the hook a
 * demo visitor's step meter prices each request through.
 *
 * Only demo orgs spending this box's key carry one (`resolveModelForPreCheck`
 * sets it for the reserved App Review org, `demoVisitorModelInfo` for a
 * verified visitor's pin; every other org's is null and its requests are
 * untouched). The step's output is capped. Its input is not: the model's own
 * context window bounds it, and prompt caching makes a long context cheap.
 *
 * A VISITOR step (`visitor: true`) reports its input estimate to its step
 * meter before the request leaves (`onRequest`), so the visitor budget holds
 * the request's real worst cost (demo-spend-ceiling.ts, ONE STEP). The
 * estimate is strict, because its text is the visitor's to choose: ASCII
 * characters / 3 plus ONE token per non-ASCII code point (CJK and emoji
 * tokenize near one token per character). A visitor step that carries an
 * image, a file or audio is refused outright (`demo_media_refused`): its size
 * in tokens is not knowable from its bytes.
 */
import { type LanguageModelMiddleware, wrapLanguageModel } from "ai"
import { isWrappableModel } from "./wrappable-model"

type WrappableModel = Parameters<typeof wrapLanguageModel>[0]["model"]
type CallOptions = Parameters<NonNullable<LanguageModelMiddleware["transformParams"]>>[0]["params"]

/** The output one request may reach, in tokens. */
export interface StepTokenCap {
  maxOutputTokens: number
  /** A verified demo visitor's step: the strict estimate and no media. */
  visitor?: boolean
  /**
   * Told each time a request is about to be handed to the provider, with its
   * input estimate (visitor steps: the strict estimate, else 0). A visitor's
   * step meter holds the request's worst cost here, and a request whose cost
   * the budget cannot hold is refused by the throw; a step whose request left
   * is billed even when its usage never comes back. Not called for a request
   * refused for its media.
   */
  onRequest?: (estimatedInputTokens: number) => void | Promise<void>
  /**
   * Told when one model call of the agent loop has answered in full, with what
   * it reported, BEFORE the SDK runs the tools that call asked for
   * (`runAgentStream` forwards it as `onLanguageModelCallEnd`). A visitor's
   * step meter settles the step there, so a tool that waits (an `agents_ask`
   * on a colleague's turn) holds no reservation while it waits.
   */
  onCallEnd?: (usage: unknown, providerMetadata: unknown) => void | Promise<void>
}

/** Characters per token the estimate assumes: a floor, so it overcounts. */
export const CHARS_PER_TOKEN_FLOOR = 3

/** Thrown when a visitor step carries a non-text part. Nothing was sent. */
export class DemoMediaRefusedError extends Error {
  readonly code = "demo_media_refused"
  constructor() {
    super("This demo does not read images, audio, video or documents.")
  }
}

/** The visitor estimate of a string: ASCII chars / 3 + one per non-ASCII code point. */
export function estimateVisitorTokens(text: string): number {
  let ascii = 0
  let other = 0
  for (const ch of text) {
    if ((ch.codePointAt(0) ?? 0) < 0x80) ascii += 1
    else other += 1
  }
  return Math.ceil(ascii / CHARS_PER_TOKEN_FLOOR) + other
}

/** The visitor input estimate of one request, in tokens. */
export function estimateVisitorRequestInputTokens(
  params: Pick<CallOptions, "prompt" | "tools">,
): number {
  return estimateVisitorTokens(
    JSON.stringify(params.prompt ?? []) + JSON.stringify(params.tools ?? []),
  )
}

const MEDIA_PART_TYPES = new Set([
  "file",
  "image",
  "media",
  "image-data",
  "file-data",
  "image-url",
  "file-url",
])

/** Does any message part (or tool result content item) carry media? */
export function promptHasMedia(prompt: unknown): boolean {
  if (!Array.isArray(prompt)) return false
  for (const message of prompt) {
    const content = (message as { content?: unknown } | null)?.content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      const type = (part as { type?: unknown } | null)?.type
      if (typeof type === "string" && MEDIA_PART_TYPES.has(type)) return true
      if (type === "tool-result") {
        const output = (part as { output?: { type?: unknown; value?: unknown } }).output
        if (output?.type === "content" && Array.isArray(output.value)) {
          for (const item of output.value) {
            const t = (item as { type?: unknown } | null)?.type
            if (typeof t === "string" && MEDIA_PART_TYPES.has(t)) return true
          }
        }
      }
    }
  }
  return false
}

function createStepTokenCapMiddleware(cap: StepTokenCap): LanguageModelMiddleware {
  return {
    specificationVersion: "v4",
    transformParams: async ({ params }) => {
      if (cap.visitor && promptHasMedia(params.prompt)) throw new DemoMediaRefusedError()
      if (cap.onRequest) {
        await cap.onRequest(cap.visitor ? estimateVisitorRequestInputTokens(params) : 0)
      }
      const asked = params.maxOutputTokens
      return {
        ...params,
        maxOutputTokens:
          asked === undefined ? cap.maxOutputTokens : Math.min(asked, cap.maxOutputTokens),
      }
    },
  }
}

/**
 * Wrap a model for one turn with `cap`, or return it unchanged for a null cap.
 * Fails closed: a capped request on a model this middleware cannot wrap throws
 * rather than running uncapped.
 */
export function withStepTokenCap<M>(model: M, cap: StepTokenCap | null): M {
  if (cap === null) return model
  if (!isWrappableModel(model)) {
    throw new Error("A step token cap needs a model object it can wrap")
  }
  return wrapLanguageModel({
    model: model as unknown as WrappableModel,
    middleware: createStepTokenCapMiddleware(cap),
  }) as unknown as M
}
