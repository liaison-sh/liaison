// SPDX-License-Identifier: FSL-1.1-ALv2
// editNote / deleteNote admin ops — internal notes are the ONLY mutable/removable
// message kind (customer-visible inbound/outbound rows must never be touched).
// Stale notes poison later agent runs ("already handled" from a dead approval id),
// so operators and gated agent tools need a way to correct or remove them.
import { beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { runAdminOp } from "~/apps/tickets/admin"
import ticketsManifest from "~/apps/tickets/app.manifest.json"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withSystemDb } from "~/db/privileged"

let orgId: string
let userId: string
let ticketId: string
let ticketHandle: string

const actor = () => ({ actorType: "user" as const, userId })

async function insertMessage(kind: string, text: string): Promise<string> {
  const rows = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO app_tickets.messages (org_id, ticket_id, kind, text_body, sent_at)
      VALUES (${orgId}, ${ticketId}, ${kind}, ${text}, now())
      RETURNING id
    `),
  )
  return rows[0]!.id
}

async function messageRow(id: string): Promise<{ text_body: string } | undefined> {
  return extractRows<{ text_body: string }>(
    await db.execute(
      drizzleSql`SELECT text_body FROM app_tickets.messages WHERE id = ${id} AND org_id = ${orgId}`,
    ),
  )[0]
}

beforeAll(async () => {
  const slug = `note-ed-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await withSystemDb("note-edit-delete-fixture", async (tx) => {
    const orgRows = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.organizations (id, name, slug)
        VALUES (gen_random_uuid(), 'NoteEd', ${slug}) RETURNING id
      `),
    )
    orgId = orgRows[0]!.id
    const u = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${orgId}, ${`u-${slug}@x.test`}, 'A', 'active', 'h', 1, 1) RETURNING id
      `),
    )
    userId = u[0]!.id
  })
  // A REAL handle: `ticket-<n>`, what nextHandle mints and what agents see.
  ticketHandle = `ticket-${Math.floor(Math.random() * 1e9)}`
  const t = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO app_tickets.tickets
        (org_id, handle, subject, channel, reply_token, status, message_count,
         sla_target_seconds, sla_deadline)
      VALUES (${orgId}, ${ticketHandle}, 'Note edit/delete', 'email', ${`tok-${slug}`}, 'open', 0,
              3600, now() + interval '1 day')
      RETURNING id
    `),
  )
  ticketId = t[0]!.id
})

describe("tickets admin editNote", () => {
  it("replaces the text of an existing note", async () => {
    const noteId = await insertMessage("note", "old text")
    const r = (await runAdminOp(
      db as never,
      orgId,
      "editNote",
      { ticketId, messageId: noteId, text: "corrected text" },
      actor(),
    )) as Record<string, unknown>
    expect(r.updated).toBe(true)
    expect((await messageRow(noteId))?.text_body).toBe("corrected text")
  })

  it("refuses to edit a customer-visible message", async () => {
    const inboundId = await insertMessage("inbound", "customer words")
    const r = (await runAdminOp(
      db as never,
      orgId,
      "editNote",
      { ticketId, messageId: inboundId, text: "tampered" },
      actor(),
    )) as { error?: { code: string } }
    expect(r.error?.code).toBe("not_found")
    expect((await messageRow(inboundId))?.text_body).toBe("customer words")
  })

  it("rejects empty replacement text", async () => {
    const noteId = await insertMessage("note", "keep me")
    const r = (await runAdminOp(
      db as never,
      orgId,
      "editNote",
      { ticketId, messageId: noteId, text: "" },
      actor(),
    )) as { error?: { code: string } }
    expect(r.error?.code).toBe("invalid_params")
  })
})

describe("tickets admin deleteNote", () => {
  it("deletes a note and decrements the ticket message_count", async () => {
    await db.execute(
      drizzleSql`UPDATE app_tickets.tickets SET message_count = 5 WHERE id = ${ticketId}`,
    )
    const noteId = await insertMessage("note", "stale note")
    const r = (await runAdminOp(
      db as never,
      orgId,
      "deleteNote",
      { ticketId, messageId: noteId },
      actor(),
    )) as Record<string, unknown>
    expect(r.deleted).toBe(true)
    expect(await messageRow(noteId)).toBeUndefined()
    const count = extractRows<{ message_count: number }>(
      await db.execute(
        drizzleSql`SELECT message_count FROM app_tickets.tickets WHERE id = ${ticketId}`,
      ),
    )[0]!.message_count
    expect(count).toBe(4)
  })

  it("refuses to delete a customer-visible message", async () => {
    const outboundId = await insertMessage("outbound", "our reply")
    const r = (await runAdminOp(
      db as never,
      orgId,
      "deleteNote",
      { ticketId, messageId: outboundId },
      actor(),
    )) as { error?: { code: string } }
    expect(r.error?.code).toBe("not_found")
    expect(await messageRow(outboundId)).toBeDefined()
  })

  it("returns not_found for an unknown note id", async () => {
    const r = (await runAdminOp(
      db as never,
      orgId,
      "deleteNote",
      { ticketId, messageId: "00000000-0000-0000-0000-000000000000" },
      actor(),
    )) as { error?: { code: string } }
    expect(r.error?.code).toBe("not_found")
  })
})

// Stage-time preflights (manifest `preflight`) for the two GATED note tools. Both are gated, so before
// these existed a messageId naming no internal note still parked a pending approval, and the not_found
// only surfaced once a human clicked approve: an error only the agent could have fixed. These pin the
// refusal at the CALL SITE and that the preflight touches nothing.
describe("tickets admin note preflights (stage-time refusal)", () => {
  it("editNotePreflight refuses an id that is not an internal note on that ticket, and edits nothing", async () => {
    const inboundId = await insertMessage("inbound", "customer words")
    const r = (await runAdminOp(
      db as never,
      orgId,
      "editNotePreflight",
      { ticketId, messageId: inboundId, text: "tampered" },
      actor(),
    )) as { error?: { code: string } }
    expect(r.error?.code).toBe("not_found")
    expect((await messageRow(inboundId))?.text_body).toBe("customer words")
  })

  it("deleteNotePreflight refuses an unknown note id, and deletes nothing", async () => {
    const noteId = await insertMessage("note", "still here")
    const r = (await runAdminOp(
      db as never,
      orgId,
      "deleteNotePreflight",
      { ticketId, messageId: "00000000-0000-0000-0000-000000000000" },
      actor(),
    )) as { error?: { code: string } }
    expect(r.error?.code).toBe("not_found")
    expect(await messageRow(noteId)).toBeDefined()
  })

  it("editNotePreflight refuses empty replacement text", async () => {
    const noteId = await insertMessage("note", "keep me")
    const r = (await runAdminOp(
      db as never,
      orgId,
      "editNotePreflight",
      { ticketId, messageId: noteId, text: "" },
      actor(),
    )) as { error?: { code: string } }
    expect(r.error?.code).toBe("invalid_params")
    expect((await messageRow(noteId))?.text_body).toBe("keep me")
  })

  it("both preflights allow a real note through, leaving it untouched", async () => {
    const noteId = await insertMessage("note", "genuine note")
    for (const op of ["editNotePreflight", "deleteNotePreflight"]) {
      const r = (await runAdminOp(
        db as never,
        orgId,
        op,
        { ticketId, messageId: noteId, text: "new text" },
        actor(),
      )) as { ok?: boolean; error?: { code: string } }
      expect(r.error).toBeUndefined()
      expect(r.ok).toBe(true)
    }
    expect((await messageRow(noteId))?.text_body).toBe("genuine note")
  })
})

describe("tickets manifest note tools", () => {
  it("declares editNote and deleteNote as gated user-boundary tools scoped to notes only", () => {
    const tools = ticketsManifest.tools as unknown as Record<
      string,
      {
        gated?: boolean
        requiredScopes: string[]
        summarizer?: string
        description: string
        preflight?: string
      }
    >
    for (const name of ["editNote", "deleteNote"]) {
      const t = tools[name]!
      expect(t.gated).toBe(true)
      expect(t.requiredScopes).toEqual(["tickets:tickets:write"])
      expect(t.summarizer).toBeTruthy()
      expect(t.description).toMatch(/kind='note'/)
      // Without a declared preflight the gate parks an approval first and the note lookup only runs
      // post-approval, which is the whole defect these tools are being fixed for.
      expect(t.preflight).toBe(`${name}Preflight`)
    }
    const emits = (ticketsManifest as any).events.emits as string[]
    expect(emits).toContain("message:update")
    expect(emits).toContain("message:delete")
  })
})

// Agents read the `ticket-<n>` HANDLE everywhere (UI, search results) and pass
// it back as ticketId. It used to be bound straight into the uuid ticket_id
// column, so Postgres threw "invalid input syntax for type uuid" and the caller
// got a 500 plus an error-level log instead of a tool error.
describe("tickets admin ticket ref resolution", () => {
  it("addNote accepts a ticket handle and inserts against the resolved uuid", async () => {
    const r = (await runAdminOp(
      db as never,
      orgId,
      "addNote",
      { ticketId: ticketHandle, text: "note added by handle" },
      actor(),
    )) as { messageId?: string; ticketId?: string; error?: { code: string } }
    expect(r.error).toBeUndefined()
    expect(r.ticketId).toBe(ticketId)
    const row = extractRows<{ ticket_id: string; text_body: string }>(
      await db.execute(drizzleSql`
        SELECT ticket_id::text AS ticket_id, text_body FROM app_tickets.messages
        WHERE id = ${r.messageId!} AND org_id = ${orgId}
      `),
    )[0]
    expect(row?.ticket_id).toBe(ticketId)
    expect(row?.text_body).toBe("note added by handle")
  })

  it("addNote returns a typed invalid_params error for a garbage ticket id", async () => {
    const r = (await runAdminOp(
      db as never,
      orgId,
      "addNote",
      { ticketId: "not-a-ticket-at-all", text: "should never land" },
      actor(),
    )) as { error?: { code: string; message: string } }
    expect(r.error?.code).toBe("invalid_params")
    expect(r.error?.message).not.toContain("invalid input syntax")
  })

  it("addNote returns a typed not_found error for an unknown ticket handle", async () => {
    const r = (await runAdminOp(
      db as never,
      orgId,
      "addNote",
      { ticketId: "ticket-999999999", text: "no such ticket" },
      actor(),
    )) as { error?: { code: string } }
    expect(r.error?.code).toBe("not_found")
  })

  it("editNote accepts a ticket handle", async () => {
    const noteId = await insertMessage("note", "old text by handle")
    const r = (await runAdminOp(
      db as never,
      orgId,
      "editNote",
      { ticketId: ticketHandle, messageId: noteId, text: "corrected by handle" },
      actor(),
    )) as { updated?: boolean; error?: { code: string } }
    expect(r.error).toBeUndefined()
    expect(r.updated).toBe(true)
    expect((await messageRow(noteId))?.text_body).toBe("corrected by handle")
  })

  it("deleteNote returns a typed invalid_params error for a garbage message id", async () => {
    const r = (await runAdminOp(
      db as never,
      orgId,
      "deleteNote",
      { ticketId, messageId: "not-a-uuid" },
      actor(),
    )) as { error?: { code: string; message: string } }
    expect(r.error?.code).toBe("invalid_params")
    expect(r.error?.message).not.toContain("invalid input syntax")
  })
})
