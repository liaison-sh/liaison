// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A THREAD'S TOOL LIST NEVER CHANGES.
//
// Upstreams that render the tool list ahead of the conversation (DeepSeek on
// OpenRouter, Anthropic) cache a request only as far as it repeats the one
// before. A tool added to the list mid-thread re-bills the whole conversation
// after it, on every turn that loads one: the largest uncached cost left once
// the system prompt was byte-stable.
//
// So the provider sees one tool list per thread: the list the thread's first
// turn started with (its reply's `toolOrder`, carried by every later turn).
// A tool loaded later is still loaded for the SDK (it parses, validates and
// runs the call, and every record keys on its real name), but the provider is
// not told about it in the tool list: its schema arrives in the conversation,
// as a guide note (guide-notes.ts), and the model calls it through one stable
// entry in the list, `kernel__call_tool` {"name", "arguments"}.
//
// This middleware is the boundary between the two views:
//   - on the way out, the request's tools are filtered to the thread's list,
//     and a call the history shows to a tool off that list is written as the
//     `kernel__call_tool` call the model made (so the conversation repeats,
//     byte for byte, what the model saw and produced);
//   - on the way back, a `kernel__call_tool` call naming a tool the turn has
//     loaded becomes a call to that tool, with its arguments as the input. A
//     call naming anything else is left as it is: the tool itself answers
//     (loads the named tool, or says what is wrong).
// A direct call to a loaded off-list tool needs nothing: the SDK holds it.
import { asSchema, type LanguageModelMiddleware, wrapLanguageModel } from "ai"
import { isRecord } from "~/lib/guards"
import { rootLogger } from "~/lib/logger"
import { indexedToolPart, loadedToolPart } from "~/modules/agent/context/guide-notes"
import type { LoadedToolSchema, RunContext } from "~/modules/agent/runtime/run-context"
import { resolveHeldToolName } from "~/modules/agent/tools/tool-name-resolve"
import { isWrappableModel } from "./wrappable-model"

const log = rootLogger.child({ module: "fixed-tool-list" })

/** The stable entry a loaded tool outside the thread's tool list is called through. */
export const CALL_TOOL_SDK_NAME = "kernel__call_tool"

type TransformParams = NonNullable<LanguageModelMiddleware["transformParams"]>
type CallParams = Parameters<TransformParams>[0]["params"]
type WrapStream = NonNullable<LanguageModelMiddleware["wrapStream"]>
type StreamResult = Awaited<ReturnType<WrapStream>>
type ModelStreamPart = StreamResult["stream"] extends ReadableStream<infer P> ? P : never
type WrapGenerate = NonNullable<LanguageModelMiddleware["wrapGenerate"]>
type GenerateResult = Awaited<ReturnType<WrapGenerate>>
type WrappableModel = Parameters<typeof wrapLanguageModel>[0]["model"]

/** The tool list a thread sends, fixed for the turn. Null: no fixed list (every loaded tool is sent). */
export type FixedToolList = ReadonlySet<string> | null

/**
 * The arguments a `kernel__call_tool` input carries. Weak models put them in
 * `arguments`, `args` or `input`, as a JSON string, or beside `name` itself.
 */
export function callToolArguments(input: Record<string, unknown>): Record<string, unknown> {
  for (const key of ["arguments", "args", "input", "parameters"]) {
    const value = input[key]
    if (isRecord(value)) return value
    if (typeof value === "string") {
      try {
        const parsed: unknown = JSON.parse(value)
        if (isRecord(parsed)) return parsed
      } catch {
        // Not JSON: fall through to the next form.
      }
    }
  }
  const rest: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(input)) {
    if (k === "name" || k === "tool" || k === "toolName") continue
    if (["arguments", "args", "input", "parameters"].includes(k)) continue
    rest[k] = v
  }
  return rest
}

/** The tool a `kernel__call_tool` input names, as written. */
export function callToolTarget(input: Record<string, unknown>): string | null {
  for (const key of ["name", "tool", "toolName"]) {
    const value = input[key]
    if (typeof value === "string" && value.trim() !== "") return value.trim()
  }
  return null
}

/** The `kernel__call_tool` input that calls `toolName` with `input`. */
export function wrapAsCallToolInput(toolName: string, input: unknown): Record<string, unknown> {
  return { name: toolName, arguments: input ?? {} }
}

/**
 * `prompt` with every tool call (and its result) to a tool off `list` written
 * as the `kernel__call_tool` call it was made through. Messages that hold no
 * such call are returned as they are (same objects).
 */
