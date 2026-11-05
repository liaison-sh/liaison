// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The agent native layer against a REAL database.
//
// Two things are proved here that a row count never could:
//
//   1. DISCOVERABILITY THROUGH THE PRODUCT'S OWN PATHS. Every assertion about a
//      skill goes through `skill_search`, `skill_read` or `list_skills`, which
//      is what an agent actually calls, resolved for a role scoped PERSON
//      rather than for an admin. A row an agent can never surface is worthless,
//      so reading the table back would prove nothing.
//   2. THE ROUTINES CANNOT FIRE. A visitor org is created before the visitor
//      has a model key, so the exact predicate the boot reconciler selects on
//      is asserted to return nothing for a freshly seeded org.
//
// Plus the convergence contract every other layer holds to: drift a skill body
// and a routine definition, seed again, and both are restored with nothing
// duplicated.
//
// And the two AGENT PAGE TABS this layer fills: the knowledge pointers and the
// activity timeline are read back with the routes' OWN queries, off Postgres,
// never off the seeder's return value. A row the route's query cannot see is a
// tab that opens empty whatever the seeder reported.
//
// Locally: run it against `liaison_hardening_test`, never a shared database.
//   DATABASE_URL=postgres://liaison_app:liaison_app@localhost:5432/liaison_hardening_test \
//     bun test src/seed/tiers/demo/seed-agent-native.integration.test.ts --timeout 600000
import { beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { sql } from "drizzle-orm"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { handleMemoryGet } from "~/modules/agent/memory/memory"
import { pathForRow } from "~/modules/agent/memory/memory-tree"
import { listSubAgentDefinitions } from "~/modules/agent/subruns/sub-agent-definitions"
import {
  handleListRoutineEvents,
  handleListRoutines,
  handleListSkills,
  handleSkillRead,
  handleSkillSearch,
} from "~/modules/agent/tools/skills-routines-tools"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { createThread } from "~/modules/threads/thread"
import { filterByVisibility } from "~/services/security/visibility"
import { seedDemoAgentNative } from "./seed-agent-native"
import { type SeedDemoOrgResult, seedDemoOrg } from "./seed-org"

const ORG_SLUG = "demo-agent-native-integration"
const DB_URL = process.env.DATABASE_URL ?? ""

// This test WRITES. The development database is shared with another checkout,
// so it is refused outright rather than reported after the fact.
beforeAll(() => {
  if (DB_URL === "") throw new Error("DATABASE_URL must be set for this test")
  if (/liaison_dev/.test(DB_URL)) {
    throw new Error("refusing to seed liaison_dev: use liaison_hardening_test")
  }
  if (!process.env.LIAISON_APPS_DIR) {
    process.env.LIAISON_APPS_DIR = path.join(
      mkdtempSync(path.join(tmpdir(), "demo-agent-native-")),
      "apps",
    )
  }
})

/** The instant the world is anchored to. Fixed, so two runs are identical. */
const BASE_TIME = new Date("2026-03-09T09:00:00.000Z")

let org: SeedDemoOrgResult

async function countOf(query: ReturnType<typeof sql>): Promise<number> {
  return withSystemDb("agent-native-test-count", async (tx) => {
    const rows = await tx.execute(query)
    const list = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? [])
    return Number((list[0] as { count?: string | number } | undefined)?.count ?? 0)
  })
}

/**
 * A tool context for a real person, carrying the scopes their ROLE actually
 * grants. Nothing is widened: if the product would hide a skill from this
 * person, it is hidden here too.
 */
async function ctxFor(personKey: string): Promise<{
  orgId: string
  userId: string
  scopes: string[]
}> {
  const userId = org.peopleByKey[personKey]?.userId
  if (!userId) throw new Error(`no seeded person '${personKey}'`)
  const perms = await withPrivilegedDb(org.orgId, "agent-native-test-perms", (tx) =>
    loadEffectivePermissions(tx, userId, org.orgId),
  )
  return { orgId: org.orgId, userId, scopes: perms.scopes }
}

/** The org admin's context: `*`, so every gated skill is visible from here. */
async function adminCtx(): Promise<{
  orgId: string
  userId: string
  scopes: string[]
}> {
  const perms = await withPrivilegedDb(org.orgId, "agent-native-test-admin-perms", (tx) =>
    loadEffectivePermissions(tx, org.adminUserId, org.orgId),
  )
  return { orgId: org.orgId, userId: org.adminUserId, scopes: perms.scopes }
}

