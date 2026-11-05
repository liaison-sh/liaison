// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The node job routes on the wire: the claim body names the job's MCP
// connection (A18), and every node call carries the owner's session AND the
// node credential.
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("../tauri", () => ({ invoke: vi.fn(), listen: vi.fn(async () => () => {}) }))

import {
  NODE_CREDENTIAL_HEADER,
  NODE_PROTOCOL_HEADER,
  nodeImportHttp,
  nodeJobHttp,
  nodeJobShell,
} from "./adapters"
import { NodeHttpError } from "./runner"

const source = {
  serverAddress: () => "https://liaison.example/",
  accessToken: () => "session-token",
  nodeCredential: async () => "lnn_cred",
}

function stubFetch(data: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data }), { status: 200 }))
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

afterEach(() => vi.unstubAllGlobals())

describe("the node job routes", () => {
  it("the claim carries the connection id, the session and the node credential", async () => {
    const fetchMock = stubFetch({ leaseGeneration: 1 })
    await nodeJobHttp(source).claim("job-1", "conn-1")
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("https://liaison.example/api/nodes/jobs/job-1/claim")
    expect(JSON.parse(init.body as string)).toEqual({ mcpConnectionId: "conn-1" })
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe("Bearer session-token")
    expect(headers[NODE_CREDENTIAL_HEADER]).toBe("lnn_cred")
  })

  // D46; S24/S7 (spec §4): protocol 3 applies mark_done and set_effort live;
  // S30/S33 (A28): protocol 4 also applies set_autonomy live (an older node
  // gets the row change only). S40/A45: protocol 5 also runs follow jobs
  // (a follow is never offered to, and refused from, an older node).
  it("the claim sends protocol 5", async () => {
    const fetchMock = stubFetch({ leaseGeneration: 1 })
    await nodeJobHttp(source).claim("job-1", null)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>)["X-Liaison-Node-Protocol"]).toBe("5")
  })

  it("B2-1: a claim's answer names the server that answered it, never a field the server sent", async () => {
    stubFetch({ leaseGeneration: 1, claimedFrom: "https://elsewhere.example" })
    const answer = await nodeJobHttp(source).claim("job-1", null)
    expect(answer.claimedFrom).toBe("https://liaison.example")
  })

  it("a claim with no connection sends none", async () => {
    const fetchMock = stubFetch({ leaseGeneration: 1 })
    await nodeJobHttp(source).claim("job-1", null)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({})
  })

  it("reads one job with GET /jobs/:id; a job that is gone is null", async () => {
    const fetchMock = stubFetch({ id: "job-2", agentId: "agent-2", kind: "unattended" })
    expect(await nodeJobHttp(source).getJob("job-2")).toEqual({
      id: "job-2",
      agentId: "agent-2",
      kind: "unattended",
    })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("https://liaison.example/api/nodes/jobs/job-2")
    expect(init.method).toBe("GET")
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "no such job" } }), {
            status: 404,
          }),
      ),
    )
    expect(await nodeJobHttp(source).getJob("gone")).toBeNull()
  })

  it("posts a session's batch to the node route, with the node credential", async () => {
    const fetchMock = stubFetch({ lastSeq: 4 })
    const body = {
      jobId: "job-1",
      leaseGeneration: 3,
      batchNo: 2,
      events: [{ at: "2026-10-13T12:00:00.000Z", type: "assistant_text" as const, payload: {} }],
    }
    expect(await nodeJobHttp(source).postEvents("session-1", body)).toEqual({ lastSeq: 4 })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("https://liaison.example/api/node/sessions/session-1/events")
    expect(JSON.parse(init.body as string)).toEqual(body)
    expect((init.headers as Record<string, string>)[NODE_CREDENTIAL_HEADER]).toBe("lnn_cred")
  })

  it("an ingest refusal keeps its extra fields (expectedBatchNo, index)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { code: "gap", message: "Expected batch 3.", expectedBatchNo: 3 },
            }),
            { status: 409 },
          ),
      ),
    )
    const error = await nodeJobHttp(source)
      .postEvents("session-1", { jobId: "j", leaseGeneration: 1, batchNo: 5, events: [] })
      .catch((e) => e)
    expect(error).toBeInstanceOf(NodeHttpError)
    expect(error).toMatchObject({ status: 409, code: "gap", details: { expectedBatchNo: 3 } })
  })
})

