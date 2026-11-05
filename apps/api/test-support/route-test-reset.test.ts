// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The per-file reset in route-test-setup.ts: the Redis cleanup and the table
// reset every route test file runs twice. Both were rewritten for speed (one
// KEYS pass instead of one per pattern; DELETE under replica mode instead of a
// ~110-table TRUNCATE), so these pin that they still do what the slow versions
// did.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { sql } from "~/db"
import { redis } from "~/lib/redis"
import {
  acquireTestLock,
  clearRedisPatterns,
  globToRegExp,
  releaseTestLock,
  truncateOrgTables,
} from "~/tests/route-test-setup"

beforeAll(acquireTestLock)
afterAll(releaseTestLock)

describe("globToRegExp", () => {
  const cases: Array<[string, string, boolean]> = [
    ["bull:*", "bull:queue:1", true],
    ["bull:*", "xbull:queue", false],
    ["ratelimit:*", "ratelimit:", true],
    ["ratelimit:*", "ratelimitx", false],
    ["a?c", "abc", true],
    ["a?c", "ac", false],
    ["[ab]x", "bx", true],
    ["[ab]x", "cx", false],
    ["[^a]x", "bx", true],
    ["[^a]x", "ax", false],
    ["a\\*", "a*", true],
    ["a\\*", "ab", false],
    ["a.b(c)", "a.b(c)", true],
    ["a.b", "axb", false],
  ]
  for (const [glob, key, matches] of cases) {
    it(`${glob} ${matches ? "matches" : "does not match"} ${key}`, () => {
      expect(globToRegExp(glob).test(key)).toBe(matches)
    })
  }
})

describe("clearRedisPatterns", () => {
  it("deletes exactly the keys the patterns match, under this process's prefix", async () => {
    const tag = crypto.randomUUID().slice(0, 8)
    const doomed = [`rt-${tag}:rate:a`, `rt-${tag}:rate:b`, `rt-${tag}:brute:1`]
    const kept = [`rt-${tag}:ratex`, `rt-${tag}:other:a`, `rt-${tag}:brute:12`]
    for (const key of [...doomed, ...kept]) await redis.set(key, "1")

    await clearRedisPatterns([`rt-${tag}:rate:*`, `rt-${tag}:brute:?`])

    for (const key of doomed) expect(await redis.exists(key)).toBe(0)
    for (const key of kept) expect(await redis.exists(key)).toBe(1)
    await redis.del(...kept)
  })
})

describe("truncateOrgTables", () => {
  it("empties the TRUNCATE ... CASCADE set, ignoring row triggers, and leaves the rest", async () => {
    const orgId = crypto.randomUUID()
    const userId = crypto.randomUUID()
    const tag = orgId.slice(0, 8)
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${orgId}, 'Reset', ${`reset-${tag}`})`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${userId}, ${orgId}, ${`reset-${tag}@t.com`}, 'R')`
    // A non-disclosable policy row: its BEFORE DELETE trigger silently refuses a
    // plain DELETE while the org exists. TRUNCATE fires no row trigger, so the
    // reset must not either.
    await sql`INSERT INTO kernel.scope_disclosure_policy (org_id, scope, disclosable) VALUES (${orgId}, 'reset:things:read', false)`
    // Seeded by a migration and outside the cascade set: never touched.
    const [seeded] = await sql<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM kernel.shareable_resource_types`
    expect(seeded?.n).toBeGreaterThan(0)

    await truncateOrgTables()

    const [counts] = await sql<{ orgs: number; users: number; policies: number; seeded: number }[]>`
      SELECT
        (SELECT count(*)::int FROM kernel.organizations) AS orgs,
        (SELECT count(*)::int FROM kernel.users) AS users,
        (SELECT count(*)::int FROM kernel.scope_disclosure_policy) AS policies,
        (SELECT count(*)::int FROM kernel.shareable_resource_types) AS seeded`
    expect(counts).toEqual({ orgs: 0, users: 0, policies: 0, seeded: seeded?.n ?? -1 })
  })
})
