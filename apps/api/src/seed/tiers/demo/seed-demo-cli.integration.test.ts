// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The `demo:seed` CLI against a real database: a RESERVED run pins the App
// Review account's password to the environment and makes sure that account is
// not the org's last admin, the same two guarantees the nightly reset and the
// signup path get from `seedDemoOrgData`.
//
// Without them the deploy hook's own seed left a box whose reviewer password
// had been changed (or seeded before the variable was set) locked out until the
// next nightly reset, because `ensureUser` never resets an existing password.
//
// The world seeder is stubbed out: what is under test is the CLI's wiring
// around it, and the org it would produce is created once, for real, by the
// org layer in `beforeAll`.
//
//   bun run scripts/test-run.ts demo-seed --file "$PWD/apps/api/src/seed/tiers/demo/seed-demo-cli.integration.test.ts"
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { sql } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { hashPassword, verifyPassword } from "~/lib/crypto"
import { env } from "~/lib/env"
import { DEMO_REVIEWER_EMAIL, reservedOwner } from "~/modules/demo/demo-seeder"
import { runSeedDemoCli, type SeedDemoWorldOptions, type SeedDemoWorldResult } from "./seed-demo"
import { type SeedDemoOrgResult, seedDemoOrg } from "./seed-org"

const ORG_SLUG = "demo-seed-cli-integration"
const DB_URL = process.env.DATABASE_URL ?? ""
const REVIEWER_PASSWORD = "ReviewCli1!Pinned"