// P1-walk D12: after about 50 minutes the window's access token had expired;
// the claim answered 401 invalid_token and the job sat offered until a restart.
describe("an expired access token is refreshed and the call retried once (D12)", () => {
  function expiringSource() {
    let token = "expired-token"
    const refresh = vi.fn(async () => {
      token = "fresh-token"
      return true
    })
    return {
      refresh,
      source: {
        serverAddress: () => "https://liaison.example/",
        accessToken: () => token,
        nodeCredential: async () => "lnn_cred",
        refreshAccessToken: refresh,
      },
    }
  }
  const unauthorized = () =>
    new Response(JSON.stringify({ error: { code: "invalid_token", message: "expired" } }), {
      status: 401,
    })

  it("a claim answered 401 invalid_token refreshes the token and claims with the new one", async () => {
    const { source: s, refresh } = expiringSource()
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) =>
      (init.headers as Record<string, string>).Authorization === "Bearer fresh-token"
        ? new Response(JSON.stringify({ data: { leaseGeneration: 7 } }), { status: 200 })
        : unauthorized(),
    )
    vi.stubGlobal("fetch", fetchMock)
    const claim = await nodeJobHttp(s).claim("job-1", null)
    expect(claim.leaseGeneration).toBe(7)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const retried = fetchMock.mock.calls[1]?.[1] as RequestInit
    expect((retried.headers as Record<string, string>).Authorization).toBe("Bearer fresh-token")
    expect((retried.headers as Record<string, string>)[NODE_PROTOCOL_HEADER]).toBe("5")
  })

  it("a heartbeat is retried too; a refresh that fails surfaces the 401, with one try only", async () => {
    const { source: s } = expiringSource()
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => unauthorized()),
    )
    const failing = { ...s, refreshAccessToken: vi.fn(async () => false) }
    await expect(nodeJobHttp(failing).heartbeat("job-1", 2)).rejects.toMatchObject({
      status: 401,
      code: "invalid_token",
    })
    expect(failing.refreshAccessToken).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("W2-D4: a result answered 401 after the window already rotated the token is retried with the current token, even when the forced refresh reports no change", async () => {
    let token = "stale-token"
    const refresh = vi.fn(async () => false)
    const s = {
      serverAddress: () => "https://liaison.example/",
      accessToken: () => token,
      nodeCredential: async () => "lnn_cred",
      refreshAccessToken: refresh,
    }
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      if ((init.headers as Record<string, string>).Authorization === "Bearer fresh-token") {
        return new Response(JSON.stringify({ data: {} }), { status: 200 })
      }
      // The window's own refresh lands while this call is in flight.
      token = "fresh-token"
      return unauthorized()
    })
    vi.stubGlobal("fetch", fetchMock)
    await nodeJobHttp(s).result("job-1", { leaseGeneration: 3, text: "Done?", refusals: [] })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const retried = fetchMock.mock.calls[1]?.[1] as RequestInit
    expect((retried.headers as Record<string, string>).Authorization).toBe("Bearer fresh-token")
    // Already rotated: no forced refresh on top.
    expect(refresh).not.toHaveBeenCalled()
  })

  it("W2-D4: a forced refresh that answers false while another refresh put a new token in place still retries", async () => {
    let token = "stale-token"
    const refresh = vi.fn(async () => {
      token = "fresh-token"
      return false
    })
    const s = {
      serverAddress: () => "https://liaison.example/",
      accessToken: () => token,
      nodeCredential: async () => "lnn_cred",
      refreshAccessToken: refresh,
    }
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) =>
      (init.headers as Record<string, string>).Authorization === "Bearer fresh-token"
        ? new Response(JSON.stringify({ data: {} }), { status: 200 })
        : unauthorized(),
    )
    vi.stubGlobal("fetch", fetchMock)
    await nodeJobHttp(s).result("job-1", { leaseGeneration: 3, text: "Done?", refusals: [] })
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("a 401 from the node credential itself (node_credential_refused) is not a token refresh", async () => {
    const { source: s, refresh } = expiringSource()
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: "node_credential_invalid" } }), {
            status: 403,
          }),
      ),
    )
    await expect(nodeJobHttp(s).claim("job-1", null)).rejects.toBeInstanceOf(NodeHttpError)
    expect(refresh).not.toHaveBeenCalled()
  })
})

