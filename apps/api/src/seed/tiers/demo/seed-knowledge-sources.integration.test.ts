// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The company knowledge scenario's world, against a real database: the two
// synced sources and their documents as the product writes them, the access
// each document carries, and the live beat in which Lucas (support) asks
// Support Desk for the Q3 gross margin. Support Desk's turn runs as Lucas, and
// the database (RLS) gives that turn no P&L, while a turn the founder or the
// visitor starts reads it. The beat asks once per run of the scenario.
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { sql } from "drizzle-orm"
import {
  getDocumentSharing,
  knowledgeActorFromContext,
  loadKnowledgeDocument,
} from "~/apps/knowledge/service"
import { withPrivilegedDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { AgentServiceTestAccess, invokeAgentForThread } from "~/modules/agent/runtime/agent-service"
import * as toolBridgeModule from "~/modules/agent/tools/tool-bridge"
import { invalidateDemoMarker } from "~/modules/demo/demo-org"
import {
  KNOWLEDGE_WORLD_CHANNEL,
  knowledgeLucasAsksInjector,
} from "~/modules/demo/world/knowledge-lucas-asks"
import { sendMessage } from "~/modules/threads/message"
import { worldActor } from "~/seed/world/people"
import { PL_TITLE, seedKnowledgeSources } from "./seed-knowledge-sources"
import { type SeedDemoOrgResult, seedDemoOrg } from "./seed-org"

const ORG_SLUG = `demo-knowledge-sources-${Date.now()}`
const DB_URL = process.env.DATABASE_URL ?? ""
const ORIG_ANTHROPIC_KEY = process.env.LIAISON_ANTHROPIC_API_KEY
const MODEL_ID = "claude-haiku-4-5-knowledge-scenario"

function stubStreamText() {
  return {
    fullStream: (async function* () {
      yield { type: "text-delta", text: "I can't find any finance figures you have access to." }
      yield {
        type: "finish-step",
        usage: { inputTokens: 10, outputTokens: 1 },
        finishReason: "stop",
      }
      yield { type: "finish", finishReason: "stop" }
    })(),
  } as never
}

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[]
  return ((result as { rows?: unknown[] }).rows ?? []) as T[]
}

let org: SeedDemoOrgResult
let ownerId: string
let plId: string

function person(key: string): string {
  const id = org.peopleByKey[key]?.userId
  if (!id) throw new Error(`no seeded person ${key}`)
  return id
}

async function query<T>(q: ReturnType<typeof sql>): Promise<T[]> {
  return withPrivilegedDb(org.orgId, "demo-knowledge-test", async (tx) =>
    rowsOf<T>(await tx.execute(q)),
  )
}

/** Does the real RLS policy let `actor` see the P&L? */
async function seesPl(actor: UserContext): Promise<boolean> {
  const rows = await withRlsContext(actor, async (tx) =>
    rowsOf<{ id: string }>(
      await tx.execute(sql`SELECT id FROM app_knowledge.documents WHERE id = ${plId}::uuid`),
    ),
  )
  return rows.length === 1
}

/** The actor the turn hands its tools, waiting for the turn `start` sets going. */
async function turnActor(start: () => Promise<unknown>): Promise<UserContext> {
  const buildSpy = spyOn(toolBridgeModule, "buildToolSet")
  try {
    await start()
    const deadline = Date.now() + 20_000
    while (buildSpy.mock.calls.length === 0 && Date.now() < deadline) await Bun.sleep(50)
    const actor = buildSpy.mock.calls[0]?.[1]
    if (actor?.actorType !== "user") throw new Error("the turn never built its tools")
    return actor
  } finally {
    buildSpy.mockRestore()
  }
}