describe("demo agent native layer", () => {
  it("seeds the org's skills, routines, sub agents and agent memory", async () => {
    org = await seedDemoOrg({ orgSlug: ORG_SLUG, variant: "visitor" })
    // The knowledge collections and conversations the support layer would have
    // left here. Without them the two tab layers correctly skip every row that
    // references one, and the tab assertions would be measuring which layers
    // ran rather than the fixture.
    await seedTabPreconditions()
    const result = await seedDemoAgentNative(org, { baseTime: BASE_TIME })

    expect(result.counts.skills).toBeGreaterThanOrEqual(9)
    // The kernel's own mirror: a skill row without its index row is half created.
    expect(result.counts.skillIndexRows).toBe(result.counts.skills)
    expect(result.counts.routines).toBe(5)
    expect(result.counts.subAgents).toBe(2)
    expect(result.counts.memoryEntries).toBeGreaterThanOrEqual(6)
    // The remembered conversations the consolidation job would have written six
    // hours after each room went quiet, and never does on a fresh box.
    expect(result.counts.rememberedConversations).toBe(8)
    // Read back from the rows that actually landed, not from the spec lists.
    expect(result.counts.knowledgePointers).toBe(10)
    expect(result.counts.activityRows).toBe(35)
  }, 600_000)

  // ── Discoverability, through the product's own paths ─────────────────────

  it("skill_search finds the right playbook from a phrase a person would type", async () => {
    // Each case is asked as the desk that actually holds the skill's
    // requiredScopes: `eu-and-export-vat` needs invoicing:settings:read, which
    // support does not carry, so it is asked as Henrik (finance) rather than
    // Lucas. A skill whose gating scope the asking desk lacks is correctly
    // invisible, not a search bug.
    const cases: Array<[string, string, string]> = [
      ["lucas", "the customer wants to return a faulty recorder", "returns-and-warranty"],
      ["lucas", "draft a reply to this customer email", "customer-reply-voice"],
      ["lucas", "the parcel is stuck in customs and has not moved", "shipment-exception"],
      ["henrik", "what VAT do I put on an invoice to a German dealer", "eu-and-export-vat"],
      ["lucas", "this dealer is asking for trade pricing on a quote", "dealer-pricing-and-quotes"],
      ["lucas", "what is our escalation path for an angry dealer", "escalation-path"],
    ]
    for (const [personKey, query, expected] of cases) {
      const ctx = await ctxFor(personKey)
      const { hits } = await handleSkillSearch({ query, maxResults: 3 }, ctx)
      expect(hits.length).toBeGreaterThan(0)
      expect(
        hits.map((h) => h.name),
        `search '${query}' should surface '${expected}'`,
      ).toContain(expected)
    }
  })

  it("skill_search folds accents and tolerates French morphology", async () => {
    const ctx = await ctxFor("lucas")
    const { hits } = await handleSkillSearch(
      { query: "le client demande un remboursement pour un retour", maxResults: 3 },
      ctx,
    )
    expect(hits.map((h) => h.name)).toContain("returns-and-warranty")
  })

  it("list_skills returns every playbook to the admin, and each carries the scope that gates it", async () => {
    const ctx = await adminCtx()
    const { skills } = await handleListSkills({ source: "org", limit: 100 }, ctx)
    const names = skills.map((s) => s.name)
    for (const expected of [
      "customer-reply-voice",
      "returns-and-warranty",
      "dealer-pricing-and-quotes",
      "eu-and-export-vat",
      "shipment-exception",
      "escalation-path",
      "refunds-and-credit-notes",
      "month-end-close",
      "knowledge-upkeep",
    ]) {
      expect(names, `'${expected}' should be visible to the org admin (holds '*')`).toContain(
        expected,
      )
    }
    // The scope-to-skill binding is the point: every playbook now declares a
    // real ceiling of its own, not an empty gate everyone passes.  This is the
    // assertion that fails without the fix (see the falsification note in the
    // task report): reverting `requiredScopes` to `[]` on the seeder turns
    // every entry here back into an empty array.
    for (const s of skills) {
      expect(s.requiredScopes.length, `${s.name} requiredScopes`).toBeGreaterThan(0)
    }
  })

  it("a scope-narrow desk sees only the playbooks its own ceiling covers", async () => {
    // Margot (fulfillment) does not hold invoicing:approve, so the finance-only
    // refund playbook is correctly hidden from her, the same way it would be
    // hidden from a real fulfillment coordinator who cannot approve a refund.
    const ctx = await ctxFor("margot")
    const { skills } = await handleListSkills({ source: "org", limit: 100 }, ctx)
    const names = skills.map((s) => s.name)
    expect(names).toContain("returns-and-warranty")
    expect(names).toContain("shipment-exception")
    expect(names).not.toContain("refunds-and-credit-notes")
  })

  it("skill_read returns a body an agent can follow", async () => {
    const ctx = await ctxFor("lucas")
    const read = await handleSkillRead({ name: "returns-and-warranty" }, ctx)
    expect("error" in read).toBe(false)
    if ("error" in read) return
    expect(read.source).toBe("org")
    expect(read.body).toContain("RETURN")
    expect(read.body.length).toBeGreaterThan(500)
  })

  it("every seeded skill declares trigger words and app anchors", async () => {
    const rows = await withPrivilegedDb(org.orgId, "agent-native-test-autoattach", (tx) =>
      tx.execute(sql`
        SELECT name, domain, auto_attach FROM kernel.skills
        WHERE org_id = ${org.orgId}::uuid AND author_user_id IS NULL
      `),
    )
    const list = (
      Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? [])
    ) as Array<{ name: string; domain: string | null; auto_attach: unknown }>
    expect(list.length).toBeGreaterThanOrEqual(9)
    for (const row of list) {
      const attach = row.auto_attach as { keywords?: string[]; apps?: string[] } | null
      expect(attach?.keywords?.length ?? 0, `${row.name} keywords`).toBeGreaterThanOrEqual(5)
      expect(attach?.apps?.length ?? 0, `${row.name} apps`).toBeGreaterThanOrEqual(1)
      expect(row.domain, `${row.name} domain`).toBeTruthy()
    }
  })

  it("list_routines returns the seeded routines as shared org automations", async () => {
    const ctx = await ctxFor("amina")
    const { routines } = await handleListRoutines({ visibility: "shared" }, ctx)
    const names = routines.map((r) => r.name)
    for (const expected of [
      "Morning backlog triage",
      "Overdue invoice sweep",
      "Monday digest",
      "New ticket first look",
      "Shipment exception check",
    ]) {
      expect(names).toContain(expected)
    }
    // Every one carries a non empty ceiling: a routine with no scopes reads
    // empty on every tick and looks broken rather than off.
    for (const r of routines) expect(r.scopes.length).toBeGreaterThan(0)
  })

  it("each event routine binds to an event the org really declares", async () => {
    const ctx = await ctxFor("amina")
    const { events } = await handleListRoutineEvents({}, ctx)
    const declared = new Set(events.map((e) => e.event))
    const bound = await withPrivilegedDb(org.orgId, "agent-native-test-events", (tx) =>
      tx.execute(sql`
        SELECT name, event FROM kernel.routines
        WHERE org_id = ${org.orgId}::uuid AND kind = 'event'
      `),
    )
    const rows = (
      Array.isArray(bound) ? bound : ((bound as { rows?: unknown[] }).rows ?? [])
    ) as Array<{ name: string; event: string }>
    expect(rows.length).toBeGreaterThanOrEqual(1)
    for (const row of rows) {
      // An event nothing declares is a subscription that never fires: the
      // routine would look set up and never run once.
      expect(declared, `'${row.name}' binds to undeclared '${row.event}'`).toContain(row.event)
    }
  })

  it("the sub agent roles are addressable by the desks that delegate to them", async () => {
    const all = await listSubAgentDefinitions(org.orgId)
    const types = all.map((d) => d.agentType)
    expect(types).toContain("ticket-first-look")
    expect(types).toContain("shipment-status-check")
    // Only the two this layer seeds. An installed app registers its own roles
    // (the social app ships `community-manager`), and those are its business.
    const defs = all.filter((d) => d.appName === "kernel")
    expect(defs).toHaveLength(2)
    for (const def of defs) {
      expect(def.scopeCeiling.length).toBeGreaterThan(0)
      // Read only by construction: a delegate that can write is not a delegate.
      for (const scope of def.scopeCeiling) expect(scope.endsWith(":read")).toBe(true)
      expect(def.skills.length).toBeGreaterThan(0)
    }
  })

  it("a desk's memory is readable in its own tree, index and all", async () => {
    const supportAgentId = org.agentsByHandle["@support"]?.agentId
    expect(supportAgentId).toBeTruthy()
    const perms = await withPrivilegedDb(org.orgId, "agent-native-test-mem-perms", (tx) =>
      loadEffectivePermissions(tx, org.adminUserId, org.orgId),
    )
    const actor = {
      actorType: "user" as const,
      userId: org.adminUserId,
      orgId: org.orgId,
      scopes: perms.scopes,
      dimensionGrants: perms.dimensionGrants,
      roles: perms.roles,
    }
    const got = await withRlsContext(actor, (tx) =>
      handleMemoryGet({}, {
        userId: org.adminUserId,
        orgId: org.orgId,
        db: tx as never,
        scopes: perms.scopes,
        ownerAgentId: supportAgentId,
      } as never),
    )
    expect("index" in got).toBe(true)
    if (!("index" in got)) return
    // The index is what an agent turn actually reads: an entry behind it is a
    // memory nothing will recall.
    expect(got.index).toContain("plain-text-replies-only")
    expect(got.index).toContain("serial-number-is-proof-of-purchase")
  })

  // ── The routines cannot fire ─────────────────────────────────────────────

  it("no seeded routine is selected by the scheduler's own predicate", async () => {
    // Byte for byte the predicate `kernel-jobs` reconciles on at boot. Nothing
    // is registered with BullMQ and no event subscription is opened for a row
    // that fails it, so a visitor org cannot burn a key it does not have yet.
    const schedulable = await countOf(sql`
      SELECT count(*) AS count FROM kernel.routines
      WHERE org_id = ${org.orgId} AND enabled = true AND status = 'active'
    `)
    expect(schedulable).toBe(0)

    const ctx = await ctxFor("amina")
    const { routines } = await handleListRoutines({ visibility: "shared" }, ctx)
    for (const r of routines) {
      expect(r.enabled, `${r.name} must be seeded off`).toBe(false)
      // Off, not paused: `paused_user` would claim a failure that never happened.
      expect(r.status, `${r.name} status`).toBe("active")
      expect(r.lastRunAt).toBeNull()
    }

    // And nothing has run: a seeded routine has no history to explain.
    const runs = await countOf(sql`
      SELECT count(*) AS count FROM kernel.routine_runs WHERE org_id = ${org.orgId}
    `)
    expect(runs).toBe(0)
  })

  // ── Converges on content ─────────────────────────────────────────────────

  it("a re-seed retires a playbook this seeder no longer declares, and leaves a person's own alone", async () => {
    const supportAgentId = org.agentsByHandle["@support"]?.agentId
    const luc = await ctxFor("lucas")
    // Two rows that look alike and are not: one this seeder wrote under a
    // previous version of its spec list (stamped with the founder, who cannot
    // sign in), one a person in the org wrote for themselves.
    await withPrivilegedDb(org.orgId, "agent-native-test-retired", async (tx) => {
      await tx.execute(sql`
        INSERT INTO kernel.skills
          (org_id, owner_agent_id, author_user_id, name, description, body,
           required_scopes, created_by_user_id, created_by_actor_type)
        VALUES (${org.orgId}::uuid, ${supportAgentId}::uuid, NULL, 'retired-playbook',
                'A playbook a previous version of the seeder wrote', 'stale body',
                '{}', ${org.adminUserId}::uuid, 'user')
        ON CONFLICT DO NOTHING
      `)
      await tx.execute(sql`
        INSERT INTO kernel.skills
          (org_id, owner_agent_id, author_user_id, name, description, body,
           required_scopes, created_by_user_id, created_by_actor_type)
        VALUES (${org.orgId}::uuid, ${supportAgentId}::uuid,
                ${luc.userId}::uuid, 'my-own-notes',
                'Something a person in the org wrote for themselves', 'mine',
                '{}', ${luc.userId}::uuid, 'user')
        ON CONFLICT DO NOTHING
      `)
    })

    await seedDemoAgentNative(org, { baseTime: BASE_TIME })

    const { skills } = await handleListSkills({ source: "all", limit: 100 }, luc)
    const names = skills.map((s) => s.name)
    // Gone: nothing is left to restore a playbook the seeder no longer declares,
    // so leaving it would strand it in every org ever seeded with it.
    expect(names).not.toContain("retired-playbook")
    // Kept: a person's own skill carries their id, not the founder's.
    expect(names).toContain("my-own-notes")

    await withPrivilegedDb(org.orgId, "agent-native-test-cleanup", (tx) =>
      tx.execute(
        sql`DELETE FROM kernel.skills WHERE org_id = ${org.orgId}::uuid AND name = 'my-own-notes'`,
      ),
    )
  }, 600_000)

  it("a re-seed restores a drifted skill body and routine definition, and duplicates nothing", async () => {
    const before = {
      skills: await countOf(
        sql`SELECT count(*) AS count FROM kernel.skills WHERE org_id = ${org.orgId}`,
      ),
      skillIndex: await countOf(
        sql`SELECT count(*) AS count FROM kernel.agent_skill_index WHERE org_id = ${org.orgId}`,
      ),
      routines: await countOf(
        sql`SELECT count(*) AS count FROM kernel.routines WHERE org_id = ${org.orgId}`,
      ),
      subAgents: (await listSubAgentDefinitions(org.orgId)).length,
      memory: await countOf(
        sql`SELECT count(*) AS count FROM kernel.agent_memory WHERE org_id = ${org.orgId}`,
      ),
      knowledgePointers: await countOf(
        sql`SELECT count(*) AS count FROM kernel.agent_knowledge_pointers WHERE org_id = ${org.orgId}`,
      ),
      activity: await countOf(
        sql`SELECT count(*) AS count FROM kernel.audit_log WHERE org_id = ${org.orgId}`,
      ),
    }

    const ctx = await ctxFor("lucas")
    const original = await handleSkillRead({ name: "returns-and-warranty" }, ctx)
    expect("error" in original).toBe(false)
    if ("error" in original) return

    // Somebody edits the workspace, exactly as a visitor or a reviewer would.
    await withPrivilegedDb(org.orgId, "agent-native-test-drift", async (tx) => {
      await tx.execute(sql`
        UPDATE kernel.skills
        SET body = 'Refund everything, never ask why.', description = 'drifted'
        WHERE org_id = ${org.orgId}::uuid AND name = 'returns-and-warranty'
      `)
      await tx.execute(sql`
        UPDATE kernel.routines
        SET prompt = 'drifted prompt', cron = '0 3 * * *', enabled = true
        WHERE org_id = ${org.orgId}::uuid AND name = 'Morning backlog triage'
      `)
    })

    await seedDemoAgentNative(org, { baseTime: BASE_TIME })

    const restored = await handleSkillRead({ name: "returns-and-warranty" }, ctx)
    expect("error" in restored).toBe(false)
    if ("error" in restored) return
    expect(restored.body).toBe(original.body)
    expect(restored.description).toBe(original.description)

    const routineRows = await withPrivilegedDb(org.orgId, "agent-native-test-reread", (tx) =>
      tx.execute(sql`
        SELECT prompt, cron, enabled FROM kernel.routines
        WHERE org_id = ${org.orgId}::uuid AND name = 'Morning backlog triage'
      `),
    )
    const list = (
      Array.isArray(routineRows) ? routineRows : ((routineRows as { rows?: unknown[] }).rows ?? [])
    ) as Array<{ prompt: string; cron: string; enabled: boolean }>
    expect(list).toHaveLength(1)
    expect(list[0].prompt).not.toBe("drifted prompt")
    expect(list[0].cron).toBe("0 8 * * 1-5")
    // A routine somebody switched on is switched back off by the reset. That is
    // what "re-run the seed to reset the world" has to mean for a demo box.
    expect(list[0].enabled).toBe(false)

    const after = {
      skills: await countOf(
        sql`SELECT count(*) AS count FROM kernel.skills WHERE org_id = ${org.orgId}`,
      ),
      skillIndex: await countOf(
        sql`SELECT count(*) AS count FROM kernel.agent_skill_index WHERE org_id = ${org.orgId}`,
      ),
      routines: await countOf(
        sql`SELECT count(*) AS count FROM kernel.routines WHERE org_id = ${org.orgId}`,
      ),
      subAgents: (await listSubAgentDefinitions(org.orgId)).length,
      memory: await countOf(
        sql`SELECT count(*) AS count FROM kernel.agent_memory WHERE org_id = ${org.orgId}`,
      ),
      knowledgePointers: await countOf(
        sql`SELECT count(*) AS count FROM kernel.agent_knowledge_pointers WHERE org_id = ${org.orgId}`,
      ),
      activity: await countOf(
        sql`SELECT count(*) AS count FROM kernel.audit_log WHERE org_id = ${org.orgId}`,
      ),
    }
    expect(after).toEqual(before)
  }, 600_000)
})

