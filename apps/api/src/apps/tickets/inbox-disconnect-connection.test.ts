// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Disconnecting a tickets inbox releases the mailbox connection behind it once
// no live inbox uses it: the connection is disconnected (grant revoked, tokens
// deleted by the connections service). The inbox's tickets stay.

import { describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { runAdminOp } from "~/apps/tickets/admin"
import { extractRows } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { ensureAppsForOrg } from "~/modules/apps/init"

async function setupOrg(): Promise<{ orgId: string; userId: string }> {
  const slug = `idc-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const ids = await withSystemDb("inbox-disconnect-connection-setup", async (tx) => {
    const orgId = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.organizations (id, name, slug)
        VALUES (gen_random_uuid(), 'Inbox Disconnect Org', ${slug}) RETURNING id`),
    )[0]!.id
    const userId = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${orgId}, ${`u-${slug}@x.test`}, 'A', 'active', 'h', 1, 1)
        RETURNING id`),
    )[0]!.id
    return { orgId, userId }
  })
  await ensureAppsForOrg(ids.orgId, {})
  return ids
}

function admin(orgId: string, userId: string, op: string, params: Record<string, unknown>) {
  return withPrivilegedDb(orgId, "inbox-disconnect-connection-test", (tx) =>
    runAdminOp(tx as never, orgId, op, params, { actorType: "user" as const, userId }),
  )
}

async function connection(orgId: string, id: string) {
  return extractRows<{ status: string; access_token_encrypted: string | null }>(
    await withSystemDb("inbox-disconnect-connection-read", (tx) =>
      tx.execute(drizzleSql`
        SELECT status, access_token_encrypted FROM kernel.connected_accounts
        WHERE org_id = ${orgId}::uuid AND id = ${id}::uuid`),
    ),
  )[0]!
}

describe("tickets inbox disconnect releases its mailbox connection", () => {
  it("disconnects the connection and deletes its tokens", async () => {
    const { orgId, userId } = await setupOrg()
    const email = `support-${orgId}@x.test`
    const accountId = await withSystemDb(
      "inbox-disconnect-connection-account",
      async (tx) =>
        extractRows<{ id: string }>(
          await tx.execute(drizzleSql`
          INSERT INTO kernel.connected_accounts
            (id, org_id, app_name, connection_name, owner_type, owner_id, provider_type, identifier,
             status, created_by, access_token_encrypted)
          VALUES (gen_random_uuid(), ${orgId}, 'tickets', 'gmail', 'org', null, 'oauth2', ${email},
                  'active', ${userId}, 'enc')
          RETURNING id`),
        )[0]!.id,
    )
    const inbox = (await admin(orgId, userId, "inboxesCreate", {
      kind: "mailbox",
      name: "Support",
      emailAddress: email,
      connectedAccountId: accountId,
    })) as { id: string }
    expect(inbox.id).toBeTruthy()
    expect((await connection(orgId, accountId)).status).toBe("active")

    await admin(orgId, userId, "inboxesDisconnect", { id: inbox.id })
    const after = await connection(orgId, accountId)
    expect(after.status).toBe("disconnected")
    expect(after.access_token_encrypted).toBeNull()
  })
})
