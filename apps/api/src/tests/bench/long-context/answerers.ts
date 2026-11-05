// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The two answering paths, and the one rule that binds both: no Anthropic API
// key is ever read. Claude models reach this bench ONLY through the Claude
// Agent SDK under this Mac's Claude Code login, the same path
// `src/tests/e2e/agent-coordination/sdk-judge.ts` uses. Gemini reaches it only
// through GOOGLE_API_KEY. A model that neither path can serve is reported as
// "not run", never as a zero score.
import { createGoogle } from "@ai-sdk/google"
import { generateText, stepCountIs, tool } from "ai"
import { estimateTokens } from "./tokens"
import type { Answerer, AnswerRequest, AnswerResult, BenchTool } from "./types"

export const DEFAULT_GEMINI_MODEL = "gemini-flash-latest"
export const DEFAULT_SDK_MODEL = "claude-haiku-4-5-20251001"

/**
 * The forced last turn. The first week 6 run scored 53 empty S5 answers and 62
 * empty S6 ones: the model spent its last allowed step on a tool call and the
 * generation stopped with no text at all, and the judge then scored the empty
 * string (a distractor accuracy of 15 percent that measured the harness, not
 * the strategy). Every agentic answer now ends with one turn that has NO tools
 * and this instruction, and an answer that is still empty is recorded as an
 * error cell rather than as an answer.
 */
export const FINAL_ANSWER_INSTRUCTION =
  "Answer now from what you have; if nothing relevant came back, say exactly that never came up."

/** One tool call and what it returned, as the forced last turn is shown it. */
export interface ToolTrace {
  name: string
  args: unknown
  payload: string
}

export function renderToolTrace(trace: ToolTrace[]): string {
  if (trace.length === 0) return ""
  return [
    "",
    "## The tool calls you already made, and what they returned",
    "",
    ...trace.map((t) => `Call: ${t.name}(${JSON.stringify(t.args)})\nResult: ${t.payload}`),
    "",
  ].join("\n")
}

// ---------------------------------------------------------------- gemini ----

export function createGeminiAnswerer(params: { apiKey: string; modelId?: string }): Answerer {
  const modelId = params.modelId ?? DEFAULT_GEMINI_MODEL
  const google = createGoogle({ apiKey: params.apiKey })
  const model = google(modelId)

  async function answer(req: AnswerRequest): Promise<AnswerResult> {
    const started = Date.now()
    let toolCalls = 0
    let toolPayloadChars = 0
    const trace: ToolTrace[] = []
    const tools: Record<string, unknown> = {}
    for (const t of req.tools) {
      tools[t.name] = tool({
        description: t.description,
        inputSchema: t.inputSchema,
        execute: async (args: Record<string, unknown>) => {
          // The budget is enforced here rather than by the step counter: a
          // refusal still leaves the model a step in which to answer.
          if (toolCalls >= req.maxToolCalls) return FINAL_ANSWER_INSTRUCTION
          toolCalls++
          const out = await t.run(args)
          toolPayloadChars += out.length
          trace.push({ name: t.name, args, payload: out })
          return out
        },
      })
    }
    const offered = req.maxToolCalls > 0 ? req.tools.length > 0 : false
    const result = await generateText({
      model: model as any,
      system: req.system,
      prompt: req.user,
      ...(offered ? { tools: tools as any } : {}),
      stopWhen: stepCountIs(req.maxToolCalls + 2),
    })
    let text = result.text
    let providerInputTokens = result.usage?.inputTokens ?? null
    if (!text.trim() && toolCalls > 0) {
      // The forced last turn, with no tools at all.
      const final = await generateText({
        model: model as any,
        system: req.system,
        prompt: `${req.user}\n${renderToolTrace(trace)}\n${FINAL_ANSWER_INSTRUCTION}`,
      })
      text = final.text
      const finalInput = final.usage?.inputTokens ?? null
      if (finalInput !== null) providerInputTokens = (providerInputTokens ?? 0) + finalInput
    }
    return {
      text,
      toolCalls,
      toolPayloadChars,
      providerInputTokens,
      latencyMs: Date.now() - started,
    }
  }

  return {
    modelId,
    answer,
    async summarize(prompt: string, text: string) {
      const result = await generateText({
        model: model as any,
        system: prompt,
        prompt: text,
      })
      const reported = (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0)
      return {
        text: result.text,
        tokens: reported > 0 ? reported : estimateTokens(prompt + text + result.text),
      }
    },
  }
}

// ------------------------------------------------------------------- sdk ----

