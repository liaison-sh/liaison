// SPDX-License-Identifier: FSL-1.1-ALv2
//
// 0216: a contact's notes (timeline entries, action `note`) move into the
// contact's discussion as messages, each with its author and date, and the
// copied entries are deleted. A second run copies nothing twice. Existing
// contact primary threads leave the global thread list, as a task's thread.
//
// Everything runs in ONE transaction on one superuser connection and is rolled
// back, so tests sharing this database see nothing.

import { afterAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import postgres from "postgres"

const FILE = new URL("./0216_contact_discussion.sql", import.meta.url).pathname

function privilegedUrl(): string {
  if (process.env.MIGRATION_DATABASE_URL) return process.env.MIGRATION_DATABASE_URL
  const base = process.env.DB_RESET_SUPERUSER_URL ?? "postgres://postgres:postgres@localhost:5432"
  const dbName = new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, "")
  return `${base.replace(/\/$/, "")}/${dbName}`
}

const conn = postgres(privilegedUrl(), { max: 1, onnotice: () => {} })

afterAll(async () => {
  await conn.end()
})

class Rollback extends Error {}

interface MessageRow {
  author_id: string
  author_type: string
  author_agent_id: string | null
  content: string
  label: string | null
  created_at: Date
}

describe("0216 contact discussion", () => {
  it("moves each note into the contact's discussion with its author and date, once", async () => {
    const org = crypto.randomUUID()
    const person = crypto.randomUUID()
    const desk = crypto.randomUUID()
    const contact = crypto.randomUUID()
    const other = crypto.randomUUID()
    const tag = org.slice(0, 8)
    const seen: {
      messages?: MessageRow[]
      notesLeft?: number
      historyKept?: number
      hidden?: boolean[]
      references?: number
      secondRun?: number
    } = {}
    await conn
      .begin(async (tx) => {
        await tx`INSERT INTO kernel.organizations (id, name, slug)
          VALUES (${org}, 'Notes Org', ${`notes-org-${tag}`})`
        await tx`INSERT INTO kernel.users (id, org_id, email, name)
          VALUES (${person}, ${org}, ${`giulia-${tag}@example.com`}, 'Giulia Rossi')`
        await tx`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name)
          VALUES (${desk}, ${org}, 'role', ${`sales-${tag}`}, 'Sales Desk')`
        await tx`INSERT INTO kernel.contacts (id, org_id, handle, name, email, created_by, owner_user_id, org_access)
          VALUES (${contact}, ${org}, ${`@ines-${tag}`}, 'Ines Duarte', ${`ines-${tag}@example.com`},
                  ${person}, ${person}, 'none')`
        await tx`INSERT INTO kernel.contacts (id, org_id, handle, name, email, created_by, org_access)
          VALUES (${other}, ${org}, ${`@felix-${tag}`}, 'Felix Moreau', ${`felix-${tag}@example.com`},
                  ${person}, 'editor')`
        // The other contact already has its primary thread (an app posted to it), listed.
        await tx`INSERT INTO kernel.threads (org_id, handle, type, created_from, created_by)
          VALUES (${org}, ${`contact-primary:${other}`}, 'thread',
                  ${tx.json({ app: "kernel", entityType: "contact", entityId: other })}, ${person})`
        const note = (actorId: string | null, actorType: string, summary: string, at: string) =>
          tx`INSERT INTO kernel.timeline_entries
               (org_id, app, entity_type, entity_id, actor_id, actor_type, action, summary, created_at)
             VALUES (${org}, 'kernel', 'contact', ${contact}, ${actorId}, ${actorType}, 'note',
                     ${summary}, ${at})`
        await note(person, "user", "Called her: wants 40 recorders.", "2026-10-01T09:12:00Z")
        await note(desk, "agent", "New prospect at Northwind Acoustics.", "2026-10-01T09:00:00Z")
        await note(
          crypto.randomUUID(),
          "agent",
          "From an agent since deleted.",
          "2026-10-02T10:00:00Z",
        )
        // The contact's other history stays where it is.
        await tx`INSERT INTO kernel.timeline_entries
             (org_id, app, entity_type, entity_id, actor_id, actor_type, action, summary)
           VALUES (${org}, 'kernel', 'contact', ${contact}, ${person}, 'user', 'update', 'Renamed')`

        await tx.unsafe(readFileSync(FILE, "utf8"))

        seen.messages = await tx<MessageRow[]>`
          SELECT m.author_id::text, m.author_type, m.author_agent_id::text, m.content,
                 m.metadata ->> 'agentAuthorLabel' AS label, m.created_at
            FROM kernel.messages m
            JOIN kernel.threads t ON t.id = m.thread_id
           WHERE t.org_id = ${org} AND t.handle = ${`contact-primary:${contact}`}
           ORDER BY m.created_at`
        const [left] = await tx<{ n: number }[]>`
          SELECT count(*)::int AS n FROM kernel.timeline_entries
           WHERE org_id = ${org} AND entity_id = ${contact} AND action = 'note'`
        seen.notesLeft = left?.n
        const [kept] = await tx<{ n: number }[]>`
          SELECT count(*)::int AS n FROM kernel.timeline_entries
           WHERE org_id = ${org} AND entity_id = ${contact} AND action = 'update'`
        seen.historyKept = kept?.n
        seen.hidden = (
          await tx<{ hidden_from_list: boolean }[]>`
            SELECT hidden_from_list FROM kernel.threads WHERE org_id = ${org} ORDER BY handle`
        ).map((r) => r.hidden_from_list)
        const [refs] = await tx<{ n: number }[]>`
          SELECT count(*)::int AS n FROM kernel.thread_references
           WHERE org_id = ${org} AND app = 'kernel' AND entity_type = 'contact'`
        seen.references = refs?.n

        await tx.unsafe(readFileSync(FILE, "utf8"))
        const [again] = await tx<{ n: number }[]>`
          SELECT count(*)::int AS n FROM kernel.messages WHERE org_id = ${org}`
        seen.secondRun = again?.n
        throw new Rollback()
      })
      .catch((err) => {
        if (!(err instanceof Rollback)) throw err
      })

    expect(seen.messages?.map((m) => [m.author_type, m.content])).toEqual([
      ["agent", "New prospect at Northwind Acoustics."],
      ["user", "Called her: wants 40 recorders."],
      ["system", "From an agent since deleted."],
    ])
    const [byAgent, byPerson, orphan] = seen.messages ?? []
    expect(byAgent?.author_agent_id).toBe(desk)
    expect(byAgent?.label).toBe("Sales Desk")
    expect(byPerson?.author_id).toBe(person)
    expect(byPerson?.created_at.toISOString()).toBe("2026-10-01T09:12:00.000Z")
    expect(orphan?.author_id).toBe(person)
    expect(seen.notesLeft).toBe(0)
    expect(seen.historyKept).toBe(1)
    expect(seen.hidden).toEqual([true, true])
    expect(seen.references).toBe(2)
    expect(seen.secondRun).toBe(3)
  })
})
