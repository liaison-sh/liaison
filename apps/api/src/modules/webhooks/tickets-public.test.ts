// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeAll, describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { Hono } from "hono"
import { searchTickets } from "~/apps/tickets/search"
import { extractRows } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { ticketsPublicRoutes } from "./tickets-public"

const app = new Hono().route("/webhooks", ticketsPublicRoutes)
const TEST_ORG = "00000000-0000-0000-0000-000000000001"

function postCreate(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return Promise.resolve(
    app.fetch(
      new Request(`http://x/webhooks/${TEST_ORG}/tickets/create`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    ),
  )
}

async function seedApiKey(plaintext: string): Promise<void> {
  await withSystemDb("tickets-public-test-api-key", async (tx) => {
    await tx.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${TEST_ORG}, 'Tickets Public Test', 'tickets-public-test')
      ON CONFLICT (id) DO NOTHING
    `)
    await tx.execute(drizzleSql`
      INSERT INTO app_tickets.api_keys (org_id, key_hash, key_prefix, label, allowed_origins, created_by)
      VALUES (
        ${TEST_ORG},
        ${createHash("sha256").update(plaintext).digest("hex")},
        ${plaintext.slice(0, 8)},
        'test key',
        '[]'::jsonb,
        '00000000-0000-0000-0000-000000000000'
      )
      ON CONFLICT (org_id, key_hash) DO NOTHING
    `)
  })
}

describe("tickets-public CORS preflight", () => {
  it("OPTIONS returns 204 with permissive CORS headers", async () => {
    const res = await app.fetch(
      new Request("http://x/webhooks/00000000-0000-0000-0000-000000000001/tickets/create", {
        method: "OPTIONS",
        headers: { origin: "https://customer.test" },
      }),
    )
    expect(res.status).toBe(204)
    expect(res.headers.get("access-control-allow-origin")).toBe("https://customer.test")
    expect(res.headers.get("access-control-allow-methods")).toContain("POST")
  })
})

describe("tickets-public body size cap", () => {
  it("rejects bodies over 51200 bytes with 413", async () => {
    const big = "x".repeat(60_000)
    const res = await app.fetch(
      new Request("http://x/webhooks/00000000-0000-0000-0000-000000000001/tickets/create", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(big.length),
        },
        body: JSON.stringify({ blob: big }),
      }),
    )
    expect(res.status).toBe(413)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("payload_too_large")
  })

  it("measures the body cap in bytes, not JavaScript characters", async () => {
    const body = JSON.stringify({ blob: "💥".repeat(13_000) })
    expect(body.length).toBeLessThan(51_200)
    const res = await app.fetch(
      new Request("http://x/webhooks/00000000-0000-0000-0000-000000000001/tickets/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
    )
    expect(res.status).toBe(413)
  })
})

describe("tickets-public invalid auth header", () => {
  it("returns 401 invalid_api_key when Authorization is malformed", async () => {
    const res = await postCreate(
      { subject: "x", fromEmail: "a@x.test" },
      { authorization: "Token not-an-api-key" },
    )
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("invalid_api_key")
  })
})

describe("tickets-public invalid JSON", () => {
  it("returns 400 invalid_json on malformed body", async () => {
    const res = await postCreate("{not-json")
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("invalid_json")
  })
})

describe("tickets-public payload validation", () => {
  it("requires subject, email, and a body before side effects", async () => {
    const missingSubject = await postCreate({ fromEmail: "a@x.test", textBody: "hello" })
    expect(missingSubject.status).toBe(400)
    expect(((await missingSubject.json()) as any).error.code).toBe("validation_failed")

    const invalidEmail = await postCreate({ subject: "Hello", fromEmail: "bad", textBody: "hello" })
    expect(invalidEmail.status).toBe(400)
    expect(((await invalidEmail.json()) as any).error.code).toBe("validation_failed")

    const missingBody = await postCreate({ subject: "Hello", fromEmail: "a@x.test" })
    expect(missingBody.status).toBe(400)
    expect(((await missingBody.json()) as any).error.code).toBe("validation_failed")
  })

  it("ignores API-key-only fields for anonymous validation", async () => {
    const res = await postCreate({
      subject: "Honeypot",
      fromEmail: "a@x.test",
      textBody: "hello",
      honeypot: "filled",
      sourceInboxId: "not-a-uuid",
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).data.received).toBe(true)
  })

  it("validates API-keyed tier fields", async () => {
    const plaintext = `test-key-${Date.now()}`
    await seedApiKey(plaintext)

    const res = await postCreate(
      {
        subject: "API keyed",
        fromEmail: "a@x.test",
        textBody: "hello",
        sourceInboxId: "not-a-uuid",
      },
      { authorization: `Bearer ${plaintext}` },
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error.code).toBe("validation_failed")
  })
})

async function seedClosedTicket(
  externalRef: string,
  overrides: { mergedIntoTicketId?: string } = {},
): Promise<string> {
  return withPrivilegedDb(TEST_ORG, "tickets-public-test-seed-closed", async (tx) => {
    const rows = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO app_tickets.tickets
          (org_id, handle, subject, channel, reply_token, sla_target_seconds, sla_deadline,
           status, closed_reason, external_ref, last_outbound_at, merged_into_ticket_id,
           requester_email)
        VALUES (
          ${TEST_ORG}, ${`ap-${externalRef}`}, 'Original subject', 'email', ${`tok-${externalRef}`},
          3600, now() + interval '1 day', 'closed', 'resolved', ${externalRef}, now(),
          ${overrides.mergedIntoTicketId ?? null}, 'customer@example.com'
        )
        RETURNING id`),
    )
    return rows[0]!.id
  })
}