describe("a node job's definition (P4 N-D T6, A30)", () => {
  it("is composed for the node runtime, not the local session", async () => {
    const fetchMock = stubFetch({
      systemPrompt: "## You run on the person's node",
      skillIndex: [],
      scopedMemory: [],
      mcpToolList: [],
    })
    const text = await nodeJobHttp(source).definition("agent-1")
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("https://liaison.example/api/agents/agent-1/definition?runtime=node")
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer session-token")
    expect(text).toContain("## You run on the person's node")
  })

  it("names the job's room, so the server bounds the definition by its floor", async () => {
    const fetchMock = stubFetch({
      systemPrompt: "x",
      skillIndex: [],
      scopedMemory: [],
      mcpToolList: [],
    })
    await nodeJobHttp(source).definition("agent-1", "thread-7")
    const [url] = fetchMock.mock.calls[0] as unknown as [string]
    expect(url).toBe(
      "https://liaison.example/api/agents/agent-1/definition?runtime=node&threadId=thread-7",
    )
  })
})

describe("relayed permission prompts (P4 N-D T6b, S24, A24)", () => {
  it("a prompt is posted on the job, fenced, with the node credential", async () => {
    const fetchMock = stubFetch({ id: "prompt-1", status: "pending" })
    const answer = await nodeJobHttp(source).permissionRequest("job-1", {
      leaseGeneration: 4,
      toolName: "Bash",
      summary: "bun run build",
    })
    expect(answer).toEqual({ id: "prompt-1", status: "pending" })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("https://liaison.example/api/nodes/jobs/job-1/permission-requests")
    expect(init.method).toBe("POST")
    expect(JSON.parse(init.body as string)).toEqual({
      leaseGeneration: 4,
      toolName: "Bash",
      summary: "bun run build",
    })
    expect((init.headers as Record<string, string>)[NODE_CREDENTIAL_HEADER]).toBe("lnn_cred")
  })

  it("the decision is read from the owner's prompt", async () => {
    const fetchMock = stubFetch({ id: "prompt-1", status: "allowed" })
    expect(await nodeJobHttp(source).permissionStatus("prompt-1")).toEqual({ status: "allowed" })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("https://liaison.example/api/nodes/permission-requests/prompt-1")
    expect(init.method).toBe("GET")
  })

  it("the answer goes to the running job through the shell", async () => {
    const tauri = await import("../tauri")
    const invoke = tauri.invoke as unknown as ReturnType<typeof vi.fn>
    invoke.mockResolvedValue(true)
    await nodeJobShell(() => "session-token").answerPermission("perm-1", false, "denied")
    expect(invoke).toHaveBeenCalledWith("answer_node_job_permission", {
      requestId: "perm-1",
      allow: false,
      message: "denied",
    })
  })
})

