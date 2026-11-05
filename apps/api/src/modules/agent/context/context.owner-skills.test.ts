// SPDX-License-Identifier: FSL-1.1-ALv2
//
// AN AGENT'S OWN PLAYBOOKS RIDE IN ITS CONTEXT (`auto_attach.owner`).
//
// Third QA walk: @oracle owned its warehouse skill and never read it in fifteen runs, because
// an owned skill reached its owner as one index line; the text rode in only through keyword or
// app surfacing. Pinned here, through the real assembly:
//
//   1. an owned skill marked `owner: true` is in the owner's context whole, every turn;
//   2. an owned skill without the mark, and another agent's marked skill, are not;
//   3. over the byte budget, the most recently updated skills are injected and the rest are
//      NAMED (a skill_read hint), never silently dropped;
//   4. a kept body taints the turn with its scopes; a body the turn may not see is dropped.
//   5. assembly hands the loop what it needs to deliver app-anchored skills mid-turn.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import type { UserContext } from "~/db/rls"
import {
  assembleContext,
  resetSystemPromptCache,
  systemPartsToText,
} from "~/modules/agent/context/context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { OWNER_SKILL_BUDGET_BYTES } from "~/modules/agent/skills/owner-skills"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = crypto.randomUUID()
const USER = crypto.randomUUID()
const ORACLE = crypto.randomUUID()
const OTHER = crypto.randomUUID()
const ALICE = crypto.randomUUID()
const tag = ORG.slice(0, 8)
let THREAD = ""

const actor: UserContext = {
  actorType: "user",
  userId: USER,
  orgId: ORG,
  scopes: ["*"],
  dimensionGrants: {},
}

async function skill(opts: {
  owner: string
  name: string
  body: string
  autoAttach?: Record<string, unknown> | null
  requiredScopes?: string[]
  updatedAt?: string
}) {
  await sql`INSERT INTO kernel.skills
      (org_id, owner_agent_id, name, description, body, required_scopes, auto_attach,
       created_by_actor_type, updated_at)
    VALUES (${ORG}, ${opts.owner}, ${opts.name}, ${`${opts.name} description`}, ${opts.body},
            ${opts.requiredScopes ?? []}::text[],
            ${opts.autoAttach ? JSON.stringify(opts.autoAttach) : null}::jsonb, 'user',
            ${opts.updatedAt ?? new Date().toISOString()}::timestamptz)`
}

async function contextText(agentId: string, scopes: string[] = ["*"]) {
  const accumulator = createTurnScopeAccumulator()
  const result = await assembleContext({
    threadId: THREAD,
    orgId: ORG,
    actor: { ...actor, scopes },
    agentId,
    effectiveScope: scopes,
    turnScopeAccumulator: accumulator,
  })
  return { text: systemPartsToText(result.system), accumulator, result }
}

beforeAll(async () => {
  await acquireTestLock()
  resetSystemPromptCache()
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Owner Skills Org', ${`owner-skills-${tag}`})`
  await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER}, ${ORG}, ${`owner-skills-${tag}@test.com`}, 'Owner Skills User')`
  await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, system_prompt, scope_ceiling)
    VALUES (${ORACLE}, ${ORG}, 'role', '@oracle', 'Oracle', 'You answer data questions.', '["*"]'::jsonb)`
  await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, system_prompt, scope_ceiling)
    VALUES (${OTHER}, ${ORG}, 'role', '@support', 'Support', 'You answer customers.', '["*"]'::jsonb)`
  const [t] = await sql<{ id: string }[]>`
    INSERT INTO kernel.threads (org_id, handle, type, created_by)
    VALUES (${ORG}, ${`owner-skills-${tag}`}, 'thread', ${USER}) RETURNING id`
  THREAD = t.id
  await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${THREAD}, ${USER}, ${ORG})`
  // Security review PoCs (3a43bf344), adopted: Alice's PERSONAL skill on the shared @oracle,
  // and an app-anchored skill scoped above what a narrow turn may see.
  await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${ALICE}, ${ORG}, ${`alice-${tag}@test.com`}, 'Alice')`
  await sql`INSERT INTO kernel.skills
      (org_id, owner_agent_id, name, description, body, required_scopes, auto_attach, author_user_id,
       created_by_actor_type)
    VALUES (${ORG}, ${ORACLE}, 'alice-private', 'alice private', 'ALICE_PERSONAL_SECRET_BODY', '{}'::text[],
            '{"owner":true}'::jsonb, ${ALICE}, 'user')`
  await sql`INSERT INTO kernel.skills
      (org_id, owner_agent_id, name, description, body, required_scopes, auto_attach,
       created_by_actor_type)
    VALUES (${ORG}, ${ORACLE}, 'anchored-scoped', 'anchored scoped', 'ANCHORED_SCOPED_BODY',
            '{pennylane:payouts:read}'::text[], '{"apps":["boxtal"]}'::jsonb, 'user')`

  await skill({
    owner: ORACLE,
    name: "warehouse-procedure",
    body: "ORACLE_WAREHOUSE_BODY: read the population first, then the metric.",
    autoAttach: { owner: true },
  })
  await skill({
    owner: ORACLE,
    name: "oracle-unmarked",
    body: "ORACLE_UNMARKED_BODY",
    autoAttach: { keywords: ["zzqx-never-said"] },
  })
  await skill({
    owner: OTHER,
    name: "support-own",
    body: "SUPPORT_OWN_BODY",
    autoAttach: { owner: true },
  })
  await skill({
    owner: ORACLE,
    name: "finance-scoped",
    body: "ORACLE_FINANCE_BODY",
    autoAttach: { owner: true },
    requiredScopes: ["pennylane:payouts:read"],
  })
  await skill({
    owner: ORACLE,
    name: "boxtal-anchored",
    body: "ORACLE_BOXTAL_ANCHORED_BODY",
    autoAttach: { apps: ["boxtal"] },
  })
})

afterAll(async () => {
  await sql`DELETE FROM kernel.agent_skill_index WHERE org_id = ${ORG}`.catch(() => {})
  await sql`DELETE FROM kernel.skills WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  await releaseTestLock()
})