// ── The two agent page tabs ──────────────────────────────────────────────

/**
 * The knowledge collections and the conversations the SUPPORT layer would have
 * put here, made by hand.
 *
 * This suite seeds the org and this layer alone, so neither exists, and the
 * two tab layers would correctly skip every row that references one. Building
 * them here is what makes the tab assertions below a statement about the
 * fixture rather than about which layers ran: the names and titles are the
 * ones `seed-support.ts` writes, because those are what the specs resolve by.
 */
async function seedTabPreconditions(): Promise<void> {
  for (const [name, description] of [
    ["Policies", "What we promise customers and dealers."],
    ["Support procedures", "How the desk handles a return, a refund and an RMA."],
    ["Product guides", "Troubleshooting and setup, one guide per product."],
  ]) {
    await withPrivilegedDb(org.orgId, "agent-native-test-collection", (tx) =>
      tx.execute(sql`
        INSERT INTO app_knowledge.collections (org_id, owner_user_id, name, description)
        SELECT ${org.orgId}::uuid, ${org.adminUserId}::uuid, ${name}, ${description}
        WHERE NOT EXISTS (
          SELECT 1 FROM app_knowledge.collections
          WHERE org_id = ${org.orgId}::uuid AND name = ${name} AND archived_at IS NULL
        )
      `),
    )
  }

  for (const [personKey, title] of [
    ["elodie", "Preamp launch readiness"],
    ["amina", "Morning triage with the support desk"],
    ["amina", "Preamp hiss: are we replacing units we should not be?"],
    ["lucas", "Knowledge gaps triage keeps hitting"],
    // The two fulfillment rooms the operations desk remembers. Without them
    // `seedEpisodes` correctly skips both of its own specs and the episode
    // assertions below would be measuring which rooms exist rather than the
    // fixture.
    ["margot", "Shipping exceptions"],
    ["amina", "Desk handover"],
  ]) {
    const userId = org.peopleByKey[personKey]?.userId
    if (!userId) throw new Error(`no seeded person '${personKey}'`)
    const perms = await withPrivilegedDb(org.orgId, "agent-native-test-thread-perms", (tx) =>
      loadEffectivePermissions(tx, userId, org.orgId),
    )
    const actor = {
      actorType: "user" as const,
      userId,
      orgId: org.orgId,
      scopes: perms.scopes,
      dimensionGrants: perms.dimensionGrants,
      roles: perms.roles,
    }
    const existing = await countOf(
      sql`SELECT count(*) AS count FROM kernel.threads
          WHERE org_id = ${org.orgId} AND title = ${title}`,
    )
    if (existing > 0) continue
    await withRlsContext(actor, (tx) =>
      createThread(
        tx as never,
        {
          orgId: org.orgId,
          userId,
          participantIds: [],
          title,
          forceCreate: true,
        } as never,
      ),
    )
  }
}

