// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P3b-FX3: a seed that throws half way through must leave nothing behind.
//
// The gestalt rule is that walk artifacts do not survive the walk. `seedFixture`
// honoured it only on the happy path: the teardown ran from the scenario's own
// `created` list, which the fixture joins only once the seed has RETURNED, so a
// throw after the organisation insert left an organisation, a user, a role and
// three agents in the database for good.
//
// No model runs here and no key is needed: the failure is a database
// constraint, which is deterministic.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { seedFixture } from "./harness"

/** A label of this run's own, so the counts below can only see this test. */
const LABEL = `leak-${crypto.randomUUID().slice(0, 8)}`

async function rowsLeftFor(label: string): Promise<{ orgs: number; threads: number }> {
  const [orgs] = await sql<Array<{ n: string }>>`
    SELECT COUNT(*) AS n FROM kernel.organizations WHERE slug LIKE ${`p3b-${label}-%`}`
  const [threads] = await sql<Array<{ n: string }>>`
    SELECT COUNT(*) AS n FROM kernel.threads WHERE handle LIKE ${`coord-${label}-%`}`
  return { orgs: Number(orgs.n), threads: Number(threads.n) }
}

beforeAll(async () => {
  await acquireTestLock()
})

afterAll(async () => {
  await releaseTestLock()
})

describe("what a failed seed leaves behind", () => {
  it("leaves no rows when the seed throws after the organisation insert", async () => {
    // Seating one agent twice violates the unique agent seat per thread, and
    // that insert is the last step of the seed: everything above it is already
    // written when it throws.
    await expect(seedFixture({ label: LABEL, seated: ["alex", "alex"] })).rejects.toBeInstanceOf(
      Error,
    )
    expect(await rowsLeftFor(LABEL)).toEqual({ orgs: 0, threads: 0 })
  }, 60_000)
})