describe("owner skills in the owner's context", () => {
  it("an owned skill marked owner rides whole; unmarked and foreign ones do not", async () => {
    const { text } = await contextText(ORACLE)
    expect(text).toContain("ORACLE_WAREHOUSE_BODY")
    expect(text).not.toContain("ORACLE_UNMARKED_BODY")
    expect(text).not.toContain("SUPPORT_OWN_BODY")
    const support = await contextText(OTHER)
    expect(support.text).toContain("SUPPORT_OWN_BODY")
    expect(support.text).not.toContain("ORACLE_WAREHOUSE_BODY")
  })

  it("a kept body taints the turn with its scopes; one the turn may not see is dropped", async () => {
    const wide = await contextText(ORACLE)
    expect(wide.text).toContain("ORACLE_FINANCE_BODY")
    expect(wide.accumulator.snapshot()).toContain("pennylane:payouts:read")
    const narrow = await contextText(ORACLE, ["kernel:threads:read", "kernel:skills:read"])
    expect(narrow.text).toContain("ORACLE_WAREHOUSE_BODY")
    expect(narrow.text).not.toContain("ORACLE_FINANCE_BODY")
    expect(narrow.accumulator.snapshot()).not.toContain("pennylane:payouts:read")
  })

  it("over the budget: newest first, the rest named for skill_read", async () => {
    const big = "x".repeat(Math.floor(OWNER_SKILL_BUDGET_BYTES * 0.6))
    await skill({
      owner: ORACLE,
      name: "big-old",
      body: `BIG_OLD_BODY ${big}`,
      autoAttach: { owner: true },
      updatedAt: "2026-01-01T00:00:00Z",
    })
    await skill({
      owner: ORACLE,
      name: "big-new",
      body: `BIG_NEW_BODY ${big}`,
      autoAttach: { owner: true },
      updatedAt: "2026-09-01T00:00:00Z",
    })
    try {
      const { text } = await contextText(ORACLE)
      expect(text).toContain("BIG_NEW_BODY")
      expect(text).not.toContain("BIG_OLD_BODY")
      expect(text).toContain("not loaded here for space: big-old")
      // The small ones still fit beside the newest big one.
      expect(text).toContain("ORACLE_WAREHOUSE_BODY")
    } finally {
      await sql`DELETE FROM kernel.skills WHERE org_id = ${ORG} AND name IN ('big-old', 'big-new')`
    }
  })

  it("hands the loop the app-anchored skills for mid-turn delivery", async () => {
    const { result } = await contextText(ORACLE)
    const surface = result.skillSurface
    expect(surface).toBeDefined()
    const anchored = surface!.anchorable.find((s) => s.name === "boxtal-anchored")
    expect(anchored?.apps).toEqual(["boxtal"])
    expect(anchored?.body).toContain("ORACLE_BOXTAL_ANCHORED_BODY")
    expect(surface!.inContext).toContain("warehouse-procedure")
    expect(surface!.activeApps).not.toContain("boxtal")
  })

  it("a personal skill on a shared agent reaches only its author (security PoC F2)", async () => {
    const bob = await contextText(ORACLE)
    expect(bob.text).not.toContain("ALICE_PERSONAL_SECRET_BODY")
    const alice = await assembleContext({
      threadId: THREAD,
      orgId: ORG,
      actor: { ...actor, userId: ALICE },
      agentId: ORACLE,
      effectiveScope: ["*"],
      turnScopeAccumulator: createTurnScopeAccumulator(),
    })
    expect(systemPartsToText(alice.system)).toContain("ALICE_PERSONAL_SECRET_BODY")
  })

  it("an anchored skill above the turn's scope is never anchorable (security PoC F3)", async () => {
    const accumulator = createTurnScopeAccumulator()
    const narrow = await assembleContext({
      threadId: THREAD,
      orgId: ORG,
      actor: { ...actor, scopes: ["*"] },
      agentId: ORACLE,
      effectiveScope: ["kernel:threads:read", "kernel:skills:read"],
      turnScopeAccumulator: accumulator,
    })
    expect(narrow.skillSurface?.anchorable.map((a) => a.name)).not.toContain("anchored-scoped")
    expect(accumulator.snapshot()).not.toContain("pennylane:payouts:read")
    const wide = await contextText(ORACLE)
    const anchored = wide.result.skillSurface?.anchorable.find((a) => a.name === "anchored-scoped")
    expect(anchored?.requiredScopes).toEqual(["pennylane:payouts:read"])
  })
})
