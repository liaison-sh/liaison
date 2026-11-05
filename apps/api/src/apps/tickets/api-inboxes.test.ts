// SPDX-License-Identifier: FSL-1.1-ALv2
//
// First-class API inboxes: a receiving bucket (bug reports, website contact, a
// per-tenant endpoint) with NO connected mail account, whose replies are sent
// through a reply-via mailbox -- so an org keeps ONE reply-from identity
// (support@) across every bucket (inbox != reply-from). Proves: api-inbox
// create with no account, mailbox create still requires an account, reply-via
// validation, an api inbox can't be default-for-create (DB CHECK), ticketsMove
// between inboxes (org-scoped), and loadInboxAndProvider's reply decoupling.

import { beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { runAdminOp } from "~/apps/tickets/admin"
import { createTicket } from "~/apps/tickets/create"
import { loadInboxAndProvider, ticketsClose } from "~/apps/tickets/tools"
import { extractRows } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { ensureAppsForOrg } from "~/modules/apps/init"

let orgId: string
let userId: string
let supportAccountId: string
let supportInboxId: string // the org's default-for-create mailbox (support@fabrikam.test)

const rows = (r: unknown): any[] => (r as any).rows ?? r

beforeAll(async () => {
  const slug = `apiinbox-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await withSystemDb("api-inbox-fixture", async (tx) => {
    orgId = rows(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.organizations (id, name, slug)
        VALUES (gen_random_uuid(), 'API Inbox Test', ${slug}) RETURNING id`),
    )[0].id
    userId = rows(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${orgId}, ${`u-${slug}@x.test`}, 'A', 'active', 'h', 1, 1) RETURNING id`),
    )[0].id
    supportAccountId = rows(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.connected_accounts
          (id, org_id, app_name, connection_name, owner_type, owner_id, provider_type, identifier, status, created_by, access_token_encrypted)
        VALUES (gen_random_uuid(), ${orgId}, 'tickets', 'gmail', 'org', null, 'oauth2', 'support@fabrikam.test', 'active', ${userId}, 'enc')
        RETURNING id`),
    )[0].id
    supportInboxId = rows(
      await tx.execute(drizzleSql`
        INSERT INTO app_tickets.inboxes
          (id, org_id, kind, connected_account_id, name, email_address, from_display_name, is_default_for_create, created_at, updated_at)
        VALUES (gen_random_uuid(), ${orgId}, 'mailbox', ${supportAccountId}, 'Support', 'support@fabrikam.test', 'Fabrikam Support', true, now(), now())
        RETURNING id`),
    )[0].id
  })
  await ensureAppsForOrg(orgId, {})
})

const actor = () => ({ actorType: "user" as const, userId })
const admin = (op: string, params: Record<string, unknown>) =>
  withPrivilegedDb(orgId, "api-inbox-test", (tx) =>
    runAdminOp(tx as never, orgId, op, params, actor()),
  )

