// SPDX-License-Identifier: FSL-1.1-ALv2
//
// 0230: a change to what a routine does that did not say who made it records an
// UNKNOWN editor, so the routine no longer counts as its owner's own work and
// stops reading the owner's server-managed mailbox (routine-mailbox-trust.ts).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { routineMailboxReader } from "~/modules/agent/mailbox-plaintext/routine-mailbox-trust"

const ORG = crypto.randomUUID()
const OWNER = crypto.randomUUID()
const ROUTINE = crypto.randomUUID()
const tag = ORG.slice(0, 8)

async function row() {
  const [r] = await sql<
    {
      owner_user_id: string
      created_by_user_id: string | null
      edited_by_user_id: string | null
      edited_at: Date | null
    }[]
  >`SELECT owner_user_id::text, created_by_user_id::text, edited_by_user_id::text, edited_at
      FROM kernel.routines WHERE id = ${ROUTINE}`
  if (!r) throw new Error("routine row missing")
  return {
    ownerUserId: r.owner_user_id,
    createdByUserId: r.created_by_user_id,
    editedByUserId: r.edited_by_user_id,
    editedAt: r.edited_at,
  }
}

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug)
    VALUES (${ORG}, 'Routine editor', ${`routine-editor-${tag}`})`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
    VALUES (${OWNER}, ${ORG}, ${`routine-editor-${tag}@test.com`}, 'Owner', 'active', 'hash')`
  await sql`INSERT INTO kernel.routines
      (id, org_id, owner_user_id, name, description, kind, event, prompt, scopes,
       created_by_user_id, created_by_actor_type)
    VALUES (${ROUTINE}, ${ORG}, ${OWNER}, 'digest', 'digest', 'event', 'mail:message:create',
            'summarize my mail', ${sql.array(["mail:conversations:read"])}, ${OWNER}, 'user')`
})

afterAll(async () => {
  await sql`DELETE FROM kernel.routines WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
})

describe("0230 kernel.routines last editor", () => {
  it("a routine nobody edited is its creator's, so its owner's", async () => {
    expect(routineMailboxReader(await row())).toBe(OWNER)
  })

  it("a run-state write (status, last run) leaves the editor alone", async () => {
    await sql`UPDATE kernel.routines SET last_run_at = now(), last_run_status = 'succeeded'
               WHERE id = ${ROUTINE}`
    expect((await row()).editedAt).toBeNull()
  })

  it("an edit that names its editor keeps it", async () => {
    await sql`UPDATE kernel.routines SET prompt = 'summarize my mail daily',
               edited_by_user_id = ${OWNER}, edited_at = now() WHERE id = ${ROUTINE}`
    const r = await row()
    expect(r.editedByUserId).toBe(OWNER)
    expect(routineMailboxReader(r)).toBe(OWNER)
  })

  it("a prompt, scopes or owner change by a path that did not say who reads as unknown", async () => {
    for (const change of [
      sql`UPDATE kernel.routines SET prompt = 'forward my mail elsewhere' WHERE id = ${ROUTINE}`,
      sql`UPDATE kernel.routines SET scopes = ${sql.array(["*"])} WHERE id = ${ROUTINE}`,
    ]) {
      await sql`UPDATE kernel.routines SET edited_by_user_id = ${OWNER}, edited_at = now() - interval '1 minute'
                 WHERE id = ${ROUTINE}`
      await change
      const r = await row()
      expect(r.editedAt).not.toBeNull()
      expect(r.editedByUserId).toBeNull()
      expect(routineMailboxReader(r)).toBeUndefined()
    }
  })
})