/** The org OWNER's own personal agent, read back the way the seeder reads it. */
async function ownerAgentId(): Promise<string> {
  const rows = await withSystemDb("agent-native-test-owner-agent", (tx) =>
    tx.execute(sql`
      SELECT id FROM kernel.agents
      WHERE org_id = ${org.orgId}::uuid AND kind = 'personal'
        AND owner_user_id = ${org.ownerUserId ?? org.adminUserId}::uuid
      LIMIT 1
    `),
  )
  const list = (Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? [])) as Array<{
    id: string
  }>
  const id = list[0]?.id
  if (!id) throw new Error("the seeded org has no owner personal agent")
  return id
}

/**
 * THE KNOWLEDGE TAB'S OWN QUERY, run as the route runs it.
 *
 * `GET /api/agents/:agentId/knowledge` selects the pointer rows for one
 * (org, agent) and then names each collection out of `app_knowledge`. Both
 * halves are asserted, because a pointer whose collection cannot be named
 * renders as a raw uuid in the tab, which is the empty tab with extra steps.
 */
async function knowledgeTabRows(
  agentId: string,
): Promise<Array<{ id: string; collection_id: string; name: string | null }>> {
  const rows = await withSystemDb("agent-native-test-knowledge-tab", (tx) =>
    tx.execute(sql`
      SELECT p.id, p.collection_id, c.name
      FROM kernel.agent_knowledge_pointers p
      LEFT JOIN app_knowledge.collections c ON c.id = p.collection_id AND c.org_id = p.org_id
      WHERE p.org_id = ${org.orgId}::uuid AND p.agent_id = ${agentId}::uuid
    `),
  )
  return (Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? [])) as Array<{
    id: string
    collection_id: string
    name: string | null
  }>
}

