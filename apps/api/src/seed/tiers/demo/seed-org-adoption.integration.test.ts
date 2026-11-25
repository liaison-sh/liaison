// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The seeder never makes a real org a demo org. The demo marker makes an org's
// legal records purgeable at expiry, so the seeder writes it only on an org
// that already carries it or that the run created itself. An existing org
// without the marker is refused, before any write, whichever way the seeder is
// reached; there is no flag past it. (Re-seeding an org that IS marked, the
// reserved org's nightly path, is covered by seed-org.integration.test.ts.)
//
//   bun run scripts/test-run.ts demo-seed --file "$PWD/apps/api/src/seed/tiers/demo/seed-org-adoption.integration.test.ts"
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { CLOUD_CREATE_ORG_ENDPOINT, claimOutcome } from "~/modules/cloud/outcomes"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { invalidateDemoMarker, loadDemoMarker, visitorMarker } from "~/modules/demo/demo-org"
import {
  claimOrgSlug,
  hasOrgSlugClaim,
  findOrgIdBySlug as orgIdBySlug,
} from "~/seed/factories/org/org"
import { seedUserRow } from "~/seed/factories/org/rows"
import {
  forgeDemoMarker,
  markDemoOrgForTest,
  revalidateMarkerCheck,
} from "~/tests/helpers/demo-org"
import { runSeedDemoCli, type SeedDemoWorldOptions } from "./seed-demo"
import { demoMarkRefusal, seedDemoOrg } from "./seed-org"

const SLUG = `demo-adoption-${Math.random().toString(36).slice(2, 8)}`
const INTERRUPTED_SLUG = `${SLUG}-interrupted`
const DB_URL = process.env.DATABASE_URL ?? ""

