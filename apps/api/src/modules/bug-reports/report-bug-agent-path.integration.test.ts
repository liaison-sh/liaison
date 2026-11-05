// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `kernel:report_bug` from an agent, end to end: the agent of a plain member
// (no role grants it any memory or tickets authority; its role agent's ceiling
// names neither) finds the tool, prepares the report, and the member's click
// sends it to the Liaison team, where reports go only there; with that switch
// off the same call files the local ticket. A tainted turn's team-only report
// is judged by its reporter alone, so it never waits in an approval sized for
// the local inbox's readers; a call held before team-only went on ends in the
// reporter's card when approved, and one that can no longer run is closed.
//
// Through the real chat path: runAgentChat with a scripted model (tool_search
// then the tool, through the tool bridge, executeTool and the approval gate),
// buildToolSet's execute closure for the taint cases, decideApproval for the
// held ones. Real database and Redis, the fake control plane over TCP.

import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { z } from "zod"
import { createTestOrg } from "~/tests/helpers/org"

const eventBusModule = await import("~/infra/events/event-bus")
spyOn(eventBusModule, "broadcastEphemeral").mockImplementation(async () => {})

const { app } = await import("~/app")
const { sql } = await import("~/db")
const { withPrivilegedDb, withSystemDb } = await import("~/db/privileged")
const { env } = await import("~/lib/env")
const { _setEdition } = await import("~/lib/edition")
const { resetOperatorOrgCache } = await import("~/modules/apps/operator-org")
const { DemoModeTestAccess } = await import("~/modules/demo/demo-mode")
const { startFakeControlPlane } = await import("~/tests/e2e/helpers/mock-control-plane")
const minimal = await import("~/seed/tiers/minimal")
const { acquireTestLock, releaseTestLock } = await import("~/tests/route-test-setup")
const { drainOnce } = await import("~/modules/liaison-team/outbox")
const { setSharing } = await import("~/modules/liaison-team/settings")
const { ensureAppsForOrg } = await import("~/modules/apps/init")
const { toolRegistry } = await import("~/modules/apps/app-registries")
const { loadEffectivePermissions } = await import("~/modules/permissions/permissions")
const { runAgentChat } = await import("~/modules/agent/runtime/agent-service")
const { clearScriptedTurns, setScriptedTurn } = await import(
  "~/modules/agent/providers/scripted-model-provider"
)
const { runContextStore } = await import("~/modules/agent/runtime/run-context")
const { createTurnScopeAccumulator } = await import("~/modules/agent/scopes/turn-scope-accumulator")
const { ALL_DEFERRED_TOOLS_UNLOCKED, buildToolSet } = await import(
  "~/modules/agent/tools/tool-bridge"
)
const { setTaintFlag } = await import("~/modules/agent/scopes/taint")
const { decideApproval } = await import("~/modules/approvals/decide")
const { createOrGetAgentDm } = await import("~/modules/threads/thread")
const { asUser } = await import("~/seed/factories/people/actors")
const { upsertRoleAgent } = await import("~/seed/factories/agent/agents")
const { creditBalances, modelPricing } = await import("~/db/schema/kernel")

type Fake = Awaited<ReturnType<typeof startFakeControlPlane>>
type Session = Awaited<ReturnType<typeof minimal.session>>
type RunFrame = import("~/modules/agent/runtime/run-context").RunContext

const saved = {
  endpoint: env.LIAISON_TEAM_ENDPOINT,
  operator: env.LIAISON_OPERATOR_ORG_ID,
  anthropic: process.env.LIAISON_ANTHROPIC_API_KEY,
  provider: process.env.LIAISON_MODEL_PROVIDER,
}
const mutableEnv = env as unknown as Record<string, string | undefined>

/** A scope only the org's admins hold: what a tainted turn read. */
const ADMIN_READ = "kernel:org:admin"

let fake: Fake
let orgId: string
let admin: Session
let member: Session
let memberScopes: string[]
let deskAgentId: string
let now: Date

const drain = () => {
  now = new Date(Math.max(now.getTime(), Date.now()) + 1)
  return drainOnce(now, { random: () => 0.5, elapsedMs: () => 0 })
}

