// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The host-side contact policy for inbound mail senders (design audit
// 2026-09-30, #6). End-to-end coverage through the sandbox lives in
// apps/mail/page-write.test.ts; this pins the policy's edges on its own.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withRlsContext } from "~/db/rls"
import { redisBullMQ } from "~/lib/redis"
import { bucketKey } from "~/middleware/rate-limiter"
import {
  AUTO_CONTACTS_PER_MAILBOX_PER_DAY,
  isMachineAddress,
  resolveSenderContacts,
} from "~/modules/mail/sender-contacts"

const suffix = crypto.randomUUID().slice(0, 8)
const SHARED_INBOX = crypto.randomUUID()
const PERSONAL_INBOX = crypto.randomUUID()
let orgId: string
let existingId: string
let ownerId: string
let otherId: string

async function contactsNamed(email: string): Promise<number> {
  const [row] = extractRows<{ n: number }>(
    await db.execute(drizzleSql`
      SELECT count(*)::int AS n FROM kernel.contacts
       WHERE org_id = ${orgId}::uuid AND LOWER(email) = ${email}`),
  )
  return row.n
}

async function contactRow(id: string) {
  const [row] = extractRows<{
    org_access: string
    owner_user_id: string | null
    acl_user_ids: string[]
    acl_role_ids: string[]
  }>(
    await db.execute(drizzleSql`
      SELECT org_access, owner_user_id::text AS owner_user_id, acl_user_ids, acl_role_ids
        FROM kernel.contacts WHERE id = ${id}::uuid`),
  )
  return row
}

/** The contact ids a user can SELECT under RLS, given their mailbox access. */
async function visibleTo(userId: string, inboxes: string[], ids: string[]): Promise<string[]> {
  return withRlsContext(
    {
      actorType: "user",
      userId,
      orgId,
      scopes: ["kernel:contacts:read"],
      dimensionGrants: inboxes.length > 0 ? { "mail:inbox": inboxes } : {},
    },
    async (tx) =>
      extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          SELECT id::text AS id FROM kernel.contacts
           WHERE id IN (${drizzleSql.join(
             ids.map((id) => drizzleSql`${id}::uuid`),
             drizzleSql`, `,
           )})`),
      ).map((r) => r.id),
  )
}

function resolve(kind: "user" | "org", senders: Parameters<typeof resolveSenderContacts>[3]) {
  return resolveSenderContacts(
    orgId,
    "system:mail:sync",
    kind === "user"
      ? { id: PERSONAL_INBOX, ownerType: "user", ownerId }
      : { id: SHARED_INBOX, ownerType: "org", ownerId: null },
    senders,
  )
}

beforeAll(async () => {
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Sender contacts', ${`sender-contacts-${suffix}`}) RETURNING id`),
  )
  orgId = org.id
  const users = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}, ${`owner-${suffix}@corp.example`}, 'Owner', 'active', 'h', 1, 1),
             (gen_random_uuid(), ${orgId}, ${`other-${suffix}@corp.example`}, 'Other', 'active', 'h', 1, 1)
      RETURNING id`),
  )
  ownerId = users[0].id
  otherId = users[1].id
  const [existing] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.contacts (org_id, handle, email, name)
      VALUES (${orgId}, ${`S-${suffix}`}, ${`Client-${suffix}@Acme.example`}, 'Client')
      RETURNING id`),
  )
  existingId = existing.id
})

afterAll(async () => {
  await db.execute(drizzleSql`DELETE FROM kernel.contacts WHERE org_id = ${orgId}::uuid`)
  await db.execute(drizzleSql`DELETE FROM kernel.resource_grants WHERE org_id = ${orgId}::uuid`)
})

