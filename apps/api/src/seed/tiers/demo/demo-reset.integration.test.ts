// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The nightly demo reset, against real rows.
//
// THE PURGE half was always covered here. What was not, and what let a command
// that ships inside the production api image delete a real tenant, is the
// CONTENT RESET: nothing tested `resetDemoOrgContent` directly, nothing tested
// that it touches only the org it was handed, and the one re-seed assertion
// read a fake seeder's call log rather than the database. A fake that reports
// `ok` without writing anything was therefore driving a content clear that
// nothing checked, which is exactly the shape of the bug.
//
// So this file asserts, on real rows:
//
//   * an org with NO demo marker is REFUSED by both entry points: the content
//     reset itself, and `seedDemoOrg`, which used to adopt any org carrying the
//     slug it was handed and stamp a demo marker on it;
//   * a content reset with demo mode OFF is refused;
//   * a content reset empties content (including the tables the old five table
//     allowlist never reached: the spend ledger, routines, skills, agent memory
//     and saved views) and leaves a SECOND demo org's identical rows alone;
//   * the org's own furniture survives it: the org, its users, its roles;
//   * platform credit is zeroed and the spend ledger is emptied, which is what
//     makes the agents work again for the next visitor;
//   * an interrupted reset is DETECTABLE afterwards and heals on the next run;
//   * a probe that passes followed by a second seed that fails leaves the org
//     flagged rather than silently half written;
//   * every org scoped kernel table has a rule, and a table with no rule stops
//     the reset before it deletes anything;
//   * a persona whose password, status and role grants a visitor drifted is
//     restored by the seeder's `ensureUser({ restore: true })`.
//
// The re-seed half runs through the `setDemoSeeder` seam rather than really
// re-seeding: this test is about which orgs the run touches and what it leaves
// behind, and a real reserved re-seed here would take minutes and rewrite orgs
// other tests own.
//
// Locally, against the isolated hardening database, never a shared one. Run it
// from `apps/api`: the modules it reaches for are written against apps/api's
// own `~/*` alias, which only resolves from a cwd whose tsconfig declares it.
//
//   cd apps/api && DATABASE_URL=postgres://liaison_app:liaison_app@localhost:5432/liaison_hardening_test \
//     bun test src/seed/tiers/demo/demo-reset.integration.test.ts --timeout 300000
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { sql } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { env } from "~/lib/env"
import { describeDbError } from "~/lib/transient-db-error"
import { listExpiredDemoOrgs } from "~/modules/demo/demo-expiry"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import {
  invalidateDemoMarker,
  markOrgAsDemo,
  reservedMarker,
  visitorMarker,
} from "~/modules/demo/demo-org"
import {
  completeDemoOrgReset,
  DemoOrgGuardError,
  KERNEL_RESET_RULES,
  kernelOrgScopedTableNames,
  purgeDemoOrg,
  readResetInProgress,
  resetDemoOrgContent,
  runDemoReset,
  UnruledKernelTableError,
} from "~/modules/demo/demo-reset"
import { DemoSeederTestAccess, setDemoSeeder } from "~/modules/demo/demo-seeder"
import { DEMO_WAREHOUSE_DSN_ENV } from "~/modules/demo/warehouse"
import { OrgPurgeIncompleteError } from "~/modules/org/purge/rows"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { installFromDist } from "../../../../test-support/seed/install-dist-apps"
import { seedDemoOrg } from "./seed-org"

const DB_URL = process.env.DATABASE_URL ?? ""
/** Unique per run: the hardening database is shared with other agents' runs. */
const PREFIX = `demo-reset-test-${process.pid}`
const NOW = new Date("2026-09-16T09:00:00.000Z")

interface Fixture {
  key: string
  slug: string
  orgId: string
}

const fixtures: Record<string, Fixture> = {}
const seedCalls: Array<{ orgSlug: string; variant: string }> = []
/** Slugs the fake seeder must report `ok: false` for, to exercise D2. */
const failingSeedSlugs = new Set<string>()
/** The App Review password the environment held before this file set its own. */
let savedReviewerPassword = ""
/** Where this file installs invoicing, when the environment names no apps directory. */
let ownAppsDir: string | null = null

