// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P4 N-S T3 (S21, S25, A17, A50/F14): requests that go to a node.
//
//  - `agents_ask` of an agent attached to someone's node, from a requester the
//    attachment allows, creates an `agent_tag` job on that node and returns at
//    once with `status: "queued"`, the job id and where it runs, plus an
//    instruction that says what "queued" obliges. Any other requester gets
//    today's synchronous answer (P5 S27 stays synchronous).
//  - An @mention of that agent in a posted message does the same.
//  - A daily cap reached refuses the request in words.
//  - `run_on_my_computer` hands the current request to the person's own node.
//
// Real rows throughout; the only stub is the model stream of a cloud turn.
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { AgentServiceTestAccess } from "~/modules/agent/runtime/agent-service"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import {
  CoordinationToolsTestAccess,
  handleAgentsAsk,
  QUEUED_INSTRUCTION,
  RELAY_INSTRUCTION,
} from "~/modules/agent/tools/coordination-tools"
import { registerKernelAgentTools } from "~/modules/agent/tools/kernel-tools"
import { toolRegistry } from "~/modules/apps/app-registries"
import { DISPATCH_REFUSAL_LINES } from "~/modules/threads/agent-dispatch-guard"
import { dispatchForPostedMessage } from "~/modules/threads/posted-message-dispatch"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import * as jobsModule from "./jobs"
import { handleRunOnMyComputer } from "./run-on-my-computer"

const ORG = crypto.randomUUID()
const USER = crypto.randomUUID() // the person whose agent asks
const OWNER = crypto.randomUUID() // the node owner
const STRANGER = crypto.randomUUID() // no node
const CALLER = crypto.randomUUID() // the asking agent (allowed)
const OUTSIDER = crypto.randomUUID() // an asking agent the attachment does not list
const FIXER = crypto.randomUUID() // the attached agent
const PERSONAL = crypto.randomUUID() // the node owner's personal agent
const tag = ORG.slice(0, 8)
let THREAD = ""
let ATTACHMENT = ""
const ANSWER = "the cloud answered this one"
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

const actorOf = (userId: string): UserContext => ({
  actorType: "user",
  userId,
  orgId: ORG,
  scopes: ["*"],
  dimensionGrants: {},
})

function frameFor(agentId: string): RunContext {
  const runId = crypto.randomUUID()
  return {
    runId,
    parentRunId: null,
    rootRunId: runId,
    nestingDepth: 0,
    agentId,
    agentCeiling: ["*"],
    effectiveScope: ["*"],
    turnScopeAccumulator: createTurnScopeAccumulator(),
  }
}

async function ask(callerAgentId: string, question: string) {
  return withRlsContext(actorOf(USER), (tx) =>
    runContextStore.run(frameFor(callerAgentId), () =>
      handleAgentsAsk(
        { agentHandle: `@fixer-${tag}`, question },
        {
          userId: USER,
          orgId: ORG,
          db: tx,
          agentExecutionThreadId: THREAD,
          scopes: ["*"],
          actingAgentId: callerAgentId,
        },
      ),
    ),
  )
}

const jobs = () =>
  sql<
    Array<{
      id: string
      source: string
      owner_user_id: string
      agent_id: string
      thread_id: string
      reply_thread_id: string | null
      reply_message_id: string | null
      requester_user_id: string | null
      requester_agent_id: string | null
      prompt: string
      trigger: Record<string, unknown> | null
      status: string
      backlog: boolean
    }>
  >`SELECT id, source, owner_user_id, agent_id, thread_id, reply_thread_id, reply_message_id,
           requester_user_id, requester_agent_id, prompt, trigger, status, backlog
      FROM kernel.node_jobs WHERE org_id = ${ORG} ORDER BY created_at`