describe("tickets-public appendIfExisting reopens a closed ticket", () => {
  beforeAll(async () => {
    // recordInboundOnTicket's reopen path resumes the ticket's SLA clock,
    // which reads org settings -- seed the org row and the tickets app
    // defaults for TEST_ORG (both idempotent) so that path does not throw
    // "settings not seeded".
    await withSystemDb("tickets-public-test-org-seed", async (tx) => {
      await tx.execute(drizzleSql`
        INSERT INTO kernel.organizations (id, name, slug)
        VALUES (${TEST_ORG}, 'Tickets Public Test', 'tickets-public-test')
        ON CONFLICT (id) DO NOTHING
      `)
    })
    await ensureAppsForOrg(TEST_ORG, {})
  })

  it("a customer follow up on a CLOSED ticket reopens it and puts it back in needs attention", async () => {
    const plaintext = `test-key-append-${Date.now()}-${Math.random()}`
    await seedApiKey(plaintext)
    const externalRef = `ext-reopen-${Date.now()}-${Math.random()}`
    const ticketId = await seedClosedTicket(externalRef)

    const res = await postCreate(
      {
        subject: "Re: Original subject",
        fromEmail: "customer@example.com",
        textBody: "It's still broken, please help.",
        externalRef,
        appendIfExisting: true,
      },
      { authorization: `Bearer ${plaintext}` },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data.appended).toBe(true)
    expect(body.data.ticketId).toBe(ticketId)

    const row = extractRows<{
      status: string
      closed_reason: string | null
      last_inbound_at: Date | null
      last_outbound_at: Date | null
    }>(
      await withPrivilegedDb(TEST_ORG, "tickets-public-test-assert-reopen", (tx) =>
        tx.execute(
          drizzleSql`SELECT status, closed_reason, last_inbound_at, last_outbound_at FROM app_tickets.tickets WHERE id = ${ticketId} AND org_id = ${TEST_ORG}`,
        ),
      ),
    )[0]!
    expect(row.status).toBe("open")
    expect(row.closed_reason).toBeNull()
    expect(row.last_inbound_at).not.toBeNull()
    expect(new Date(row.last_inbound_at as Date).getTime()).toBeGreaterThan(
      new Date(row.last_outbound_at as Date).getTime(),
    )

    const searchResult = await withPrivilegedDb(TEST_ORG, "tickets-public-test-search", (tx) =>
      searchTickets(tx as never, TEST_ORG, { smartFilter: "needs-attention", limit: 100 } as never),
    )
    expect(searchResult.items.map((i) => (i as Record<string, unknown>).id)).toContain(ticketId)
  })

  it("a follow up on a MERGED source lands on the merge leaf, not the source", async () => {
    const plaintext = `test-key-mergeleaf-${Date.now()}-${Math.random()}`
    await seedApiKey(plaintext)
    const leafExternalRef = `ext-leaf-${Date.now()}-${Math.random()}`
    const leafId = await seedClosedTicket(leafExternalRef)
    const sourceExternalRef = `ext-source-${Date.now()}-${Math.random()}`
    const sourceId = await seedClosedTicket(sourceExternalRef, { mergedIntoTicketId: leafId })
    await withPrivilegedDb(TEST_ORG, "tickets-public-test-mark-merged", (tx) =>
      tx.execute(
        drizzleSql`UPDATE app_tickets.tickets SET closed_reason = 'merged' WHERE id = ${sourceId} AND org_id = ${TEST_ORG}`,
      ),
    )

    const res = await postCreate(
      {
        subject: "Re: Original subject",
        fromEmail: "customer@example.com",
        textBody: "Following up on the merged thread.",
        externalRef: sourceExternalRef,
        appendIfExisting: true,
      },
      { authorization: `Bearer ${plaintext}` },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data.ticketId).toBe(leafId)
    expect(body.data.ticketId).not.toBe(sourceId)

    const messageOnLeaf = extractRows<{ id: string }>(
      await withPrivilegedDb(TEST_ORG, "tickets-public-test-assert-leaf-msg", (tx) =>
        tx.execute(
          drizzleSql`SELECT id FROM app_tickets.messages WHERE ticket_id = ${leafId} AND org_id = ${TEST_ORG}`,
        ),
      ),
    )
    expect(messageOnLeaf.length).toBe(1)
    const messageOnSource = extractRows<{ id: string }>(
      await withPrivilegedDb(TEST_ORG, "tickets-public-test-assert-source-msg", (tx) =>
        tx.execute(
          drizzleSql`SELECT id FROM app_tickets.messages WHERE ticket_id = ${sourceId} AND org_id = ${TEST_ORG}`,
        ),
      ),
    )
    expect(messageOnSource.length).toBe(0)
  })
})

