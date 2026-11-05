// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { type RlsClient, sql } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"

const rlsDb = db as unknown as RlsClient

import { timelineDeclarations } from "~/modules/apps/app-registries"
import { generateTimelineEntries } from "~/modules/audit/timeline"

describe("timeline entry generation", () => {
  const orgId = "00000000-0000-0000-0000-000000000099"
  const userId = "00000000-0000-0000-0000-000000000098"

  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${orgId}, 'Test', 'test') ON CONFLICT DO NOTHING`
    // Register a timeline declaration (org-scoped key)
    timelineDeclarations.set([orgId, "test", "items"], {
      app: "test",
      entity: "items",
      fields: ["status", "team"],
    })
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.timeline_entries WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${orgId}`
    timelineDeclarations.delete([orgId, "test", "items"])
  })

  it("generates entry for update with timeline field", async () => {
    await generateTimelineEntries(rlsDb, {
      orgId,
      app: "test",
      entity: "items",
      action: "updated",
      entityId: "00000000-0000-0000-0000-000000000010",
      userId: userId,
      data: {
        before: { status: "open", title: "Old" },
        after: { status: "resolved", title: "New" },
      },
    })

    const entries = await sql`SELECT * FROM kernel.timeline_entries
			WHERE org_id = ${orgId} AND entity_id = '00000000-0000-0000-0000-000000000010'
			ORDER BY created_at DESC`

    // Only status is in timeline fields, not title
    expect(entries).toHaveLength(1)
    expect(entries[0].action).toBe("field_changed")
    expect(entries[0].summary).toContain("status")
    expect(entries[0].summary).toContain("open")
    expect(entries[0].summary).toContain("resolved")
  })

  it("skips non-timeline fields", async () => {
    await sql`DELETE FROM kernel.timeline_entries WHERE org_id = ${orgId}`

    await generateTimelineEntries(rlsDb, {
      orgId,
      app: "test",
      entity: "items",
      action: "updated",
      entityId: "00000000-0000-0000-0000-000000000020",
      userId: userId,
      data: {
        before: { title: "Old" },
        after: { title: "New" },
      },
    })

    const entries = await sql`SELECT * FROM kernel.timeline_entries
			WHERE org_id = ${orgId} AND entity_id = '00000000-0000-0000-0000-000000000020'`
    expect(entries).toHaveLength(0)
  })

  it("generates created entry", async () => {
    await generateTimelineEntries(rlsDb, {
      orgId,
      app: "test",
      entity: "items",
      action: "created",
      entityId: "00000000-0000-0000-0000-000000000030",
      userId: userId,
      data: { title: "New Item", status: "open" },
    })

    const entries = await sql`SELECT * FROM kernel.timeline_entries
			WHERE org_id = ${orgId} AND entity_id = '00000000-0000-0000-0000-000000000030'`
    expect(entries).toHaveLength(1)
    expect(entries[0].action).toBe("created")
  })

  it("records copy provenance on a file:create timeline entry", async () => {
    await sql`DELETE FROM kernel.timeline_entries WHERE org_id = ${orgId}`
    timelineDeclarations.set([orgId, "kernel", "file"], {
      app: "kernel",
      entity: "file",
      fields: ["filename"],
    })
    const fileId = "00000000-0000-0000-0000-0000000000f1"
    await generateTimelineEntries(rlsDb, {
      orgId,
      app: "kernel",
      entity: "file",
      action: "create",
      entityId: fileId,
      userId,
      actorType: "agent",
      data: {
        copiedFromId: "00000000-0000-0000-0000-0000000000aa",
        sourceApp: "tickets",
        sourceEntityType: "message",
        sourceEntityId: "tm-1",
        filename: "return-label.pdf",
      },
    })

    const entries = await sql`SELECT * FROM kernel.timeline_entries
			WHERE org_id = ${orgId} AND entity_id = ${fileId}`
    expect(entries).toHaveLength(1)
    expect(entries[0].action).toBe("created")
    expect(entries[0].field_changes).toMatchObject({
      copiedFromId: "00000000-0000-0000-0000-0000000000aa",
      sourceApp: "tickets",
    })
    timelineDeclarations.delete([orgId, "kernel", "file"])
  })

  it("generates deleted entry", async () => {
    await generateTimelineEntries(rlsDb, {
      orgId,
      app: "test",
      entity: "items",
      action: "deleted",
      entityId: "00000000-0000-0000-0000-000000000040",
      userId: userId,
      data: {},
    })

    const entries = await sql`SELECT * FROM kernel.timeline_entries
			WHERE org_id = ${orgId} AND entity_id = '00000000-0000-0000-0000-000000000040'`
    expect(entries).toHaveLength(1)
    expect(entries[0].action).toBe("deleted")
  })

  it("no timeline declaration -> no entries", async () => {
    await generateTimelineEntries(rlsDb, {
      orgId,
      app: "nope",
      entity: "things",
      action: "updated",
      entityId: "00000000-0000-0000-0000-000000000050",
      userId: userId,
      data: { before: { x: 1 }, after: { x: 2 } },
    })

    const entries = await sql`SELECT * FROM kernel.timeline_entries
			WHERE org_id = ${orgId} AND entity_id = '00000000-0000-0000-0000-000000000050'`
    expect(entries).toHaveLength(0)
  })

  it("system actor type", async () => {
    await generateTimelineEntries(rlsDb, {
      orgId,
      app: "test",
      entity: "items",
      action: "updated",
      entityId: "00000000-0000-0000-0000-000000000060",
      userId: null,
      actorType: "system",
      data: {
        before: { status: "open" },
        after: { status: "auto-resolved" },
      },
    })

    const entries = await sql`SELECT * FROM kernel.timeline_entries
			WHERE org_id = ${orgId} AND entity_id = '00000000-0000-0000-0000-000000000060'`
    expect(entries[0].actor_type).toBe("system")
  })

  it("non-uuid actor id (system sentinel) → null actor_id, no 22P02 crash", async () => {
    // Production bug: a contact created by a system / cross-app actor carried a
    // non-uuid sentinel userId ("system") with no explicit actorType. The uuid
    // `actor_id` insert threw 22P02 and the timeline entry was silently dropped.
    await generateTimelineEntries(rlsDb, {
      orgId,
      app: "test",
      entity: "items",
      action: "created",
      entityId: "00000000-0000-0000-0000-000000000070",
      userId: "system",
      data: { status: "open", title: "x" },
    })

    const entries = await sql`SELECT * FROM kernel.timeline_entries
			WHERE org_id = ${orgId} AND entity_id = '00000000-0000-0000-0000-000000000070'`
    expect(entries).toHaveLength(1)
    expect(entries[0].actor_id).toBeNull()
    expect(entries[0].actor_type).toBe("system")
  })
})

