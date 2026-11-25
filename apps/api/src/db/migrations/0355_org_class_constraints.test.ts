// SPDX-License-Identifier: FSL-1.1-ALv2
//
// 0355 (the two `organizations.class` constraints): an org's class never
// changes, and only a `demo` org carries the demo marker `settings.demo`. On
// the migrated test database: a forged marker on a standard org and a class
// change both raise, a demo org is marked as before; and across the migration,
// a standard org that already carries a marker stops it, naming the org, and
// stays `standard` (a blanket backfill would have made it a demo org, which the
// demo purge then deletes). Every case rolls back.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import postgres from "postgres"
import { markOrgAsDemo, visitorMarker } from "~/modules/demo/demo-org"
import { seedOrgRow } from "~/seed/factories/org/rows"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const MIGRATION = join(import.meta.dir, "0355_org_class_constraints.sql")

function privilegedUrl(): string {
  if (process.env.MIGRATION_DATABASE_URL) return process.env.MIGRATION_DATABASE_URL
  const base = process.env.DB_RESET_SUPERUSER_URL ?? "postgres://postgres:postgres@localhost:5432"
  const dbName = new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, "")
  return `${base.replace(/\/$/, "")}/${dbName}`
}

const priv = postgres(privilegedUrl(), { max: 1, onnotice: () => {} })
type Tx = postgres.TransactionSql
class Rollback extends Error {}

const STATEMENTS = readFileSync(MIGRATION, "utf8")
  .split("--> statement-breakpoint")
  .map((s) => s.trim())
  .filter((s) => s.replace(/--.*$/gm, "").trim() !== "")

async function rolledBack(fn: (tx: Tx) => Promise<void>): Promise<void> {
  await priv
    .begin(async (tx) => {
      await fn(tx)
      throw new Rollback()
    })
    .catch((err) => {
      if (!(err instanceof Rollback)) throw err
    })
}

/** The schema the previous release ran on: 0309's class, without this migration's rules. */
async function before(tx: Tx): Promise<void> {
  await tx.unsafe(
    "ALTER TABLE kernel.organizations DROP CONSTRAINT IF EXISTS organizations_demo_marker_class_check",
  )
  await tx.unsafe("DROP TRIGGER IF EXISTS organizations_class_immutable ON kernel.organizations")
  await tx.unsafe("DROP FUNCTION IF EXISTS kernel.organizations_class_immutable()")
}

const migrate = async (tx: Tx) => {
  for (const s of STATEMENTS) await tx.unsafe(s)
}

const orgs: string[] = []
const org = async (cls: "standard" | "demo" = "standard"): Promise<string> => {
  const id = await seedOrgRow({
    name: "0355 Org",
    slug: `m0355-${crypto.randomUUID()}`,
    class: cls,
  })
  orgs.push(id)
  return id
}

/** Write `settings.demo` with a plain UPDATE, as any bad write to `settings` would. */
const forge = (tx: Tx | postgres.Sql, orgId: string, demo: unknown) =>
  tx`UPDATE kernel.organizations
    SET settings = settings || jsonb_build_object('demo', ${JSON.stringify(demo)}::text::jsonb)
    WHERE id = ${orgId}`

async function classOf(tx: Tx | postgres.Sql, orgId: string): Promise<string> {
  const [row] = await tx<{ class: string }[]>`
    SELECT class FROM kernel.organizations WHERE id = ${orgId}`
  return (row as { class: string }).class
}

const marker = (variant: string) => ({
  variant,
  createdAt: "2026-01-01T00:00:00Z",
  expiresAt: null,
})

beforeAll(() => acquireTestLock())
afterAll(async () => {
  for (const id of orgs) await priv`DELETE FROM kernel.organizations WHERE id = ${id}`
  await priv.end()
  await releaseTestLock()
})