type Rows = Array<Record<string, unknown>>
function rowsOf(result: unknown): Rows {
  return (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as Rows
}

let savedPassword = ""
let org: SeedDemoOrgResult
const seen: SeedDemoWorldOptions[] = []

/** Stands in for the world seeder: records what the CLI asked for, writes nothing. */
async function stubWorld(opts: SeedDemoWorldOptions): Promise<SeedDemoWorldResult> {
  seen.push(opts)
  return {
    orgId: org.orgId,
    orgSlug: org.orgSlug,
    org,
    support: null,
    commerce: null,
    warehouse: null,
    agentNative: null,
    accounts: null,
    complete: true,
    failures: [],
    partsOff: [],
  }
}

/** What a reviewer changing their password, and an operator's role edit, leave behind. */
async function drift(): Promise<void> {
  const other = await hashPassword("SomethingElse1!")
  await withSystemDb("demo-cli-test-drift", async (tx) => {
    await tx.execute(
      sql`UPDATE kernel.users SET password_hash = ${other}
          WHERE org_id = ${org.orgId} AND email = ${DEMO_REVIEWER_EMAIL}`,
    )
    await tx.execute(
      sql`DELETE FROM kernel.user_roles ur USING kernel.roles r, kernel.users u
          WHERE ur.role_id = r.id AND ur.user_id = u.id
            AND r.org_id = ${org.orgId} AND r.name = 'admin'
            AND lower(u.email) <> ${DEMO_REVIEWER_EMAIL}`,
    )
  })
}

async function reviewerPasswordIsPinned(): Promise<boolean> {
  const rows = rowsOf(
    await withSystemDb("demo-cli-test-hash", (tx) =>
      tx.execute(
        sql`SELECT password_hash AS hash FROM kernel.users
            WHERE org_id = ${org.orgId} AND email = ${DEMO_REVIEWER_EMAIL}`,
      ),
    ),
  )
  const hash = rows[0]?.hash
  return typeof hash === "string" && (await verifyPassword(REVIEWER_PASSWORD, hash))
}

async function otherAdmins(): Promise<number> {
  const rows = rowsOf(
    await withSystemDb("demo-cli-test-admins", (tx) =>
      tx.execute(
        sql`SELECT count(*)::int AS n FROM kernel.user_roles ur
            JOIN kernel.roles r ON r.id = ur.role_id
            JOIN kernel.users u ON u.id = ur.user_id
            WHERE r.org_id = ${org.orgId} AND r.name = 'admin' AND u.status = 'active'
              AND lower(u.email) <> ${DEMO_REVIEWER_EMAIL}`,
      ),
    ),
  )
  return Number(rows[0]?.n ?? 0)
}

beforeAll(async () => {
  if (DB_URL === "") throw new Error("DATABASE_URL must be set for this test")
  if (/liaison_dev/.test(DB_URL)) {
    throw new Error("refusing to seed liaison_dev: use an isolated test database")
  }
  if (!process.env.LIAISON_APPS_DIR) {
    process.env.LIAISON_APPS_DIR = path.join(mkdtempSync(path.join(tmpdir(), "demo-cli-")), "apps")
  }
  savedPassword = env.LIAISON_DEMO_REVIEWER_PASSWORD
  ;(env as { LIAISON_DEMO_REVIEWER_PASSWORD: string }).LIAISON_DEMO_REVIEWER_PASSWORD =
    REVIEWER_PASSWORD
  org = await seedDemoOrg({ orgSlug: ORG_SLUG, variant: "reserved", owner: reservedOwner() })
}, 900_000)

afterAll(() => {
  ;(env as { LIAISON_DEMO_REVIEWER_PASSWORD: string }).LIAISON_DEMO_REVIEWER_PASSWORD =
    savedPassword
})

describe("demo:seed, the CLI", () => {
  it("a reserved run re-pins the reviewer password and restores a second admin", async () => {
    await drift()
    expect(await reviewerPasswordIsPinned()).toBe(false)
    expect(await otherAdmins()).toBe(0)

    const { exitCode } = await runSeedDemoCli(["--slug", ORG_SLUG, "--no-reset"], {
      seedWorld: stubWorld,
    })

    expect(exitCode).toBe(0)
    expect(seen.at(-1)?.variant).toBe("reserved")
    expect(seen.at(-1)?.owner?.email).toBe(DEMO_REVIEWER_EMAIL)
    expect(await reviewerPasswordIsPinned()).toBe(true)
    expect(await otherAdmins()).toBe(1)
  })

  it("a visitor run touches neither", async () => {
    await drift()
    const { exitCode } = await runSeedDemoCli(
      ["--slug", ORG_SLUG, "--variant", "visitor", "--no-reset"],
      { seedWorld: stubWorld },
    )
    expect(exitCode).toBe(0)
    expect(seen.at(-1)?.owner).toBeUndefined()
    expect(await reviewerPasswordIsPinned()).toBe(false)
    expect(await otherAdmins()).toBe(0)
  })

  it("the reserved variant with a world flag exits 2", async () => {
    const before = seen.length
    for (const argv of [
      ["--slug", ORG_SLUG, "--world", "saas"],
      ["--slug", ORG_SLUG, "--world", "studio", "--variant", "reserved"],
    ]) {
      const { exitCode, result } = await runSeedDemoCli(argv, { seedWorld: stubWorld })
      expect(exitCode).toBe(2)
      expect(result).toBeNull()
    }
    expect(seen.length).toBe(before)
  })

  it("an unknown world exits 2", async () => {
    const before = seen.length
    const { exitCode } = await runSeedDemoCli(
      ["--slug", ORG_SLUG, "--variant", "visitor", "--world", "atlantis"],
      { seedWorld: stubWorld },
    )
    expect(exitCode).toBe(2)
    expect(seen.length).toBe(before)
  })

  it("the products world flag seeds the products world, and no flag means products", async () => {
    await runSeedDemoCli(["--slug", ORG_SLUG, "--no-reset", "--world", "products"], {
      seedWorld: stubWorld,
    })
    expect(seen.at(-1)?.worldId).toBe("products")
    expect(seen.at(-1)?.variant).toBe("reserved")
    await runSeedDemoCli(["--slug", ORG_SLUG, "--no-reset"], { seedWorld: stubWorld })
    expect(seen.at(-1)?.worldId).toBe("products")
  })
})
