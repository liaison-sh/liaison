// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A32's loop, end to end in one window: a message apps/web NAMES through the
// bridge becomes a turn on this machine, and the turn's answer becomes the
// agent's reply in the same conversation.
//
// The id is a claim, never a source. Since P6d-T16a the document event is gone
// and `submitLocalTurn` is the one way in, so every case here goes through it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const shell = vi.hoisted(() => {
  const listeners = new Set<(event: Record<string, unknown>) => void>()
  return {
    listeners,
    emit(event: Record<string, unknown>) {
      for (const listener of Array.from(listeners)) listener(event)
    },
    startTurn: vi.fn(async (_prompt: string, _turnCredential?: string) => undefined),
  }
})

vi.mock("./sidecar-client", () => ({
  startTurn: shell.startTurn,
  onTurnEvent: (callback: (event: Record<string, unknown>) => void) => {
    shell.listeners.add(callback)
    return () => shell.listeners.delete(callback)
  },
}))

import type { LocalSessionHandle } from "./start-local-session"
import {
  attachLocalTurns,
  promptFromMessage,
  replyRetry,
  submitLocalTurn,
} from "./thread-turn-bridge"
import { undeliveredReplyFor } from "./undelivered-replies"

/**
 * What the reply route answers, one status per attempt, in order; 201 once
 * the list runs out. A test that wants a refusal pushes it here.
 */
const replyStatuses: number[] = []

const calls: Array<{ url: string; body: Record<string, unknown> | null }> = []

/**
 * What the SERVER says each message is. The caller hands over only an id: the
 * bridge re-reads the message before running anything, so a forged id is a
 * lookup that finds something else, or nothing.
 */
const stored = new Map<
  string,
  {
    threadId: string
    authorKind: string
    text: string
    replyRootId?: string | null
    turnCredential?: string
  }
>()

function handleFor(threadId: string | null): LocalSessionHandle {
  return {
    agentId: "agent-1",
    auditSessionId: "sess-1",
    threadId,
    claimHolderKey: "holder-1",
    folderHash: "f".repeat(64),
    mode: "manual",
    model: "claude-haiku-4-5",
    serverAddress: "https://acme.example.com",
    accessToken: "tok1",
    finish: async () => undefined,
    releaseClaim: async () => undefined,
    reclaim: async () => true,
    systemPromptChecksum: async () => "c".repeat(64),
    freshReason: null,
  }
}

/**
 * The page asking for one turn, the only way it can: a message id. Not awaited,
 * because the promise settles when the SDK turn does and the cases below drive
 * that stream themselves.
 */
function ask(messageId: string): void {
  void submitLocalTurn(messageId)
}