describe("resolveSenderContacts", () => {
  it("recognises machine senders by local part, and only those", () => {
    for (const email of [
      "noreply@x.example",
      "no-reply@x.example",
      "do_not_reply@x.example",
      "notifications@x.example",
      "notification+123@x.example",
      "mailer-daemon@x.example",
      "bounces@x.example",
    ]) {
      expect(isMachineAddress(email)).toBe(true)
    }
    for (const email of [
      "info@x.example",
      "support@x.example",
      "jane@x.example",
      "noreplyjane@x.example",
    ]) {
      expect(isMachineAddress(email)).toBe(false)
    }
  })

  it("a personal mailbox links the organisation's contact, and keeps a new sender to its owner", async () => {
    const newcomer = `new-${suffix}@person.example`
    const map = await resolve("user", [
      { email: `client-${suffix}@acme.example` },
      { email: newcomer, name: "New Person" },
      { email: `noreply-${suffix}@shop.example` },
    ])
    expect(map[`client-${suffix}@acme.example`]).toBe(existingId)
    expect(Object.keys(map).sort()).toEqual([`client-${suffix}@acme.example`, newcomer].sort())
    const row = await contactRow(map[newcomer])
    // Never the organisation's: the owner's alone.
    expect(row.org_access).toBe("none")
    expect(row.owner_user_id).toBe(ownerId)
    expect(row.acl_user_ids).toEqual([ownerId])
    expect(await contactsNamed(`noreply-${suffix}@shop.example`)).toBe(0)
    // RLS: the owner sees it, a colleague does not; both see the org contact.
    expect((await visibleTo(ownerId, [], [map[newcomer], existingId])).sort()).toEqual(
      [map[newcomer], existingId].sort(),
    )
    expect(await visibleTo(otherId, [], [map[newcomer], existingId])).toEqual([existingId])
    // Idempotent.
    expect(await resolve("user", [{ email: newcomer }])).toEqual({ [newcomer]: map[newcomer] })
  })

  it("a shared mailbox shares a new human sender with the mailbox's members only, never bulk or machine senders", async () => {
    const human = `human-${suffix}@person.example`
    const senders = [
      { email: human, name: "Human" },
      { email: human.toUpperCase(), name: "Human again" },
      { email: `list-${suffix}@news.example`, bulk: false },
      { email: `list-${suffix}@news.example`, bulk: true },
      { email: `noreply-${suffix}@shop.example` },
      { email: `client-${suffix}@acme.example` },
    ]
    const map = await resolve("org", senders)
    expect(Object.keys(map).sort()).toEqual([`client-${suffix}@acme.example`, human].sort())
    expect(map[`client-${suffix}@acme.example`]).toBe(existingId)
    expect(await contactsNamed(human)).toBe(1)
    // Flagged bulk by any message of the page: bulk for the page.
    expect(await contactsNamed(`list-${suffix}@news.example`)).toBe(0)
    expect(await contactsNamed(`noreply-${suffix}@shop.example`)).toBe(0)
    const row = await contactRow(map[human])
    expect(row.org_access).toBe("none")
    expect(row.owner_user_id).toBeNull()
    expect(row.acl_role_ids).toContain(`dim:mail:inbox=${SHARED_INBOX}`)
    // The org contact gains no grant: it is already everyone's.
    const grants = extractRows<{ n: number }>(
      await db.execute(drizzleSql`
        SELECT count(*)::int AS n FROM kernel.resource_grants
         WHERE resource_id = ${existingId}::uuid`),
    )
    expect(grants[0].n).toBe(0)
    // RLS: a member of the mailbox sees it; someone without access does not,
    // nor does someone with access to a different mailbox.
    expect(await visibleTo(otherId, [SHARED_INBOX], [map[human]])).toEqual([map[human]])
    expect(await visibleTo(otherId, [], [map[human]])).toEqual([])
    expect(await visibleTo(otherId, [PERSONAL_INBOX], [map[human]])).toEqual([])
    // Idempotent: the second page links to the contact the first one created.
    expect(await resolve("org", [{ email: human }])).toEqual({ [human]: map[human] })
    expect(await contactsNamed(human)).toBe(1)
  })

  it("stops auto-creating contacts once a mailbox reaches its daily cap", async () => {
    const key = bucketKey(`mail:auto-contacts:${SHARED_INBOX}:day`, 86_400)
    const now = Date.now()
    const members: string[] = []
    for (let i = 0; i < AUTO_CONTACTS_PER_MAILBOX_PER_DAY; i++)
      members.push(String(now), `${now}:${i}`)
    await redisBullMQ.zadd(key, ...members)
    try {
      const flooded = `flood-${suffix}@person.example`
      const map = await resolve("org", [{ email: flooded, name: "Flood" }])
      expect(map[flooded]).toBeUndefined()
      expect(await contactsNamed(flooded)).toBe(0)
    } finally {
      await redisBullMQ.del(key)
    }
  })

  it("a sender who wrote to a personal mailbox and a shared one is two separate contacts", async () => {
    const both = `both-${suffix}@person.example`
    const personal = await resolve("user", [{ email: both }])
    const shared = await resolve("org", [{ email: both }])
    // The shared mailbox never links (or leaks) the owner's private contact.
    expect(shared[both]).not.toBe(personal[both])
    expect((await contactRow(personal[both])).owner_user_id).toBe(ownerId)
    expect((await contactRow(shared[both])).owner_user_id).toBeNull()
  })

  it("two shared mailboxes keep their own contact for the same sender", async () => {
    const both = `twoboxes-${suffix}@person.example`
    const first = await resolve("org", [{ email: both }])
    const otherInbox = crypto.randomUUID()
    const second = await resolveSenderContacts(
      orgId,
      "system:mail:sync",
      { id: otherInbox, ownerType: "org", ownerId: null },
      [{ email: both }],
    )
    expect(second[both]).not.toBe(first[both])
    // Each is visible to its own mailbox's members only.
    expect(await visibleTo(otherId, [SHARED_INBOX], [first[both], second[both]])).toEqual([
      first[both],
    ])
    expect(await visibleTo(otherId, [otherInbox], [first[both], second[both]])).toEqual([
      second[both],
    ])
  })
})