/** Audit action -> timeline kind, copied from the route's own closed list. */
const ACTIVITY_KIND_OF: Record<string, string> = {
  "message.create": "turn",
  "agent.local_session.reply": "turn",
  "agent.local_session.turn": "turn",
  "routine.status": "routine_tick",
  "routine.run_completed": "routine_tick",
  "sub_run.create": "sub_run",
  "sub_run.update": "sub_run",
  memory_file_edited: "memory_write",
  memory_fact_written: "memory_write",
  memory_episode_written: "memory_write",
  memory_index_rebuilt: "memory_write",
  memory_thread_forgotten: "memory_write",
  memory_episode_rebuilt: "memory_write",
  "approval_request.create": "approval",
  "approval_request.update": "approval",
}

/**
 * THE ACTIVITY TAB'S OWN QUERY: `kernel.audit_log` filtered to one agent and
 * to the route's closed action list, newest first, 50 at a time. An action
 * outside that list is not a row the tab can draw, so a fixture that wrote one
 * would seed an invisible timeline.
 */
async function activityTabRows(agentId: string): Promise<
  Array<{
    action: string
    entity_type: string | null
    entity_id: string | null
    changes: Record<string, unknown> | null
    metadata: Record<string, unknown> | null
  }>
> {
  const actions = Object.keys(ACTIVITY_KIND_OF)
  const rows = await withSystemDb("agent-native-test-activity-tab", (tx) =>
    tx.execute(sql`
      SELECT action, entity_type, entity_id, changes, metadata
      FROM kernel.audit_log
      WHERE org_id = ${org.orgId}::uuid AND agent_id = ${agentId}::uuid
        AND action IN (${sql.join(
          actions.map((a) => sql`${a}`),
          sql`,`,
        )})
      ORDER BY timestamp DESC
      LIMIT 50
    `),
  )
  return (Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? [])) as Array<{
    action: string
    entity_type: string | null
    entity_id: string | null
    changes: Record<string, unknown> | null
    metadata: Record<string, unknown> | null
  }>
}

