// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A stub OpenAI-compatible model server for tests (Bun.serve on a free port).
// It plays both an org's own server (`/v1/...`) and OpenRouter
// (`/api/v1/...`, with `/models` and `/key`). Every chat completion answers
// with ONE tool call while the conversation has no tool result yet, then with
// a short text, streamed or not as the request asks. Requests are recorded so a
// test can assert what was sent.

export interface StubRequest {
  path: string
  body: Record<string, unknown>
  authorization: string | null
}

export interface StubOptions {
  /** OpenRouter `/models` rows. */
  catalogue?: unknown[]
  /** Answer every chat completion with this error instead (status + message). */
  failWith?: { status: number; message: string }
  /** The tool the stub calls when the request offers it; else the first tool offered. */
  preferTool?: (names: string[]) => { name: string; args: Record<string, unknown> } | null
  /** Text of the final answer. */
  answer?: string
}

export interface OpenAICompatibleStub {
  url: string
  requests: StubRequest[]
  options: StubOptions
  stop(): void
}

function toolNamesOf(body: Record<string, unknown>): string[] {
  const tools = Array.isArray(body.tools) ? (body.tools as Array<Record<string, unknown>>) : []
  return tools
    .map((t) => (t.function as { name?: unknown } | undefined)?.name)
    .filter((n): n is string => typeof n === "string")
}

function hasToolResult(body: Record<string, unknown>): boolean {
  const messages = Array.isArray(body.messages)
    ? (body.messages as Array<Record<string, unknown>>)
    : []
  return messages.some((m) => m.role === "tool")
}

const USAGE = { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 }

function sse(chunks: unknown[]): Response {
  const text = `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`
  return new Response(text, { headers: { "content-type": "text/event-stream" } })
}

function completion(body: Record<string, unknown>, options: StubOptions): Response {
  const model = String(body.model ?? "stub")
  const names = toolNamesOf(body)
  const pick =
    names.length > 0 && !hasToolResult(body)
      ? (options.preferTool?.(names) ??
        (names.includes("ping") ? { name: "ping", args: {} } : { name: names[0]!, args: {} }))
      : null
  const stream = body.stream === true
  const base = { id: "chatcmpl-stub", created: 1, model }
  if (pick) {
    const call = {
      id: "call_stub_1",
      type: "function",
      function: { name: pick.name, arguments: JSON.stringify(pick.args) },
    }
    if (!stream) {
      return Response.json({
        ...base,
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: null, tool_calls: [call] },
            finish_reason: "tool_calls",
          },
        ],
        usage: USAGE,
      })
    }
    return sse([
      {
        ...base,
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", tool_calls: [{ index: 0, ...call }] },
            finish_reason: null,
          },
        ],
      },
      {
        ...base,
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        usage: USAGE,
      },
    ])
  }
  const answer = options.answer ?? "pong"
  if (!stream) {
    return Response.json({
      ...base,
      object: "chat.completion",
      choices: [
        { index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" },
      ],
      usage: USAGE,
    })
  }
  return sse([
    {
      ...base,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { role: "assistant", content: answer }, finish_reason: null }],
    },
    {
      ...base,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: USAGE,
    },
  ])
}

export function startOpenAICompatibleStub(options: StubOptions = {}): OpenAICompatibleStub {
  const requests: StubRequest[] = []
  const state: OpenAICompatibleStub = {
    url: "",
    requests,
    options,
    stop: () => {},
  }
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname
      let body: Record<string, unknown> = {}
      if (req.method === "POST") {
        try {
          body = (await req.json()) as Record<string, unknown>
        } catch {
          body = {}
        }
      }
      requests.push({ path, body, authorization: req.headers.get("authorization") })
      if (path.endsWith("/models") && req.method === "GET") {
        return Response.json({ data: state.options.catalogue ?? [] })
      }
      if (path.endsWith("/key") && req.method === "GET") {
        return Response.json({ data: { label: "stub", limit: 50 } })
      }
      if (path.endsWith("/chat/completions")) {
        const fail = state.options.failWith
        if (fail) {
          return Response.json(
            { error: { message: fail.message, code: fail.status } },
            { status: fail.status },
          )
        }
        return completion(body, state.options)
      }
      return new Response("not found", { status: 404 })
    },
  })
  state.url = `http://127.0.0.1:${server.port}`
  state.stop = () => server.stop(true)
  return state
}

/** A trimmed OpenRouter `/models` catalogue for tests. */
export const STUB_OPENROUTER_CATALOGUE = [
  {
    id: "deepseek/deepseek-v4.1-flash-1017",
    name: "DeepSeek: DeepSeek V4.1 Flash 1017",
    context_length: 1048576,
    pricing: { prompt: "0.0000003", completion: "0.0000012" },
    supported_parameters: ["max_tokens", "reasoning", "tools", "tool_choice"],
    reasoning: { mandatory: false, supported_efforts: ["max", "high", "low", "none"] },
  },
  {
    id: "acme/always-thinks",
    name: "Acme: Always Thinks",
    context_length: 200000,
    pricing: { prompt: "0.000001", completion: "0.000002" },
    supported_parameters: ["tools", "reasoning"],
    reasoning: { mandatory: true, supported_efforts: ["low", "medium", "high"] },
  },
  {
    id: "acme/no-tools",
    name: "Acme: No Tools",
    context_length: 8192,
    pricing: { prompt: "0.0000001", completion: "0.0000001" },
    supported_parameters: ["max_tokens"],
  },
]