/** One text call through the logged in Claude Code CLI. Throws when it cannot run. */
export async function callAgentSdk(
  model: string,
  prompt: string,
): Promise<{ text: string; inputTokens: number | null }> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk")
  const session = query({
    prompt,
    options: { model, settingSources: [], mcpServers: {}, allowedTools: [], maxTurns: 1 },
  })
  let text = ""
  let inputTokens: number | null = null
  for await (const message of session) {
    if (message.type !== "result") continue
    if (message.subtype !== "success") throw new Error(`the ${model} call ended ${message.subtype}`)
    text = message.result
    // The SDK reports the uncached input separately from the cache creation
    // and cache read halves; the fed number is all three, or a 200,000 token
    // prompt reads as ten tokens.
    const usage = (message as any).usage
    const parts = [
      usage?.input_tokens ?? usage?.inputTokens,
      usage?.cache_creation_input_tokens ?? usage?.cacheCreationInputTokens,
      usage?.cache_read_input_tokens ?? usage?.cacheReadInputTokens,
    ].filter((v: unknown): v is number => typeof v === "number")
    if (parts.length > 0) inputTokens = parts.reduce((a: number, b: number) => a + b, 0)
  }
  if (!text) throw new Error(`the ${model} call returned no result message`)
  return { text, inputTokens }
}

const TOOL_PROTOCOL = [
  "",
  "## Tools",
  "",
  "You may call a tool instead of answering. To call one, reply with ONLY a JSON object on a single",
  'line: {"tool": "<name>", "args": { ... }}. Nothing else, no prose, no code fence.',
  "When you are ready to answer, reply with the answer text and no JSON.",
  "",
].join("\n")

interface ParsedToolCall {
  tool: string
  args: Record<string, unknown>
}

/** Read a tool call out of a reply. Returns null when the reply is an answer. */
export function parseToolCall(text: string): ParsedToolCall | null {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/, "")
    .trim()
  if (!stripped.startsWith("{")) return null
  try {
    const parsed = JSON.parse(stripped) as ParsedToolCall
    if (typeof parsed?.tool !== "string") return null
    return { tool: parsed.tool, args: (parsed.args ?? {}) as Record<string, unknown> }
  } catch {
    return null
  }
}

/**
 * The agentic loop for the SDK path, written here rather than exposed as MCP
 * tools: the SDK's in process MCP server would need a permission mode and a
 * tool allowlist for a loop that is three calls deep, and the bench has to
 * count the exact payload the model was fed. The model replies with a JSON
 * tool call, the bench runs it, appends the payload and asks again.
 */
export type SdkCall = (
  model: string,
  prompt: string,
) => Promise<{ text: string; inputTokens: number | null }>

export function createSdkAnswerer(params: { modelId?: string; call?: SdkCall } = {}): Answerer {
  const modelId = params.modelId ?? DEFAULT_SDK_MODEL
  const call = params.call ?? callAgentSdk

  async function answer(req: AnswerRequest): Promise<AnswerResult> {
    const started = Date.now()
    const offered: BenchTool[] = req.maxToolCalls > 0 ? req.tools : []
    const toolDocs =
      offered.length > 0
        ? `${TOOL_PROTOCOL}${offered.map((t) => `- ${t.name}: ${t.description}`).join("\n")}\n`
        : ""
    const base = `${req.system}\n${toolDocs}\n${req.user}`
    let transcript = base
    const trace: ToolTrace[] = []
    let toolCalls = 0
    let toolPayloadChars = 0
    let inputTokens: number | null = null
    let text = ""
    const account = (value: number | null): void => {
      if (value != null) inputTokens = (inputTokens ?? 0) + value
    }
    // At least one turn always runs: a strategy with no tools answers in one
    // call, and the tool budget only bounds how many MORE turns it may take.
    for (let step = 0; step <= req.maxToolCalls + 1; step++) {
      const out = await call(modelId, transcript)
      account(out.inputTokens)
      const parsed = offered.length > 0 ? parseToolCall(out.text) : null
      if (!parsed) {
        text = out.text
        break
      }
      const found = offered.find((t) => t.name === parsed.tool)
      const payload = found ? await found.run(parsed.args) : `no such tool: ${parsed.tool}`
      if (found) toolCalls++
      toolPayloadChars += payload.length
      trace.push({ name: parsed.tool, args: parsed.args, payload })
      transcript = [
        transcript,
        "",
        `Your tool call: ${JSON.stringify(parsed)}`,
        `Tool result: ${payload}`,
      ].join("\n")
      if (toolCalls >= req.maxToolCalls) break
    }
    if (!text.trim() && toolCalls > 0) {
      // The forced last turn: no tool protocol, no tools, answer or say it
      // never came up. Whatever comes back is the answer, tool shaped or not.
      const final = await call(
        modelId,
        `${req.system}\n\n${req.user}\n${renderToolTrace(trace)}\n${FINAL_ANSWER_INSTRUCTION}`,
      )
      account(final.inputTokens)
      text = parseToolCall(final.text) ? "" : final.text
    }
    return {
      text,
      toolCalls,
      toolPayloadChars,
      providerInputTokens: inputTokens,
      latencyMs: Date.now() - started,
    }
  }

  return {
    modelId,
    answer,
    async summarize(prompt: string, text: string) {
      const out = await call(modelId, `${prompt}\n\n${text}`)
      return {
        text: out.text,
        tokens: out.inputTokens ?? estimateTokens(prompt + text + out.text),
      }
    },
  }
}