describe("0355 on a migrated database", () => {
  it("a demo marker forged on a standard org raises, and the org keeps no marker", async () => {
    const customer = await org()
    const err = await forge(priv, customer, marker("visitor")).catch((e: Error) => e)
    expect(String(err)).toMatch(/organizations_demo_marker_class_check/)
    const [row] = await priv<{ demo: unknown }[]>`
      SELECT settings->'demo' AS demo FROM kernel.organizations WHERE id = ${customer}`
    expect(row?.demo ?? null).toBeNull()
  })

  it("a class change raises, either way", async () => {
    const customer = await org()
    const demo = await org("demo")
    for (const [id, to] of [
      [customer, "demo"],
      [demo, "standard"],
    ] as const) {
      const err = await priv`UPDATE kernel.organizations SET class = ${to} WHERE id = ${id}`.catch(
        (e: Error) => e,
      )
      expect(String(err)).toMatch(/organizations\.class never changes/)
    }
    expect([await classOf(priv, customer), await classOf(priv, demo)]).toEqual(["standard", "demo"])
  })

  it("a demo org is marked as before, and its settings stay writable", async () => {
    const demo = await org("demo")
    await markOrgAsDemo(demo, visitorMarker(72))
    await priv`UPDATE kernel.organizations SET name = 'Renamed' WHERE id = ${demo}`
    const [row] = await priv<{ variant: string }[]>`
      SELECT settings->'demo'->>'variant' AS variant FROM kernel.organizations WHERE id = ${demo}`
    expect(row?.variant).toBe("visitor")
  })

  it("a standard org's other settings are written as before", async () => {
    const customer = await org()
    await priv`UPDATE kernel.organizations
      SET settings = settings || '{"locale":"fr","demo":null}'::jsonb WHERE id = ${customer}`
    expect(await classOf(priv, customer)).toBe("standard")
  })

  it("a fresh install holds both rules, validated", async () => {
    const [check] = await priv<{ valid: boolean }[]>`
      SELECT convalidated AS valid FROM pg_constraint
       WHERE conname = 'organizations_demo_marker_class_check'`
    expect(check?.valid).toBe(true)
    const trigger = await priv`SELECT 1 FROM pg_trigger
      WHERE tgname = 'organizations_class_immutable' AND NOT tgisinternal`
    expect(trigger).toHaveLength(1)
  })
})

describe("0355 across the upgrade", () => {
  it("a forged marker on a standard org stops it, naming the org, and the class stays standard", async () => {
    const forged = await org()
    const demo = await org("demo")
    const plain = await org()
    await rolledBack(async (tx) => {
      await before(tx)
      await forge(tx, forged, marker("visitor"))
      await forge(tx, demo, marker("visitor"))
      const err = await tx.savepoint(async (sp) => migrate(sp)).catch((e: Error) => e)
      expect(String(err)).toContain(forged)
      expect(String(err)).not.toContain(demo)
      expect(String(err)).not.toContain(plain)
      expect(String(err)).toContain("liaison demo reclassify")
      expect(String(err)).toContain("remove settings.demo")
      expect(await classOf(tx, forged)).toBe("standard")
      const check = await tx`SELECT 1 FROM pg_constraint
        WHERE conname = 'organizations_demo_marker_class_check'`
      expect(check).toHaveLength(0)
    })
  })

  it("passes over demo orgs with their marker and markers that are not objects", async () => {
    const demo = await org("demo")
    const odd = await org()
    await rolledBack(async (tx) => {
      await before(tx)
      await forge(tx, demo, marker("visitor"))
      await forge(tx, odd, "visitor")
      await migrate(tx)
      expect([await classOf(tx, demo), await classOf(tx, odd)]).toEqual(["demo", "standard"])
      const [check] = await tx<{ valid: boolean }[]>`
        SELECT convalidated AS valid FROM pg_constraint
         WHERE conname = 'organizations_demo_marker_class_check'`
      expect(check?.valid).toBe(true)
    })
  })

  it("stops when liaison_admin is held to row security, instead of reading no org", async () => {
    await rolledBack(async (tx) => {
      await before(tx)
      await tx.unsafe("ALTER ROLE liaison_admin NOBYPASSRLS")
      const err = await tx.savepoint(async (sp) => migrate(sp)).catch((e: Error) => e)
      expect(String(err)).toMatch(/liaison_admin is held to row security/)
    })
  })
})
