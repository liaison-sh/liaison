// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mapPermissionMode } from "../../sidecar/sdk-runner"
import { composeAgentDefinitionText, definitionChecksum } from "./agent-definition-client"
import { hashFolder } from "./folder-hash"
import { getSessionEntry, getSessionId, sessionIdKey, setSessionId } from "./SessionResumeStore"
import type { PermissionMode } from "./sidecar-client"
import {
  endLocalSession,
  LocalSessionStartError,
  sendTurn,
  startLocalSession,
} from "./start-local-session"

const shell = vi.hoisted(() => {
  const listeners = new Set<(event: Record<string, unknown>) => void>()
  return {
    listeners,
    emit(event: Record<string, unknown>) {
      for (const listener of Array.from(listeners)) listener(event)
    },
    startSession: vi.fn(async (_options: unknown) => undefined),
    startTurn: vi.fn(async (_prompt: string) => undefined),
    stopSession: vi.fn(async () => undefined),
    reportConversationLost: vi.fn(() => undefined),
  }
})

vi.mock("./sidecar-client", () => ({
  // The shell's per install salt, fixed here so the digest the audit body
  // carries is reproducible in the assertions below.
  getInstallSalt: async () => "0".repeat(64),
  startSession: shell.startSession,
  startTurn: shell.startTurn,
  stopSession: shell.stopSession,
  // The claim tells the window when the conversation stops being its own; the
  // claim path is exercised here from P6d-FX5 on, and a module that reaches
  // for an export the mock does not have throws before the claim is made.
  reportConversationLost: shell.reportConversationLost,
  onTurnEvent: (callback: (event: Record<string, unknown>) => void) => {
    shell.listeners.add(callback)
    return () => shell.listeners.delete(callback)
  },
}))

/**
 * The definition client is spied on rather than replaced: the REAL fetch and
 * the REAL composition run against the fake route below, so the text handed to
 * the shell is the text the route's parts compose to. Only the failure cases
 * override the implementation.
 */
const fetchDefinition = vi.hoisted(() => vi.fn())
const fetchKind = vi.hoisted(() => vi.fn())

vi.mock("./agent-definition-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agent-definition-client")>()
  fetchDefinition.mockImplementation(actual.fetchAgentDefinition)
  fetchKind.mockImplementation(actual.fetchAgentKind)
  return { ...actual, fetchAgentDefinition: fetchDefinition, fetchAgentKind: fetchKind }
})

/** What the fake definition route answers with, in the route's own shape. */
const DEFINITION = {
  systemPrompt: "you are an agent",
  skillIndex: [{ name: "invoicing", description: "always de-tax an export" }],
  scopedMemory: [{ name: "n", path: "p", description: "d", line: "- p: d" }],
  mcpToolList: [{ name: "kernel__threads_list", description: "list threads" }],
}

interface RecordedCall {
  url: string
  init: RequestInit | undefined
  body: Record<string, unknown> | null
}

const calls: RecordedCall[] = []

/** What the fake turn-context route answers: warm and bare, as a server does. */
let turnContextAnswer: Record<string, unknown> = { coldResume: false }

/** The checksum of the definition the fake route serves, before any cold context. */
function currentDefinitionChecksum(): Promise<string> {
  return definitionChecksum(composeAgentDefinitionText(DEFINITION))
}

/** Only the local-session audit posts: the definition and the kind are GETs. */
function auditCalls(): RecordedCall[] {
  return calls.filter((call) => call.url.includes("/local-sessions"))
}

