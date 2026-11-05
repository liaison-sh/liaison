// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Contact groups: named groups with hand-picked members (S15), stored as
// contact_segments of kind 'manual' beside the rule-based segments.
//
// Visibility is the database's: a member row is visible only when its contact
// is (migration 0124), so every list and count here is what the CALLER may see
// under their own RLS. Adding a contact the caller cannot see reports it as not
// found, exactly like reading it would; nobody learns a restricted contact is in
// a group.

import { and, asc, sql as drizzleSql, eq, inArray } from "drizzle-orm"
import { HTTPException } from "hono/http-exception"
import type { RlsClient, RlsTx } from "~/db"
import { contactGroupMembers, contactSegments, contacts } from "~/db/schema/kernel"
import { UUID_RE } from "~/lib/uuid"

type Db = RlsClient | RlsTx

/** Longest group name accepted, in characters. */
export const GROUP_NAME_MAX = 80
/** Most contacts one add or remove call takes. */
export const GROUP_MEMBERS_BATCH_MAX = 500

export interface ContactGroup {
  id: string
  name: string
  /** Members the caller can see. */
  memberCount: number
  createdBy: string | null
  createdAt: Date
}

function cleanName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, " ")
  if (name === "") throw new HTTPException(422, { message: "A group needs a name" })
  if (name.length > GROUP_NAME_MAX) {
    throw new HTTPException(422, {
      message: `A group name is at most ${GROUP_NAME_MAX} characters`,
    })
  }
  return name
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } }
  return (e?.code ?? e?.cause?.code) === "23505"
}

// Members the caller can see, per group: the subquery runs under the caller's
// RLS, which hides member rows whose contact they cannot see.
const visibleMemberCount = drizzleSql<number>`(
  SELECT count(*)::int FROM ${contactGroupMembers} m WHERE m.segment_id = ${contactSegments.id}
)`

const groupColumns = {
  id: contactSegments.id,
  name: contactSegments.name,
  memberCount: visibleMemberCount,
  createdBy: contactSegments.createdBy,
  createdAt: contactSegments.createdAt,
}

/** The org's manual group with this id. */
function isManualGroup(orgId: string, groupId: string) {
  return and(
    eq(contactSegments.id, groupId),
    eq(contactSegments.orgId, orgId),
    eq(contactSegments.kind, "manual"),
  )
}

async function nameTaken(db: Db, orgId: string, name: string, exceptId?: string) {
  const rows = await db
    .select({ id: contactSegments.id })
    .from(contactSegments)
    .where(
      and(
        eq(contactSegments.orgId, orgId),
        eq(contactSegments.kind, "manual"),
        drizzleSql`lower(${contactSegments.name}) = lower(${name})`,
        exceptId ? drizzleSql`${contactSegments.id} <> ${exceptId}::uuid` : undefined,
      ),
    )
    .limit(1)
  return rows.length > 0
}

function duplicateName(name: string): HTTPException {
  return new HTTPException(409, { message: `A group named "${name}" already exists` })
}

export async function listGroups(db: Db, params: { orgId: string }): Promise<ContactGroup[]> {
  return db
    .select(groupColumns)
    .from(contactSegments)
    .where(and(eq(contactSegments.orgId, params.orgId), eq(contactSegments.kind, "manual")))
    .orderBy(asc(drizzleSql`lower(${contactSegments.name})`))
}

/** One group by id, or null when there is no manual group with that id. */
export async function getGroup(
  db: Db,
  params: { orgId: string; groupId: string },
): Promise<ContactGroup | null> {
  if (!UUID_RE.test(params.groupId)) return null
  const [row] = await db
    .select(groupColumns)
    .from(contactSegments)
    .where(isManualGroup(params.orgId, params.groupId))
    .limit(1)
  return row ?? null
}

async function requireGroup(db: Db, orgId: string, groupId: string): Promise<ContactGroup> {
  const group = await getGroup(db, { orgId, groupId })
  if (!group) throw new HTTPException(404, { message: "Group not found" })
  return group
}

export async function createGroup(
  db: Db,
  params: { orgId: string; userId: string; name: string },
): Promise<ContactGroup> {
  const name = cleanName(params.name)
  if (await nameTaken(db, params.orgId, name)) throw duplicateName(name)
  const createdBy = UUID_RE.test(params.userId) ? params.userId : null
  try {
    const [row] = await db.transaction(async (sp) =>
      sp
        .insert(contactSegments)
        .values({ orgId: params.orgId, name, kind: "manual", filter: {}, createdBy })
        .returning(),
    )
    return {
      id: row.id,
      name: row.name,
      memberCount: 0,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
    }
  } catch (err) {
    // Another request created the same name between the check and the insert.
    if (isUniqueViolation(err)) throw duplicateName(name)
    throw err
  }
}

export async function renameGroup(
  db: Db,
  params: { orgId: string; groupId: string; name: string },
): Promise<ContactGroup> {
  await requireGroup(db, params.orgId, params.groupId)
  const name = cleanName(params.name)
  if (await nameTaken(db, params.orgId, name, params.groupId)) throw duplicateName(name)
  try {
    await db.transaction(async (sp) =>
      sp.update(contactSegments).set({ name }).where(isManualGroup(params.orgId, params.groupId)),
    )
  } catch (err) {
    if (isUniqueViolation(err)) throw duplicateName(name)
    throw err
  }
  return requireGroup(db, params.orgId, params.groupId)
}