/** Lets the queued turn chain run to the point where it is waiting on the SDK. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

beforeEach(() => {
  calls.length = 0
  stored.clear()
  stored.set("m1", { threadId: "t1", authorKind: "user", text: "make it" })
  shell.listeners.clear()
  shell.startTurn.mockClear()
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({
        url,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      })
      const read = url.match(/\/messages\/([^/?]+)(?:\?.*)?$/)
      if (read) {
        const message = stored.get(read[1])
        if (!message) return new Response(null, { status: 404 })
        return new Response(JSON.stringify({ data: { id: read[1], ...message } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      if (url.endsWith("/reply")) {
        const status = replyStatuses.shift() ?? 201
        if (status === 0) throw new TypeError("Load failed")
        if (status !== 201) {
          return new Response(JSON.stringify({ error: { message: `refused ${status}` } }), {
            status,
            headers: { "content-type": "application/json" },
          })
        }
      }
      return new Response(JSON.stringify({ data: { messageId: "m-reply" } }), {
        status: 201,
        headers: { "content-type": "application/json" },
      })
    }),
  )
  replyStatuses.length = 0
  replyRetry.delaysMs = [0, 0, 0, 0]
  localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("promptFromMessage", () => {
  it("strips the mention pill that names the agent, keeping the question", () => {
    expect(promptFromMessage("@[Liaison](agent:a-1) Create a file named hello.txt")).toBe(
      "Create a file named hello.txt",
    )
  })

  it("leaves a message with no mention alone", () => {
    expect(promptFromMessage("  Create hello.txt  ")).toBe("Create hello.txt")
  })

  it("leaves a mention that is not the first thing in the message", () => {
    expect(promptFromMessage("ask @[Liaison](agent:a-1) about it")).toBe(
      "ask @[Liaison](agent:a-1) about it",
    )
  })
})

describe("a local turn, named by its message", () => {
  it("runs a human message of the claimed thread as a turn, mention stripped", async () => {
    stored.set("m1", {
      threadId: "t1",
      authorKind: "user",
      text: "@[Liaison](agent:a-1) Create a file named hello.txt",
    })
    const detach = attachLocalTurns(handleFor("t1"), "t1")
    ask("m1")
    await settle()
    expect(shell.startTurn).toHaveBeenCalledWith("Create a file named hello.txt")
    detach()
  })

  it("posts the turn's final text back as the agent's reply in that thread", async () => {
    const detach = attachLocalTurns(handleFor("t1"), "t1")
    ask("m1")
    await settle()
    shell.emit({
      type: "message",
      event: "result",
      payload: { result: "Created hello.txt in the folder." },
    })
    shell.emit({ type: "turn_done" })
    await settle()
    const reply = calls.find((call) => call.url.endsWith("/reply"))
    expect(reply?.url).toBe(
      "https://acme.example.com/api/agents/agent-1/local-sessions/sess-1/reply",
    )
    // The reply names the machine that holds the claim: the server posts as the
    // agent for that machine and for no other.
    expect(reply?.body).toMatchObject({
      threadId: "t1",
      text: "Created hello.txt in the folder.",
      holderKey: "holder-1",
    })
    detach()
  })

  // A7: a message asked in a reply thread is answered in that reply thread,
  // named by the server's copy of the message, never by the page.
  it("posts the answer into the reply thread the message was asked in", async () => {
    stored.set("m1", {
      threadId: "t1",
      authorKind: "user",
      text: "make it",
      replyRootId: "root-1",
    })
    const detach = attachLocalTurns(handleFor("t1"), "t1")
    ask("m1")
    await settle()
    shell.emit({ type: "message", event: "result", payload: { result: "Done." } })
    shell.emit({ type: "turn_done" })
    await settle()
    expect(calls.find((call) => call.url.endsWith("/reply"))?.body).toMatchObject({
      threadId: "t1",
      text: "Done.",
      replyRootId: "root-1",
    })
    detach()
  })

  it("posts a channel message's answer to the channel, naming no reply thread", async () => {
    const detach = attachLocalTurns(handleFor("t1"), "t1")
    ask("m1")
    await settle()
    shell.emit({ type: "message", event: "result", payload: { result: "Done." } })
    shell.emit({ type: "turn_done" })
    await settle()
    const body = calls.find((call) => call.url.endsWith("/reply"))?.body ?? {}
    expect("replyRootId" in body).toBe(false)
    detach()
  })

  // P6d-FX2 (SK-3): an `error` line was read as the end of the turn, and the
  // sidecar emits `error` lines that are about something else entirely. The
  // partial text that had arrived went into the conversation as the agent's
  // finished reply, while the real turn kept running.
  it("an error line mid turn posts nothing, and the real end of the turn still does", async () => {
    const detach = attachLocalTurns(handleFor("t1"), "t1")
    ask("m1")
    await settle()
    shell.emit({
      type: "message",
      event: "text",
      payload: { message: { content: [{ type: "text", text: "Half an answer" }] } },
    })
    shell.emit({ type: "error", message: "the mode could not be changed" })
    await settle()
    expect(calls.find((call) => call.url.endsWith("/reply"))).toBeUndefined()

    shell.emit({
      type: "message",
      event: "result",
      payload: { result: "The whole answer." },
    })
    shell.emit({ type: "turn_done" })
    await settle()
    // Every text of the turn, as a cloud turn's text accumulates every step's.
    expect(calls.find((call) => call.url.endsWith("/reply"))?.body).toMatchObject({
      threadId: "t1",
      text: "Half an answer\n\nThe whole answer.",
      holderKey: "holder-1",
    })
    detach()
  })

  // 2026-09-24: a turn run with no Claude sign-in on this computer. The CLI's
  // "Not logged in, run /login" was posted to the conversation as the agent's
  // answer. It is a failed turn now, reported so the window offers a sign-in.
  it("a turn that could not authenticate posts nothing and is reported as failed", async () => {
    const failures: Array<{ messageId: string; reason: string; kind?: string }> = []
    const detach = attachLocalTurns(handleFor("t1"), "t1", (messageId, reason, kind) =>
      failures.push({ messageId, reason, kind }),
    )
    ask("m1")
    await settle()
    shell.emit({
      type: "message",
      event: "text",
      payload: {
        type: "assistant",
        error: "authentication_failed",
        message: {
          content: [
            {
              type: "text",
              text: "Failed to authenticate: OAuth session expired and could not be refreshed",
            },
          ],
        },
      },
    })
    shell.emit({
      type: "message",
      event: "result",
      payload: {
        type: "result",
        is_error: true,
        result: "Failed to authenticate: OAuth session expired and could not be refreshed",
      },
    })
    shell.emit({ type: "turn_done" })
    await settle()
    expect(calls.find((call) => call.url.endsWith("/reply"))).toBeUndefined()
    expect(failures).toEqual([
      {
        messageId: "m1",
        reason: "Failed to authenticate: OAuth session expired and could not be refreshed",
        kind: "stopped",
      },
    ])
    detach()
  })

  it("an answer that merely mentions logging in is still an answer", async () => {
    const detach = attachLocalTurns(handleFor("t1"), "t1")
    ask("m1")
    await settle()
    shell.emit({
      type: "message",
      event: "result",
      payload: { type: "result", result: "The site says: Not logged in. Please run /login." },
    })
    shell.emit({ type: "turn_done" })
    await settle()
    expect(calls.find((call) => call.url.endsWith("/reply"))?.body).toMatchObject({
      text: "The site says: Not logged in. Please run /login.",
    })
    detach()
  })

  it("falls back to the assistant's own text when the result line carries none", async () => {
    const detach = attachLocalTurns(handleFor("t1"), "t1")
    ask("m1")
    await settle()
    shell.emit({
      type: "message",
      event: "text",
      payload: { message: { content: [{ type: "text", text: "Done." }] } },
    })
    shell.emit({ type: "message", event: "result", payload: {} })
    shell.emit({ type: "turn_done" })
    await settle()
    expect(calls.find((call) => call.url.endsWith("/reply"))?.body).toMatchObject({
      threadId: "t1",
      text: "Done.",
      holderKey: "holder-1",
    })
    detach()
  })

  it("ignores the agent's own reply, which would run the turn on its own output", async () => {
    stored.set("m2", { threadId: "t1", authorKind: "agent", text: "Created hello.txt" })
    const detach = attachLocalTurns(handleFor("t1"), "t1")
    ask("m2")
    await settle()
    expect(shell.startTurn).not.toHaveBeenCalled()
    detach()
  })

  it("ignores a message of another conversation", async () => {
    stored.set("m3", { threadId: "t2", authorKind: "user", text: "not yours" })
    const detach = attachLocalTurns(handleFor("t1"), "t1")
    ask("m3")
    await settle()
    expect(shell.startTurn).not.toHaveBeenCalled()
    detach()
  })

  it("stops running turns once the session is detached", async () => {
    const detach = attachLocalTurns(handleFor("t1"), "t1")
    detach()
    ask("m4")
    await settle()
    expect(shell.startTurn).not.toHaveBeenCalled()
  })

  it("S59: fetchThreadMessage sends the holder key and keeps the credential", async () => {
    const credential = `${"Q".repeat(40)}_-9`
    stored.set("m1", {
      threadId: "t1",
      authorKind: "user",
      text: "list my sessions",
      turnCredential: credential,
    })
    const detach = attachLocalTurns(handleFor("t1"), "t1")
    ask("m1")
    await settle()
    const read = calls.find((call) => call.url.includes("/messages/m1"))
    expect(read?.url).toBe(
      "https://acme.example.com/api/agents/agent-1/local-claims/t1/messages/m1?holderKey=holder-1",
    )
    // The turn that answers this message, and only it, carries the credential.
    expect(shell.startTurn).toHaveBeenCalledWith("list my sessions", credential)
    detach()
  })

  it("S59: a message read that returns no credential starts the turn without one", async () => {
    stored.set("m1", { threadId: "t1", authorKind: "user", text: "hello" })
    const detach = attachLocalTurns(handleFor("t1"), "t1")
    ask("m1")
    await settle()
    expect(shell.startTurn.mock.calls).toEqual([["hello"]])
    detach()
  })

  // AN ID IS NOT A SOURCE. The bridge is on the window, so anything that can
  // run a script in apps/web can call it, and text taken from the caller would
  // run as a prompt on the user's own Claude Code login, in whatever permission
  // mode the session is in. What runs is what the conversation holds.
  it("runs the message the server has, whoever asked for the turn", async () => {
    stored.set("m1", { threadId: "t1", authorKind: "user", text: "the real question" })
    const detach = attachLocalTurns(handleFor("t1"), "t1")
    ask("m1")
    await settle()
    expect(shell.startTurn).toHaveBeenCalledWith("the real question")
    detach()
  })

  it("runs nothing for an id the conversation does not have", async () => {
    const detach = attachLocalTurns(handleFor("t1"), "t1")
    ask("forged")
    await settle()
    expect(shell.startTurn).not.toHaveBeenCalled()
    detach()
  })

  it("runs nothing for a message that belongs to another conversation", async () => {
    stored.set("m9", { threadId: "t2", authorKind: "user", text: "somebody else's message" })
    const detach = attachLocalTurns(handleFor("t1"), "t1")
    ask("m9")
    await settle()
    expect(shell.startTurn).not.toHaveBeenCalled()
    detach()
  })

  it("runs nothing for a message the room itself wrote", async () => {
    stored.set("m8", { threadId: "t1", authorKind: "system", text: "Liaison joined the room" })
    const detach = attachLocalTurns(handleFor("t1"), "t1")
    ask("m8")
    await settle()
    expect(shell.startTurn).not.toHaveBeenCalled()
    detach()
  })
})

/** Every reply post so far. */
const replies = () => calls.filter((call) => call.url.endsWith("/reply"))

