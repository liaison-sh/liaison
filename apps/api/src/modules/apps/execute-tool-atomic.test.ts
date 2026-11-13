// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Regression for the `atomic: true` branch of executeToolHandler.
//
// Under bridge-owned transactions, a manifest tool's DEFAULT contract is
// PER-CALL commit: each bridge method call (db_insert, etc.) opens and
// commits its own short RLS transaction, so an early write survives a later
// handler-level throw (pinned by rpc-bridge-session.test.ts). A tool that
// declares `atomic: true` on its registry entry keeps the LEGACY whole-run
// ambient transaction instead (execute-tool.ts ~line 1686-1703): the entire
// handler run — every bridge call it makes — shares ONE transaction that
// commits or rolls back together.
//
// This test drives that branch end to end via `executeTool()` (the same
// entrypoint `execute-tool-sandbox.test.ts` uses), which always builds a
// fresh `RlsSession` and hands it to `executeToolHandler` — the session/atomic
// branching under test lives entirely inside that function, not in the
// caller. Two registry entries share one on-disk bundle (two exported
// handlers): one that performs two writes then throws, one that performs the
// same two writes and returns normally. `atomic: true` vs `atomic` absent on
// the registry entry is the only variable between the rollback and
// no-rollback assertions.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { resetAppRegistries, toolRegistry } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { generateRlsPolicySql } from "~/modules/permissions/rls-generator"

const SCHEMA = "app_atomictooltest"
const APP_NAME = "atomictooltest"
const ORG_A = "00000000-0000-0000-0000-0000000e0a01"
const USER_A = "00000000-0000-0000-0000-0000000e0a02"

const MANIFEST = {
  name: APP_NAME,
  schema: {
    items: {
      fields: { title: "string", status: "string" },
    },
  },
  events: { emits: [] },
  connections: {},
  network: { allowedDomains: [] },
} as const

function itemsTable(): string {
  return `"${SCHEMA}".items`
}

const BUNDLE_SOURCE = `
async function twoWritesThenThrow(params, ctx) {
  await ctx.db_insert("items", JSON.stringify({ title: "atomic-w1", status: "open" }));
  await ctx.db_insert("items", JSON.stringify({ title: "atomic-w2", status: "open" }));
  throw new Error("boom");
}
async function twoWrites(params, ctx) {
  await ctx.db_insert("items", JSON.stringify({ title: "atomic-w1", status: "open" }));
  await ctx.db_insert("items", JSON.stringify({ title: "atomic-w2", status: "open" }));
  return { ok: true };
}
async function writeThenCallOutside(params, ctx) {
  await ctx.db_insert("items", JSON.stringify({ title: "atomic-w1", status: "open" }));
  try {
    await ctx.fetch("https://example.test/x", "{}");
    return { called: true };
  } catch (err) {
    return { refused: err && err.code ? err.code : String(err && err.message) };
  }
}
`

const BUNDLE_PATH = "/tmp/test-execute-tool-atomic-bundle.js"

const ACTOR_A = {
  actorType: "user" as const,
  userId: USER_A,
  orgId: ORG_A,
  scopes: ["*"],
  dimensionGrants: {},
}

