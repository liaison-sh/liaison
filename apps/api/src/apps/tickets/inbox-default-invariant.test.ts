// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Invariant (migration 0046): an org that has at least one eligible inbox
// (kind = 'mailbox' AND archived_at IS NULL) always has exactly one live
// default (is_default_for_create = true AND archived_at IS NULL). Multiple
// independent writers can otherwise drive an org to zero live defaults --
// archiving the default, or creating the org's first mailbox inbox alongside
// an existing api-kind inbox (an api inbox can never be default) -- and the
// public ticket webhook rejects every api-keyed submission with 422
// inbox_required when that happens. Proves: the deferred constraint trigger
// heals both broken-state shapes, the inboxesUpdate explicit-clear guard
// (default_inbox_required), the isDefaultForCreate: undefined no-op bug, and
// that setting a different inbox as default still moves the flag atomically.

import { describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { runAdminOp } from "~/apps/tickets/admin"
import { extractRows } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { ensureAppsForOrg } from "~/modules/apps/init"

const rows = (r: unknown): any[] => (r as any).rows ?? r

// Each test case gets its own org (and its own user, since kernel.users.id is
// a global PK and can't be reused across orgs): the invariant is org-scoped,
// and tests that mutate the default across a whole org would otherwise
// interfere with each other if they shared one.
async function setupOrg(): Promise<{ orgId: string; userId: string }> {
  const slug = `idi-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const { orgId, userId } = await withSystemDb("inbox-default-invariant-org-setup", async (tx) => {
    const orgId = rows(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.organizations (id, name, slug)
        VALUES (gen_random_uuid(), 'Inbox Default Invariant Org', ${slug}) RETURNING id`),
    )[0].id
    const userId = rows(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${orgId}, ${`u-${slug}@x.test`}, 'A', 'active', 'h', 1, 1)
        RETURNING id`),
    )[0].id
    return { orgId, userId }
  })
  await ensureAppsForOrg(orgId, {})
  return { orgId, userId }
}

function admin(orgId: string, userId: string, op: string, params: Record<string, unknown>) {
  return withPrivilegedDb(orgId, "inbox-default-invariant-test", (tx) =>
    runAdminOp(tx as never, orgId, op, params, { actorType: "user" as const, userId }),
  )
}

async function createMailboxAccount(orgId: string, userId: string, email: string): Promise<string> {
  return withSystemDb("inbox-default-invariant-account", async (tx) => {
    const id = rows(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.connected_accounts
          (id, org_id, app_name, connection_name, owner_type, owner_id, provider_type, identifier, status, created_by, access_token_encrypted)
        VALUES (gen_random_uuid(), ${orgId}, 'tickets', ${email}, 'org', null, 'oauth2', ${email}, 'active', ${userId}, 'enc')
        RETURNING id`),
    )[0].id
    return id as string
  })
}

async function liveDefaultRows(
  orgId: string,
): Promise<Array<{ id: string; is_default_for_create: boolean; archived_at: Date | null }>> {
  return extractRows(
    await withPrivilegedDb(orgId, "inbox-default-invariant-check", (tx) =>
      tx.execute(drizzleSql`
        SELECT id, is_default_for_create, archived_at FROM app_tickets.inboxes
        WHERE org_id = ${orgId} AND is_default_for_create = true AND archived_at IS NULL
      `),
    ),
  )
}

async function inboxRow(
  orgId: string,
  id: string,
): Promise<{ id: string; is_default_for_create: boolean; archived_at: Date | null; name: string }> {
  return extractRows<{
    id: string
    is_default_for_create: boolean
    archived_at: Date | null
    name: string
  }>(
    await withPrivilegedDb(orgId, "inbox-default-invariant-check", (tx) =>
      tx.execute(drizzleSql`
        SELECT id, is_default_for_create, archived_at, name FROM app_tickets.inboxes
        WHERE org_id = ${orgId} AND id = ${id}
      `),
    ),
  )[0]!
}

