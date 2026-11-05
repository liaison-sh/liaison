// SPDX-License-Identifier: FSL-1.1-ALv2
// P13-I6: I6 ("kernel copy translated server-side from the user's stored
// language") hinges on defaultLoadUser actually reading
// kernel.user_preferences.language. The prior tests only fed renderDigestEmail
// an injected locale; this exercises the REAL SQL link.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { ConsoleEmailProvider } from "~/infra/email"
import {
  defaultLoadUser,
  runDigestDailyAt,
  runDigestHourlyOnce,
} from "~/modules/attention/digest-jobs"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId: string
let userId: string

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await createTestOrg()).id
  userId = await withSystemDb("digest-load-user-uid", async (tx) => {
    const rows = extractRows<{ id: string }>(
      await tx.execute(
        drizzleSql`SELECT id FROM kernel.users WHERE org_id = ${orgId} ORDER BY created_at ASC LIMIT 1`,
      ),
    )
    return rows[0].id
  })
})

afterAll(releaseTestLock)

describe("defaultLoadUser reads the persisted UI language (I6)", () => {
  test("returns the stored kernel.user_preferences.language", async () => {
    await withSystemDb("digest-load-user-pref", async (tx) => {
      await tx.execute(drizzleSql`
        INSERT INTO kernel.user_preferences (user_id, language)
        VALUES (${userId}, 'fr')
        ON CONFLICT (user_id) DO UPDATE SET language = 'fr'
      `)
    })
    const user = await defaultLoadUser(userId)
    expect(user).not.toBeNull()
    expect(user?.language).toBe("fr")
  })

  // A user who never chose a language reads the ORG's language. The column
  // used to default to 'en', which beat a French org's default for everyone.
  test("no preferences row → the org default locale (fr-FR org → fr)", async () => {
    await withSystemDb("digest-load-user-clear", async (tx) => {
      await tx.execute(drizzleSql`DELETE FROM kernel.user_preferences WHERE user_id = ${userId}`)
      await tx.execute(
        drizzleSql`UPDATE kernel.organizations SET default_locale = 'fr-FR' WHERE id = ${orgId}`,
      )
    })
    const user = await defaultLoadUser(userId)
    expect(user?.language).toBe("fr")
  })

  test("a row created without a language (never chose) → the org default, not en", async () => {
    await withSystemDb("digest-load-user-null-lang", async (tx) => {
      await tx.execute(
        drizzleSql`UPDATE kernel.organizations SET default_locale = 'fr' WHERE id = ${orgId}`,
      )
      await tx.execute(drizzleSql`
        INSERT INTO kernel.user_preferences (user_id, timezone) VALUES (${userId}, 'UTC')
        ON CONFLICT (user_id) DO UPDATE SET language = DEFAULT
      `)
    })
    const user = await defaultLoadUser(userId)
    expect(user?.language).toBe("fr")
  })

  test("an explicit English choice still beats a French org default", async () => {
    await withSystemDb("digest-load-user-explicit-en", async (tx) => {
      await tx.execute(
        drizzleSql`UPDATE kernel.organizations SET default_locale = 'fr' WHERE id = ${orgId}`,
      )
      await tx.execute(drizzleSql`
        INSERT INTO kernel.user_preferences (user_id, language) VALUES (${userId}, 'en')
        ON CONFLICT (user_id) DO UPDATE SET language = 'en'
      `)
    })
    const user = await defaultLoadUser(userId)
    expect(user?.language).toBe("en")
    await withSystemDb("digest-load-user-reset-org", async (tx) => {
      await tx.execute(
        drizzleSql`UPDATE kernel.organizations SET default_locale = 'en-US' WHERE id = ${orgId}`,
      )
    })
  })

  test("last_daily_sent_at comes back as a finite Date (raw execute returns a string)", async () => {
    // Field bug (staging 2026-07-03): the raw tx.execute row left
    // last_daily_sent_at a string; shouldFireDailyDigest fed it to
    // Intl.DateTimeFormat.formatToParts → ToNumber(string) = NaN →
    // "RangeError: date value is not finite" on EVERY daily tick once the
    // first digest had been sent.
    await withSystemDb("digest-load-user-sent-at", async (tx) => {
      await tx.execute(drizzleSql`
        INSERT INTO kernel.user_preferences (user_id, last_daily_sent_at)
        VALUES (${userId}, '2026-07-03T06:10:00.000Z')
        ON CONFLICT (user_id) DO UPDATE SET last_daily_sent_at = '2026-07-03T06:10:00.000Z'
      `)
    })
    const user = await defaultLoadUser(userId)
    expect(user?.lastDailySentAt).toBeInstanceOf(Date)
    expect(Number.isFinite(user?.lastDailySentAt?.getTime() ?? Number.NaN)).toBe(true)
    // The exact call chain that crashed in the field must not throw:
    const { shouldFireDailyDigest } = await import("~/modules/attention/digest")
    expect(() =>
      shouldFireDailyDigest(new Date("2026-07-03T09:00:00Z"), "UTC", user?.lastDailySentAt ?? null),
    ).not.toThrow()
  })
})

// liaison-messaging-visibility Task 2: with the digest_cadence default flipped
// to 'daily', a user with NO kernel.user_preferences row must be selected by
// the DAILY cadence job (never hourly/immediate) — this is what actually
// queues the email for row-less users, via defaultFetchCadencePending's
// COALESCE(p.digest_cadence, 'daily').
describe("row-less user gets the daily digest (default cadence flip)", () => {
  test("a user with no prefs row is fetched by runDigestDailyAt and NOT by hourly", async () => {
    const rowlessUserId = randomUUID()
    await withSystemDb("digest-rowless-user-seed", async (tx) => {
      await tx.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (${rowlessUserId}::uuid, ${orgId}, ${`rowless-${rowlessUserId}@t.co`}, 'Rowless', 'active', 'hash', 1, 1)
      `)
      // Deliberately NO kernel.user_preferences row for this user.
      await tx.execute(drizzleSql`
        INSERT INTO kernel.attention_events
          (id, org_id, user_id, app, entity_type, entity_id, kind, urgency, summary,
           actor_type, occurred_at, is_urgent, digest_state, digest_eligible_at, email_only)
        VALUES (gen_random_uuid(), ${orgId}, ${rowlessUserId}::uuid, 'kernel', 'thread',
                ${randomUUID()}, 'thread_reply', 30, 'rowless digest test',
                'system', now() - interval '1 minute', false, 'pending',
                now() - interval '1 minute', false)
      `)
    })

    const sentUserIds: string[] = []
    const provider = new ConsoleEmailProvider()
    const commonDeps = {
      provider,
      emitDigestFailureAlert: async () => {},
      markRowsSent: async (_rowIds: string[]) => {
        sentUserIds.push(rowlessUserId)
      },
      setLastDailySent: async () => {},
    }

    // Hourly cadence job must NOT select this user (their effective cadence
    // is 'daily', the new default — not 'hourly').
    await runDigestHourlyOnce(commonDeps)
    expect(sentUserIds).toEqual([])

    // Daily cadence job DOES select them. shouldFireDailyDigest only fires
    // once the user's local clock has crossed 08:00 (see digest.ts), so this
    // must use a fixed "now" well after that threshold in UTC (the user's
    // default timezone with no prefs row) rather than the real wall clock:
    // a bare `new Date()` makes the assertion fail whenever the suite runs
    // before 08:00 UTC, which is a real-world occurrence, not a fixture.
    await runDigestDailyAt(new Date("2026-01-01T12:00:00.000Z"), commonDeps)
    expect(sentUserIds).toEqual([rowlessUserId])
  })
})
