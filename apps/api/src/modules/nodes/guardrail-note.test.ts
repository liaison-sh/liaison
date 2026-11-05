// SPDX-License-Identifier: FSL-1.1-ALv2
//
// D18: an agent that sets up a routine on the owner's computer gets the
// guardrail risk note in the tool result, with the instruction to relay it
// before confirming; a cloud routine gets none. The suggested level follows
// the model: Strict for Haiku, Standard for Opus.
import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql } from "~/db"
import { withRlsContext } from "~/db/rls"
import { gatedRoutineAgentNotes } from "./guardrail-note"

const realJobs = await import("~/infra/jobs/jobs")
const realJobsModule = { ...realJobs }
mock.module("~/infra/jobs/jobs", () => ({
  ...realJobsModule,
  enqueueAppJob: async () => "job-id",
  upsertJobScheduler: async () => undefined,
  removeScheduledJob: async () => undefined,
  removeAppJob: async () => undefined,
}))

// mock.module outlives this file: put the real jobs module back so the stubs above
// never reach a later file in the same bun process (a later spyOn(Queue.prototype)
// would otherwise watch a queue the stub never touches).
afterAll(() => {
  mock.module("~/infra/jobs/jobs", () => realJobsModule)
})

const { handleCreateRoutine, handleUpdateRoutine, summarizeCreateRoutine, summarizeUpdateRoutine } =
  await import("~/modules/agent/tools/skills-routines-tools")

const ORG = randomUUID()
const OWNER = randomUUID()
const ctx = {
  orgId: ORG,
  userId: OWNER,
  actorType: "user",
  scopes: ["*"],
  approverUserId: OWNER,
} as never

type Result = {
  routine?: { id: string }
  error?: unknown
  nodeGuardrails?: { riskNote: string; suggestedGuardrail: string; relay: string }
}

const base = {
  description: "d",
  kind: "recurring" as const,
  cron: "0 9 * * 1",
  timezone: "Europe/Paris",
  prompt: "Summarise the week.",
  scopes: ["kernel:threads:read"],
}

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Guard Org', ${`guard-${ORG}`})`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
    VALUES (${OWNER}, ${ORG}, ${`${OWNER}@guard.test`}, 'Owner', 'active', 'hash')`
  await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope) VALUES (${OWNER}, ${ORG}, '*')`
})

afterAll(async () => {
  await sql`DELETE FROM kernel.routines WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG}`
})

