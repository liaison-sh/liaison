// SPDX-License-Identifier: FSL-1.1-ALv2
// liaison-messaging-visibility Task 2: pins the SCOPE of 0037's backfill —
// it must flip the mechanical 0007 reset back to 'daily' without resurrecting
// a genuine post-0007 opt-out, and must be idempotent (safe to re-run).
//
// Mirrors the UPDATE in 0037_digest_default_daily.sql exactly (the migration
// itself already ran once against the shared test DB via db:migrate — this
// re-executes the same statement against freshly seeded rows with controlled
// `updated_at` timestamps to prove the predicate's boundary behavior).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const CUTOFF = "2026-07-03 23:59:59+00"

async function runBackfill(): Promise<void> {
  await withSystemDb("0037-backfill-test-run", (tx) =>
    tx.execute(drizzleSql`
      UPDATE kernel.user_preferences
        SET digest_cadence = 'daily', updated_at = now()
        WHERE digest_cadence = 'off'
          AND updated_at <= ${CUTOFF}::timestamptz
    `),
  )
}

async function cadenceFor(userId: string): Promise<string | undefined> {
  const rows = extractRows<{ digest_cadence: string }>(
    await withSystemDb("0037-backfill-test-read", (tx) =>
      tx.execute(
        drizzleSql`SELECT digest_cadence FROM kernel.user_preferences WHERE user_id = ${userId}`,
      ),
    ),
  )
  return rows[0]?.digest_cadence
}

let orgId: string

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await createTestOrg()).id
})

afterAll(releaseTestLock)

async function seedUser(cadence: string, updatedAt: string): Promise<string> {
  const id = randomUUID()
  await withSystemDb("0037-backfill-test-seed", async (tx) => {
    await tx.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (${id}::uuid, ${orgId}, ${`0037-${id}@t.co`}, 'Migration Test', 'active', 'hash', 1, 1)
    `)
    await tx.execute(drizzleSql`
      INSERT INTO kernel.user_preferences (user_id, digest_cadence, updated_at)
      VALUES (${id}::uuid, ${cadence}, ${updatedAt}::timestamptz)
    `)
  })
  return id
}

describe("0037_digest_default_daily backfill scoping", () => {
  it("flips a pre-cutoff 'off' row (the mechanical 0007 reset) to 'daily'", async () => {
    const preCutoffOff = await seedUser("off", "2026-07-03T12:00:00Z")
    await runBackfill()
    expect(await cadenceFor(preCutoffOff)).toBe("daily")
  })

  it("flips a row updated exactly at the cutoff instant (inclusive boundary)", async () => {
    const atCutoff = await seedUser("off", "2026-07-03T23:59:59Z")
    await runBackfill()
    expect(await cadenceFor(atCutoff)).toBe("daily")
  })

  it("leaves an explicit opt-out dated inside the old, wider (now-corrected) 2026-07-05 window alone", async () => {
    // Regression case for the review finding: an earlier draft of this
    // migration used a cutoff of 2026-07-05 00:00:00+00, a 2-day-wider
    // window than 0007's actual same-day deploy. A user who explicitly
    // chose 'off' in Settings on 2026-07-04 -- one day after the opt-in
    // regime went live -- would have been silently resurrected to 'daily'
    // by that wider window. The corrected cutoff (2026-07-03 23:59:59+00)
    // must leave this row alone.
    const explicitOptOutInOldWindow = await seedUser("off", "2026-07-04T00:00:00Z")
    await runBackfill()
    expect(await cadenceFor(explicitOptOutInOldWindow)).toBe("off")
  })

  it("leaves a post-cutoff explicit 'off' row alone (real opt-out)", async () => {
    const postCutoffOff = await seedUser("off", "2026-08-01T00:00:00Z")
    await runBackfill()
    expect(await cadenceFor(postCutoffOff)).toBe("off")
  })

  it("leaves an 'hourly' row untouched regardless of updated_at", async () => {
    const hourly = await seedUser("hourly", "2026-07-01T00:00:00Z")
    await runBackfill()
    expect(await cadenceFor(hourly)).toBe("hourly")
  })

  it("is idempotent: a second run makes no further change", async () => {
    const preCutoffOff = await seedUser("off", "2026-06-01T00:00:00Z")
    await runBackfill()
    expect(await cadenceFor(preCutoffOff)).toBe("daily")
    const before = extractRows<{ updated_at: string }>(
      await withSystemDb("0037-idem-read-1", (tx) =>
        tx.execute(
          drizzleSql`SELECT updated_at FROM kernel.user_preferences WHERE user_id = ${preCutoffOff}`,
        ),
      ),
    )[0]?.updated_at
    await runBackfill()
    expect(await cadenceFor(preCutoffOff)).toBe("daily")
    const after = extractRows<{ updated_at: string }>(
      await withSystemDb("0037-idem-read-2", (tx) =>
        tx.execute(
          drizzleSql`SELECT updated_at FROM kernel.user_preferences WHERE user_id = ${preCutoffOff}`,
        ),
      ),
    )[0]?.updated_at
    // Predicate no longer matches (digest_cadence is now 'daily', not 'off'),
    // so the second run's UPDATE does not touch this row at all.
    expect(after).toBe(before)
  })
})
