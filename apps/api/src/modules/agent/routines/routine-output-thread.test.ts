// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P4b-D6: a routine's destination.
//
// The picker sends a thread id as `reportThreadId`, the one "where it posts"
// field; the routine may only post where its OWNER sits, so the id alone is not
// enough. The routine's own run thread (`outputThreadId`) is internal and never
// set from an edit. The list payload also has to say which agent owns each
// routine, or the picker cannot tell which threads to offer in the first place.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { app } from "~/app"
import { sql } from "~/db"
import { env } from "~/lib/env"
import { signAccessToken } from "~/modules/auth/jwt"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = crypto.randomUUID()
const OWNER = crypto.randomUUID()
const STRANGER = crypto.randomUUID()
const AGENT = crypto.randomUUID()
const ROUTINE = crypto.randomUUID()
const SEATED_ROOM = crypto.randomUUID()
const STRANGE_ROOM = crypto.randomUUID()
const DM = crypto.randomUUID()
const tag = crypto.randomUUID().slice(0, 8)

let token: string

const updateRoutine = (body: Record<string, string | null>) =>
  app.request(`/api/agent/routines/${ROUTINE}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })

const setDestination = (reportThreadId: string | null) => updateRoutine({ reportThreadId })

const storedThreads = async () => {
  const [row] = await sql<{ report_thread_id: string | null; output_thread_id: string | null }[]>`
    SELECT report_thread_id, output_thread_id FROM kernel.routines WHERE id = ${ROUTINE}`
  return row
}
const storedDestination = async () => (await storedThreads()).report_thread_id

describe("routine output thread", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'ROT Org', ${`rot-${tag}`})`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${OWNER}, ${ORG}, ${`rot-${tag}@t.com`}, 'Owner')`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${STRANGER}, ${ORG}, ${`rot-other-${tag}@t.com`}, 'Stranger')`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id, scope_ceiling)
      VALUES (${AGENT}, ${ORG}, 'personal', ${`@rot-${tag}`}, 'ROT Agent', ${OWNER}, '[]'::jsonb)`
    for (const [id, handle, type, member] of [
      [SEATED_ROOM, `rot-seated-${tag}`, "thread", OWNER],
      [STRANGE_ROOM, `rot-strange-${tag}`, "thread", STRANGER],
      [DM, `rot-dm-${tag}`, "agent_chat", OWNER],
    ] as const) {
      await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${id}, ${ORG}, ${handle}, ${type}, ${member})`
      await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${id}, ${member}, ${ORG})`
    }
    await sql`INSERT INTO kernel.thread_participants (thread_id, agent_id, org_id, participant_type)
      VALUES (${SEATED_ROOM}, ${AGENT}, ${ORG}, 'agent')`
    await sql`INSERT INTO kernel.thread_participants (thread_id, agent_id, org_id, participant_type)
      VALUES (${DM}, ${AGENT}, ${ORG}, 'agent')`
    await sql`INSERT INTO kernel.routines (id, org_id, owner_user_id, owner_agent_id, name, description, kind, cron, timezone, prompt, visibility, scopes, created_by_actor_type)
      VALUES (${ROUTINE}, ${ORG}, ${OWNER}, ${AGENT}, ${`rot-routine-${tag}`}, 'digest', 'recurring', '0 9 * * *', 'UTC', 'do it', 'personal', '{}'::text[], 'user')`
    token = await signAccessToken(
      {
        userId: OWNER,
        orgId: ORG,
        name: "Owner",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["*"],
      },
      env.JWT_SECRET,
    )
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.routines WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
    await releaseTestLock()
  })

  it("moves the routine to a thread its owner sits in", async () => {
    expect((await setDestination(SEATED_ROOM)).status).toBe(200)
    expect(await storedDestination()).toBe(SEATED_ROOM)
  })

  it("accepts a direct chat with that agent", async () => {
    expect((await setDestination(DM)).status).toBe(200)
    expect(await storedDestination()).toBe(DM)
  })

  it("refuses a room the routine's owner has no seat in", async () => {
    const res = await setDestination(STRANGE_ROOM)
    expect(res.status).toBe(400)
    expect(await storedDestination()).toBe(DM)
  })

  it("null detaches the routine from its thread", async () => {
    expect((await setDestination(null)).status).toBe(200)
    expect(await storedDestination()).toBe(null)
  })

  it("an edit naming a run thread leaves the routine's own thread alone", async () => {
    expect((await updateRoutine({ outputThreadId: SEATED_ROOM })).status).toBe(200)
    expect((await storedThreads()).output_thread_id).toBe(null)
  })

  it("the routine list says which agent owns each routine", async () => {
    const res = await app.request("/api/agent/routines", {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const body: any = await res.json()
    const row = (body.data ?? body).find((r: any) => r.id === ROUTINE)
    expect(row.ownerAgentId).toBe(AGENT)
  })
})
