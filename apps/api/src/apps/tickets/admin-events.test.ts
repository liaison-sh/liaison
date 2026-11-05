// SPDX-License-Identifier: FSL-1.1-ALv2
// [Task 10] Admin operations emit category:* and inbox:* events.
import { beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { runAdminOp } from "~/apps/tickets/admin"
import ticketsManifest from "~/apps/tickets/app.manifest.json"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withSystemDb } from "~/db/privileged"
import { ensureAppsForOrg } from "~/modules/apps/init"

let orgId: string
let userId: string

beforeAll(async () => {
  const slug = `admin-evt-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await withSystemDb("admin-evt-fixture", async (tx) => {
    const orgRows = (await tx.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Admin Evt', ${slug}) RETURNING id
    `)) as any
    orgId = (orgRows.rows ?? orgRows)[0].id
    const u = (await tx.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}, ${`u-${slug}@x.test`}, 'A', 'active', 'h', 1, 1) RETURNING id
    `)) as any
    userId = (u.rows ?? u)[0].id
  })
  await ensureAppsForOrg(orgId, {})
})

/** Seed a real org-owned connected mail account whose identifier is `email`. */
async function seedConnectedAccount(email: string): Promise<string> {
  const rows = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.connected_accounts (
        id, org_id, app_name, connection_name, owner_type, owner_id,
        provider_type, identifier, status, created_by
      )
      VALUES (
        gen_random_uuid(), ${orgId}, 'mail', 'gmail', 'org', NULL,
        'oauth2', ${email}, 'active', ${userId}
      )
      RETURNING id
    `),
  )
  return rows[0].id
}

describe("tickets.events.emits", () => {
  it("manifest declares category:* and inbox:* events", () => {
    const emits = (ticketsManifest as any).events.emits as string[]
    for (const name of [
      "category:create",
      "category:update",
      "category:archive",
      "inbox:create",
      "inbox:update",
      "inbox:disconnect",
    ]) {
      expect(emits).toContain(name)
    }
  })

  it("categoriesCreate emits a category:create event into pending_events", async () => {
    const result = await withSystemDb("admin-events-cat-create", async (tx) => {
      return runAdminOp(
        tx as never,
        orgId,
        "categoriesCreate",
        { name: "Bugs" },
        { actorType: "user", userId },
      )
    })
    expect((result as any).id).toBeTruthy()
    const events = extractRows<{ payload: any }>(
      await db.execute(drizzleSql`
        SELECT payload FROM kernel.pending_events
        WHERE org_id = ${orgId} AND payload->>'entity' = 'category'
        ORDER BY created_at DESC LIMIT 5
      `),
    )
    expect(
      events.some((r) => r.payload.action === "create" && r.payload.data?.name === "Bugs"),
    ).toBe(true)
  })

  it("inboxesCreate emits an inbox:create event", async () => {
    const email = `support-${Date.now()}@x.test`
    // A tickets inbox must bind to a REAL connected mail account whose
    // identifier matches the inbox emailAddress — seed one so the guard passes.
    const connectedAccountId = await seedConnectedAccount(email)
    const result = await withSystemDb("admin-events-cat-create", async (tx) => {
      return runAdminOp(
        tx as never,
        orgId,
        "inboxesCreate",
        {
          name: "Support",
          emailAddress: email,
          connectedAccountId,
          isDefaultForCreate: true,
        },
        { actorType: "user", userId },
      )
    })
    expect((result as any).id).toBeTruthy()
    const inboxEvents = extractRows<{ payload: any }>(
      await db.execute(drizzleSql`
        SELECT payload FROM kernel.pending_events
        WHERE org_id = ${orgId} AND payload->>'entity' = 'inbox'
        ORDER BY created_at DESC LIMIT 5
      `),
    )
    expect(inboxEvents.some((r) => r.payload.action === "create")).toBe(true)
  })
})

// Regression: a tickets inbox is the support face of a CONNECTED mail account.
// inboxesCreate must REJECT (a) a connectedAccountId with no visible account,
// and (b) an emailAddress that does not MATCH the bound account's mailbox —
// both of which let an agent fabricate "I connected support@… as a shared
// inbox" when no such mailbox is connected (mail has no agent connect tool).
describe("tickets.inboxesCreate.account-email-binding-guard", () => {
  async function createInbox(params: Record<string, unknown>) {
    return withSystemDb("inboxesCreate-guard", async (tx) =>
      runAdminOp(tx as never, orgId, "inboxesCreate", params, { actorType: "user", userId }),
    )
  }

  it("rejects binding an inbox to a connectedAccountId that has no visible account", async () => {
    const res: any = await createInbox({
      name: "Phantom",
      emailAddress: "support@resonantaudio.example",
      connectedAccountId: crypto.randomUUID(),
    })
    expect(res.id).toBeFalsy()
    expect(res.error?.code).toBe("account_not_found")
    // No mislabelled inbox row was persisted.
    const rows = extractRows<{ n: number }>(
      await db.execute(drizzleSql`
        SELECT count(*)::int AS n FROM app_tickets.inboxes
        WHERE org_id = ${orgId} AND email_address = 'support@resonantaudio.example'
      `),
    )
    expect(rows[0]?.n).toBe(0)
  })

  it("rejects an emailAddress that does not match the bound account's mailbox", async () => {
    // A real account at support@chaos.liaison.sh exists, but the agent labels
    // the inbox support@resonantaudio.example — the exact fabrication trap.
    const connectedAccountId = await seedConnectedAccount("support@chaos.liaison.sh")
    const res: any = await createInbox({
      name: "Mislabelled shared inbox",
      emailAddress: "support@resonantaudio.example",
      connectedAccountId,
    })
    expect(res.id).toBeFalsy()
    expect(res.error?.code).toBe("inbox_account_email_mismatch")
    const rows = extractRows<{ n: number }>(
      await db.execute(drizzleSql`
        SELECT count(*)::int AS n FROM app_tickets.inboxes
        WHERE org_id = ${orgId} AND email_address = 'support@resonantaudio.example'
      `),
    )
    expect(rows[0]?.n).toBe(0)
  })

  it("accepts a matching emailAddress (case-insensitive) against a real account", async () => {
    const connectedAccountId = await seedConnectedAccount("shared@x.test")
    const res: any = await createInbox({
      name: "Shared",
      emailAddress: "Shared@X.test", // different case — still a match
      connectedAccountId,
    })
    expect(res.id).toBeTruthy()
    expect(res.error).toBeFalsy()
  })
})