const outbox = () =>
  sql<{ type: string; message_id: string; status: string }[]>`
    SELECT type, message_id, status FROM kernel.control_plane_outbox
     WHERE type = 'bug-report' ORDER BY created_at`
const ticketCount = async () => {
  const [r] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM app_tickets.tickets WHERE org_id = ${orgId}::uuid`
  return r?.n ?? 0
}
const reportApprovals = () =>
  sql<{ id: string; status: string }[]>`
    SELECT id, status FROM kernel.approval_requests
     WHERE org_id = ${orgId}::uuid AND tool_name = 'kernel:report_bug' ORDER BY created_at`

function call(s: Session, path: string, body?: unknown): Promise<Response> {
  return Promise.resolve(
    app.request(`/api/bug-reports${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.bearer}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
}

const teamOnly = async (on: boolean) => {
  await setSharing({ register: true }, { userId: null }, now)
  await drain()
  await setSharing(
    { forwardBugReports: true, bugReportsTeamOnly: on },
    { userId: null },
    new Date(now.getTime() + 1),
  )
  await sql`DELETE FROM kernel.control_plane_outbox`
}

interface TurnTrace {
  results: Array<{ toolName: string; output: unknown }>
}

/** Consume a turn's stream the way the chat route does, then persist it. */
async function drive(r: Awaited<ReturnType<typeof runAgentChat>>): Promise<TurnTrace> {
  const trace: TurnTrace = { results: [] }
  let text = ""
  const steps: Array<{ toolCalls?: unknown[]; toolResults?: unknown[] }> = []
  let calls: unknown[] = []
  let results: unknown[] = []
  for await (const part of r.fullStream as AsyncIterable<any>) {
    if (part.type === "text-delta") text += part.text
    if (part.type === "tool-call")
      calls.push({ toolCallId: part.toolCallId, toolName: part.toolName, args: part.input })
    if (part.type === "tool-result") {
      trace.results.push({ toolName: part.toolName, output: part.output })
      results.push({ toolCallId: part.toolCallId, result: part.output })
    }
    if (part.type === "finish-step") {
      steps.push({
        toolCalls: calls.length ? calls : undefined,
        toolResults: results.length ? results : undefined,
      })
      calls = []
      results = []
    }
  }
  await r.finalize({
    usage: { promptTokens: 0, completionTokens: 0 },
    finishReason: "stop",
    text,
    steps,
  } as never)
  return trace
}

/** The member asks the support desk agent, in their DM, to report a bug. */
async function memberAsksForReport(title: string): Promise<TurnTrace> {
  // The product's own DM find-or-create; one fresh conversation per case.
  const dm = await asUser(memberActor(), (tx) =>
    createOrGetAgentDm(tx as never, { orgId, userId: member.userId, agentId: deskAgentId }),
  )
  if (!dm) throw new Error("no DM with the support desk agent")
  const threadId = dm.id
  await clearScriptedTurns(threadId)
  await setScriptedTurn(threadId, [
    { toolCalls: [{ name: "kernel__tool_search", args: { query: "report a bug in Liaison" } }] },
    {
      toolCalls: [
        {
          name: "kernel__report_bug",
          args: { title, description: "The save button spins forever." },
        },
      ],
    },
    { text: "Done." },
  ])
  try {
    return await drive(
      await runAgentChat({
        threadId,
        content: "Please report this Liaison bug: saving spins forever.",
        actor: memberActor(),
        orgId,
        actingAgentId: deskAgentId,
      }),
    )
  } finally {
    await clearScriptedTurns(threadId)
  }
}

const memberActor = () => ({
  actorType: "user" as const,
  userId: member.userId,
  orgId,
  scopes: memberScopes,
  dimensionGrants: {},
})

const resultOf = (trace: TurnTrace, tool: string) =>
  trace.results.find((r) => r.toolName === tool)?.output as Record<string, any> | undefined

/** A typed turn of the admin that has already read `taint`. */
function adminTurn(
  taint: string[],
  routineId?: string,
  extra: Partial<Pick<RunFrame, "background" | "coordinated" | "humanTurn">> = {},
): RunFrame {
  const runId = crypto.randomUUID()
  const turnScopeAccumulator = createTurnScopeAccumulator()
  turnScopeAccumulator.recordInjected(taint)
  return {
    runId,
    parentRunId: null,
    rootRunId: runId,
    nestingDepth: 0,
    ...(routineId ? { routineId } : { humanTurn: true }),
    ...extra,
    turnScopeAccumulator,
  }
}

