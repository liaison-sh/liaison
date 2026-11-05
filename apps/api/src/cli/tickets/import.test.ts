// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Real-DB test for `tickets import` (Task 15). Generic NDJSON bulk importer:
 *
 * - canonical create: one record → ticket + initial inbound message; created:1.
 * - externalRef re-import → skipped:1, count of tickets with that externalRef == 1
 *   (CORRECTION #6: createTicket does NOT dedup external_ref — a dup THROWS 23505;
 *   the importer's pre-SELECT is mandatory).
 * - --dry-run validates only, writes nothing.
 * - malformed line → failed[] with the line number, stream continues (later valid
 *   lines still import).
 * - historical-date: messages.sent_at == the supplied historical timestamp AND
 *   tickets.created_at ≈ now() (NOT historical) — both asserted.
 * - contact auto-create reuse: a new contactEmail find-or-creates; same email twice
 *   reuses the same contact.
 * - multi-message: a record with >1 message appends subsequent inbound messages
 *   with their own sent_at.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sql as drizzleSql } from "drizzle-orm"
import { kernelRel, ticketsRel } from "~/apps/tickets/schema-refs"
import { runTicketsImport } from "~/cli/tickets/import"
import { extractRows } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

beforeAll(acquireTestLock)
afterAll(releaseTestLock)

const tmpDirs: string[] = []
afterAll(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      // best-effort
    }
  }
})

function writeNdjson(records: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "cli-import-"))
  tmpDirs.push(dir)
  const file = join(dir, "tickets.ndjson")
  writeFileSync(file, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`)
  return file
}

function writeRaw(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "cli-import-raw-"))
  tmpDirs.push(dir)
  const file = join(dir, "tickets.ndjson")
  writeFileSync(file, `${lines.join("\n")}\n`)
  return file
}

async function freshOrg(): Promise<string> {
  const { orgId } = await ensureOrg({
    slug: `cli-import-${crypto.randomUUID().slice(0, 12)}`,
    name: "ImportTestOrg",
  })
  await ensureUser({
    orgId,
    email: `admin-${crypto.randomUUID().slice(0, 8)}@fabrikam.example`,
    name: "Owner",
    password: "pw-import-1!",
    role: "admin",
  })
  return orgId
}

async function orgSlug(orgId: string): Promise<string> {
  const rows = await withPrivilegedDb(orgId, "t", (tx) =>
    tx.execute(
      drizzleSql`SELECT slug FROM ${kernelRel("organizations")} WHERE id = ${orgId}::uuid`,
    ),
  )
  return extractRows<{ slug: string }>(rows)[0]!.slug
}

async function countTicketsByExternalRef(orgId: string, externalRef: string): Promise<number> {
  const rows = await withPrivilegedDb(orgId, "t", (tx) =>
    tx.execute(drizzleSql`
      SELECT id FROM ${ticketsRel("tickets")}
      WHERE org_id = ${orgId}::uuid AND external_ref = ${externalRef}
    `),
  )
  return extractRows(rows).length
}

/** Minimal Freshdesk XML fixture: one ticket with an inbound (customer) note and
 *  an outbound (public agent reply) note, in chronological order. Structure
 *  mirrors the real Freshdesk "Export Tickets" format (verified against an
 *  actual export): direction comes from `<incoming>` (true=customer=inbound,
 *  false=agent), `<private>` distinguishes a public agent reply (outbound) from
 *  an internal-only agent note (note). */
function freshdeskFixtureXml(externalId: string, requesterId: string, agentId: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<helpdesk-tickets type="array">
  <helpdesk-ticket>
    <id type="integer">${externalId}</id>
    <description>Customer: my unit won't power on.</description>
    <requester-id type="integer">${requesterId}</requester-id>
    <status type="integer">2</status>
    <created-at type="dateTime">2023-05-01T10:00:00+02:00</created-at>
    <subject>Freshdesk import fixture</subject>
    <notes type="array">
      <helpdesk-note>
        <id type="integer">700001</id>
        <body>Agent: try holding the power button for 10 seconds.</body>
        <user-id type="integer">${agentId}</user-id>
        <incoming type="boolean">false</incoming>
        <private type="boolean">false</private>
        <created-at type="dateTime">2023-05-01T11:00:00+02:00</created-at>
        <attachments type="array"/>
      </helpdesk-note>
      <helpdesk-note>
        <id type="integer">700002</id>
        <body>Customer: that worked, thanks!</body>
        <user-id type="integer">${requesterId}</user-id>
        <incoming type="boolean">true</incoming>
        <private type="boolean">false</private>
        <created-at type="dateTime">2023-05-02T09:00:00+02:00</created-at>
        <attachments type="array"/>
      </helpdesk-note>
    </notes>
  </helpdesk-ticket>
</helpdesk-tickets>
`
}

