// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { sql } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { CryptoContext, decryptSecret } from "~/lib/crypto"
import { env } from "~/lib/env"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { seedContext } from "~/seed/context"
import { seedBaseAgent } from "~/seed/factories/agent/agents"
import { seedRoutine } from "~/seed/factories/agent/routines"
import { rowsOf } from "~/seed/factories/people/actors"
import { adminSession, contact, orgAdmin, person, thread } from "~/seed/tiers/minimal"
import { buildTestApp } from "~/tests/helpers/build-app"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

beforeAll(acquireTestLock)
afterAll(releaseTestLock)

// Each case bootstraps an org (a full app setup chain, about 1.3 s on a CI-class box).
const TIMEOUT_MS = 60_000

type App = Awaited<ReturnType<typeof buildTestApp>>

async function seed(
  app: App,
  orgId: string | undefined,
  factory: string,
  args: Record<string, unknown>,
): Promise<{
  status: number
  body: { data?: Record<string, unknown>; error?: { code: string; message: string } }
}> {
  const res = await app.request("/api/_test/seed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ factory, orgId, args }),
  })
  return { status: res.status, body: (await res.json()) as never }
}

async function ticketRow(orgId: string, id: string) {
  const [row] = await withPrivilegedDb(orgId, "seed-route-test:ticket", async (tx) =>
    rowsOf<{
      status: string
      closed_reason: string | null
      merged_into_ticket_id: string | null
      source_inbox_id: string | null
      message_count: number
      first_response_at: string | null
    }>(
      await tx.execute(
        sql`SELECT status, closed_reason, merged_into_ticket_id, source_inbox_id, message_count, first_response_at
            FROM app_tickets.tickets WHERE id = ${id}::uuid`,
      ),
    ),
  )
  return row
}