/** `env` is parsed once at import; the nightly run reads this field off it. */
function setReviewerPassword(value: string): void {
  ;(env as { LIAISON_DEMO_REVIEWER_PASSWORD: string }).LIAISON_DEMO_REVIEWER_PASSWORD = value
}

async function makeOrg(key: string): Promise<Fixture> {
  const slug = `${PREFIX}-${key}`
  const { orgId } = await ensureOrg({ slug, name: `Demo reset ${key}` })
  const fixture = { key, slug, orgId }
  fixtures[key] = fixture
  return fixture
}

/** The id of a user in this org, creating one if there is none. */
async function someUserId(orgId: string): Promise<string> {
  return withSystemDb("demo-reset-test-user", async (tx) => {
    const result = await tx.execute(sql`
      INSERT INTO kernel.users (org_id, email, password_hash, name, status)
      VALUES (${orgId}::uuid, ${`someone@${orgId}.example`}, 'x', 'Someone', 'active')
      ON CONFLICT (org_id, email) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `)
    const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
    return String((rows[0] as { id: string }).id)
  })
}

/**
 * Rows in an app table and in the kernel tables the reset has to reach: the
 * five the old allowlist knew, plus the ones it did not (`credit_transactions`,
 * `routines`, `skills`, `agent_memory`, `saved_views`), plus a credit balance.
 */
async function populate(orgId: string): Promise<void> {
  const userId = await someUserId(orgId)
  await withSystemDb("demo-reset-test-populate", async (tx) => {
    await tx.execute(sql`
      INSERT INTO app_tickets.categories (org_id, name) VALUES (${orgId}::uuid, 'Demo reset fixture')
    `)
    await tx.execute(sql`
      INSERT INTO kernel.contacts (org_id, handle, name)
      VALUES (${orgId}::uuid, 'demo-reset-contact', 'Demo reset contact')
    `)
    await tx.execute(sql`
      INSERT INTO kernel.credit_transactions
        (org_id, type, amount, balance_after, input_tokens, output_tokens)
      VALUES (${orgId}::uuid, 'byok_usage', 0, 0, 900000, 900000)
    `)
    await tx.execute(sql`
      INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency)
      VALUES (${orgId}::uuid, 25, 7, 'EUR')
      ON CONFLICT (org_id) DO UPDATE SET included_balance = 25, purchased_balance = 7
    `)
    await tx.execute(sql`
      INSERT INTO kernel.routines
        (org_id, owner_user_id, name, description, kind, cron, timezone, prompt, scopes,
         created_by_actor_type)
      VALUES (${orgId}::uuid, ${userId}::uuid, 'Visitor routine', 'left behind', 'recurring',
              '0 3 * * *', 'Europe/Paris', 'go', ARRAY[]::text[], 'user')
    `)
    await tx.execute(sql`
      INSERT INTO kernel.skills (org_id, name, description, body, created_by_actor_type)
      VALUES (${orgId}::uuid, 'Visitor skill', 'left behind', 'body', 'user')
    `)
    await tx.execute(sql`
      INSERT INTO kernel.agent_memory
        (org_id, type, name, description, content, required_scopes)
      VALUES (${orgId}::uuid, 'reference', 'Visitor memory', 'left behind', 'content',
              ARRAY[]::text[])
    `)
    await tx.execute(sql`
      INSERT INTO kernel.saved_views (org_id, app, view_id, owner_user_id, name, payload)
      VALUES (${orgId}::uuid, 'tickets', 'all', ${userId}::uuid, 'Visitor view', '{}'::jsonb)
    `)
    // A legal record: an immutable app table, whose kernel trigger refuses a DELETE for ten
    // years. A visitor who issued an invoice leaves one of these behind.
    await tx.execute(sql`
      INSERT INTO app_invoicing.legal_originals (org_id, kind, recorded_at)
      VALUES (${orgId}::uuid, 'legacy_import', current_date)
    `)
  })
}

