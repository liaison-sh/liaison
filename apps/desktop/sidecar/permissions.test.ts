// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Two host-answered round trips: the SDK's canUseTool callback, which the
// sidecar turns into a permission_request the host answers, and the MCP relay,
// which the host uses to call a Liaison tool with the session's own token.
// Both are driven here without a model: the permission half through a fake
// runner that calls the callback the sidecar installed, the relay half against
// a local Bun.serve that asserts what came off the wire.
import { describe, expect, it } from "bun:test"
import { runMain, type SessionRunner, type SidecarConfig } from "./index"
import { callMcpTool } from "./mcp-relay"

function config(): SidecarConfig {
  return {
    mcpConfigPath: "/tmp/mcp.json",
    cwd: "/tmp/work",
    permissionMode: "manual" as const,
    model: "claude-haiku-4-5",
    isolateConfig: false,
  }
}

function collect(lines: string[]): Array<Record<string, any>> {
  return lines.filter((line) => line.trim()).map((line) => JSON.parse(line))
}

/**
 * A runner that asks the host for permission on its first turn and reports
 * what came back on the `decided` promise, so the test reads the exact
 * PermissionResult the SDK would have received.
 */
function askingRunner(decided: { value?: unknown }): SessionRunner {
  return ({ prompts, canUseTool }) => {
    async function* run() {
      for await (const _prompt of prompts) {
        decided.value = await canUseTool("Bash", { command: "ls" }, { suggestions: [] })
        yield { type: "result", subtype: "success" }
      }
    }
    const iterator = run()
    return { [Symbol.asyncIterator]: () => iterator }
  }
}

/** Control lines the test pushes while the session is already running. */
function liveControl(): {
  lines: AsyncIterable<string>
  send: (line: unknown) => void
  end: () => void
} {
  const queue: string[] = []
  const waiting: Array<(r: IteratorResult<string>) => void> = []
  let closed = false
  return {
    send: (line: unknown) => {
      const text = JSON.stringify(line)
      const waiter = waiting.shift()
      if (waiter) waiter({ value: text, done: false })
      else queue.push(text)
    },
    end: () => {
      closed = true
      while (waiting.length > 0) waiting.shift()?.({ value: undefined as never, done: true })
    },
    lines: {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift() as string, done: false })
          }
          if (closed) return Promise.resolve({ value: undefined as never, done: true })
          return new Promise<IteratorResult<string>>((resolve) => waiting.push(resolve))
        },
      }),
    },
  }
}

describe("canUseTool", () => {
  it("asks the host and maps an allow onto the SDK's PermissionResult", async () => {
    const written: string[] = []
    const decided: { value?: unknown } = {}
    const control = liveControl()
    const run = runMain({
      config: config(),
      runner: askingRunner(decided),
      write: (line) => {
        written.push(line)
        const event = JSON.parse(line) as Record<string, any>
        if (event.type === "permission_request") {
          expect(event.toolName).toBe("Bash")
          expect(event.input).toEqual({ command: "ls" })
          control.send({
            type: "permission_response",
            requestId: event.requestId,
            behavior: "allow",
            updatedInput: { command: "ls -la" },
          })
          control.send({ type: "shutdown" })
        }
      },
      control: control.lines,
    })
    control.send({ type: "turn", prompt: "run ls" })
    await run
    expect(decided.value).toEqual({ behavior: "allow", updatedInput: { command: "ls -la" } })
    expect(collect(written).some((event) => event.type === "permission_request")).toBe(true)
  })

  it("keeps the tool's own input when the host allows without editing it", async () => {
    const decided: { value?: unknown } = {}
    const control = liveControl()
    const run = runMain({
      config: config(),
      runner: askingRunner(decided),
      write: (line) => {
        const event = JSON.parse(line) as Record<string, any>
        if (event.type === "permission_request") {
          control.send({
            type: "permission_response",
            requestId: event.requestId,
            behavior: "allow",
          })
          control.send({ type: "shutdown" })
        }
      },
      control: control.lines,
    })
    control.send({ type: "turn", prompt: "run ls" })
    await run
    expect(decided.value).toEqual({ behavior: "allow", updatedInput: { command: "ls" } })
  })

  it("maps a deny onto the SDK's deny with the host's message", async () => {
    const decided: { value?: unknown } = {}
    const control = liveControl()
    const run = runMain({
      config: config(),
      runner: askingRunner(decided),
      write: (line) => {
        const event = JSON.parse(line) as Record<string, any>
        if (event.type === "permission_request") {
          control.send({
            type: "permission_response",
            requestId: event.requestId,
            behavior: "deny",
            message: "not in this folder",
          })
          control.send({ type: "shutdown" })
        }
      },
      control: control.lines,
    })
    control.send({ type: "turn", prompt: "run ls" })
    await run
    expect(decided.value).toEqual({ behavior: "deny", message: "not in this folder" })
  })

  it("fails closed: a request still pending when the host goes away is denied", async () => {
    const decided: { value?: unknown } = {}
    const control = liveControl()
    const run = runMain({
      config: config(),
      runner: askingRunner(decided),
      write: (line) => {
        const event = JSON.parse(line) as Record<string, any>
        // The host never answers. Stdin simply closes.
        if (event.type === "permission_request") control.end()
      },
      control: control.lines,
    })
    control.send({ type: "turn", prompt: "run ls" })
    await run
    expect(decided.value).toEqual({ behavior: "deny", message: "host disconnected" })
  })
})