export function wrapOffListToolCalls(
  prompt: CallParams["prompt"],
  list: ReadonlySet<string>,
): CallParams["prompt"] {
  const off = (name: string) => name !== CALL_TOOL_SDK_NAME && !list.has(name)
  let changed = false
  const out = prompt.map((message) => {
    if (message.role !== "assistant" && message.role !== "tool") return message
    if (!Array.isArray(message.content)) return message
    let touched = false
    const content = message.content.map((part) => {
      if (part.type === "tool-call" && off(part.toolName)) {
        touched = true
        return {
          ...part,
          toolName: CALL_TOOL_SDK_NAME,
          input: wrapAsCallToolInput(part.toolName, part.input),
        }
      }
      if (part.type === "tool-result" && off(part.toolName)) {
        touched = true
        return { ...part, toolName: CALL_TOOL_SDK_NAME }
      }
      return part
    })
    if (!touched) return message
    changed = true
    return { ...message, content } as typeof message
  })
  return changed ? out : prompt
}

/**
 * The direct call a `kernel__call_tool` call stands for, when it names one of
 * `held` (the tools the SDK was asked to hold for this step): its name and its
 * arguments as the JSON input. Null when the input is not an object or names
 * no single held tool: the call then goes to `kernel__call_tool` itself.
 */
export function unwrapCallTool(
  input: string,
  held: readonly string[],
): { toolName: string; input: string } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(input)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const target = callToolTarget(parsed)
  if (!target || target === CALL_TOOL_SDK_NAME) return null
  const resolution = resolveHeldToolName(target, held)
  if (resolution.kind !== "exact" && resolution.kind !== "resolved") return null
  if (resolution.name === CALL_TOOL_SDK_NAME) return null
  return { toolName: resolution.name, input: JSON.stringify(callToolArguments(parsed)) }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null)?.then === "function"
}

/** A tool's input schema as the SDK hands it to a provider. */
function toolSchemaOf(tool: unknown): ReturnType<typeof asSchema> | null {
  const inputSchema = (tool as { inputSchema?: unknown } | null | undefined)?.inputSchema
  if (inputSchema === undefined) return null
  return asSchema(inputSchema as Parameters<typeof asSchema>[0])
}

/** The parameters without their `$schema` URI: it names the JSON Schema draft and tells the model nothing. */
function withoutSchemaUri(parameters: unknown): unknown {
  if (typeof parameters !== "object" || parameters === null || !("$schema" in parameters)) {
    return parameters
  }
  const { $schema: _uri, ...rest } = parameters as Record<string, unknown>
  return rest
}

/**
 * What the model is told about a loaded tool outside the list: the
 * description and the JSON Schema parameters the tool list would carry.
 * Null when the tool is absent or its schema resolves only asynchronously.
 */
export function describeLoadedTool(name: string, tool: unknown): LoadedToolSchema | null {
  const schema = toolSchemaOf(tool)
  if (!schema) return null
  const parameters = schema.jsonSchema
  if (isPromiseLike(parameters)) {
    log.warn({ toolName: name }, "A loaded tool's schema is asynchronous: not described")
    return null
  }
  const description = (tool as { description?: unknown }).description
  return {
    name,
    description: typeof description === "string" ? description : "",
    parameters: withoutSchemaUri(parameters),
  }
}

/**
 * The run frame's view of a fixed tool list over `tools` (RunContext.fixedToolList):
 * what kernel__call_tool and tool_search read to answer about a loaded tool.
 * `requestSchemas` is told which loaded tools the model asked for (a search
 * naming them, a call): a tool loaded by name only gets its schema then.
 */
export function fixedToolListFrame(
  listed: ReadonlySet<string>,
  tools: Record<string, unknown>,
  isLoaded: (name: string) => boolean,
  requestSchemas?: (names: readonly string[]) => void,
): NonNullable<RunContext["fixedToolList"]> {
  return {
    listed,
    isLoaded,
    describe: (name) => describeLoadedTool(name, tools[name]),
    validate: (name, args) => validateLoadedToolInput(tools[name], args),
    ...(requestSchemas ? { requestSchemas } : {}),
  }
}

/**
 * The loaded tools among `active` that the fixed list leaves out and whose
 * description and parameters were not delivered yet (`delivered` holds guide
 * parts, guide-notes.ts), with the parts that deliver them. The caller sends
 * them in a guide note (renderLoadedToolsBlock) and marks the parts delivered.
 *
 * A tool `indexOnly` names (loaded speculatively, not asked for) is listed by
 * name and purpose instead (`indexed`, renderIndexedToolsBlock), once: its
 * schema follows when the model asks for it and `indexOnly` stops naming it.
 */
