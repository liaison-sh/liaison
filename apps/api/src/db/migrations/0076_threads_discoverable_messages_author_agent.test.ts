// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P4a-T08: threads.discoverable (a channel) and messages.author_agent_id (A8,
// the speaking agent).
//
// The invariant the database enforces TODAY is that attribution and authorship
// agree: a message that names an agent is agent-authored. A8's other half ("an
// agent-authored message names its agent") landed in 0080, once every writer
// set the column. The guard is a write-time
// TRIGGER rather than a CHECK so that half can land there without breaking the
// GDPR erasure cascade, which hard-deletes personal agents, KEEPS their
// messages, and reaches them through the key's ON DELETE SET NULL.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"

const ORG = crypto.randomUUID()
const OTHER_ORG = crypto.randomUUID()
const USER = crypto.randomUUID()
const AGENT = crypto.randomUUID()
const FOREIGN_AGENT = crypto.randomUUID()
const tag = ORG.slice(0, 8)
let THREAD = ""

const rejects = (fn: () => Promise<unknown>) => expect((async () => await fn())()).rejects

beforeAll(async () => {
  for (const [org, slug] of [
    [ORG, `p4a-t08-a-${tag}`],
    [OTHER_ORG, `p4a-t08-b-${tag}`],
  ]) {
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${org}, 'P4a Org', ${slug})`
  }
  await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
    VALUES (${USER}, ${ORG}, ${`p4a-t08-${tag}@test.com`}, 'P4a', 'active', 'hash')`
  for (const [id, org, handle] of [
    [AGENT, ORG, `p4a-t08-${tag}`],
    [FOREIGN_AGENT, OTHER_ORG, `p4a-t08-foreign-${tag}`],
  ]) {
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name)
      VALUES (${id}, ${org}, 'role', ${handle}, 'P4a Agent')`
  }
  const [thread] = await sql<{ id: string }[]>`
    INSERT INTO kernel.threads (org_id, handle, type, created_by)
    VALUES (${ORG}, ${`p4a-t08-thr-${tag}`}, 'thread', ${USER}) RETURNING id`
  THREAD = thread!.id
})

afterAll(async () => {
  for (const org of [ORG, OTHER_ORG]) {
    await sql`DELETE FROM kernel.messages WHERE org_id = ${org}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${org}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${org}`
    await sql`DELETE FROM kernel.agents WHERE org_id = ${org}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${org}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${org}`
  }
})

async function insertMessage(
  authorType: string,
  authorAgentId: string | null,
  content: string,
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO kernel.messages
      (thread_id, org_id, author_id, author_type, author_agent_id, content, required_scopes)
    VALUES (${THREAD}, ${ORG}, ${USER}, ${authorType}, ${authorAgentId}, ${content}, '{}')
    RETURNING id`
  return row!.id
}

describe("threads discoverable and messages author_agent_id", () => {
  it("threads discoverable column defaults to false for a newly inserted row", async () => {
    const [row] = await sql<{ discoverable: boolean }[]>`
      SELECT discoverable FROM kernel.threads WHERE id = ${THREAD}`
    expect(row?.discoverable).toBe(false)
  })

  it("threads accept a discoverable channel row", async () => {
    const [row] = await sql<{ discoverable: boolean }[]>`
      INSERT INTO kernel.threads (org_id, handle, type, created_by, discoverable)
      VALUES (${ORG}, ${`p4a-t08-chan-${tag}`}, 'thread', ${USER}, true)
      RETURNING discoverable`
    expect(row?.discoverable).toBe(true)
  })

  it("messages reject attribution on a message that is not agent-authored", async () => {
    await rejects(() => insertMessage("user", AGENT, "human wearing an agent face")).toThrow(
      /may only name an agent on an agent-authored message/,
    )
  })

  it("messages accept an agent-authored message that names its agent", async () => {
    const id = await insertMessage("agent", AGENT, "attributed agent line")
    const [row] = await sql<{ author_agent_id: string | null }[]>`
      SELECT author_agent_id FROM kernel.messages WHERE id = ${id}`
    expect(row?.author_agent_id).toBe(AGENT)
  })

  it("messages refuse an agent message that names no agent", async () => {
    // The handover this file anticipated: 0080 arms the other half once every
    // writer names its agent. A row whose agent was later ERASED still exists
    // (the cascade nulls the column by UPDATE, covered below); only a fresh
    // INSERT is refused.
    await rejects(() => insertMessage("agent", null, "legacy agent line")).toThrow(
      /requires author_agent_id to name the speaking agent/,
    )
  })

  it("messages allow a user-authored message with no author_agent_id", async () => {
    const id = await insertMessage("user", null, "human line")
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.messages WHERE id = ${id}`
    expect(row?.n).toBe(1)
  })

  it("messages reject an author agent belonging to another org", async () => {
    await rejects(() => insertMessage("agent", FOREIGN_AGENT, "cross org")).toThrow(/foreign key/)
  })

  it("deleting the speaking agent clears the attribution and keeps the message", async () => {
    const doomed = crypto.randomUUID()
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name)
      VALUES (${doomed}, ${ORG}, 'role', ${`p4a-t08-doomed-${tag}`}, 'Doomed')`
    const id = await insertMessage("agent", doomed, "agent line")
    await sql`DELETE FROM kernel.agents WHERE id = ${doomed}`
    const [row] = await sql<{ author_agent_id: string | null; author_type: string }[]>`
      SELECT author_agent_id, author_type FROM kernel.messages WHERE id = ${id}`
    expect(row?.author_type).toBe("agent")
    expect(row?.author_agent_id).toBeNull()
    // And the orphaned row stays writable: editing history must not be hostage
    // to an agent that no longer exists.
    await sql`UPDATE kernel.messages SET content = 'edited' WHERE id = ${id}`
  })

  it("messages reject an update that moves attribution onto a human message", async () => {
    const id = await insertMessage("user", null, "plain human line")
    await rejects(
      () => sql`UPDATE kernel.messages SET author_agent_id = ${AGENT} WHERE id = ${id}`,
    ).toThrow(/may only name an agent on an agent-authored message/)
  })
})
