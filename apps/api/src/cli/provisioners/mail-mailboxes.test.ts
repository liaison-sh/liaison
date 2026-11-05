// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Real-DB tests for the `mail.mailboxes` provisioner: Mail app connections
 * only, shared (org-owned) or personal (member-owned), and never a ticket inbox.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { ConfigError } from "~/cli/config/parse"
import type { ProvisioningConfig } from "~/cli/config/schema"
import { mailMailboxesProvisioner } from "~/cli/provisioners/mail-mailboxes"
import { buildProvisionContext, type ProvisionContext } from "~/cli/provisioners/types"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

beforeAll(acquireTestLock)
afterAll(releaseTestLock)

async function freshOrgWithAdmin(): Promise<{ ctx: ProvisionContext; orgId: string }> {
  const { orgId } = await ensureOrg({
    slug: `cli-mail-${crypto.randomUUID().slice(0, 12)}`,
    name: "MailOrg",
  })
  const { userId } = await ensureUser({
    orgId,
    email: `admin-${crypto.randomUUID().slice(0, 8)}@fabrikam.example`,
    name: "Owner",
    password: "pw-mail-1!",
    role: "admin",
  })
  const ctx = buildProvisionContext({ log: () => {}, validateByok: false })
  ctx.orgId = orgId
  ctx.actor.userId = userId
  ctx.actor.scopes = ["*"]
  return { ctx, orgId }
}

const imap = (address: string) => ({
  email: address,
  imapHost: "imap.fabrikam.example",
  imapPort: 993,
  smtpHost: "smtp.fabrikam.example",
  smtpPort: 587,
  username: address,
  password: "app-password-1",
})

async function connectionsFor(orgId: string, address: string) {
  const rows = await withPrivilegedDb(orgId, "t", (tx) =>
    tx.execute(drizzleSql`
      SELECT app_name, connection_name, owner_type, owner_id FROM kernel.connected_accounts
      WHERE org_id = ${orgId}::uuid AND identifier = ${address} AND status = 'active'
    `),
  )
  return extractRows<{
    app_name: string
    connection_name: string
    owner_type: string
    owner_id: string | null
  }>(rows)
}

async function ticketInboxCount(orgId: string): Promise<number> {
  const rows = await withPrivilegedDb(orgId, "t", (tx) =>
    tx.execute(drizzleSql`SELECT id FROM app_tickets.inboxes WHERE org_id = ${orgId}::uuid`),
  )
  return extractRows(rows).length
}

describe("mail.mailboxes provisioner", () => {
  test("shared imap mailbox -> one org-owned mail/imap connection, no ticket inbox, idempotent", async () => {
    const { ctx, orgId } = await freshOrgWithAdmin()
    const address = `team-${crypto.randomUUID().slice(0, 8)}@fabrikam.example`
    const config: ProvisioningConfig = {
      org: { slug: "x", name: "X" },
      mail: { mailboxes: [{ address, provider: "imap", imap: imap(address) }] },
    }

    const r1 = await mailMailboxesProvisioner.apply(ctx, { actions: [] }, config)
    expect(r1.changed ?? []).toContain(`mail.mailboxes.${address}.connection`)
    const conns = await connectionsFor(orgId, address)
    expect(conns.map((c) => `${c.app_name}/${c.connection_name}/${c.owner_type}`)).toEqual([
      "mail/imap/org",
    ])
    expect(await ticketInboxCount(orgId)).toBe(0)

    const r2 = await mailMailboxesProvisioner.apply(ctx, { actions: [] }, config)
    expect(r2.unchanged ?? []).toContain(`mail.mailboxes.${address}.connection`)
    expect((await connectionsFor(orgId, address)).length).toBe(1)
  })

  test("personal imap mailbox -> connection owned by the named member", async () => {
    const { ctx, orgId } = await freshOrgWithAdmin()
    const ownerEmail = `alice-${crypto.randomUUID().slice(0, 8)}@fabrikam.example`
    const { userId: aliceId } = await ensureUser({
      orgId,
      email: ownerEmail,
      name: "Alice",
      password: "pw-alice-1!",
      role: "member",
    })
    const address = ownerEmail
    await mailMailboxesProvisioner.apply(
      ctx,
      { actions: [] },
      {
        org: { slug: "x", name: "X" },
        mail: {
          mailboxes: [{ address, provider: "imap", owner: ownerEmail, imap: imap(address) }],
        },
      },
    )
    const [conn] = await connectionsFor(orgId, address)
    expect(conn?.owner_type).toBe("user")
    expect(conn?.owner_id).toBe(aliceId)
    expect(await ticketInboxCount(orgId)).toBe(0)
  })

  test("personal mailbox for someone who is not a member -> ConfigError", async () => {
    const { ctx } = await freshOrgWithAdmin()
    const address = "ghost@fabrikam.example"
    await expect(
      mailMailboxesProvisioner.apply(
        ctx,
        { actions: [] },
        {
          org: { slug: "x", name: "X" },
          mail: {
            mailboxes: [{ address, provider: "imap", owner: address, imap: imap(address) }],
          },
        },
      ),
    ).rejects.toBeInstanceOf(ConfigError)
  })

  test("shared gmail mailbox -> pending 'liaison guide google' then 'liaison connect mail/gmail', nothing created", async () => {
    const { ctx, orgId } = await freshOrgWithAdmin()
    const address = `gteam-${crypto.randomUUID().slice(0, 8)}@fabrikam.example`
    const result = await mailMailboxesProvisioner.apply(
      ctx,
      { actions: [] },
      { org: { slug: "x", name: "X" }, mail: { mailboxes: [{ address, provider: "gmail" }] } },
    )
    const pending = (result.pending ?? []).find((p) => p.app === "mail")
    expect(pending?.action).toBe(
      `liaison guide google --email ${address}, then liaison connect mail/gmail`,
    )
    expect(await connectionsFor(orgId, address)).toEqual([])
    expect(await ticketInboxCount(orgId)).toBe(0)
  })
})
