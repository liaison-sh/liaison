// SPDX-License-Identifier: FSL-1.1-ALv2
//
// 0309 (`organizations.class`): a marked org becomes `demo`, everything else
// `standard`; an org with a marker AND a billing row stops the migration before
// it writes anything; a migration login held to row security gets the same; and the previous release keeps working on the new schema
// (it inserts orgs and billing rows without the new columns). Runs against the
// migrated test database, taken back to the schema before it; every case rolls
// back.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import postgres from "postgres"
import { CLOUD_CREATE_ORG_ENDPOINT } from "~/modules/cloud/outcomes"
import { seedOrgBillingState } from "~/seed/factories/billing/billing"
import { seedOrgRow } from "~/seed/factories/org/rows"
import { insertSql } from "~/seed/factories/org/test-rows"
import { withRoleCatalogLock } from "~/tests/helpers/role-catalog-lock"
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

const orgs: string[] = []
const org = async (billed = false): Promise<string> => {
  const id = await seedOrgRow({ name: "0309 Org", slug: `m0309-${crypto.randomUUID()}` })
  orgs.push(id)
  if (billed) await seedOrgBillingState(id)
  return id
}

/** Write `settings.demo`, as the previous release marks an org: after its insert. */
const mark = async (tx: Tx, orgId: string, demo: unknown) => {
  await tx`UPDATE kernel.organizations
    SET settings = settings || jsonb_build_object('demo', ${JSON.stringify(demo)}::text::jsonb)
    WHERE id = ${orgId}`
}