export function undeliveredLoadedTools(
  active: Iterable<string>,
  listed: ReadonlySet<string>,
  tools: Record<string, unknown>,
  delivered: ReadonlySet<string>,
  indexOnly: (name: string) => boolean = () => false,
): {
  loaded: LoadedToolSchema[]
  indexed: Array<{ name: string; description: string }>
  parts: string[]
} {
  const loaded: LoadedToolSchema[] = []
  const indexed: Array<{ name: string; description: string }> = []
  const parts: string[] = []
  for (const name of active) {
    if (listed.has(name)) continue
    const part = loadedToolPart(name)
    if (delivered.has(part)) continue
    if (indexOnly(name)) {
      const indexPart = indexedToolPart(name)
      if (delivered.has(indexPart)) continue
      const description = (tools[name] as { description?: unknown } | undefined)?.description
      indexed.push({ name, description: typeof description === "string" ? description : "" })
      parts.push(indexPart)
      continue
    }
    const described = describeLoadedTool(name, tools[name])
    if (!described) continue
    loaded.push(described)
    parts.push(part)
  }
  return { loaded, indexed, parts }
}

/** One line per problem: `path: message`. */
function validationProblems(error: unknown): string {
  const issues =
    (error as { cause?: { issues?: unknown } } | null)?.cause?.issues ??
    (error as { issues?: unknown } | null)?.issues
  if (Array.isArray(issues) && issues.length > 0) {
    return issues
      .slice(0, 8)
      .map((issue: { path?: unknown; message?: unknown }) => {
        const path =
          Array.isArray(issue.path) && issue.path.length > 0 ? issue.path.join(".") : "(arguments)"
        return `${path}: ${typeof issue.message === "string" ? issue.message : "invalid"}`
      })
      .join("; ")
  }
  const message = error instanceof Error ? error.message : String(error)
  return message.slice(0, 600)
}

/** Checks `args` against a loaded tool's input schema, as the SDK would before running it. */
export async function validateLoadedToolInput(
  tool: unknown,
  args: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const schema = toolSchemaOf(tool)
  if (!schema?.validate) return { ok: true }
  const result = await schema.validate(args)
  return result.success ? { ok: true } : { ok: false, error: validationProblems(result.error) }
}

/** The names of the function tools a call holds, by the params object the inner model receives. */
const heldByParams = new WeakMap<object, string[]>()

function functionToolNames(tools: CallParams["tools"]): string[] {
  return (tools ?? []).flatMap((t) => (t.type === "function" ? [t.name] : []))
}

function createFixedToolListMiddleware(list: ReadonlySet<string>): LanguageModelMiddleware {
  const unwrap = (part: { toolName: string; input: string }, held: readonly string[]) => {
    if (part.toolName !== CALL_TOOL_SDK_NAME) return null
    const direct = unwrapCallTool(part.input, held)
    if (direct) {
      log.debug({ toolName: direct.toolName }, "Loaded tool called through kernel__call_tool")
    }
    return direct
  }
  return {
    specificationVersion: "v4",
    transformParams: async ({ params }) => {
      const held = functionToolNames(params.tools)
      // Only a list that offers the stable entry can leave a tool out: without
      // it, a loaded tool would be uncallable.
      if (!held.includes(CALL_TOOL_SDK_NAME)) return params
      const tools = (params.tools ?? []).filter((t) => t.type !== "function" || list.has(t.name))
      const next = { ...params, tools, prompt: wrapOffListToolCalls(params.prompt, list) }
      heldByParams.set(next, held)
      return next
    },
    wrapGenerate: async ({ doGenerate, params }): Promise<GenerateResult> => {
      const result = await doGenerate()
      const held = heldByParams.get(params)
      if (!held) return result
      const content = result.content.map((part) => {
        if (part.type !== "tool-call") return part
        const direct = unwrap(part, held)
        return direct ? { ...part, ...direct } : part
      })
      return { ...result, content }
    },
    wrapStream: async ({ doStream, params }) => {
      const result = await doStream()
      const held = heldByParams.get(params)
      if (!held) return result
      // A call's streamed input names the stable entry until it is complete:
      // its live parts are dropped and the complete call is sent as the tool
      // it names.
      const callToolInputs = new Set<string>()
      const stream = result.stream.pipeThrough(
        new TransformStream<ModelStreamPart, ModelStreamPart>({
          transform(part, controller) {
            if (part.type === "tool-input-start" && part.toolName === CALL_TOOL_SDK_NAME) {
              callToolInputs.add(part.id)
              return
            }
            if (
              (part.type === "tool-input-delta" || part.type === "tool-input-end") &&
              callToolInputs.has(part.id)
            ) {
              return
            }
            if (part.type === "tool-call") {
              const direct = unwrap(part, held)
              controller.enqueue(direct ? { ...part, ...direct } : part)
              return
            }
            controller.enqueue(part)
          },
        }),
      )
      return { ...result, stream }
    },
  }
}

/**
 * Wrap a model so the provider sees only `list` for tools (see the header).
 * A null list, or a model given by id string, is returned unchanged.
 */
export function withFixedToolList<M>(model: M, list: FixedToolList): M {
  if (list === null || !isWrappableModel(model)) return model
  return wrapLanguageModel({
    model: model as unknown as WrappableModel,
    middleware: createFixedToolListMiddleware(list),
  }) as unknown as M
}