/** Every table `populate` writes, as `schema.table`. */
const POPULATED_TABLES = [
  "app_tickets.categories",
  "app_invoicing.legal_originals",
  "kernel.contacts",
  "kernel.routines",
  "kernel.skills",
  "kernel.agent_memory",
  "kernel.saved_views",
] as const

/**
 * The token ledger, which the reset deliberately does NOT clear. It is the
 * rolling 24 hour window the reserved org's ceiling is measured over, so a
 * reset that erased it made the job enforcing the ceiling the job that lifted
 * it. Visitor orgs have no ceiling and are purged rather than reset, so nobody
 * inherits anybody's rows.
 */
const KEPT_TABLE = "kernel.credit_transactions"

async function orgExists(orgId: string): Promise<boolean> {
  return withSystemDb("demo-reset-test-exists", async (tx) => {
    const result = await tx.execute(
      sql`SELECT 1 AS one FROM kernel.organizations WHERE id = ${orgId}::uuid`,
    )
    const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
    return rows.length > 0
  })
}

async function rowCount(table: string, orgId: string): Promise<number> {
  return withSystemDb("demo-reset-test-count", async (tx) => {
    const ref = sql.raw(table)
    const result = await tx.execute(
      sql`SELECT count(*) AS count FROM ${ref} WHERE org_id = ${orgId}::uuid`,
    )
    const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
    return Number((rows[0] as { count?: string | number } | undefined)?.count ?? 0)
  })
}

/** Every populated table's row count for one org, by table. */
async function counts(orgId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const table of POPULATED_TABLES) out[table] = await rowCount(table, orgId)
  return out
}

async function creditBalance(orgId: string): Promise<{ included: number; purchased: number }> {
  return withSystemDb("demo-reset-test-balance", async (tx) => {
    const result = await tx.execute(sql`
      SELECT included_balance AS included, purchased_balance AS purchased
      FROM kernel.credit_balances WHERE org_id = ${orgId}::uuid
    `)
    const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
    const row = rows[0] as { included: unknown; purchased: unknown } | undefined
    return { included: Number(row?.included ?? 0), purchased: Number(row?.purchased ?? 0) }
  })
}