describe("the MCP relay", () => {
  async function withServer(
    handler: (request: Request) => Response | Promise<Response>,
    body: (url: string) => Promise<void>,
  ) {
    const server = Bun.serve({ port: 0, fetch: handler })
    try {
      await body(`http://127.0.0.1:${server.port}/mcp`)
    } finally {
      await server.stop(true)
    }
  }

  it("posts a JSON-RPC tools/call carrying the agent scoped token", async () => {
    const seen: { auth?: string | null; accept?: string | null; body?: any } = {}
    await withServer(
      async (request) => {
        seen.auth = request.headers.get("authorization")
        seen.accept = request.headers.get("accept")
        seen.body = await request.json()
        return Response.json({
          jsonrpc: "2.0",
          id: seen.body.id,
          result: { content: [{ type: "text", text: "two threads" }] },
        })
      },
      async (url) => {
        const outcome = await callMcpTool(
          { liaisonMcpUrl: url, agentScopedToken: "tok-123", agentDefinition: "" },
          "mcp__liaison__kernel__threads_list",
          { limit: 2 },
        )
        expect(outcome).toEqual({
          result: { content: [{ type: "text", text: "two threads" }] },
        })
      },
    )
    expect(seen.auth).toBe("Bearer tok-123")
    expect(seen.accept).toContain("text/event-stream")
    expect(seen.body).toMatchObject({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "mcp__liaison__kernel__threads_list", arguments: { limit: 2 } },
    })
  })

  it("reads an SSE framed answer, which is what the stateless transport returns", async () => {
    await withServer(
      async (request) => {
        const body = (await request.json()) as { id: number }
        return new Response(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { ok: true } })}\n\n`,
          { headers: { "Content-Type": "text/event-stream" } },
        )
      },
      async (url) => {
        const outcome = await callMcpTool(
          { liaisonMcpUrl: url, agentScopedToken: "tok", agentDefinition: "" },
          "any_tool",
          {},
        )
        expect(outcome).toEqual({ result: { ok: true } })
      },
    )
  })

  it("reports an HTTP refusal as an error carrying the status", async () => {
    await withServer(
      async () => new Response("invalid_token", { status: 401 }),
      async (url) => {
        const outcome = await callMcpTool(
          { liaisonMcpUrl: url, agentScopedToken: "stale", agentDefinition: "" },
          "any_tool",
          {},
        )
        expect(outcome.error?.status).toBe(401)
        expect(outcome.error?.message).toContain("invalid_token")
      },
    )
  })

  it("reports a JSON-RPC error as an error rather than a result", async () => {
    await withServer(
      async (request) => {
        const body = (await request.json()) as { id: number }
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32602, message: "unknown tool" },
        })
      },
      async (url) => {
        const outcome = await callMcpTool(
          { liaisonMcpUrl: url, agentScopedToken: "tok", agentDefinition: "" },
          "nope",
          {},
        )
        expect(outcome.result).toBeUndefined()
        expect(outcome.error?.message).toContain("unknown tool")
      },
    )
  })

  // Only the fetch call itself used to sit in the try. Reading the body is a
  // SECOND await over the same connection and it fails on its own (a reset
  // mid-body, a truncated chunk), so an answer that started arriving and then
  // died threw out of the relay entirely. The host awaits that promise in a
  // `void (async ...)()`, so there was no mcp_result and no catch: an
  // unhandled rejection and a caller waiting forever.
  //
  // The failing read is injected rather than served, because Bun's own fetch
  // hands a truncated body back as a short string instead of rejecting, and a
  // test that cannot reach the throw proves nothing about the code that has to
  // survive it. The live half is the next test.
  it("reports a body read failure as an error rather than throwing", async () => {
    const brokenBody = {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "Content-Type": "application/json" }),
      text: () => Promise.reject(new Error("connection reset")),
    } as unknown as Response
    const outcome = await callMcpTool(
      { liaisonMcpUrl: "http://127.0.0.1:1/mcp", agentScopedToken: "tok", agentDefinition: "" },
      "any_tool",
      {},
      (async () => brokenBody) as unknown as typeof fetch,
    )
    expect(outcome.result).toBeUndefined()
    expect(outcome.error?.message).toContain("connection reset")
  })

  it("reports a connection that dies mid body as an error, never as a result", async () => {
    await withServer(
      () => {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0","id":1,"res'))
            setTimeout(() => controller.error(new Error("connection reset")), 20)
          },
        })
        return new Response(stream, { headers: { "Content-Type": "application/json" } })
      },
      async (url) => {
        const outcome = await callMcpTool(
          { liaisonMcpUrl: url, agentScopedToken: "tok", agentDefinition: "" },
          "any_tool",
          {},
        )
        expect(outcome.result).toBeUndefined()
        expect(outcome.error?.message).toBeTruthy()
      },
    )
  })

  it("gives up on a server that never answers, rather than waiting forever", async () => {
    await withServer(
      async () => {
        // Far longer than the relay's deadline, so the abort is what ends the
        // call; the handler still returns so the server can be stopped.
        await Bun.sleep(500)
        return Response.json({ jsonrpc: "2.0", id: 1, result: { ok: true } })
      },
      async (url) => {
        const outcome = await callMcpTool(
          { liaisonMcpUrl: url, agentScopedToken: "tok", agentDefinition: "" },
          "any_tool",
          {},
          fetch,
          50,
        )
        expect(outcome.result).toBeUndefined()
        expect(outcome.error?.message).toContain("timed out")
      },
    )
  })

  it("keeps a relay that throws inside the mcp_result answer", async () => {
    const written: string[] = []
    const control = liveControl()
    const run = runMain({
      config: config(),
      runner: ({ prompts }) => {
        async function* nothing() {
          for await (const _prompt of prompts) yield { type: "result", subtype: "success" }
        }
        const iterator = nothing()
        return { [Symbol.asyncIterator]: () => iterator }
      },
      control: control.lines,
      write: (line) => written.push(line),
      relay: async () => {
        throw new Error("the relay blew up")
      },
    })
    control.send({ type: "mcp_call", requestId: "r-1", tool: "any_tool", args: {} })
    await Bun.sleep(20)
    control.send({ type: "shutdown" })
    await run
    const result = collect(written).find((line) => line.type === "mcp_result")
    expect(result).toBeDefined()
    expect(result?.requestId).toBe("r-1")
    expect(result?.error?.message).toContain("the relay blew up")
  })

  it("answers an mcp_call control line with an mcp_result naming the same requestId", async () => {
    const written: string[] = []
    const control = liveControl()
    const run = runMain({
      config: config(),
      runner: ({ prompts }) => {
        async function* run() {
          for await (const _prompt of prompts) yield { type: "result", subtype: "success" }
        }
        const iterator = run()
        return { [Symbol.asyncIterator]: () => iterator }
      },
      write: (line) => written.push(line),
      relay: async (tool, args) => ({ result: { tool, args } }),
      control: control.lines,
    })
    control.send({ type: "mcp_call", requestId: "call-7", tool: "kernel__threads_list", args: {} })
    await Bun.sleep(10)
    control.send({ type: "shutdown" })
    await run
    const result = collect(written).find((event) => event.type === "mcp_result")
    expect(result).toMatchObject({
      requestId: "call-7",
      result: { tool: "kernel__threads_list" },
    })
  })
})

describe("Auto, the default mode", () => {
  /** Asks for each call in turn and records what the SDK would have received. */
  function callsRunner(
    calls: Array<[string, Record<string, unknown>]>,
    decided: unknown[],
  ): SessionRunner {
    return ({ prompts, canUseTool }) => {
      async function* run() {
        for await (const _prompt of prompts) {
          for (const [tool, input] of calls) decided.push(await canUseTool(tool, input, {}))
          yield { type: "result", subtype: "success" }
        }
      }
      const iterator = run()
      return { [Symbol.asyncIterator]: () => iterator }
    }
  }

  async function drive(
    mode: SidecarConfig["permissionMode"],
    calls: Array<[string, Record<string, unknown>]>,
  ) {
    const written: string[] = []
    const decided: unknown[] = []
    const control = liveControl()
    const run = runMain({
      config: { ...config(), permissionMode: mode },
      runner: callsRunner(calls, decided),
      write: (line) => {
        written.push(line)
        const event = JSON.parse(line) as Record<string, any>
        if (event.type === "permission_request") {
          control.send({
            type: "permission_response",
            requestId: event.requestId,
            behavior: "deny",
          })
        }
        if (event.type === "turn_done") control.send({ type: "shutdown" })
      },
      control: control.lines,
    })
    control.send({ type: "turn", prompt: "go" })
    await run
    const asked = collect(written)
      .filter((event) => event.type === "permission_request")
      .map((event) => event.toolName)
    return { decided, asked }
  }

  it("runs a read-only Liaison MCP call without asking", async () => {
    const input = { query: "rapport mensuel" }
    const { decided, asked } = await drive("auto", [["mcp__liaison__kernel__skill_search", input]])
    expect(asked).toEqual([])
    expect(decided).toEqual([{ behavior: "allow", updatedInput: input }])
  })

  it("still asks before a destructive shell command", async () => {
    const { decided, asked } = await drive("auto", [
      ["Bash", { command: "ls -la" }],
      ["Bash", { command: "rm -rf /Users/someone" }],
    ])
    expect(asked).toEqual(["Bash"])
    expect(decided[0]).toEqual({ behavior: "allow", updatedInput: { command: "ls -la" } })
    expect((decided[1] as { behavior: string }).behavior).toBe("deny")
  })

  it("leaves Manual asking for the same Liaison call", async () => {
    const { asked } = await drive("manual", [["mcp__liaison__kernel__skill_search", {}]])
    expect(asked).toEqual(["mcp__liaison__kernel__skill_search"])
  })
})

describe("stopping a turn parked on a permission question", () => {
  it("denies the parked request, so the SDK is never left waiting on it", async () => {
    const decided: { value?: unknown } = {}
    const control = liveControl()
    let interrupted = 0
    const run = runMain({
      config: config(),
      runner: (args) => {
        const handle = askingRunner(decided)(args)
        return {
          ...handle,
          interrupt: async () => {
            interrupted += 1
          },
        }
      },
      write: (line) => {
        const event = JSON.parse(line) as Record<string, any>
        if (event.type === "permission_request") control.send({ type: "interrupt" })
        if (event.type === "interrupted") control.send({ type: "shutdown" })
      },
      control: control.lines,
    })
    control.send({ type: "turn", prompt: "run ls" })
    await run
    expect(interrupted).toBe(1)
    expect(decided.value).toEqual({ behavior: "deny", message: "the user stopped this turn" })
  })
})
