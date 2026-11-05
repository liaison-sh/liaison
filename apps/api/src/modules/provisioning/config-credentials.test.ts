// SPDX-License-Identifier: FSL-1.1-ALv2
//
// On the tool path a secret never arrives as a tool param, so a mailbox or a
// ticket inbox comes without its password / client secret. It then creates NO
// connection and reports a `credentials` pending item naming the address, and a
// ticket inbox's settings apply only to an inbox that already exists, without
// waiting for the server to create one. The CLI path (secrets present) is
// unchanged; its own provisioner tests prove that.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { runAdminOp } from "~/apps/tickets/admin"
import type { ProvisioningConfig } from "~/cli/config/schema"
import { createTicketInboxesProvisioner } from "~/cli/provisioners/ticket-inboxes"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { loadOrgGoogleOAuthClient } from "~/modules/apps/connections/oauth-client"
import { createCredentialConnection } from "~/modules/apps/connections/service"
import { applySections, buildActorProvisionContext } from "~/modules/provisioning/config-sections"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

beforeAll(acquireTestLock)
afterAll(releaseTestLock)

async function toolCtx() {
  const { orgId } = await ensureOrg({
    slug: `cfg-cred-${crypto.randomUUID().slice(0, 12)}`,
    name: "CredOrg",
  })
  const { userId } = await ensureUser({
    orgId,
    email: `admin-${crypto.randomUUID().slice(0, 8)}@fabrikam.example`,
    name: "Owner",
    password: "pw-cred-1!",
    role: "admin",
  })
  const ctx = buildActorProvisionContext({
    orgId,
    actor: { userId, scopes: ["*"], dimensionGrants: { "*": ["*"] } },
  })
  return { ctx, orgId, userId }
}

/** The tool path's IMAP block: everything but the password (empty). */
function imapWithoutSecret(address: string) {
  return {
    email: address,
    imapHost: "imap.fabrikam.example",
    imapPort: 993,
    smtpHost: "smtp.fabrikam.example",
    smtpPort: 587,
    username: address,
    password: "",
  }
}

async function connections(orgId: string, address: string) {
  const rows = await withPrivilegedDb(orgId, "t", (tx) =>
    tx.execute(drizzleSql`
      SELECT app_name, connection_name FROM kernel.connected_accounts
      WHERE org_id = ${orgId}::uuid AND lower(identifier) = lower(${address}) AND status = 'active'
    `),
  )
  return extractRows<{ app_name: string; connection_name: string }>(rows)
}

async function connect(orgId: string, userId: string, app: string, address: string) {
  await withPrivilegedDb(orgId, "t", (priv) =>
    createCredentialConnection(priv, orgId, userId, app, "imap", {
      identifier: address,
      credentials: {
        ...imapWithoutSecret(address),
        imapPort: "993",
        smtpPort: "587",
        password: "x",
      },
      ownerType: "org",
    }),
  )
}