describe("/api/_test/seed", () => {
  test(
    "tickets: a snooze come due through the state machine, then time moves its SLA deadline",
    async () => {
      const org = await createTestOrg()
      const app = await buildTestApp()
      const due = new Date(Date.now() - 60_000).toISOString()
      const ticket = await seed(app, org.id, "tickets.ticket", {
        subject: "Ping back",
        withInboundMessage: false,
        followup: { at: due, reason: "ping back" },
      })
      expect(ticket.status).toBe(200)
      const id = ticket.body.data?.id as string
      const read = async () => {
        const [row] = await withPrivilegedDb(org.id, "seed-route-test:clock", async (tx) =>
          rowsOf<{
            status: string
            followup_at: string
            followup_reason: string
            sla_deadline: string
          }>(
            await tx.execute(
              sql`SELECT status, followup_at, followup_reason, sla_deadline
                  FROM app_tickets.tickets WHERE id = ${id}::uuid`,
            ),
          ),
        )
        return row
      }
      const snoozed = await read()
      expect(snoozed?.status).toBe("awaiting_followup")
      expect(snoozed?.followup_reason).toBe("ping back")
      expect(new Date(snoozed?.followup_at as string).toISOString()).toBe(due)

      const moved = await seed(app, org.id, "tickets.clock", {
        ticketId: id,
        slaDeadlineInSeconds: -300,
      })
      expect(moved.status).toBe(200)
      const after = await read()
      expect(new Date(after?.sla_deadline as string).getTime()).toBeLessThan(Date.now() - 250_000)
      expect(new Date(after?.followup_at as string).toISOString()).toBe(due)

      const missing = await seed(app, org.id, "tickets.clock", {
        ticketId: crypto.randomUUID(),
        slaDeadlineInSeconds: 0,
      })
      expect(missing.status).toBe(422)
    },
    TIMEOUT_MS,
  )

  test(
    "names the known factories for an unknown one, and refuses invalid args",
    async () => {
      const org = await createTestOrg()
      const app = await buildTestApp()
      const unknown = await seed(app, org.id, "nope.nothing", {})
      expect(unknown.status).toBe(400)
      expect(unknown.body.error?.code).toBe("unknown_factory")
      expect(unknown.body.error?.message).toContain("tickets.ticket")

      const invalid = await seed(app, org.id, "tickets.ticket", { subject: 42 })
      expect(invalid.status).toBe(400)
      expect(invalid.body.error?.code).toBe("invalid_args")
      expect(invalid.body.error?.message).toContain("subject")
    },
    TIMEOUT_MS,
  )

  test(
    "tickets: an inbox, a ticket in it with the customer's message, later messages, a merge",
    async () => {
      const org = await createTestOrg()
      const app = await buildTestApp()
      const inbox = await seed(app, org.id, "tickets.inbox", {
        name: "Support",
        emailAddress: "support@e2e.test",
        isDefault: true,
      })
      expect(inbox.status).toBe(200)
      const inboxId = inbox.body.data?.id as string
      const [inboxRow] = await withPrivilegedDb(org.id, "seed-route-test:inbox", async (tx) =>
        rowsOf<{ is_default_for_create: boolean; email_address: string }>(
          await tx.execute(
            sql`SELECT is_default_for_create, email_address FROM app_tickets.inboxes WHERE id = ${inboxId}::uuid`,
          ),
        ),
      )
      expect(inboxRow).toEqual({ is_default_for_create: true, email_address: "support@e2e.test" })

      const ticket = await seed(app, org.id, "tickets.ticket", {
        subject: "Broken knob",
        sourceInboxId: inboxId,
        priority: "high",
      })
      expect(ticket.status).toBe(200)
      const ticketId = ticket.body.data?.id as string
      expect(ticket.body.data?.handle).toBeTruthy()
      expect(await ticketRow(org.id, ticketId)).toMatchObject({
        status: "open",
        source_inbox_id: inboxId,
        message_count: 1,
        first_response_at: null,
      })

      const more = await seed(app, org.id, "tickets.messages", {
        ticketId,
        messages: [
          { kind: "outbound", textBody: "Which model?" },
          { kind: "inbound", textBody: "The big one" },
        ],
      })
      expect(more.status).toBe(200)
      expect(more.body.data?.count).toBe(2)
      expect(more.body.data?.ids).toHaveLength(2)
      const after = await ticketRow(org.id, ticketId)
      expect(after?.message_count).toBe(3)
      expect(after?.first_response_at).not.toBeNull()

      const source = await seed(app, org.id, "tickets.ticket", {
        subject: "Same knob again",
        sourceInboxId: inboxId,
        mergedIntoTicketId: ticketId,
      })
      expect(source.status).toBe(200)
      expect(await ticketRow(org.id, source.body.data?.id as string)).toMatchObject({
        status: "closed",
        closed_reason: "merged",
        merged_into_ticket_id: ticketId,
      })

      const closed = await seed(app, org.id, "tickets.ticket", {
        subject: "Done",
        status: "closed",
        closedReason: "resolved",
        withInboundMessage: false,
      })
      expect(await ticketRow(org.id, closed.body.data?.id as string)).toMatchObject({
        status: "closed",
        closed_reason: "resolved",
        message_count: 0,
      })
    },
    TIMEOUT_MS,
  )

  test(
    "a backdated, assigned ticket on a team, closed again through the state machine",
    async () => {
      const org = await createTestOrg()
      const app = await buildTestApp()
      const admin = await orgAdmin(org.id)
      const ticket = await seed(app, org.id, "tickets.ticket", {
        subject: "Old question",
        team: "support-eu",
        assignedTo: admin.id,
        createdMinutesAgo: 360,
        firstResponseMinutesAgo: 300,
      })
      expect(ticket.status).toBe(200)
      const id = ticket.body.data?.id as string
      const [row] = await withPrivilegedDb(org.id, "seed-route-test:backdated", async (tx) =>
        rowsOf<{ team: string; assigned_to: string; age_min: number; answered_min: number }>(
          await tx.execute(
            sql`SELECT team, assigned_to::text AS assigned_to,
                       extract(epoch FROM now() - created_at) / 60 AS age_min,
                       extract(epoch FROM now() - first_response_at) / 60 AS answered_min
                FROM app_tickets.tickets WHERE id = ${id}::uuid`,
          ),
        ),
      )
      expect(row?.team).toBe("support-eu")
      expect(row?.assigned_to).toBe(admin.id)
      expect(Number(row?.age_min)).toBeGreaterThan(355)
      expect(Number(row?.answered_min)).toBeGreaterThan(295)

      const closed = await seed(app, org.id, "tickets.close", { ticketIds: [id] })
      expect(closed.body.data).toEqual({ closed: 1 })
      expect(await ticketRow(org.id, id)).toMatchObject({
        status: "closed",
        closed_reason: "resolved",
      })
      const again = await seed(app, org.id, "tickets.close", { ticketIds: [id] })
      expect(again.body.data).toEqual({ closed: 0 })
    },
    TIMEOUT_MS,
  )

  test(
    "onlyMissing grants nothing to a person who holds every scope already",
    async () => {
      const org = await createTestOrg()
      const app = await buildTestApp()
      const admin = await orgAdmin(org.id)
      const version = async () => {
        const [row] = await withPrivilegedDb(org.id, "seed-route-test:version", async (tx) =>
          rowsOf<{ v: number }>(
            await tx.execute(
              sql`SELECT permission_version AS v FROM kernel.users WHERE id = ${admin.id}::uuid`,
            ),
          ),
        )
        return row?.v
      }
      const before = await version()
      const held = await seed(app, org.id, "roles.grantScopes", {
        userId: admin.id,
        scopes: ["projects:projects:read"],
        onlyMissing: true,
      })
      expect(held.body.data).toEqual({ roleId: null })
      expect(await version()).toBe(before)

      const member = await person(org.id)
      const granted = await seed(app, org.id, "roles.grantScopes", {
        userId: member.id,
        scopes: ["projects:projects:read"],
        onlyMissing: true,
      })
      expect(typeof granted.body.data?.roleId).toBe("string")
    },
    TIMEOUT_MS,
  )

  test(
    "a refused factory answers 422 naming the factory",
    async () => {
      const org = await createTestOrg()
      const app = await buildTestApp()
      const refused = await seed(app, org.id, "tickets.ticket", {
        subject: "Into nothing",
        mergedIntoTicketId: "00000000-0000-4000-8000-000000000000",
      })
      expect(refused.status).toBe(422)
      expect(refused.body.error?.code).toBe("seed_refused")
      expect(refused.body.error?.message).toContain("tickets.ticket")
    },
    TIMEOUT_MS,
  )

  test(
    "an API key whose plaintext hashes to the stored key, and a role granting scopes and dimensions",
    async () => {
      const org = await createTestOrg()
      const app = await buildTestApp()
      const key = await seed(app, org.id, "tickets.apiKey", { label: "e2e key" })
      expect(key.status).toBe(200)
      const plaintext = key.body.data?.plaintext as string
      const [stored] = await withPrivilegedDb(org.id, "seed-route-test:key", async (tx) =>
        rowsOf<{ key_hash: string }>(
          await tx.execute(
            sql`SELECT key_hash FROM app_tickets.api_keys WHERE id = ${key.body.data?.id as string}::uuid`,
          ),
        ),
      )
      expect(stored?.key_hash).toBe(createHash("sha256").update(plaintext).digest("hex"))

      const member = await person(org.id)
      const granted = await seed(app, org.id, "roles.grantScopes", {
        userId: member.id,
        scopes: ["tickets:tickets:read"],
        dimensions: { team: ["*"], sensitivity: ["restricted"] },
      })
      expect(granted.status).toBe(200)
      const perms = await withPrivilegedDb(org.id, "seed-route-test:perms", (tx) =>
        loadEffectivePermissions(tx, member.id, org.id),
      )
      expect(perms.scopes).toContain("tickets:tickets:read")
      expect(JSON.stringify(perms.dimensionGrants)).toContain("restricted")
    },
    TIMEOUT_MS,
  )

  test(
    "people and roles: a roleless person, a role with grants assigned, threads referencing a ticket",
    async () => {
      const org = await createTestOrg()
      const app = await buildTestApp()
      const roleless = await seed(app, org.id, "people.roleless", {
        name: "No Role",
        email: `norole-${crypto.randomUUID().slice(0, 8)}@e2e.test`,
      })
      expect(roleless.status).toBe(200)
      const rolelessId = roleless.body.data?.id as string
      const before = await withPrivilegedDb(org.id, "seed-route-test:roleless", (tx) =>
        loadEffectivePermissions(tx, rolelessId, org.id),
      )
      expect(before.roles).toEqual([])

      const role = await seed(app, org.id, "roles.create", {
        name: "Desk",
        scopes: ["tickets:tickets:read"],
        dimensions: { sensitivity: ["restricted"] },
      })
      expect(role.status).toBe(200)
      const assigned = await seed(app, org.id, "roles.assign", {
        roleId: role.body.data?.roleId as string,
        userId: rolelessId,
      })
      expect(assigned.status).toBe(200)
      const after = await withPrivilegedDb(org.id, "seed-route-test:assigned", (tx) =>
        loadEffectivePermissions(tx, rolelessId, org.id),
      )
      expect(after.scopes).toContain("tickets:tickets:read")

      const admin = await orgAdmin(org.id)
      const ticket = await seed(app, org.id, "tickets.ticket", { subject: "Referenced" })
      const ticketId = ticket.body.data?.id as string
      const refs = await seed(app, org.id, "threads.referencing", {
        userId: admin.id,
        app: "tickets",
        entityType: "ticket",
        entityId: ticketId,
        count: 3,
      })
      expect(refs.status).toBe(200)
      expect(new Set(refs.body.data?.threadIds as string[]).size).toBe(3)
      const [n] = await withPrivilegedDb(org.id, "seed-route-test:refs", async (tx) =>
        rowsOf<{ n: number }>(
          await tx.execute(
            sql`SELECT count(*)::int AS n FROM kernel.thread_references
                WHERE entity_id = ${ticketId} AND app = 'tickets'`,
          ),
        ),
      )
      expect(n?.n).toBe(3)

      const member = await person(org.id)
      const conv = await seed(app, org.id, "threads.conversation", {
        userId: admin.id,
        title: "Seeded conversation",
        participantUserIds: [member.id, admin.id],
      })
      expect(conv.status).toBe(200)
      const members = await withPrivilegedDb(org.id, "seed-route-test:conversation", async (tx) =>
        rowsOf<{ user_id: string }>(
          await tx.execute(
            sql`SELECT user_id FROM kernel.thread_participants
                WHERE thread_id = ${conv.body.data?.threadId as string}::uuid AND user_id IS NOT NULL`,
          ),
        ),
      )
      expect(members.map((m) => m.user_id).sort()).toEqual([admin.id, member.id].sort())
    },
    TIMEOUT_MS,
  )

  test(
    "a person's own dimension grant, set then taken away",
    async () => {
      const org = await createTestOrg()
      const app = await buildTestApp()
      const member = await person(org.id)
      const granted = await seed(app, org.id, "people.grantDimension", {
        userId: member.id,
        dimension: "team",
        values: ["eng-leads"],
      })
      expect(granted.status).toBe(200)
      const perms = () =>
        withPrivilegedDb(org.id, "seed-route-test:user-dim", (tx) =>
          loadEffectivePermissions(tx, member.id, org.id),
        )
      expect(JSON.stringify((await perms()).dimensionGrants)).toContain("eng-leads")
      const revoked = await seed(app, org.id, "people.revokeDimension", {
        userId: member.id,
        dimension: "team",
      })
      expect(revoked.status).toBe(200)
      expect(JSON.stringify((await perms()).dimensionGrants)).not.toContain("eng-leads")
    },
    TIMEOUT_MS,
  )

  test(
    "connections.mock: sealed with the server's key, adopted on a repeat",
    async () => {
      const org = await createTestOrg()
      const app = await buildTestApp()
      const admin = await orgAdmin(org.id)
      const args = {
        appName: "gitlab",
        connectionName: "gitlab",
        ownerType: "org",
        userId: admin.id,
        identifier: "acme",
        displayName: "E2E GitLab",
        kind: { type: "credentials", credentials: { token: "glpat-x", group: "acme" } },
      }
      const first = await seed(app, org.id, "connections.mock", args)
      expect(first.status).toBe(200)
      expect(first.body.data?.created).toBe(true)
      const again = await seed(app, org.id, "connections.mock", args)
      expect(again.body.data).toMatchObject({ id: first.body.data?.id, created: false })
      const [row] = await withPrivilegedDb(org.id, "seed-route-test:connection", async (tx) =>
        rowsOf<{ credentials_encrypted: string; owner_id: string | null }>(
          await tx.execute(
            sql`SELECT credentials_encrypted, owner_id FROM kernel.connected_accounts
                WHERE id = ${first.body.data?.id as string}::uuid`,
          ),
        ),
      )
      expect(row?.owner_id).toBeNull()
      const plain = decryptSecret(
        row?.credentials_encrypted as string,
        env.ENCRYPTION_KEY,
        CryptoContext.connectedAccountCredentials,
      )
      expect(JSON.parse(plain)).toEqual({ token: "glpat-x", group: "acme" })

      const drive = await seed(app, org.id, "connections.mock", {
        appName: "google-drive",
        connectionName: "drive",
        ownerType: "user",
        userId: admin.id,
        identifier: "e2e-fake-drive@example.com",
        displayName: "E2E Drive",
        kind: { type: "oauth2" },
      })
      expect(drive.status).toBe(200)

      const orgDrive = await seed(app, org.id, "connections.mock", {
        appName: "google-drive",
        connectionName: "drive",
        ownerType: "org",
        userId: admin.id,
        identifier: "org-drive@example.com",
        displayName: "Org Drive",
        metadata: { sharedDrives: [{ id: "DRIVE0001", name: "Shared" }] },
        kind: { type: "oauth2", accessToken: "org-access", refreshToken: "org-refresh" },
      })
      expect(orgDrive.status).toBe(200)
      const [orgRow] = await withPrivilegedDb(org.id, "seed-route-test:connection", async (tx) =>
        rowsOf<{ refresh_token_encrypted: string; metadata: unknown }>(
          await tx.execute(
            sql`SELECT refresh_token_encrypted, metadata FROM kernel.connected_accounts
                WHERE id = ${orgDrive.body.data?.id as string}::uuid`,
          ),
        ),
      )
      expect(orgRow?.metadata).toEqual({ sharedDrives: [{ id: "DRIVE0001", name: "Shared" }] })
      expect(
        decryptSecret(
          orgRow?.refresh_token_encrypted as string,
          env.ENCRYPTION_KEY,
          CryptoContext.connectedAccountRefreshToken,
        ),
      ).toBe("org-refresh")
    },
    TIMEOUT_MS,
  )

  test(
    "mail: a mailbox on its connection (adopted on a repeat), a conversation with its messages, more messages",
    async () => {
      const org = await createTestOrg()
      const app = await buildTestApp()
      const admin = await orgAdmin(org.id)
      const email = "seed-route-box@e2e.test"
      const box = await seed(app, org.id, "mail.account", {
        ownerType: "user",
        userId: admin.id,
        email,
      })
      expect(box.status).toBe(200)
      const accountId = box.body.data?.accountId as string
      const again = await seed(app, org.id, "mail.account", {
        ownerType: "user",
        userId: admin.id,
        email,
      })
      expect(again.body.data?.accountId).toBe(accountId)

      const janeId = await contact(org.id, "jane@customer.example", { name: "Jane" })
      const conv = await seed(app, org.id, "mail.conversation", {
        accountId,
        subject: "Order status",
        labels: ["INBOX"],
        contactId: janeId,
        messages: [
          {
            direction: "inbound",
            from: { name: "Jane", email: "jane@customer.example" },
            to: [{ email }],
            textBody: "When does my order ship?",
            sentAt: "2026-01-01T10:00:00.000Z",
            rawHeaders: { "message-id": "<1@e2e.web>", subject: "Order status" },
          },
        ],
      })
      expect(conv.status).toBe(200)
      const conversationId = conv.body.data?.conversationId as string
      expect(conv.body.data?.messageIds).toHaveLength(1)

      const more = await seed(app, org.id, "mail.messages", {
        conversationId,
        messages: [
          {
            direction: "outbound",
            from: { email },
            to: [{ email: "jane@customer.example" }],
            textBody: "It ships tomorrow.",
            sentByUserId: admin.id,
          },
        ],
      })
      expect(more.status).toBe(200)

      const [row] = await withPrivilegedDb(org.id, "seed-route-test:mail", async (tx) =>
        rowsOf<{
          owner_type: string
          owner_id: string | null
          message_count: number
          snippet: string
          connected: string
          contact_id: string | null
          encryption_state: string
          header_keys: string[]
        }>(
          await tx.execute(
            sql`SELECT c.owner_type, c.owner_id, c.message_count, c.snippet,
                       ca.identifier AS connected, c.contact_id::text AS contact_id,
                       a.encryption_state,
                       (SELECT array_agg(k ORDER BY k) FROM app_mail.messages m,
                               jsonb_object_keys(m.raw_headers) k
                         WHERE m.conversation_id = c.id) AS header_keys
                FROM app_mail.conversations c
                JOIN app_mail.accounts a ON a.id = c.account_id
                JOIN kernel.connected_accounts ca ON ca.id = a.connected_account_id
                WHERE c.id = ${conversationId}::uuid`,
          ),
        ),
      )
      expect(row).toMatchObject({
        owner_type: "user",
        owner_id: admin.id,
        message_count: 2,
        snippet: "It ships tomorrow.",
        connected: email,
        contact_id: janeId,
        // An unarmed personal mailbox: the accounts trigger stamps it at birth.
        encryption_state: "pending_enrollment",
        header_keys: ["message-id", "subject"],
      })
    },
    TIMEOUT_MS,
  )

  test(
    "mail.injectInbound runs the tickets matcher: dropped with no inbox, then a new ticket",
    async () => {
      const org = await createTestOrg()
      const app = await buildTestApp()
      const none = await seed(app, org.id, "mail.injectInbound", {
        fromEmail: "early@customer.test",
        subject: "Before any inbox",
        textBody: "Hello?",
        messageId: "inject-none-1",
      })
      expect(none.status).toBe(200)
      expect(none.body.data).toMatchObject({ outcome: "dropped", reason: "no_inbox" })

      const inbox = await seed(app, org.id, "tickets.inbox", {
        name: "Support",
        emailAddress: "support@inject.test",
      })
      expect(inbox.status).toBe(200)
      const created = await seed(app, org.id, "mail.injectInbound", {
        fromEmail: "customer@customer.test",
        fromName: "A Customer",
        subject: "My order is late",
        textBody: "Where is my order?",
        messageId: "inject-1",
      })
      expect(created.status).toBe(200)
      expect(created.body.data?.outcome).toBe("created")
      const ticketId = created.body.data?.ticketId as string
      expect(typeof ticketId).toBe("string")
      const row = await ticketRow(org.id, ticketId)
      expect(row?.message_count).toBe(1)
    },
    TIMEOUT_MS,
  )

  test(
    "threads.injectMessage writes the author type and metadata as given, only on the org's threads",
    async () => {
      const org = await createTestOrg()
      const app = await buildTestApp()
      const admin = await orgAdmin(org.id)
      const threadId = await thread(org.id, admin.id, { title: "Sub-run host" })
      const injected = await seed(app, org.id, "threads.injectMessage", {
        threadId,
        authorId: admin.id,
        content: "Sub-run finished",
        metadata: { kind: "sub_run", subRunId: "sr-1" },
      })
      expect(injected.status).toBe(200)
      const id = injected.body.data?.id as string
      const [msg] = await withPrivilegedDb(org.id, "seed-route-test:message", async (tx) =>
        rowsOf<{ author_type: string; metadata: Record<string, unknown> | null }>(
          await tx.execute(
            sql`SELECT author_type, metadata FROM kernel.messages WHERE id = ${id}::uuid`,
          ),
        ),
      )
      expect(msg?.author_type).toBe("agent")
      expect(msg?.metadata).toEqual({ kind: "sub_run", subRunId: "sr-1" })

      const foreign = await seed(app, randomUUID(), "threads.injectMessage", {
        threadId,
        authorId: admin.id,
        content: "Not here",
      })
      expect(foreign.status).toBe(422)
    },
    TIMEOUT_MS,
  )

  test(
    "calendar.account connects, imports and syncs through the engine; forceReauth flips its status",
    async () => {
      const org = await createTestOrg()
      const app = await buildTestApp()
      const admin = await orgAdmin(org.id)
      const seeded = await seed(app, org.id, "calendar.account", {
        userId: admin.id,
        ownerType: "user",
        identifier: "me@calendar.test",
      })
      expect(seeded.status).toBe(200)
      const accountId = seeded.body.data?.accountId as string
      const calendarId = seeded.body.data?.calendarId as string
      const read = async () =>
        withPrivilegedDb(org.id, "seed-route-test:calendar", async (tx) => {
          const [account] = rowsOf<{ sync_status: string; connected_account_id: string }>(
            await tx.execute(
              sql`SELECT sync_status, connected_account_id FROM app_calendar.accounts WHERE id = ${accountId}::uuid`,
            ),
          )
          const [events] = rowsOf<{ n: number }>(
            await tx.execute(
              sql`SELECT count(*)::int AS n FROM app_calendar.events WHERE calendar_id = ${calendarId}::uuid`,
            ),
          )
          return { account, events: events?.n }
        })
      const before = await read()
      expect(before.account?.connected_account_id).toBeTruthy()
      expect(before.events).toBe(3)

      const reauth = await seed(app, org.id, "calendar.forceReauth", { accountId })
      expect(reauth.status).toBe(200)
      expect((await read()).account?.sync_status).toBe("reauth-required")
    },
    TIMEOUT_MS,
  )

  test(
    "persona.step acknowledges and persona.messages lists nothing, with no org",
    async () => {
      const app = await buildTestApp()
      const step = await seed(app, undefined, "persona.step", { persona: "sofia", step: "triage" })
      expect(step.body.data).toEqual({ ok: true, persona: "sofia", step: "triage" })
      const msgs = await seed(app, undefined, "persona.messages", { persona: "sofia" })
      expect(msgs.body.data).toEqual({ messages: [] })
    },
    TIMEOUT_MS,
  )

  describe("org.second", () => {
    const create = (app: App, email: string, withData = true) =>
      seed(app, undefined, "org.second", {
        orgName: "Org B (test)",
        adminEmail: email,
        adminPassword: "Passw0rd!",
        adminName: "Org B Admin",
        withData,
      })

    async function login(app: App, email: string): Promise<{ authorization: string }> {
      const res = await app.request("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: "Passw0rd!" }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { data: { accessToken: string } }
      return { authorization: `Bearer ${body.data.accessToken}` }
    }

    test(
      "an org-scoped factory needs an orgId; org.second does not",
      async () => {
        await createTestOrg()
        const app = await buildTestApp()
        const missing = await seed(app, undefined, "tickets.ticket", { subject: "x" })
        expect(missing.status).toBe(400)
        expect(missing.body.error?.message).toContain("orgId required")
      },
      TIMEOUT_MS,
    )

    test(
      "makes a loginable org with its own thread and contact, and adopts it on a repeat",
      async () => {
        await createTestOrg()
        const app = await buildTestApp()
        const email = `orgb-${crypto.randomUUID().slice(0, 8)}@cross-org.test`
        const first = await create(app, email)
        expect(first.status).toBe(200)
        const orgB = first.body.data as {
          orgId: string
          threadId: string
          contactId: string
          created: boolean
        }
        expect(orgB.created).toBe(true)
        expect(orgB.threadId).toBeTruthy()
        expect(orgB.contactId).toBeTruthy()

        const hdrB = await login(app, email)
        const orgRes = await app.request("/api/org", { headers: hdrB })
        expect(orgRes.status).toBe(200)
        expect(JSON.stringify(await orgRes.json())).toContain("Org B (test)")
        expect((await app.request(`/api/threads/${orgB.threadId}`, { headers: hdrB })).status).toBe(
          200,
        )
        expect((await app.request("/api/credits/balance", { headers: hdrB })).status).toBe(200)

        const again = await create(app, email)
        expect(again.body.data).toMatchObject({
          orgId: orgB.orgId,
          threadId: orgB.threadId,
          contactId: orgB.contactId,
          created: false,
        })
      },
      TIMEOUT_MS,
    )

    test(
      "the two orgs cannot see each other's threads or contacts",
      async () => {
        const orgA = await createTestOrg()
        const adminA = await orgAdmin(orgA.id)
        const secretThreadId = await thread(orgA.id, adminA.id, { title: "Org A secret" })
        const secretContactId = await contact(orgA.id, "secret@orga.test")
        const app = await buildTestApp()
        const email = `orgb-${crypto.randomUUID().slice(0, 8)}@cross-org.test`
        const orgB = (await create(app, email)).body.data as { threadId: string }
        const hdrB = await login(app, email)
        const hdrA = { authorization: `Bearer ${(await adminSession(orgA.id)).bearer}` }

        const threadsB = JSON.stringify(
          await (await app.request("/api/threads", { headers: hdrB })).json(),
        )
        expect(threadsB).not.toContain(secretThreadId)
        expect(threadsB).toContain(orgB.threadId)
        const contactsB = await app.request("/api/contacts", { headers: hdrB })
        expect(contactsB.status).toBe(200)
        expect(JSON.stringify(await contactsB.json())).not.toContain(secretContactId)
        expect(
          (await app.request(`/api/threads/${secretThreadId}`, { headers: hdrB })).status,
        ).toBe(404)
        expect(
          (await app.request(`/api/contacts/${secretContactId}`, { headers: hdrB })).status,
        ).toBe(404)

        const threadsA = JSON.stringify(
          await (await app.request("/api/threads", { headers: hdrA })).json(),
        )
        expect(threadsA).toContain(secretThreadId)
        expect(threadsA).not.toContain(orgB.threadId)
        expect((await app.request(`/api/threads/${orgB.threadId}`, { headers: hdrA })).status).toBe(
          404,
        )
      },
      TIMEOUT_MS,
    )
  })
  describe("agent factories", () => {
    test(
      "pricing.catalog seeds the models and the rate; credits.balance sets exact amounts",
      async () => {
        const org = await createTestOrg()
        const app = await buildTestApp()
        expect((await seed(app, undefined, "pricing.catalog", {})).status).toBe(200)
        const set = await seed(app, org.id, "credits.balance", {
          included: "7.5",
          purchased: "3",
        })
        expect(set.status).toBe(200)
        const lower = await seed(app, org.id, "credits.balance", {
          included: "2",
          purchased: "1.25",
        })
        expect(lower.status).toBe(200)
        const [counts] = await withPrivilegedDb(org.id, "seed-route-test:pricing", async (tx) =>
          rowsOf<{ models: number; rate: number; included: string; purchased: string }>(
            await tx.execute(
              sql`SELECT (SELECT count(*)::int FROM kernel.model_pricing) AS models,
                         (SELECT count(*)::int FROM kernel.system_config WHERE key = 'usd_eur_rate') AS rate,
                         b.included_balance::text AS included, b.purchased_balance::text AS purchased
                    FROM kernel.credit_balances b WHERE b.org_id = ${org.id}::uuid`,
            ),
          ),
        )
        expect(counts?.models).toBeGreaterThan(0)
        expect(counts?.rate).toBe(1)
        expect(Number(counts?.included)).toBe(2)
        expect(Number(counts?.purchased)).toBe(1.25)
      },
      TIMEOUT_MS,
    )

    test(
      "roles.revokeScope takes a role scope away and roles.restoreScope gives it back",
      async () => {
        const org = await createTestOrg()
        const app = await buildTestApp()
        const p = await person(org.id, { name: "Scope Person", email: "scope-p@seed.test" })
        const scope = "kernel:skills:write"
        const granted = await seed(app, org.id, "roles.grantScopes", {
          userId: p.id,
          scopes: [scope],
        })
        expect(granted.status).toBe(200)
        const scopesOf = async () =>
          (
            await withPrivilegedDb(org.id, "seed-route-test:perms", (tx) =>
              loadEffectivePermissions(tx, p.id, org.id),
            )
          ).scopes
        expect(await scopesOf()).toContain(scope)
        const revoked = await seed(app, org.id, "roles.revokeScope", { userId: p.id, scope })
        expect(revoked.status).toBe(200)
        expect(revoked.body.data?.roleIds).toEqual([granted.body.data?.roleId])
        expect(await scopesOf()).not.toContain(scope)
        const restored = await seed(app, org.id, "roles.restoreScope", {
          userId: p.id,
          scope,
          ...revoked.body.data,
        })
        expect(restored.status).toBe(200)
        expect(await scopesOf()).toContain(scope)
        expect((await seed(app, org.id, "agents.alignOwnCeiling", { userId: p.id })).status).toBe(
          200,
        )
      },
      TIMEOUT_MS,
    )

    test(
      "threads.agentChat, subAgents.definition, agents.role and routines.runs write through the product",
      async () => {
        const org = await createTestOrg()
        const app = await buildTestApp()
        const admin = await orgAdmin(org.id)
        const chat = await seed(app, org.id, "threads.agentChat", { userId: admin.id })
        expect(chat.status).toBe(200)
        const def = await seed(app, org.id, "subAgents.definition", {
          agentType: "seed-investigator",
          whenToUse: "seeded role",
          scopeCeiling: ["kernel:threads:read"],
          systemPrompt: "seeded",
          defaultMaxSteps: 5,
        })
        expect(def.status).toBe(200)
        expect(def.body.data?.agentType).toBe("seed-investigator")
        const role = await seed(app, org.id, "agents.role", {
          handle: "@seed-desk",
          displayName: "Seed Desk",
        })
        expect(role.status).toBe(200)
        expect(role.body.data?.handle).toBe("@seed-desk")

        const routineId = await seedRoutine(seedContext({ orgId: org.id, now: new Date() }), {
          createdByUserId: admin.id,
          ownerScopes: ["*"],
          routine: {
            name: "seed-route-routine",
            description: "d",
            kind: "recurring",
            cron: "0 8 * * *",
            timezone: "UTC",
            ownerUserId: admin.id,
            ownerAgentId: (await seedBaseAgent(org.id)).agentId,
            scopes: [],
            prompt: "p",
          },
        })
        const runs = await seed(app, org.id, "routines.runs", {
          routineName: "seed-route-routine",
          runs: [
            {
              startedAt: "2026-10-16T08:00:00Z",
              durationMs: 1000,
              status: "succeeded",
              trigger: "manual",
            },
            {
              startedAt: null,
              ranAt: "2026-10-14T08:00:09Z",
              durationMs: 9000,
              status: "failed",
              trigger: null,
              error: "x",
              turnsAdded: null,
            },
          ],
        })
        expect(runs.status).toBe(200)
        const count = async () =>
          (
            await withPrivilegedDb(org.id, "seed-route-test:runs", async (tx) =>
              rowsOf<{ n: number }>(
                await tx.execute(
                  sql`SELECT count(*)::int AS n FROM kernel.routine_runs WHERE routine_id = ${routineId}::uuid`,
                ),
              ),
            )
          )[0]?.n
        expect(await count()).toBe(2)
        await seed(app, org.id, "routines.runs", { routineName: "seed-route-routine", runs: [] })
        expect(await count()).toBe(0)
      },
      TIMEOUT_MS,
    )
  })
})
