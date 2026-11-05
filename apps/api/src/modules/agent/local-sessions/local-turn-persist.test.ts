// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A TURN THAT RAN ON THE USER'S MACHINE IS STORED THE WAY A CLOUD TURN IS
// (2026-09-23). The local reply used to be the final text and nothing else, so
// a relaunch, another device or the web app showed a question and an answer
// with nothing between them, and every reader downstream (the history the next
// turn replays, the checkpoint budget, the compaction trigger, the episode
// close) saw a turn that did nothing. These pin the stored row, the server's
// own redaction, and each of those readers seeing the local turn.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import * as jobsModule from "~/infra/jobs/jobs"
import { historyRowTokens, loadBoundedHistory } from "~/modules/agent/context/checkpoint"
import { estimateTokens } from "~/modules/agent/context/compaction"
import { convertToCoreMessages } from "~/modules/agent/context/context"
import { getLastInputTokens } from "~/modules/agent/runtime/agent-service"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const FOLDER_HASH = "a".repeat(64)
const HOLDER = "holder-local-turn"
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.c2lnbmF0dXJlLXZhbHVl"

/** What the desktop sends for the production turn, trimmed: two tools and the verdict. */
function reportTurn() {
  return {
    modelId: "claude-haiku-4-5",
    stepCount: 3,
    finishReason: "stop",
    reasoning: "Find the hub first.",
    usage: {
      inputTokens: 66_000,
      outputTokens: 900,
      cachedInputTokens: 60_000,
      lastStepInputTokens: 22_009,
    },
    toolCalls: [
      {
        toolCallId: "toolu_1",
        toolName: "kpi__kpi_list_hubs",
        args: { query: "Havre" },
        result: "Passage du Havre (hub 42)",
        status: "completed",
      },
      {
        toolCallId: "toolu_2",
        toolName: "Bash",
        // A client that did NOT redact: the server must.
        args: {
          command: `curl -H "Authorization: Bearer ${JWT}" https://x.example/k?token=cap123`,
        },
        result: `{"access_token":"${JWT}"}`,
        status: "completed",
      },
    ],
    timeline: [
      { kind: "reasoning", text: "Find the hub first." },
      { kind: "tool", toolCallId: "toolu_1" },
      { kind: "tool", toolCallId: "toolu_2" },
    ],
    // Never the client's to say.
    requiredScopes: [],
  }
}