describe("tickets: API inboxes (routing bucket, decoupled from reply-from)", () => {
  it("creates an API inbox with NO connected account", async () => {
    const created = (await admin("inboxesCreate", {
      kind: "api",
      name: "Bug Reports",
    })) as Record<string, unknown>
    expect(created.id).toBeTruthy()
    expect(created.kind).toBe("api")
    expect(created.connected_account_id).toBeNull()
    expect(created.email_address).toBeNull()
    expect(created.is_default_for_create).toBe(false)
    expect(created.suppress_attention).toBe(false)
  })

  it("suppressAttention: settable at create, togglable via update, surfaced by list", async () => {
    const created = (await admin("inboxesCreate", {
      kind: "api",
      name: "Monitoring Bucket",
      suppressAttention: true,
    })) as Record<string, unknown>
    expect(created.suppress_attention).toBe(true)

    await admin("inboxesUpdate", { id: created.id, suppressAttention: false })
    let list = (await admin("inboxesList", {})) as Array<Record<string, unknown>>
    expect(list.find((i) => i.id === created.id)?.suppress_attention).toBe(false)

    await admin("inboxesUpdate", { id: created.id, suppressAttention: true })
    list = (await admin("inboxesList", {})) as Array<Record<string, unknown>>
    expect(list.find((i) => i.id === created.id)?.suppress_attention).toBe(true)
  })

  it("mailbox inbox create still requires a connected account (unchanged)", async () => {
    const r = (await admin("inboxesCreate", {
      kind: "mailbox",
      name: "X",
      emailAddress: "x@y.test",
    })) as { error?: { code?: string } }
    expect(r.error?.code).toBe("invalid_params")
  })

  it("rejects a reply-via that is not a connected mailbox inbox", async () => {
    const apiA = (await admin("inboxesCreate", { kind: "api", name: "Bucket A" })) as {
      id: string
    }
    const r = (await admin("inboxesCreate", {
      kind: "api",
      name: "Website",
      replyViaInboxId: apiA.id,
    })) as { error?: { code?: string } }
    expect(r.error?.code).toBe("reply_via_not_mailbox")
  })

  it("accepts a reply-via that IS a connected mailbox inbox", async () => {
    const r = (await admin("inboxesCreate", {
      kind: "api",
      name: "Website tickets",
      replyViaInboxId: supportInboxId,
    })) as Record<string, unknown>
    expect(r.id).toBeTruthy()
    expect(r.reply_via_inbox_id).toBe(supportInboxId)
  })

  it("inboxesList surfaces kind + reply fields", async () => {
    const list = (await admin("inboxesList", {})) as Array<Record<string, unknown>>
    const api = list.find((x) => x.name === "Bug Reports")
    expect(api?.kind).toBe("api")
    expect("reply_via_inbox_id" in (api ?? {})).toBe(true)
    expect("reply_from_email" in (api ?? {})).toBe(true)
  })

  it("an API inbox cannot be made default-for-create (DB CHECK)", async () => {
    const created = (await admin("inboxesCreate", { kind: "api", name: "NoDefault" })) as {
      id: string
    }
    await expect(
      admin("inboxesUpdate", { id: created.id, isDefaultForCreate: true }),
    ).rejects.toThrow()
  })

  it("moves a ticket from the mailbox inbox into an API inbox (org-scoped)", async () => {
    const bug = (await admin("inboxesCreate", { kind: "api", name: "MoveTarget" })) as {
      id: string
    }
    const created = (await withPrivilegedDb(orgId, "api-inbox-test", (tx) =>
      createTicket(
        tx as never,
        orgId,
        {
          subject: "Move me",
          sourceInboxId: supportInboxId,
          channel: "api",
          contactEmail: "cust@x.test",
          initialMessage: { kind: "inbound", fromEmail: "cust@x.test", textBody: "hello" },
        },
        actor(),
      ),
    )) as { ticketId?: string; error?: unknown }
    expect(created.ticketId).toBeTruthy()

    const moved = (await admin("ticketsMove", {
      toInboxId: bug.id,
      ticketIds: [created.ticketId],
    })) as { moved: string[]; count: number }
    expect(moved.count).toBe(1)
    expect(moved.moved).toContain(created.ticketId!)

    const row = extractRows<{ source_inbox_id: string; source_account_id: string | null }>(
      await withPrivilegedDb(orgId, "api-inbox-test", (tx) =>
        tx.execute(drizzleSql`
          SELECT source_inbox_id, source_account_id FROM app_tickets.tickets
          WHERE id = ${created.ticketId}::uuid AND org_id = ${orgId}::uuid`),
      ),
    )[0]
    expect(row.source_inbox_id).toBe(bug.id)
    expect(row.source_account_id).toBeNull() // an API inbox has no send account
  })

  it("SLA exemption: an sla_exempt inbox's tickets get NO deadline/clock; normal inboxes unchanged", async () => {
    const monitoring = (await admin("inboxesCreate", {
      kind: "api",
      name: "Bug Reports (SLA exempt)",
      slaExempt: true,
    })) as { id: string; sla_exempt?: boolean }
    expect(monitoring.sla_exempt).toBe(true)

    // Configurable per inbox via inboxesUpdate (the MCP / settings-UI config path).
    await admin("inboxesUpdate", { id: monitoring.id, slaExempt: false })
    let list = (await admin("inboxesList", {})) as Array<Record<string, unknown>>
    expect(list.find((i) => i.id === monitoring.id)?.sla_exempt).toBe(false)
    await admin("inboxesUpdate", { id: monitoring.id, slaExempt: true })
    list = (await admin("inboxesList", {})) as Array<Record<string, unknown>>
    expect(list.find((i) => i.id === monitoring.id)?.sla_exempt).toBe(true)

    const exempt = (await withPrivilegedDb(orgId, "api-inbox-test", (tx) =>
      createTicket(
        tx as never,
        orgId,
        {
          subject: "Bug report: no SLA",
          sourceInboxId: monitoring.id,
          channel: "web_form",
          contactEmail: "reporter@x.test",
          initialMessage: { kind: "inbound", fromEmail: "reporter@x.test", textBody: "telemetry" },
        },
        actor(),
      ),
    )) as { ticketId?: string }
    expect(exempt.ticketId).toBeTruthy()

    const exemptRow = extractRows<{
      sla_deadline: Date | null
      sla_active_started_at: Date | null
      sla_target_seconds: number
    }>(
      await withPrivilegedDb(orgId, "api-inbox-test", (tx) =>
        tx.execute(drizzleSql`
          SELECT sla_deadline, sla_active_started_at, sla_target_seconds
          FROM app_tickets.tickets WHERE id = ${exempt.ticketId}::uuid AND org_id = ${orgId}::uuid`),
      ),
    )[0]
    // No live SLA: null deadline + null clock. sla_target_seconds stays populated
    // (NOT NULL column, kept for reference) but nothing ever breaches.
    expect(exemptRow.sla_deadline).toBeNull()
    expect(exemptRow.sla_active_started_at).toBeNull()
    expect(exemptRow.sla_target_seconds).toBeGreaterThan(0)

    // A ticket in the normal (non-suppressed) support inbox still gets an SLA.
    const normal = (await withPrivilegedDb(orgId, "api-inbox-test", (tx) =>
      createTicket(
        tx as never,
        orgId,
        {
          subject: "Customer question",
          sourceInboxId: supportInboxId,
          channel: "email",
          contactEmail: "cust@x.test",
          initialMessage: { kind: "inbound", fromEmail: "cust@x.test", textBody: "hi" },
        },
        actor(),
      ),
    )) as { ticketId?: string }
    const normalRow = extractRows<{
      sla_deadline: Date | null
      sla_active_started_at: Date | null
    }>(
      await withPrivilegedDb(orgId, "api-inbox-test", (tx) =>
        tx.execute(drizzleSql`
          SELECT sla_deadline, sla_active_started_at FROM app_tickets.tickets
          WHERE id = ${normal.ticketId}::uuid AND org_id = ${orgId}::uuid`),
      ),
    )[0]
    expect(normalRow.sla_deadline).not.toBeNull()
    expect(normalRow.sla_active_started_at).not.toBeNull()
  })

  it("ticketsMove ignores a foreign/unknown ticket id (org-scoped, no cross-org move)", async () => {
    const bug = (await admin("inboxesCreate", { kind: "api", name: "MoveTarget2" })) as {
      id: string
    }
    const r = (await admin("ticketsMove", {
      toInboxId: bug.id,
      ticketIds: [crypto.randomUUID()],
    })) as { count: number }
    expect(r.count).toBe(0)
  })

  it("resolves an API inbox's reply identity + transport to the default mailbox (always reply from support@)", async () => {
    const bucket = (await admin("inboxesCreate", { kind: "api", name: "ReplyBucket" })) as {
      id: string
    }
    const resolved = await withPrivilegedDb(orgId, "api-inbox-test", (db) =>
      loadInboxAndProvider(db as never, orgId, bucket.id),
    )
    expect(resolved).not.toBeNull()
    expect(resolved?.email_address).toBe("support@fabrikam.test")
    expect(resolved?.identifier).toBe("support@fabrikam.test")
    expect(resolved?.provider_type).toBe("oauth2")
  })

  it("honours a per-source reply_from_email override while still sending via the mailbox", async () => {
    const bucket = (await admin("inboxesCreate", {
      kind: "api",
      name: "OverrideBucket",
      replyFromEmail: "bugs@fabrikam.test",
    })) as { id: string }
    const resolved = await withPrivilegedDb(orgId, "api-inbox-test", (db) =>
      loadInboxAndProvider(db as never, orgId, bucket.id),
    )
    expect(resolved?.email_address).toBe("bugs@fabrikam.test") // From override
    expect(resolved?.identifier).toBe("support@fabrikam.test") // transport still the support account
  })

  it("closing needs no mail account; a closing message with no sendable mailbox fails with an actionable error", async () => {
    // A mailbox inbox whose account was disconnected: nothing can send for it.
    const inboxId = rows(
      await withSystemDb("api-inbox-fixture", async (tx) => {
        const acct = rows(
          await tx.execute(drizzleSql`
            INSERT INTO kernel.connected_accounts
              (id, org_id, app_name, connection_name, owner_type, owner_id, provider_type, identifier, status, created_by, access_token_encrypted)
            VALUES (gen_random_uuid(), ${orgId}, 'tickets', 'gmail', 'org', null, 'oauth2', 'gone@fabrikam.test', 'disconnected', ${userId}, 'enc')
            RETURNING id`),
        )[0].id
        return tx.execute(drizzleSql`
          INSERT INTO app_tickets.inboxes
            (id, org_id, kind, connected_account_id, name, email_address, created_at, updated_at)
          VALUES (gen_random_uuid(), ${orgId}, 'mailbox', ${acct}, 'Gone', 'gone@fabrikam.test', now(), now())
          RETURNING id`)
      }),
    )[0].id as string
    const newTicket = async (subject: string) =>
      (
        (await withPrivilegedDb(orgId, "api-inbox-test", (tx) =>
          createTicket(
            tx as never,
            orgId,
            {
              subject,
              sourceInboxId: inboxId,
              channel: "api",
              contactEmail: "cust@x.test",
              initialMessage: { kind: "inbound", fromEmail: "cust@x.test", textBody: "hello" },
            },
            actor(),
          ),
        )) as { ticketId: string }
      ).ticketId
    const close = (ticketId: string, textBody?: string) =>
      withPrivilegedDb(orgId, "api-inbox-test", (tx) =>
        ticketsClose(
          { ticketId, closedReason: "resolved", textBody },
          { tx: tx as never, orgId, actor: actor() },
        ),
      )

    const withMessage = (await close(await newTicket("Close with note"), "Thanks")) as {
      error?: { code: string; message: string }
    }
    expect(withMessage.error?.code).toBe("send_preflight_failed")
    expect(withMessage.error?.message).toMatch(/reconnect/i)
    expect(withMessage.error?.message).toMatch(/without a message/i)
    expect(withMessage.error?.message).not.toContain("inbox or account not found")

    const silentId = await newTicket("Close silently")
    const silent = (await close(silentId)) as { ok?: boolean; status?: string }
    expect(silent.ok).toBe(true)
    const status = extractRows<{ status: string }>(
      await withPrivilegedDb(orgId, "api-inbox-test", (tx) =>
        tx.execute(drizzleSql`
          SELECT status FROM app_tickets.tickets WHERE id = ${silentId}::uuid AND org_id = ${orgId}::uuid`),
      ),
    )[0]
    expect(status.status).toBe("closed")
  })

  it("a mailbox inbox still resolves to its OWN account (no regression)", async () => {
    const resolved = await withPrivilegedDb(orgId, "api-inbox-test", (db) =>
      loadInboxAndProvider(db as never, orgId, supportInboxId),
    )
    expect(resolved?.email_address).toBe("support@fabrikam.test")
    expect(resolved?.identifier).toBe("support@fabrikam.test")
  })
})

