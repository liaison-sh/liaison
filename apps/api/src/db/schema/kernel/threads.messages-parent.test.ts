// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P3b-T01: `kernel.messages` gains a nullable self referencing
// `parent_message_id`. It is the one shape that carries BOTH the nesting Home
// renders and every dispatch guard: hop depth is the length of the parent
// chain, the root turn is that chain's root, the per root cap counts agent
// authored descendants of the root, and the dedupe is a sibling scan.
//
// `parent_message_id IS NULL` is the audience asymmetry: a human facing turn is
// flattened to the thread root, an agent only turn nests.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"

const ORG = crypto.randomUUID()
const AUTHOR = crypto.randomUUID()
const tag = ORG.slice(0, 8)
let THREAD = ""

async function insertMessage(content: string, parentId: string | null): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO kernel.messages
      (thread_id, org_id, author_id, author_type, content, required_scopes, parent_message_id)
    VALUES (${THREAD}, ${ORG}, ${AUTHOR}, 'user', ${content}, '{}', ${parentId})
    RETURNING id`
  return row.id
}

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug)
    VALUES (${ORG}, 'P3b T01', ${`p3b-t01-${tag}`})`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
    VALUES (${AUTHOR}, ${ORG}, ${`p3b-t01-${tag}@test.com`}, 'P3b', 'active', 'hash')`
  const [thread] = await sql<{ id: string }[]>`
    INSERT INTO kernel.threads (org_id, handle, type, created_by)
    VALUES (${ORG}, ${`p3b-t01-thr-${tag}`}, 'thread', ${AUTHOR}) RETURNING id`
  THREAD = thread.id
})

afterAll(async () => {
  await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
})

describe("kernel.messages parent_message_id", () => {
  it("messages accepts a null parent message id", async () => {
    const id = await insertMessage("a flat human turn", null)
    const [row] = await sql<{ parent_message_id: string | null }[]>`
      SELECT parent_message_id FROM kernel.messages WHERE id = ${id}`
    expect(row.parent_message_id).toBeNull()
  })

  it("messages accepts a parent message id in the same thread", async () => {
    const parentId = await insertMessage("the asking turn", null)
    const childId = await insertMessage("the nested answer", parentId)
    const [row] = await sql<{ parent_message_id: string | null }[]>`
      SELECT parent_message_id FROM kernel.messages WHERE id = ${childId}`
    expect(row.parent_message_id).toBe(parentId)
  })

  it("messages rejects a parent message id that does not exist", async () => {
    let failed = ""
    try {
      await insertMessage("an orphan", crypto.randomUUID())
    } catch (err) {
      failed = String((err as { code?: string }).code ?? err)
    }
    expect(failed).toBe("23503")
  })

  it("deleting a parent message deletes its nested children", async () => {
    const parentId = await insertMessage("the parent to remove", null)
    const childId = await insertMessage("the child that follows it", parentId)
    await sql`DELETE FROM kernel.messages WHERE id = ${parentId}`
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM kernel.messages WHERE id = ${childId}`
    expect(rows.length).toBe(0)
  })
})