beforeAll(async () => {
  await acquireTestLock()
  AgentServiceTestAccess.setStreamText(fakeStream as never)
  CoordinationToolsTestAccess.setAgentAskWait(10_000)
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Node Org', ${`p4-t3-${tag}`})`
  for (const [id, name] of [
    [USER, "Uma"],
    [OWNER, "Olive"],
    [STRANGER, "Sam"],
  ]) {
    await sql`INSERT INTO kernel.users (id, org_id, email, name)
      VALUES (${id}, ${ORG}, ${`p4-t3-${name}-${tag}@t.com`}, ${name})`
  }
  for (const [id, handle, name] of [
    [CALLER, `@support-${tag}`, "Support"],
    [OUTSIDER, `@sales-${tag}`, "Sales"],
    [FIXER, `@fixer-${tag}`, "Bug Fixer"],
  ]) {
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling)
      VALUES (${id}, ${ORG}, 'role', ${handle}, ${name}, '["*"]'::jsonb)`
  }
  await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling, owner_user_id)
    VALUES (${PERSONAL}, ${ORG}, 'personal', ${`@olive-${tag}`}, 'Olive', '["*"]'::jsonb, ${OWNER})`
  await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency)
    VALUES (${ORG}, '10.00000000', '5.00000000', 'EUR')`
  await sql`INSERT INTO kernel.model_pricing
      (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum)
    VALUES ('anthropic', 'claude-haiku-4-5', 'Claude Haiku 4.5', '1.00', '5.00', 200000, true, 'starter')
    ON CONFLICT (provider, model_id) DO NOTHING`
  const [t] = await sql<{ id: string }[]>`
    INSERT INTO kernel.threads (org_id, handle, type, agent_model_id, created_by)
    VALUES (${ORG}, ${`p4-t3-${tag}`}, 'thread', 'claude-haiku-4-5', ${USER}) RETURNING id`
  THREAD = t.id
  for (const u of [USER, OWNER]) {
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${THREAD}, ${u}, ${ORG})`
  }
  for (const a of [CALLER, OUTSIDER]) {
    await sql`INSERT INTO kernel.thread_participants (thread_id, agent_id, org_id, participant_type)
      VALUES (${THREAD}, ${a}, ${ORG}, 'agent')`
  }
  // Olive's node (offline: no live connection in this file) and her attachment
  // of Bug Fixer, allowed by an admin, listing @support as a requester.
  await sql`INSERT INTO kernel.nodes (org_id, owner_user_id, device_id, name)
    VALUES (${ORG}, ${OWNER}, ${`d.${tag}`}, 'Olive''s Mac')`
  const [att] = await sql<{ id: string }[]>`
    INSERT INTO kernel.node_attachments (org_id, node_owner_user_id, agent_id, allowed_requesters,
                                         agent_allowed_by, agent_allowed_at)
    VALUES (${ORG}, ${OWNER}, ${FIXER}, ${JSON.stringify([{ type: "agent", id: CALLER }])}::jsonb,
            ${OWNER}, now())
    RETURNING id`
  ATTACHMENT = att.id
  await registerKernelAgentTools(ORG)
})

beforeEach(async () => {
  streamCalls = 0
  await sql`DELETE FROM kernel.node_jobs WHERE org_id = ${ORG}`
  await sql`UPDATE kernel.node_attachments SET max_jobs_per_day = 10 WHERE id = ${ATTACHMENT}`
})