/** The conversation a row points at, resolved the way the route resolves it. */
function threadIdOf(row: {
  entity_type: string | null
  entity_id: string | null
  changes: Record<string, unknown> | null
  metadata: Record<string, unknown> | null
}): string | null {
  if (row.entity_type === "thread" && row.entity_id) return row.entity_id
  for (const source of [row.metadata, row.changes]) {
    const value = source?.threadId
    if (typeof value === "string") return value
  }
  return null
}

describe("the agent page's knowledge and activity tabs", () => {
  it("every named agent is pointed at knowledge collections the tab can name", async () => {
    const owner = await ownerAgentId()
    const targets: Array<[string, string]> = [
      ["@support", org.agentsByHandle["@support"]?.agentId ?? ""],
      ["@operations", org.agentsByHandle["@operations"]?.agentId ?? ""],
      ["@finance", org.agentsByHandle["@finance"]?.agentId ?? ""],
      ["the owner's personal agent", owner],
    ]
    for (const [label, agentId] of targets) {
      expect(agentId, `${label} must exist`).toBeTruthy()
      const rows = await knowledgeTabRows(agentId)
      // Without the fixture this is zero for every one of them, which is the
      // empty tab the QA tour opens.
      expect(rows.length, `${label} knowledge pointers`).toBeGreaterThan(0)
      for (const row of rows) {
        // A pointer whose collection is gone renders as a bare uuid.
        expect(
          row.name,
          `${label} pointer ${row.collection_id} must name a collection`,
        ).toBeTruthy()
      }
    }
  })

  // A screenshot pass opened the owner's OWN agent and read "No purpose
  // recorded yet" and "Not in any channel yet": a blank page on the one agent
  // the owner is most likely to open first.
  it("the owner's personal agent has a purpose and a seat in two rooms", async () => {
    const agentId = await ownerAgentId()
    const [row] =
      (await withSystemDb("agent-native-test-owner-purpose", async (tx) => {
        const rows = await tx.execute(sql`
        SELECT purpose FROM kernel.agents WHERE id = ${agentId}::uuid
      `)
        return (Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? [])) as Array<{
          purpose: string | null
        }>
      })) ?? []
    expect(row?.purpose ?? "").not.toBe("")
    expect((row?.purpose ?? "").length).toBeGreaterThan(20)

    const seats = await countOf(
      sql`SELECT count(*) AS count
          FROM kernel.thread_participants p
          JOIN kernel.threads t ON t.id = p.thread_id
          WHERE p.org_id = ${org.orgId} AND p.agent_id = ${agentId}
            AND p.participant_type = 'agent'
            AND t.title IS NOT NULL`,
    )
    expect(seats).toBe(2)
  })

  // Re-seeding is a no-op: the purpose is a fixed UPDATE and the seats collide
  // on the partial unique index.
  it("re-seeding the layer leaves the owner agent with exactly two seats", async () => {
    await seedDemoAgentNative(org, { baseTime: BASE_TIME })
    const agentId = await ownerAgentId()
    const seats = await countOf(
      sql`SELECT count(*) AS count FROM kernel.thread_participants
          WHERE org_id = ${org.orgId} AND agent_id = ${agentId} AND participant_type = 'agent'`,
    )
    expect(seats).toBe(2)
  }, 600_000)

  it("the owner's personal agent has a timeline of several kinds, and nothing in it dangles", async () => {
    const agentId = await ownerAgentId()
    const rows = await activityTabRows(agentId)
    expect(rows.length).toBeGreaterThanOrEqual(8)
    const kinds = new Set(rows.map((r) => ACTIVITY_KIND_OF[r.action]))
    expect(kinds.size).toBeGreaterThanOrEqual(4)
    await expectNoDanglingReferences(rows)
    // The local rows are the ones the tab draws as having run on somebody's own
    // machine: `runLocation` is one of the two fields the route reads at all.
    const local = rows.filter((r) => r.metadata?.runLocation === "local")
    expect(local.length).toBeGreaterThan(0)
  })

  it("a role agent has a timeline of several kinds, and nothing in it dangles", async () => {
    const agentId = org.agentsByHandle["@support"]?.agentId ?? ""
    expect(agentId).toBeTruthy()
    const rows = await activityTabRows(agentId)
    expect(rows.length).toBeGreaterThanOrEqual(8)
    const kinds = new Set(rows.map((r) => ACTIVITY_KIND_OF[r.action]))
    expect(kinds.size).toBeGreaterThanOrEqual(4)
    await expectNoDanglingReferences(rows)
    // An ASK is not an action of its own: it is a message row carrying an agent
    // mention, and it is the only thing that makes the sixth kind reachable.
    const asks = rows.filter((r) => {
      if (r.action !== "message.create") return false
      const mentions = r.changes?.mentions
      return (
        Array.isArray(mentions) && mentions.some((m) => (m as { type?: string })?.type === "agent")
      )
    })
    expect(asks.length).toBeGreaterThan(0)
    // A routine tick names a routine this seeder really created.
    const ticks = rows.filter((r) => r.entity_type === "routine")
    expect(ticks.length).toBeGreaterThan(0)
  })

  it("the operations desk has a timeline too, so the tour never opens an empty one", async () => {
    const agentId = org.agentsByHandle["@operations"]?.agentId ?? ""
    expect(agentId).toBeTruthy()
    const rows = await activityTabRows(agentId)
    expect(rows.length).toBeGreaterThanOrEqual(8)
    expect(new Set(rows.map((r) => ACTIVITY_KIND_OF[r.action])).size).toBeGreaterThanOrEqual(4)
    await expectNoDanglingReferences(rows)
  })
})

