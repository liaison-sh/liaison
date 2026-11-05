// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P4b-D7: a channel nobody has joined yet still has to say who runs it.
//
// The discoverable list carried counts only, so an unjoined channel could not
// show its role agent and the "who is in here" question could not be answered
// before joining. Identities only (id, handle, display name), never messages.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { app } from "~/app"
import { sql } from "~/db"
import { env } from "~/lib/env"
import { signAccessToken } from "~/modules/auth/jwt"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = crypto.randomUUID()
const MEMBER = crypto.randomUUID()
const INSIDER = crypto.randomUUID()
const AGENT = crypto.randomUUID()
const QUIET_AGENT = crypto.randomUUID()
const CHANNEL = crypto.randomUUID()
const EMPTY_CHANNEL = crypto.randomUUID()
const tag = crypto.randomUUID().slice(0, 8)

let token: string

describe("GET /api/threads/discoverable carries agent identities", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'DA Org', ${`da-${tag}`})`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${MEMBER}, ${ORG}, ${`da-m-${tag}@t.com`}, 'Member')`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${INSIDER}, ${ORG}, ${`da-i-${tag}@t.com`}, 'Insider')`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id, scope_ceiling)
      VALUES (${AGENT}, ${ORG}, 'role', ${`@da-support-${tag}`}, 'Support', NULL, '[]'::jsonb)`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id, scope_ceiling)
      VALUES (${QUIET_AGENT}, ${ORG}, 'role', ${`@da-quiet-${tag}`}, 'Quiet', NULL, '[]'::jsonb)`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by, discoverable)
      VALUES (${CHANNEL}, ${ORG}, ${`da-chan-${tag}`}, 'thread', ${INSIDER}, true)`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by, discoverable)
      VALUES (${EMPTY_CHANNEL}, ${ORG}, ${`da-empty-${tag}`}, 'thread', ${INSIDER}, true)`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${CHANNEL}, ${INSIDER}, ${ORG})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, agent_id, org_id, participant_type)
      VALUES (${CHANNEL}, ${AGENT}, ${ORG}, 'agent')`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${EMPTY_CHANNEL}, ${INSIDER}, ${ORG})`
    await sql`
      INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, content, required_scopes)
      VALUES (${CHANNEL}, ${ORG}, ${INSIDER}, 'user', 'a private word', '{}'::text[])`
    token = await signAccessToken(
      {
        userId: MEMBER,
        orgId: ORG,
        name: "Member",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["kernel:threads:read"],
      },
      env.JWT_SECRET,
    )
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
    await releaseTestLock()
  })

  it("names the agents seated in a channel the caller has not joined", async () => {
    const res = await app.request("/api/threads/discoverable", {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const rows: any[] = ((await res.json()) as any).data
    const channel = rows.find((r) => r.id === CHANNEL)
    expect(channel.agents).toEqual([
      { id: AGENT, handle: `@da-support-${tag}`, displayName: "Support" },
    ])
    // Metadata, not content: nothing said in the channel travels with the row.
    expect(JSON.stringify(channel)).not.toContain("a private word")
    // An agent of the org that is not in this channel is not listed on it.
    expect(JSON.stringify(channel)).not.toContain(QUIET_AGENT)
  })

  it("opening that same channel by id names the agents too", async () => {
    // The list row says who runs the channel; the detail a non-member gets by
    // opening it must not answer with less, or the card the list drew loses
    // its identity the moment it is clicked.
    const res = await app.request(`/api/threads/${CHANNEL}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const detail: any = ((await res.json()) as any).data
    expect(detail.agents).toEqual([
      { id: AGENT, handle: `@da-support-${tag}`, displayName: "Support" },
    ])
    expect(JSON.stringify(detail)).not.toContain("a private word")
    expect(JSON.stringify(detail)).not.toContain(QUIET_AGENT)
  })

  it("a channel with no agent seat carries an empty list, never a missing key", async () => {
    const res = await app.request("/api/threads/discoverable", {
      headers: { Authorization: `Bearer ${token}` },
    })
    const rows: any[] = ((await res.json()) as any).data
    expect(rows.find((r) => r.id === EMPTY_CHANNEL).agents).toEqual([])
  })
})
