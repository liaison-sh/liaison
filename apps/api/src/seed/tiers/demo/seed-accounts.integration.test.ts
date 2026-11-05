// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The accounts layer against a real database: the reserved org's owner opens
// the product on a FEW unread conversations, not on every conversation the seed
// joined them to.
//
// The accounts layer joins the owner to every seeded thread, and with no read
// state each one of them arrived unread: about thirty unread conversations on
// Chats and a badge to match, on the account Apple's reviewer signs into. The
// seed now reads the owner up to the latest message everywhere except the
// most recent few, and the same state comes back after a top up, after
// somebody read or unread things by hand, and after a content reset.
//
//   bun run scripts/test-run.ts demo-seed --file "$PWD/apps/api/src/seed/tiers/demo/seed-accounts.integration.test.ts"
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { sql } from "drizzle-orm"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import {
  invalidateDemoMarker,
  loadDemoMarker,
  markOrgAsDemo,
  reservedMarker,
} from "~/modules/demo/demo-org"
import { resetDemoOrgContent } from "~/modules/demo/demo-reset"
import { computeUnreadMessageCount } from "~/modules/push/badge-count"
import { messagesListShows } from "~/modules/threads/thread"
import { DEMO_UNREAD_CONVERSATIONS, seedDemoAccounts } from "./seed-accounts"
import { type SeedDemoOrgResult, seedDemoOrg } from "./seed-org"
import { seedDemoSupport } from "./seed-support"

const ORG_SLUG = "demo-accounts-integration"
const DB_URL = process.env.DATABASE_URL ?? ""
const BASE_TIME = new Date("2026-09-16T09:00:00.000Z")