beforeAll(async () => {
  if (DB_URL === "") throw new Error("DATABASE_URL must be set for this test")
  if (/liaison_dev|liaison_test(?!_)/.test(DB_URL)) {
    throw new Error("refusing to seed a shared database")
  }
  if (!process.env.LIAISON_APPS_DIR) {
    process.env.LIAISON_APPS_DIR = path.join(mkdtempSync(path.join(tmpdir(), "demo-kn-")), "apps")
  }
  org = await seedDemoOrg({
    orgSlug: ORG_SLUG,
    variant: "visitor",
    owner: {
      email: `visitor-${Date.now()}@visitor.demo.invalid`,
      name: "Visitor",
      password: "Visitor1!Seed",
    },
  })
  ownerId = org.adminUserId
  const founder = await worldActor(org.orgId, person("elodie"))
  await seedKnowledgeSources(org, founder, new Date(), () => {})
  // A second run (a re-seed) writes nothing new.
  await seedKnowledgeSources(org, founder, new Date(), () => {})
  const [pl] = await query<{ id: string }>(
    sql`SELECT id FROM app_knowledge.documents WHERE org_id = ${org.orgId}::uuid AND title = ${PL_TITLE}`,
  )
  if (!pl) throw new Error("the P&L was not seeded")
  plId = pl.id
}, 900_000)

afterAll(async () => {
  AgentServiceTestAccess.setStreamText()
  if (ORIG_ANTHROPIC_KEY !== undefined) process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
  else delete process.env.LIAISON_ANTHROPIC_API_KEY
})

describe("the seeded knowledge sources", () => {
  it("two synced sources with real metadata, synced recently, and no connected account", async () => {
    const sources = await query<{
      app_name: string
      display_name: string
      last_sync_status: string
      last_sync_at: Date
    }>(sql`SELECT app_name, display_name, last_sync_status, last_sync_at
      FROM app_knowledge.synced_sources WHERE org_id = ${org.orgId}::uuid ORDER BY app_name`)
    expect(sources.map((s) => [s.app_name, s.display_name, s.last_sync_status])).toEqual([
      ["gitlab", "resonant/manuals", "ok"],
      ["google-drive", "Finance", "ok"],
    ])
    for (const s of sources) {
      const age = Date.now() - new Date(s.last_sync_at).getTime()
      expect(age).toBeGreaterThan(0)
      expect(age).toBeLessThan(3 * 3_600_000)
    }
    const accounts = await query<{
      n: number
    }>(sql`SELECT count(*)::int AS n FROM kernel.connected_accounts
      WHERE org_id = ${org.orgId}::uuid AND app_name IN ('gitlab', 'google-drive')`)
    expect(accounts[0]?.n).toBe(0)
  })

  it("the synced documents and the playbook, once each, with their sensitivity and access", async () => {
    const docs = await query<{
      title: string
      sensitivity: string
      org_access: string
      app_name: string | null
    }>(sql`SELECT d.title, d.sensitivity, d.org_access, s.app_name
      FROM app_knowledge.documents d
      LEFT JOIN app_knowledge.synced_sources s ON s.id = d.synced_source_id
      WHERE d.org_id = ${org.orgId}::uuid AND d.title IN (
        'Kestrel 10 user manual', 'Field Preamp firmware notes', ${PL_TITLE},
        'Cash forecast, next 6 months', 'Marketing funnel playbook')
      ORDER BY d.title`)
    expect(docs.map((d) => [d.title, d.sensitivity, d.org_access, d.app_name])).toEqual([
      ["Cash forecast, next 6 months", "confidential", "none", "google-drive"],
      ["Field Preamp firmware notes", "internal", "viewer", "gitlab"],
      ["Kestrel 10 user manual", "internal", "viewer", "gitlab"],
      ["Marketing funnel playbook", "internal", "viewer", null],
      [PL_TITLE, "confidential", "none", "google-drive"],
    ])
  })

  it("the P&L is shared with finance (viewer), admin (editor) and Henrik (viewer), as the Share dialog reads it", async () => {
    const founder = await worldActor(org.orgId, person("elodie"))
    const sharing = await withRlsContext(founder, (tx) =>
      getDocumentSharing(
        tx,
        plId,
        knowledgeActorFromContext({
          orgId: org.orgId,
          userId: founder.userId,
          scopes: founder.scopes,
          dimensionGrants: founder.dimensionGrants,
          roles: founder.roles ?? [],
        }),
      ),
    )
    const roles = await query<{ id: string; name: string }>(
      sql`SELECT id, name FROM kernel.roles WHERE org_id = ${org.orgId}::uuid`,
    )
    const roleName = new Map(roles.map((r) => [r.id, r.name]))
    expect(sharing.orgAccess).toBe("none")
    expect(sharing.shares).toEqual([{ userId: person("henrik"), role: "viewer" }])
    expect((sharing.roleShares ?? []).map((r) => [roleName.get(r.roleId), r.role]).sort()).toEqual([
      ["admin", "editor"],
      ["finance", "viewer"],
    ])
  })

  it("the database lets the visitor, the founder and Henrik read the P&L, and not Lucas", async () => {
    expect(await seesPl(await worldActor(org.orgId, ownerId))).toBe(true)
    expect(await seesPl(await worldActor(org.orgId, person("henrik")))).toBe(true)
    expect(await seesPl(await worldActor(org.orgId, person("elodie")))).toBe(true)
    const lucas = await worldActor(org.orgId, person("lucas"))
    expect(await seesPl(lucas)).toBe(false)
    const asLucas = await withRlsContext(lucas, (tx) =>
      loadKnowledgeDocument(
        tx,
        plId,
        knowledgeActorFromContext({
          orgId: org.orgId,
          userId: lucas.userId,
          scopes: lucas.scopes,
          dimensionGrants: lucas.dimensionGrants,
          roles: lucas.roles ?? [],
        }),
      ),
    )
    expect(asLucas).toBeNull()
  })
})