async function setUpSchema(): Promise<void> {
  await sql.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
  await sql.unsafe(`CREATE SCHEMA "${SCHEMA}"`)
  await sql.unsafe(`
    CREATE TABLE ${itemsTable()} (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
  for (const role of ["liaison_rls", "liaison_admin"]) {
    await sql.unsafe(`GRANT USAGE ON SCHEMA "${SCHEMA}" TO ${role}`).catch(() => {})
    await sql.unsafe(`GRANT ALL ON ALL TABLES IN SCHEMA "${SCHEMA}" TO ${role}`).catch(() => {})
  }
  const policySql = generateRlsPolicySql(
    SCHEMA,
    "items",
    {},
    APP_NAME,
    "items",
    MANIFEST.schema.items.fields as Record<string, unknown>,
  )
  for (const stmt of policySql.split(";").filter((s) => s.trim())) {
    await sql.unsafe(`${stmt};`)
  }
}

async function tearDownSchema(): Promise<void> {
  await sql.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
}

async function seedOrgAndUser(): Promise<void> {
  await sql`INSERT INTO kernel.organizations (id, name, slug)
    VALUES (${ORG_A}, 'Atomic Tool Org', 'atomic-tool-org')
    ON CONFLICT (id) DO NOTHING`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, status, auth_version)
    VALUES (${USER_A}, ${ORG_A}, 'atomic-tool-a@test.com', 'Atomic Tool User A', 'active', 1)
    ON CONFLICT (id) DO NOTHING`
}

async function cleanupOrgAndUser(): Promise<void> {
  await sql`DELETE FROM kernel.users WHERE id = ${USER_A}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_A}`
}

async function titlesPresent(): Promise<string[]> {
  const rows = await withPrivilegedDb(ORG_A, "atomic-tool-read", async (tx) => {
    return extractRows<{ title: string }>(
      await tx.execute(
        drizzleSql`SELECT title FROM ${drizzleSql.raw(itemsTable())} WHERE org_id = ${ORG_A}::uuid ORDER BY title`,
      ),
    )
  })
  return rows.map((r) => r.title)
}

describe("executeToolHandler — atomic: true keeps the legacy whole-run ambient transaction", () => {
  beforeAll(async () => {
    await setUpSchema()
    await seedOrgAndUser()
    await Bun.write(BUNDLE_PATH, BUNDLE_SOURCE)
    await initSandboxPool()
  }, 60_000)

  afterAll(async () => {
    await shutdownSandboxPool()
    await tearDownSchema()
    await cleanupOrgAndUser()
  }, 60_000)

  afterEach(async () => {
    await sql.unsafe(`DELETE FROM ${itemsTable()}`)
    resetAppRegistries()
  })

  it("atomic: true — a handler that writes twice then throws rolls back BOTH writes", async () => {
    toolRegistry.set([ORG_A, APP_NAME, "twoWritesThenThrow"], {
      appName: APP_NAME,
      name: "twoWritesThenThrow",
      description: "two writes then throw",
      requiredScopes: [`${APP_NAME}:items:write`],
      handler: { bundlePath: BUNDLE_PATH, exportName: "twoWritesThenThrow", core: true },
      _manifest: MANIFEST,
      atomic: true,
    } as any)

    await expect(
      executeTool({
        toolName: `${APP_NAME}:twoWritesThenThrow`,
        orgId: ORG_A,
        actor: ACTOR_A,
        params: {},
      }),
    ).rejects.toThrow()

    // Whole-run ambient transaction: the throw rolls back BOTH earlier writes.
    expect(await titlesPresent()).toEqual([])
  })

  it("atomic: false (absent) — the SAME shaped handler commits the first write per-call, independent of the later throw", async () => {
    toolRegistry.set([ORG_A, APP_NAME, "twoWritesThenThrowNonAtomic"], {
      appName: APP_NAME,
      name: "twoWritesThenThrowNonAtomic",
      description: "two writes then throw, non-atomic tool",
      requiredScopes: [`${APP_NAME}:items:write`],
      handler: { bundlePath: BUNDLE_PATH, exportName: "twoWritesThenThrow", core: true },
      _manifest: MANIFEST,
      // atomic intentionally omitted — per-call bridge-owned transactions.
    } as any)

    await expect(
      executeTool({
        toolName: `${APP_NAME}:twoWritesThenThrowNonAtomic`,
        orgId: ORG_A,
        actor: ACTOR_A,
        params: {},
      }),
    ).rejects.toThrow()

    // Per-call commit: the first write persisted before the handler threw.
    expect(await titlesPresent()).toContain("atomic-w1")
  })

  it("atomic: true — a handler that completes successfully commits both writes together", async () => {
    toolRegistry.set([ORG_A, APP_NAME, "twoWrites"], {
      appName: APP_NAME,
      name: "twoWrites",
      description: "two writes, no throw",
      requiredScopes: [`${APP_NAME}:items:write`],
      handler: { bundlePath: BUNDLE_PATH, exportName: "twoWrites", core: true },
      _manifest: MANIFEST,
      atomic: true,
    } as any)

    const result = await executeTool({
      toolName: `${APP_NAME}:twoWrites`,
      orgId: ORG_A,
      actor: ACTOR_A,
      params: {},
    })

    expect(result.data).toEqual({ ok: true })
    expect(await titlesPresent()).toEqual(["atomic-w1", "atomic-w2"])
  })

  it("atomic: true — a call outside the database is refused while the run holds its transaction", async () => {
    toolRegistry.set([ORG_A, APP_NAME, "writeThenCallOutside"], {
      appName: APP_NAME,
      name: "writeThenCallOutside",
      description: "a write, then an outside call",
      requiredScopes: [`${APP_NAME}:items:write`],
      handler: { bundlePath: BUNDLE_PATH, exportName: "writeThenCallOutside", core: true },
      _manifest: MANIFEST,
      atomic: true,
    } as any)

    const result = await executeTool({
      toolName: `${APP_NAME}:writeThenCallOutside`,
      orgId: ORG_A,
      actor: ACTOR_A,
      params: {},
    })

    expect(JSON.stringify(result.data)).toContain("atomic_run_egress_refused")
    // The local write still commits with the run.
    expect(await titlesPresent()).toEqual(["atomic-w1"])
  })
})