describe("the shell's run commands (P3-T10: one sidecar per live session)", () => {
  it("a stop names the session and the job; none stops every run", async () => {
    const tauri = await import("../tauri")
    const invoke = tauri.invoke as unknown as ReturnType<typeof vi.fn>
    invoke.mockResolvedValue(true)
    const shell = nodeJobShell(() => "session-token")
    await shell.stopJob("session-1", "job-1")
    expect(invoke).toHaveBeenLastCalledWith("stop_node_job", {
      sessionId: "session-1",
      jobId: "job-1",
    })
    await shell.stopJob()
    expect(invoke).toHaveBeenLastCalledWith("stop_node_job", { sessionId: null, jobId: null })
  })

  it("a control line goes to one session through node_session_write", async () => {
    const tauri = await import("../tauri")
    const invoke = tauri.invoke as unknown as ReturnType<typeof vi.fn>
    invoke.mockResolvedValueOnce(false)
    const shell = nodeJobShell(() => "session-token")
    expect(await shell.writeSession("session-1", '{"type":"restart"}')).toBe(false)
    expect(invoke).toHaveBeenLastCalledWith("node_session_write", {
      sessionId: "session-1",
      line: '{"type":"restart"}',
    })
  })

  it("lines and exits carry their job and session; anything else is dropped", async () => {
    const tauri = await import("../tauri")
    const listen = tauri.listen as unknown as ReturnType<typeof vi.fn>
    const handlers = new Map<string, (e: { payload: unknown }) => void>()
    listen.mockImplementation(async (event: string, handler: (e: { payload: unknown }) => void) => {
      handlers.set(event, handler)
      return () => {}
    })
    const shell = nodeJobShell(() => "session-token")
    const lines: unknown[] = []
    const exits: unknown[] = []
    shell.onLine((l) => lines.push(l))
    shell.onExit((e) => exits.push(e))
    await Promise.resolve()
    handlers.get("node-job-line")?.({
      payload: { sessionId: "s-1", jobId: "j-1", line: "{}", index: 3 },
    })
    handlers.get("node-job-line")?.({ payload: { jobId: "j-2", line: "{}" } })
    handlers.get("node-job-line")?.({ payload: "a bare line" })
    handlers.get("node-job-line")?.({ payload: { line: "{}" } })
    handlers.get("node-job-exit")?.({ payload: { sessionId: "s-1", jobId: "j-1", exit: {} } })
    handlers.get("node-job-exit")?.({ payload: {} })
    // A45: a follow's end carries its why (and the offset it reached); a bad one is dropped.
    handlers.get("node-job-exit")?.({
      payload: { sessionId: "s-2", jobId: "j-2", follow: { why: "owner", endOffset: 42 } },
    })
    handlers.get("node-job-exit")?.({
      payload: { sessionId: "s-3", jobId: "j-3", follow: { why: "done", endOffset: -1 } },
    })
    expect(lines).toEqual([
      { sessionId: "s-1", jobId: "j-1", line: "{}", index: 3 },
      { jobId: "j-2", line: "{}" },
    ])
    expect(exits).toEqual([
      { sessionId: "s-1", jobId: "j-1" },
      { sessionId: "s-2", jobId: "j-2", follow: { why: "owner", endOffset: 42 } },
      { sessionId: "s-3", jobId: "j-3" },
    ])
    expect(shell).not.toHaveProperty("backlogPrompt")
  })
})

describe("the shell's follow commands (W3 T11, A45)", () => {
  it("a follow starts through start_node_follow with its request, and stops through stop_node_follow", async () => {
    const tauri = await import("../tauri")
    const invoke = tauri.invoke as unknown as ReturnType<typeof vi.fn>
    invoke.mockResolvedValue({ started: true })
    const shell = nodeJobShell(() => "session-token")
    const request = {
      sessionId: "s-1",
      jobId: "j-1",
      leaseGeneration: 3,
      sdkSessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      folderName: "app",
      cwdSubdir: "",
      startAt: "end" as const,
      once: false,
      inPlace: true,
    }
    await shell.startFollow(request)
    // Never the window's session: the follow host calls no server.
    expect(invoke).toHaveBeenLastCalledWith("start_node_follow", { request })
    invoke.mockResolvedValueOnce(true)
    expect(await shell.stopFollow("s-1", "j-1")).toBe(true)
    expect(invoke).toHaveBeenLastCalledWith("stop_node_follow", { sessionId: "s-1", jobId: "j-1" })
    invoke.mockRejectedValueOnce("FOLLOW_AT_CAP")
    await expect(shell.startFollow(request)).rejects.toMatchObject({ code: "FOLLOW_AT_CAP" })
  })
})