describe("knowledge-lucas-asks", () => {
  beforeAll(async () => {
    // The turns run as in any workspace: the demo's spend gates (the visitor's
    // verified email, the box key) are the registry's and the meter's, tested
    // with them; here the turn is the one under test.
    await withPrivilegedDb(org.orgId, "demo-knowledge-test-unmark", (tx) =>
      tx.execute(sql`UPDATE kernel.organizations SET settings = settings - 'demo'
        WHERE id = ${org.orgId}::uuid`),
    )
    invalidateDemoMarker(org.orgId)
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    AgentServiceTestAccess.setStreamText(stubStreamText as never)
    await withPrivilegedDb(org.orgId, "demo-knowledge-test-credits", async (tx) => {
      await tx.execute(sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency)
        VALUES (${org.orgId}::uuid, '10.00000000', '0', 'EUR')
        ON CONFLICT (org_id) DO UPDATE SET included_balance = '10.00000000'`)
      await tx.execute(sql`INSERT INTO kernel.model_pricing (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum)
        VALUES ('anthropic', ${MODEL_ID}, 'Knowledge scenario stub', '1.00', '5.00', 200000, true, 'starter')
        ON CONFLICT DO NOTHING`)
    })
  })

  afterAll(async () => {
    await withPrivilegedDb(org.orgId, "demo-knowledge-test-pricing", (tx) =>
      tx.execute(sql`DELETE FROM kernel.model_pricing WHERE model_id = ${MODEL_ID}`),
    )
  })

  it("Lucas asks Support Desk in #support, and its turn runs as Lucas: the database gives it no P&L", async () => {
    const lucas = person("lucas")
    const ctx = {
      orgId: org.orgId,
      ownerUserId: ownerId,
      tourId: "kernel.scenario-knowledge",
      beatId: "lucas-asks",
      run: 0,
      runStartedAt: new Date(Date.now() - 1_000),
    }
    const actor = await turnActor(() => knowledgeLucasAsksInjector.injectWorldEvent(ctx))
    expect(actor.userId).toBe(lucas)
    const lucasRoles = (await worldActor(org.orgId, lucas)).roles ?? []
    expect(lucasRoles.length).toBeGreaterThan(0)
    expect([...(actor.roles ?? [])].sort()).toEqual([...lucasRoles].sort())
    expect(await seesPl(actor)).toBe(false)

    // The channel the beat records: Lucas's question in it, the visitor seated.
    const channelId = await knowledgeLucasAsksInjector.entityOf?.(ctx)
    expect(channelId).toBeTruthy()
    const asked = await query<{ content: string; author_id: string }>(
      sql`SELECT content, author_id FROM kernel.messages WHERE thread_id = ${channelId}::uuid
        AND author_type = 'user'`,
    )
    expect(asked).toHaveLength(1)
    expect(asked[0]?.author_id).toBe(lucas)
    expect(asked[0]?.content).toContain("what was our gross margin in Q3?")
    const seats = await query<{ user_id: string }>(
      sql`SELECT user_id FROM kernel.thread_participants WHERE thread_id = ${channelId}::uuid`,
    )
    expect(seats.map((s) => s.user_id)).toEqual(expect.arrayContaining([lucas, ownerId]))
  })

  it("the same question from the visitor in that channel: the turn reads the P&L", async () => {
    const [channel] = await query<{ id: string }>(
      sql`SELECT id FROM kernel.threads WHERE org_id = ${org.orgId}::uuid AND title = ${KNOWLEDGE_WORLD_CHANNEL}`,
    )
    if (!channel) throw new Error("no #support")
    const owner = await worldActor(org.orgId, ownerId)
    const msg = await withRlsContext(owner, (tx) =>
      sendMessage(tx, {
        orgId: org.orgId,
        userId: ownerId,
        threadId: channel.id,
        content: "What was our gross margin in Q3?",
        requiredScopes: [],
      }),
    )
    if (!msg) throw new Error("the visitor could not post")
    const actor = await turnActor(() =>
      invokeAgentForThread(
        channel.id,
        msg.id,
        {
          userId: ownerId,
          orgId: org.orgId,
          scopes: owner.scopes,
          dimensionGrants: owner.dimensionGrants,
        },
        org.orgId,
      ),
    )
    expect(actor.userId).toBe(ownerId)
    expect(await seesPl(actor)).toBe(true)
  })

  it("asks once per run: a second pass adds nothing, Start again asks again in the same channel", async () => {
    const ctx = {
      orgId: org.orgId,
      ownerUserId: ownerId,
      tourId: "kernel.scenario-knowledge",
      beatId: "lucas-asks",
      run: 0,
      runStartedAt: new Date(Date.now() - 60_000),
    }
    const count = async () =>
      (
        await query<{ n: number }>(sql`SELECT count(*)::int AS n FROM kernel.messages m
          JOIN kernel.threads t ON t.id = m.thread_id
          WHERE t.org_id = ${org.orgId}::uuid AND t.title = ${KNOWLEDGE_WORLD_CHANNEL}
            AND m.author_id = ${person("lucas")}::uuid`)
      )[0]?.n ?? 0
    const before = await count()
    await knowledgeLucasAsksInjector.injectWorldEvent(ctx)
    expect(await count()).toBe(before)
    await Bun.sleep(5)
    const next = { ...ctx, run: 1, runStartedAt: new Date() }
    await knowledgeLucasAsksInjector.injectWorldEvent(next)
    await knowledgeLucasAsksInjector.injectWorldEvent(next)
    expect(await count()).toBe(before + 1)
    const channels = await query<{ id: string }>(
      sql`SELECT id FROM kernel.threads WHERE org_id = ${org.orgId}::uuid AND title = ${KNOWLEDGE_WORLD_CHANNEL}`,
    )
    expect(channels).toHaveLength(1)
    expect(await knowledgeLucasAsksInjector.entityOf?.(next)).toBe(channels[0]?.id)
  })
})
