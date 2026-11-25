// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHO STANDS IN FOR AN AWAY ACCOUNT MANAGER is read on the manager's own day: their time zone,
// else the organization's. A UTC day is wrong every night east of it and every evening west.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { sql } from "~/db/connection"
import { insertSql } from "~/seed/factories/org/test-rows"
import * as minimal from "~/seed/tiers/minimal"
import { createTestCompany } from "~/tests/helpers/company"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { loadAccountManager } from "./translator"

let orgId = ""
let company = ""
let manager = ""
let next = ""

/** 5 January 2027, 00:42 in Paris; still the 4th in UTC. */
const PAST_MIDNIGHT_IN_PARIS = new Date("2027-01-04T23:42:00Z")
/** 4 January 2027, 21:30 in New York; already the 5th in UTC. */
const EVENING_IN_NEW_YORK = new Date("2027-01-05T02:30:00Z")

async function zones(org: string, person: string | null) {
  await sql`UPDATE kernel.organizations SET timezone = ${org} WHERE id = ${orgId}`
  await sql`UPDATE kernel.users SET timezone = ${person} WHERE id = ${manager}`
}

describe("an away account manager's stand-in, by the manager's own day", () => {
  beforeAll(async () => {
    await acquireTestLock()
    orgId = (await createTestOrg()).id
    manager = (await minimal.person(orgId, { name: "Fixture manager" })).id
    next = (await minimal.person(orgId, { name: "Fixture next" })).id
    company = await createTestCompany(orgId)
    await sql`UPDATE kernel.companies SET owner_user_id = ${manager} WHERE id = ${company}`
    await sql.unsafe(
      insertSql("kernel.away_ranges", {
        org_id: orgId,
        user_id: manager,
        starts_on: "2027-01-05",
        ends_on: "2027-01-08",
        next_in_line_id: next,
        source: "said",
        set_by: manager,
      }),
    )
  }, 60_000)

  beforeEach(() => zones("UTC", null))

  afterAll(async () => {
    await zones("UTC", null)
    await sql`DELETE FROM kernel.away_ranges WHERE org_id = ${orgId}`
    await releaseTestLock()
  })

  it("the first minutes of the first day away reach the next in line", async () => {
    await zones("Europe/Paris", null)
    expect(await loadAccountManager(orgId, company, { now: PAST_MIDNIGHT_IN_PARIS })).toEqual([
      manager,
      next,
    ])
  })

  it("the evening before, west of UTC, does not", async () => {
    await zones("America/New_York", null)
    expect(await loadAccountManager(orgId, company, { now: EVENING_IN_NEW_YORK })).toEqual([
      manager,
    ])
  })

  it("the manager's own zone comes before the organization's", async () => {
    await zones("America/New_York", "Europe/Paris")
    expect(await loadAccountManager(orgId, company, { now: PAST_MIDNIGHT_IN_PARIS })).toEqual([
      manager,
      next,
    ])
  })

  it("with no zone set at all, the day is UTC's", async () => {
    expect(await loadAccountManager(orgId, company, { now: PAST_MIDNIGHT_IN_PARIS })).toEqual([
      manager,
    ])
  })
})