/** One SDK assistant line, as the sidecar forwards it. */
function assistant(id: string, content: unknown[], usage?: Record<string, number>) {
  shell.emit({
    type: "message",
    event: "text",
    payload: { type: "assistant", message: { id, content, ...(usage ? { usage } : {}) } },
  })
}

function toolResult(toolUseId: string, content: unknown, isError = false) {
  shell.emit({
    type: "message",
    event: "tool_result",
    payload: {
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }],
      },
    },
  })
}

function finish(result: string) {
  shell.emit({
    type: "message",
    event: "result",
    payload: {
      type: "result",
      subtype: "success",
      result,
      num_turns: 3,
      usage: { input_tokens: 10, output_tokens: 40, cache_read_input_tokens: 900 },
    },
  })
  shell.emit({ type: "turn_done" })
}

// 2026-09-23, production (thread 1abf0d03, the Data agent on "This machine"):
// the turn ran to "Verdict : GREEN" and its answer never reached the thread.
describe("a local turn's answer always reaches the conversation", () => {
  it("a done line from the PREVIOUS sidecar does not end this turn early", async () => {
    const detach = attachLocalTurns(handleFor("t1"), "t1")
    ask("m1")
    await settle()
    // The child the handover replaced answers its shutdown line with `done`.
    shell.emit({ type: "done" })
    await settle()
    assistant("a1", [{ type: "text", text: "Verdict : GREEN" }])
    finish("Verdict : GREEN")
    await vi.waitFor(() => expect(replies()).toHaveLength(1))
    expect(replies()[0]?.body?.text).toBe("Verdict : GREEN")
    detach()
  })

  it("a server error is retried and the answer lands", async () => {
    replyStatuses.push(502, 0)
    const detach = attachLocalTurns(handleFor("t1"), "t1")
    ask("m1")
    await settle()
    finish("The answer.")
    await vi.waitFor(() => expect(replies()).toHaveLength(3))
    expect(undeliveredReplyFor("m1")).toBeNull()
    detach()
  })

  it("a conversation whose claim lapsed is taken back and the answer posted", async () => {
    replyStatuses.push(409)
    const handle = handleFor("t1")
    const reclaim = vi.fn(async () => true)
    const detach = attachLocalTurns({ ...handle, reclaim }, "t1")
    ask("m1")
    await settle()
    finish("The answer.")
    await vi.waitFor(() => expect(replies()).toHaveLength(2))
    expect(reclaim).toHaveBeenCalledTimes(1)
    detach()
  })

  it("a body the server finds too large is posted again without the calls", async () => {
    replyStatuses.push(413)
    const detach = attachLocalTurns(handleFor("t1"), "t1")
    ask("m1")
    await settle()
    assistant("a1", [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } }])
    toolResult("tu1", "a.txt")
    finish("The answer.")
    await vi.waitFor(() => expect(replies()).toHaveLength(2))
    expect(replies()[0]?.body?.turn).toMatchObject({ toolCalls: [{ toolCallId: "tu1" }] })
    expect(replies()[1]?.body).toMatchObject({ text: "The answer.", turn: { toolCalls: [] } })
    detach()
  })

  it("a refusal no retry fixes is said on the conversation, and the answer is kept", async () => {
    replyStatuses.push(403)
    const failures: Array<{ messageId: string; reason: string; kind?: string }> = []
    const detach = attachLocalTurns(handleFor("t1"), "t1", (messageId, reason, kind) =>
      failures.push({ messageId, reason, kind }),
    )
    ask("m1")
    await settle()
    finish("The answer that cost ten minutes.")
    await vi.waitFor(() => expect(failures).toHaveLength(1))
    expect(failures[0]).toMatchObject({ messageId: "m1", kind: "undelivered" })
    expect(failures[0]?.reason).toContain("403")
    expect(replies()).toHaveLength(1)
    expect(undeliveredReplyFor("m1")?.text).toBe("The answer that cost ten minutes.")
    detach()
  })

  it("Retry posts the kept answer and does not run the turn again", async () => {
    replyStatuses.push(403)
    const delivered: string[] = []
    const detach = attachLocalTurns(
      handleFor("t1"),
      "t1",
      () => undefined,
      (messageId) => delivered.push(messageId),
    )
    ask("m1")
    await settle()
    finish("Kept answer.")
    await vi.waitFor(() => expect(undeliveredReplyFor("m1")).not.toBeNull())
    shell.startTurn.mockClear()
    await submitLocalTurn("m1")
    expect(shell.startTurn).not.toHaveBeenCalled()
    expect(replies()).toHaveLength(2)
    expect(replies()[1]?.body?.text).toBe("Kept answer.")
    expect(delivered).toEqual(["m1"])
    expect(undeliveredReplyFor("m1")).toBeNull()
    detach()
  })

  it("an answer kept by an earlier session is posted when the conversation is attached again", async () => {
    replyStatuses.push(403)
    const first = attachLocalTurns(handleFor("t1"), "t1")
    ask("m1")
    await settle()
    finish("Answer from before the relaunch.")
    await vi.waitFor(() => expect(undeliveredReplyFor("m1")).not.toBeNull())
    first()
    // A new session (a relaunch, or the Local runtime chosen again).
    const second = attachLocalTurns(handleFor("t1"), "t1")
    await vi.waitFor(() => expect(replies()).toHaveLength(2))
    expect(replies()[1]?.body?.text).toBe("Answer from before the relaunch.")
    expect(undeliveredReplyFor("m1")).toBeNull()
    second()
  })
})