describe("a local turn, stored as a cloud turn is", () => {
  let session: minimal.Session
  let agentId: string
  let threadId: string
  let sessionId: string

  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })

  const reply = (body: Record<string, unknown>) =>
    post(`/api/agents/${agentId}/local-sessions/${sessionId}/reply`, {
      threadId,
      holderKey: HOLDER,
      ...body,
    })

  async function storedRow(messageId: string) {
    const [row] = await sql<
      Array<{ content: string; metadata: Record<string, unknown>; required_scopes: string[] }>
    >`SELECT content, metadata, required_scopes FROM kernel.messages WHERE id = ${messageId}`
    return row
  }

  beforeAll(async () => {
    await acquireTestLock()
    const org = await createTestOrg()
    session = await minimal.session(org.id, { role: "admin" })
    const [agent] = await sql<{ id: string }[]>`
      INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling, owner_user_id)
      VALUES (${session.orgId}, 'personal', '@local-turn', 'Data', '["*"]'::jsonb, ${session.userId})
      RETURNING id`
    agentId = agent.id
    const started = await post(`/api/agents/${agentId}/local-sessions`, {
      permissionMode: "auto",
      folderHash: FOLDER_HASH,
      model: "claude-haiku-4-5",
    })
    sessionId = ((await started.json()) as { data: { sessionId: string } }).data.sessionId
  })

  beforeEach(async () => {
    threadId = await minimal.thread(session.orgId, session.userId)
    await post(`/api/agents/${agentId}/local-claims`, { threadId, holderKey: HOLDER })
  })

  afterEach(async () => {
    await sql`DELETE FROM kernel.agent_local_claims WHERE thread_id = ${threadId}`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.audit_log WHERE org_id = ${session.orgId}`
    await sql`DELETE FROM kernel.agents WHERE id = ${agentId}`
    await releaseTestLock()
  })

  it("stores the tool calls, the timeline, the usage and the model on the reply", async () => {
    const response = await reply({ text: "Verdict : GREEN", turn: reportTurn() })
    expect(response.status).toBe(201)
    const { data } = (await response.json()) as { data: { messageId: string } }
    const row = await storedRow(data.messageId)
    expect(row.content).toBe("Verdict : GREEN")
    expect(row.metadata).toMatchObject({
      runLocation: "local",
      localSessionId: sessionId,
      modelId: "claude-haiku-4-5",
      stepCount: 3,
      finishReason: "stop",
      reasoning: "Find the hub first.",
      usage: { inputTokens: 66_000, outputTokens: 900, lastStepInputTokens: 22_009 },
      timeline: [
        { kind: "reasoning", text: "Find the hub first." },
        { kind: "tool", toolCallId: "toolu_1" },
        { kind: "tool", toolCallId: "toolu_2" },
      ],
      agentAuthorLabel: "Data",
    })
    const calls = row.metadata.toolCalls as Array<Record<string, unknown>>
    expect(calls.map((call) => call.toolName)).toEqual(["kpi__kpi_list_hubs", "Bash"])
    expect(calls[0]).toMatchObject({ args: { query: "Havre" }, status: "completed" })
  })

  it("redacts what the client did not, and never takes the scopes from it", async () => {
    // The conversation the turn was handed carries a scoped message; the client says [].
    await sql`INSERT INTO kernel.messages (org_id, thread_id, author_type, author_id, content, required_scopes)
      VALUES (${session.orgId}, ${threadId}, 'user', ${session.userId}, 'hub figures', ${["kpi:metrics:read"]})`
    const response = await reply({ text: "Verdict : GREEN", turn: reportTurn() })
    const { data } = (await response.json()) as { data: { messageId: string } }
    const row = await storedRow(data.messageId)
    const stored = JSON.stringify(row.metadata)
    expect(stored).not.toContain(JWT)
    expect(stored).not.toContain("cap123")
    expect(stored).toContain("[redacted]")
    expect(stored).not.toContain("requiredScopes")
    // What the server knows the turn was handed (local-context-scopes.ts), never
    // the empty set the client asserted, and never the admin's whole `*`.
    expect(row.required_scopes).toContain("kpi:metrics:read")
    expect(row.required_scopes).not.toContain("*")
  })

  it("is read back with its activity by anyone who opens the conversation", async () => {
    await reply({ text: "Verdict : GREEN", turn: reportTurn() })
    const response = await app.request(`/api/threads/${threadId}/messages`, {
      headers: { Authorization: `Bearer ${session.bearer}` },
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      data: Array<{ authorType: string; content: string; metadata: Record<string, unknown> }>
    }
    const agentRow = body.data.find((m) => m.authorType === "agent")
    expect(agentRow?.content).toBe("Verdict : GREEN")
    expect(agentRow?.metadata.toolCalls).toHaveLength(2)
    expect(agentRow?.metadata.timeline).toHaveLength(3)
  })

  it("is in the history the next turn replays, tool calls included", async () => {
    await reply({ text: "Verdict : GREEN", turn: reportTurn() })
    const loaded = await loadBoundedHistory({
      threadId,
      orgId: session.orgId,
      actor: {
        actorType: "user",
        userId: session.userId,
        orgId: session.orgId,
        scopes: ["*"],
        dimensionGrants: {},
      },
      agentId,
    })
    const replayed = convertToCoreMessages(loaded.messages, undefined, { selfAgentId: agentId })
    const assistant = replayed.find((m) => m.role === "assistant" && Array.isArray(m.content)) as
      | { content: Array<{ type: string; toolName?: string; text?: string }> }
      | undefined
    expect(assistant).toBeDefined()
    expect(assistant?.content.filter((p) => p.type === "tool-call").map((p) => p.toolName)).toEqual(
      ["kpi__kpi_list_hubs", "Bash"],
    )
    expect(assistant?.content.find((p) => p.type === "text")?.text).toBe("Verdict : GREEN")
  })

  it("is counted by the checkpoint budget and read by the compaction trigger", async () => {
    const response = await reply({ text: "Verdict : GREEN", turn: reportTurn() })
    const { data } = (await response.json()) as { data: { messageId: string } }
    const row = await storedRow(data.messageId)
    expect(historyRowTokens(row)).toBeGreaterThan(estimateTokens(row.content))
    expect(await getLastInputTokens(threadId, session.orgId)).toBe(22_009)
  })

  it("a turn that called tools and wrote nothing is stored with a line, never a blank", async () => {
    const response = await reply({ text: "", turn: reportTurn() })
    expect(response.status).toBe(201)
    const { data } = (await response.json()) as { data: { messageId: string } }
    const row = await storedRow(data.messageId)
    expect(row.content.length).toBeGreaterThan(0)
    expect((row.metadata.toolCalls as unknown[]).length).toBe(2)
  })

  it("refuses a reply with neither text nor a turn", async () => {
    const response = await reply({ text: "  " })
    expect(response.status).toBe(400)
  })

  it("an older desktop's text-only reply is still stored", async () => {
    const response = await reply({ text: "Created hello.txt" })
    expect(response.status).toBe(201)
    const { data } = (await response.json()) as { data: { messageId: string } }
    const row = await storedRow(data.messageId)
    expect(row.content).toBe("Created hello.txt")
    expect(row.metadata.toolCalls).toBeUndefined()
  })

  describe("who answered last, for the next local start's resume decision", () => {
    const continuity = async () => {
      const response = await app.request(
        `/api/agents/${agentId}/local-claims/${threadId}/turn-context?continuity=1`,
        { headers: { Authorization: `Bearer ${session.bearer}` } },
      )
      expect(response.status).toBe(200)
      return ((await response.json()) as { data: Record<string, unknown> }).data
    }

    it("names nobody before the agent has answered", async () => {
      expect(await continuity()).toEqual({ coldResume: false, lastAgentTurn: null })
    })

    it("names the local session that wrote the last agent turn", async () => {
      await reply({ text: "Verdict : GREEN", turn: { ...reportTurn(), sdkSessionId: "sdk-1" } })
      expect(await continuity()).toEqual({
        coldResume: false,
        lastAgentTurn: { runLocation: "local", sdkSessionId: "sdk-1" },
      })
    })

    it("says cloud once a cloud turn answered after it", async () => {
      await reply({ text: "Verdict : GREEN", turn: { ...reportTurn(), sdkSessionId: "sdk-1" } })
      await sql`INSERT INTO kernel.messages
        (thread_id, org_id, author_id, author_type, author_agent_id, content, required_scopes, metadata, created_at)
        VALUES (${threadId}, ${session.orgId}, ${session.userId}, 'agent', ${agentId},
                'From Liaison.', '{}', ${JSON.stringify({ modelId: "gemini-3-flash" })}::jsonb,
                now() + interval '1 second')`
      expect(await continuity()).toEqual({
        coldResume: false,
        lastAgentTurn: { runLocation: "cloud", sdkSessionId: null },
      })
    })

    it("answers a warm turn that did not ask exactly as before", async () => {
      const response = await app.request(
        `/api/agents/${agentId}/local-claims/${threadId}/turn-context`,
        { headers: { Authorization: `Bearer ${session.bearer}` } },
      )
      expect(((await response.json()) as { data: unknown }).data).toEqual({ coldResume: false })
    })
  })

  describe("the between-turns upkeep a cloud turn gets", () => {
    const enqueued: Array<{ jobName: string; jobId?: string }> = []
    let spy: { mockRestore: () => void } | null = null

    beforeEach(() => {
      enqueued.length = 0
      spy = spyOn(jobsModule, "enqueueAppJob").mockImplementation(
        async (
          _app: string,
          jobName: string,
          _payload: unknown,
          opts?: Record<string, unknown>,
        ) => {
          enqueued.push({ jobName, jobId: opts?.jobId as string | undefined })
          return (opts?.jobId as string) ?? "job"
        },
      )
    })

    afterEach(() => spy?.mockRestore())

    const quietClose = () =>
      enqueued.filter((job) => job.jobId?.endsWith(`:${agentId}:${threadId}:quiet`))

    it("a local turn arms the episode close of its conversation", async () => {
      const response = await post(`/api/agents/${agentId}/local-sessions/${sessionId}/events`, {
        kind: "turn",
        permissionMode: "auto",
        threadId,
      })
      expect(response.status).toBe(204)
      for (let i = 0; i < 50 && quietClose().length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      expect(quietClose()).toHaveLength(1)
    })

    it("does nothing for a conversation this caller does not hold", async () => {
      await sql`DELETE FROM kernel.agent_local_claims WHERE thread_id = ${threadId}`
      await post(`/api/agents/${agentId}/local-sessions/${sessionId}/events`, {
        kind: "turn",
        permissionMode: "auto",
        threadId,
      })
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(quietClose()).toHaveLength(0)
    })
  })
})
