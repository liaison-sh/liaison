// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Once an agent's gated call is approved and its result posted, the agent that
// proposed it answers from the result, once, without the person writing again.
//
// Live, a personal agent's gated read was approved 18 seconds after the agent
// said it needed approval; the platform posted the approval and the result,
// and the conversation then stayed silent until the person wrote again. Here
// the gated call is a projected MCP tool on a loopback MCP server, proposed
// inside an agent turn's frame, decided through decideApproval (which runs the
// real call), and the handed-back turn runs through the real
// invokeAgentForThread with a scripted model that records what it is sent.
import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test"
import crypto from "node:crypto"

const enqueued: Array<{ jobName: string; payload: Record<string, unknown> }> = []
const realJobs = await import("~/infra/jobs/jobs")
const realJobsModule = { ...realJobs }
mock.module("~/infra/jobs/jobs", () => ({
  ...realJobsModule,
  enqueueAppJob: async (_app: string, jobName: string, payload: Record<string, unknown>) => {
    enqueued.push({ jobName, payload })
    return "job-id"
  },
}))
// mock.module outlives this file: put the real jobs module back for later files.
afterAll(() => {
  mock.module("~/infra/jobs/jobs", () => realJobsModule)
})

const { Hono } = await import("hono")
const { mcpManagerRoutes } = await import("~/apps/mcp-manager/routes")
const { buildMcpWorld } = await import("~/apps/mcp-manager/test-helpers/world")
const { sql } = await import("~/db")
const { withPrivilegedDb } = await import("~/db/privileged")
const { threadParticipants, threads } = await import("~/db/schema/kernel")
const { errorHandler } = await import("~/middleware/error-handler")
const { getOrCreatePersonalAgentId } = await import("~/modules/agent/directory/personal-agent")
const { AgentServiceTestAccess } = await import("~/modules/agent/runtime/agent-service")
const { runContextStore } = await import("~/modules/agent/runtime/run-context")
const { createTurnScopeAccumulator } = await import("~/modules/agent/scopes/turn-scope-accumulator")
const { APPROVAL_RESULT_TURN_JOB, runApprovalResultTurn } = await import(
  "~/modules/approvals/approval-result-turn"
)
const { decideApproval } = await import("~/modules/approvals/decide")
const { approvalPayloadHash } = await import("~/modules/approvals/payload-hash")
const { executeTool } = await import("~/modules/apps/execute-tool")
const { initMcpClient, McpClientTestAccess } = await import("~/modules/mcp-client/index")
const { startFixtureHttpMcpServer } = await import(
  "~/modules/mcp-client/transports/fixtures/http-mcp-server"
)
const { loadEffectivePermissions } = await import("~/modules/permissions/permissions")
const { acquireTestLock, releaseTestLock } = await import("~/tests/route-test-setup")

import type { AppEnv } from "~/app"
import type { UserContext } from "~/db/rls"
import type { ApprovalResultTurnPayload } from "~/modules/approvals/approval-result-turn"

const ORIG_ANTHROPIC_KEY = process.env.LIAISON_ANTHROPIC_API_KEY
const ORIG_ALLOW = process.env.LIAISON_E2E_ALLOW_PRIVATE_MCP
const MODEL_ID = "claude-haiku-4-5-approved-resume"

/** The messages each scripted model call was sent, in order. */
const modelRequests: unknown[] = []

function recordingStreamText(opts: { messages?: unknown }) {
  modelRequests.push(opts.messages)
  return {
    fullStream: (async function* () {
      yield { type: "text-delta", text: "The rack is 899 EUR." }
      yield {
        type: "finish-step",
        usage: { inputTokens: 10, outputTokens: 5 },
        finishReason: "stop",
      }
      yield { type: "finish", finishReason: "stop" }
    })(),
  } as never
}

function appAs(actor: UserContext) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("userId", actor.userId)
    c.set("orgId", actor.orgId)
    c.set("scopes", actor.scopes as never)
    c.set("dimensionGrants", actor.dimensionGrants ?? {})
    await next()
  })
  app.route("/apps/mcp-manager", mcpManagerRoutes)
  app.onError(errorHandler)
  return app
}