describe("a local turn is stored the way a cloud turn is", () => {
  it("posts the tool calls, the timeline and the usage with the answer", async () => {
    const detach = attachLocalTurns(handleFor("t1"), "t1")
    ask("m1")
    await settle()
    assistant(
      "a1",
      [
        { type: "thinking", thinking: "Find the hub first." },
        {
          type: "tool_use",
          id: "tu1",
          name: "mcp__liaison__kpi__kpi_list_hubs",
          input: { query: "Havre" },
        },
      ],
      { input_tokens: 5, cache_read_input_tokens: 20_000, output_tokens: 30 },
    )
    toolResult("tu1", [{ type: "text", text: "Passage du Havre (hub 42)" }])
    assistant("a2", [{ type: "tool_use", id: "tu2", name: "Bash", input: { command: "false" } }], {
      input_tokens: 7,
      cache_read_input_tokens: 21_000,
      output_tokens: 20,
    })
    toolResult("tu2", "exit 1", true)
    assistant("a3", [{ type: "text", text: "Verdict : GREEN" }], {
      input_tokens: 9,
      cache_read_input_tokens: 22_000,
      output_tokens: 50,
    })
    finish("Verdict : GREEN")
    await vi.waitFor(() => expect(replies()).toHaveLength(1))
    const turn = replies()[0]?.body?.turn as Record<string, unknown>
    expect(turn).toMatchObject({
      modelId: "claude-haiku-4-5",
      stepCount: 3,
      finishReason: "stop",
      reasoning: "Find the hub first.",
      usage: { lastStepInputTokens: 22_009, cachedInputTokens: 900, outputTokens: 40 },
      toolCalls: [
        {
          toolCallId: "tu1",
          // The name the server knows the tool by, not the SDK's MCP prefix.
          toolName: "kpi__kpi_list_hubs",
          args: { query: "Havre" },
          result: "Passage du Havre (hub 42)",
          status: "completed",
        },
        {
          toolCallId: "tu2",
          toolName: "Bash",
          status: "error",
          error: { message: "exit 1" },
        },
      ],
      timeline: [
        { kind: "reasoning", text: "Find the hub first." },
        { kind: "tool", toolCallId: "tu1" },
        { kind: "tool", toolCallId: "tu2" },
        { kind: "text", text: "Verdict : GREEN" },
      ],
    })
    detach()
  })

  it("records the words written between tools where they were written", async () => {
    // Haiku narrates every step: a line, a tool, a line, a tool. The thread view
    // drew every tool first and every line after (2026-09-24), because the
    // timeline had no text.
    const detach = attachLocalTurns(handleFor("t1"), "t1")
    ask("m1")
    await settle()
    assistant("a1", [
      { type: "text", text: "Je cherche le hub." },
      { type: "tool_use", id: "tu1", name: "mcp__liaison__kpi__kpi_list_hubs", input: {} },
    ])
    toolResult("tu1", "Passage du Havre")
    assistant("a2", [
      { type: "text", text: "Hub trouvé, je lance le pipeline." },
      { type: "tool_use", id: "tu2", name: "Bash", input: { command: "true" } },
    ])
    toolResult("tu2", "ok")
    assistant("a3", [{ type: "text", text: "Rapport prêt." }])
    finish("Rapport prêt.")
    await vi.waitFor(() => expect(replies()).toHaveLength(1))
    const body = replies()[0]?.body as { text: string; turn: { timeline: unknown[] } }
    expect(body.turn.timeline).toEqual([
      { kind: "text", text: "Je cherche le hub." },
      { kind: "tool", toolCallId: "tu1" },
      { kind: "text", text: "Hub trouvé, je lance le pipeline." },
      { kind: "tool", toolCallId: "tu2" },
      { kind: "text", text: "Rapport prêt." },
    ])
    expect(body.text).toBe(
      "Je cherche le hub.\n\nHub trouvé, je lance le pipeline.\n\nRapport prêt.",
    )
    detach()
  })

  it("puts a result that never came as a block at the end of the timeline", async () => {
    const detach = attachLocalTurns(handleFor("t1"), "t1")
    ask("m1")
    await settle()
    assistant("a1", [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "true" } }])
    toolResult("tu1", "ok")
    finish("Terminé.")
    await vi.waitFor(() => expect(replies()).toHaveLength(1))
    const body = replies()[0]?.body as { text: string; turn: { timeline: unknown[] } }
    expect(body.text).toBe("Terminé.")
    expect(body.turn.timeline).toEqual([
      { kind: "tool", toolCallId: "tu1" },
      { kind: "text", text: "Terminé." },
    ])
    detach()
  })

  it("names the Claude Code session that ran it, for the next start's resume decision", async () => {
    const detach = attachLocalTurns({ ...handleFor("t1"), sdkSessionId: () => "sdk-9" }, "t1")
    ask("m1")
    await settle()
    finish("Done.")
    await vi.waitFor(() => expect(replies()).toHaveLength(1))
    expect(replies()[0]?.body?.turn).toMatchObject({ sdkSessionId: "sdk-9" })
    detach()
  })

  it("never lets a bearer, a JWT or a capability token leave the machine", async () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.c2lnbmF0dXJlLXZhbHVl"
    const detach = attachLocalTurns(handleFor("t1"), "t1")
    ask("m1")
    await settle()
    assistant("a1", [
      {
        type: "tool_use",
        id: "tu1",
        name: "Bash",
        input: {
          command: `curl -H "Authorization: Bearer ${jwt}" "https://x.example/toolkit?token=cap_9f8e7d6c5b4a&v=1"`,
          apiKey: "plain-secret-value",
        },
      },
    ])
    toolResult("tu1", `{"access_token":"${jwt}","ok":true}`)
    finish("Done.")
    await vi.waitFor(() => expect(replies()).toHaveLength(1))
    const serialized = JSON.stringify(replies()[0]?.body?.turn)
    expect(serialized).not.toContain(jwt)
    expect(serialized).not.toContain("cap_9f8e7d6c5b4a")
    expect(serialized).not.toContain("plain-secret-value")
    expect(serialized).toContain("[redacted]")
    detach()
  })
})