async function adminReports(
  frame: RunFrame,
  title: string,
  existingThreadId?: string,
): Promise<Record<string, any>> {
  const threadId = existingThreadId ?? (await minimal.thread(orgId, admin.userId))
  const actor = {
    actorType: "user" as const,
    userId: admin.userId,
    orgId,
    scopes: ["*"],
    dimensionGrants: {},
  }
  const tools = buildToolSet(orgId, actor, threadId, ALL_DEFERRED_TOOLS_UNLOCKED, "agent", frame)
  const t = tools.kernel__report_bug as
    | { execute: (a: unknown, o: unknown) => Promise<unknown> }
    | undefined
  if (!t) throw new Error("kernel__report_bug is not in the admin's catalog")
  return (await runContextStore.run(frame, () =>
    t.execute({ title, description: "The save button spins forever." }, { toolCallId: title }),
  )) as Record<string, any>
}

const approve = (requestId: string) =>
  decideApproval({
    orgId,
    requestId,
    decision: "approve",
    actor: { actorType: "user", userId: admin.userId, orgId, scopes: ["*"], dimensionGrants: {} },
  })

beforeAll(async () => {
  await acquireTestLock()
  process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
  process.env.LIAISON_MODEL_PROVIDER = "scripted"
  orgId = (await createTestOrg()).id
  await ensureAppsForOrg(orgId, {})
  admin = await minimal.adminSession(orgId)
  // A plain member: no role at all, three direct grants; no memory, no approvals,
  // no bug scope of their own.
  const person = await minimal.person(orgId)
  await minimal.revokeRole(person.id, "member")
  for (const scope of ["kernel:threads:read", "kernel:threads:write", "tickets:tickets:read"]) {
    await minimal.grantScope(person.id, scope)
  }
  member = await minimal.sessionOf(person)
  memberScopes = (
    await withPrivilegedDb(orgId, "test-member-scopes", (tx) =>
      loadEffectivePermissions(tx, person.id, orgId),
    )
  ).scopes
  // A role agent whose admin-set ceiling names neither memory nor bug reports.
  deskAgentId = (
    await upsertRoleAgent(orgId, {
      handle: `@desk-${crypto.randomUUID().slice(0, 8)}`,
      displayName: "Support Desk",
      purpose: "Answers support conversations",
      systemPrompt: "",
      scopes: ["kernel:threads:read", "kernel:threads:write", "tickets:tickets:read"],
      toolAllowlist: null,
      modelPreference: null,
    })
  ).agentId
  // The model the scripted turn resolves to, with credit to spend on it.
  await withSystemDb("test-credits", async (tx) => {
    await tx
      .insert(creditBalances)
      .values({
        orgId,
        includedBalance: "10.00000000",
        purchasedBalance: "0.00000000",
        currency: "EUR",
      })
      .onConflictDoNothing()
    await tx
      .insert(modelPricing)
      .values({
        provider: "anthropic",
        modelId: "claude-haiku-4-5",
        displayName: "Claude Haiku 4.5",
        inputCostPerM: "1.00000000",
        outputCostPerM: "5.00000000",
        contextWindow: 200000,
        autoEligible: true,
        tierMinimum: "starter",
      })
      .onConflictDoNothing()
  })
  // A stand-in read only admins may make: what taints the admin's turns below.
  toolRegistry.set([orgId, "kernel", "qa_admin_read"], {
    appName: "kernel",
    name: "qa_admin_read",
    description: "Read the org's admin settings (test stand-in).",
    requiredScopes: [ADMIN_READ],
    readOnly: true,
    params: z.object({}),
    handler: async () => ({ ok: true }),
  })
}, 120_000)