describe("tickets: per-inbox email identity config (Task 1)", () => {
  it("creates a mailbox inbox with the schema defaults", async () => {
    // A NEW inbox created without overrides gets the schema-level defaults
    // (ack_enabled true, sla_promise_phrase default) and no email identity.
    const created = (await admin("inboxesCreate", {
      kind: "api",
      name: "Fresh Bucket",
    })) as Record<string, unknown>
    expect(created.ack_enabled).toBe(true)
    expect(created.sla_promise_phrase).toBe("within 2 business days")
  })

  it("creates an inbox with a full custom email identity", async () => {
    const created = (await admin("inboxesCreate", {
      kind: "api",
      name: "Custom Identity Bucket",
      fromDisplayName: "Acme Care",
      replyToEmail: "care@acme.test",
      signatureHtml: "<p>The Acme Team</p>",
      signatureText: "The Acme Team",
      ackEnabled: false,
      ackBodyText: "Thanks, we will be in touch.",
      slaPromisePhrase: "within 1 business day",
    })) as Record<string, unknown>
    expect(created.from_display_name).toBe("Acme Care")
    expect(created.reply_to_email).toBe("care@acme.test")
    expect(created.signature_html).toBe("<p>The Acme Team</p>")
    expect(created.signature_text).toBe("The Acme Team")
    expect(created.ack_enabled).toBe(false)
    expect(created.ack_body_text).toBe("Thanks, we will be in touch.")
    expect(created.sla_promise_phrase).toBe("within 1 business day")
  })

  it("updates an inbox's email identity fields independently", async () => {
    const created = (await admin("inboxesCreate", { kind: "api", name: "Updatable Bucket" })) as {
      id: string
    }
    const updated = (await admin("inboxesUpdate", {
      id: created.id,
      replyToEmail: "hello@acme.test",
      signatureHtml: "<p>Signed</p>",
      ackEnabled: false,
      slaPromisePhrase: "within 24 hours",
    })) as Record<string, unknown>
    expect(updated.id).toBe(created.id)

    const list = (await admin("inboxesList", {})) as Array<Record<string, unknown>>
    const row = list.find((i) => i.id === created.id)
    expect(row?.reply_to_email).toBe("hello@acme.test")
    expect(row?.signature_html).toBe("<p>Signed</p>")
    expect(row?.ack_enabled).toBe(false)
    expect(row?.sla_promise_phrase).toBe("within 24 hours")
    // Untouched fields survive a partial update.
    expect(row?.name).toBe("Updatable Bucket")
  })

  it("inboxesList surfaces per-inbox connection health from the backing account", async () => {
    // Healthy mailbox inbox: active account -> ok. API inbox (no account) -> null.
    let list = (await admin("inboxesList", {})) as Array<Record<string, unknown>>
    const mailbox = list.find((i) => i.id === supportInboxId)
    expect(mailbox?.connection_health).toMatchObject({ status: "ok", connection: "gmail" })
    const apiInbox = list.find((i) => i.kind === "api")
    if (apiInbox) expect(apiInbox.connection_health).toBeNull()

    // Flip the account to a terminal error: the inbox must report
    // needs_reconnect with the reason and status message.
    await withSystemDb("api-inbox-health-error", async (tx) => {
      await tx.execute(drizzleSql`
        UPDATE kernel.connected_accounts
        SET status = 'error', status_message = 'Authorization expired, reconnect required'
        WHERE id = ${supportAccountId}`)
    })
    try {
      list = (await admin("inboxesList", {})) as Array<Record<string, unknown>>
      expect(list.find((i) => i.id === supportInboxId)?.connection_health).toMatchObject({
        status: "needs_reconnect",
        connection: "gmail",
        reason: "error",
        statusMessage: "Authorization expired, reconnect required",
      })
    } finally {
      await withSystemDb("api-inbox-health-restore", async (tx) => {
        await tx.execute(drizzleSql`
          UPDATE kernel.connected_accounts
          SET status = 'active', status_message = NULL
          WHERE id = ${supportAccountId}`)
      })
    }
  })

  it("inboxesList surfaces every per-inbox email identity field", async () => {
    const list = (await admin("inboxesList", {})) as Array<Record<string, unknown>>
    const row = list[0] ?? {}
    for (const key of [
      "reply_to_email",
      "signature_html",
      "signature_text",
      "ack_enabled",
      "ack_body_text",
      "sla_promise_phrase",
    ]) {
      expect(key in row).toBe(true)
    }
  })

  it("loadInboxAndProvider surfaces the per-inbox ack config from the SOURCE inbox", async () => {
    const bucket = (await admin("inboxesCreate", {
      kind: "api",
      name: "AckConfigBucket",
      ackEnabled: false,
      slaPromisePhrase: "within 3 business days",
    })) as { id: string }
    const resolved = await withPrivilegedDb(orgId, "api-inbox-test", (db) =>
      loadInboxAndProvider(db as never, orgId, bucket.id),
    )
    expect(resolved?.ack_enabled).toBe(false)
    expect(resolved?.sla_promise_phrase).toBe("within 3 business days")
  })
})