// ── Invariant K, Task 6.2: the timeline denylist is a PREDICATE, not a Set ────
//
// The two halves of this file are not symmetric and that is the point. Adding
// "subject" to a bare `Set<string>` of field names would strip TICKET subject
// changes across the whole product, because the renderer consults the same set
// for every app. So the denylist keys on (app, entity, field), and both cases
// below have to hold at once: a mail subject change renders without its value,
// and a tickets subject change renders with it.
describe("timeline sensitive-field scoping", () => {
  const orgId = "00000000-0000-0000-0000-0000000000a9"
  const MAIL_ENTITY = "00000000-0000-0000-0000-0000000000b1"
  const TICKET_ENTITY = "00000000-0000-0000-0000-0000000000b2"
  const CIPHER_ENTITY = "00000000-0000-0000-0000-0000000000b3"

  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${orgId}, 'Scoped', 'scoped-timeline') ON CONFLICT DO NOTHING`
    timelineDeclarations.set([orgId, "mail", "conversation"], {
      app: "mail",
      entity: "conversation",
      fields: ["subject", "snippet", "status"],
    })
    timelineDeclarations.set([orgId, "tickets", "ticket"], {
      app: "tickets",
      entity: "ticket",
      fields: ["subject", "status"],
    })
    timelineDeclarations.set([orgId, "widgets", "widget"], {
      app: "widgets",
      entity: "widget",
      fields: ["body_ciphertext"],
    })
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.timeline_entries WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${orgId}`
    timelineDeclarations.delete([orgId, "mail", "conversation"])
    timelineDeclarations.delete([orgId, "tickets", "ticket"])
    timelineDeclarations.delete([orgId, "widgets", "widget"])
  })

  it("redacts a mail subject change but still records that it changed", async () => {
    await generateTimelineEntries(rlsDb, {
      orgId,
      app: "mail",
      entity: "conversation",
      action: "updated",
      entityId: MAIL_ENTITY,
      userId: null,
      data: {
        before: { subject: "OLDNONCEPHRASE alpha" },
        after: { subject: "NEWNONCEPHRASE beta" },
      },
    })
    const entries = (await sql`SELECT * FROM kernel.timeline_entries
      WHERE org_id = ${orgId} AND entity_id = ${MAIL_ENTITY}`) as unknown as Array<{
      summary: string
      field_changes: unknown
    }>
    // Non-vacuity: the entry must EXIST. "no phrase found" is trivially true of
    // a timeline that generated nothing at all.
    expect(entries).toHaveLength(1)
    expect(entries[0].summary).toBe("changed subject")
    const serialized = `${entries[0].summary}${JSON.stringify(entries[0].field_changes)}`
    expect(serialized).not.toContain("OLDNONCEPHRASE")
    expect(serialized).not.toContain("NEWNONCEPHRASE")
  })

  it("still renders a tickets subject change verbatim", async () => {
    await generateTimelineEntries(rlsDb, {
      orgId,
      app: "tickets",
      entity: "ticket",
      action: "updated",
      entityId: TICKET_ENTITY,
      userId: null,
      data: {
        before: { subject: "Broken pedal" },
        after: { subject: "Broken pedal, resolved" },
      },
    })
    const entries = (await sql`SELECT * FROM kernel.timeline_entries
      WHERE org_id = ${orgId} AND entity_id = ${TICKET_ENTITY}`) as unknown as Array<{
      summary: string
    }>
    expect(entries).toHaveLength(1)
    expect(entries[0].summary).toContain("Broken pedal")
  })

  it("redacts any field named *_ciphertext on any app, in the flat-changes branch too", async () => {
    await generateTimelineEntries(rlsDb, {
      orgId,
      app: "widgets",
      entity: "widget",
      action: "updated",
      entityId: CIPHER_ENTITY,
      userId: null,
      data: { changes: { body_ciphertext: "Q0lQSEVSTk9OQ0U=" } },
    })
    const entries = (await sql`SELECT * FROM kernel.timeline_entries
      WHERE org_id = ${orgId} AND entity_id = ${CIPHER_ENTITY}`) as unknown as Array<{
      summary: string
      field_changes: unknown
    }>
    expect(entries).toHaveLength(1)
    expect(`${entries[0].summary}${JSON.stringify(entries[0].field_changes)}`).not.toContain(
      "Q0lQSEVSTk9OQ0U=",
    )
  })

  it("redacts a mail snippet supplied through the flat-changes branch", async () => {
    const flatEntity = "00000000-0000-0000-0000-0000000000b4"
    await generateTimelineEntries(rlsDb, {
      orgId,
      app: "mail",
      entity: "conversation",
      action: "updated",
      entityId: flatEntity,
      userId: null,
      data: { changes: { snippet: "FLATNONCEPHRASE gamma" } },
    })
    const entries = (await sql`SELECT * FROM kernel.timeline_entries
      WHERE org_id = ${orgId} AND entity_id = ${flatEntity}`) as unknown as Array<{
      summary: string
      field_changes: unknown
    }>
    expect(entries).toHaveLength(1)
    expect(`${entries[0].summary}${JSON.stringify(entries[0].field_changes)}`).not.toContain(
      "FLATNONCEPHRASE",
    )
  })
})