afterAll(async () => {
  mutableEnv.LIAISON_TEAM_ENDPOINT = saved.endpoint
  mutableEnv.LIAISON_OPERATOR_ORG_ID = saved.operator
  process.env.LIAISON_ANTHROPIC_API_KEY = saved.anthropic
  process.env.LIAISON_MODEL_PROVIDER = saved.provider
  resetOperatorOrgCache()
  _setEdition(null)
  DemoModeTestAccess.set(null)
  await fake?.kill()
  await sql`DELETE FROM kernel.control_plane_outbox`
  await sql`DELETE FROM kernel.instance_settings WHERE key LIKE 'liaison_team.%'`
  await releaseTestLock()
})

beforeEach(async () => {
  await fake?.kill()
  await sql`DELETE FROM kernel.control_plane_outbox`
  await sql`DELETE FROM kernel.instance_settings WHERE key LIKE 'liaison_team.%'`
  await sql`DELETE FROM kernel.approved_handler_executions WHERE org_id = ${orgId}::uuid AND tool_name = 'kernel:report_bug'`
  await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${orgId}::uuid AND tool_name = 'kernel:report_bug'`
  fake = await startFakeControlPlane(0)
  now = new Date(Math.floor(Date.now() / 1000) * 1000)
  fake.control.setClock(() => now)
  mutableEnv.LIAISON_TEAM_ENDPOINT = fake.control.endpoint
  mutableEnv.LIAISON_OPERATOR_ORG_ID = orgId
  resetOperatorOrgCache()
  _setEdition("self_hosted")
  DemoModeTestAccess.set(false)
})

describe("an agent reports a bug for a plain member", () => {
  it("team-only: found, prepared, confirmed by the member, delivered to the Liaison team; no ticket, no approval", async () => {
    await teamOnly(true)
    const tickets = await ticketCount()
    const trace = await memberAsksForReport("Save spins (team-only)")
    expect(JSON.stringify(resultOf(trace, "kernel__tool_search"))).toContain("kernel__report_bug")
    const result = resultOf(trace, "kernel__report_bug")
    expect(result?.awaitingConfirmation).toBe(true)
    expect(result?.draftId).toBeString()
    expect(await reportApprovals()).toHaveLength(0)
    expect(await outbox()).toHaveLength(0)

    // The member's click on the card sends it.
    const sent = await call(member, `/drafts/${result?.draftId}/send`, { digest: result?.digest })
    expect(sent.status).toBe(200)
    const { data } = (await sent.json()) as { data: { messageId: string } }
    await drain()
    expect(fake.control.acks().filter((a) => a.type === "bug-report")).toEqual([
      expect.objectContaining({ messageId: data.messageId }),
    ])
    expect((await outbox()).map((r) => r.status)).toEqual(["delivered"])
    expect(await ticketCount()).toBe(tickets)
  }, 120_000)

  it("team-only off: the same call files the local ticket, under the member's name", async () => {
    await teamOnly(false)
    const tickets = await ticketCount()
    const result = resultOf(await memberAsksForReport("Save spins (local)"), "kernel__report_bug")
    expect(result?.filed).toBe(true)
    expect(await ticketCount()).toBe(tickets + 1)
    expect(await outbox()).toHaveLength(0)
  }, 120_000)
})

describe("a tainted turn's report", () => {
  beforeAll(async () => {
    // A reader of tickets who does not hold what the admin's turn read.
    expect(memberScopes).toContain("tickets:tickets:read")
    expect(memberScopes).not.toContain(ADMIN_READ)
  })

  it("team-only: judged by the reporter alone, so it goes to the card with no approval", async () => {
    await teamOnly(true)
    const result = await adminReports(adminTurn([ADMIN_READ]), "After an admin read (team-only)")
    expect(result.status).not.toBe("pending_approval")
    expect(result.awaitingConfirmation).toBe(true)
    expect(await reportApprovals()).toHaveLength(0)
    expect(await outbox()).toHaveLength(0)
  })

  it("held before team-only went on: approving it prepares the reporter's card, nothing is sent", async () => {
    await teamOnly(false)
    const held = await adminReports(adminTurn([ADMIN_READ]), "Held, then team-only")
    expect(held.status).toBe("pending_approval")
    const [row] = await reportApprovals()
    expect(row?.status).toBe("pending")
    await teamOnly(true)
    const tickets = await ticketCount()
    await approve(row?.id ?? "")
    expect((await reportApprovals())[0]?.status).not.toBe("pending")
    const drafts = await call(admin, "/drafts")
    const listed = ((await drafts.json()) as { data: Array<{ data: Record<string, any> }> }).data
    expect(JSON.stringify(listed)).toContain("Held, then team-only")
    expect(await outbox()).toHaveLength(0)
    expect(await ticketCount()).toBe(tickets)
  })

  it("a routine's report held before team-only went on: approving it closes the request with the reason", async () => {
    await teamOnly(false)
    const held = await adminReports(
      adminTurn([ADMIN_READ], crypto.randomUUID()),
      "Routine held, then team-only",
    )
    expect(held.status).toBe("pending_approval")
    const [row] = await reportApprovals()
    await teamOnly(true)
    const decided = await approve(row?.id ?? "").catch((err: unknown) => err)
    expect(decided).toBeInstanceOf(Error)
    expect((await reportApprovals())[0]?.status).toBe("cancelled")
    const [notice] = await sql<{ content: string }[]>`
      SELECT content FROM kernel.messages
       WHERE org_id = ${orgId}::uuid AND content LIKE 'Handler failed:%'
       ORDER BY created_at DESC LIMIT 1`
    expect(notice?.content).toContain("Report a bug")
    expect(notice?.content).toContain("The request is closed")
    expect(await outbox()).toHaveLength(0)
  })

  it("a routine's report, team-only: refused before any approval is created", async () => {
    await teamOnly(true)
    const result = await adminReports(
      adminTurn([ADMIN_READ], crypto.randomUUID()),
      "Routine, team-only",
    )
    expect(result.error?.code).toBe("REPORTER_CONFIRMATION_REQUIRED")
    expect(result.status).not.toBe("pending_approval")
    expect(result.draftId).toBeUndefined()
    expect(await reportApprovals()).toHaveLength(0)
    expect(await outbox()).toHaveLength(0)
  })

  for (const kind of ["background", "coordinated"] as const) {
    it(`a ${kind} turn's report held before team-only went on: approving it closes the request, no card`, async () => {
      await teamOnly(false)
      const held = await adminReports(
        adminTurn([ADMIN_READ], undefined, { [kind]: true, humanTurn: undefined }),
        `Held from a ${kind} turn`,
      )
      expect(held.status).toBe("pending_approval")
      const [row] = await reportApprovals()
      const [meta] = await sql<{ metadata: Record<string, unknown> }[]>`
        SELECT metadata FROM kernel.approval_requests WHERE id = ${row?.id ?? ""}::uuid`
      expect(meta?.metadata.originHasPerson).toBe(false)
      await teamOnly(true)
      const decided = await approve(row?.id ?? "").catch((err: unknown) => err)
      expect(decided).toBeInstanceOf(Error)
      expect((await reportApprovals())[0]?.status).toBe("cancelled")
      const drafts = await call(admin, "/drafts")
      const listed = ((await drafts.json()) as { data: unknown[] }).data
      expect(JSON.stringify(listed)).not.toContain(`Held from a ${kind} turn`)
      expect(await outbox()).toHaveLength(0)
    })
  }

  it("a typed turn's held call records that a person was behind it", async () => {
    await teamOnly(false)
    const held = await adminReports(adminTurn([ADMIN_READ]), "Typed, held")
    expect(held.status).toBe("pending_approval")
    const [row] = await reportApprovals()
    const [meta] = await sql<{ metadata: Record<string, unknown> }[]>`
      SELECT metadata FROM kernel.approval_requests WHERE id = ${row?.id ?? ""}::uuid`
    expect(meta?.metadata.originHasPerson).toBe(true)
  })

  it("after outside text, the report parks for a person even though the tool reads nothing (taintFree)", async () => {
    await teamOnly(false)
    const tickets = await ticketCount()
    const threadId = await minimal.thread(orgId, admin.userId)
    await setTaintFlag(threadId, orgId)
    const result = await adminReports(adminTurn([]), "After outside text", threadId)
    expect(result.status).toBe("pending_approval")
    expect(result.filed).not.toBe(true)
    expect(await ticketCount()).toBe(tickets)
    expect(await reportApprovals()).toHaveLength(1)
  })
})