describe("the import requests on the wire (W3 T11, S40)", () => {
  it("pulls and answers an import request on the node's own route, with the node credential", async () => {
    const fetchMock = vi.fn(
      async (_url: string, init: RequestInit) =>
        new Response(
          init.method === "GET"
            ? JSON.stringify({ data: { op: { kind: "list" }, claim: "claim-1" } })
            : null,
          { status: init.method === "GET" ? 200 : 204 },
        ),
    )
    vi.stubGlobal("fetch", fetchMock)
    const http = nodeImportHttp(source)
    expect(await http.get("req-1")).toEqual({ op: { kind: "list" }, claim: "claim-1" })
    await http.put("req-1", "claim-1", { ok: false, code: "timeout" })
    const [getUrl, getInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(getUrl).toBe("https://liaison.example/api/node/import-requests/req-1")
    expect((getInit.headers as Record<string, string>)[NODE_CREDENTIAL_HEADER]).toBe("lnn_cred")
    const [putUrl, putInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit]
    expect(putUrl).toBe("https://liaison.example/api/node/import-requests/req-1")
    expect(JSON.parse(putInit.body as string)).toEqual({
      claim: "claim-1",
      ok: false,
      code: "timeout",
    })
  })

  it("a pull answered 404 (gone, or another connection's claim) is null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 404 })),
    )
    expect(await nodeImportHttp(source).get("req-1")).toBeNull()
  })
})

describe("reattach and steering calls (P3-T13)", () => {
  it("pulls the node's unacked commands and reports its live runs, with the node credential", async () => {
    // Walk D1: the server's real shape, `data: {commands: [...]}` (routes-node.ts).
    const pulled = {
      commandId: "c-1",
      sessionId: "s-1",
      jobId: "j-1",
      seq: 1,
      type: "message",
      payload: { text: "hi" },
    }
    const fetchMock = stubFetch({ commands: [pulled, { commandId: "bad" }] } satisfies {
      commands: unknown[]
    })
    expect(await nodeJobHttp(source).getCommands()).toEqual([pulled])
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("https://liaison.example/api/node/sessions/commands?unacked=1")
    expect(init.method).toBe("GET")
    expect((init.headers as Record<string, string>)[NODE_CREDENTIAL_HEADER]).toBe("lnn_cred")
    const reported = stubFetch({ sessions: [{ id: "s-1", lastBatchNo: 4, lastSeq: 9 }] })
    const sessions = [{ id: "s-1", jobId: "j-1", leaseGeneration: 2, alive: true }]
    expect(await nodeJobHttp(source).report(sessions)).toEqual({
      sessions: [{ id: "s-1", lastBatchNo: 4, lastSeq: 9 }],
    })
    const [reportUrl, reportInit] = reported.mock.calls[0] as unknown as [string, RequestInit]
    expect(reportUrl).toBe("https://liaison.example/api/node/sessions/report")
    expect(JSON.parse(reportInit.body as string)).toEqual({ sessions })
  })

  it("reads the shell's live runs, outbox and ack, and persists an ack", async () => {
    const tauri = await import("../tauri")
    const invoke = tauri.invoke as unknown as ReturnType<typeof vi.fn>
    const shell = nodeJobShell(() => "session-token")
    invoke.mockResolvedValueOnce([{ sessionId: "s-1", jobId: "j-1", lines: 2 }])
    expect(await shell.liveSessions()).toEqual([{ sessionId: "s-1", jobId: "j-1", lines: 2 }])
    expect(invoke).toHaveBeenLastCalledWith("node_live_sessions")
    invoke.mockResolvedValueOnce([{ index: 3, line: "{}" }])
    expect(await shell.outbox("s-1", "j-1", 3, 200)).toEqual([{ index: 3, line: "{}" }])
    expect(invoke).toHaveBeenLastCalledWith("node_session_outbox", {
      sessionId: "s-1",
      jobId: "j-1",
      fromIndex: 3,
      max: 200,
    })
    invoke.mockResolvedValueOnce(undefined)
    await shell.ack("s-1", "j-1", 3, 7)
    expect(invoke).toHaveBeenLastCalledWith("node_session_ack", {
      sessionId: "s-1",
      jobId: "j-1",
      index: 3,
      batchNo: 7,
    })
    invoke.mockResolvedValueOnce({ index: 3, batchNo: 7 })
    expect(await shell.acked("s-1", "j-1")).toEqual({ index: 3, batchNo: 7 })
    invoke.mockResolvedValueOnce(null)
    expect(await shell.acked("s-1", "j-1")).toEqual({ index: 0, batchNo: 0 })
  })
})

