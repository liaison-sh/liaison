// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P4 N-S T3b (S24, A24, A50/F9): a conversation that runs on a node.
//
//  - The thread's runtime (runs_on + permission mode) is stored server side.
//    `bypass` is unavailable when the chat is driven remotely: refused by the
//    route, and impossible in the job and settings rows.
//  - Only the node owner's own messages go to the node, as an INTERACTIVE job
//    carrying the permission mode and the SDK session id to resume; anyone
//    else's message in the same thread runs in the cloud.
//  - The node reports the session id with its result, and the next job
//    resumes it.
//  - A permission prompt of the remote session becomes an approval card for
//    the owner; pending until answered, denied after 10 minutes; unattended
//    jobs never prompt.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { NODE_CHAT_PERMISSION_MODES } from "@liaison/shared"
import { app } from "~/app"
import { sql } from "~/db"
import { withRlsContext } from "~/db/rls"
import { NODE_PERMISSION_MODES } from "~/db/schema/kernel/nodes"
import { AgentServiceTestAccess } from "~/modules/agent/runtime/agent-service"
import { dispatchForPostedMessage } from "~/modules/threads/posted-message-dispatch"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { createNodeJob } from "./jobs"

const ANSWER = "the cloud answered this one"

async function rejects(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn()
    return false
  } catch {
    return true
  }
}
let streamCalls = 0

function fakeStream() {
  streamCalls++
  return {
    fullStream: (async function* () {
      yield { type: "text-delta", text: ANSWER }
      yield {
        type: "finish-step",
        usage: { inputTokens: 3, outputTokens: 2 },
        finishReason: "stop",
      }
      yield { type: "finish", finishReason: "stop" }
    })(),
  } as never
}

