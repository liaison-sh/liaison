// SPDX-License-Identifier: FSL-1.1-ALv2
//
// 0252: an agent turn's reply whose required_scopes carry a grant wildcard (`*`, or a `*`
// segment anywhere but last) loses those entries and keeps every other one in order, only in an
// org where every wildcard-bearing message is such a reply. A system row (an approval failure
// notice, stamped with the requester's whole grant set) is never touched, and its org is left
// entirely as it is; an external client's post is treated the same way. Nothing is ever made
// readable by someone who could not read it: a base-only member still cannot read the notice.
// A second run changes nothing. The statement runs against rows seeded as the old runtime
// stored them.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import { sql } from "~/db"
import { withRlsContext } from "~/db/rls"
import { messages } from "~/db/schema/kernel"
import { sendMessage } from "~/modules/threads/message"
import * as minimal from "~/seed/tiers/minimal"

type Where = { org: string; user: string; thread: string }
let A: Where = { org: "", user: "", thread: "" }
let B: Where = { org: "", user: "", thread: "" }
let C: Where = { org: "", user: "", thread: "" }
let B_MEMBER = ""

const FILE = readFileSync(
  join(import.meta.dir, "0252_messages_required_scopes_wildcard_repair.sql"),
  "utf8",
)

/** The migration's repair statement: the one UPDATE of kernel.messages. */
function repairStatement(): string {
  const stmt = FILE.split("--> statement-breakpoint").find((s) =>
    s.includes("UPDATE kernel.messages"),
  )
  if (!stmt) throw new Error("0252 has no UPDATE kernel.messages statement")
  return stmt
}

/**
 * A message stored as the old runtime left it. Posted through the real write path (which no
 * longer stamps a wildcard), then given the stored shape the repair meets: its author type and
 * the old stamp.
 */
async function store(
  where: { org: string; user: string; thread: string },
  authorType: "agent" | "system" | "user",
  required: string[],
  metadata: Record<string, unknown> | null = null,
) {
  const actor = {
    actorType: "user" as const,
    userId: where.user,
    orgId: where.org,
    scopes: ["*"],
    dimensionGrants: {},
  }
  const row = await withRlsContext(actor, (tx) =>
    sendMessage(tx, {
      orgId: where.org,
      userId: where.user,
      threadId: where.thread,
      content: "m",
      authorType: authorType === "user" ? "user" : "agent",
      requiredScopes: [],
    }),
  )
  if (!row) throw new Error("the test message was not stored")
  await sql`UPDATE kernel.messages SET required_scopes = ${required}::text[],
      author_type = ${authorType},
      author_agent_id = CASE WHEN ${authorType} = 'agent' THEN author_agent_id END,
      metadata = ${metadata === null ? null : JSON.stringify(metadata)}::jsonb
    WHERE id = ${row.id}`
  return row.id
}

async function scopesOf(id: string): Promise<string[] | undefined> {
  return (
    await sql<{ r: string[] }[]>`
      SELECT to_jsonb(required_scopes) AS r FROM kernel.messages WHERE id = ${id}`
  )[0]?.r
}

async function world(name: string, withMember = false): Promise<Where & { member: string }> {
  const org = (await minimal.secondOrg({ name })).orgId
  const user = (await minimal.person(org)).id
  const member = withMember ? (await minimal.person(org)).id : ""
  const thread = await minimal.thread(org, user, {
    title: name,
    participantIds: member ? [member] : [],
  })
  return { org, user, thread, member }
}

beforeAll(async () => {
  A = await world("Wildcard Repair Agent Only")
  const b = await world("Wildcard Repair With Notice", true)
  B = b
  B_MEMBER = b.member
  C = await world("Wildcard Repair With Client Post")
})

afterAll(async () => {
  for (const w of [A, B, C]) await sql`DELETE FROM kernel.messages WHERE org_id = ${w.org}`
})