describe("tickets-public appendIfExisting survives an org with no tickets settings seeded", () => {
  const NO_SETTINGS_ORG = "00000000-0000-0000-0000-0000000ba591"

  beforeAll(async () => {
    // Deliberately do NOT call ensureAppsForOrg: the org row exists but has
    // no tickets settings, so the reopen path's loadTicketsSlaSettings
    // throws "tickets settings not seeded for org".
    await withSystemDb("tickets-public-test-no-settings-org-seed", async (tx) => {
      await tx.execute(drizzleSql`
        INSERT INTO kernel.organizations (id, name, slug)
        VALUES (${NO_SETTINGS_ORG}, 'Tickets Public No Settings', 'tickets-public-no-settings')
        ON CONFLICT (id) DO NOTHING
      `)
    })
  })

  async function seedNoSettingsClosedTicket(externalRef: string): Promise<string> {
    return withPrivilegedDb(
      NO_SETTINGS_ORG,
      "tickets-public-test-seed-closed-nosettings",
      async (tx) => {
        const rows = extractRows<{ id: string }>(
          await tx.execute(drizzleSql`
          INSERT INTO app_tickets.tickets
            (org_id, handle, subject, channel, reply_token, sla_target_seconds, sla_deadline,
             status, closed_reason, external_ref, last_outbound_at, requester_email)
          VALUES (
            ${NO_SETTINGS_ORG}, ${`ap-ns-${externalRef}`}, 'Original subject', 'email', ${`tok-ns-${externalRef}`},
            3600, now() + interval '1 day', 'closed', 'resolved', ${externalRef}, now(),
            'customer@example.com'
          )
          RETURNING id`),
        )
        return rows[0]!.id
      },
    )
  }

  async function seedNoSettingsApiKey(plaintext: string): Promise<void> {
    await withSystemDb("tickets-public-test-no-settings-api-key", async (tx) => {
      await tx.execute(drizzleSql`
        INSERT INTO app_tickets.api_keys (org_id, key_hash, key_prefix, label, allowed_origins, created_by)
        VALUES (
          ${NO_SETTINGS_ORG},
          ${createHash("sha256").update(plaintext).digest("hex")},
          ${plaintext.slice(0, 8)},
          'test key',
          '[]'::jsonb,
          '00000000-0000-0000-0000-000000000000'
        )
        ON CONFLICT (org_id, key_hash) DO NOTHING
      `)
    })
  }

  function postCreateNoSettingsOrg(
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return Promise.resolve(
      app.fetch(
        new Request(`http://x/webhooks/${NO_SETTINGS_ORG}/tickets/create`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: typeof body === "string" ? body : JSON.stringify(body),
        }),
      ),
    )
  }

  it("a follow up still lands when the org has no tickets settings seeded", async () => {
    const plaintext = `test-key-nosettings-${Date.now()}-${Math.random()}`
    await seedNoSettingsApiKey(plaintext)
    const externalRef = `ext-nosettings-${Date.now()}-${Math.random()}`
    const ticketId = await seedNoSettingsClosedTicket(externalRef)

    const res = await postCreateNoSettingsOrg(
      {
        subject: "Re: Original subject",
        fromEmail: "customer@example.com",
        textBody: "Still broken, org has no settings seeded.",
        externalRef,
        appendIfExisting: true,
      },
      { authorization: `Bearer ${plaintext}` },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data.appended).toBe(true)
    expect(body.data.ticketId).toBe(ticketId)

    const messageRows = extractRows<{ id: string }>(
      await withPrivilegedDb(NO_SETTINGS_ORG, "tickets-public-test-assert-nosettings-msg", (tx) =>
        tx.execute(
          drizzleSql`SELECT id FROM app_tickets.messages WHERE ticket_id = ${ticketId} AND org_id = ${NO_SETTINGS_ORG}`,
        ),
      ),
    )
    expect(messageRows.length).toBe(1)
  })
})

