// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P4b carry-in H1: the SECOND half of 0076's attribution guard. An
// agent-authored message must NAME the speaking agent, so the front end
// resolves the speaker from the row instead of a client-side sentinel. 0076
// could not arm it because no writer set the column; every writer now does.
//
// The guard is INSERT-only on purpose: the composite key's ON DELETE SET NULL
// (author_agent_id) nulls the column on rows that already exist when a personal
// agent is hard-deleted by its owner's erasure, and that UPDATE must pass.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import postgres from "postgres"
import { sql } from "~/db"

// DDL replays need the migration role; DATABASE_URL is the unprivileged app
// role (scripts/db-reset.ts's convention, same as the 4a idempotency test).
function privilegedUrl(): string {
  if (process.env.MIGRATION_DATABASE_URL) return process.env.MIGRATION_DATABASE_URL
  const base = process.env.DB_RESET_SUPERUSER_URL ?? "postgres://postgres:postgres@localhost:5432"
  const dbName = new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, "")
  return `${base.replace(/\/$/, "")}/${dbName}`
}
const ddl = postgres(privilegedUrl(), { max: 1, onnotice: () => {} })

const ORG = crypto.randomUUID()
const USER = crypto.randomUUID()
const AGENT = crypto.randomUUID()
const AGENT2 = crypto.randomUUID()
const tag = ORG.slice(0, 8)
let THREAD = ""

const rejects = (fn: () => Promise<unknown>) => expect((async () => await fn())()).rejects

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'P4b Org', ${`p4b-t80-${tag}`})`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
    VALUES (${USER}, ${ORG}, ${`p4b-t80-${tag}@test.com`}, 'P4b', 'active', 'hash')`
  await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id)
    VALUES (${AGENT}, ${ORG}, 'personal', ${`@p4b-t80-${tag}`}, 'P4b Agent', ${USER})`
  const [thread] = await sql<{ id: string }[]>`
    INSERT INTO kernel.threads (org_id, handle, type, created_by)
    VALUES (${ORG}, ${`p4b-t80-thr-${tag}`}, 'thread', ${USER}) RETURNING id`
  THREAD = thread!.id
})

afterAll(async () => {
  await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  await ddl.end()
})

async function insertMessage(authorType: string, authorAgentId: string | null, content: string) {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO kernel.messages
      (thread_id, org_id, author_id, author_type, author_agent_id, content, required_scopes)
    VALUES (${THREAD}, ${ORG}, ${USER}, ${authorType}, ${authorAgentId}, ${content}, '{}')
    RETURNING id`
  return row!.id
}

describe("messages agent author is named", () => {
  it("refuses an agent-authored insert that names no agent", async () => {
    await rejects(() => insertMessage("agent", null, "unattributed")).toThrow(
      /requires author_agent_id to name the speaking agent/,
    )
  })

  it("accepts an agent-authored insert that names its agent", async () => {
    const id = await insertMessage("agent", AGENT, "attributed")
    const [row] = await sql<{ author_agent_id: string }[]>`
      SELECT author_agent_id FROM kernel.messages WHERE id = ${id}`
    expect(row?.author_agent_id).toBe(AGENT)
  })

  it("still accepts a user-authored and a system-authored insert with no agent", async () => {
    for (const type of ["user", "system"]) {
      const id = await insertMessage(type, null, `${type} line`)
      const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM kernel.messages WHERE id = ${id}`
      expect(row?.n).toBe(1)
    }
  })

  it("lets the erasure cascade null the attribution on a row that already exists", async () => {
    // INSERT-only: an agent hard-deleted by its owner's erasure nulls this
    // column on its history, and the message survives the loss of the name.
    const id = await insertMessage("agent", AGENT, "to be orphaned")
    await sql`UPDATE kernel.messages SET author_agent_id = NULL WHERE id = ${id}`
    const [row] = await sql<{ author_agent_id: string | null }[]>`
      SELECT author_agent_id FROM kernel.messages WHERE id = ${id}`
    expect(row?.author_agent_id).toBeNull()
  })

  it("survives a replay of 0076, whose guard it must not share", async () => {
    // The per-file idempotency replay re-runs 0076 against a database that
    // already has this migration. 0076 CREATE OR REPLACEs its own guard
    // function and recreates its own trigger; if this half lived in that same
    // function it would be silently disarmed from then on.
    const zero76 = Bun.file(
      new URL("./0076_threads_discoverable_messages_author_agent.sql", import.meta.url).pathname,
    )
    for (const statement of (await zero76.text()).split("--> statement-breakpoint")) {
      if (statement.trim().length > 0) await ddl.unsafe(statement)
    }
    await rejects(() => insertMessage("agent", null, "after the replay")).toThrow(
      /requires author_agent_id to name the speaking agent/,
    )
  })

  it("backfills a legacy agent row from the author's single personal agent", async () => {
    // The rule the agent_chat collapse used. Plant a legacy row the way the
    // product did before the writers named the agent (the guard is INSERT-only,
    // so the plant must bypass it the same way the erasure cascade does).
    const id = await insertMessage("agent", AGENT, "legacy")
    await sql`UPDATE kernel.messages SET author_agent_id = NULL WHERE id = ${id}`
    const file = Bun.file(
      new URL("./0080_messages_agent_author_named.sql", import.meta.url).pathname,
    )
    const [backfill] = (await file.text()).split("--> statement-breakpoint")
    await ddl.unsafe(backfill)
    const [row] = await sql<{ author_agent_id: string | null }[]>`
      SELECT author_agent_id FROM kernel.messages WHERE id = ${id}`
    expect(row?.author_agent_id).toBe(AGENT)
  })
  it("leaves a legacy agent row unattributed when its author has TWO live personal agents", async () => {
    // "Named, never guessed": with two live personal agents there is no single
    // unambiguous speaker, so the backfill must skip the row (the guard is
    // INSERT-only, so a null row is legal) and SAY so rather than pick one.
    const id = await insertMessage("agent", AGENT, "ambiguous legacy")
    await sql`UPDATE kernel.messages SET author_agent_id = NULL WHERE id = ${id}`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id)
      VALUES (${AGENT2}, ${ORG}, 'personal', ${`@p4b-t80b-${tag}`}, 'P4b Agent Two', ${USER})`

    const notices: string[] = []
    const listening = postgres(privilegedUrl(), {
      max: 1,
      onnotice: (n) => notices.push(String(n.message ?? "")),
    })
    try {
      const file = Bun.file(
        new URL("./0080_messages_agent_author_named.sql", import.meta.url).pathname,
      )
      const [backfill, announce] = (await file.text()).split("--> statement-breakpoint")
      await listening.unsafe(backfill)
      await listening.unsafe(announce)
    } finally {
      await listening.end()
    }

    const [row] = await sql<{ author_agent_id: string | null }[]>`
      SELECT author_agent_id FROM kernel.messages WHERE id = ${id}`
    expect(row?.author_agent_id).toBeNull()
    expect(notices.some((n) => /could not be attributed/.test(n))).toBe(true)
  })
})
