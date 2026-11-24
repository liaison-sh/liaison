// SPDX-License-Identifier: FSL-1.1-ALv2
//
// 0309 (`organizations.class`): a marked org becomes `demo`, everything else
// `standard`; an org with a marker AND a billing row stops the migration before
// it writes anything; and the previous release keeps working on the new schema
// (it inserts orgs and billing rows without the new columns). Runs against the
// migrated test database, taken back to the schema before it; every case rolls
// back.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import postgres from "postgres"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const MIGRATION = join(import.meta.dir, "0309_org_class.sql")

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

/** The schema the previous release ran on. */
async function before(tx: Tx): Promise<void> {
  await tx.unsafe("ALTER TABLE kernel.org_billing_state DROP COLUMN org_class")
  await tx.unsafe("DROP INDEX kernel.organizations_id_class_key")
  await tx.unsafe("ALTER TABLE kernel.organizations DROP COLUMN class")
}

const migrate = async (tx: Tx) => {
  for (const s of STATEMENTS) await tx.unsafe(s)
}

/** An org as the previous release inserts it. */
async function org(tx: Tx, settings: unknown = {}): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO kernel.organizations (name, slug, settings)
    VALUES ('Org', ${`m0309-${crypto.randomUUID()}`}, ${JSON.stringify(settings)}::text::jsonb) RETURNING id`
  return (row as { id: string }).id
}

/** A billing row as the previous release inserts it. */
async function bill(tx: Tx, orgId: string): Promise<void> {
  await tx`INSERT INTO kernel.org_billing_state
      (org_id, version, plan, status, period_end, included_credits, auto_top_up)
    VALUES (${orgId}, 1, 'base', 'active', now(), 0, '{}'::jsonb)`
}

async function classOf(tx: Tx, orgId: string): Promise<string> {
  const [row] = await tx<{ class: string }[]>`
    SELECT class FROM kernel.organizations WHERE id = ${orgId}`
  return (row as { class: string }).class
}

const marker = (variant: string) => ({
  demo: { variant, createdAt: "2026-01-01T00:00:00Z", expiresAt: null },
})

beforeAll(() => acquireTestLock())
afterAll(async () => {
  await priv.end()
  await releaseTestLock()
})

describe("0309 org class", () => {
  it("a valid marker makes a demo org; anything else is standard", async () => {
    await rolledBack(async (tx) => {
      await before(tx)
      const visitor = await org(tx, marker("visitor"))
      const reserved = await org(tx, marker("reserved"))
      const plain = await org(tx)
      const billed = await org(tx)
      await bill(tx, billed)
      const odd = await org(tx, marker("staging"))
      const empty = await org(tx, { demo: {} })
      const text = await org(tx, { demo: "visitor" })
      await migrate(tx)
      expect([await classOf(tx, visitor), await classOf(tx, reserved)]).toEqual(["demo", "demo"])
      for (const id of [plain, billed, odd, empty, text]) {
        expect(await classOf(tx, id)).toBe("standard")
      }
    })
  })

  it("a marked org with a billing row stops it, naming the org and the way out", async () => {
    await rolledBack(async (tx) => {
      await before(tx)
      const both = await org(tx, marker("visitor"))
      await bill(tx, both)
      const other = await org(tx, marker("visitor"))
      const err = await tx.savepoint(async (sp) => migrate(sp)).catch((e: Error) => e)
      expect(String(err)).toContain(both)
      expect(String(err)).not.toContain(other)
      expect(String(err)).toContain("settings.demo")
      const columns = await tx`SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'kernel' AND table_name = 'organizations' AND column_name = 'class'`
      expect(columns).toHaveLength(0)
    })
  })

  it("the previous release works on it: an org marked after its insert, and a customer billed", async () => {
    await rolledBack(async (tx) => {
      const window = await org(tx)
      await tx`UPDATE kernel.organizations
        SET settings = settings || ${JSON.stringify(marker("visitor"))}::text::jsonb WHERE id = ${window}`
      expect(await classOf(tx, window)).toBe("standard")
      const customer = await org(tx)
      await bill(tx, customer)
      await tx`UPDATE kernel.org_billing_state SET version = 2 WHERE org_id = ${customer}`
      await tx`DELETE FROM kernel.organizations WHERE id = ${customer}`
      expect(
        await tx`SELECT 1 FROM kernel.org_billing_state WHERE org_id = ${customer}`,
      ).toHaveLength(0)
    })
  })

  it("a demo org can never be billed, and no third class exists", async () => {
    await rolledBack(async (tx) => {
      const demo = await org(tx)
      await tx`UPDATE kernel.organizations SET class = 'demo' WHERE id = ${demo}`
      const billed = await tx.savepoint((sp) => bill(sp, demo)).catch((e: Error) => e)
      expect(String(billed)).toMatch(/org_billing_state_org_class_fk/)
      const customer = await org(tx)
      await bill(tx, customer)
      const flipped = await tx
        .savepoint(
          (sp) => sp`UPDATE kernel.organizations SET class = 'demo' WHERE id = ${customer}`,
        )
        .catch((e: Error) => e)
      expect(String(flipped)).toMatch(/org_billing_state_org_class_fk/)
      const third = await tx
        .savepoint((sp) => sp`UPDATE kernel.organizations SET class = 'trial' WHERE id = ${demo}`)
        .catch((e: Error) => e)
      expect(String(third)).toMatch(/organizations_class_check/)
    })
  })
})