describe("0252 messages required_scopes wildcard repair", () => {
  it("drops wildcard entries from agent turn stamps, keeps the rest in order, re-runs as a no-op", async () => {
    const mixed = await store(A, "agent", ["*", "clevel", "kernel:threads:read"])
    const onlyStar = await store(A, "agent", ["*"])
    const approve = await store(A, "agent", ["*:approve", "tickets:tickets:read"])
    const trailing = await store(A, "agent", ["*:read", "crm:*", "a:*:b", "x:y:read"])
    const clean = await store(A, "agent", ["kernel:threads:read", "clevel"])
    const empty = await store(A, "agent", [])

    const statement = repairStatement()
    await sql.unsafe(statement)

    expect(await scopesOf(mixed)).toEqual(["clevel", "kernel:threads:read"])
    // Nothing would be left: an empty stamp opens the row to the room, so it stays hidden.
    expect(await scopesOf(onlyStar)).toEqual(["*"])
    expect(await scopesOf(approve)).toEqual(["tickets:tickets:read"])
    // A trailing `p:*` is coverable (the grant `p` or `p:*`), so it is kept.
    expect(await scopesOf(trailing)).toEqual(["crm:*", "x:y:read"])
    expect(await scopesOf(clean)).toEqual(["kernel:threads:read", "clevel"])
    expect(await scopesOf(empty)).toEqual([])

    const ids = [mixed, onlyStar, approve, trailing, clean, empty]
    const before = await sql<{ id: string; r: string[] }[]>`
      SELECT id, to_jsonb(required_scopes) AS r FROM kernel.messages WHERE id = ANY(${ids}::uuid[]) ORDER BY id`
    const second = await sql.unsafe(statement)
    expect(second.count).toBe(0)
    const after = await sql<{ id: string; r: string[] }[]>`
      SELECT id, to_jsonb(required_scopes) AS r FROM kernel.messages WHERE id = ANY(${ids}::uuid[]) ORDER BY id`
    expect(after).toEqual(before)
  })

  it("never touches a system failure notice, nor any row of its org, so a base-only member still cannot read it", async () => {
    const base = ["kernel:threads:read"]
    const notice = await store(B, "system", ["*", ...base])
    const reply = await store(B, "agent", ["*", ...base])
    const user = await store(B, "user", ["*", "x:y:read"])
    await sql.unsafe(repairStatement())
    expect(await scopesOf(notice)).toEqual(["*", ...base])
    // The org holds a wildcard row the repair cannot vouch for: a later turn may have read it.
    expect(await scopesOf(reply)).toEqual(["*", ...base])
    expect(await scopesOf(user)).toEqual(["*", "x:y:read"])
    // Visibility, through the real read policy: a participant holding the base scopes only.
    await minimal.revokeRole(B_MEMBER, "member")
    for (const scope of base) await minimal.grantScope(B_MEMBER, scope)
    const visible = await withRlsContext(
      { actorType: "user", userId: B_MEMBER, orgId: B.org, scopes: base, dimensionGrants: {} },
      async (tx) =>
        (
          await tx.select({ id: messages.id }).from(messages).where(eq(messages.threadId, B.thread))
        ).map((m) => m.id),
    )
    expect(visible).not.toContain(notice)
  })

  it("leaves an org with an external client's wildcard post as it is", async () => {
    const post = await store(C, "agent", ["*", "clevel"], { externalClientPost: true })
    const reply = await store(C, "agent", ["*", "kernel:threads:read"])
    await sql.unsafe(repairStatement())
    expect(await scopesOf(post)).toEqual(["*", "clevel"])
    expect(await scopesOf(reply)).toEqual(["*", "kernel:threads:read"])
  })

  it("sets a lock timeout before the repair and is listed in the journal", () => {
    expect(FILE.search(/^SET LOCAL lock_timeout = '5s';/m)).toBeGreaterThanOrEqual(0)
    expect(FILE.search(/^SET LOCAL lock_timeout/m)).toBeLessThan(
      FILE.search(/^UPDATE kernel\.messages/m),
    )
    const journal = JSON.parse(readFileSync(join(import.meta.dir, "meta/_journal.json"), "utf8"))
    const tags = (journal.entries as { tag: string }[]).map((e) => e.tag)
    expect(tags).toContain("0252_messages_required_scopes_wildcard_repair")
  })
})