/**
 * Every thread and routine a timeline row names is a row that is really there.
 *
 * This is the assertion the fixture exists to satisfy: a tab row whose
 * conversation does not resolve renders with a blank link, which reads as a
 * bug to anyone opening the page.
 */
async function expectNoDanglingReferences(
  rows: Array<{
    action: string
    entity_type: string | null
    entity_id: string | null
    changes: Record<string, unknown> | null
    metadata: Record<string, unknown> | null
  }>,
): Promise<void> {
  for (const row of rows) {
    const threadId = threadIdOf(row)
    if (threadId) {
      const found = await countOf(
        sql`SELECT count(*) AS count FROM kernel.threads
            WHERE org_id = ${org.orgId} AND id = ${threadId}::uuid`,
      )
      expect(found, `${row.action} names thread ${threadId}`).toBe(1)
    }
    if (row.entity_type === "routine" && row.entity_id) {
      const found = await countOf(
        sql`SELECT count(*) AS count FROM kernel.routines
            WHERE org_id = ${org.orgId} AND id = ${row.entity_id}::uuid`,
      )
      expect(found, `${row.action} names routine ${row.entity_id}`).toBe(1)
    }
  }
}

// ── The Memory tab's remembered conversations ────────────────────────────
//
// An episode is written by the CONSOLIDATION JOB six hours after a room goes
// quiet (spec-memory.md L102), so a freshly provisioned box has none: the
// "Past conversations" group stands empty over a rule and the header's
// "Forget this conversation" panel lists nothing, on an agent whose Activity
// tab is already showing a `memory_episode_written` row.
//
// Everything below is read back through the TAB'S OWN QUERY, never off the
// seeder's return value: `readTree` in `apps/api/src/modules/agent/memory/
// memory-routes.ts` selects the agent's rows under the caller's RLS, drops the
// ones `filterByVisibility` hides, and names each file with `pathForRow`. The
// panel then keeps whatever `threadOfPath` can name, which is exactly the
// `episodes/<handle>/` and `checkpoints/<handle>` prefixes. A row that query
// cannot see is a panel that opens empty whatever the table holds.

interface MemoryTabFile {
  path: string
  type: string
  sourceKind: string
  sourceThreadId: string | null
}

/** One agent, read the way `resolveAgent` reads it. */
async function agentRow(agentId: string): Promise<{ id: string; ownerUserId: string | null }> {
  const rows = await withSystemDb("agent-native-test-agent-row", (tx) =>
    tx.execute(sql`
      SELECT id, owner_user_id FROM kernel.agents WHERE id = ${agentId}::uuid LIMIT 1
    `),
  )
  const list = (Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? [])) as Array<{
    id: string
    owner_user_id: string | null
  }>
  if (!list[0]) throw new Error(`no agent ${agentId}`)
  return { id: list[0].id, ownerUserId: list[0].owner_user_id }
}

/**
 * THE MEMORY TAB'S OWN TREE, as the route builds it for the org admin.
 *
 * The owner predicate is the route's, verbatim: rows keyed on the agent, plus
 * rows an older build left keyed only on the owning human. The visibility
 * filter is the verbs' own, so a row the caller's scopes do not cover is
 * absent here exactly as it is absent in the tab.
 */
async function memoryTabFiles(agentId: string): Promise<MemoryTabFile[]> {
  const agent = await agentRow(agentId)
  const ctx = await adminCtx()
  const perms = await withPrivilegedDb(org.orgId, "agent-native-test-tree-perms", (tx) =>
    loadEffectivePermissions(tx, org.adminUserId, org.orgId),
  )
  const actor = {
    actorType: "user" as const,
    userId: org.adminUserId,
    orgId: org.orgId,
    scopes: perms.scopes,
    dimensionGrants: perms.dimensionGrants,
    roles: perms.roles,
  }
  const owned = agent.ownerUserId
    ? sql`(owner_agent_id = ${agent.id}::uuid
           OR (owner_agent_id IS NULL AND user_id = ${agent.ownerUserId}::uuid))`
    : sql`owner_agent_id = ${agent.id}::uuid`
  const raw = await withRlsContext(actor, (tx) =>
    (tx as { execute: (q: unknown) => Promise<unknown> }).execute(sql`
      SELECT type, name, path, description, content, required_scopes, source_kind, source_thread_id
      FROM kernel.agent_memory
      WHERE org_id = ${org.orgId}::uuid AND ${owned}
    `),
  )
  const rows = (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as Array<{
    type: string
    name: string
    path: string | null
    required_scopes: string[]
    source_kind: string
    source_thread_id: string | null
  }>
  const visible = filterByVisibility(
    rows.map((r) => ({ ...r, requiredScopes: r.required_scopes ?? [] })),
    { userId: ctx.userId, grants: ctx.scopes },
  )
  return visible
    .filter((r) => r.type !== "_index")
    .map((r) => ({
      path: pathForRow(r),
      type: r.type,
      sourceKind: r.source_kind,
      sourceThreadId: r.source_thread_id,
    }))
}

/** The `MEMORY.md` row, which is what carries the folder line per thread. */
async function memoryIndexBody(agentId: string): Promise<string> {
  const rows = await withSystemDb("agent-native-test-index-body", (tx) =>
    tx.execute(sql`
      SELECT content FROM kernel.agent_memory
      WHERE org_id = ${org.orgId}::uuid AND owner_agent_id = ${agentId}::uuid
        AND type = '_index' LIMIT 1
    `),
  )
  const list = (Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? [])) as Array<{
    content: string
  }>
  return list[0]?.content ?? ""
}