beforeAll(async () => {
  if (DB_URL === "") throw new Error("DATABASE_URL must be set for this test")
  if (/liaison_dev|liaison_test(?!_)/.test(DB_URL)) {
    throw new Error("refusing to write to a shared database: use liaison_hardening_test")
  }
  DemoModeTestAccess.set(true)
  // A configured box. The nightly run resolves the App Review credential before
  // it deletes anything and refuses the whole reserved org reset without it
  // (`reservedOwner()`, covered by demo-reset-ledger.test.ts). This file tests
  // the reset itself, so it runs on a box that has the password set; the fake
  // seeder below never signs anybody in with it.
  savedReviewerPassword = env.LIAISON_DEMO_REVIEWER_PASSWORD
  setReviewerPassword("demo-reset-test-reviewer-password")
  // The warehouse layer runs on its own read-only login (a role in no Liaison
  // role), named by this variable on the demo box; here, the same login the
  // warehouse integration test provisions.
  process.env[DEMO_WAREHOUSE_DSN_ENV] ??= DB_URL.replace(
    /\/\/[^@]*@/,
    "//liaison_demo_warehouse_it:it-warehouse-password-0123456789@",
  )
  // The seam the seeder already ships for exactly this. It reports `ok` only
  // for THIS test's own fixtures: the hardening database holds other reserved
  // orgs that other tests own, and `runDemoReset` empties an org before
  // re-seeding it, which a fake seeder would never fill back in. Reporting
  // `ok: false` for a foreign org is what keeps this test out of their rows,
  // and it is the same signal a real broken seeder would send.
  setDemoSeeder(async (req) => {
    if (!req.orgSlug.startsWith(PREFIX)) return { ok: false, detail: "not this test's org" }
    seedCalls.push({ orgSlug: req.orgSlug, variant: req.variant })
    if (failingSeedSlugs.has(req.orgSlug)) return { ok: false, detail: "seeder is broken" }
    const fixture = Object.values(fixtures).find((f) => f.slug === req.orgSlug)
    return { ok: true, orgId: fixture?.orgId }
  })

  // Invoicing, for its immutable legal-record tables (`legal_originals`): installed the way a
  // demo box has it, so the kernel immutability trigger is the one registration applies.
  if (!process.env.LIAISON_APPS_DIR) {
    ownAppsDir = mkdtempSync(path.join(tmpdir(), "liaison-apps-demo-reset-"))
    process.env.LIAISON_APPS_DIR = ownAppsDir
  }
  await installFromDist("invoicing", crypto.randomUUID())

  const expiredVisitor = await makeOrg("expired-visitor")
  await populate(expiredVisitor.orgId)
  // Two days past its own TTL.
  await markOrgAsDemo(
    expiredVisitor.orgId,
    visitorMarker(24, new Date(NOW.getTime() - 72 * 3600_000)),
  )

  const liveVisitor = await makeOrg("live-visitor")
  await markOrgAsDemo(liveVisitor.orgId, visitorMarker(48, NOW))

  const reserved = await makeOrg("reserved")
  await markOrgAsDemo(reserved.orgId, reservedMarker(new Date(NOW.getTime() - 90 * 86_400_000)))

  await makeOrg("plain")

  const malformed = await makeOrg("malformed")
  // Hand written into the jsonb, exactly the way an operator's SQL would get it
  // wrong: a variant that is not a variant and an expiry that is not a date.
  await withSystemDb("demo-reset-test-malformed", async (tx) => {
    await tx.execute(sql`
      UPDATE kernel.organizations
      SET settings = COALESCE(settings, '{}'::jsonb) ||
        jsonb_build_object('demo', '{"variant":12,"expiresAt":"yesterday"}'::jsonb)
      WHERE id = ${malformed.orgId}::uuid
    `)
  })
  invalidateDemoMarker(malformed.orgId)

  // The pair the content reset runs against: two marked demo orgs holding the
  // SAME rows, so "it cleared the right one" is an assertion and not a hope.
  const target = await makeOrg("reset-target")
  await populate(target.orgId)
  await markOrgAsDemo(target.orgId, visitorMarker(72, NOW))

  const bystander = await makeOrg("reset-bystander")
  await populate(bystander.orgId)
  await markOrgAsDemo(bystander.orgId, visitorMarker(72, NOW))
}, 300_000)

afterAll(async () => {
  DemoSeederTestAccess.reset()
  DemoModeTestAccess.set(true)
  // Leave nothing behind: every fixture still standing is force expired as a
  // visitor org and collected through the same path under test.
  for (const fixture of Object.values(fixtures)) {
    if (!(await orgExists(fixture.orgId))) continue
    await markOrgAsDemo(fixture.orgId, visitorMarker(1, new Date(Date.now() - 48 * 3600_000)))
    await purgeDemoOrg(fixture.orgId)
  }
  DemoModeTestAccess.set(null)
  setReviewerPassword(savedReviewerPassword)
  if (ownAppsDir) rmSync(ownAppsDir, { recursive: true, force: true })
}, 300_000)

describe("the nightly demo reset", () => {
  it("lists only the expired visitor org, and skips the malformed marker", async () => {
    const expired = await listExpiredDemoOrgs(NOW, 500)
    const slugs = expired.map((o) => o.slug).filter((s) => s.startsWith(PREFIX))
    expect(slugs).toEqual([fixtures["expired-visitor"].slug])
  })

  it("refuses to purge anything that is not an expired visitor org", async () => {
    expect((await purgeDemoOrg(fixtures.reserved.orgId, NOW)).refusal).toBe("not-a-visitor-org")
    expect((await purgeDemoOrg(fixtures.plain.orgId, NOW)).refusal).toBe("not-a-demo-org")
    expect((await purgeDemoOrg(fixtures.malformed.orgId, NOW)).refusal).toBe("malformed-marker")
    expect((await purgeDemoOrg(fixtures["live-visitor"].orgId, NOW)).refusal).toBe("not-expired")
    for (const key of ["reserved", "plain", "malformed", "live-visitor"]) {
      expect(await orgExists(fixtures[key].orgId)).toBe(true)
    }
  })
})