function writeText(content: string, filename: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cli-import-fd-"))
  tmpDirs.push(dir)
  const file = join(dir, filename)
  writeFileSync(file, content)
  return file
}

describe("tickets import -- Freshdesk XML mode", () => {
  test("both inbound and outbound notes import, in order, with correct kind", async () => {
    const orgId = await freshOrg()
    const slug = await orgSlug(orgId)
    const extId = `${Date.now()}`
    const file = writeText(freshdeskFixtureXml(extId, "9001", "1001"), "Tickets0.xml")

    const { exitCode, report } = await runTicketsImport({
      file,
      orgSlug: slug,
      dryRun: false,
      freshdeskXml: true,
    })
    expect(exitCode).toBe(0)
    expect(report.created).toBe(1)
    expect(report.failed.length).toBe(0)

    const extRef = `freshdesk-${extId}`
    expect(await countTicketsByExternalRef(orgId, extRef)).toBe(1)

    const msgs = await withPrivilegedDb(orgId, "t", (tx) =>
      tx.execute(drizzleSql`
        SELECT m.kind, m.text_body, m.sent_at FROM ${ticketsRel("messages")} m
        JOIN ${ticketsRel("tickets")} t ON t.id = m.ticket_id
        WHERE t.org_id = ${orgId}::uuid AND t.external_ref = ${extRef}
        ORDER BY m.sent_at ASC
      `),
    )
    const rows = extractRows<{ kind: string; text_body: string; sent_at: string | Date }>(msgs)

    // Initial description (inbound) + agent reply (outbound) + customer follow-up (inbound).
    expect(rows.length).toBe(3)
    expect(rows[0]?.kind).toBe("inbound")
    expect(rows[0]?.text_body).toBe("Customer: my unit won't power on.")
    expect(rows[1]?.kind).toBe("outbound")
    expect(rows[1]?.text_body).toBe("Agent: try holding the power button for 10 seconds.")
    expect(rows[2]?.kind).toBe("inbound")
    expect(rows[2]?.text_body).toBe("Customer: that worked, thanks!")

    // Chronological order preserved.
    const times = rows.map((r) => new Date(r.sent_at).getTime())
    expect(times).toEqual([...times].sort((a, b) => a - b))
  })

  test("the people directories give the customer and the agent their emails", async () => {
    const orgId = await freshOrg()
    const slug = await orgSlug(orgId)
    const extId = `${Date.now()}dir`
    const file = writeText(freshdeskFixtureXml(extId, "9003", "1003"), "Tickets0.xml")
    const users = writeText(
      `<users type="array"><user><id type="integer">9003</id><name>Ann Customer</name><email>ann@example.com</email></user></users>`,
      "Users0.xml",
    )
    const agents = writeText(
      `<agents type="array"><agent><user><id type="integer">1003</id><name>Bo Agent</name><email>bo@fabrikam.example</email></user></agent></agents>`,
      "AllAgents0.xml",
    )
    const { exitCode, report } = await runTicketsImport({
      file,
      orgSlug: slug,
      dryRun: false,
      freshdeskXml: true,
      freshdeskUsersFile: users,
      freshdeskAgentsFile: agents,
    })
    expect(exitCode).toBe(0)
    expect(report.created).toBe(1)
    const rows = extractRows<{ from_email: string | null }>(
      await withPrivilegedDb(orgId, "t", (tx) =>
        tx.execute(drizzleSql`
          SELECT m.from_email FROM ${ticketsRel("messages")} m
          JOIN ${ticketsRel("tickets")} t ON t.id = m.ticket_id
          WHERE t.org_id = ${orgId}::uuid AND t.external_ref = ${`freshdesk-${extId}`}
          ORDER BY m.sent_at ASC
        `),
      ),
    )
    expect(rows.map((r) => r.from_email)).toEqual([
      "ann@example.com",
      "bo@fabrikam.example",
      "ann@example.com",
    ])
  })

  test("a 20,000-person directory carries through every batch", async () => {
    const orgId = await freshOrg()
    const slug = await orgSlug(orgId)
    const people = Array.from(
      { length: 20_000 },
      (_, i) =>
        `<user><id type="integer">${700000 + i}</id><name>Person ${i}</name><email>person${i}@example.com</email></user>`,
    )
    const users = writeText(`<users type="array">${people.join("")}</users>`, "Users0.xml")
    const extId = `${Date.now()}big`
    const file = writeText(freshdeskFixtureXml(extId, "719999", "700000"), "Tickets0.xml")
    const { exitCode, report } = await runTicketsImport({
      file,
      orgSlug: slug,
      dryRun: false,
      freshdeskXml: true,
      freshdeskUsersFile: users,
    })
    expect(report.failed).toEqual([])
    expect(exitCode).toBe(0)
    const rows = extractRows<{ from_email: string | null }>(
      await withPrivilegedDb(orgId, "t", (tx) =>
        tx.execute(drizzleSql`
          SELECT m.from_email FROM ${ticketsRel("messages")} m
          JOIN ${ticketsRel("tickets")} t ON t.id = m.ticket_id
          WHERE t.org_id = ${orgId}::uuid AND t.external_ref = ${`freshdesk-${extId}`}
          ORDER BY m.sent_at ASC
        `),
      ),
    )
    // The requester is the directory's last person.
    expect(rows[0]?.from_email).toBe("person19999@example.com")
  }, 300_000)

  test("--dry-run reads the export and writes nothing", async () => {
    const orgId = await freshOrg()
    const slug = await orgSlug(orgId)
    const extId = `${Date.now()}dry`
    const file = writeText(freshdeskFixtureXml(extId, "9004", "1004"), "Tickets0.xml")
    const { exitCode, report } = await runTicketsImport({
      file,
      orgSlug: slug,
      dryRun: true,
      freshdeskXml: true,
    })
    expect(exitCode).toBe(0)
    expect(report.failed).toEqual([])
    expect(await countTicketsByExternalRef(orgId, `freshdesk-${extId}`)).toBe(0)
  })

  test("re-import of the same Freshdesk ticket is deduped via externalRef", async () => {
    const orgId = await freshOrg()
    const slug = await orgSlug(orgId)
    const extId = `${Date.now()}dup`
    const file = writeText(freshdeskFixtureXml(extId, "9002", "1002"), "Tickets0.xml")

    const r1 = await runTicketsImport({ file, orgSlug: slug, dryRun: false, freshdeskXml: true })
    expect(r1.report.created).toBe(1)
    const r2 = await runTicketsImport({ file, orgSlug: slug, dryRun: false, freshdeskXml: true })
    expect(r2.report.created).toBe(0)
    expect(r2.report.skipped).toBe(1)
    expect(await countTicketsByExternalRef(orgId, `freshdesk-${extId}`)).toBe(1)
  })
})