describe("tickets: default-for-create inbox invariant", () => {
  it("an org whose only default is archived gets the default moved to a live inbox", async () => {
    const { orgId, userId } = await setupOrg()
    const acctA = await createMailboxAccount(orgId, userId, `a-${orgId}@x.test`)
    const acctB = await createMailboxAccount(orgId, userId, `b-${orgId}@x.test`)
    const a = (await admin(orgId, userId, "inboxesCreate", {
      kind: "mailbox",
      name: "Inbox A",
      emailAddress: `a-${orgId}@x.test`,
      connectedAccountId: acctA,
      isDefaultForCreate: true,
    })) as { id: string }
    const b = (await admin(orgId, userId, "inboxesCreate", {
      kind: "mailbox",
      name: "Inbox B",
      emailAddress: `b-${orgId}@x.test`,
      connectedAccountId: acctB,
    })) as { id: string }
    expect(a.id).toBeTruthy()
    expect(b.id).toBeTruthy()

    await admin(orgId, userId, "inboxesDisconnect", { id: a.id })

    const live = await liveDefaultRows(orgId)
    expect(live.length).toBe(1)
    expect(live[0]!.id).toBe(b.id)
    const rowA = await inboxRow(orgId, a.id)
    expect(rowA.is_default_for_create).toBe(false)
  })

  it("a mailbox inbox created alongside an api inbox becomes the default", async () => {
    const { orgId, userId } = await setupOrg()
    const apiInbox = (await admin(orgId, userId, "inboxesCreate", {
      kind: "api",
      name: "Bug Reports",
    })) as { id: string }
    expect(apiInbox.id).toBeTruthy()

    const acct = await createMailboxAccount(orgId, userId, `support-${orgId}@x.test`)
    const mailbox = (await admin(orgId, userId, "inboxesCreate", {
      kind: "mailbox",
      name: "Support",
      emailAddress: `support-${orgId}@x.test`,
      connectedAccountId: acct,
      isDefaultForCreate: false,
    })) as { id: string }
    expect(mailbox.id).toBeTruthy()

    const live = await liveDefaultRows(orgId)
    expect(live.length).toBe(1)
    expect(live[0]!.id).toBe(mailbox.id)
  })

  it("clearing the only default for create is refused", async () => {
    const { orgId, userId } = await setupOrg()
    const acct = await createMailboxAccount(orgId, userId, `only-${orgId}@x.test`)
    const inbox = (await admin(orgId, userId, "inboxesCreate", {
      kind: "mailbox",
      name: "Only",
      emailAddress: `only-${orgId}@x.test`,
      connectedAccountId: acct,
      isDefaultForCreate: true,
    })) as { id: string }

    const result = (await admin(orgId, userId, "inboxesUpdate", {
      id: inbox.id,
      isDefaultForCreate: false,
    })) as { error?: { code?: string } }
    expect(result.error?.code).toBe("default_inbox_required")

    const row = await inboxRow(orgId, inbox.id)
    expect(row.is_default_for_create).toBe(true)
  })

  it("an undefined isDefaultForCreate leaves the default untouched", async () => {
    const { orgId, userId } = await setupOrg()
    const acct = await createMailboxAccount(orgId, userId, `undef-${orgId}@x.test`)
    const inbox = (await admin(orgId, userId, "inboxesCreate", {
      kind: "mailbox",
      name: "Undef",
      emailAddress: `undef-${orgId}@x.test`,
      connectedAccountId: acct,
      isDefaultForCreate: true,
    })) as { id: string }

    await admin(orgId, userId, "inboxesUpdate", {
      id: inbox.id,
      name: "renamed",
      isDefaultForCreate: undefined,
    })

    const row = await inboxRow(orgId, inbox.id)
    expect(row.name).toBe("renamed")
    expect(row.is_default_for_create).toBe(true)
  })

  it("setting another inbox as the default still moves the flag atomically", async () => {
    const { orgId, userId } = await setupOrg()
    const acctA = await createMailboxAccount(orgId, userId, `moveA-${orgId}@x.test`)
    const acctB = await createMailboxAccount(orgId, userId, `moveB-${orgId}@x.test`)
    const a = (await admin(orgId, userId, "inboxesCreate", {
      kind: "mailbox",
      name: "Move A",
      emailAddress: `moveA-${orgId}@x.test`,
      connectedAccountId: acctA,
      isDefaultForCreate: true,
    })) as { id: string }
    const b = (await admin(orgId, userId, "inboxesCreate", {
      kind: "mailbox",
      name: "Move B",
      emailAddress: `moveB-${orgId}@x.test`,
      connectedAccountId: acctB,
    })) as { id: string }

    await admin(orgId, userId, "inboxesUpdate", { id: b.id, isDefaultForCreate: true })

    const live = await liveDefaultRows(orgId)
    expect(live.length).toBe(1)
    expect(live[0]!.id).toBe(b.id)
    const rowA = await inboxRow(orgId, a.id)
    expect(rowA.is_default_for_create).toBe(false)
  })
})