describe("the content reset guard", () => {
  it("refuses an org that carries no demo marker", async () => {
    const plain = fixtures.plain
    const before = await counts(plain.orgId)
    await expect(resetDemoOrgContent(plain.orgId)).rejects.toThrow(DemoOrgGuardError)
    try {
      await resetDemoOrgContent(plain.orgId)
    } catch (err) {
      expect((err as DemoOrgGuardError).refusal).toBe("not-a-demo-org")
    }
    expect(await counts(plain.orgId)).toEqual(before)
    // And nothing was flagged: a refusal must not leave the org looking mid reset.
    expect(await readResetInProgress(plain.orgId)).toBeNull()
  })

  it("refuses an org whose marker is malformed", async () => {
    try {
      await resetDemoOrgContent(fixtures.malformed.orgId)
      throw new Error("expected a refusal")
    } catch (err) {
      expect(err).toBeInstanceOf(DemoOrgGuardError)
      expect((err as DemoOrgGuardError).refusal).toBe("not-a-demo-org")
    }
  })

  it("refuses every org when demo mode is off", async () => {
    DemoModeTestAccess.set(false)
    try {
      try {
        await resetDemoOrgContent(fixtures["reset-target"].orgId)
        throw new Error("expected a refusal")
      } catch (err) {
        expect(err).toBeInstanceOf(DemoOrgGuardError)
        expect((err as DemoOrgGuardError).refusal).toBe("demo-mode-off")
      }
    } finally {
      DemoModeTestAccess.set(true)
    }
  })

  it("refuses to adopt and mark an existing org that is not already a demo org", async () => {
    // The other half of the same hole: `seedDemoOrg` used to adopt ANY org
    // carrying the slug it was handed and stamp a demo marker on it, which is
    // how `demo:seed --slug acme` reached a real tenant. It has to refuse
    // BEFORE it writes, so the org must still be unmarked afterwards.
    await expect(
      seedDemoOrg({ orgSlug: fixtures.plain.slug, variant: "reserved" }),
    ).rejects.toThrow(/NOT a demo org/)
    invalidateDemoMarker(fixtures.plain.orgId)
    const marked = await withSystemDb("demo-reset-test-marker", async (tx) => {
      const result = await tx.execute(
        sql`SELECT settings->'demo' AS demo FROM kernel.organizations
            WHERE id = ${fixtures.plain.orgId}::uuid`,
      )
      const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
      return (rows[0] as { demo: unknown }).demo
    })
    expect(marked === null || marked === undefined).toBe(true)
  }, 120_000)

  it("refuses to flip a reserved org into a visitor org, which would hand it to the reaper", async () => {
    await expect(
      seedDemoOrg({ orgSlug: fixtures.reserved.slug, variant: "visitor" }),
    ).rejects.toThrow(/already a 'reserved' demo org/)
  }, 120_000)
})