type Rows = Array<Record<string, unknown>>
function rowsOf(result: unknown): Rows {
  return (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as Rows
}

let orgId = ""

async function usersOf(id: string): Promise<number> {
  const rows = rowsOf(
    await withSystemDb("demo-adoption-test-users", (tx) =>
      tx.execute(sql`SELECT count(*)::int AS n FROM kernel.users WHERE org_id = ${id}`),
    ),
  )
  return Number(rows[0]?.n ?? 0)
}

async function marker(): Promise<unknown> {
  invalidateDemoMarker(orgId)
  return loadDemoMarker(orgId)
}

beforeAll(async () => {
  if (DB_URL === "") throw new Error("DATABASE_URL must be set for this test")
  if (/liaison_dev/.test(DB_URL)) throw new Error("refusing to write to liaison_dev")
  // A real workspace that merely shares the slug an operator typed.
  const rows = rowsOf(
    await withSystemDb("demo-adoption-test-org", (tx) =>
      tx.execute(
        sql`INSERT INTO kernel.organizations (name, slug) VALUES ('Real Tenant', ${SLUG}) RETURNING id`,
      ),
    ),
  )
  orgId = String(rows[0]?.id ?? "")
  expect(orgId).not.toBe("")
})

afterAll(async () => {
  await withSystemDb("demo-adoption-test-cleanup", (tx) =>
    tx.execute(sql`DELETE FROM kernel.organizations WHERE slug = ${SLUG}`),
  )
  // The orgs the refusals left standing, theirs people first.
  await withSystemDb("demo-adoption-test-cleanup-left", async (tx) => {
    const left = sql`SELECT id FROM kernel.organizations WHERE slug LIKE ${`${SLUG}-%`} AND slug <> ${INTERRUPTED_SLUG}`
    await tx.execute(sql`DELETE FROM kernel.users WHERE org_id IN (${left})`)
    await tx.execute(
      sql`DELETE FROM kernel.cloud_request_outcomes WHERE idem_key LIKE ${`${SLUG}-%`}`,
    )
    await tx.execute(
      sql`DELETE FROM kernel.organizations WHERE slug LIKE ${`${SLUG}-%`} AND slug <> ${INTERRUPTED_SLUG}`,
    )
  })
  // The interrupted org is a marked demo org by now: its rows go with the demo purge path.
  await withSystemDb("demo-adoption-test-cleanup-claim", (tx) =>
    tx.execute(sql`DELETE FROM kernel.system_config WHERE key LIKE ${`seed.org-claim:${SLUG}%`}`),
  )
  await revalidateMarkerCheck()
})

describe("demoMarkRefusal", () => {
  it("allows an org that already carries the marker, or one this run created", () => {
    expect(demoMarkRefusal({ orgSlug: "a", hasMarker: true, createdThisRun: false })).toBeNull()
    expect(demoMarkRefusal({ orgSlug: "a", hasMarker: false, createdThisRun: true })).toBeNull()
  })

  it("refuses an unmarked org it did not create, naming the slug and the reason", () => {
    const refusal = demoMarkRefusal({ orgSlug: "acme", hasMarker: false, createdThisRun: false })
    expect(refusal).toContain("'acme'")
    expect(refusal).toContain("NOT a demo org")
    expect(refusal).toContain("did not create it")
  })
})

describe("demo:seed --variant visitor --reset: a seeded visitor org is replaced", () => {
  const seen: SeedDemoWorldOptions[] = []
  const stubWorld = async (opts: SeedDemoWorldOptions) => {
    seen.push(opts)
    return { complete: true, partsOff: [], orgSlug: opts.orgSlug, orgId: "stub" } as never
  }
  const demoOrgUnder = async (slug: string, orgClass: "demo" | "standard") => {
    const rows = rowsOf(
      await withSystemDb("demo-adoption-test-replace-org", (tx) =>
        tx.execute(
          sql`INSERT INTO kernel.organizations (name, slug, class) VALUES ('Walk', ${slug}, ${orgClass}) RETURNING id`,
        ),
      ),
    )
    const id = String(rows[0]?.id ?? "")
    // A standard org with a marker is refused by Postgres (0355): forged for the
    // case that proves the replace refuses it on its own.
    if (orgClass === "standard") await forgeDemoMarker(id, visitorMarker(72))
    else await markDemoOrgForTest(id, visitorMarker(72))
    await seedUserRow({ orgId: id, email: `p@${slug}.test`, name: "P", passwordHash: "x" })
    return id
  }
  const reset = (slug: string) =>
    runSeedDemoCli(["--slug", slug, "--variant", "visitor", "--reset"], { seedWorld: stubWorld })

  it("on a private box: the demo org is deleted, then seeded from nothing", async () => {
    const slug = `${SLUG}-walk`
    const old = await demoOrgUnder(slug, "demo")
    expect((await reset(slug)).exitCode).toBe(0)
    expect(await orgIdBySlug(slug)).toBeNull()
    expect(await usersOf(old)).toBe(0)
    expect(seen.at(-1)).toMatchObject({ orgSlug: slug, variant: "visitor", resetContent: false })
    // Nothing under the slug: a fresh seed, nothing to replace.
    expect((await reset(slug)).exitCode).toBe(0)
  })

  it("never an org of class standard, marker or not", async () => {
    const slug = `${SLUG}-walk-std`
    const real = await demoOrgUnder(slug, "standard")
    const calls = seen.length
    await expect(reset(slug)).rejects.toThrow(/not a demo org/)
    expect(await usersOf(real)).toBe(1)
    expect(seen.length).toBe(calls)
  })

  it("never on a public demo box", async () => {
    const slug = `${SLUG}-walk-public`
    const id = await demoOrgUnder(slug, "demo")
    DemoModeTestAccess.set(true)
    try {
      await expect(reset(slug)).rejects.toThrow(/public demo box/)
    } finally {
      DemoModeTestAccess.set(null)
    }
    expect(await usersOf(id)).toBe(1)
  })
})

describe("seeding an existing org that is not a demo org", () => {
  it("is refused, and the org is left unmarked", async () => {
    await expect(seedDemoOrg({ orgSlug: SLUG, variant: "visitor" })).rejects.toThrow(
      new RegExp(`'${SLUG}'.*NOT a demo org`),
    )
    expect(await marker()).toBeNull()
  })

  it("is never deleted by a reset on a private box: the replace refuses it and the org stays", async () => {
    DemoModeTestAccess.set(false)
    try {
      await expect(
        runSeedDemoCli(["--slug", SLUG, "--world", "saas", "--variant", "visitor", "--reset"]),
      ).rejects.toThrow(new RegExp(`'${SLUG}': it is not a demo org`))
    } finally {
      DemoModeTestAccess.set(null)
    }
    expect(await orgIdBySlug(SLUG)).toBe(orgId)
    expect(await marker()).toBeNull()
  })

  it("is refused from the CLI too, whatever flag the operator adds", async () => {
    await expect(
      runSeedDemoCli(["--slug", SLUG, "--variant", "visitor", "--adopt-non-demo-org"]),
    ).rejects.toThrow(new RegExp(`'${SLUG}'.*NOT a demo org`))
    expect(await marker()).toBeNull()
  })
})

describe("a seed killed between creating the org and marking it", () => {
  it("leaves a claim the next run recognises: the half-made org is made again, marked, the claim released", async () => {
    // What the killed run left behind: its claim, and the org row with no marker.
    await claimOrgSlug(INTERRUPTED_SLUG)
    const rows = rowsOf(
      await withSystemDb("demo-adoption-test-interrupted-org", (tx) =>
        tx.execute(
          sql`INSERT INTO kernel.organizations (name, slug, class) VALUES ('Resonant Audio Labs', ${INTERRUPTED_SLUG}, 'demo') RETURNING id`,
        ),
      ),
    )
    const interruptedId = String(rows[0]?.id ?? "")

    const org = await seedDemoOrg({ orgSlug: INTERRUPTED_SLUG, variant: "visitor" })
    expect(org.orgId).not.toBe(interruptedId)
    expect(org.people.length).toBe(7)
    invalidateDemoMarker(org.orgId)
    expect((await loadDemoMarker(org.orgId))?.variant).toBe("visitor")
    expect(await hasOrgSlugClaim(INTERRUPTED_SLUG)).toBe(false)
  }, 300_000)

  it("never deletes a standard org that took the slug since: refused, org, people and claim kept", async () => {
    const slug = `${SLUG}-taken`
    await claimOrgSlug(slug)
    const rows = rowsOf(
      await withSystemDb("demo-adoption-test-taken-org", (tx) =>
        tx.execute(
          sql`INSERT INTO kernel.organizations (name, slug) VALUES ('Real Tenant', ${slug}) RETURNING id`,
        ),
      ),
    )
    const realId = String(rows[0]?.id ?? "")
    await seedUserRow({ orgId: realId, email: `owner@${slug}.test`, name: "O", passwordHash: "x" })

    await expect(seedDemoOrg({ orgSlug: slug, variant: "visitor" })).rejects.toThrow(
      /not of class demo.*delete it by hand/,
    )
    expect(await usersOf(realId)).toBe(1)
    expect(await orgIdBySlug(slug)).toBe(realId)
    expect(await hasOrgSlugClaim(slug)).toBe(true)
  })

  it("never deletes a demo org the control plane created, even under a stale claim", async () => {
    const slug = `${SLUG}-cloud`
    await claimOrgSlug(slug)
    const rows = rowsOf(
      await withSystemDb("demo-adoption-test-cloud-org", (tx) =>
        tx.execute(
          sql`INSERT INTO kernel.organizations (name, slug, class) VALUES ('Made', ${slug}, 'demo') RETURNING id`,
        ),
      ),
    )
    const id = String(rows[0]?.id ?? "")
    await seedUserRow({ orgId: id, email: `owner@${slug}.test`, name: "O", passwordHash: "x" })
    await claimOutcome(CLOUD_CREATE_ORG_ENDPOINT, slug, "owner")

    await expect(seedDemoOrg({ orgSlug: slug, variant: "visitor" })).rejects.toThrow(
      /no longer an interrupted seed's org/,
    )
    expect(await usersOf(id)).toBe(1)
  })

  it("leaves no claim behind after a run that completes", async () => {
    expect(await hasOrgSlugClaim(SLUG)).toBe(false)
  })
})