/** Delete a group and its memberships (the contacts themselves are untouched). */
export async function deleteGroup(
  db: Db,
  params: { orgId: string; groupId: string },
): Promise<{ id: string; name: string } | null> {
  if (!UUID_RE.test(params.groupId)) return null
  const [row] = await db
    .delete(contactSegments)
    .where(isManualGroup(params.orgId, params.groupId))
    .returning({ id: contactSegments.id, name: contactSegments.name })
  return row ?? null
}

/**
 * Split a member batch into the ids the caller can see in the org and the rest
 * (unknown or invisible: reported as not found, never acted on).
 */
async function partitionVisible(
  db: Db,
  orgId: string,
  contactIds: string[],
): Promise<{ visible: string[]; notFound: string[] }> {
  const ids = [...new Set(contactIds)]
  if (ids.length === 0) throw new HTTPException(422, { message: "No contacts given" })
  if (ids.length > GROUP_MEMBERS_BATCH_MAX) {
    throw new HTTPException(422, {
      message: `At most ${GROUP_MEMBERS_BATCH_MAX} contacts per call`,
    })
  }
  const candidates = ids.filter((id) => UUID_RE.test(id))
  const rows =
    candidates.length === 0
      ? []
      : await db
          .select({ id: contacts.id })
          .from(contacts)
          .where(and(eq(contacts.orgId, orgId), inArray(contacts.id, candidates)))
  const visible = rows.map((r) => r.id)
  const visibleSet = new Set(visible)
  return { visible, notFound: ids.filter((id) => !visibleSet.has(id)) }
}

export interface GroupMembershipChange {
  groupId: string
  groupName: string
  /** Contacts this call changed. */
  changed: number
  /** Contacts that were already in (add) or already out of (remove) the group. */
  unchanged: number
  /** Ids the caller cannot see, or that do not exist. Nothing was done for them. */
  notFound: string[]
}

export async function addGroupMembers(
  db: Db,
  params: { orgId: string; userId: string; groupId: string; contactIds: string[] },
): Promise<GroupMembershipChange> {
  const group = await requireGroup(db, params.orgId, params.groupId)
  const { visible, notFound } = await partitionVisible(db, params.orgId, params.contactIds)
  let changed = 0
  if (visible.length > 0) {
    const addedBy = UUID_RE.test(params.userId) ? params.userId : null
    const inserted = await db
      .insert(contactGroupMembers)
      .values(
        visible.map((contactId) => ({
          segmentId: group.id,
          contactId,
          orgId: params.orgId,
          addedBy,
        })),
      )
      .onConflictDoNothing()
      .returning({ contactId: contactGroupMembers.contactId })
    changed = inserted.length
  }
  return {
    groupId: group.id,
    groupName: group.name,
    changed,
    unchanged: visible.length - changed,
    notFound,
  }
}

export async function removeGroupMembers(
  db: Db,
  params: { orgId: string; groupId: string; contactIds: string[] },
): Promise<GroupMembershipChange> {
  const group = await requireGroup(db, params.orgId, params.groupId)
  const { visible, notFound } = await partitionVisible(db, params.orgId, params.contactIds)
  let changed = 0
  if (visible.length > 0) {
    const removed = await db
      .delete(contactGroupMembers)
      .where(
        and(
          eq(contactGroupMembers.orgId, params.orgId),
          eq(contactGroupMembers.segmentId, group.id),
          inArray(contactGroupMembers.contactId, visible),
        ),
      )
      .returning({ contactId: contactGroupMembers.contactId })
    changed = removed.length
  }
  return {
    groupId: group.id,
    groupName: group.name,
    changed,
    unchanged: visible.length - changed,
    notFound,
  }
}

/** The group's members the caller can see, by name. */
export async function listGroupMembers(
  db: Db,
  params: { orgId: string; groupId: string; page?: number; limit?: number },
): Promise<{
  group: ContactGroup
  rows: Array<typeof contacts.$inferSelect>
  total: number
}> {
  const group = await requireGroup(db, params.orgId, params.groupId)
  const limit = Math.min(Math.max(1, Math.floor(params.limit ?? 50)), 200)
  const page = Math.max(1, Math.floor(params.page ?? 1))
  const rows = await db
    .select({ contact: contacts })
    .from(contactGroupMembers)
    .innerJoin(contacts, eq(contacts.id, contactGroupMembers.contactId))
    .where(
      and(eq(contactGroupMembers.orgId, params.orgId), eq(contactGroupMembers.segmentId, group.id)),
    )
    .orderBy(
      asc(drizzleSql`lower(coalesce(${contacts.name}, ${contacts.email}, ''))`),
      asc(contacts.id),
    )
    .limit(limit)
    .offset((page - 1) * limit)
  return { group, rows: rows.map((r) => r.contact), total: group.memberCount }
}

/** The ids of every group the caller can see `contactId` in. */
export async function groupsOfContact(
  db: Db,
  params: { orgId: string; contactId: string },
): Promise<Array<{ id: string; name: string }>> {
  if (!UUID_RE.test(params.contactId)) return []
  return db
    .select({ id: contactSegments.id, name: contactSegments.name })
    .from(contactGroupMembers)
    .innerJoin(contactSegments, eq(contactSegments.id, contactGroupMembers.segmentId))
    .where(
      and(
        eq(contactGroupMembers.orgId, params.orgId),
        eq(contactGroupMembers.contactId, params.contactId),
      ),
    )
    .orderBy(asc(drizzleSql`lower(${contactSegments.name})`))
}

/** SQL predicate: the contact row is a member of `groupId` (visible to the caller). */
export function memberOfGroupCondition(groupId: string) {
  return drizzleSql`EXISTS (
    SELECT 1 FROM ${contactGroupMembers} gm
     WHERE gm.segment_id = ${groupId}::uuid AND gm.contact_id = ${contacts.id}
  )`
}
