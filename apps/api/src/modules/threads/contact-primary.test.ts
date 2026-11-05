// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { sql } from "~/db"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { getOrCreateContactPrimaryThread } from "./contact-primary"

describe("getOrCreateContactPrimaryThread (B1)", () => {
  beforeAll(async () => {
    await acquireTestLock()
  })
  afterAll(async () => {
    await releaseTestLock()
  })

  test("creates a new thread the first time", async () => {
    const org = await createTestOrg()
    const admin = await minimal.person(org.id, { role: "admin" })
    const contactId = await minimal.contact(org.id, `c1-${crypto.randomUUID()}@t.co`)

    const { id } = await getOrCreateContactPrimaryThread(org.id, contactId, admin.id)
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
  })

  test("returns the same id on the second call (idempotent)", async () => {
    const org = await createTestOrg()
    const admin = await minimal.person(org.id, { role: "admin" })
    const contactId = await minimal.contact(org.id, `c2-${crypto.randomUUID()}@t.co`)

    const a = await getOrCreateContactPrimaryThread(org.id, contactId, admin.id)
    const b = await getOrCreateContactPrimaryThread(org.id, contactId, admin.id)
    expect(b.id).toBe(a.id)
  })

  test("a non-creator caller is upserted as a participant on the existing thread", async () => {
    const org = await createTestOrg()
    const creator = await minimal.person(org.id, { role: "admin" })
    const other = await minimal.person(org.id, { role: "member" })
    const contactId = await minimal.contact(org.id, `c3-${crypto.randomUUID()}@t.co`)

    const first = await getOrCreateContactPrimaryThread(org.id, contactId, creator.id)
    // A second user reaching the same contact thread must not 500 and must
    // become a participant so their RLS-scoped reads/writes succeed.
    const second = await getOrCreateContactPrimaryThread(org.id, contactId, other.id)
    expect(second.id).toBe(first.id)

    const parts = await sql`
      SELECT user_id, role FROM kernel.thread_participants
      WHERE thread_id = ${first.id} AND org_id = ${org.id}
      ORDER BY user_id
    `
    const byUser = new Map(parts.map((r) => [r.user_id, r.role]))
    expect(byUser.get(creator.id)).toBe("admin")
    expect(byUser.get(other.id)).toBe("member")
  })
})
