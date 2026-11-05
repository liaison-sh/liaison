// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Contacts in the generic sharing model (modules/sharing, migration 0117).
//
// A contact has an owner and an ACL like any shareable resource. Reading its
// sharing needs only read access (as in Drive, whoever sees it may see who
// else does); changing it needs `kernel.can_manage_sharing`: the owner, or for
// a contact nobody owns, a contacts admin (kernel:contacts:admin) or, for a
// shared mailbox's contact, a mail admin. Editors edit, they never re-share.
// A mailbox's or team's contact keeps its grant to that audience. The
// database enforces all of it (RLS, the grants table's
// write policy, the contacts sharing guard); this module only shapes the call
// and turns a refusal into a 403 before any write.
//
// "Share with the organisation" is `orgAccess: 'editor'`; taking it back is
// `orgAccess: 'none'`, which only the contact's owner (whoever it belonged to)
// may do, and only while no team object (ticket, invoice, another mailbox's
// conversation: modules/contacts/references.ts) uses it. Every change is announced as `contact:share` (audited, reindexed).

import { and, eq } from "drizzle-orm"
import { HTTPException } from "hono/http-exception"
import type { RlsClient } from "~/db"
import { contacts } from "~/db/schema/kernel"
import { pruneContactDiscussion } from "~/modules/contacts/discussion"
import { countTeamReferences } from "~/modules/contacts/references"
import {
  canManageSharing,
  listGrants,
  type OrgAccess,
  type ResourceGrants,
  recomputeSearchAcl,
  replaceGrants,
} from "~/modules/sharing/service"

export const CONTACT_RESOURCE = "kernel.contact"

export interface ContactSharing extends ResourceGrants {
  orgAccess: OrgAccess
  ownerUserId: string | null
  canManage: boolean
}

export interface ContactSharingInput extends Partial<ResourceGrants> {
  orgAccess: OrgAccess
}

async function loadVisible(tx: RlsClient, orgId: string, contactId: string) {
  const [row] = await tx
    .select({
      id: contacts.id,
      orgAccess: contacts.orgAccess,
      ownerUserId: contacts.ownerUserId,
      audienceKey: contacts.audienceKey,
    })
    .from(contacts)
    .where(and(eq(contacts.id, contactId), eq(contacts.orgId, orgId)))
    .limit(1)
  if (!row) throw new HTTPException(404, { message: "Contact not found" })
  return row
}

export async function getContactSharing(
  tx: RlsClient,
  params: { orgId: string; contactId: string },
): Promise<ContactSharing> {
  const row = await loadVisible(tx, params.orgId, params.contactId)
  return {
    orgAccess: row.orgAccess,
    ownerUserId: row.ownerUserId,
    canManage: await canManageSharing(tx, CONTACT_RESOURCE, row.id),
    ...(await listGrants(tx, CONTACT_RESOURCE, row.id)),
  }
}

export async function setContactSharing(
  tx: RlsClient,
  params: { orgId: string; userId: string; contactId: string; sharing: ContactSharingInput },
): Promise<ContactSharing> {
  const row = await loadVisible(tx, params.orgId, params.contactId)
  if (!(await canManageSharing(tx, CONTACT_RESOURCE, row.id))) {
    throw new HTTPException(403, {
      message:
        "Only the contact's owner (or, for a contact nobody owns, an admin) can change who it is shared with",
    })
  }
  const { orgAccess, users, roles, dimensions } = params.sharing
  if (orgAccess === "none" && row.orgAccess !== "none") {
    // Taking it back must not strand team work on a record the team can no
    // longer read.
    const refs = await countTeamReferences(tx, params.orgId, row.id)
    const used = Object.entries(refs).map(([kind, n]) => `${n} ${kind}`)
    if (used.length > 0) {
      throw new HTTPException(409, {
        message: `This contact is used by the team (${used.join(", ")}): it stays shared with the organisation`,
      })
    }
  }
  if (orgAccess !== row.orgAccess) {
    try {
      await tx.transaction(async (sp) => {
        await sp
          .update(contacts)
          .set({ orgAccess, updatedAt: new Date() })
          .where(and(eq(contacts.id, row.id), eq(contacts.orgId, params.orgId)))
      })
    } catch (err: any) {
      if ((err.code ?? err.cause?.code) === "23505") {
        // Org-visible contacts are unique per address.
        throw new HTTPException(409, {
          message:
            "The organisation already has a contact with this address: merge into it instead",
        })
      }
      throw err
    }
  }
  await replaceGrants(
    tx,
    { orgId: params.orgId, userId: params.userId },
    CONTACT_RESOURCE,
    row.id,
    { users, roles, dimensions },
    // A mailbox's or team's contact stays shared with that audience.
    row.audienceKey ? [{ kind: "dimension", grantee: row.audienceKey }] : [],
  )
  await tx.queueEvent({
    app: "kernel",
    entity: "contact",
    action: "share",
    entityId: row.id,
    orgId: params.orgId,
    actorId: params.userId,
    actorType: "user",
    data: {
      id: row.id,
      orgAccess,
      previousOrgAccess: row.orgAccess,
      userCount: users?.length ?? null,
      roleCount: roles?.length ?? null,
      dimensionCount: dimensions?.length ?? null,
    },
  })
  // Its discussion follows who sees it: everyone enrolled so far re-enrols by
  // opening it again, which only someone who still sees the contact can do.
  await pruneContactDiscussion({
    orgId: params.orgId,
    contactId: row.id,
    keepUserId: params.userId,
  })
  return getContactSharing(tx, params)
}

/**
 * Kernel-side change of a contact's owner and general access, for reviewed
 * maintenance (the privatize and provenance CLIs), in a privileged
 * transaction pinned to the org: no person's RLS applies, so the caller has
 * already decided. Refreshes the search ACL and announces `contact:share`
 * (audited, reindexed) with the previous state.
 */
export async function assignContactSharingAsKernel(
  tx: RlsClient,
  params: {
    orgId: string
    contactId: string
    ownerUserId: string | null
    orgAccess: OrgAccess
    actorId: string | null
    reason: string
  },
): Promise<{ previousOwnerUserId: string | null; previousOrgAccess: OrgAccess } | null> {
  const [before] = await tx
    .select({ ownerUserId: contacts.ownerUserId, orgAccess: contacts.orgAccess })
    .from(contacts)
    .where(and(eq(contacts.id, params.contactId), eq(contacts.orgId, params.orgId)))
    .limit(1)
  if (!before) return null
  await tx
    .update(contacts)
    .set({ ownerUserId: params.ownerUserId, orgAccess: params.orgAccess, updatedAt: new Date() })
    .where(and(eq(contacts.id, params.contactId), eq(contacts.orgId, params.orgId)))
  await recomputeSearchAcl(tx, CONTACT_RESOURCE, params.contactId)
  await tx.queueEvent({
    app: "kernel",
    entity: "contact",
    action: "share",
    entityId: params.contactId,
    orgId: params.orgId,
    actorId: params.actorId,
    actorType: params.actorId ? "user" : "system",
    data: {
      id: params.contactId,
      orgAccess: params.orgAccess,
      previousOrgAccess: before.orgAccess,
      ownerUserId: params.ownerUserId,
      previousOwnerUserId: before.ownerUserId,
      reason: params.reason,
    },
  })
  // Already privileged (no person's RLS applies): the same transaction.
  await pruneContactDiscussion(
    { orgId: params.orgId, contactId: params.contactId, keepUserId: params.ownerUserId },
    tx,
  )
  return { previousOwnerUserId: before.ownerUserId, previousOrgAccess: before.orgAccess }
}