/** `threadOfPath` from `apps/web/src/modules/agent/agent-memory-store.ts`: the
 *  only handle the Forget panel has for a conversation. */
function threadOfPath(path: string): string | null {
  if (path.startsWith("episodes/")) return path.split("/")[1] || null
  if (path.startsWith("checkpoints/")) {
    return path.slice("checkpoints/".length).replace(/\.md$/, "") || null
  }
  return null
}

describe("the Memory tab's remembered conversations", () => {
  /** The three agents the tour opens: the owner's own, and the two desks. */
  async function targets(): Promise<Array<[string, string]>> {
    return [
      ["the owner's personal agent", await ownerAgentId()],
      ["@support", org.agentsByHandle["@support"]?.agentId ?? ""],
      ["@operations", org.agentsByHandle["@operations"]?.agentId ?? ""],
    ]
  }

  it("each agent's Forget panel lists at least two conversations it remembers", async () => {
    for (const [label, agentId] of await targets()) {
      expect(agentId, `${label} must exist`).toBeTruthy()
      const files = await memoryTabFiles(agentId)
      const episodes = files.filter((f) => f.path.startsWith("episodes/"))
      // Without the fixture this is zero for all three, which is the empty
      // group and the empty panel the QA tour opens.
      expect(episodes.length, `${label} episodes`).toBeGreaterThanOrEqual(2)
      for (const file of episodes) {
        expect(file.type, `${file.path} type`).toBe("episode")
        // The job's provenance, not a human edit: the tab refuses to edit one.
        expect(file.sourceKind, `${file.path} sourceKind`).toBe("consolidation")
      }
      // What the panel actually renders: one named conversation per handle.
      const remembered = [
        ...new Set(files.map((f) => threadOfPath(f.path)).filter(Boolean)),
      ] as string[]
      expect(remembered.length, `${label} remembered conversations`).toBeGreaterThanOrEqual(2)
    }
  }, 600_000)

  it("every episode points at a conversation that is really there, and its index line with it", async () => {
    for (const [label, agentId] of await targets()) {
      const files = await memoryTabFiles(agentId)
      const episodes = files.filter((f) => f.path.startsWith("episodes/"))
      const indexBody = await memoryIndexBody(agentId)
      for (const file of episodes) {
        // Forget resolves the thread by HANDLE and 404s when it is gone, so an
        // episode naming a handle no thread carries is a panel row that cannot
        // be acted on at all.
        const handle = threadOfPath(file.path)
        expect(handle, `${file.path} must name a thread`).toBeTruthy()
        const byHandle = await countOf(
          sql`SELECT count(*) AS count FROM kernel.threads
              WHERE org_id = ${org.orgId} AND handle = ${handle}`,
        )
        expect(byHandle, `${label}: ${file.path} names thread handle ${handle}`).toBe(1)
        // And the delete predicate's own column: forget deletes on
        // `source_thread_id`, not on the path.
        expect(file.sourceThreadId, `${file.path} sourceThreadId`).toBeTruthy()
        const byId = await countOf(
          sql`SELECT count(*) AS count FROM kernel.threads
              WHERE org_id = ${org.orgId} AND id = ${file.sourceThreadId}::uuid`,
        )
        expect(byId, `${label}: ${file.path} source thread`).toBe(1)
        // The companion the writer keeps in step: a folder line in MEMORY.md.
        // An episode the index does not point at is a file nothing recalls.
        expect(indexBody, `${label} index must point at episodes/${handle}/`).toContain(
          `](episodes/${handle}/)`,
        )
      }
      // The other half of what Forget deletes, so the panel's own count is not
      // half of what a real forget would remove.
      const checkpoints = await countOf(
        sql`SELECT count(*) AS count FROM kernel.agent_thread_checkpoints
            WHERE org_id = ${org.orgId} AND agent_id = ${agentId}`,
      )
      expect(checkpoints, `${label} checkpoint versions`).toBeGreaterThanOrEqual(2)
    }
  }, 600_000)

  it("re-seeding leaves every agent with the same remembered conversations", async () => {
    const before = new Map<string, string[]>()
    for (const [label, agentId] of await targets()) {
      before.set(
        label,
        (await memoryTabFiles(agentId))
          .filter((f) => f.path.startsWith("episodes/"))
          .map((f) => f.path)
          .sort(),
      )
    }
    const episodesBefore = await countOf(
      sql`SELECT count(*) AS count FROM kernel.agent_memory
          WHERE org_id = ${org.orgId} AND type = 'episode'`,
    )
    const checkpointsBefore = await countOf(
      sql`SELECT count(*) AS count FROM kernel.agent_thread_checkpoints
          WHERE org_id = ${org.orgId}`,
    )

    await seedDemoAgentNative(org, { baseTime: BASE_TIME })

    for (const [label, agentId] of await targets()) {
      const after = (await memoryTabFiles(agentId))
        .filter((f) => f.path.startsWith("episodes/"))
        .map((f) => f.path)
        .sort()
      // Not merely the same count: `writeEpisode` disambiguates a same day
      // collision with a `-2` suffix, so a seeder that inserted blindly would
      // grow a second file per run under a path nobody asked for.
      expect(after, `${label} episodes after a re-seed`).toEqual(before.get(label) ?? [])
    }
    expect(
      await countOf(
        sql`SELECT count(*) AS count FROM kernel.agent_memory
            WHERE org_id = ${org.orgId} AND type = 'episode'`,
      ),
    ).toBe(episodesBefore)
    expect(
      await countOf(
        sql`SELECT count(*) AS count FROM kernel.agent_thread_checkpoints
            WHERE org_id = ${org.orgId}`,
      ),
    ).toBe(checkpointsBefore)
  }, 600_000)
})