describe("an approved gated call hands the turn back to the agent that proposed it", () => {
  let world: Awaited<ReturnType<typeof buildMcpWorld>>
  let fixture: Awaited<ReturnType<typeof startFixtureHttpMcpServer>>
  let admin: UserContext
  let agentId: string
  let slug: string

  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_E2E_ALLOW_PRIVATE_MCP = "1"
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    AgentServiceTestAccess.setStreamText(recordingStreamText as never)
    McpClientTestAccess.reset()
    await initMcpClient({ skipEnvBootstrap: true, skipReapTimer: true })
    fixture = await startFixtureHttpMcpServer()
    // The person may call the server's tools (an org connection's tools need a grant).
    world = await buildMcpWorld({ adminScopes: ["mcp:*"] })
    const orgId = world.org.id
    await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency)
      VALUES (${orgId}, '10.00000000', '0', 'EUR')
      ON CONFLICT (org_id) DO UPDATE SET included_balance = '10.00000000'`
    await sql`INSERT INTO kernel.model_pricing (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum)
      VALUES ('anthropic', ${MODEL_ID}, 'Claude Haiku Approved Resume', '1.00', '5.00', 200000, true, 'starter')
      ON CONFLICT DO NOTHING`
    const perms = await withPrivilegedDb(orgId, "approved-resume-perms", (tx) =>
      loadEffectivePermissions(tx, world.admin.userId, orgId),
    )
    admin = { ...world.admin, scopes: perms.scopes }
    agentId = await withPrivilegedDb(orgId, "approved-resume-agent", (tx) =>
      getOrCreatePersonalAgentId(tx, { orgId, userId: admin.userId }),
    )

    // A gate_writes connection to the loopback server, dialed once so its
    // tools are projected (gated) into the registry.
    slug = `rack-${crypto.randomUUID().slice(0, 6)}`
    const created = await appAs(admin).request("/apps/mcp-manager/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug,
        displayName: "Catalogue",
        transport: "http",
        httpUrl: fixture.url,
        authFlavor: "none",
        connectionDefaultPolicy: "gate_writes",
      }),
    })
    expect(created.status).toBe(200)
    const { id } = (await created.json()) as { id: string }
    const dialed = await appAs(admin).request(`/apps/mcp-manager/connections/${id}/test`, {
      method: "POST",
    })
    expect(((await dialed.json()) as { ok: boolean }).ok).toBe(true)
  })

  afterAll(async () => {
    AgentServiceTestAccess.setStreamText()
    McpClientTestAccess.reset()
    await fixture?.close()
    await sql`DELETE FROM kernel.model_pricing WHERE model_id = ${MODEL_ID}`
    if (ORIG_ANTHROPIC_KEY !== undefined) process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
    else delete process.env.LIAISON_ANTHROPIC_API_KEY
    if (ORIG_ALLOW !== undefined) process.env.LIAISON_E2E_ALLOW_PRIVATE_MCP = ORIG_ALLOW
    else delete process.env.LIAISON_E2E_ALLOW_PRIVATE_MCP
    await releaseTestLock()
  })

  /** A fresh conversation in which the agent's turn proposed one gated call. */
  async function propose(
    answer: string,
    routineId?: string,
    turn: { askId?: string; personWroteFirst?: boolean; threadId?: string } = {},
  ): Promise<{ threadId: string; approvalId: string; askMessageId?: string }> {
    const orgId = world.org.id
    const threadId =
      turn.threadId ??
      (await withPrivilegedDb(orgId, "approved-resume-thread", async (tx) => {
        const [t] = await tx
          .insert(threads)
          .values({
            orgId,
            handle: `rs-${crypto.randomUUID().slice(0, 8)}`,
            type: "agent_chat",
            createdBy: admin.userId,
          })
          .returning({ id: threads.id })
        await tx.insert(threadParticipants).values({ threadId: t.id, userId: admin.userId, orgId })
        return t.id
      }))
    // The person's question the proposing turn answered, written before the call.
    let askMessageId: string | undefined
    if (turn.personWroteFirst) {
      const [ask] = await sql<{ id: string }[]>`INSERT INTO kernel.messages
        (org_id, thread_id, author_id, author_type, content, required_scopes, created_at)
        VALUES (${orgId}, ${threadId}, ${admin.userId}, 'user', 'what does the rack cost?', '{}',
                now() - interval '1 second')
        RETURNING id`
      askMessageId = ask.id
    }
    const proposed = await runContextStore.run(
      {
        runId: crypto.randomUUID(),
        parentRunId: null,
        rootRunId: crypto.randomUUID(),
        nestingDepth: 0,
        effectiveScope: admin.scopes as string[],
        turnScopeAccumulator: createTurnScopeAccumulator(),
        agentId,
        agentCeiling: admin.scopes as string[],
        ...(routineId ? { routineId } : {}),
        ...(turn.askId ? { askId: turn.askId } : {}),
      },
      () =>
        executeTool({
          toolName: `mcp:${slug}:echo`,
          orgId,
          actor: admin,
          params: { message: answer },
          threadId,
          origin: "in-app-agent",
        }),
    )
    const approvalId = proposed.blocked?.approvalRequestId
    expect(approvalId).toBeString()
    return { threadId, approvalId: approvalId!, ...(askMessageId ? { askMessageId } : {}) }
  }

  async function decide(approvalId: string, decision: "approve" | "deny") {
    const [row] =
      await sql`SELECT tool_name, current_payload FROM kernel.approval_requests WHERE id = ${approvalId}`
    return decideApproval({
      orgId: world.org.id,
      requestId: approvalId,
      actor: admin,
      decision,
      payloadHash: approvalPayloadHash(row.tool_name as string, row.current_payload),
    })
  }

  function resumeJobs(approvalId: string) {
    return enqueued.filter(
      (e) => e.jobName === APPROVAL_RESULT_TURN_JOB && e.payload.approvalId === approvalId,
    )
  }

  async function agentReplies(threadId: string): Promise<number> {
    const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM kernel.messages
      WHERE thread_id = ${threadId} AND author_type = 'agent'`
    return row.n
  }

  it("approve: exactly one agent turn runs, and it is handed the call's result", async () => {
    const answer = `Modular Synth Rack 6U, price 899 EUR, ref ${crypto.randomUUID().slice(0, 8)}`
    const { threadId, approvalId } = await propose(answer)
    enqueued.length = 0
    const decided = await decide(approvalId, "approve")
    expect((decided as { status?: string }).status).toBe("approved")

    // The approved re-entry hands the turn back: one job, for the proposing agent.
    const jobs = resumeJobs(approvalId)
    expect(jobs.length).toBe(1)
    const payload = jobs[0]!.payload as unknown as ApprovalResultTurnPayload
    expect(payload.threadId).toBe(threadId)
    expect(payload.agentId).toBe(agentId)
    expect(payload.requesterId).toBe(admin.userId)

    modelRequests.length = 0
    expect(await runApprovalResultTurn(payload)).toBe(true)
    expect(modelRequests.length).toBe(1)
    const sent = JSON.stringify(modelRequests[0])
    expect(sent).toContain(answer)
    // Fenced as untrusted tool output, with the instruction to answer from it.
    expect(sent).toContain("untrusted")
    expect(sent).toContain("Answer from it")
    expect(await agentReplies(threadId)).toBe(1)
    // No visible user message was written to start it.
    const [users] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM kernel.messages
      WHERE thread_id = ${threadId} AND author_type = 'user'`
    expect(users.n).toBe(0)

    // A second decide, a replayed job: still exactly one turn.
    await decide(approvalId, "approve").catch(() => undefined)
    expect(resumeJobs(approvalId).length).toBe(1)
    modelRequests.length = 0
    expect(await runApprovalResultTurn(payload)).toBe(false)
    expect(modelRequests.length).toBe(0)
    expect(await agentReplies(threadId)).toBe(1)
  })

  /** The handed-back turn's answer and the result row that started it. */
  async function answerAfterApproval(threadId: string, approvalId: string) {
    const [answer] = await sql<{ turn_id: string | null; ask_id: string | null }[]>`
      SELECT metadata->>'turnId' AS turn_id, metadata->>'askId' AS ask_id
      FROM kernel.messages WHERE thread_id = ${threadId} AND author_type = 'agent'`
    const [resultRow] = await sql<{ id: string }[]>`SELECT id FROM kernel.messages
      WHERE thread_id = ${threadId} AND metadata->>'type' = 'approval-result'
        AND metadata->>'requestId' = ${approvalId}`
    return { answer, resultRowId: resultRow?.id }
  }

  it("the answer names the person's question, not the result row that started its turn", async () => {
    const askId = crypto.randomUUID()
    const { threadId, approvalId } = await propose(
      `Rack ref ${crypto.randomUUID().slice(0, 8)}`,
      undefined,
      { askId },
    )
    // Recorded on the approval at the moment the call parked.
    const [row] =
      await sql`SELECT metadata->>'askId' AS a FROM kernel.approval_requests WHERE id = ${approvalId}`
    expect(row.a).toBe(askId)
    enqueued.length = 0
    await decide(approvalId, "approve")
    const payload = resumeJobs(approvalId)[0]!.payload as unknown as ApprovalResultTurnPayload
    expect(await runApprovalResultTurn(payload)).toBe(true)
    const { answer, resultRowId } = await answerAfterApproval(threadId, approvalId)
    expect(resultRowId).toBeString()
    // The trigger is unchanged (replay and Share anyway read it)...
    expect(answer.turn_id).toBe(resultRowId!)
    // ...and the answer carries the ask it continues.
    expect(answer.ask_id).toBe(askId)
  })

  it("an approval recorded without the ask falls back to the person's last message before it", async () => {
    const { threadId, approvalId, askMessageId } = await propose(
      `Rack ref ${crypto.randomUUID().slice(0, 8)}`,
      undefined,
      { personWroteFirst: true },
    )
    const [row] =
      await sql`SELECT metadata ? 'askId' AS has FROM kernel.approval_requests WHERE id = ${approvalId}`
    expect(row.has).toBe(false)
    enqueued.length = 0
    await decide(approvalId, "approve")
    const payload = resumeJobs(approvalId)[0]!.payload as unknown as ApprovalResultTurnPayload
    expect(await runApprovalResultTurn(payload)).toBe(true)
    const { answer } = await answerAfterApproval(threadId, approvalId)
    expect(answer.ask_id).toBe(askMessageId!)
  })

  it("the same job delivered twice before the agent answers still runs one turn", async () => {
    const { approvalId } = await propose(`Rack ref ${crypto.randomUUID().slice(0, 8)}`)
    enqueued.length = 0
    await decide(approvalId, "approve")
    const payload = resumeJobs(approvalId)[0]!.payload as unknown as ApprovalResultTurnPayload
    modelRequests.length = 0
    const ran = await Promise.all([runApprovalResultTurn(payload), runApprovalResultTurn(payload)])
    expect(ran.filter(Boolean).length).toBe(1)
    expect(modelRequests.length).toBe(1)
  })

  it("calls one turn parked together hand back one turn, from the last result", async () => {
    const askId = crypto.randomUUID()
    const first = `Rack ref ${crypto.randomUUID().slice(0, 8)}`
    const second = `Case ref ${crypto.randomUUID().slice(0, 8)}`
    const a = await propose(first, undefined, { askId })
    const b = await propose(second, undefined, { askId, threadId: a.threadId })
    enqueued.length = 0
    await decide(a.approvalId, "approve")
    // Its sibling is still undecided: the first result waits for it.
    modelRequests.length = 0
    const pa = resumeJobs(a.approvalId)[0]!.payload as unknown as ApprovalResultTurnPayload
    expect(await runApprovalResultTurn(pa)).toBe(false)
    expect(modelRequests.length).toBe(0)
    await decide(b.approvalId, "approve")
    const pb = resumeJobs(b.approvalId)[0]!.payload as unknown as ApprovalResultTurnPayload
    // A replay of the first job, now that both ran: the later result answers, not it.
    expect(await runApprovalResultTurn(pa)).toBe(false)
    expect(await runApprovalResultTurn(pb)).toBe(true)
    expect(modelRequests.length).toBe(1)
    const sent = JSON.stringify(modelRequests[0])
    expect(sent).toContain(first)
    expect(sent).toContain(second)
    expect(await agentReplies(a.threadId)).toBe(1)
  })

  it("the turn's last call refused: its approved sibling hands the turn back", async () => {
    const askId = crypto.randomUUID()
    const first = `Rack ref ${crypto.randomUUID().slice(0, 8)}`
    const a = await propose(first, undefined, { askId })
    const b = await propose(`Case ref ${crypto.randomUUID().slice(0, 8)}`, undefined, {
      askId,
      threadId: a.threadId,
    })
    enqueued.length = 0
    await decide(a.approvalId, "approve")
    const pa = resumeJobs(a.approvalId)[0]!.payload as unknown as ApprovalResultTurnPayload
    expect(await runApprovalResultTurn(pa)).toBe(false)
    await decide(b.approvalId, "deny")
    // The approved sibling is handed the turn again, under its own new job id.
    const again = resumeJobs(a.approvalId)
    expect(again.length).toBe(2)
    modelRequests.length = 0
    expect(
      await runApprovalResultTurn(again[1]!.payload as unknown as ApprovalResultTurnPayload),
    ).toBe(true)
    expect(modelRequests.length).toBe(1)
    expect(JSON.stringify(modelRequests[0])).toContain(first)
    expect(await agentReplies(a.threadId)).toBe(1)
  })

  it("deny: no turn is handed back", async () => {
    const { threadId, approvalId } = await propose(`Rack ref ${crypto.randomUUID().slice(0, 8)}`)
    enqueued.length = 0
    await decide(approvalId, "deny")
    expect(resumeJobs(approvalId).length).toBe(0)
    expect(enqueued.filter((e) => e.jobName === APPROVAL_RESULT_TURN_JOB).length).toBe(0)
    expect(await agentReplies(threadId)).toBe(0)
  })

  it("a routine's gated call takes the same job, for its run: no chat turn is started", async () => {
    const routineId = crypto.randomUUID()
    const { approvalId } = await propose(`Rack ref ${crypto.randomUUID().slice(0, 8)}`, routineId)
    const [row] =
      await sql`SELECT metadata->>'originRoutineId' AS r FROM kernel.approval_requests WHERE id = ${approvalId}`
    expect(row.r).toBe(routineId)
    enqueued.length = 0
    const decided = await decide(approvalId, "approve")
    expect((decided as { status?: string }).status).toBe("approved")
    // The job carries the routine: its run resumes there (routine-run-resume.ts).
    const jobs = resumeJobs(approvalId)
    expect(jobs.length).toBe(1)
    expect(jobs[0]!.payload.routineId).toBe(routineId)
    // No run of that routine waits on it: nothing happens, and never a chat turn.
    modelRequests.length = 0
    expect(
      await runApprovalResultTurn(jobs[0]!.payload as unknown as ApprovalResultTurnPayload),
    ).toBe(false)
    expect(modelRequests.length).toBe(0)
  })

  it("the person wrote after the decision: their own turn answers, no second one", async () => {
    const { threadId, approvalId } = await propose(`Rack ref ${crypto.randomUUID().slice(0, 8)}`)
    enqueued.length = 0
    await decide(approvalId, "approve")
    const payload = resumeJobs(approvalId)[0]!.payload as unknown as ApprovalResultTurnPayload
    await sql`INSERT INTO kernel.messages (org_id, thread_id, author_id, author_type, content, required_scopes, created_at)
      VALUES (${world.org.id}, ${threadId}, ${admin.userId}, 'user', 'so what did it say?', '{}',
              now() + interval '1 second')`
    modelRequests.length = 0
    expect(await runApprovalResultTurn(payload)).toBe(false)
    expect(modelRequests.length).toBe(0)
    expect(await agentReplies(threadId)).toBe(0)
  })
})