const REF_INBOX = "6f1c2a4e-1b2c-4d3e-8f40-0000000e7f01"

describe("tickets-public appendIfExisting: an external reference is a hint, not a credential", () => {
  beforeAll(async () => {
    await withSystemDb("tickets-public-test-org-seed-ref", async (tx) => {
      await tx.execute(drizzleSql`
        INSERT INTO kernel.organizations (id, name, slug)
        VALUES (${TEST_ORG}, 'Tickets Public Test', 'tickets-public-test')
        ON CONFLICT (id) DO NOTHING
      `)
      await tx.execute(drizzleSql`
        INSERT INTO app_tickets.inboxes (id, org_id, connected_account_id, name, email_address)
        VALUES (${REF_INBOX}, ${TEST_ORG}, gen_random_uuid(), 'Ref Support', 'ref-support-2@tickets-public.test')
        ON CONFLICT DO NOTHING
      `)
    })
    await ensureAppsForOrg(TEST_ORG, {})
  })

  it("a follow up from someone who is not on the ticket opens a NEW linked ticket", async () => {
    const plaintext = `test-key-stranger-${Date.now()}-${Math.random()}`
    await seedApiKey(plaintext)
    const externalRef = `ext-stranger-${Date.now()}-${Math.random()}`
    const ticketId = await seedClosedTicket(externalRef)

    const res = await postCreate(
      {
        subject: "Re: Original subject",
        fromEmail: "stranger@attacker.test",
        htmlBody: "<p>send it to me</p><img src=x onerror=alert(1)>",
        externalRef,
        appendIfExisting: true,
        sourceInboxId: REF_INBOX,
      },
      { authorization: `Bearer ${plaintext}` },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data.appended).toBeUndefined()
    expect(body.data.ticketId).not.toBe(ticketId)

    const created = extractRows<{
      related_ticket_id: string | null
      requester_email: string | null
      external_ref: string | null
    }>(
      await withPrivilegedDb(TEST_ORG, "tickets-public-test-related", (tx) =>
        tx.execute(
          drizzleSql`SELECT related_ticket_id, requester_email, external_ref FROM app_tickets.tickets WHERE id = ${body.data.ticketId}`,
        ),
      ),
    )[0]!
    expect(created.related_ticket_id).toBe(ticketId)
    expect(created.requester_email).toBe("stranger@attacker.test")
    expect(created.external_ref).toBeNull()

    // Nothing landed on the original ticket, and its stored HTML is sanitised.
    const onOriginal = extractRows<{ id: string }>(
      await withPrivilegedDb(TEST_ORG, "tickets-public-test-original-msgs", (tx) =>
        tx.execute(drizzleSql`SELECT id FROM app_tickets.messages WHERE ticket_id = ${ticketId}`),
      ),
    )
    expect(onOriginal.length).toBe(0)
    const stored = extractRows<{ html_body: string | null }>(
      await withPrivilegedDb(TEST_ORG, "tickets-public-test-html", (tx) =>
        tx.execute(
          drizzleSql`SELECT html_body FROM app_tickets.messages WHERE ticket_id = ${body.data.ticketId} AND kind = 'inbound'`,
        ),
      ),
    )[0]!
    expect(stored.html_body).not.toContain("onerror")
  })
})