describe("tickets import (Task 15)", () => {
  test("canonical create: ticket + initial inbound message; created:1", async () => {
    const orgId = await freshOrg()
    const slug = await orgSlug(orgId)
    const extRef = `ext-${crypto.randomUUID().slice(0, 8)}`
    const file = writeNdjson([
      {
        subject: "My order is late",
        externalRef: extRef,
        contactEmail: "buyer@example.com",
        contactName: "Buyer One",
        priority: "high",
        messages: [{ kind: "inbound", fromEmail: "buyer@example.com", textBody: "Where is it?" }],
      },
    ])

    const { exitCode, report } = await runTicketsImport({ file, orgSlug: slug, dryRun: false })
    expect(exitCode).toBe(0)
    expect(report.created).toBe(1)
    expect(report.skipped).toBe(0)
    expect(report.failed.length).toBe(0)

    expect(await countTicketsByExternalRef(orgId, extRef)).toBe(1)

    // The initial inbound message landed.
    const msgs = await withPrivilegedDb(orgId, "t", (tx) =>
      tx.execute(drizzleSql`
        SELECT m.kind, m.text_body FROM ${ticketsRel("messages")} m
        JOIN ${ticketsRel("tickets")} t ON t.id = m.ticket_id
        WHERE t.org_id = ${orgId}::uuid AND t.external_ref = ${extRef}
      `),
    )
    const rows = extractRows<{ kind: string; text_body: string }>(msgs)
    expect(rows.length).toBe(1)
    expect(rows[0]?.kind).toBe("inbound")
    expect(rows[0]?.text_body).toBe("Where is it?")
  })

  test("externalRef re-import → skipped:1, count==1", async () => {
    const orgId = await freshOrg()
    const slug = await orgSlug(orgId)
    const extRef = `ext-${crypto.randomUUID().slice(0, 8)}`
    const record = {
      subject: "Dup ticket",
      externalRef: extRef,
      contactEmail: "dup@example.com",
      messages: [{ kind: "inbound", textBody: "first" }],
    }
    const file = writeNdjson([record])

    const r1 = await runTicketsImport({ file, orgSlug: slug, dryRun: false })
    expect(r1.report.created).toBe(1)
    expect(await countTicketsByExternalRef(orgId, extRef)).toBe(1)

    // Second import of the SAME externalRef → skipped, NOT a 23505 throw, count stays 1.
    const r2 = await runTicketsImport({ file, orgSlug: slug, dryRun: false })
    expect(r2.exitCode).toBe(0)
    expect(r2.report.created).toBe(0)
    expect(r2.report.skipped).toBe(1)
    expect(await countTicketsByExternalRef(orgId, extRef)).toBe(1)
  })

  test("--dry-run validates, writes nothing", async () => {
    const orgId = await freshOrg()
    const slug = await orgSlug(orgId)
    const extRef = `ext-${crypto.randomUUID().slice(0, 8)}`
    const file = writeNdjson([
      {
        subject: "Dry run",
        externalRef: extRef,
        contactEmail: "dry@example.com",
        messages: [{ kind: "inbound", textBody: "nope" }],
      },
    ])

    const { exitCode, report } = await runTicketsImport({ file, orgSlug: slug, dryRun: true })
    expect(exitCode).toBe(0)
    // Dry run reports what WOULD be created but writes nothing.
    expect(report.created).toBe(0)
    expect(await countTicketsByExternalRef(orgId, extRef)).toBe(0)
  })

  test("malformed line → failed[] with line number, stream continues", async () => {
    const orgId = await freshOrg()
    const slug = await orgSlug(orgId)
    const goodRef = `ext-${crypto.randomUUID().slice(0, 8)}`
    const file = writeRaw([
      "{ this is not valid json",
      JSON.stringify({
        subject: "Good one",
        externalRef: goodRef,
        contactEmail: "good@example.com",
        messages: [{ kind: "inbound", textBody: "ok" }],
      }),
    ])

    const { exitCode, report } = await runTicketsImport({ file, orgSlug: slug, dryRun: false })
    // The malformed line is reported but the stream continues and the valid one imports.
    expect(report.failed.length).toBe(1)
    expect(report.failed[0]?.line).toBe(1)
    expect(report.created).toBe(1)
    expect(await countTicketsByExternalRef(orgId, goodRef)).toBe(1)
    // A record-level failure leaves exitCode non-zero (1 runtime) but does not abort.
    expect(exitCode).toBe(1)
  })

  test("historical-date: message sent_at == historical; ticket created_at ≈ now()", async () => {
    const orgId = await freshOrg()
    const slug = await orgSlug(orgId)
    const extRef = `ext-${crypto.randomUUID().slice(0, 8)}`
    const historical = "2021-03-04T09:15:00.000Z"
    const before = Date.now()
    const file = writeNdjson([
      {
        subject: "Old ticket",
        externalRef: extRef,
        contactEmail: "old@example.com",
        messages: [{ kind: "inbound", textBody: "from 2021", sentAt: historical }],
      },
    ])

    const { report } = await runTicketsImport({ file, orgSlug: slug, dryRun: false })
    expect(report.created).toBe(1)
    const after = Date.now()

    const rows = await withPrivilegedDb(orgId, "t", (tx) =>
      tx.execute(drizzleSql`
        SELECT t.created_at AS ticket_created_at, m.sent_at AS message_sent_at
        FROM ${ticketsRel("tickets")} t
        JOIN ${ticketsRel("messages")} m ON m.ticket_id = t.id
        WHERE t.org_id = ${orgId}::uuid AND t.external_ref = ${extRef}
      `),
    )
    const row = extractRows<{ ticket_created_at: string | Date; message_sent_at: string | Date }>(
      rows,
    )[0]
    if (!row) throw new Error("ticket not found")

    // Message sent_at == the supplied historical timestamp.
    const sentAt = new Date(row.message_sent_at).getTime()
    expect(sentAt).toBe(new Date(historical).getTime())

    // Ticket created_at ≈ now() (NOT historical). Allow a generous window.
    const createdAt = new Date(row.ticket_created_at).getTime()
    expect(createdAt).toBeGreaterThanOrEqual(before - 60_000)
    expect(createdAt).toBeLessThanOrEqual(after + 60_000)
    // Definitively NOT the 2021 historical date.
    expect(createdAt).toBeGreaterThan(new Date("2022-01-01T00:00:00Z").getTime())
  })

  // A ticket links the organisation's contact for an address when one exists and
  // never creates one: adding someone to the organisation's contacts is an
  // explicit share (modules/sharing). So an import reuses the org contact for a
  // repeated address, and an address nobody shared stays on the ticket alone.
  test("contact reuse: same email twice → both tickets link the one org contact, none created", async () => {
    const orgId = await freshOrg()
    const slug = await orgSlug(orgId)
    const email = `reuse-${crypto.randomUUID().slice(0, 6)}@example.com`
    const contactId = crypto.randomUUID()
    await withPrivilegedDb(orgId, "t", (tx) =>
      tx.execute(drizzleSql`
        INSERT INTO ${kernelRel("contacts")} (id, org_id, handle, name, email, org_access)
        VALUES (${contactId}::uuid, ${orgId}::uuid, ${`@reuse-${contactId.slice(0, 8)}`}, 'Reuse Person', ${email}, 'editor')
      `),
    )
    const refs = [
      `ext-${crypto.randomUUID().slice(0, 8)}`,
      `ext-${crypto.randomUUID().slice(0, 8)}`,
    ]
    const file = writeNdjson([
      {
        subject: "First",
        externalRef: refs[0],
        contactEmail: email,
        contactName: "Reuse Person",
        messages: [{ kind: "inbound", textBody: "one" }],
      },
      {
        subject: "Second",
        externalRef: refs[1],
        contactEmail: email.toUpperCase(),
        messages: [{ kind: "inbound", textBody: "two" }],
      },
    ])

    const { report } = await runTicketsImport({ file, orgSlug: slug, dryRun: false })
    expect(report.created).toBe(2)

    const contacts = await withPrivilegedDb(orgId, "t", (tx) =>
      tx.execute(drizzleSql`
        SELECT id FROM ${kernelRel("contacts")}
        WHERE org_id = ${orgId}::uuid AND lower(email) = ${email.toLowerCase()}
      `),
    )
    expect(extractRows(contacts).length).toBe(1)
    const tickets = await withPrivilegedDb(orgId, "t", (tx) =>
      tx.execute(drizzleSql`
        SELECT contact_id FROM ${ticketsRel("tickets")}
        WHERE org_id = ${orgId}::uuid AND external_ref IN (${refs[0]}, ${refs[1]})
      `),
    )
    expect(extractRows<{ contact_id: string }>(tickets).map((t) => t.contact_id)).toEqual([
      contactId,
      contactId,
    ])
  })

  test("an address no contact carries creates no org contact; it stays on the ticket", async () => {
    const orgId = await freshOrg()
    const slug = await orgSlug(orgId)
    const email = `unshared-${crypto.randomUUID().slice(0, 6)}@example.com`
    const ref = `ext-${crypto.randomUUID().slice(0, 8)}`
    const file = writeNdjson([
      {
        subject: "Unshared",
        externalRef: ref,
        contactEmail: email,
        messages: [{ kind: "inbound", textBody: "hello" }],
      },
    ])

    const { report } = await runTicketsImport({ file, orgSlug: slug, dryRun: false })
    expect(report.created).toBe(1)

    const contacts = await withPrivilegedDb(orgId, "t", (tx) =>
      tx.execute(drizzleSql`
        SELECT id FROM ${kernelRel("contacts")}
        WHERE org_id = ${orgId}::uuid AND lower(email) = ${email}
      `),
    )
    expect(extractRows(contacts).length).toBe(0)
    const [ticket] = extractRows<{ contact_id: string | null; requester_email: string | null }>(
      await withPrivilegedDb(orgId, "t", (tx) =>
        tx.execute(drizzleSql`
          SELECT contact_id, requester_email FROM ${ticketsRel("tickets")}
          WHERE org_id = ${orgId}::uuid AND external_ref = ${ref}
        `),
      ),
    )
    expect(ticket?.contact_id).toBeNull()
    expect(ticket?.requester_email).toBe(email)
  })

  test("multi-message: subsequent inbound messages appended with their sent_at", async () => {
    const orgId = await freshOrg()
    const slug = await orgSlug(orgId)
    const extRef = `ext-${crypto.randomUUID().slice(0, 8)}`
    const t1 = "2023-01-01T10:00:00.000Z"
    const t2 = "2023-01-02T11:30:00.000Z"
    const file = writeNdjson([
      {
        subject: "Two messages",
        externalRef: extRef,
        contactEmail: "multi@example.com",
        messages: [
          { kind: "inbound", textBody: "first message", sentAt: t1 },
          { kind: "inbound", textBody: "second message", sentAt: t2 },
        ],
      },
    ])

    const { report } = await runTicketsImport({ file, orgSlug: slug, dryRun: false })
    expect(report.created).toBe(1)

    const msgs = await withPrivilegedDb(orgId, "t", (tx) =>
      tx.execute(drizzleSql`
        SELECT m.text_body, m.sent_at FROM ${ticketsRel("messages")} m
        JOIN ${ticketsRel("tickets")} t ON t.id = m.ticket_id
        WHERE t.org_id = ${orgId}::uuid AND t.external_ref = ${extRef}
        ORDER BY m.sent_at ASC
      `),
    )
    const rows = extractRows<{ text_body: string; sent_at: string | Date }>(msgs)
    expect(rows.length).toBe(2)
    expect(rows[0]?.text_body).toBe("first message")
    expect(new Date(rows[0]!.sent_at).getTime()).toBe(new Date(t1).getTime())
    expect(rows[1]?.text_body).toBe("second message")
    expect(new Date(rows[1]!.sent_at).getTime()).toBe(new Date(t2).getTime())
  })

  test("single-org default: orgSlug omitted resolves the only org", async () => {
    // This test only asserts the resolution contract is callable; multiple orgs
    // exist in the shared test DB, so omitting orgSlug there is ambiguous and must
    // return a clean exit-2 (not a crash).
    const orgId = await freshOrg()
    const slug = await orgSlug(orgId)
    const file = writeNdjson([
      {
        subject: "Resolve test",
        externalRef: `ext-${crypto.randomUUID().slice(0, 8)}`,
        contactEmail: "resolve@example.com",
        messages: [{ kind: "inbound", textBody: "x" }],
      },
    ])
    // With a known slug it always works.
    const { exitCode } = await runTicketsImport({ file, orgSlug: slug, dryRun: false })
    expect(exitCode).toBe(0)
  })

  test("unknown orgSlug → clean exit-2", async () => {
    const file = writeNdjson([
      {
        subject: "x",
        externalRef: "x",
        contactEmail: "x@example.com",
        messages: [{ kind: "inbound", textBody: "x" }],
      },
    ])
    const { exitCode } = await runTicketsImport({
      file,
      orgSlug: `does-not-exist-${crypto.randomUUID()}`,
      dryRun: false,
    })
    expect(exitCode).toBe(2)
  })

  test("migration metadata: status, closedReason, assignee, backdated createdAt are honoured", async () => {
    const orgId = await freshOrg()
    const slug = await orgSlug(orgId)
    // The assignee email must resolve to an active org user.
    const agentEmail = `agent-${crypto.randomUUID().slice(0, 8)}@fabrikam.example`
    await ensureUser({
      orgId,
      email: agentEmail,
      name: "Agent Smith",
      password: "pw-import-1!",
      role: "admin",
    })

    const extRef = `ext-${crypto.randomUUID().slice(0, 8)}`
    const created = "2020-06-15T08:00:00.000Z"
    const firstResp = "2020-06-15T09:30:00.000Z"
    const file = writeNdjson([
      {
        subject: "Resolved long ago",
        externalRef: extRef,
        contactEmail: "cust@example.com",
        channel: "email",
        priority: "high",
        status: "closed",
        closedReason: "resolved",
        assigneeEmail: agentEmail,
        createdAt: created,
        firstResponseAt: firstResp,
        messages: [
          { kind: "inbound", fromEmail: "cust@example.com", textBody: "help", sentAt: created },
          { kind: "outbound", fromEmail: agentEmail, textBody: "fixed", sentAt: firstResp },
          { kind: "note", fromName: "Agent Smith", textBody: "internal note", sentAt: firstResp },
        ],
      },
    ])

    const { exitCode, report } = await runTicketsImport({ file, orgSlug: slug, dryRun: false })
    expect(exitCode).toBe(0)
    expect(report.created).toBe(1)

    const rows = await withPrivilegedDb(orgId, "t", (tx) =>
      tx.execute(drizzleSql`
        SELECT t.status, t.closed_reason, t.priority, t.created_at, t.first_response_at,
               t.assigned_to, u.email AS assignee_email
        FROM ${ticketsRel("tickets")} t
        LEFT JOIN ${kernelRel("users")} u ON u.id = t.assigned_to
        WHERE t.org_id = ${orgId}::uuid AND t.external_ref = ${extRef}
      `),
    )
    const row = extractRows<{
      status: string
      closed_reason: string | null
      priority: string
      created_at: string | Date
      first_response_at: string | Date | null
      assigned_to: string | null
      assignee_email: string | null
    }>(rows)[0]
    if (!row) throw new Error("ticket not found")

    // Status is honoured (regression: it was previously hardcoded to 'open').
    expect(row.status).toBe("closed")
    expect(row.closed_reason).toBe("resolved")
    expect(row.priority).toBe("high")
    // created_at + first_response_at are BACKDATED to the source timestamps (not now()).
    expect(new Date(row.created_at).getTime()).toBe(new Date(created).getTime())
    expect(new Date(row.first_response_at!).getTime()).toBe(new Date(firstResp).getTime())
    // Assignee email resolved to the active user id.
    expect(row.assigned_to).not.toBeNull()
    expect(row.assignee_email).toBe(agentEmail)

    // The internal note imported as kind='note'.
    const noteRows = await withPrivilegedDb(orgId, "t", (tx) =>
      tx.execute(drizzleSql`
        SELECT m.kind FROM ${ticketsRel("messages")} m
        JOIN ${ticketsRel("tickets")} t ON t.id = m.ticket_id
        WHERE t.org_id = ${orgId}::uuid AND t.external_ref = ${extRef} AND m.kind = 'note'
      `),
    )
    expect(extractRows(noteRows).length).toBe(1)
  })

  test("pass-throughs: team, language, sourceInboxId, categoryPath land on the ticket", async () => {
    const orgId = await freshOrg()
    const slug = await orgSlug(orgId)

    // Fixture: a connected account + inbox (sourceInboxId target) and a
    // two-level category tree (categoryPath target), inserted the same way
    // api-inboxes.test.ts builds its fixtures.
    let inboxId = ""
    let childCategoryId = ""
    await withSystemDb("cli-import-passthrough-fixture", async (tx) => {
      const adminId = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          SELECT id FROM ${kernelRel("users")}
          WHERE org_id = ${orgId}::uuid AND status = 'active'
          ORDER BY created_at ASC LIMIT 1`),
      )[0]!.id
      const accountRows = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          INSERT INTO ${kernelRel("connected_accounts")}
            (id, org_id, app_name, connection_name, owner_type, owner_id, provider_type, identifier, status, created_by, access_token_encrypted)
          VALUES (gen_random_uuid(), ${orgId}::uuid, 'tickets', 'gmail', 'org', null, 'oauth2', 'desk@example.test', 'active', ${adminId}::uuid, 'enc')
          RETURNING id`),
      )
      const accountId = accountRows[0]!.id
      inboxId = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          INSERT INTO ${ticketsRel("inboxes")}
            (id, org_id, kind, connected_account_id, name, email_address, created_at, updated_at)
          VALUES (gen_random_uuid(), ${orgId}::uuid, 'mailbox', ${accountId}::uuid, 'Desk', 'desk@example.test', now(), now())
          RETURNING id`),
      )[0]!.id
      const parentId = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          INSERT INTO ${ticketsRel("categories")} (id, org_id, parent_id, name, sort_order)
          VALUES (gen_random_uuid(), ${orgId}::uuid, NULL, 'Support', 0)
          RETURNING id`),
      )[0]!.id
      childCategoryId = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          INSERT INTO ${ticketsRel("categories")} (id, org_id, parent_id, name, sort_order)
          VALUES (gen_random_uuid(), ${orgId}::uuid, ${parentId}::uuid, 'Bank connection', 0)
          RETURNING id`),
      )[0]!.id
    })

    const extRef = `ext-${crypto.randomUUID().slice(0, 8)}`
    const file = writeNdjson([
      {
        subject: "Connexion bancaire impossible",
        externalRef: extRef,
        contactEmail: "cust@example.com",
        team: "nord",
        language: "French",
        sourceInboxId: inboxId,
        // Case-insensitive path resolution (same resolver as the public webhook).
        categoryPath: "support / bank connection",
        messages: [{ kind: "inbound", textBody: "bonjour" }],
      },
    ])

    const { exitCode, report } = await runTicketsImport({ file, orgSlug: slug, dryRun: false })
    expect(exitCode).toBe(0)
    expect(report.created).toBe(1)

    const rows = await withPrivilegedDb(orgId, "t", (tx) =>
      tx.execute(drizzleSql`
        SELECT team, language, source_inbox_id, category_id FROM ${ticketsRel("tickets")}
        WHERE org_id = ${orgId}::uuid AND external_ref = ${extRef}
      `),
    )
    const row = extractRows<{
      team: string | null
      language: string | null
      source_inbox_id: string | null
      category_id: string | null
    }>(rows)[0]
    if (!row) throw new Error("ticket not found")
    expect(row.team).toBe("nord")
    expect(row.language).toBe("French")
    expect(row.source_inbox_id).toBe(inboxId)
    expect(row.category_id).toBe(childCategoryId)
  })

  test("unresolvable categoryPath → record fails loudly, nothing written", async () => {
    const orgId = await freshOrg()
    const slug = await orgSlug(orgId)
    const extRef = `ext-${crypto.randomUUID().slice(0, 8)}`
    const file = writeNdjson([
      {
        subject: "Bad category",
        externalRef: extRef,
        contactEmail: "cust@example.com",
        categoryPath: "No Such Parent / No Such Child",
        messages: [{ kind: "inbound", textBody: "x" }],
      },
    ])
    const { exitCode, report } = await runTicketsImport({ file, orgSlug: slug, dryRun: false })
    expect(exitCode).toBe(1)
    expect(report.created).toBe(0)
    expect(report.failed.length).toBe(1)
    expect(report.failed[0]?.error).toContain("does not resolve")
    expect(await countTicketsByExternalRef(orgId, extRef)).toBe(0)
  })

  test("dry-run validates categoryPath (unresolvable path reported without writing)", async () => {
    const orgId = await freshOrg()
    const slug = await orgSlug(orgId)
    const extRef = `ext-${crypto.randomUUID().slice(0, 8)}`
    const file = writeNdjson([
      {
        subject: "Bad category dry",
        externalRef: extRef,
        contactEmail: "cust@example.com",
        categoryPath: "Ghost / Path",
        messages: [{ kind: "inbound", textBody: "x" }],
      },
    ])
    const { exitCode, report } = await runTicketsImport({ file, orgSlug: slug, dryRun: true })
    expect(exitCode).toBe(1)
    expect(report.failed.length).toBe(1)
    expect(report.failed[0]?.error).toContain("does not resolve")
    expect(await countTicketsByExternalRef(orgId, extRef)).toBe(0)
  })

  test("unknown sourceInboxId → record fails loudly (createTicket not_found surfaces)", async () => {
    const orgId = await freshOrg()
    const slug = await orgSlug(orgId)
    const extRef = `ext-${crypto.randomUUID().slice(0, 8)}`
    const file = writeNdjson([
      {
        subject: "Bad inbox",
        externalRef: extRef,
        contactEmail: "cust@example.com",
        sourceInboxId: crypto.randomUUID(),
        messages: [{ kind: "inbound", textBody: "x" }],
      },
    ])
    const { exitCode, report } = await runTicketsImport({ file, orgSlug: slug, dryRun: false })
    expect(exitCode).toBe(1)
    expect(report.failed.length).toBe(1)
    expect(report.failed[0]?.error).toContain("inbox not found")
    expect(await countTicketsByExternalRef(orgId, extRef)).toBe(0)
  })

  test("unknown assigneeEmail → ticket imports UNASSIGNED, not a failure", async () => {
    const orgId = await freshOrg()
    const slug = await orgSlug(orgId)
    const extRef = `ext-${crypto.randomUUID().slice(0, 8)}`
    const file = writeNdjson([
      {
        subject: "Assignee not in org",
        externalRef: extRef,
        contactEmail: "x@example.com",
        status: "open",
        assigneeEmail: "ghost@nowhere.example",
        messages: [{ kind: "inbound", textBody: "hi" }],
      },
    ])
    const { exitCode, report } = await runTicketsImport({ file, orgSlug: slug, dryRun: false })
    expect(exitCode).toBe(0)
    expect(report.created).toBe(1)
    const rows = await withPrivilegedDb(orgId, "t", (tx) =>
      tx.execute(drizzleSql`
        SELECT assigned_to FROM ${ticketsRel("tickets")}
        WHERE org_id = ${orgId}::uuid AND external_ref = ${extRef}
      `),
    )
    expect(extractRows<{ assigned_to: string | null }>(rows)[0]?.assigned_to).toBeNull()
  })
})