async function classOf(tx: Tx, orgId: string): Promise<string> {
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

const LOGIN = `m0309_login_${crypto.randomUUID().slice(0, 8)}`

/**
 * Continue the transaction as a migration login that owns the schema and its
 * tables and is a member of `roles`, with neither superuser nor BYPASSRLS (the
 * shape 0283 is for). RESET ROLE then comes back to that login, as on a
 * connection of its own. The role goes with the rollback.
 */
async function asOwnerLogin(
  tx: Tx,
  roles = "liaison_admin, liaison_rls, liaison_schema_admin, liaison_definer",
): Promise<void> {
  await tx.unsafe(`CREATE ROLE "${LOGIN}" NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB`)
  if (roles) await tx.unsafe(`GRANT ${roles} TO "${LOGIN}"`)
  await tx.unsafe(`DO $$
    DECLARE r record;
    BEGIN
      ALTER SCHEMA kernel OWNER TO "${LOGIN}";
      FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'kernel' AND c.relkind IN ('r', 'p') LOOP
        EXECUTE format('ALTER TABLE kernel.%I OWNER TO "${LOGIN}"', r.relname);
      END LOOP;
    END $$`)
  await tx.unsafe(`SET LOCAL SESSION AUTHORIZATION "${LOGIN}"`)
  const [who] = await tx<{ su: boolean; bypass: boolean; n: number }[]>`
    SELECT rolsuper AS su, rolbypassrls AS bypass,
           (SELECT count(*)::int FROM kernel.organizations) AS n
      FROM pg_roles WHERE rolname = current_user`
  // Row security hides every org from it: what the migration has to see through.
  expect(who).toEqual({ su: false, bypass: false, n: 0 })
}

describe("0309, run by a schema owner that is neither superuser nor BYPASSRLS", () => {
  it("gives the marked orgs their class, as for a superuser", async () => {
    const visitor = await org()
    const plain = await org()
    const billed = await org(true)
    await rolledBack(async (tx) => {
      await before(tx)
      await mark(tx, visitor, marker("visitor"))
      await asOwnerLogin(tx)
      await migrate(tx)
      const [who] = await tx`SELECT current_user AS me`
      expect(who?.me).toBe(LOGIN)
      await tx.unsafe("RESET SESSION AUTHORIZATION")
      expect(await classOf(tx, visitor)).toBe("demo")
      expect(await classOf(tx, plain)).toBe("standard")
      expect(await classOf(tx, billed)).toBe("standard")
      const fk = await tx`SELECT 1 FROM pg_constraint
        WHERE conname = 'org_billing_state_org_class_fk' AND convalidated`
      expect(fk).toHaveLength(1)
    })
  })

  it("stops at a marked org with a billing row", async () => {
    const both = await org(true)
    await rolledBack(async (tx) => {
      await before(tx)
      await mark(tx, both, marker("visitor"))
      await asOwnerLogin(tx)
      const err = await tx.savepoint(async (sp) => migrate(sp)).catch((e: Error) => e)
      expect(String(err)).toContain(both)
    })
  })

  it("stops, instead of doing nothing, when the login is not a member of liaison_admin", async () => {
    const visitor = await org()
    await rolledBack(async (tx) => {
      await before(tx)
      await mark(tx, visitor, marker("visitor"))
      await asOwnerLogin(tx, "")
      const err = await tx.savepoint(async (sp) => migrate(sp)).catch((e: Error) => e)
      expect(String(err)).toMatch(/permission denied to set role "liaison_admin"/)
    })
  })

  it("stops when liaison_admin itself is held to row security", async () => {
    const visitor = await org()
    // liaison_admin is a cluster-wide row that migration replays in other test
    // processes also write: held until the rollback, under their lock.
    await withRoleCatalogLock(privilegedUrl(), () =>
      rolledBack(async (tx) => {
        await before(tx)
        await mark(tx, visitor, marker("visitor"))
        await tx.unsafe("ALTER ROLE liaison_admin NOBYPASSRLS")
        await asOwnerLogin(tx)
        const err = await tx.savepoint(async (sp) => migrate(sp)).catch((e: Error) => e)
        expect(String(err)).toMatch(/liaison_admin is held to row security/)
      }),
    )
  })
})

describe("0309 org class", () => {
  it("a valid marker makes a demo org; anything else is standard", async () => {
    const visitor = await org()
    const reserved = await org()
    const plain = await org()
    const billed = await org(true)
    const odd = await org()
    const empty = await org()
    const text = await org()
    await rolledBack(async (tx) => {
      await before(tx)
      await mark(tx, visitor, marker("visitor"))
      await mark(tx, reserved, marker("reserved"))
      await mark(tx, odd, marker("staging"))
      await mark(tx, empty, {})
      await mark(tx, text, "visitor")
      await migrate(tx)
      expect([await classOf(tx, visitor), await classOf(tx, reserved)]).toEqual(["demo", "demo"])
      for (const id of [plain, billed, odd, empty, text]) {
        expect(await classOf(tx, id)).toBe("standard")
      }
    })
  })

  it("a marked org with a billing row stops it, naming the org and the way out", async () => {
    const both = await org(true)
    const other = await org()
    await rolledBack(async (tx) => {
      await before(tx)
      await mark(tx, both, marker("visitor"))
      await mark(tx, other, marker("visitor"))
      const err = await tx.savepoint(async (sp) => migrate(sp)).catch((e: Error) => e)
      expect(String(err)).toContain(both)
      expect(String(err)).not.toContain(other)
      expect(String(err)).toContain("settings.demo")
      const columns = await tx`SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'kernel' AND table_name = 'organizations' AND column_name = 'class'`
      expect(columns).toHaveLength(0)
    })
  })

  it("a marked org the control plane created stops it, as a billed one does", async () => {
    const made = await org()
    await rolledBack(async (tx) => {
      await before(tx)
      await mark(tx, made, marker("visitor"))
      const [row] = await tx<
        { slug: string }[]
      >`SELECT slug FROM kernel.organizations WHERE id = ${made}`
      await tx.unsafe(
        insertSql("kernel.cloud_request_outcomes", {
          endpoint: CLOUD_CREATE_ORG_ENDPOINT,
          idem_key: row?.slug ?? "",
          binding_hash: "h",
        }),
      )
      const err = await tx.savepoint(async (sp) => migrate(sp)).catch((e: Error) => e)
      expect(String(err)).toContain(made)
    })
  })

  it("the previous release works on it: an org marked after its insert, and a customer billed", async () => {
    const window = await org()
    const customer = await org(true)
    await rolledBack(async (tx) => {
      await mark(tx, window, marker("visitor"))
      expect(await classOf(tx, window)).toBe("standard")
      await tx`UPDATE kernel.org_billing_state SET version = 2 WHERE org_id = ${customer}`
      await tx`DELETE FROM kernel.organizations WHERE id = ${customer}`
      expect(
        await tx`SELECT 1 FROM kernel.org_billing_state WHERE org_id = ${customer}`,
      ).toHaveLength(0)
    })
  })

  it("a billed org can never become a demo one, and no third class exists", async () => {
    const customer = await org(true)
    const plain = await org()
    await rolledBack(async (tx) => {
      const flipped = await tx
        .savepoint(
          (sp) => sp`UPDATE kernel.organizations SET class = 'demo' WHERE id = ${customer}`,
        )
        .catch((e: Error) => e)
      expect(String(flipped)).toMatch(/org_billing_state_org_class_fk/)
      const third = await tx
        .savepoint((sp) => sp`UPDATE kernel.organizations SET class = 'trial' WHERE id = ${plain}`)
        .catch((e: Error) => e)
      expect(String(third)).toMatch(/organizations_class_check/)
    })
  })
})