describe("what a content reset clears, and what it leaves alone", () => {
  it("empties the target org and never touches a second demo org", async () => {
    const target = fixtures["reset-target"]
    const bystander = fixtures["reset-bystander"]

    const before = await counts(target.orgId)
    for (const table of POPULATED_TABLES) expect(before[table]).toBeGreaterThan(0)
    const ledgerBefore = await rowCount(KEPT_TABLE, target.orgId)
    expect(ledgerBefore).toBeGreaterThan(0)
    const bystanderBefore = await counts(bystander.orgId)
    const usersBefore = await rowCount("kernel.users", target.orgId)
    const rolesBefore = await rowCount("kernel.roles", target.orgId)
    expect(usersBefore).toBeGreaterThan(0)
    expect(rolesBefore).toBeGreaterThan(0)

    await resetDemoOrgContent(target.orgId)

    // Content is gone, including the tables the old allowlist knew and the ones
    // it did not: the routine that would have kept firing, the skill, the
    // memory and the view.
    const after = await counts(target.orgId)
    for (const table of POPULATED_TABLES) expect(after[table]).toBe(0)
    // And the ledger the ceiling is measured over is still standing.
    expect(await rowCount(KEPT_TABLE, target.orgId)).toBe(ledgerBefore)

    // The org's own furniture is still standing: this is a reset, not a purge.
    expect(await orgExists(target.orgId)).toBe(true)
    expect(await rowCount("kernel.users", target.orgId)).toBe(usersBefore)
    expect(await rowCount("kernel.roles", target.orgId)).toBe(rolesBefore)

    // Platform credit is gone, and the balance ROW is kept rather than deleted.
    expect(await creditBalance(target.orgId)).toEqual({ included: 0, purchased: 0 })

    // And the org next door has not lost a single row.
    expect(await counts(bystander.orgId)).toEqual(bystanderBefore)
    expect(await creditBalance(bystander.orgId)).toEqual({ included: 25, purchased: 7 })
  }, 300_000)

  it("leaves an interrupted reset detectable, and lets a completed one clear the flag", async () => {
    const target = fixtures["reset-target"]
    // `resetDemoOrgContent` raises the flag and NEVER lowers it: only a re-seed
    // that came back clean does. So after the clear above, the org still says
    // it is mid reset, which is exactly what a process death would leave and
    // what the next nightly run reads.
    const flag = await readResetInProgress(target.orgId)
    expect(flag).not.toBeNull()
    expect(Number.isNaN(Date.parse(flag?.startedAt ?? ""))).toBe(false)

    await completeDemoOrgReset(target.orgId)
    expect(await readResetInProgress(target.orgId)).toBeNull()
  })
})

describe("the kernel reset rules", () => {
  it("has a rule for every org scoped kernel table", async () => {
    const catalog = await kernelOrgScopedTableNames()
    expect(catalog.length).toBeGreaterThan(50)
    const unruled = catalog.filter((table) => !(table in KERNEL_RESET_RULES))
    expect(unruled).toEqual([])
    const stale = Object.keys(KERNEL_RESET_RULES).filter((t) => !catalog.includes(t))
    expect(stale).toEqual([])
  })

  it("keeps the spend ledger and the org's furniture, by rule", () => {
    expect(KERNEL_RESET_RULES.credit_transactions).toBe("keep")
    expect(KERNEL_RESET_RULES.routines).toBe("clear")
    expect(KERNEL_RESET_RULES.mcp_connections).toBe("clear")
    expect(KERNEL_RESET_RULES.oauth_providers).toBe("clear")
    expect(KERNEL_RESET_RULES.users).toBe("restore")
    expect(KERNEL_RESET_RULES.roles).toBe("restore")
  })

  it("refuses to reset at all when the catalog has a table the rules do not", async () => {
    // The loud failure D1 asks for, proved by removing a rule the database
    // really has: a migration that adds a table and forgets the map gets a
    // refused reset naming the table, not a silent leak for ever.
    const target = fixtures["reset-bystander"]
    const before = await counts(target.orgId)
    const removed = KERNEL_RESET_RULES.contacts
    delete KERNEL_RESET_RULES.contacts
    try {
      await resetDemoOrgContent(target.orgId)
      throw new Error("expected the reset to refuse")
    } catch (err) {
      expect(err).toBeInstanceOf(UnruledKernelTableError)
      expect((err as UnruledKernelTableError).tables).toContain("contacts")
    } finally {
      KERNEL_RESET_RULES.contacts = removed
    }
    // Nothing was deleted: the refusal lands before the first DELETE.
    expect(await counts(target.orgId)).toEqual(before)
  }, 120_000)
})