describe("tickets-public browser keys (keys with allowed origins)", () => {
  async function seedBrowserKey(plaintext: string): Promise<void> {
    await withSystemDb("tickets-public-test-browser-key", async (tx) => {
      await tx.execute(drizzleSql`
        INSERT INTO app_tickets.api_keys (org_id, key_hash, key_prefix, label, allowed_origins, created_by)
        VALUES (
          ${TEST_ORG},
          ${createHash("sha256").update(plaintext).digest("hex")},
          ${plaintext.slice(0, 8)},
          'browser key',
          '["https://shop.customer.test"]'::jsonb,
          '00000000-0000-0000-0000-000000000000'
        )
        ON CONFLICT (org_id, key_hash) DO NOTHING
      `)
    })
  }

  it.each([
    ["team", { team: "finance" }],
    ["sensitivity", { sensitivity: "restricted" }],
    ["assignedTo", { assignedTo: "6f1c2a4e-1b2c-4d3e-8f40-000000000009" }],
    ["contactId", { contactId: "6f1c2a4e-1b2c-4d3e-8f40-000000000009" }],
    ["attachmentFileIds", { attachmentFileIds: ["6f1c2a4e-1b2c-4d3e-8f40-000000000009"] }],
    ["appendIfExisting", { appendIfExisting: true, externalRef: "x" }],
    ["externalRef", { externalRef: "order-1001" }],
  ])("refuses a server-only field (%s)", async (_name, extra) => {
    const plaintext = `test-key-browser-${Date.now()}-${Math.random()}`
    await seedBrowserKey(plaintext)
    const res = await postCreate(
      { subject: "Hello", fromEmail: "a@customer.test", textBody: "hi", ...extra },
      { authorization: `Bearer ${plaintext}`, origin: "https://shop.customer.test" },
    )
    expect(res.status).toBe(403)
    expect(((await res.json()) as any).error.code).toBe("browser_key_field_not_allowed")
  })

  it("cannot stage attachment files", async () => {
    const plaintext = `test-key-browser-up-${Date.now()}-${Math.random()}`
    await seedBrowserKey(plaintext)
    const form = new FormData()
    form.append("file", new Blob([new Uint8Array([1, 2, 3])], { type: "text/plain" }), "a.txt")
    const res = await app.fetch(
      new Request(`http://x/webhooks/${TEST_ORG}/tickets/attachments`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${plaintext}`,
          origin: "https://shop.customer.test",
        },
        body: form,
      }),
    )
    expect(res.status).toBe(403)
    expect(((await res.json()) as any).error.code).toBe("browser_key_cannot_upload")
  })
})
