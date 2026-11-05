// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Real-DB tests for the `tickets.inboxes` provisioner. No outbox worker runs
 * here: the reactive inbox creation by the tickets app is simulated by seeding
 * the inbox inside the poll's `sleep` seam. The full chain with the live tickets
 * handler is covered by tests/integration/config-cli-hub-path.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { runAdminOp } from "~/apps/tickets/admin"
import type { ProvisioningConfig } from "~/cli/config/schema"
import { createTicketInboxesProvisioner } from "~/cli/provisioners/ticket-inboxes"
import { buildProvisionContext, type ProvisionContext } from "~/cli/provisioners/types"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import { getGoogleIntegrationSummary } from "~/modules/settings/google-integration"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

beforeAll(acquireTestLock)
afterAll(releaseTestLock)

async function freshOrgWithAdmin(): Promise<{ ctx: ProvisionContext; orgId: string }> {
  const { orgId } = await ensureOrg({
    slug: `cli-tix-${crypto.randomUUID().slice(0, 12)}`,
    name: "TicketInboxOrg",
  })
  const { userId } = await ensureUser({
    orgId,
    email: `admin-${crypto.randomUUID().slice(0, 8)}@fabrikam.example`,
    name: "Owner",
    password: "pw-tix-1!",
    role: "admin",
  })
  const ctx = buildProvisionContext({ log: () => {}, validateByok: false })
  ctx.orgId = orgId
  ctx.actor.userId = userId
  ctx.actor.scopes = ["*"]
  return { ctx, orgId }
}

function imapConfig(
  address: string,
  settings: { name?: string; defaultTeam?: string; fromDisplayName?: string; default?: boolean },
): ProvisioningConfig {
  return {
    org: { slug: "x", name: "X" },
    tickets: {
      inboxes: [
        {
          address,
          provider: "imap",
          imap: {
            email: address,
            imapHost: "imap.fabrikam.example",
            imapPort: 993,
            smtpHost: "smtp.fabrikam.example",
            smtpPort: 587,
            username: address,
            password: "app-password-1",
          },
          ...settings,
        },
      ],
    },
  }
}

async function connectionsFor(orgId: string, address: string) {
  const rows = await withPrivilegedDb(orgId, "t", (tx) =>
    tx.execute(drizzleSql`
      SELECT id, app_name, connection_name, owner_type FROM kernel.connected_accounts
      WHERE org_id = ${orgId}::uuid AND identifier = ${address} AND status = 'active'
    `),
  )
  return extractRows<{ id: string; app_name: string; connection_name: string; owner_type: string }>(
    rows,
  )
}

async function inboxFor(orgId: string, address: string) {
  const rows = await withPrivilegedDb(orgId, "t", (tx) =>
    tx.execute(drizzleSql`
      SELECT id, name, default_team, from_display_name, is_default_for_create, connected_account_id
      FROM app_tickets.inboxes WHERE org_id = ${orgId}::uuid AND email_address = ${address}
    `),
  )
  return extractRows<{
    id: string
    name: string
    default_team: string | null
    from_display_name: string | null
    is_default_for_create: boolean
    connected_account_id: string
  }>(rows)
}

/** Stand-in for `ticketsOnAccountConnected`: an inbox named after the address. */
async function seedInboxForConnection(orgId: string, userId: string, address: string) {
  const [conn] = await connectionsFor(orgId, address)
  if (!conn) throw new Error("no connection to bind")
  await withPrivilegedDb(orgId, "t", (tx) =>
    runAdminOp(
      tx,
      orgId,
      "inboxesCreate",
      { connectedAccountId: conn.id, name: address, emailAddress: address },
      { actorType: "user", userId },
    ),
  )
}

describe("tickets.inboxes provisioner: imap", () => {
  test("creates a tickets-owned connection and no Mail app connection; no inbox yet -> pending", async () => {
    const { ctx, orgId } = await freshOrgWithAdmin()
    const address = `desk-${crypto.randomUUID().slice(0, 8)}@fabrikam.example`
    const provisioner = createTicketInboxesProvisioner({
      pollIntervalMs: 1,
      pollTimeoutMs: 5,
      sleep: () => Promise.resolve(),
    })

    const result = await provisioner.apply(ctx, { actions: [] }, imapConfig(address, {}))

    const conns = await connectionsFor(orgId, address)
    expect(conns.map((c) => `${c.app_name}/${c.connection_name}/${c.owner_type}`)).toEqual([
      "tickets/imap/org",
    ])
    const mail = await withPrivilegedDb(orgId, "t", (tx) =>
      tx.execute(drizzleSql`
        SELECT id FROM kernel.connected_accounts WHERE org_id = ${orgId}::uuid AND app_name = 'mail'
      `),
    )
    expect(extractRows(mail).length).toBe(0)
    const pending = (result.pending ?? []).find((p) => p.app === "tickets")
    expect(pending?.connection).toBe("imap")

    // Re-run: the connection is found, never duplicated.
    await provisioner.apply(ctx, { actions: [] }, imapConfig(address, {}))
    expect((await connectionsFor(orgId, address)).length).toBe(1)
  })

  test("once the server creates the inbox, its settings converge, and a re-run is unchanged", async () => {
    const { ctx, orgId } = await freshOrgWithAdmin()
    const address = `desk-${crypto.randomUUID().slice(0, 8)}@fabrikam.example`
    let seeded = false
    const provisioner = createTicketInboxesProvisioner({
      pollIntervalMs: 1,
      pollTimeoutMs: 5_000,
      sleep: async () => {
        if (!seeded) {
          seeded = true
          await seedInboxForConnection(orgId, ctx.actor.userId, address)
        }
      },
    })
    const config = imapConfig(address, {
      name: "Support",
      defaultTeam: "Le Pass",
      fromDisplayName: "Fabrikam Support",
      default: true,
    })

    const r1 = await provisioner.apply(ctx, { actions: [] }, config)
    expect(r1.pending ?? []).toEqual([])
    const [inbox] = await inboxFor(orgId, address)
    const [conn] = await connectionsFor(orgId, address)
    expect(inbox?.connected_account_id).toBe(conn?.id)
    expect(inbox?.name).toBe("Support")
    expect(inbox?.default_team).toBe("Le Pass")
    expect(inbox?.from_display_name).toBe("Fabrikam Support")
    expect(inbox?.is_default_for_create).toBe(true)
    expect(r1.changed ?? []).toContain(`tickets.inboxes.${address}.settings`)

    const r2 = await provisioner.apply(ctx, { actions: [] }, config)
    expect(r2.unchanged ?? []).toContain(`tickets.inboxes.${address}.settings`)
    expect(r2.changed ?? []).not.toContain(`tickets.inboxes.${address}.settings`)
  })
})