type Rows = Array<Record<string, unknown>>
function rowsOf(result: unknown): Rows {
  return (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as Rows
}

/**
 * The conversations Chats shows the user as unread, by title: the badge's own
 * unread rule (badge-count.ts) and the Messages list's own predicate, per
 * thread.
 */
async function unreadTitles(orgId: string, userId: string): Promise<string[]> {
  const k = sql.raw("kernel")
  const rows = rowsOf(
    await withPrivilegedDb(orgId, "demo-accounts-test-unread", (tx) =>
      tx.execute(sql`
        SELECT t.title FROM kernel.threads t
        JOIN kernel.thread_participants tp ON tp.thread_id = t.id AND tp.user_id = ${userId}::uuid
        LEFT JOIN kernel.user_thread_state uts ON uts.thread_id = t.id AND uts.user_id = ${userId}::uuid
        WHERE t.org_id = ${orgId}::uuid
          AND ${messagesListShows(k)}
          AND EXISTS (
            SELECT 1 FROM kernel.messages m
            WHERE m.thread_id = t.id AND m.deleted_at IS NULL
              AND NOT (m.author_id = ${userId}::uuid AND m.author_type IN ('user', 'system'))
              AND (m.reply_root_id IS NULL OR m.also_in_channel)
              AND m.created_at > COALESCE(
                (SELECT m2.created_at FROM kernel.messages m2 WHERE m2.id = uts.last_read_message_id),
                '1970-01-01'::timestamptz))
        ORDER BY t.title`),
    ),
  )
  return rows.map((r) => String(r.title))
}

async function joinedCount(orgId: string, userId: string): Promise<number> {
  const rows = rowsOf(
    await withPrivilegedDb(orgId, "demo-accounts-test-joined", (tx) =>
      tx.execute(sql`SELECT count(*)::int AS n FROM kernel.thread_participants
                     WHERE org_id = ${orgId}::uuid AND user_id = ${userId}::uuid`),
    ),
  )
  return Number(rows[0]?.n ?? 0)
}

let org: SeedDemoOrgResult
let ownerId = ""
let afterFirst: string[] = []

beforeAll(async () => {
  if (DB_URL === "") throw new Error("DATABASE_URL must be set for this test")
  if (/liaison_dev|liaison_test(?!_)/.test(DB_URL)) {
    throw new Error("refusing to seed a shared database: use an isolated test database")
  }
  // The content reset below refuses a process that is not a demo instance.
  DemoModeTestAccess.set(true)
  if (!process.env.LIAISON_APPS_DIR) {
    process.env.LIAISON_APPS_DIR = path.join(
      mkdtempSync(path.join(tmpdir(), "demo-accounts-")),
      "apps",
    )
  }
  // This test's own slug: a run killed between the org pass and the marker
  // leaves the row unmarked, and the seeder refuses an unmarked org it did not
  // create. Re-mark that leftover here, as the operator would, before seeding.
  const leftover = rowsOf(
    await withSystemDb("demo-accounts-test-leftover", (tx) =>
      tx.execute(sql`SELECT id FROM kernel.organizations WHERE slug = ${ORG_SLUG}`),
    ),
  )
  const leftoverId = leftover[0]?.id
  if (typeof leftoverId === "string") {
    invalidateDemoMarker(leftoverId)
    if ((await loadDemoMarker(leftoverId)) === null) {
      await markOrgAsDemo(leftoverId, reservedMarker())
    }
  }
  org = await seedDemoOrg({
    orgSlug: ORG_SLUG,
    variant: "reserved",
    owner: {
      email: `owner@${ORG_SLUG}.example`,
      name: "Demo Owner",
      password: "Demo-Owner-Accounts-9",
    },
  })
  ownerId = org.ownerUserId ?? ""
  // A previous run left its own world behind: start from a cleared one.
  await resetDemoOrgContent(org.orgId)
  await seedDemoSupport(org, { now: BASE_TIME })
  await seedDemoAccounts(org)
  afterFirst = await unreadTitles(org.orgId, ownerId)
}, 1_800_000)

afterAll(() => {
  DemoModeTestAccess.set(null)
})

describe("seedDemoAccounts: the owner's read state", () => {
  it("leaves only the few most recent conversations unread", async () => {
    // Joined to many, so the assertion below is not comparing a near empty org.
    expect(await joinedCount(org.orgId, ownerId)).toBeGreaterThan(10)
    expect(afterFirst.length).toBe(DEMO_UNREAD_CONVERSATIONS)
    expect(DEMO_UNREAD_CONVERSATIONS).toBeGreaterThanOrEqual(2)
    expect(DEMO_UNREAD_CONVERSATIONS).toBeLessThanOrEqual(3)
    // One new message each: the badge is the conversations, not their history.
    expect(await computeUnreadMessageCount(ownerId, org.orgId)).toBe(DEMO_UNREAD_CONVERSATIONS)
  })

  it("converges after the owner read everything or nothing", async () => {
    await withPrivilegedDb(org.orgId, "demo-accounts-test-drift", (tx) =>
      tx.execute(sql`DELETE FROM kernel.user_thread_state
                     WHERE org_id = ${org.orgId}::uuid AND user_id = ${ownerId}::uuid`),
    )
    // With no read state at all (the seed before this change), every
    // conversation the owner was joined to is unread.
    expect((await unreadTitles(org.orgId, ownerId)).length).toBeGreaterThan(
      DEMO_UNREAD_CONVERSATIONS + 3,
    )
    await seedDemoAccounts(org)
    expect(await unreadTitles(org.orgId, ownerId)).toEqual(afterFirst)
  })

  // Walk D23: a visitor's first view showed 6 unread chats although the seed
  // had read them all. The read state is written straight into the table while
  // the visitor's page is already open, and that page had counted the seed's
  // messages as they landed: the read marks must reach the owner's devices.
  it("tells the owner's devices where every conversation's read mark now stands", async () => {
    const frames: Array<{ userId: string; change: Record<string, unknown> }> = []
    await seedDemoAccounts(org, {
      broadcast: async (_orgId, userId, change) => {
        frames.push({ userId, change: change as Record<string, unknown> })
      },
    })
    const threads = frames.filter((f) => f.change.kind === "thread")
    expect(threads.length).toBe(await joinedCount(org.orgId, ownerId))
    expect(threads.every((f) => f.userId === ownerId)).toBe(true)
    // The few left unread hold one new message each; every other one none.
    expect(threads.filter((f) => f.change.unreadCount === 1).length).toBe(DEMO_UNREAD_CONVERSATIONS)
    expect(
      threads.filter((f) => f.change.unreadCount !== 1).every((f) => f.change.unreadCount === 0),
    ).toBe(true)
  })

  it("comes back the same after a content reset and a re-seed", async () => {
    await resetDemoOrgContent(org.orgId)
    await seedDemoSupport(org, { now: BASE_TIME })
    await seedDemoAccounts(org)
    expect(await unreadTitles(org.orgId, ownerId)).toEqual(afterFirst)
  }, 1_800_000)
})
