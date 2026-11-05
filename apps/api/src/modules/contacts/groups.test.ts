// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Contact groups (S15): named groups with hand-picked members, under the
// caller's own RLS. The member table's policy (migration 0124) shows a row only
// when its contact is visible to the reader, so a private contact never shows
// up as somebody else's group member, in a list, a count or a filter.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { sql as dsql } from "drizzle-orm"
import { sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import {
  addGroupMembers,
  createGroup,
  deleteGroup,
  groupsOfContact,
  listGroupMembers,
  listGroups,
  removeGroupMembers,
  renameGroup,
} from "~/modules/contacts/groups"
import {
  createSegment,
  evaluateSegment,
  listContacts,
  mergeContacts,
} from "~/modules/contacts/service"

const ORG = "00000000-0000-4000-8000-00000000c601"
const OWNER = "00000000-0000-4000-8000-00000000c602"
const OTHER = "00000000-0000-4000-8000-00000000c603"
const PRIVATE_CONTACT = "00000000-0000-4000-8000-00000000c604"
const ORG_CONTACT = "00000000-0000-4000-8000-00000000c605"
const ORG_CONTACT_2 = "00000000-0000-4000-8000-00000000c606"
const MISSING = "00000000-0000-4000-8000-00000000c6ff"

const SCOPES = ["kernel:contacts:read", "kernel:contacts:write"]

function as(userId: string): UserContext {
  return { actorType: "user", userId, orgId: ORG, scopes: SCOPES, dimensionGrants: {} }
}

async function asUser<T>(userId: string, fn: (db: any) => Promise<T>): Promise<T> {
  return withRlsContext(as(userId), fn)
}

async function cleanup() {
  await sql`DELETE FROM kernel.contact_group_members WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.contact_segments WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.contacts WHERE org_id = ${ORG}`
}

beforeAll(async () => {
  // listContacts folds mail (and invoicing) activity into each row. A deployment
  // grants the RLS role those tables at app install; a bare test database may
  // carry them without the grant, so grant what exists.
  await sql.unsafe(`DO $$ BEGIN
    IF to_regclass('app_mail.conversations') IS NOT NULL THEN
      GRANT USAGE ON SCHEMA app_mail TO liaison_rls;
      GRANT SELECT ON app_mail.conversations TO liaison_rls;
    END IF;
    IF to_regclass('app_invoicing.documents') IS NOT NULL THEN
      GRANT USAGE ON SCHEMA app_invoicing TO liaison_rls;
      GRANT SELECT ON app_invoicing.documents TO liaison_rls;
    END IF;
  END $$`)
  await sql`INSERT INTO kernel.organizations (id, name, slug)
    VALUES (${ORG}, 'Contact Groups Org', 'contact-groups-org') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES
    (${OWNER}, ${ORG}, 'groups-owner@test.com', 'Owner'),
    (${OTHER}, ${ORG}, 'groups-other@test.com', 'Other')
    ON CONFLICT DO NOTHING`
})

beforeEach(async () => {
  await cleanup()
  // A private contact of OWNER (org_access 'none'), two org-wide contacts.
  await sql`INSERT INTO kernel.contacts (id, org_id, handle, name, email, owner_user_id, org_access) VALUES
    (${PRIVATE_CONTACT}, ${ORG}, '@grp-private', 'Priya Private', 'priya@private.test', ${OWNER}, 'none'),
    (${ORG_CONTACT}, ${ORG}, '@grp-org', 'Olga Org', 'olga@org.test', NULL, 'editor'),
    (${ORG_CONTACT_2}, ${ORG}, '@grp-org2', 'Noreply Org', 'noreply@org.test', NULL, 'editor')`
})

afterAll(async () => {
  await cleanup()
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
})

describe("contact groups: service", () => {
  it("creates, lists, renames and deletes a group; names are unique ignoring case", async () => {
    const group = await asUser(OWNER, (db) =>
      createGroup(db, { orgId: ORG, userId: OWNER, name: "  VIP   dealers " }),
    )
    expect(group.name).toBe("VIP dealers")
    expect(group.memberCount).toBe(0)

    await expect(
      asUser(OTHER, (db) => createGroup(db, { orgId: ORG, userId: OTHER, name: "vip DEALERS" })),
    ).rejects.toMatchObject({ status: 409 })

    // A rule segment is not a group: it is not listed.
    await asUser(OWNER, (db) =>
      createSegment(db, { orgId: ORG, userId: OWNER, name: "Rule", filter: { tag: "x" } }),
    )
    const listed = await asUser(OTHER, (db) => listGroups(db, { orgId: ORG }))
    expect(listed.map((g) => g.name)).toEqual(["VIP dealers"])

    const renamed = await asUser(OTHER, (db) =>
      renameGroup(db, { orgId: ORG, groupId: group.id, name: "Key accounts" }),
    )
    expect(renamed.name).toBe("Key accounts")

    const deleted = await asUser(OTHER, (db) => deleteGroup(db, { orgId: ORG, groupId: group.id }))
    expect(deleted?.id).toBe(group.id)
    expect(await asUser(OWNER, (db) => listGroups(db, { orgId: ORG }))).toEqual([])
  })

  it("adds and removes members, reporting already-members and ids it cannot see", async () => {
    const group = await asUser(OWNER, (db) =>
      createGroup(db, { orgId: ORG, userId: OWNER, name: "Prospects" }),
    )
    const added = await asUser(OWNER, (db) =>
      addGroupMembers(db, {
        orgId: ORG,
        userId: OWNER,
        groupId: group.id,
        contactIds: [ORG_CONTACT, PRIVATE_CONTACT, MISSING],
      }),
    )
    expect(added).toMatchObject({ changed: 2, unchanged: 0, notFound: [MISSING] })
    const again = await asUser(OWNER, (db) =>
      addGroupMembers(db, {
        orgId: ORG,
        userId: OWNER,
        groupId: group.id,
        contactIds: [ORG_CONTACT],
      }),
    )
    expect(again).toMatchObject({ changed: 0, unchanged: 1, notFound: [] })

    const removed = await asUser(OWNER, (db) =>
      removeGroupMembers(db, {
        orgId: ORG,
        groupId: group.id,
        contactIds: [ORG_CONTACT, ORG_CONTACT_2],
      }),
    )
    expect(removed).toMatchObject({ changed: 1, unchanged: 1, notFound: [] })
    const members = await asUser(OWNER, (db) =>
      listGroupMembers(db, { orgId: ORG, groupId: group.id }),
    )
    expect(members.rows.map((c) => c.id)).toEqual([PRIVATE_CONTACT])
  })

  it("a rule segment takes no members, and an unknown group is a 404", async () => {
    const rule = await asUser(OWNER, (db) =>
      createSegment(db, { orgId: ORG, userId: OWNER, name: "Rule", filter: { tag: "x" } }),
    )
    await expect(
      asUser(OWNER, (db) =>
        addGroupMembers(db, {
          orgId: ORG,
          userId: OWNER,
          groupId: rule.id,
          contactIds: [ORG_CONTACT],
        }),
      ),
    ).rejects.toMatchObject({ status: 404 })
    await expect(
      asUser(OWNER, (db) => listGroupMembers(db, { orgId: ORG, groupId: MISSING })),
    ).rejects.toMatchObject({ status: 404 })
  })

  it("evaluateSegment of a group is its members; listContacts filters by group, automated senders included", async () => {
    const group = await asUser(OWNER, (db) =>
      createGroup(db, { orgId: ORG, userId: OWNER, name: "Newsletter" }),
    )
    await asUser(OWNER, (db) =>
      addGroupMembers(db, {
        orgId: ORG,
        userId: OWNER,
        groupId: group.id,
        contactIds: [ORG_CONTACT, ORG_CONTACT_2],
      }),
    )
    const evaluated = await asUser(OWNER, (db) =>
      evaluateSegment(db, { orgId: ORG, segmentId: group.id }),
    )
    expect(evaluated.map((c) => c.id).sort()).toEqual([ORG_CONTACT, ORG_CONTACT_2].sort())

    const filtered = await asUser(OWNER, (db) =>
      listContacts(db, { orgId: ORG, page: 1, limit: 50, groupId: group.id }),
    )
    // noreply@ is an automated sender, hidden from the default "people" list but
    // hand-picked into this group, so the group filter shows it.
    expect(filtered.rows.map((c) => c.id).sort()).toEqual([ORG_CONTACT, ORG_CONTACT_2].sort())
    expect(filtered.total).toBe(2)
  })

  it("a merge carries the source's group memberships onto the survivor", async () => {
    const group = await asUser(OWNER, (db) =>
      createGroup(db, { orgId: ORG, userId: OWNER, name: "Merged" }),
    )
    await asUser(OWNER, (db) =>
      addGroupMembers(db, {
        orgId: ORG,
        userId: OWNER,
        groupId: group.id,
        contactIds: [ORG_CONTACT_2],
      }),
    )
    await asUser(OWNER, (db) =>
      mergeContacts(db, {
        orgId: ORG,
        userId: OWNER,
        sourceId: ORG_CONTACT_2,
        targetId: ORG_CONTACT,
      }),
    )
    const members = await asUser(OWNER, (db) =>
      listGroupMembers(db, { orgId: ORG, groupId: group.id }),
    )
    expect(members.rows.map((c) => c.id)).toEqual([ORG_CONTACT])
  })
})

describe("contact groups: RLS, a member is visible only when its contact is", () => {
  it("another user does not see a private contact as a member: not listed, not counted, not filtered", async () => {
    const group = await asUser(OWNER, (db) =>
      createGroup(db, { orgId: ORG, userId: OWNER, name: "Mixed" }),
    )
    await asUser(OWNER, (db) =>
      addGroupMembers(db, {
        orgId: ORG,
        userId: OWNER,
        groupId: group.id,
        contactIds: [PRIVATE_CONTACT, ORG_CONTACT],
      }),
    )

    const ownerView = await asUser(OWNER, (db) =>
      listGroupMembers(db, { orgId: ORG, groupId: group.id }),
    )
    expect(ownerView.rows.map((c) => c.id).sort()).toEqual([PRIVATE_CONTACT, ORG_CONTACT].sort())
    expect(ownerView.total).toBe(2)

    const otherView = await asUser(OTHER, (db) =>
      listGroupMembers(db, { orgId: ORG, groupId: group.id }),
    )
    expect(otherView.rows.map((c) => c.id)).toEqual([ORG_CONTACT])
    expect(otherView.total).toBe(1)
    const otherGroups = await asUser(OTHER, (db) => listGroups(db, { orgId: ORG }))
    expect(otherGroups[0]?.memberCount).toBe(1)

    // The member rows themselves, read straight from the table under OTHER's RLS.
    const rawRows = await asUser(OTHER, (db) =>
      db.execute(
        dsql`SELECT contact_id::text FROM kernel.contact_group_members WHERE org_id = ${ORG}`,
      ),
    )
    const rawIds = (Array.isArray(rawRows) ? rawRows : (rawRows as any).rows).map(
      (r: { contact_id: string }) => r.contact_id,
    )
    expect(rawIds).toEqual([ORG_CONTACT])

    const filtered = await asUser(OTHER, (db) =>
      listContacts(db, { orgId: ORG, page: 1, limit: 50, groupId: group.id }),
    )
    expect(filtered.rows.map((c) => c.id)).toEqual([ORG_CONTACT])
    const evaluated = await asUser(OTHER, (db) =>
      evaluateSegment(db, { orgId: ORG, segmentId: group.id }),
    )
    expect(evaluated.map((c) => c.id)).toEqual([ORG_CONTACT])

    // Nor which groups that contact is in.
    expect(
      await asUser(OTHER, (db) => groupsOfContact(db, { orgId: ORG, contactId: PRIVATE_CONTACT })),
    ).toEqual([])
    expect(
      (
        await asUser(OWNER, (db) => groupsOfContact(db, { orgId: ORG, contactId: PRIVATE_CONTACT }))
      ).map((g) => g.name),
    ).toEqual(["Mixed"])
  })

  it("another user can neither add nor remove a contact they cannot see", async () => {
    const group = await asUser(OWNER, (db) =>
      createGroup(db, { orgId: ORG, userId: OWNER, name: "Guarded" }),
    )
    await asUser(OWNER, (db) =>
      addGroupMembers(db, {
        orgId: ORG,
        userId: OWNER,
        groupId: group.id,
        contactIds: [PRIVATE_CONTACT],
      }),
    )

    const removed = await asUser(OTHER, (db) =>
      removeGroupMembers(db, { orgId: ORG, groupId: group.id, contactIds: [PRIVATE_CONTACT] }),
    )
    expect(removed).toMatchObject({ changed: 0, notFound: [PRIVATE_CONTACT] })
    const added = await asUser(OTHER, (db) =>
      addGroupMembers(db, {
        orgId: ORG,
        userId: OTHER,
        groupId: group.id,
        contactIds: [PRIVATE_CONTACT],
      }),
    )
    expect(added).toMatchObject({ changed: 0, notFound: [PRIVATE_CONTACT] })

    // The policy holds even when the service is bypassed.
    await expect(
      asUser(OTHER, (db) =>
        db.execute(dsql`INSERT INTO kernel.contact_group_members (segment_id, contact_id, org_id)
          VALUES (${group.id}::uuid, ${PRIVATE_CONTACT}::uuid, ${ORG}::uuid)`),
      ),
    ).rejects.toThrow()
    await asUser(OTHER, (db) =>
      db.execute(
        dsql`DELETE FROM kernel.contact_group_members WHERE contact_id = ${PRIVATE_CONTACT}::uuid`,
      ),
    )
    const ownerView = await asUser(OWNER, (db) =>
      listGroupMembers(db, { orgId: ORG, groupId: group.id }),
    )
    expect(ownerView.rows.map((c) => c.id)).toEqual([PRIVATE_CONTACT])
  })
})