describe("tickets.inboxes provisioner: gmail", () => {
  test("saves the Google client and reports pending 'liaison guide google' then 'liaison connect tickets/gmail', no connection", async () => {
    const { ctx, orgId } = await freshOrgWithAdmin()
    const address = `gdesk-${crypto.randomUUID().slice(0, 8)}@fabrikam.example`
    const result = await createTicketInboxesProvisioner().apply(
      ctx,
      { actions: [] },
      {
        org: { slug: "x", name: "X" },
        tickets: {
          inboxes: [
            {
              address,
              provider: "gmail",
              google: { clientId: "gcid-1.apps.googleusercontent.com", clientSecret: "gsec-1" },
              name: "Support",
            },
          ],
        },
      },
    )
    expect((await getGoogleIntegrationSummary(orgId)).configurationSource).toBe("org")
    const pending = (result.pending ?? []).find((p) => p.app === "tickets")
    expect(pending?.action).toBe(
      `liaison guide google --email ${address}, then liaison connect tickets/gmail`,
    )
    expect(await connectionsFor(orgId, address)).toEqual([])
  })

  test("an inbox bound to a Mail app connection is flagged for rebinding, not reported ready", async () => {
    const { ctx, orgId } = await freshOrgWithAdmin()
    const address = `legacy-${crypto.randomUUID().slice(0, 8)}@fabrikam.example`
    // The shape the removed `mailboxes` section produced: a mail/gmail
    // connection with a ticket inbox attached to it.
    await withPrivilegedDb(orgId, "t", (tx) =>
      tx.execute(drizzleSql`
        INSERT INTO kernel.connected_accounts (
          id, org_id, app_name, connection_name, owner_type, owner_id,
          identifier, provider_type, status, created_by, created_at, updated_at
        ) VALUES (
          gen_random_uuid(), ${orgId}::uuid, 'mail', 'gmail', 'org', NULL,
          ${address}, 'oauth2', 'active', ${ctx.actor.userId}::uuid, now(), now()
        )
      `),
    )
    await seedInboxForConnection(orgId, ctx.actor.userId, address)

    const result = await createTicketInboxesProvisioner().apply(
      ctx,
      { actions: [] },
      {
        org: { slug: "x", name: "X" },
        tickets: { inboxes: [{ address, provider: "gmail", name: "Renamed" }] },
      },
    )
    const pending = (result.pending ?? []).find((p) => p.app === "tickets")
    expect(pending?.action).toBe(
      `liaison guide google --email ${address}, then liaison connect tickets/gmail`,
    )
    expect(pending?.message).toContain("'mail' app connection")
    // Settings are not applied to an inbox that cannot receive tickets.
    expect((await inboxFor(orgId, address))[0]?.name).toBe(address)
  })
})

describe("tickets.approveRepliesFromHome", () => {
  test("writes settings.tickets.approveRepliesFromHome, keeps sibling keys, re-run is unchanged", async () => {
    const { ctx, orgId } = await freshOrgWithAdmin()
    await withPrivilegedDb(orgId, "t", (tx) =>
      tx.execute(drizzleSql`
        UPDATE kernel.organizations
        SET settings = jsonb_set(settings, '{tickets}', '{"idSegment":{"by":"none","codes":{}}}'::jsonb, true)
        WHERE id = ${orgId}::uuid
      `),
    )
    const readTickets = async () =>
      extractRows<{ t: Record<string, unknown> }>(
        await withPrivilegedDb(orgId, "t", (tx) =>
          tx.execute(
            drizzleSql`SELECT settings->'tickets' AS t FROM kernel.organizations WHERE id = ${orgId}::uuid`,
          ),
        ),
      )[0]?.t
    const provisioner = createTicketInboxesProvisioner()
    const config = (value: boolean): ProvisioningConfig => ({
      org: { slug: "x", name: "X" },
      tickets: { approveRepliesFromHome: value },
    })

    const first = await provisioner.apply(ctx, { actions: [] }, config(true))
    expect(first.changed).toEqual(["tickets.approveRepliesFromHome"])
    expect(await readTickets()).toEqual({
      idSegment: { by: "none", codes: {} },
      approveRepliesFromHome: true,
    })

    const again = await provisioner.apply(ctx, { actions: [] }, config(true))
    expect(again.unchanged).toEqual(["tickets.approveRepliesFromHome"])
    expect(again.changed).toBeUndefined()

    const off = await provisioner.apply(ctx, { actions: [] }, config(false))
    expect(off.changed).toEqual(["tickets.approveRepliesFromHome"])
    expect((await readTickets())?.approveRepliesFromHome).toBe(false)
  })
})