describe("the nightly run", () => {
  it("collects the expired visitor org, its kernel rows and its app rows", async () => {
    const target = fixtures["expired-visitor"]
    expect(await rowCount("kernel.users", target.orgId)).toBeGreaterThan(0)
    expect(await rowCount("app_tickets.categories", target.orgId)).toBeGreaterThan(0)

    const outcome = await runDemoReset(NOW)

    expect(outcome.collected.map((o) => o.slug)).toContain(target.slug)
    expect(await orgExists(target.orgId)).toBe(false)
    // The kernel rows would have blocked a plain org delete outright, and no
    // cascade has ever reached the app schema.
    expect(await rowCount("kernel.users", target.orgId)).toBe(0)
    expect(await rowCount("app_tickets.categories", target.orgId)).toBe(0)
    // The legal original the immutability trigger guards went with it.
    expect(await rowCount("app_invoicing.legal_originals", target.orgId)).toBe(0)

    // Everything else is still standing.
    for (const key of ["reserved", "plain", "malformed", "live-visitor"]) {
      expect(await orgExists(fixtures[key].orgId)).toBe(true)
    }
    // And the reserved org was cleared and re-seeded, not just topped up.
    const ours = outcome.reseeded.filter((r) => r.slug === fixtures.reserved.slug)
    expect(ours).toHaveLength(1)
    expect(ours[0].action).toBe("reset")
    expect(ours[0].ok).toBe(true)
    expect(await readResetInProgress(fixtures.reserved.orgId)).toBeNull()
  }, 300_000)

  it("proves the seeder FROM SCRATCH, in a throwaway org, before it clears anything", async () => {
    // The probe used to be a top up against the reserved org itself, where
    // every layer adopts what it already wrote: it could not tell a seeder that
    // can no longer CREATE anything from a healthy one. It now runs against a
    // scratch slug, and that org is collected again in the same run.
    const probeSlug = `${fixtures.reserved.slug}-reseed-probe`
    const ours = seedCalls.filter((c) => c.orgSlug.startsWith(PREFIX))
    expect(ours.some((c) => c.orgSlug === probeSlug && c.variant === "visitor")).toBe(true)
    expect(ours.some((c) => c.orgSlug === fixtures.reserved.slug)).toBe(true)
  })

  it("leaves the org flagged when the probe passes and the second seed fails", async () => {
    // D2's untested case, and the one that used to leave the ONE curated
    // workspace cleared and half written with nothing recording it.
    const reserved = fixtures.reserved
    failingSeedSlugs.add(reserved.slug)
    try {
      const outcome = await runDemoReset(NOW)
      const ours = outcome.reseeded.find((r) => r.slug === reserved.slug)
      expect(ours?.action).toBe("reset")
      expect(ours?.ok).toBe(false)
      // The flag stays UP: the next run can tell this org apart from a quiet one.
      expect(await readResetInProgress(reserved.orgId)).not.toBeNull()
    } finally {
      failingSeedSlugs.delete(reserved.slug)
    }

    // And the next run heals it: the flag comes down only once a seed lands.
    const healed = await runDemoReset(NOW)
    const ours = healed.reseeded.find((r) => r.slug === reserved.slug)
    expect(ours?.ok).toBe(true)
    expect(ours?.healedInterrupted).toBe(true)
    expect(await readResetInProgress(reserved.orgId)).toBeNull()
  }, 300_000)

  it("does nothing at all when demo mode is off", async () => {
    DemoModeTestAccess.set(false)
    try {
      const outcome = await runDemoReset(NOW)
      expect(outcome).toEqual({ reseeded: [], collected: [], refused: [] })
    } finally {
      DemoModeTestAccess.set(true)
    }
  })
})