// Reply-signature contract (WYSIWYG): the send path appends nothing; the
// effective signature is served to composers (tickets_get) and injected into
// AGENT drafts pre-approval via tools.draftSignature. Precedence: inbox
// signature_text first, else the acting user's personal signature.
describe("tickets: draft signature resolution", () => {
  let sigTicketId: string

  beforeAll(async () => {
    const created = (await withPrivilegedDb(orgId, "api-inbox-test", (tx) =>
      createTicket(
        tx as never,
        orgId,
        {
          subject: "Signature contract",
          sourceInboxId: supportInboxId,
          channel: "api",
          contactEmail: "sig-cust@x.test",
          initialMessage: { kind: "inbound", fromEmail: "sig-cust@x.test", textBody: "hello" },
        },
        actor(),
      ),
    )) as { ticketId: string }
    sigTicketId = created.ticketId
    await withSystemDb("sig-fixture", async (tx) => {
      await tx.execute(drizzleSql`
        UPDATE kernel.users
        SET settings = COALESCE(settings, '{}'::jsonb)
          || '{"tickets": {"signature": {"text": "Best,\\nAlex from Acme"}}}'::jsonb
        WHERE id = ${userId}`)
    })
  })

  const draftSignature = (actorType: "user" | "agent") =>
    withPrivilegedDb(orgId, "api-inbox-test", (tx) =>
      runAdminOp(tx as never, orgId, "tools.draftSignature", { ticketId: sigTicketId }, {
        actorType,
        userId,
      } as never),
    ) as Promise<{ signatureText: string | null; signatureHtml: string | null }>

  it("agent drafts get the inbox signature when one is configured", async () => {
    await admin("inboxesUpdate", { id: supportInboxId, signatureText: "The Fabrikam Team" })
    const sig = await draftSignature("agent")
    expect(sig.signatureText).toBe("The Fabrikam Team")
    expect(sig.signatureHtml).toBe("The Fabrikam Team")
  })

  it("agent drafts fall back to the acting user's personal signature when the inbox has none", async () => {
    await admin("inboxesUpdate", { id: supportInboxId, signatureText: null })
    const sig = await draftSignature("agent")
    expect(sig.signatureText).toBe("Best,\nAlex from Acme")
    expect(sig.signatureHtml).toBe("Best,<br>Alex from Acme")
  })

  it("human actors get NO injected signature (their composer prefilled it)", async () => {
    const sig = await draftSignature("user")
    expect(sig.signatureText).toBeNull()
    expect(sig.signatureHtml).toBeNull()
  })

  it("returns nulls when neither inbox nor user has a signature", async () => {
    await withSystemDb("sig-fixture", async (tx) => {
      await tx.execute(drizzleSql`
        UPDATE kernel.users
        SET settings = settings - 'tickets'
        WHERE id = ${userId}`)
    })
    const sig = await draftSignature("agent")
    expect(sig.signatureText).toBeNull()
    expect(sig.signatureHtml).toBeNull()
  })
})