function mockServer(auditSessionId = "sess-1"): void {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    let body: Record<string, unknown> | null = null
    if (typeof init?.body === "string") body = JSON.parse(init.body) as Record<string, unknown>
    calls.push({ url, init, body })
    if (url.endsWith("/events")) return new Response(null, { status: 204 })
    if (url.includes("/turn-context")) {
      return new Response(JSON.stringify({ data: turnContextAnswer }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    if (/\/definition(\?|$)/.test(url)) {
      return new Response(JSON.stringify({ data: DEFINITION }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    if (url.endsWith("/api/agents")) {
      return new Response(JSON.stringify({ data: [{ id: "agent-1", kind: "role" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    return new Response(JSON.stringify({ data: { sessionId: auditSessionId } }), {
      status: 201,
      headers: { "content-type": "application/json" },
    })
  })
  vi.stubGlobal("fetch", fetchMock)
}

const OPTIONS = {
  agentId: "agent-1",
  folder: "/Users/alice/secret-project",
  mode: "manual" as PermissionMode,
  model: "local",
  serverAddress: "https://acme.example.com",
  accessToken: "tok1",
}

beforeEach(() => {
  calls.length = 0
  shell.listeners.clear()
  shell.startSession.mockClear()
  shell.startTurn.mockClear()
  shell.stopSession.mockClear()
  fetchDefinition.mockClear()
  fetchKind.mockClear()
  localStorage.clear()
  turnContextAnswer = { coldResume: false }
  mockServer()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("startLocalSession", () => {
  it("audits the start with a hashed folder, never the raw path", async () => {
    const handle = await startLocalSession(OPTIONS)
    const start = auditCalls()[0]
    expect(start?.url).toBe("https://acme.example.com/api/agents/agent-1/local-sessions")
    expect(start?.init?.method).toBe("POST")
    expect((start?.init?.headers as Record<string, string> | undefined)?.Authorization).toBe(
      "Bearer tok1",
    )
    expect(JSON.stringify(start?.body)).not.toContain("secret-project")
    expect(start?.body?.folderHash).toMatch(/^[0-9a-f]{64}$/)
    expect(start?.body?.folderHash).toBe(await hashFolder(OPTIONS.folder))
    expect(start?.body?.permissionMode).toBe("manual")
    expect(start?.body?.model).toBe("local")
    expect(handle.auditSessionId).toBe("sess-1")
  })

  it("audits the start BEFORE the sidecar session exists", async () => {
    shell.startSession.mockImplementationOnce(async () => {
      expect(auditCalls()).toHaveLength(1)
      return undefined
    })
    await startLocalSession(OPTIONS)
    expect(shell.startSession).toHaveBeenCalledTimes(1)
  })

  it("passes each Liaison permission mode through to the shell unchanged", async () => {
    for (const mode of ["auto", "manual", "edit", "plan", "bypass"] as PermissionMode[]) {
      await startLocalSession({ ...OPTIONS, mode })
    }
    expect(
      shell.startSession.mock.calls.map(
        (call) => (call[0] as { permissionMode: string }).permissionMode,
      ),
    ).toEqual(["auto", "manual", "edit", "plan", "bypass"])
  })

  it("starts the session in the chosen folder with the chosen model", async () => {
    await startLocalSession(OPTIONS)
    expect(shell.startSession.mock.calls[0]?.[0]).toMatchObject({
      agentId: "agent-1",
      cwd: "/Users/alice/secret-project",
      model: "local",
    })
  })

  it("hands the shell the fetched definition, under the one documented name", async () => {
    // This REPLACES an assertion that the definition never reached the shell.
    // It never could: the shell read one from its own environment, so the
    // session ran on a definition nobody fetched. The rule it was protecting
    // (ONE source for the prompt, never a second composed here) is the reason
    // the text is passed under `agentDefinition` and under nothing else.
    await startLocalSession(OPTIONS)
    const sent = startedWith() ?? {}
    expect(Object.keys(sent)).not.toContain("systemPrompt")
    expect(sent.agentDefinition).toBe(composeAgentDefinitionText(DEFINITION))
    expect(sent.agentDefinition).toContain("you are an agent")
    expect(sent.agentKind).toBe("role")
  })

  it("composes the route's own parts into the text the session runs with", async () => {
    await startLocalSession(OPTIONS)
    const text = String(startedWith()?.agentDefinition)
    expect(text).toContain("you are an agent")
    expect(text).toContain("always de-tax an export")
    expect(text).toContain("- p: d")
    expect(text).toContain("kernel__threads_list: list threads")
  })

  it("asks the agents route for the kind the definition route does not carry", async () => {
    await startLocalSession(OPTIONS)
    expect(fetchKind).toHaveBeenCalledTimes(1)
    expect(calls.some((call) => call.url === "https://acme.example.com/api/agents")).toBe(true)
  })

  it("treats an agent the listing does not name as a role, never as personal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.endsWith("/api/agents")) {
          return new Response(JSON.stringify({ data: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }
        if (/\/definition(\?|$)/.test(url)) {
          return new Response(JSON.stringify({ data: DEFINITION }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }
        if (typeof init?.body === "string") {
          calls.push({ url, init, body: JSON.parse(init.body) as Record<string, unknown> })
        }
        return new Response(JSON.stringify({ data: { sessionId: "sess-1" } }), {
          status: 201,
          headers: { "content-type": "application/json" },
        })
      }),
    )
    await startLocalSession(OPTIONS)
    expect(startedWith()?.agentKind).toBe("role")
  })

  it("fetches the agent definition once per start and never by runtime location", async () => {
    await startLocalSession(OPTIONS)
    expect(fetchDefinition).toHaveBeenCalledTimes(1)
    const [agentId, definitionOptions] = fetchDefinition.mock.calls[0] ?? []
    expect(agentId).toBe("agent-1")
    expect(definitionOptions).toEqual({
      serverAddress: "https://acme.example.com",
      accessToken: "tok1",
    })
    expect(Object.keys(definitionOptions as object)).not.toContain("runtimeLocation")
  })

  it("names the conversation it runs in, so the definition is bound by that room's floor", async () => {
    await startLocalSession({ ...OPTIONS, threadId: "thread-1" })
    const [, definitionOptions] = fetchDefinition.mock.calls[0] ?? []
    expect(definitionOptions).toEqual({
      serverAddress: "https://acme.example.com",
      accessToken: "tok1",
      threadId: "thread-1",
    })
  })

  it("does not start a session the account may not read a definition for", async () => {
    fetchDefinition.mockRejectedValueOnce(new Error("forbidden"))
    // P6d-FX5 (W8): it rejects with the REASON now, and carries the original
    // as its cause. The window can only say something useful about a refusal
    // it can tell apart from the other two.
    const failure = await startLocalSession(OPTIONS).catch((error: unknown) => error)
    expect((failure as LocalSessionStartError).reason).toBe("AgentDefinitionRefused")
    expect((failure as Error).cause).toBeInstanceOf(Error)
    expect(shell.startSession).not.toHaveBeenCalled()
    expect(auditCalls()).toHaveLength(0)
  })

  it("rejects when the audit start is refused, rather than running unaudited", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: {} }), { status: 403 })),
    )
    await expect(startLocalSession(OPTIONS)).rejects.toThrow()
    expect(shell.startSession).not.toHaveBeenCalled()
  })
})

// P6d-FX7 (SK-2): starting a session for ANOTHER conversation releases this
// one's claim without tearing the session down, and puts it back when the new
// start is refused. The two halves are one handle, so they are pinned here.
describe("handing the conversation over without ending the session", () => {
  const claimCalls = () => calls.filter((call) => call.url.includes("/local-claims"))

  it("releases the claim on the server and keeps the session's own handle", async () => {
    const handle = await startLocalSession({
      ...OPTIONS,
      threadId: "thread-1",
      holderKey: "this-window",
    })
    await handle.releaseClaim()
    const released = claimCalls().filter((call) => call.init?.method === "DELETE")
    expect(released).toHaveLength(1)
    expect(released[0]?.url).toContain("holderKey=this-window")
    // The sidecar was never asked to stop: the session is still running.
    expect(shell.stopSession).not.toHaveBeenCalled()
  })

  it("takes the conversation back under the SAME holder key when the handover is refused", async () => {
    const handle = await startLocalSession({
      ...OPTIONS,
      threadId: "thread-1",
      holderKey: "this-window",
    })
    await handle.releaseClaim()
    await expect(handle.reclaim()).resolves.toBe(true)
    const registered = claimCalls().filter((call) => call.init?.method === "POST")
    expect(registered).toHaveLength(2)
    // The same key, so the server reads the second registration as the renewal
    // it is rather than as a second window arguing over one conversation.
    expect(registered[1]?.body).toMatchObject({ threadId: "thread-1", holderKey: "this-window" })
  })
})

describe("the sidecar's permission mode table", () => {
  // Pinned from HERE as well as from the sidecar's own tests: the mapping is
  // the one place a Liaison mode becomes an SDK mode, and a drift in either
  // half of the pair (this module passing a mode through, the sidecar mapping
  // it) is invisible to a test that only reads one of them.
  it("maps the five Liaison modes onto the SDK values", () => {
    expect(mapPermissionMode("auto")).toBe("acceptEdits")
    expect(mapPermissionMode("manual")).toBe("default")
    expect(mapPermissionMode("edit")).toBe("acceptEdits")
    expect(mapPermissionMode("plan")).toBe("plan")
    expect(mapPermissionMode("bypass")).toBe("bypassPermissions")
  })
})

describe("sendTurn", () => {
  async function sha256Hex(text: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
  }

  it("sends the user message to the running session", async () => {
    const handle = await startLocalSession(OPTIONS)
    shell.emit({ type: "ready", sidecarReadyMs: 5, systemPromptChecksum: "a".repeat(64) })
    await sendTurn(handle, "what changed here")
    expect(shell.startTurn).toHaveBeenCalledWith("what changed here")
  })

  it("audits every turn with the checksum of the definition the session runs with", async () => {
    // The checksum is the SIDECAR's, of the definition it was handed: the fake
    // emits sha256 of exactly the text `start_session` received, so the
    // assertion below (it equals sha256 of the composed route response) fails
    // the moment the window's fetched definition stops being what runs.
    const checksum = await sha256Hex(composeAgentDefinitionText(DEFINITION))
    const handle = await startLocalSession(OPTIONS)
    expect(await sha256Hex(String(startedWith()?.agentDefinition))).toBe(checksum)
    shell.emit({ type: "ready", sidecarReadyMs: 5, systemPromptChecksum: checksum })
    await sendTurn(handle, "one")
    await sendTurn(handle, "two")
    await sendTurn(handle, "three")
    const turns = calls.filter((call) => call.url.endsWith("/events"))
    expect(turns).toHaveLength(3)
    expect(turns.map((call) => call.body?.kind)).toEqual(["turn", "turn", "turn"])
    expect(turns.map((call) => call.body?.promptChecksum)).toEqual([checksum, checksum, checksum])
    expect(turns[0]?.url).toBe(
      "https://acme.example.com/api/agents/agent-1/local-sessions/sess-1/events",
    )
  })

  it("never posts a turn carrying the folder path", async () => {
    const handle = await startLocalSession(OPTIONS)
    shell.emit({ type: "ready", sidecarReadyMs: 5, systemPromptChecksum: "b".repeat(64) })
    await sendTurn(handle, "read /Users/alice/secret-project/plan.md")
    for (const call of calls) {
      expect(JSON.stringify(call.body)).not.toContain("secret-project")
    }
  })

  // The prompt is already running when the turn row is posted: a row the
  // server did not take used to reject `sendTurn`, and the caller then never
  // posted the answer the turn went on to give.
  it("a turn row the server did not take does not fail the turn", async () => {
    const handle = await startLocalSession({ ...OPTIONS, threadId: "thread-1" })
    shell.emit({ type: "ready", sidecarReadyMs: 5, systemPromptChecksum: "a".repeat(64) })
    const real = globalThis.fetch
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith("/events")) throw new TypeError("Load failed")
        return real(input, init)
      }),
    )
    await expect(sendTurn(handle, "hello")).resolves.toBeUndefined()
    expect(shell.startTurn).toHaveBeenCalledWith("hello")
  })

  it("names the conversation on the turn row, for the server's between-turns upkeep", async () => {
    const handle = await startLocalSession({ ...OPTIONS, threadId: "thread-1" })
    shell.emit({ type: "ready", sidecarReadyMs: 5, systemPromptChecksum: "a".repeat(64) })
    await sendTurn(handle, "hello")
    const turn = calls.find((call) => call.url.endsWith("/events") && call.body?.kind === "turn")
    expect(turn?.body?.threadId).toBe("thread-1")
  })

  it("still audits the turn when the sidecar reported no checksum", async () => {
    const handle = await startLocalSession(OPTIONS)
    shell.emit({ type: "ready", sidecarReadyMs: 5, systemPromptChecksum: null })
    await sendTurn(handle, "one")
    const turn = calls.filter((call) => call.url.endsWith("/events"))[0]
    expect(turn?.body?.kind).toBe("turn")
    expect(turn?.body).not.toHaveProperty("promptChecksum")
  })
})

function startedWith(index = 0): Record<string, unknown> | undefined {
  return shell.startSession.mock.calls[index]?.[0] as Record<string, unknown> | undefined
}

describe("session resume", () => {
  it("starts fresh when the agent has never worked in this folder", async () => {
    await startLocalSession(OPTIONS)
    expect(startedWith()?.resumeSessionId).toBe(null)
    expect(auditCalls()[0]?.body).not.toHaveProperty("resumeSessionId")
  })

  it("resumes the stored session id for a known agent and folder", async () => {
    const folderHash = await hashFolder(OPTIONS.folder)
    setSessionId(OPTIONS.agentId, folderHash, "claude-session-7", await currentDefinitionChecksum())
    await startLocalSession(OPTIONS)
    expect(startedWith()?.resumeSessionId).toBe("claude-session-7")
    expect(auditCalls()[0]?.body?.resumeSessionId).toBe("claude-session-7")
  })

  it("stores the session id the sidecar announces after a fresh start", async () => {
    const folderHash = await hashFolder(OPTIONS.folder)
    await startLocalSession(OPTIONS)
    expect(getSessionId(OPTIONS.agentId, folderHash)).toBeNull()
    shell.emit({ type: "session", sessionId: "claude-session-9" })
    expect(getSessionId(OPTIONS.agentId, folderHash)).toBe("claude-session-9")
  })

  it("keeps another agent's session in the same folder out of this one", async () => {
    const folderHash = await hashFolder(OPTIONS.folder)
    setSessionId("agent-other", folderHash, "not-mine")
    await startLocalSession(OPTIONS)
    expect(startedWith()?.resumeSessionId).toBe(null)
  })

  // P4c-T23: the same cold decision the server's turn start makes.
  it("a warm local turn resumes the same SDK session id, a cold one starts a new session", async () => {
    const folderHash = await hashFolder(OPTIONS.folder)
    setSessionId(OPTIONS.agentId, folderHash, "claude-session-7", await currentDefinitionChecksum())

    await startLocalSession({ ...OPTIONS, coldResume: false })
    expect(startedWith()?.resumeSessionId).toBe("claude-session-7")
    expect(auditCalls()[0]?.body?.resumeSessionId).toBe("claude-session-7")

    calls.length = 0
    shell.startSession.mockClear()

    await startLocalSession({ ...OPTIONS, coldResume: true })
    expect(startedWith()?.resumeSessionId).toBe(null)
    expect(auditCalls()[0]?.body).not.toHaveProperty("resumeSessionId")
    // The stored id is not forgotten by the decision itself: the sidecar's own
    // `session` line replaces it once the new session names itself.
    expect(getSessionId(OPTIONS.agentId, folderHash)).toBe("claude-session-7")
  })

  // P4c-T26b: a fresh SDK session that is told nothing starts from nothing,
  // which is strictly worse than the stale transcript T26 stopped resuming. The
  // server assembles the same context a cloud turn gets, and it reaches the
  // session through the ONE channel the SDK gives a new session: the system
  // prompt append the shell already composes and hands to `start_session`.
  it("a cold session is primed with the checkpoint and the tail", async () => {
    const folderHash = await hashFolder(OPTIONS.folder)
    setSessionId(OPTIONS.agentId, folderHash, "claude-session-7")

    await startLocalSession({
      ...OPTIONS,
      coldResume: true,
      coldContext: {
        checkpoint: { summary: "The Lyon shipment was split into two cartons." },
        tail: [
          {
            id: "m1",
            authorType: "user",
            authorName: "Alice Chen",
            createdAt: "2026-09-15T09:00:00.000Z",
            content: "Did the second carton ever leave?",
            toolNames: [],
          },
          {
            id: "m2",
            authorType: "agent",
            authorName: "Replier",
            createdAt: "2026-09-15T09:01:00.000Z",
            content: "It shipped on the Tuesday pickup.",
            toolNames: ["boxtal__track"],
          },
        ],
        recall: "<recalled-memory>\n- the Lyon carton ladder\n</recalled-memory>",
        resumeLine: "Resumed after 3 hours. Earlier messages are summarized above;",
      },
    })

    // The fresh session: nothing to resume, by the same rule T23 made.
    expect(startedWith()?.resumeSessionId).toBe(null)

    const prompt = String(startedWith()?.agentDefinition ?? "")
    // The definition is still all of itself: the cold context is ADDED, never
    // substituted for the agent the session is supposed to be.
    expect(prompt).toContain("you are an agent")
    // The checkpoint.
    expect(prompt).toContain("The Lyon shipment was split into two cartons.")
    // Both tail rows, verbatim, with who said them and when.
    expect(prompt).toContain("Did the second carton ever leave?")
    expect(prompt).toContain("It shipped on the Tuesday pickup.")
    expect(prompt).toContain("Alice Chen (user)")
    expect(prompt).toContain("2026-09-15T09:01:00.000Z")
    expect(prompt).toContain("[tools called: boxtal__track]")
    // The recall and the resume line, which the cloud turn also carries.
    expect(prompt).toContain("the Lyon carton ladder")
    expect(prompt).toContain("Resumed after 3 hours.")
    // And it is framed as a record rather than as an instruction.
    expect(prompt).toContain("<cold-resume")
    expect(prompt).toContain("</cold-resume>")
  })

  // A warm turn carries none of it: the SDK session it resumes already holds
  // the transcript, and a second copy in the system prompt is the same
  // conversation told twice.
  it("a warm session is not primed with any cold context", async () => {
    const folderHash = await hashFolder(OPTIONS.folder)
    setSessionId(OPTIONS.agentId, folderHash, "claude-session-7", await currentDefinitionChecksum())
    await startLocalSession({ ...OPTIONS, coldResume: false, coldContext: null })
    expect(startedWith()?.resumeSessionId).toBe("claude-session-7")
    expect(String(startedWith()?.agentDefinition ?? "")).not.toContain("<cold-resume")
  })
})

// 2026-09-23: an org fixed its agent's definition after a wrong computed
// figure, and the desktop resumed the session holding that answer. The new
// definition reached the resumed session as its system prompt, and the old
// transcript still won about one run in three. A session is resumed only under
// the definition it was created with.
describe("a changed agent definition starts a new session", () => {
  const WARM_CONTEXT = {
    coldResume: false,
    fresh: true,
    checkpoint: { summary: "The team asked for the September basket size." },
    tail: [
      {
        id: "m1",
        authorType: "user",
        authorName: "Alice Chen",
        createdAt: "2026-09-23T09:00:00.000Z",
        content: "What was the average basket in September?",
        toolNames: [],
      },
      {
        id: "m2",
        authorType: "agent",
        authorName: "Data",
        createdAt: "2026-09-23T09:01:00.000Z",
        content: "About 41 euros.",
        toolNames: ["kpi__kpi_run"],
      },
    ],
    recall: null,
    resumeLine: null,
  }

  const turnContextCalls = () => calls.filter((call) => call.url.includes("/turn-context"))

  it("starts fresh, fed the conversation's context, when the definition changed", async () => {
    const folderHash = await hashFolder(OPTIONS.folder)
    setSessionId(OPTIONS.agentId, folderHash, "claude-session-7", "e".repeat(64))
    turnContextAnswer = WARM_CONTEXT

    const handle = await startLocalSession({ ...OPTIONS, threadId: "thread-1" })

    expect(startedWith()?.resumeSessionId).toBe(null)
    expect(auditCalls()[0]?.body).not.toHaveProperty("resumeSessionId")
    expect(auditCalls()[0]?.body?.freshReason).toBe("definition_changed")
    expect(handle.freshReason).toBe("definition_changed")
    // The context is asked for even though the turn is warm.
    expect(turnContextCalls()).toHaveLength(1)
    expect(turnContextCalls()[0]?.url).toBe(
      "https://acme.example.com/api/agents/agent-1/local-claims/thread-1/turn-context?fresh=1",
    )
    const prompt = String(startedWith()?.agentDefinition ?? "")
    expect(prompt.startsWith(composeAgentDefinitionText(DEFINITION))).toBe(true)
    expect(prompt).toContain("The team asked for the September basket size.")
    expect(prompt).toContain("What was the average basket in September?")
    expect(prompt).toContain("<cold-resume")
    // The frame says the definition changed and which one wins.
    expect(prompt).toContain("definition changed")
    expect(prompt).toContain("the definition above wins")
    await handle.finish()
  })

  // 2026-09-23: a conversation continued in Liaison (or on another computer)
  // after this computer's last session in it. Resuming the stored transcript
  // hid those turns from the agent; the server's record has them.
  it("does not resume a session that did not write the conversation's last agent turn", async () => {
    const folderHash = await hashFolder(OPTIONS.folder)
    setSessionId(OPTIONS.agentId, folderHash, "claude-session-7", await currentDefinitionChecksum())
    turnContextAnswer = WARM_CONTEXT

    const handle = await startLocalSession({
      ...OPTIONS,
      threadId: "thread-1",
      lastAgentTurn: { runLocation: "cloud", sdkSessionId: null },
    })

    expect(startedWith()?.resumeSessionId).toBe(null)
    expect(turnContextCalls()[0]?.url).toContain("turn-context?fresh=1")
    const prompt = String(startedWith()?.agentDefinition ?? "")
    expect(prompt).toContain("What was the average basket in September?")
    expect(prompt).toContain("continued elsewhere")
    await handle.finish()
  })

  it("resumes the session that wrote the conversation's last agent turn", async () => {
    const folderHash = await hashFolder(OPTIONS.folder)
    setSessionId(OPTIONS.agentId, folderHash, "claude-session-7", await currentDefinitionChecksum())

    const handle = await startLocalSession({
      ...OPTIONS,
      threadId: "thread-1",
      lastAgentTurn: { runLocation: "local", sdkSessionId: "claude-session-7" },
    })

    expect(startedWith()?.resumeSessionId).toBe("claude-session-7")
    expect(turnContextCalls()).toHaveLength(0)
    expect(handle.sdkSessionId?.()).toBe("claude-session-7")
    shell.emit({ type: "session", sessionId: "claude-session-7b" })
    expect(handle.sdkSessionId?.()).toBe("claude-session-7b")
    await handle.finish()
  })

  it("a first session on this computer is fed what the conversation already holds", async () => {
    turnContextAnswer = WARM_CONTEXT

    const handle = await startLocalSession({
      ...OPTIONS,
      threadId: "thread-1",
      lastAgentTurn: { runLocation: "cloud", sdkSessionId: null },
    })

    expect(startedWith()?.resumeSessionId).toBe(null)
    const prompt = String(startedWith()?.agentDefinition ?? "")
    expect(prompt).toContain("The team asked for the September basket size.")
    expect(prompt).toContain("new to this conversation")
    await handle.finish()
  })

  it("resumes when the definition is the one the session was created with", async () => {
    const folderHash = await hashFolder(OPTIONS.folder)
    setSessionId(OPTIONS.agentId, folderHash, "claude-session-7", await currentDefinitionChecksum())
    turnContextAnswer = WARM_CONTEXT

    const handle = await startLocalSession({ ...OPTIONS, threadId: "thread-1" })

    expect(startedWith()?.resumeSessionId).toBe("claude-session-7")
    expect(auditCalls()[0]?.body?.resumeSessionId).toBe("claude-session-7")
    expect(auditCalls()[0]?.body).not.toHaveProperty("freshReason")
    expect(handle.freshReason).toBe(null)
    expect(turnContextCalls()).toHaveLength(0)
    expect(String(startedWith()?.agentDefinition ?? "")).not.toContain("<cold-resume")
    await handle.finish()
  })

  it("starts a session stored before checksums fresh once, then resumes it", async () => {
    const folderHash = await hashFolder(OPTIONS.folder)
    // What every desktop before this change wrote: the bare id.
    localStorage.setItem(sessionIdKey(OPTIONS.agentId, folderHash), "claude-session-legacy")
    turnContextAnswer = WARM_CONTEXT

    const first = await startLocalSession({ ...OPTIONS, threadId: "thread-1" })
    expect(startedWith()?.resumeSessionId).toBe(null)
    expect(auditCalls()[0]?.body?.freshReason).toBe("definition_unknown")
    expect(first.freshReason).toBe("definition_unknown")
    expect(String(startedWith()?.agentDefinition ?? "")).toContain(
      "What was the average basket in September?",
    )
    shell.emit({ type: "session", sessionId: "claude-session-new" })
    expect(getSessionEntry(OPTIONS.agentId, folderHash)).toEqual({
      sessionId: "claude-session-new",
      definitionChecksum: await currentDefinitionChecksum(),
    })
    await first.finish()

    calls.length = 0
    shell.startSession.mockClear()
    const second = await startLocalSession({ ...OPTIONS, threadId: "thread-1" })
    expect(startedWith()?.resumeSessionId).toBe("claude-session-new")
    expect(second.freshReason).toBe(null)
    await second.finish()
  })

  it("stores the definition's checksum, never the cold context's, so a cold start resumes next time", async () => {
    const folderHash = await hashFolder(OPTIONS.folder)
    setSessionId(OPTIONS.agentId, folderHash, "claude-session-7", await currentDefinitionChecksum())
    const cold = await startLocalSession({
      ...OPTIONS,
      coldResume: true,
      coldContext: {
        checkpoint: { summary: "An earlier summary." },
        tail: [],
        recall: null,
        resumeLine: null,
      },
    })
    expect(auditCalls()[0]?.body?.freshReason).toBe("cold_resume")
    expect(cold.freshReason).toBe("cold_resume")
    shell.emit({ type: "session", sessionId: "claude-session-8" })
    expect(getSessionEntry(OPTIONS.agentId, folderHash)?.definitionChecksum).toBe(
      await currentDefinitionChecksum(),
    )
    await cold.finish()

    shell.startSession.mockClear()
    await startLocalSession(OPTIONS)
    expect(startedWith()?.resumeSessionId).toBe("claude-session-8")
  })

  it("the stored checksum is the one every warm turn is audited with", async () => {
    // The sidecar audits sha256 of the text `start_session` received; on a
    // warm start that text is the composed definition, so the two agree.
    await startLocalSession(OPTIONS)
    const sent = String(startedWith()?.agentDefinition ?? "")
    expect(await definitionChecksum(sent)).toBe(await currentDefinitionChecksum())
  })

  it("still starts fresh against a server that cannot hand the context over", async () => {
    const folderHash = await hashFolder(OPTIONS.folder)
    setSessionId(OPTIONS.agentId, folderHash, "claude-session-7", "e".repeat(64))
    // An older server: the flag is ignored and the warm answer is bare.
    turnContextAnswer = { coldResume: false }
    const handle = await startLocalSession({ ...OPTIONS, threadId: "thread-1" })
    expect(startedWith()?.resumeSessionId).toBe(null)
    expect(auditCalls()[0]?.body?.freshReason).toBe("definition_changed")
    expect(String(startedWith()?.agentDefinition ?? "")).toBe(
      composeAgentDefinitionText(DEFINITION),
    )
    await handle.finish()
  })
})

describe("session end", () => {
  const endEvents = () =>
    calls.filter((call) => call.url.endsWith("/events") && call.body?.kind === "end")

  it("audits the end when the session's sidecar exits", async () => {
    await startLocalSession(OPTIONS)
    shell.emit({ type: "done" })
    shell.emit({
      type: "sidecar_exited",
      code: 0,
      signal: null,
      booted: true,
      reason: "it exited",
      stderrTail: [],
    })
    await vi.waitFor(() => expect(endEvents()).toHaveLength(1))
    expect(endEvents()[0]?.url).toBe(
      "https://acme.example.com/api/agents/agent-1/local-sessions/sess-1/events",
    )
  })

  // The session outlives the fifteen minute access token; a captured token
  // made the end audit (and every reply and re-read) a 401 after that.
  it("audits the end with the token current at the end, not the one at start", async () => {
    let token = "tok-at-start"
    await startLocalSession({ ...OPTIONS, accessToken: () => token })
    token = "tok-refreshed"
    shell.emit({
      type: "sidecar_exited",
      code: 0,
      signal: null,
      booted: true,
      reason: "it exited",
      stderrTail: [],
    })
    await vi.waitFor(() => expect(endEvents()).toHaveLength(1))
    const headers = endEvents()[0]?.init?.headers as Record<string, string>
    expect(headers.Authorization).toBe("Bearer tok-refreshed")
  })

  it("audits the end when the session fails", async () => {
    await startLocalSession(OPTIONS)
    shell.emit({ type: "error", message: "the model refused" })
    shell.emit({ type: "done" })
    shell.emit({
      type: "sidecar_exited",
      code: 0,
      signal: null,
      booted: true,
      reason: "it exited",
      stderrTail: [],
    })
    await vi.waitFor(() => expect(endEvents()).toHaveLength(1))
    // The failure text is the session's business, never the audit trail's.
    expect(JSON.stringify(endEvents()[0]?.body)).not.toContain("refused")
  })

  it("audits the end exactly once, however many ways it ends", async () => {
    const handle = await startLocalSession(OPTIONS)
    shell.emit({ type: "error", message: "boom" })
    shell.emit({ type: "done" })
    shell.emit({
      type: "sidecar_exited",
      code: 0,
      signal: null,
      booted: true,
      reason: "it exited",
      stderrTail: [],
    })
    await endLocalSession(handle)
    await vi.waitFor(() => expect(endEvents()).toHaveLength(1))
  })

  // 2026-09-23, production (thread 1abf0d03): switching the local session from
  // one conversation to another replaced the running sidecar, which answered
  // its shutdown line with `done`. That line reached the NEW session, which
  // read it as its own end and released the claim it had just taken: the turn
  // then ran, and the server refused its answer for want of a claim.
  it("a done line from the sidecar being replaced does not end the new session", async () => {
    await startLocalSession({ ...OPTIONS, threadId: "thread-2", holderKey: "this-window" })
    shell.emit({ type: "done" })
    shell.emit({ type: "error", message: "the SDK query was closed" })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const released = calls.filter(
      (call) => call.url.includes("/local-claims") && call.init?.method === "DELETE",
    )
    expect(released).toHaveLength(0)
    expect(endEvents()).toHaveLength(0)
  })

  // 2026-09-23: a sidecar that dies sends neither `done` nor `error`; the
  // shell reports the exit, and the claim has to go with the session or the
  // heartbeat keeps the server away from a conversation nobody answers.
  it("a sidecar the shell reports dead releases the claim and closes the trail", async () => {
    await startLocalSession({ ...OPTIONS, threadId: "thread-1", holderKey: "this-window" })
    shell.emit({
      type: "sidecar_exited",
      code: 2,
      signal: null,
      booted: false,
      reason: "unknown permission mode: auto",
      stderrTail: [],
    })
    await vi.waitFor(() => expect(endEvents()).toHaveLength(1))
    const released = calls.filter(
      (call) => call.url.includes("/local-claims") && call.init?.method === "DELETE",
    )
    expect(released).toHaveLength(1)
    expect(released[0]?.url).toContain("holderKey=this-window")
  })

  // 2026-09-23, production: the app was quit and relaunched, and the new
  // instance was refused its own conversation (409). `endLocalSession` awaited
  // the shell's stop FIRST, and on an app that is going away that invoke
  // rejects: the release was never sent and the lease sat out its TTL.
  it("endLocalSession releases the claim even when the shell cannot stop the sidecar", async () => {
    const handle = await startLocalSession({
      ...OPTIONS,
      threadId: "thread-1",
      holderKey: "this-window",
    })
    shell.stopSession.mockRejectedValueOnce(new Error("the shell is exiting"))
    await endLocalSession(handle).catch(() => undefined)
    const released = calls.filter(
      (call) => call.url.includes("/local-claims") && call.init?.method === "DELETE",
    )
    expect(released).toHaveLength(1)
    expect(released[0]?.url).toContain("holderKey=this-window")
    expect(endEvents()).toHaveLength(1)
  })

  it("endLocalSession stops the sidecar and audits the end", async () => {
    const handle = await startLocalSession(OPTIONS)
    await endLocalSession(handle)
    expect(shell.stopSession).toHaveBeenCalledTimes(1)
    expect(endEvents()).toHaveLength(1)
  })

  it("never posts the folder path in any body, start turn or end", async () => {
    const handle = await startLocalSession(OPTIONS)
    shell.emit({ type: "ready", sidecarReadyMs: 1, systemPromptChecksum: "c".repeat(64) })
    await sendTurn(handle, "read the plan")
    await endLocalSession(handle)
    expect(calls.length).toBeGreaterThan(2)
    for (const call of calls) {
      expect(JSON.stringify(call.body)).not.toContain("secret-project")
      expect(JSON.stringify(call.body)).not.toContain("/Users/alice")
    }
  })
})

// P6d-FX5 (W8). A start touches the server three times before a sidecar
// exists, every one of them used to reject alike, and the window swallowed all
// three: thirty seconds of pressing Start produced a window identical to the
// one before it. The driven walk's own refusal was the claim answering 409,
// and the trail it left was a start row with no end.
describe("a start the server refuses names which step refused it", () => {
  /** The server, with the claim POST answering `status` instead of 200. */
  function claimRefusedWith(status: number, details?: Record<string, unknown>): void {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      let body: Record<string, unknown> | null = null
      if (typeof init?.body === "string") body = JSON.parse(init.body) as Record<string, unknown>
      calls.push({ url, init, body })
      if (url.includes("/local-claims")) {
        if (!details) return new Response(null, { status })
        return new Response(JSON.stringify({ error: { code: "claim_held", details } }), {
          status,
          headers: { "content-type": "application/json" },
        })
      }
      if (url.endsWith("/events")) return new Response(null, { status: 204 })
      if (/\/definition(\?|$)/.test(url)) {
        return new Response(JSON.stringify({ data: DEFINITION }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      if (url.endsWith("/api/agents")) {
        return new Response(JSON.stringify({ data: [{ id: "agent-1", kind: "role" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      return new Response(JSON.stringify({ data: { sessionId: "sess-1" } }), {
        status: 201,
        headers: { "content-type": "application/json" },
      })
    })
    vi.stubGlobal("fetch", fetchMock)
  }

  const endEvents = () =>
    calls.filter((call) => call.url.endsWith("/events") && call.body?.kind === "end")

  it("a conversation another machine holds refuses with ConversationClaimed", async () => {
    claimRefusedWith(409)
    const failure = await startLocalSession({ ...OPTIONS, threadId: "thread-1" }).catch(
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(LocalSessionStartError)
    expect((failure as LocalSessionStartError).reason).toBe("ConversationClaimed")
    // And the sidecar was never asked to run: a session with no claim is the
    // double turn the claim exists to prevent.
    expect(shell.startSession).not.toHaveBeenCalled()
  })

  it("any other refusal of the claim is ClaimRefused, not the 409 sentence", async () => {
    claimRefusedWith(403)
    const failure = await startLocalSession({ ...OPTIONS, threadId: "thread-1" }).catch(
      (error: unknown) => error,
    )
    expect((failure as LocalSessionStartError).reason).toBe("ClaimRefused")
  })

  it("the start row a refused claim left behind is closed", async () => {
    claimRefusedWith(409)
    await startLocalSession({ ...OPTIONS, threadId: "thread-1" }).catch(() => undefined)
    // The audit row was posted before the claim was attempted, so a start that
    // died here left a session that had begun and never ended.
    expect(endEvents()).toHaveLength(1)
    expect(endEvents()[0]?.url).toBe(
      "https://acme.example.com/api/agents/agent-1/local-sessions/sess-1/events",
    )
  })

  // P6d-FX7 (SK-5): the 409 a window gets from ITS OWN lease, after a release
  // the server accepted and never applied. "Another machine is already running
  // this conversation, stop the session there" names a machine that does not
  // exist and an action nobody can take.
  it("a 409 from this window's own lease is not the other machine sentence", async () => {
    claimRefusedWith(409, { heldByYou: true, expiresAt: "2026-09-14T10:00:00.000Z" })
    const failure = await startLocalSession({
      ...OPTIONS,
      threadId: "thread-1",
      holderKey: "this-window",
    }).catch((error: unknown) => error)
    expect((failure as LocalSessionStartError).reason).toBe("ClaimHeldHere")
  })

  // 2026-09-23: "another machine" alone sent the person looking for a
  // computer. The server now says whose lease it is, and the refusal carries it.
  it("a 409 carries who holds the conversation, as the server named it", async () => {
    claimRefusedWith(409, {
      heldByYou: false,
      sameUser: false,
      holderName: "Stéphanie",
      canTakeOver: true,
      expiresAt: "2026-09-14T10:00:00.000Z",
    })
    const failure = await startLocalSession({
      ...OPTIONS,
      threadId: "thread-1",
      holderKey: "this-window",
    }).catch((error: unknown) => error)
    expect((failure as LocalSessionStartError).reason).toBe("ConversationClaimed")
    expect((failure as LocalSessionStartError).holder).toEqual({
      sameUser: false,
      holderName: "Stéphanie",
      canTakeOver: true,
    })
  })

  it("a start the person asked to take over says so on the registration", async () => {
    mockServer()
    await startLocalSession({
      ...OPTIONS,
      threadId: "thread-1",
      holderKey: "this-window",
      takeOver: true,
    })
    const registered = calls.filter(
      (call) => call.url.endsWith("/local-claims") && call.init?.method === "POST",
    )
    expect(registered[0]?.body).toMatchObject({ takeOver: true, register: true })
  })

  it("a 409 from a holder that is not this window keeps the other machine sentence", async () => {
    claimRefusedWith(409, { heldByYou: false, expiresAt: "2026-09-14T10:00:00.000Z" })
    const failure = await startLocalSession({
      ...OPTIONS,
      threadId: "thread-1",
      holderKey: "this-window",
    }).catch((error: unknown) => error)
    expect((failure as LocalSessionStartError).reason).toBe("ConversationClaimed")
  })

  // P6d-FX7 (SK-6): the end row is written before the specific error is
  // thrown, and it used to be written with no catch, so the network condition
  // that had just refused the claim replaced the reason with its own rejection
  // and the page said "The session could not be started. Try again."
  it("a failing audit end does not replace the reason the claim refused with", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (typeof init?.body === "string") {
        calls.push({ url, init, body: JSON.parse(init.body) as Record<string, unknown> })
      }
      if (url.endsWith("/events")) throw new TypeError("the network went away")
      if (url.includes("/local-claims")) {
        return new Response(JSON.stringify({ error: { details: { heldByYou: false } } }), {
          status: 409,
          headers: { "content-type": "application/json" },
        })
      }
      if (/\/definition(\?|$)/.test(url)) {
        return new Response(JSON.stringify({ data: DEFINITION }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      if (url.endsWith("/api/agents")) {
        return new Response(JSON.stringify({ data: [{ id: "agent-1", kind: "role" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      return new Response(JSON.stringify({ data: { sessionId: "sess-1" } }), {
        status: 201,
        headers: { "content-type": "application/json" },
      })
    })
    vi.stubGlobal("fetch", fetchMock)
    const failure = await startLocalSession({ ...OPTIONS, threadId: "thread-1" }).catch(
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(LocalSessionStartError)
    expect((failure as LocalSessionStartError).reason).toBe("ConversationClaimed")
  })

  it("an audit the server refuses refuses with AuditRefused", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (/\/definition(\?|$)/.test(url)) {
        return new Response(JSON.stringify({ data: DEFINITION }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      if (url.endsWith("/api/agents")) {
        return new Response(JSON.stringify({ data: [{ id: "agent-1", kind: "role" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      return new Response(null, { status: 500 })
    })
    vi.stubGlobal("fetch", fetchMock)
    const failure = await startLocalSession(OPTIONS).catch((error: unknown) => error)
    expect((failure as LocalSessionStartError).reason).toBe("AuditRefused")
    expect(shell.startSession).not.toHaveBeenCalled()
  })
})