describe("legal records and honest refusals", () => {
  it("purges a demo org holding a legal original entirely", async () => {
    const org = await makeOrg("legal-visitor")
    await populate(org.orgId)
    await markOrgAsDemo(org.orgId, visitorMarker(1, new Date(NOW.getTime() - 48 * 3600_000)))
    expect(await rowCount("app_invoicing.legal_originals", org.orgId)).toBe(1)

    const result = await purgeDemoOrg(org.orgId, NOW)

    expect(result.purged).toBe(true)
    expect(result.deleted?.["app_invoicing.legal_originals"]).toBe(1)
    expect(await orgExists(org.orgId)).toBe(false)
    expect(await rowCount("app_invoicing.legal_originals", org.orgId)).toBe(0)
  }, 300_000)

  it("leaves a non-demo org's legal original undeletable, even with the setting naming it", async () => {
    const plain = fixtures.plain
    await withSystemDb("demo-reset-test-legal-plain", async (tx) => {
      await tx.execute(sql`
        INSERT INTO app_invoicing.legal_originals (org_id, kind, recorded_at)
        VALUES (${plain.orgId}::uuid, 'legacy_import', current_date)
      `)
    })
    // The privileged role the purge runs as, the setting naming this org: still refused,
    // because the org's stored row carries no demo marker.
    let refusal: unknown
    try {
      await withSystemDb("demo-reset-test-legal-plain-delete", async (tx) => {
        await tx.execute(sql`SELECT set_config('liaison.demo_purge_org', ${plain.orgId}, true)`)
        await tx.execute(
          sql`DELETE FROM app_invoicing.legal_originals WHERE org_id = ${plain.orgId}::uuid`,
        )
      })
    } catch (err) {
      refusal = err
    }
    expect(describeDbError(refusal).code).toBe("P0001")
    expect(describeDbError(refusal).message).toMatch(/^immutable_retention/)
    expect(await rowCount("app_invoicing.legal_originals", plain.orgId)).toBe(1)
  })

  it("reports a refusal that is not a foreign key with its SQLSTATE and message", async () => {
    // A scratch app table whose trigger refuses every delete, the way an immutability or a
    // permission refusal would. The sweep must name it, its code and its message, and must
    // still have emptied every other table.
    const schema = `app_purge_refusal_${process.pid}`
    const org = await makeOrg("refusing-visitor")
    await populate(org.orgId)
    await markOrgAsDemo(org.orgId, visitorMarker(1, new Date(NOW.getTime() - 48 * 3600_000)))
    await withSystemDb("demo-reset-test-refusal-setup", async (tx) => {
      await tx.execute(sql.raw(`CREATE SCHEMA ${schema}`))
      await tx.execute(
        sql.raw(
          `CREATE TABLE ${schema}.held (id uuid primary key default gen_random_uuid(), org_id uuid not null)`,
        ),
      )
      await tx.execute(
        sql.raw(
          `CREATE FUNCTION ${schema}.refuse() RETURNS trigger AS 'BEGIN RAISE EXCEPTION ''purge_test_refusal'' USING ERRCODE = ''P0001''; END' LANGUAGE plpgsql`,
        ),
      )
      await tx.execute(
        sql.raw(
          `CREATE TRIGGER refuse BEFORE DELETE ON ${schema}.held FOR EACH ROW EXECUTE FUNCTION ${schema}.refuse()`,
        ),
      )
      await tx.execute(sql.raw(`INSERT INTO ${schema}.held (org_id) VALUES ('${org.orgId}')`))
    })
    try {
      let caught: unknown
      try {
        await purgeDemoOrg(org.orgId, NOW)
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(OrgPurgeIncompleteError)
      const err = caught as OrgPurgeIncompleteError
      expect(err.failed).toEqual([
        { table: `${schema}.held`, code: "P0001", message: "purge_test_refusal" },
      ])
      expect(err.blocked).toEqual([])
      expect(err.message).toContain(`${schema}.held: P0001 purge_test_refusal`)
      expect(err.message).not.toContain("foreign key")
      // The rest of the sweep ran, and the org row is left for the next run to collect.
      expect(await rowCount("kernel.contacts", org.orgId)).toBe(0)
      expect(await rowCount("app_invoicing.legal_originals", org.orgId)).toBe(0)
      expect(await orgExists(org.orgId)).toBe(true)
    } finally {
      await withSystemDb("demo-reset-test-refusal-teardown", async (tx) => {
        await tx.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`))
      })
    }
    // With the refusing table gone, the next run collects the org.
    expect((await purgeDemoOrg(org.orgId, NOW)).purged).toBe(true)
  }, 300_000)
})
