// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Private contacts, end to end through every surface that reads or links a
// contact (modules/sharing, migration 0117). User A owns a private contact P
// (found in A's own mail). Colleague B must not list, read, search, mention,
// link, merge, dedupe, export or data-subject-export it, nor change its
// sharing; only A may share it with the organisation or take it back. A shared
// mailbox's sender S is visible to exactly that mailbox's members.

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { exportContacts } from "~/apps/contacts/export"
import { createTicket } from "~/apps/tickets/create"
import { extractRows, type RlsClient } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withRlsContext } from "~/db/rls"
import * as searchClientModule from "~/infra/search/client"
import { getObjectBuffer } from "~/infra/storage/object-storage"
import {
  contactsMergePreflight,
  contactsSharePreflight,
  handleContactsExport,
  handleContactsFindDuplicates,
  handleContactsRead,
  handleContactsSearch,
  handleContactsShare,
} from "~/modules/agent/tools/contact-tools"
import { addGroupMembers, createGroup } from "~/modules/contacts/groups"
import {
  exportContactsToFile,
  findDuplicateClusters,
  getContact,
  listContacts,
  mergeContactsWithMailReferences,
  resolveContact,
} from "~/modules/contacts/service"
import { getContactSharing, setContactSharing } from "~/modules/contacts/sharing"
import { buildDataSubjectBundle } from "~/modules/export/data-subject-export-tool"
import { resolveSenderContacts } from "~/modules/mail/sender-contacts"
import { canManageSharing } from "~/modules/sharing/service"

const suffix = crypto.randomUUID().slice(0, 8)
const INBOX = crypto.randomUUID()
const READ = ["kernel:contacts:read", "kernel:contacts:write", "kernel:contacts:export"]
let orgId: string
let userA: string
let userB: string
let member: string
let privateId: string
let orgContactId: string
let sharedSenderId: string
const privateEmail = `dana-${suffix}@private.example`
const sharedEmail = `sam-${suffix}@customer.example`

function as<T>(
  userId: string,
  fn: (tx: RlsClient) => Promise<T>,
  dimensionGrants: Record<string, string[]> = {},
  scopes: string[] = READ,
): Promise<T> {
  return withRlsContext({ actorType: "user", userId, orgId, scopes, dimensionGrants }, (tx) =>
    fn(tx as unknown as RlsClient),
  )
}

async function visibleIds(userId: string, dims: Record<string, string[]> = {}): Promise<string[]> {
  return as(
    userId,
    async (tx) =>
      (await listContacts(tx, { orgId, page: 1, limit: 100, mode: "all" as never })).rows.map(
        (r: { id: string }) => r.id,
      ),
    dims,
  )
}

