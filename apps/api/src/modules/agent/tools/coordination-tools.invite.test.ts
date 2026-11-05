// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P3b-T11: `agents_invite` seats an agent and starts nothing.
//
// And never on the agent's own say-so: the tool is gated, so the person it
// works for approves an inline "X wants to add Y to this discussion" first.
//
// S12: an agent speaks only when prompted. Seating one is not prompting it, so
// an invite that quietly ran a turn would be a room full of agents answering
// each other unasked. Every refusal here comes from `addAgentParticipant`
// itself, so the invite path can never admit an agent the mention path refuses.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import {
  agentsInvitePreflight,
  handleAgentsInvite,
  summarizeAgentsInvite,
} from "~/modules/agent/tools/coordination-tools"
import { registerKernelAgentTools } from "~/modules/agent/tools/kernel-tools"
import { approvalSummarizerRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = crypto.randomUUID()
const OTHER_ORG = crypto.randomUUID()
const USER = crypto.randomUUID()
const CALLER = crypto.randomUUID()
const GUEST = crypto.randomUUID()
const GONE = crypto.randomUUID()
const FOREIGN = crypto.randomUUID()
const tag = ORG.slice(0, 8)
let THREAD = ""

const actor: UserContext = {
  actorType: "user",
  userId: USER,
  orgId: ORG,
  scopes: ["*"],
  dimensionGrants: {},
}

async function invite(agentHandle: string) {
  const runId = crypto.randomUUID()
  const frame: RunContext = {
    runId,
    parentRunId: null,
    rootRunId: runId,
    nestingDepth: 0,
    agentId: CALLER,
    agentCeiling: ["*"],
    turnScopeAccumulator: createTurnScopeAccumulator(),
  }
  return withRlsContext(actor, (tx) =>
    runContextStore.run(frame, () =>
      handleAgentsInvite(
        { agentHandle },
        {
          userId: USER,
          orgId: ORG,
          db: tx,
          agentExecutionThreadId: THREAD,
          scopes: ["*"],
          actingAgentId: CALLER,
        },
      ),
    ),
  )
}

async function lines(): Promise<string[]> {
  const rows = await sql<{ content: string }[]>`
    SELECT content FROM kernel.messages WHERE thread_id = ${THREAD}
    ORDER BY created_at ASC, id ASC`
  return rows.map((r) => r.content)
}

async function seats(): Promise<string[]> {
  const rows = await sql<{ agent_id: string }[]>`
    SELECT agent_id FROM kernel.thread_participants
    WHERE thread_id = ${THREAD} AND agent_id IS NOT NULL`
  return rows.map((r) => r.agent_id)
}

beforeAll(async () => {
  await acquireTestLock()
  for (const [id, slug] of [
    [ORG, `p3b-t11-${tag}`],
    [OTHER_ORG, `p3b-t11-other-${tag}`],
  ]) {
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${id}, 'Invite Org', ${slug})`
  }
  await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER}, ${ORG}, ${`p3b-t11-${tag}@t.com`}, 'Invite User')`
  for (const [id, org, handle, name] of [
    [CALLER, ORG, `@caller-${tag}`, "Caller"],
    [GUEST, ORG, `@guest-${tag}`, "Guest"],
    [GONE, ORG, `@gone-${tag}`, "Gone"],
    [FOREIGN, OTHER_ORG, `@foreign-${tag}`, "Foreign"],
  ]) {
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling)
      VALUES (${id}, ${org}, 'role', ${handle}, ${name}, '["*"]'::jsonb)`
  }
  await sql`UPDATE kernel.agents SET archived_at = now() WHERE id = ${GONE}`
  const [t] = await sql<{ id: string }[]>`
    INSERT INTO kernel.threads (org_id, handle, type, created_by)
    VALUES (${ORG}, ${`p3b-t11-${tag}`}, 'thread', ${USER}) RETURNING id`
  THREAD = t.id
  await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${THREAD}, ${USER}, ${ORG})`
  await sql`INSERT INTO kernel.thread_participants (thread_id, agent_id, org_id, participant_type)
    VALUES (${THREAD}, ${CALLER}, ${ORG}, 'agent')`
})

afterAll(async () => {
  await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.user_thread_state WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.agents WHERE org_id IN (${ORG}, ${OTHER_ORG})`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.organizations WHERE id IN (${ORG}, ${OTHER_ORG})`
  await releaseTestLock()
})

describe("agents_invite", () => {
  it("agents_invite seats a live agent and posts the system line", async () => {
    const res = await invite(`@guest-${tag}`)
    expect(res.invited).toBe(true)
    expect(await seats()).toContain(GUEST)
    // The room reads NAMES, not handles (postAgentAutoAddSystemMessage).
    expect((await lines()).filter((c) => c.includes("added Guest")).length).toBe(1)
  })

  it("agents_invite starts no agent turn", async () => {
    // Seating is not prompting: nothing the guest authored may exist.
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM kernel.messages WHERE thread_id = ${THREAD} AND author_agent_id = ${GUEST}`
    expect(rows.length).toBe(0)
  })

  it("agents_invite on an agent already seated refuses without a duplicate system line", async () => {
    const before = (await lines()).length
    const res = await invite(`@guest-${tag}`)
    expect(res.invited).toBe(false)
    expect(res.reason).toBe("no live agent with that handle, or already in this conversation")
    expect((await lines()).length).toBe(before)
  })

  it("agents_invite on an archived agent refuses and seats nobody", async () => {
    const res = await invite(`@gone-${tag}`)
    expect(res.invited).toBe(false)
    expect(await seats()).not.toContain(GONE)
  })

  it("agents_invite on a foreign org agent refuses", async () => {
    const res = await invite(`@foreign-${tag}`)
    expect(res.invited).toBe(false)
    expect(await seats()).not.toContain(FOREIGN)
  })
})

describe("agents_invite asks the person first", () => {
  it("is registered gated, never auto-approved, with its own summarizer", async () => {
    await registerKernelAgentTools(ORG)
    const def = toolRegistry.get([ORG, "kernel", "agents_invite"])
    expect(def?.gated).toBe(true)
    expect(def?.noAutoApprove).toBe(true)
    expect(typeof def?.preflight).toBe("function")
    expect(approvalSummarizerRegistry.get([ORG, "kernel", "agents_invite"])).toBeDefined()
  })

  it("the inline card names who wants to add whom", async () => {
    const summary = await withRlsContext(actor, (tx) =>
      summarizeAgentsInvite(
        { agentHandle: `@guest-${tag}`, reason: "the refund needs finance" },
        { tx, orgId: ORG, actingAgentId: CALLER },
      ),
    )
    expect(summary.title).toBe("Caller wants to add Guest to this discussion")
    expect(summary.lines).toEqual(["the refund needs finance"])
  })

  it("the gate refuses an invite that could never be carried out, so nobody is asked", async () => {
    const res = (await withRlsContext(actor, (tx) =>
      agentsInvitePreflight(
        { agentHandle: `@gone-${tag}` },
        { userId: USER, orgId: ORG, db: tx, agentExecutionThreadId: THREAD, actingAgentId: CALLER },
      ),
    )) as { error?: { code: string } }
    expect(res.error?.code).toBe("INVITE_REFUSED")
  })
})