describe("full output (P3-T22)", () => {
  it("PUTs the text as text/plain, or an empty body marked gone, with the node credential", async () => {
    const fetchMock = stubFetch({ ok: true })
    await nodeJobHttp(source).putFullOutput("s-1", "toolu_01A", "all of it")
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("https://liaison.example/api/node/sessions/s-1/full-output/toolu_01A")
    expect(init.method).toBe("PUT")
    expect(init.body).toBe("all of it")
    const headers = init.headers as Record<string, string>
    expect(headers["Content-Type"]).toBe("text/plain; charset=utf-8")
    expect(headers[NODE_CREDENTIAL_HEADER]).toBe("lnn_cred")
    expect(headers["X-Full-Output"]).toBeUndefined()
    await nodeJobHttp(source).putFullOutput("s-1", "toolu_01B", null)
    const [, gone] = fetchMock.mock.calls[1] as unknown as [string, RequestInit]
    expect(gone.body).toBe("")
    expect((gone.headers as Record<string, string>)["X-Full-Output"]).toBe("gone")
  })

  it("reads the spill file through the shell", async () => {
    const tauri = await import("../tauri")
    const invoke = tauri.invoke as unknown as ReturnType<typeof vi.fn>
    invoke.mockResolvedValueOnce("text")
    expect(await nodeJobShell(() => "t").spill("s-1", "toolu_01A")).toBe("text")
    expect(invoke).toHaveBeenLastCalledWith("node_session_spill", {
      sessionId: "s-1",
      toolUseId: "toolu_01A",
    })
    invoke.mockResolvedValueOnce(null)
    expect(await nodeJobShell(() => "t").spill("s-1", "toolu_01A")).toBeNull()
  })
})

describe("the shell's connection commands and the start (D43, CAV14, K25)", () => {
  it("an unattended job's agent is connected with no dialog; My node chat asks with the dialog", async () => {
    const tauri = await import("../tauri")
    const invoke = tauri.invoke as unknown as ReturnType<typeof vi.fn>
    invoke.mockResolvedValueOnce("conn-9")
    const shell = nodeJobShell(() => "session-token")
    expect(await shell.ensureConnection("agent-1")).toBe("conn-9")
    expect(invoke).toHaveBeenLastCalledWith("ensure_node_agent_connection", {
      agentId: "agent-1",
      accessToken: "session-token",
    })
    invoke.mockResolvedValueOnce({ confirmed: true, connected: false })
    expect(await shell.confirmConnection("agent-1", "Dev")).toEqual({
      confirmed: true,
      connected: false,
    })
    expect(invoke).toHaveBeenLastCalledWith("confirm_node_connection", {
      agentId: "agent-1",
      agentName: "Dev",
      accessToken: "session-token",
    })
    expect(invoke.mock.calls.some((c) => c[0] === "confirm_node_profile")).toBe(false)
  })

  it("the start carries the window's session for the shell's consume call", async () => {
    const tauri = await import("../tauri")
    const invoke = tauri.invoke as unknown as ReturnType<typeof vi.fn>
    invoke.mockResolvedValueOnce({ ok: true })
    await nodeJobShell(() => "session-token").startJob({
      jobId: "job-1",
      agentId: "agent-1",
      agentName: "Dev",
      model: "claude-haiku-4-5",
      profile: { level: "standard", liaisonTools: true },
      prompt: "do it",
      trigger: null,
      hardTokenLimit: null,
      agentDefinition: "",
      mcpConnectionId: "conn-1",
      sessionId: "session-1",
      level: "open",
      profileLevel: "standard",
      configKind: "owner",
      sessionConfirmationId: "conf-1",
    })
    expect(invoke).toHaveBeenLastCalledWith("start_node_job", {
      request: expect.objectContaining({
        sessionId: "session-1",
        level: "open",
        sessionConfirmationId: "conf-1",
        accessToken: "session-token",
      }),
    })
  })
})