describe("node routine setup carries the guardrail risk note (D18)", () => {
  it("a node routine on Haiku: Strict suggested, the note and the relay instruction", async () => {
    const res = (await handleCreateRoutine(
      {
        ...base,
        name: `n-haiku-${ORG.slice(0, 6)}`,
        runsOn: "node" as const,
        agentModelId: "claude-haiku-4-5",
      },
      ctx,
    )) as Result
    expect(res.error).toBeUndefined()
    expect(res.nodeGuardrails?.suggestedGuardrail).toBe("strict")
    expect(res.nodeGuardrails?.riskNote).toContain("Untrusted input (mail, tickets, web pages)")
    expect(res.nodeGuardrails?.riskNote).toContain("recommended on cheap models")
    // D20, L13: the note names no hosting provider's settings and no profile
    // template; the pre-push hook is the guard it names.
    expect(res.nodeGuardrails?.riskNote).toContain(
      "On Strict and Standard, a determined prompt-injected session can still push to the default branch from a script; the pre-push hook refuses it, but a script can get past it.",
    )
    expect(res.nodeGuardrails?.riskNote).not.toContain("GitHub")
    expect(res.nodeGuardrails?.riskNote).not.toContain("Bug Fixer")
    expect(res.nodeGuardrails?.relay).toContain("Before you confirm")
  })

  it("a node_else_cloud routine on Opus: Standard suggested", async () => {
    const res = (await handleCreateRoutine(
      {
        ...base,
        name: `n-opus-${ORG.slice(0, 6)}`,
        runsOn: "node_else_cloud" as const,
        agentModelId: "claude-opus-5-5",
      },
      ctx,
    )) as Result
    expect(res.nodeGuardrails?.suggestedGuardrail).toBe("standard")
  })

  it("a cloud routine carries no note; moving it to the node does", async () => {
    const created = (await handleCreateRoutine(
      { ...base, name: `cloud-${ORG.slice(0, 6)}` },
      ctx,
    )) as Result
    expect(created.nodeGuardrails).toBeUndefined()
    // A tool runs with the caller's RLS client (ctx.db), as every production
    // tool context carries: the agent's model is read through it.
    const moved = (await withRlsContext(
      { actorType: "user", userId: OWNER, orgId: ORG, scopes: ["*"], dimensionGrants: {} },
      (db) =>
        handleUpdateRoutine({ id: created.routine!.id, runsOn: "node" as const }, {
          ...(ctx as object),
          db,
        } as never),
    )) as Result
    expect(moved.error).toBeUndefined()
    expect(moved.nodeGuardrails?.riskNote).toContain("Untrusted input")
  })

  // P6-fix9 (walk): the web editor saves through PUT /api/agent/routines/:id, whose
  // handler context (handler-rpc buildAppContext) carries no RLS client. Every save
  // of a node routine there sends runsOn + agentModelId, and the agent-model read
  // dereferenced the missing client: the row was written, then the route answered 500.
  it("an edit through the HTTP route (no ctx.db) of a node routine answers with the note", async () => {
    // P6-fix10: the agent's model is read in the acting user's own RLS
    // transaction (no privileged handle). The routine's agent runs on Opus, so
    // Standard comes back only when that read really reached kernel.agents.
    const AGENT = randomUUID()
    await sql`INSERT INTO kernel.agents (id, org_id, kind, owner_user_id, handle, display_name, model_preference)
      VALUES (${AGENT}, ${ORG}, 'personal', ${OWNER}, ${`@g-${ORG.slice(0, 8)}`}, 'Owner agent', 'claude-opus-5-5')`
    const created = (await handleCreateRoutine(
      { ...base, name: `http-${ORG.slice(0, 6)}`, runsOn: "node" as const },
      ctx,
    )) as Result
    await sql`UPDATE kernel.routines SET owner_agent_id = ${AGENT} WHERE id = ${created.routine!.id}`
    const edited = (await handleUpdateRoutine(
      { id: created.routine!.id, runsOn: "node" as const, agentModelId: null },
      { ...(ctx as object), db: undefined } as never,
    )) as Result
    expect(edited.error).toBeUndefined()
    expect(edited.nodeGuardrails?.riskNote).toContain("Untrusted input")
    expect(edited.nodeGuardrails?.suggestedGuardrail).toBe("standard")
  })

  // Walk 2026-10-12 (N14): create_routine is GATED, so the agent never saw the
  // tool result that carries the note and confirmed a node routine without a
  // word of the risk. The gate now hands it the note (`gatedAgentNotes`), and
  // the card's first lines say where the routine runs (only 8 lines survive).
  it("a gated node routine hands the agent the note; the card says where it runs", async () => {
    const AGENT = randomUUID()
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, model_preference)
      VALUES (${AGENT}, ${ORG}, 'role', ${`@s-${ORG.slice(0, 8)}`}, 'Researcher', 'claude-opus-5-5')`
    const params = { ...base, name: "n14", runsOn: "node", ownerAgentId: AGENT }
    const notes = await gatedRoutineAgentNotes("create_routine", params, {
      orgId: ORG,
      userId: OWNER,
      scopes: ["*"],
    })
    expect(notes?.nodeGuardrails.riskNote).toContain("Untrusted input (mail, tickets, web pages)")
    expect(notes?.nodeGuardrails.suggestedGuardrail).toBe("standard")
    expect(notes?.nodeGuardrails.relay).toContain("Before you confirm")
    expect(
      await gatedRoutineAgentNotes(
        "create_routine",
        { ...base, name: "c" },
        {
          orgId: ORG,
          userId: OWNER,
          scopes: ["*"],
        },
      ),
    ).toBeNull()

    const card = (await summarizeCreateRoutine(params)) as { lines: string[] }
    expect(card.lines.slice(0, 8)).toContain("Runs on: your computer (its node)")
  })

  // L18: a node run uses the routine's node model (routines.model), not its
  // cloud model; that model keys the suggested level.
  it("a node routine's own Claude model keys the suggested level", async () => {
    const created = (await handleCreateRoutine(
      {
        ...base,
        name: `nodemodel-${ORG.slice(0, 6)}`,
        runsOn: "node" as const,
        agentModelId: "claude-haiku-4-5",
      },
      ctx,
    )) as Result
    expect(created.nodeGuardrails?.suggestedGuardrail).toBe("strict")
    await sql`UPDATE kernel.routines SET model = 'claude-opus-5-5' WHERE id = ${created.routine!.id}`
    const notes = await gatedRoutineAgentNotes(
      "update_routine",
      { id: created.routine!.id, runsOn: "node" },
      { orgId: ORG, userId: OWNER, scopes: ["*"] },
    )
    expect(notes?.nodeGuardrails.suggestedGuardrail).toBe("standard")
    // An explicit cloud model in the same call does not override the node model.
    const withCloud = await gatedRoutineAgentNotes(
      "update_routine",
      { id: created.routine!.id, runsOn: "node", agentModelId: "claude-haiku-4-5" },
      { orgId: ORG, userId: OWNER, scopes: ["*"] },
    )
    expect(withCloud?.nodeGuardrails.suggestedGuardrail).toBe("standard")
  })

  // P1-T21: the ungated answers (create, update) key on the node model too.
  it("an ungated update of a node routine keys the note on its node model", async () => {
    const created = (await handleCreateRoutine(
      {
        ...base,
        name: `ungated-${ORG.slice(0, 6)}`,
        runsOn: "node" as const,
        agentModelId: "claude-haiku-4-5",
      },
      ctx,
    )) as Result
    await sql`UPDATE kernel.routines SET model = 'claude-opus-5-5' WHERE id = ${created.routine!.id}`
    const updated = (await handleUpdateRoutine(
      { id: created.routine!.id, runsOn: "node" as const },
      ctx,
    )) as Result
    expect(updated.nodeGuardrails?.suggestedGuardrail).toBe("standard")
  })

  it("a gated move to the node: the note follows the routine's own model, the card says where", async () => {
    const created = (await handleCreateRoutine(
      { ...base, name: `sum-${ORG.slice(0, 6)}`, agentModelId: "claude-haiku-4-5" },
      ctx,
    )) as Result
    const params = { id: created.routine!.id, runsOn: "node_else_cloud" }
    const notes = await gatedRoutineAgentNotes("update_routine", params, {
      orgId: ORG,
      userId: OWNER,
      scopes: ["*"],
    })
    expect(notes?.nodeGuardrails.suggestedGuardrail).toBe("strict")
    const card = (await summarizeUpdateRoutine(params)) as { lines: string[] }
    expect(card.lines[0]).toBe("runs on → your computer, else the cloud")
  })
})