describe("credential-less mailboxes and inboxes on the tool path", () => {
  test("an IMAP mailbox without its password creates no connection and reports pending credentials", async () => {
    const { ctx, orgId } = await toolCtx()
    const address = `box-${crypto.randomUUID().slice(0, 8)}@fabrikam.example`
    const cfg: ProvisioningConfig = {
      org: { slug: "x", name: "X" },
      mail: { mailboxes: [{ address, provider: "imap", imap: imapWithoutSecret(address) }] },
    }
    const report = await applySections(ctx, cfg, ["mail"])
    expect(await connections(orgId, address)).toEqual([])
    expect(report.pending).toContainEqual(
      expect.objectContaining({
        kind: "credentials",
        app: "mail",
        connection: "imap",
        identifier: address,
      }),
    )
  })

  test("an IMAP mailbox whose connection already exists is reported connected and unchanged", async () => {
    const { ctx, orgId, userId } = await toolCtx()
    const address = `box-${crypto.randomUUID().slice(0, 8)}@fabrikam.example`
    await connect(orgId, userId, "mail", address)
    const cfg: ProvisioningConfig = {
      org: { slug: "x", name: "X" },
      mail: { mailboxes: [{ address, provider: "imap", imap: imapWithoutSecret(address) }] },
    }
    const report = await applySections(ctx, cfg, ["mail"])
    expect(report.pending).toEqual([])
    expect(report.unchanged).toContain(`mail.mailboxes.${address}.connection`)
  })

  test("a Google client without its secret is not saved and is reported pending", async () => {
    const { ctx, orgId } = await toolCtx()
    const address = `g-${crypto.randomUUID().slice(0, 8)}@fabrikam.example`
    const cfg: ProvisioningConfig = {
      org: { slug: "x", name: "X" },
      mail: {
        mailboxes: [
          {
            address,
            provider: "gmail",
            google: { clientId: "id.apps.googleusercontent.com", clientSecret: "" },
          },
        ],
      },
    }
    const report = await applySections(ctx, cfg, ["mail"])
    // The org's own client is what must not be saved. The summary would also
    // answer `configured` for a deployment client in the environment.
    expect(await loadOrgGoogleOAuthClient(orgId)).toBeNull()
    expect(report.pending).toContainEqual(
      expect.objectContaining({ kind: "credentials", app: "mail", identifier: address }),
    )
  })

  test("a ticket inbox without its password: no connection, pending credentials, no wait", async () => {
    const { ctx, orgId } = await toolCtx()
    const address = `desk-${crypto.randomUUID().slice(0, 8)}@fabrikam.example`
    // A long bounded wait proves the tool path never polls.
    const provisioner = createTicketInboxesProvisioner({
      pollIntervalMs: 1_000,
      pollTimeoutMs: 60_000,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    })
    const cfg: ProvisioningConfig = {
      org: { slug: "x", name: "X" },
      tickets: {
        inboxes: [{ address, provider: "imap", imap: imapWithoutSecret(address), name: "Desk" }],
      },
    }
    const started = Date.now()
    const report = await applySections(ctx, cfg, ["tickets"], {
      registry: { tickets: provisioner },
    })
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(await connections(orgId, address)).toEqual([])
    expect(report.pending).toContainEqual(
      expect.objectContaining({
        kind: "credentials",
        app: "tickets",
        connection: "imap",
        identifier: address,
      }),
    )
  })

  test("a connected ticket inbox the server has not created yet: pending, apply again later, no wait", async () => {
    const { ctx, orgId, userId } = await toolCtx()
    const address = `desk-${crypto.randomUUID().slice(0, 8)}@fabrikam.example`
    await connect(orgId, userId, "tickets", address)
    const provisioner = createTicketInboxesProvisioner({
      pollIntervalMs: 1_000,
      pollTimeoutMs: 60_000,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    })
    const cfg: ProvisioningConfig = {
      org: { slug: "x", name: "X" },
      tickets: {
        inboxes: [{ address, provider: "imap", imap: imapWithoutSecret(address), name: "Desk" }],
      },
    }
    const started = Date.now()
    const report = await applySections(ctx, cfg, ["tickets"], {
      registry: { tickets: provisioner },
    })
    expect(Date.now() - started).toBeLessThan(5_000)
    const item = report.pending.find((p) => p.app === "tickets")
    expect(item?.message).toMatch(/apply again once the inbox appears/)
  })

  test("a connected ticket inbox that exists gets its settings", async () => {
    const { ctx, orgId, userId } = await toolCtx()
    const address = `desk-${crypto.randomUUID().slice(0, 8)}@fabrikam.example`
    await connect(orgId, userId, "tickets", address)
    const [conn] = extractRows<{ id: string }>(
      await withPrivilegedDb(orgId, "t", (tx) =>
        tx.execute(drizzleSql`
          SELECT id FROM kernel.connected_accounts
          WHERE org_id = ${orgId}::uuid AND app_name = 'tickets' AND identifier = ${address}`),
      ),
    )
    if (!conn) throw new Error("no connection")
    await withPrivilegedDb(orgId, "t", (tx) =>
      runAdminOp(
        tx,
        orgId,
        "inboxesCreate",
        { connectedAccountId: conn.id, name: address, emailAddress: address },
        { actorType: "user", userId },
      ),
    )
    const cfg: ProvisioningConfig = {
      org: { slug: "x", name: "X" },
      tickets: {
        inboxes: [{ address, provider: "imap", imap: imapWithoutSecret(address), name: "Desk" }],
      },
    }
    const report = await applySections(ctx, cfg, ["tickets"])
    expect(report.pending).toEqual([])
    expect(report.changed).toContain(`tickets.inboxes.${address}.settings`)
    const [row] = extractRows<{ name: string }>(
      await withPrivilegedDb(orgId, "t", (tx) =>
        tx.execute(drizzleSql`
          SELECT name FROM app_tickets.inboxes WHERE org_id = ${orgId}::uuid AND email_address = ${address}`),
      ),
    )
    expect(row?.name).toBe("Desk")
  })
})