beforeAll(async () => {
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Private contacts', ${`private-contacts-${suffix}`}) RETURNING id`),
  )
  orgId = org.id
  const users = extractRows<{ id: string; name: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}, ${`a-${suffix}@corp.example`}, 'A', 'active', 'h', 1, 1),
             (gen_random_uuid(), ${orgId}, ${`b-${suffix}@corp.example`}, 'B', 'active', 'h', 1, 1),
             (gen_random_uuid(), ${orgId}, ${`m-${suffix}@corp.example`}, 'M', 'active', 'h', 1, 1)
      RETURNING id, name`),
  )
  userA = users.find((u) => u.name === "A")!.id
  userB = users.find((u) => u.name === "B")!.id
  member = users.find((u) => u.name === "M")!.id
  const { ensureAppsForOrg } = await import("~/modules/apps/init")
  await ensureAppsForOrg(orgId)

  // P: what A's own mail (or A's agent) discovers: private to A.
  privateId = (
    await as(userA, (tx) =>
      resolveContact(
        tx,
        orgId,
        userA,
        { email: privateEmail, name: `Dana Private ${suffix}` },
        { audience: "owner", ownerUserId: userA },
      ),
    )
  ).contact!.id
  // O: an organisation contact with the same name (a duplicate candidate).
  orgContactId = (
    await as(userA, (tx) =>
      resolveContact(
        tx,
        orgId,
        userA,
        { email: `dana-${suffix}@org.example`, name: `Dana Private ${suffix}` },
        { audience: "org" },
      ),
    )
  ).contact!.id
  // S: a shared mailbox's sender.
  const map = await resolveSenderContacts(
    orgId,
    "system:mail:sync",
    { id: INBOX, ownerType: "org", ownerId: null },
    [{ email: sharedEmail, name: `Sam Shared ${suffix}` }],
  )
  sharedSenderId = map[sharedEmail]
}, 120_000)

afterAll(async () => {
  await db.execute(drizzleSql`DELETE FROM app_tickets.tickets WHERE org_id = ${orgId}::uuid`)
  await db.execute(drizzleSql`DELETE FROM kernel.files WHERE org_id = ${orgId}::uuid`)
  await db.execute(drizzleSql`DELETE FROM kernel.contacts WHERE org_id = ${orgId}::uuid`)
  await db.execute(drizzleSql`DELETE FROM kernel.contact_segments WHERE org_id = ${orgId}::uuid`)
})

describe("a private contact stays its owner's on every surface", () => {
  it("list and read (API service and agent tools)", async () => {
    expect(await visibleIds(userA)).toContain(privateId)
    expect(await visibleIds(userB)).not.toContain(privateId)
    expect(await visibleIds(userB)).toContain(orgContactId)
    expect(await as(userB, (tx) => getContact(tx, { orgId, contactId: privateId }))).toBeNull()

    const ctxB = (tx: RlsClient) => ({ orgId, userId: userB, db: tx, scopes: READ })
    const read = (await as(userB, (tx) =>
      handleContactsRead({ contactId: privateId }, ctxB(tx)),
    )) as { error?: { code: string } }
    expect(read.error?.code).toBe("NOT_FOUND")
    const search = (await as(userB, (tx) =>
      handleContactsSearch({ query: `Dana Private ${suffix}` }, ctxB(tx)),
    )) as { contacts?: Array<{ id: string }>; items?: Array<{ id: string }> }
    const found = (search.contacts ?? search.items ?? []).map((c) => c.id)
    expect(found).toContain(orgContactId)
    expect(found).not.toContain(privateId)
  })

  it("duplicates, merge, export and data-subject export", async () => {
    const clusterIds = async (userId: string) =>
      (await as(userId, (tx) => findDuplicateClusters(tx, { orgId }))).clusters.flatMap((c) =>
        c.contacts.map((x: { id: string }) => x.id),
      )
    expect(await clusterIds(userA)).toContain(privateId)
    expect(await clusterIds(userB)).not.toContain(privateId)
    const dupB = (await as(userB, (tx) =>
      handleContactsFindDuplicates({}, { orgId, userId: userB, db: tx, scopes: READ }),
    )) as { clusters: Array<{ contacts: Array<{ id: string }> }> }
    expect(dupB.clusters.flatMap((c) => c.contacts.map((x) => x.id))).not.toContain(privateId)

    const preflight = (await contactsMergePreflight(
      { sourceId: privateId, targetId: orgContactId },
      { orgId, userId: userB },
    )) as { error?: { code: string } }
    expect(preflight.error?.code).toBe("NOT_FOUND")
    await expect(
      as(userB, (tx) =>
        mergeContactsWithMailReferences(tx, {
          orgId,
          userId: userB,
          sourceId: privateId,
          targetId: orgContactId,
        }),
      ),
    ).rejects.toMatchObject({ status: 404 })

    const exportAs = (userId: string) =>
      as(userId, (tx) =>
        exportContacts({ db: tx, orgId, userId } as never, "csv" as never, {} as never),
      ).then((out) => String((out as { body?: unknown }).body ?? out))
    expect(await exportAs(userA)).toContain(privateEmail)
    expect(await exportAs(userB)).not.toContain(privateEmail)

    const dsr = (await as(userB, (tx) =>
      buildDataSubjectBundle(privateId, { orgId, userId: userB, db: tx }),
    )) as { error?: { code: string } }
    expect(dsr.error?.code).toBe("NOT_FOUND")
  })

  it("a contact group export never reaches past the caller's contact visibility or read scope", async () => {
    // A's hand-picked group holds A's private contact P and the org contact O.
    const groupId = await as(userA, async (tx) => {
      const g = await createGroup(tx, { orgId, userId: userA, name: `Export group ${suffix}` })
      await addGroupMembers(tx, {
        orgId,
        userId: userA,
        groupId: g.id,
        contactIds: [privateId, orgContactId],
      })
      return g.id
    })
    const csvOf = async (fileId: string) => {
      const [f] = extractRows<{ storage_key: string }>(
        await db.execute(
          drizzleSql`SELECT storage_key FROM kernel.files WHERE id = ${fileId}::uuid`,
        ),
      )
      return (await getObjectBuffer(f.storage_key)).toString("utf8")
    }
    const exportAs = (userId: string, scopes: string[]) =>
      as(
        userId,
        (tx) =>
          exportContactsToFile(tx, { orgId, userId, scopes, format: "csv", segmentId: groupId }),
        {},
        scopes,
      )

    // Owner A with read + export: both members.
    const own = await csvOf((await exportAs(userA, READ)).fileId)
    expect(own).toContain(privateEmail)
    expect(own).toContain(`dana-${suffix}@org.example`)
    // Colleague B with read + export: O only, never A's private P.
    const colleague = await csvOf((await exportAs(userB, READ)).fileId)
    expect(colleague).toContain(`dana-${suffix}@org.example`)
    expect(colleague).not.toContain(privateEmail)

    // B holding export but NOT read: no export at all (service and agent tool path,
    // which is what an approved gated call executes with the approver's scopes).
    const EXPORT_ONLY = ["kernel:contacts:export"]
    await expect(exportAs(userB, EXPORT_ONLY)).rejects.toMatchObject({ status: 403 })
    const tool = (await as(
      userB,
      (tx) =>
        handleContactsExport(
          { segmentId: groupId },
          { orgId, userId: userB, db: tx, scopes: EXPORT_ONLY },
        ),
      {},
      EXPORT_ONLY,
    )) as { fileId?: string; error?: { code: string } }
    expect(tool.fileId).toBeUndefined()
    expect(tool.error?.code).toBe("FORBIDDEN")
    // Nor the whole directory.
    await expect(
      as(
        userB,
        (tx) =>
          exportContactsToFile(tx, { orgId, userId: userB, scopes: EXPORT_ONLY, format: "csv" }),
        {},
        EXPORT_ONLY,
      ),
    ).rejects.toMatchObject({ status: 403 })
  })

  it("a ticket never links it, by id or by address", async () => {
    const byId = (await as(userA, (tx) =>
      createTicket(
        tx as never,
        orgId,
        { subject: "x", channel: "manual", contactId: privateId } as never,
        { actorType: "user", userId: userA } as never,
      ),
    )) as { error?: { code: string } }
    expect(byId.error?.code).toBe("not_found")
  })

  it("mention autocomplete (search fallback) finds it for its owner only", async () => {
    const meili = spyOn(searchClientModule, "getMeili").mockReturnValue({
      index: () => ({ search: async () => ({ hits: [], estimatedTotalHits: 0 }) }),
    } as never)
    const index = spyOn(searchClientModule, "effectiveIndexName").mockReturnValue("test_index")
    try {
      const { mentionSearch } = await import("~/modules/search/service")
      const mention = (userId: string, q: string, dims: Record<string, string[]> = {}) =>
        mentionSearch({
          orgId,
          userId,
          scopes: READ,
          dimensionGrants: dims,
          q,
          limit: 10,
        }).then((hits) => hits.map((h) => h.id))
      expect(await mention(userA, `Dana Private ${suffix}`)).toContain(privateId)
      expect(await mention(userB, `Dana Private ${suffix}`)).not.toContain(privateId)
      expect(await mention(userB, `Dana Private ${suffix}`)).toContain(orgContactId)
      // An admin's dimension wildcard is no key to a private contact.
      expect(await mention(userB, `Dana Private ${suffix}`, { "*": ["*"] })).not.toContain(
        privateId,
      )
      // The shared mailbox's sender: its members, not everyone.
      expect(await mention(member, `Sam Shared ${suffix}`, { "mail:inbox": [INBOX] })).toContain(
        sharedSenderId,
      )
      expect(await mention(userB, `Sam Shared ${suffix}`)).not.toContain(sharedSenderId)
    } finally {
      meili.mockRestore()
      index.mockRestore()
    }
  })
})

describe("sharing is the owner's choice", () => {
  it("B can neither see nor change the sharing of A's contact; nobody but the owner manages", async () => {
    await expect(
      as(userB, (tx) =>
        setContactSharing(tx, {
          orgId,
          userId: userB,
          contactId: privateId,
          sharing: { orgAccess: "editor" },
        }),
      ),
    ).rejects.toMatchObject({ status: 404 })
    // An organisation contact B can edit is still not B's to take back.
    await expect(
      as(userB, (tx) =>
        setContactSharing(tx, {
          orgId,
          userId: userB,
          contactId: orgContactId,
          sharing: { orgAccess: "none" },
        }),
      ),
    ).rejects.toMatchObject({ status: 403 })
    // The database refuses it too, whatever the code path.
    await expect(
      as(userB, (tx) =>
        tx.execute(
          drizzleSql`UPDATE kernel.contacts SET org_access = 'none' WHERE id = ${orgContactId}::uuid`,
        ),
      ),
    ).rejects.toThrow()
    await expect(
      as(userA, (tx) =>
        tx.execute(
          drizzleSql`UPDATE kernel.contacts SET owner_user_id = ${userB}::uuid WHERE id = ${privateId}::uuid`,
        ),
      ),
    ).rejects.toThrow()
    // The gated agent tool refuses at staging, without an oracle for ids.
    expect(
      await as(userB, (tx) =>
        contactsSharePreflight(
          { contactId: privateId, orgAccess: "editor" },
          { orgId, userId: userB, db: tx },
        ),
      ),
    ).toMatchObject({ error: { code: "NOT_FOUND" } })
    expect(
      await as(userB, (tx) =>
        contactsSharePreflight(
          { contactId: orgContactId, orgAccess: "none" },
          { orgId, userId: userB, db: tx },
        ),
      ),
    ).toMatchObject({ error: { code: "FORBIDDEN" } })
    expect(
      await as(userA, (tx) =>
        contactsSharePreflight(
          { contactId: privateId, orgAccess: "editor" },
          { orgId, userId: userA, db: tx },
        ),
      ),
    ).toEqual({ ok: true })
  })

  it("A shares with the organisation, then takes it back; a team use blocks the take-back", async () => {
    const shared = (await as(userA, (tx) =>
      handleContactsShare(
        { contactId: privateId, orgAccess: "editor" },
        { orgId, userId: userA, db: tx, scopes: READ },
      ),
    )) as { orgAccess?: string }
    expect(shared.orgAccess).toBe("editor")
    expect(await visibleIds(userB)).toContain(privateId)
    const audit = extractRows<{ n: number }>(
      await db.execute(drizzleSql`
        SELECT count(*)::int AS n FROM kernel.pending_events
         WHERE org_id = ${orgId}::uuid AND payload->>'entity' = 'contact'
           AND payload->>'action' = 'share' AND payload->>'entityId' = ${privateId}`),
    )
    expect(audit[0].n).toBeGreaterThanOrEqual(1)

    await as(userA, (tx) =>
      setContactSharing(tx, {
        orgId,
        userId: userA,
        contactId: privateId,
        sharing: { orgAccess: "none" },
      }),
    )
    expect(await visibleIds(userB)).not.toContain(privateId)

    // Shared again, a ticket now uses it: taking it back would strand the team.
    await as(userA, (tx) =>
      setContactSharing(tx, {
        orgId,
        userId: userA,
        contactId: privateId,
        sharing: { orgAccess: "editor" },
      }),
    )
    await db.execute(drizzleSql`
      INSERT INTO app_tickets.tickets
        (org_id, handle, subject, status, priority, channel, reply_token, sla_target_seconds, contact_id)
      VALUES (${orgId}, ${`T-${suffix}`}, 's', 'open', 'normal', 'manual', ${`rt-${suffix}`}, 3600,
              ${privateId})`)
    await expect(
      as(userA, (tx) =>
        setContactSharing(tx, {
          orgId,
          userId: userA,
          contactId: privateId,
          sharing: { orgAccess: "none" },
        }),
      ),
    ).rejects.toMatchObject({ status: 409 })
    expect(await visibleIds(userB)).toContain(privateId)
  })

  it("a shared mailbox's sender: its members see and edit it, others do not; mail admins manage it", async () => {
    expect(await visibleIds(member, { "mail:inbox": [INBOX] })).toContain(sharedSenderId)
    expect(await visibleIds(userB)).not.toContain(sharedSenderId)
    expect(await visibleIds(userB, { "mail:inbox": [crypto.randomUUID()] })).not.toContain(
      sharedSenderId,
    )
    // Its members edit it; they do not re-share it. A mail admin does.
    expect(
      await as(member, (tx) => canManageSharing(tx, "kernel.contact", sharedSenderId), {
        "mail:inbox": [INBOX],
      }),
    ).toBe(false)
    expect(
      await as(
        member,
        (tx) => canManageSharing(tx, "kernel.contact", sharedSenderId),
        { "mail:inbox": [INBOX] },
        [...READ, "mail:accounts:admin"],
      ),
    ).toBe(true)
    const sharing = await as(
      member,
      (tx) => getContactSharing(tx, { orgId, contactId: sharedSenderId }),
      { "mail:inbox": [INBOX] },
    )
    expect(sharing.dimensions).toEqual([{ key: "mail:inbox", value: INBOX, role: "editor" }])
  })
})

describe("security review 2026-09-30", () => {
  it("#1 a merge needs edit rights on both contacts, and the owner's say to widen a private one", async () => {
    // A's private contact with a secret note, shared READ-ONLY with B.
    const secret = (
      await as(userA, (tx) =>
        resolveContact(
          tx,
          orgId,
          userA,
          { email: `secret-${suffix}@x.example`, externalId: { crm: "SECRET-NOTE" } },
          { audience: "owner", ownerUserId: userA },
        ),
      )
    ).contact!.id
    await as(userA, (tx) =>
      setContactSharing(tx, {
        orgId,
        userId: userA,
        contactId: secret,
        sharing: { orgAccess: "none", users: [{ userId: userB, role: "viewer" }] },
      }),
    )
    expect(await visibleIds(userB)).toContain(secret)
    const target = (
      await as(userB, (tx) =>
        resolveContact(
          tx,
          orgId,
          userB,
          { email: `target-${suffix}@x.example` },
          { audience: "org" },
        ),
      )
    ).contact!.id
    const mergeAs = (userId: string) =>
      as(userId, (tx) =>
        mergeContactsWithMailReferences(tx, { orgId, userId, sourceId: secret, targetId: target }),
      )
    await expect(mergeAs(userB)).rejects.toMatchObject({ status: 403 })
    // Nothing moved: the source survives, the target did not get the note.
    const [src] = extractRows<{ n: number }>(
      await db.execute(
        drizzleSql`SELECT count(*)::int AS n FROM kernel.contacts WHERE id = ${secret}::uuid`,
      ),
    )
    expect(src.n).toBe(1)
    const [tgt] = extractRows<{ external_ids: Record<string, string> }>(
      await db.execute(
        drizzleSql`SELECT external_ids FROM kernel.contacts WHERE id = ${target}::uuid`,
      ),
    )
    expect(tgt.external_ids.crm).toBeUndefined()

    // An EDITOR grant lets B edit it, still not widen it to the organisation.
    await as(userA, (tx) =>
      setContactSharing(tx, {
        orgId,
        userId: userA,
        contactId: secret,
        sharing: { orgAccess: "none", users: [{ userId: userB, role: "editor" }] },
      }),
    )
    await expect(mergeAs(userB)).rejects.toMatchObject({ status: 403 })
    // Its owner may (merging into an org contact is a share).
    const merged = await mergeAs(userA)
    expect(merged.contact.id).toBe(target)
  })

  it("merging two private contacts with the same audience is not a share: an editor may do it", async () => {
    // Two of A's own contacts, both shared with B as editor. Merging one into
    // the other shows the data to nobody new, so B's editor grant is enough
    // (an agent acting on an approved merge is in the same position: it edits,
    // it never manages sharing). A grant on the target the source does not
    // carry WOULD widen it, and stays the owner's call.
    const mk = async (tag: string) =>
      (
        await as(userA, (tx) =>
          resolveContact(
            tx,
            orgId,
            userA,
            { email: `same-aud-${tag}-${suffix}@x.example` },
            { audience: "owner", ownerUserId: userA },
          ),
        )
      ).contact!.id
    const share = (
      contactId: string,
      users: Array<{ userId: string; role: "viewer" | "editor" }>,
    ) =>
      as(userA, (tx) =>
        setContactSharing(tx, {
          orgId,
          userId: userA,
          contactId,
          sharing: { orgAccess: "none", users },
        }),
      )
    const source = await mk("src")
    const target = await mk("tgt")
    await share(source, [{ userId: userB, role: "editor" }])
    await share(target, [
      { userId: userB, role: "editor" },
      { userId: member, role: "viewer" },
    ])
    const mergeAs = (userId: string) =>
      as(userId, (tx) =>
        mergeContactsWithMailReferences(tx, { orgId, userId, sourceId: source, targetId: target }),
      )
    // The target is also visible to `member`: merging widens the source.
    await expect(mergeAs(userB)).rejects.toMatchObject({ status: 403 })
    // Same audience on both: B merges.
    await share(target, [{ userId: userB, role: "editor" }])
    const merged = await mergeAs(userB)
    expect(merged.contact.id).toBe(target)
  })

  it("#3 a shared mailbox never reuses another mailbox's contact; its own grant cannot be stripped", async () => {
    const other = crypto.randomUUID()
    const map = await resolveSenderContacts(
      orgId,
      "system:mail:sync",
      { id: other, ownerType: "org", ownerId: null },
      [{ email: sharedEmail }],
    )
    expect(map[sharedEmail]).toBeDefined()
    expect(map[sharedEmail]).not.toBe(sharedSenderId)
    expect(await visibleIds(member, { "mail:inbox": [INBOX] })).not.toContain(map[sharedEmail])
    // A mail admin re-shares INBOX's contact; its mailbox grant stays.
    const after = await as(
      member,
      (tx) =>
        setContactSharing(tx, {
          orgId,
          userId: member,
          contactId: sharedSenderId,
          sharing: {
            orgAccess: "none",
            dimensions: [],
            users: [{ userId: userB, role: "viewer" }],
          },
        }),
      { "mail:inbox": [INBOX] },
      [...READ, "mail:accounts:admin"],
    )
    expect(after.dimensions).toEqual([{ key: "mail:inbox", value: INBOX, role: "editor" }])
    expect(after.users).toEqual([{ userId: userB, role: "viewer" }])
  })

  it("#4 the search ACL is derived: an RLS caller cannot write it, on contacts or documents", async () => {
    await expect(
      as(userA, (tx) =>
        tx.execute(
          drizzleSql`UPDATE kernel.contacts SET acl_user_ids = ${JSON.stringify([userB])}::jsonb WHERE id = ${privateId}::uuid`,
        ),
      ),
    ).rejects.toThrow()
    const forged = await as(userA, async (tx) =>
      extractRows<{ acl: string[] }>(
        await tx.execute(drizzleSql`
          INSERT INTO kernel.contacts (org_id, handle, email, org_access, owner_user_id, acl_user_ids)
          VALUES (${orgId}, ${`@forged-${suffix}`}, ${`forged-${suffix}@x.example`}, 'none', ${userA},
                  ${JSON.stringify([userB])}::jsonb)
          RETURNING acl_user_ids AS acl`),
      ),
    )
    expect(forged[0].acl).toEqual([])
  })

  it("#5 grants are read only with the resource; nobody creates a contact owned by someone else", async () => {
    const grantRows = (userId: string, dims: Record<string, string[]>) =>
      as(
        userId,
        async (tx) =>
          extractRows(
            await tx.execute(
              drizzleSql`SELECT 1 FROM kernel.resource_grants WHERE resource_id = ${sharedSenderId}::uuid`,
            ),
          ).length,
        dims,
      )
    expect(await grantRows(member, {})).toBe(0) // no access to that mailbox: no grants either
    expect(await grantRows(member, { "mail:inbox": [INBOX] })).toBeGreaterThan(0)
    await expect(
      as(userB, (tx) =>
        tx.execute(drizzleSql`
          INSERT INTO kernel.contacts (org_id, handle, email, org_access, owner_user_id)
          VALUES (${orgId}, ${`@owned-by-a-${suffix}`}, ${`o-${suffix}@x.example`}, 'editor', ${userA})`),
      ),
    ).rejects.toThrow()
  })

  it("re-review #1: nobody plants a contact in a mailbox's audience, and a merge moves only what the caller may edit", async () => {
    const victimInbox = crypto.randomUUID()
    const planted = `planted-${suffix}@x.example`
    // B tries to pose as mailbox M's contact for an address.
    const [row] = await as(userB, async (tx) =>
      extractRows<{ id: string; audience_key: string | null }>(
        await tx.execute(drizzleSql`
          INSERT INTO kernel.contacts (org_id, handle, email, org_access, owner_user_id, audience_key)
          VALUES (${orgId}, ${`@planted-${suffix}`}, ${planted}, 'none', ${userB},
                  ${`mail:inbox=${victimInbox}`})
          RETURNING id::text AS id, audience_key`),
      ),
    )
    expect(row.audience_key).toBeNull()
    const map = await resolveSenderContacts(
      orgId,
      "system:mail:sync",
      { id: victimInbox, ownerType: "org", ownerId: null },
      [{ email: planted }],
    )
    expect(map[planted]).toBeDefined()
    expect(map[planted]).not.toBe(row.id)

    // Even linked by force to one of M's conversations, B's contact cannot be
    // merged by B: B cannot edit that conversation, so nothing is re-pointed.
    const [acct] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        INSERT INTO app_mail.accounts (org_id, connected_account_id, owner_type, provider, email_address, sync_status)
        VALUES (${orgId}, gen_random_uuid(), 'org', 'gmail', ${`m-${suffix}@corp.example`}, 'active')
        RETURNING id::text AS id`),
    )
    const [conv] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        INSERT INTO app_mail.conversations
          (org_id, account_id, owner_type, external_thread_id, status, from_email, contact_id, message_count)
        VALUES (${orgId}, ${acct.id}, 'org', ${`t-${suffix}`}, 'open', ${planted}, ${row.id}, 1)
        RETURNING id::text AS id`),
    )
    await expect(
      as(userB, (tx) =>
        mergeContactsWithMailReferences(tx, {
          orgId,
          userId: userB,
          sourceId: row.id,
          targetId: orgContactId,
        }),
      ),
    ).rejects.toMatchObject({ status: 409 })
    const [still] = extractRows<{ contact_id: string }>(
      await db.execute(
        drizzleSql`SELECT contact_id::text AS contact_id FROM app_mail.conversations WHERE id = ${conv.id}::uuid`,
      ),
    )
    expect(still.contact_id).toBe(row.id)
  })
})