describe("node chat (P4 T3b)", () => {
  let owner: minimal.Session
  let member: minimal.Session
  let agentId: string
  let threadId: string
  let node: { nodeId: string; credential: string }

  const call = (
    session: minimal.Session,
    path: string,
    method: string,
    body?: unknown,
    nodeCredential?: string,
  ) =>
    app.request(path, {
      method,
      headers: {
        Authorization: `Bearer ${session.bearer}`,
        ...(nodeCredential
          ? { "X-Node-Credential": nodeCredential, "X-Liaison-Node-Protocol": "2" }
          : {}),
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  const data = async (res: Response) => ((await res.json()) as { data: any }).data
  const settingsPath = () => `/api/nodes/threads/${threadId}/settings`

  /** A human message naming the agent, dispatched exactly as the thread route does. */
  async function post(session: minimal.Session, text: string) {
    const content = `@[Fixer](agent:${agentId}) ${text}`
    const [msg] = await sql<{ id: string }[]>`
      INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, content, required_scopes, mentions)
      VALUES (${threadId}, ${session.orgId}, ${session.userId}, 'user', ${content}, '{}'::text[],
              ${JSON.stringify([{ type: "agent", id: agentId }])}::jsonb)
      RETURNING id`
    const actor = { userId: session.userId, orgId: session.orgId, scopes: ["*"] }
    const out = await dispatchForPostedMessage(
      (fn) => withRlsContext({ actorType: "user", ...actor, dimensionGrants: {} }, fn),
      {
        orgId: session.orgId,
        threadId,
        message: {
          id: msg.id,
          content,
          mentions: [{ type: "agent", id: agentId }],
          authorName: "someone",
          threadType: "thread",
        },
        actor,
      },
    )
    return { messageId: msg.id, ...out }
  }

  const jobs = () =>
    sql<
      Array<{
        id: string
        kind: string
        source: string
        permission_mode: string | null
        sdk_session_id: string | null
        source_ref: string | null
        thread_id: string
        prompt: string
      }>
    >`SELECT id, kind, source, permission_mode, sdk_session_id, source_ref, thread_id, prompt
        FROM kernel.node_jobs WHERE org_id = ${owner.orgId} ORDER BY created_at`

  beforeAll(async () => {
    await acquireTestLock()
    AgentServiceTestAccess.setStreamText(fakeStream as never)
    const org = await createTestOrg()
    owner = await minimal.session(org.id)
    member = await minimal.session(org.id)
    const [agent] = await sql<{ id: string }[]>`
      INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling)
      VALUES (${owner.orgId}, 'role', ${`@nc-${crypto.randomUUID().slice(0, 8)}`}, 'Fixer',
              '["*"]'::jsonb)
      RETURNING id`
    agentId = agent.id
    await sql`INSERT INTO kernel.model_pricing
        (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum)
      VALUES ('anthropic', 'claude-haiku-4-5', 'Claude Haiku 4.5', '1.00', '5.00', 200000, true, 'starter')
      ON CONFLICT (provider, model_id) DO NOTHING`
    const enabled = await data(
      await call(owner, "/api/nodes", "POST", { deviceId: `d.${crypto.randomUUID()}` }),
    )
    node = { nodeId: enabled.node.id, credential: enabled.credential }
  })

  beforeEach(async () => {
    streamCalls = 0
    await sql`DELETE FROM kernel.node_jobs WHERE org_id = ${owner.orgId}`
    await sql`DELETE FROM kernel.thread_node_settings WHERE org_id = ${owner.orgId}`
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${owner.orgId}`
    const [t] = await sql<{ id: string }[]>`
      INSERT INTO kernel.threads (org_id, handle, type, agent_model_id, created_by)
      VALUES (${owner.orgId}, ${`nc-${crypto.randomUUID().slice(0, 8)}`}, 'thread',
              'claude-haiku-4-5', ${owner.userId})
      RETURNING id`
    threadId = t.id
    for (const u of [owner.userId, member.userId]) {
      await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
        VALUES (${threadId}, ${u}, ${owner.orgId})`
    }
    await sql`INSERT INTO kernel.thread_participants (thread_id, agent_id, org_id, participant_type)
      VALUES (${threadId}, ${agentId}, ${owner.orgId}, 'agent')`
  })

  afterAll(async () => {
    AgentServiceTestAccess.setStreamText()
    if (owner) {
      await sql`DELETE FROM kernel.node_jobs WHERE org_id = ${owner.orgId}`
      await sql`DELETE FROM kernel.thread_node_settings WHERE org_id = ${owner.orgId}`
      await sql`DELETE FROM kernel.nodes WHERE org_id = ${owner.orgId}`
    }
    await releaseTestLock()
  })

  it("permission_mode enum equals NODE_CHAT_PERMISSION_MODES (L23)", () => {
    expect(NODE_PERMISSION_MODES).toBe(NODE_CHAT_PERMISSION_MODES)
  })

  it("bypass is unavailable when the chat is driven remotely; the other modes are stored", async () => {
    const bypass = await call(owner, settingsPath(), "PUT", {
      agentId,
      runsOn: "node",
      permissionMode: "bypass",
    })
    expect(bypass.status).toBe(422)
    expect(((await bypass.json()) as { error: { code: string } }).error.code).toBe(
      "bypass_unavailable_remote",
    )
    expect(
      await sql`SELECT id FROM kernel.thread_node_settings WHERE thread_id = ${threadId}`,
    ).toHaveLength(0)

    const plan = await call(owner, settingsPath(), "PUT", {
      agentId,
      runsOn: "node",
      permissionMode: "plan",
    })
    expect(plan.status).toBe(200)
    const listed = await data(await call(owner, settingsPath(), "GET"))
    expect(listed).toEqual([
      expect.objectContaining({ agentId, runsOn: "node", permissionMode: "plan", mine: true }),
    ])
    // Nor can a row or a job ever hold bypass.
    expect(
      await rejects(
        async () =>
          await sql`UPDATE kernel.thread_node_settings SET permission_mode = 'bypass' WHERE thread_id = ${threadId}`,
      ),
    ).toBe(true)
    expect(
      await rejects(() =>
        createNodeJob({
          orgId: owner.orgId,
          ownerUserId: owner.userId,
          agentId,
          threadId,
          source: "chat",
          kind: "interactive",
          permissionMode: "bypass" as never,
          prompt: "p",
          sourceRequiredScopes: [],
        }),
      ),
    ).toBe(true)
  })

  it("another person cannot take over the agent's node runtime in the same thread", async () => {
    await call(owner, settingsPath(), "PUT", { agentId, runsOn: "node", permissionMode: "auto" })
    const res = await call(member, settingsPath(), "PUT", {
      agentId,
      runsOn: "node",
      permissionMode: "auto",
    })
    expect(res.status).toBe(409)
    // Back to the cloud: the row goes.
    expect((await call(owner, settingsPath(), "PUT", { agentId, runsOn: "cloud" })).status).toBe(
      200,
    )
    expect(await data(await call(owner, settingsPath(), "GET"))).toEqual([])
  })

  /** What this node's Claude offers, as its capability publish stores it. */
  async function offerModels(ids: string[]) {
    const models = JSON.stringify(ids.map((id) => ({ id, label: id })))
    await sql`INSERT INTO kernel.node_capabilities (node_id, org_id, owner_user_id, models)
      VALUES (${node.nodeId}, ${owner.orgId}, ${owner.userId}, ${models}::jsonb)
      ON CONFLICT (node_id) DO UPDATE SET models = excluded.models`
  }

  it("the chat's model is one its node offers; anything else is refused, never stored", async () => {
    await offerModels(["claude-opus-5-5", "claude-haiku-4-5"])
    const notOffered = await call(owner, settingsPath(), "PUT", {
      agentId,
      runsOn: "node",
      nodeId: node.nodeId,
      model: "claude-opus-9",
    })
    expect(notOffered.status).toBe(422)
    expect(((await notOffered.json()) as { error: { code: string } }).error.code).toBe(
      "model_not_offered",
    )
    // Not a model id at all: refused by the schema before anything is read.
    for (const model of ["gpt-5", "claude-opus; rm -rf ~", "--dangerously-skip-permissions"]) {
      const bad = await call(owner, settingsPath(), "PUT", { agentId, runsOn: "node", model })
      expect(bad.status).toBe(400)
    }
    expect(await data(await call(owner, settingsPath(), "GET"))).toEqual([])

    const ok = await call(owner, settingsPath(), "PUT", {
      agentId,
      runsOn: "node",
      nodeId: node.nodeId,
      model: "claude-opus-5-5",
    })
    expect(ok.status).toBe(200)
    expect(await data(ok)).toMatchObject({ model: "claude-opus-5-5", nodeId: node.nodeId })
    // A later change that names no model keeps it; null puts the agent's back.
    const mode = await call(owner, settingsPath(), "PUT", {
      agentId,
      runsOn: "node",
      permissionMode: "plan",
    })
    expect(await data(mode)).toMatchObject({ model: "claude-opus-5-5", permissionMode: "plan" })
    const cleared = await call(owner, settingsPath(), "PUT", {
      agentId,
      runsOn: "node",
      model: null,
    })
    expect((await data(cleared)).model).toBeNull()
    // The column holds model ids only, whoever writes it.
    expect(
      await rejects(
        async () =>
          await sql`UPDATE kernel.thread_node_settings SET model = 'gpt-5' WHERE thread_id = ${threadId}`,
      ),
    ).toBe(true)
  })

  it("an interactive job claims with the model picked for the conversation", async () => {
    await offerModels(["claude-opus-5-5", "claude-haiku-4-5"])
    await call(owner, settingsPath(), "PUT", {
      agentId,
      runsOn: "node",
      nodeId: node.nodeId,
      model: "claude-opus-5-5",
    })
    await post(owner, "refactor the parser")
    const [job] = await jobs()
    const claimed = await data(
      await call(owner, `/api/nodes/jobs/${job.id}/claim`, "POST", {}, node.credential),
    )
    expect(claimed.job.agentModel).toBe("claude-opus-5-5")
  })

  it("the node owner's own message becomes an interactive job; nothing runs in the cloud", async () => {
    await call(owner, settingsPath(), "PUT", { agentId, runsOn: "node", permissionMode: "edit" })
    await sql`UPDATE kernel.thread_node_settings SET sdk_session_id = 'sess-1' WHERE thread_id = ${threadId}`
    const sent = await post(owner, "refactor the parser")
    expect(sent.dispatchedAgentIds).toEqual([agentId])
    await Bun.sleep(50)
    expect(streamCalls).toBe(0)
    const [job] = await jobs()
    expect(job).toMatchObject({
      kind: "interactive",
      source: "chat",
      permission_mode: "edit",
      sdk_session_id: "sess-1",
      source_ref: sent.messageId,
      thread_id: threadId,
    })
    expect(job.prompt).toContain("refactor the parser")
  })

  // D29 froze My node chat: an interactive job for an offline node still tells
  // its owner (the offline notice), unlike sessions, which show queued in
  // Sessions with no push (L19).
  it("an interactive job for an offline node tells its owner the computer is offline", async () => {
    await call(owner, settingsPath(), "PUT", { agentId, runsOn: "node", permissionMode: "edit" })
    await post(owner, "refactor the parser")
    const [job] = await sql<Array<{ kind: string; backlog: boolean }>>`
      SELECT kind, backlog FROM kernel.node_jobs WHERE org_id = ${owner.orgId}`
    expect(job).toEqual({ kind: "interactive", backlog: true })
    const events = await sql<Array<{ payload: Record<string, any> }>>`
      SELECT payload FROM kernel.pending_events
       WHERE org_id = ${owner.orgId} AND payload->>'entity' = 'agent_notification'`
    const offline = events.filter((e) => e.payload.data?.nodeOffline === true)
    expect(offline).toHaveLength(1)
    expect(offline[0].payload.data.targetUserIds).toEqual([owner.userId])
    expect(offline[0].payload.data.summary).toBe("Your computer is offline; 1 job waiting.")
    expect(offline[0].payload.data.link).toEqual({ tabType: "thread", entityId: threadId })
  })

  it("someone else's message in the same node-mode thread runs in the cloud", async () => {
    await call(owner, settingsPath(), "PUT", { agentId, runsOn: "node", permissionMode: "auto" })
    const sent = await post(member, "what does the parser do?")
    expect(sent.dispatchedAgentIds).toEqual([agentId])
    const deadline = Date.now() + 5000
    while (streamCalls === 0 && Date.now() < deadline) await Bun.sleep(25)
    expect(streamCalls).toBe(1)
    expect(await jobs()).toHaveLength(0)
  })

  it("the result's SDK session id is kept and the next interactive job resumes it", async () => {
    await call(owner, settingsPath(), "PUT", { agentId, runsOn: "node", permissionMode: "manual" })
    await post(owner, "first")
    const [first] = await jobs()
    expect(first.sdk_session_id).toBeNull()
    const { leaseGeneration } = await data(
      await call(owner, `/api/nodes/jobs/${first.id}/claim`, "POST", {}, node.credential),
    )
    const res = await call(
      owner,
      `/api/nodes/jobs/${first.id}/result`,
      "POST",
      { leaseGeneration, text: "Done.", sdkSessionId: "sess-abc" },
      node.credential,
    )
    expect(res.status).toBe(201)
    await post(owner, "second")
    const second = (await jobs())[1]
    expect(second.sdk_session_id).toBe("sess-abc")
  })

  it("a remote permission prompt is an owner approval card: allow, and denied after 10 minutes", async () => {
    await call(owner, settingsPath(), "PUT", { agentId, runsOn: "node", permissionMode: "manual" })
    await post(owner, "run the migrations")
    const [job] = await jobs()
    const { leaseGeneration } = await data(
      await call(owner, `/api/nodes/jobs/${job.id}/claim`, "POST", {}, node.credential),
    )
    const ask = (toolName: string) =>
      call(
        owner,
        `/api/nodes/jobs/${job.id}/permission-requests`,
        "POST",
        { leaseGeneration, toolName, summary: "bun run db:migrate" },
        node.credential,
      )
    const first = await ask("Bash")
    expect(first.status).toBe(201)
    const prompt = await data(first)
    expect(prompt.status).toBe("pending")
    const events = await sql<Array<{ payload: Record<string, any> }>>`
      SELECT payload FROM kernel.pending_events
       WHERE org_id = ${owner.orgId} AND payload->>'entity' = 'agent_notification'`
    const card = events.find((e) => e.payload.data?.nodePermissionPromptId === prompt.id)
    expect(card?.payload.data.targetUserIds).toEqual([owner.userId])
    expect(card?.payload.data.actions).toEqual(["allow", "deny"])
    // What the owner's card shows: what is asked, by which agent, from which node.
    expect(card?.payload.data.nodePermission).toMatchObject({
      promptId: prompt.id,
      jobId: job.id,
      nodeName: expect.any(String),
      toolName: "Bash",
      summary: "bun run db:migrate",
    })
    expect(card?.payload.data.summary).toContain("Bash")

    // Nobody else can see or answer it.
    expect((await call(member, `/api/nodes/permission-requests/${prompt.id}`, "GET")).status).toBe(
      404,
    )
    expect(
      (
        await call(member, `/api/nodes/permission-requests/${prompt.id}/decision`, "POST", {
          allow: true,
        })
      ).status,
    ).toBe(404)
    const decided = await call(
      owner,
      `/api/nodes/permission-requests/${prompt.id}/decision`,
      "POST",
      { allow: true },
    )
    expect(decided.status).toBe(200)
    expect(
      (await data(await call(owner, `/api/nodes/permission-requests/${prompt.id}`, "GET"))).status,
    ).toBe("allowed")

    const second = await data(await ask("Write"))
    await sql`UPDATE kernel.node_permission_prompts
      SET created_at = now() - interval '11 minutes', expires_at = now() - interval '1 minute'
      WHERE id = ${second.id}`
    expect(
      (await data(await call(owner, `/api/nodes/permission-requests/${second.id}`, "GET"))).status,
    ).toBe("denied")
    expect(
      (
        await call(owner, `/api/nodes/permission-requests/${second.id}/decision`, "POST", {
          allow: true,
        })
      ).status,
    ).toBe(409)
  })

  it("an unattended job never relays a permission prompt", async () => {
    const job = await createNodeJob({
      orgId: owner.orgId,
      ownerUserId: owner.userId,
      agentId,
      threadId,
      source: "chat",
      prompt: "p",
      sourceRequiredScopes: [],
    })
    const { leaseGeneration } = await data(
      await call(owner, `/api/nodes/jobs/${job.id}/claim`, "POST", {}, node.credential),
    )
    const res = await call(
      owner,
      `/api/nodes/jobs/${job.id}/permission-requests`,
      "POST",
      { leaseGeneration, toolName: "Bash", summary: "rm -rf" },
      node.credential,
    )
    expect(res.status).toBe(409)
  })
})