afterAll(async () => {
  AgentServiceTestAccess.setStreamText()
  CoordinationToolsTestAccess.setAgentAskWait()
  await sql`DELETE FROM kernel.node_jobs WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.node_attachments WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.nodes WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.pending_events WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.user_thread_state WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.credit_transactions WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.credit_balances WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  await releaseTestLock()
})

describe("agent_tag routing (A17)", () => {
  it("agents_ask of an attached agent from an allowed requester returns a queued receipt at once", async () => {
    const res = await ask(CALLER, "Bug #42: the export button crashes. Please fix it.")
    expect(res.asked).toBe(true)
    expect(res.status).toBe("queued")
    expect(res.on).toBe("Olive's computer")
    expect(res.answer ?? null).toBeNull()
    expect(res.instruction).toBe(QUEUED_INSTRUCTION)
    // No cloud turn ran for the attached agent.
    expect(streamCalls).toBe(0)
    const [job] = await jobs()
    expect(res.jobId).toBe(job.id)
    expect(job.source).toBe("agent_tag")
    expect(job.owner_user_id).toBe(OWNER)
    expect(job.agent_id).toBe(FIXER)
    expect(job.reply_thread_id).toBe(THREAD)
    expect(job.requester_user_id).toBe(USER)
    expect(job.requester_agent_id).toBe(CALLER)
    expect(job.prompt).toContain("Bug #42")
    expect(job.trigger).toMatchObject({
      askedBy: "Support",
      question: expect.stringContaining("#42"),
    })
    // The result goes to the node owner's own conversation with that agent.
    expect(job.thread_id).not.toBe(THREAD)
    const [dm] = await sql<
      Array<{ type: string }>
    >`SELECT type FROM kernel.threads WHERE id = ${job.thread_id}`
    expect(dm.type).toBe("agent_chat")
    const owners = await sql<Array<{ user_id: string }>>`
      SELECT user_id FROM kernel.thread_participants WHERE thread_id = ${job.thread_id} AND user_id IS NOT NULL`
    expect(owners.map((o) => o.user_id)).toEqual([OWNER])
    // The question it answers is the question row in the asking thread.
    const [q] = await sql<Array<{ content: string }>>`
      SELECT content FROM kernel.messages WHERE id = ${job.reply_message_id}`
    expect(q.content).toContain("Bug #42")
    // Offline node: the job waits, and no offline notification is made (L19):
    // the queued session shows in Sessions.
    expect(job.backlog).toBe(true)
    const events = await sql<Array<{ payload: Record<string, any> }>>`
      SELECT payload FROM kernel.pending_events
       WHERE org_id = ${ORG} AND payload->>'entity' = 'agent_notification'`
    expect(events.some((e) => e.payload.data?.nodeOffline === true)).toBe(false)
  })

  it("an agent_tag job is an isolated session at the agent's profile level", async () => {
    const res = await ask(CALLER, "Bug #51: the import hangs.")
    expect(res.status).toBe("queued")
    const [job] = await jobs()
    const [session] = await sql<
      Array<{ source: string; config_kind: string; model: string; level: string; agent_id: string }>
    >`SELECT source, config_kind, model, level, agent_id FROM kernel.node_sessions
       WHERE job_id = ${job.id}`
    expect(session).toEqual({
      source: "agent_tag",
      config_kind: "isolated",
      model: "default",
      level: "strict",
      agent_id: FIXER,
    })
  })

  it("a routing error on an attached agent is refused in words and never runs in the cloud", async () => {
    const failing = spyOn(jobsModule, "createNodeJob").mockImplementation(async () => {
      throw new Error("the database went away")
    })
    try {
      const res = await ask(CALLER, "Bug #52: the export is empty.")
      expect(res.asked).toBe(false)
      expect(res.reason).toBe("node_routing_failed")
    } finally {
      failing.mockRestore()
    }
    expect(streamCalls).toBe(0)
    expect(await jobs()).toHaveLength(0)
    const lines = await sql<Array<{ content: string; metadata: Record<string, unknown> | null }>>`
      SELECT content, metadata FROM kernel.messages
       WHERE thread_id = ${THREAD} AND metadata->>'nodeRefusal' = 'node_routing_failed'`
    expect(lines).toHaveLength(1)
    expect(lines[0].content).toBe(DISPATCH_REFUSAL_LINES.node_routing_failed)
  })

  it("a requester the attachment does not list gets today's synchronous answer", async () => {
    const res = await ask(OUTSIDER, "Is the export button bug known?")
    expect(res.status).toBeUndefined()
    expect(res.answer).toBe(ANSWER)
    expect(res.instruction).toBe(RELAY_INSTRUCTION)
    expect(streamCalls).toBe(1)
    expect(await jobs()).toHaveLength(0)
  })

  it("a reached daily cap refuses the ask in words, with no job and no cloud turn", async () => {
    await sql`UPDATE kernel.node_attachments SET max_jobs_per_day = 1 WHERE id = ${ATTACHMENT}`
    expect((await ask(CALLER, "First bug report, number 7.")).status).toBe("queued")
    const res = await ask(CALLER, "Second bug report, number 8.")
    expect(res.asked).toBe(false)
    expect(res.reason).toBe("node_daily_cap")
    expect(streamCalls).toBe(0)
    expect(await jobs()).toHaveLength(1)
  })

  it("an @mention of the attached agent by the node owner creates an agent_tag job", async () => {
    const content = `@[Bug Fixer](agent:${FIXER}) the CSV import drops the last row`
    const [msg] = await sql<{ id: string }[]>`
      INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, content, required_scopes, mentions)
      VALUES (${THREAD}, ${ORG}, ${OWNER}, 'user', ${content}, '{}'::text[],
              ${JSON.stringify([{ type: "agent", id: FIXER }])}::jsonb)
      RETURNING id`
    const out = await dispatchForPostedMessage((fn) => withRlsContext(actorOf(OWNER), fn), {
      orgId: ORG,
      threadId: THREAD,
      message: {
        id: msg.id,
        content,
        mentions: [{ type: "agent", id: FIXER }],
        authorName: "Olive",
        threadType: "thread",
      },
      actor: { userId: OWNER, orgId: ORG, scopes: ["*"] },
    })
    expect(out.dispatchedAgentIds).toEqual([FIXER])
    await Bun.sleep(50)
    expect(streamCalls).toBe(0)
    const [job] = await jobs()
    expect(job.source).toBe("agent_tag")
    expect(job.reply_message_id).toBe(msg.id)
    expect(job.requester_user_id).toBe(OWNER)
    expect(job.requester_agent_id).toBeNull()
    // P1-walk D8: the owner's own message is an owner run (S13, D27): only
    // other people's requests are isolated.
    const [session] = await sql<Array<{ config_kind: string }>>`
      SELECT config_kind FROM kernel.node_sessions WHERE job_id = ${job.id}`
    expect(session?.config_kind).toBe("owner")
  })

  it("the node owner's message naming a shared folder runs the attached agent's session in that folder; another requester's does not (walk D24)", async () => {
    await sql`INSERT INTO kernel.node_capabilities (node_id, org_id, owner_user_id, models, shared_folders)
      SELECT id, org_id, owner_user_id, '[{"id":"claude-haiku-4-5-20251001","label":"Haiku 4.5"}]'::jsonb,
             '[{"name":"liaison-walk-sample","path":"/Users/olive/liaison-walk-sample","kind":"root"}]'::jsonb
        FROM kernel.nodes WHERE org_id = ${ORG} AND owner_user_id = ${OWNER}
      ON CONFLICT (node_id) DO UPDATE SET shared_folders = EXCLUDED.shared_folders`
    const content = `@[Bug Fixer](agent:${FIXER}) In liaison-walk-sample, list the files`
    const [msg] = await sql<{ id: string }[]>`
      INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, content, required_scopes, mentions)
      VALUES (${THREAD}, ${ORG}, ${OWNER}, 'user', ${content}, '{}'::text[],
              ${JSON.stringify([{ type: "agent", id: FIXER }])}::jsonb)
      RETURNING id`
    await dispatchForPostedMessage((fn) => withRlsContext(actorOf(OWNER), fn), {
      orgId: ORG,
      threadId: THREAD,
      message: {
        id: msg.id,
        content,
        mentions: [{ type: "agent", id: FIXER }],
        authorName: "Olive",
        threadType: "thread",
      },
      actor: { userId: OWNER, orgId: ORG, scopes: ["*"] },
    })
    await Bun.sleep(50)
    const [job] = await jobs()
    expect(job.source).toBe("agent_tag")
    const [session] = await sql<Array<{ folder_name: string | null; folder_path: string | null }>>`
      SELECT folder_name, folder_path FROM kernel.node_sessions WHERE job_id = ${job.id}`
    expect(session).toEqual({
      folder_name: "liaison-walk-sample",
      folder_path: "/Users/olive/liaison-walk-sample",
    })

    // Another requester's ask names the same folder: an isolated run never
    // gets the owner's shared folder from a message.
    await sql`DELETE FROM kernel.node_jobs WHERE org_id = ${ORG}`
    await ask(CALLER, "In liaison-walk-sample, list the files")
    const [other] = await jobs()
    const [isolated] = await sql<Array<{ folder_name: string | null }>>`
      SELECT folder_name FROM kernel.node_sessions WHERE job_id = ${other.id}`
    expect(isolated.folder_name).toBeNull()
  })

  it("the node owner's own messages are not capped like other people's (L30, D8)", async () => {
    await sql`UPDATE kernel.node_attachments SET max_jobs_per_day = 1 WHERE id = ${ATTACHMENT}`
    const post = async (text: string) => {
      const content = `@[Bug Fixer](agent:${FIXER}) ${text}`
      const [msg] = await sql<{ id: string }[]>`
        INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, content, required_scopes, mentions)
        VALUES (${THREAD}, ${ORG}, ${OWNER}, 'user', ${content}, '{}'::text[],
                ${JSON.stringify([{ type: "agent", id: FIXER }])}::jsonb)
        RETURNING id`
      return dispatchForPostedMessage((fn) => withRlsContext(actorOf(OWNER), fn), {
        orgId: ORG,
        threadId: THREAD,
        message: {
          id: msg.id,
          content,
          mentions: [{ type: "agent", id: FIXER }],
          authorName: "Olive",
          threadType: "thread",
        },
        actor: { userId: OWNER, orgId: ORG, scopes: ["*"] },
      })
    }
    await post("first")
    await post("second")
    await Bun.sleep(50)
    expect(await jobs()).toHaveLength(2)
  })
})

describe("run_on_my_computer (S21)", () => {
  async function run(
    userId: string,
    task: string,
    choice: { noFolder?: boolean; model?: string } = {},
  ) {
    return withRlsContext(actorOf(userId), (tx) =>
      runContextStore.run(frameFor(PERSONAL), () =>
        handleRunOnMyComputer(
          { task, ...choice },
          {
            userId,
            orgId: ORG,
            db: tx,
            agentExecutionThreadId: THREAD,
            scopes: ["*"],
            actingAgentId: PERSONAL,
          },
        ),
      ),
    )
  }

  it("hands the request to the person's own node as a dispatch session for this conversation", async () => {
    // P1-T20: a node runs sessions once it published what it offers.
    await sql`INSERT INTO kernel.node_capabilities (node_id, org_id, owner_user_id, models)
      SELECT id, org_id, owner_user_id, '[{"id":"claude-haiku-4-5-20251001","label":"Haiku 4.5"}]'::jsonb
        FROM kernel.nodes WHERE org_id = ${ORG} AND owner_user_id = ${OWNER}
      ON CONFLICT (node_id) DO NOTHING`
    // The person chooses where it works and which model runs it (#62): with
    // neither said the tool asks; here they said both.
    const res = await run(OWNER, "Run the full test suite of my repo and summarise failures", {
      noFolder: true,
      model: "claude-haiku-4-5-20251001",
    })
    expect(res).toMatchObject({ status: "started", on: "Olive's Mac", nodeOnline: false })
    const [job] = await jobs()
    const [session] = await sql<{ id: string }[]>`
      SELECT id FROM kernel.node_sessions WHERE job_id = ${job.id}`
    expect(res.sessionId).toBe(session.id)
    expect(job.source).toBe("dispatch")
    expect(job.owner_user_id).toBe(OWNER)
    expect(job.agent_id).toBe(PERSONAL)
    expect(job.thread_id).toBe(THREAD)
    expect(job.prompt).toBe("Run the full test suite of my repo and summarise failures")
  })

  it("refuses when the person has no node, and creates nothing", async () => {
    const res = await run(STRANGER, "Run it on my computer")
    expect(res.status).toBe("refused")
    expect(res.reason).toBe("no_node")
    expect(await jobs()).toHaveLength(0)
  })

  it("is registered with a description that says when to suggest it and never to route silently", () => {
    const tool = toolRegistry.get([ORG, "kernel", "run_on_my_computer"])
    expect(tool).toBeDefined()
    const d = tool!.description.toLowerCase()
    expect(d).toContain("local")
    expect(d).toContain("budget")
    expect(d).toContain("never")
    expect(d).toContain("on my computer")
  })
})

describe("a personal agent attached to its owner's node", () => {
  // A colleague's personal agent is refused to agents_ask (it acts only for
  // its owner), EXCEPT where the owner attached it to their node and listed
  // the requester: that is the owner saying who may ask it.
  async function askOlive(callerAgentId: string) {
    return withRlsContext(actorOf(USER), (tx) =>
      runContextStore.run(frameFor(callerAgentId), () =>
        handleAgentsAsk(
          { agentHandle: `@olive-${tag}`, question: "Can you rerun the nightly export?" },
          {
            userId: USER,
            orgId: ORG,
            db: tx,
            agentExecutionThreadId: THREAD,
            scopes: ["*"],
            actingAgentId: callerAgentId,
          },
        ),
      ),
    )
  }

  it("routes an allowlisted requester's ask to the node, and refuses one the owner did not list", async () => {
    const [att] = await sql<{ id: string }[]>`
      INSERT INTO kernel.node_attachments (org_id, node_owner_user_id, agent_id, allowed_requesters,
                                           agent_allowed_by, agent_allowed_at)
      VALUES (${ORG}, ${OWNER}, ${PERSONAL}, ${JSON.stringify([{ type: "agent", id: CALLER }])}::jsonb,
              ${OWNER}, now())
      RETURNING id`
    try {
      const routed = await askOlive(CALLER)
      expect(routed.asked).toBe(true)
      expect(routed.status).toBe("queued")
      expect(routed.person).toBeUndefined()
      const [job] = await jobs()
      expect(job.agent_id).toBe(PERSONAL)

      const refused = await askOlive(OUTSIDER)
      expect(refused.asked).toBe(false)
      expect(refused.person?.mention).toBe(`@[Olive](user:${OWNER})`)
    } finally {
      await sql`DELETE FROM kernel.node_jobs WHERE org_id = ${ORG}`
      await sql`DELETE FROM kernel.node_attachments WHERE id = ${att.id}`
    }
  })
})
