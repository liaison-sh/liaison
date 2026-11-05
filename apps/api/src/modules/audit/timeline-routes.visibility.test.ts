// SPDX-License-Identifier: FSL-1.1-ALv2
// The timeline scope says "may read this KIND of record"; the history of one
// record must also be a record the caller can see through RLS.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { env } from "~/lib/env"
import { signAccessToken } from "~/modules/auth/jwt"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = "00000000-0000-4000-8300-00000000b001"
const ALICE = "00000000-0000-4000-8300-00000000b002"
const BOB = "00000000-0000-4000-8300-00000000b003"
const THREAD = "00000000-0000-4000-8300-00000000b004"
const MESSAGE = "00000000-0000-4000-8300-00000000b005"

const token = (userId: string, scopes: string[] = ["kernel:messages:read"]) =>
  signAccessToken(
    {
      userId,
      orgId: ORG,
      name: "T",
      authVersion: 1,
      permissionVersion: 1,
      scopes,
      dimensionGrants: {},
    },
    env.JWT_SECRET,
  )

describe("timeline of an entity the caller cannot see", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'TimelineVis', 'timeline-vis-org') ON CONFLICT DO NOTHING`
    for (const [id, e] of [
      [ALICE, "tl-alice@test.com"],
      [BOB, "tl-bob@test.com"],
    ]) {
      await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${id}, ${ORG}, ${e}, 'U') ON CONFLICT DO NOTHING`
    }
    await sql`INSERT INTO kernel.threads (id, org_id, handle, created_by) VALUES (${THREAD}, ${ORG}, 'tlvis', ${BOB}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, org_id, user_id) VALUES (${THREAD}, ${ORG}, ${BOB}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.messages (id, thread_id, org_id, author_id, content, required_scopes) VALUES (${MESSAGE}, ${THREAD}, ${ORG}, ${BOB}, 'private', '{}'::text[]) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.timeline_entries (org_id, app, entity_type, entity_id, actor_type, action, summary) VALUES (${ORG}, 'kernel', 'message', ${MESSAGE}, 'user', 'update', 'edited')`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.timeline_entries WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
    await releaseTestLock()
  })

  it("a non-participant gets 404, the participant gets the history", async () => {
    const url = `/api/timeline/kernel/message/${MESSAGE}`
    const outsider = await app.request(url, {
      headers: { Authorization: `Bearer ${await token(ALICE)}` },
    })
    expect(outsider.status).toBe(404)
    const insider = await app.request(url, {
      headers: { Authorization: `Bearer ${await token(BOB)}` },
    })
    expect(insider.status).toBe(200)
  })

  it("each entry names its actor: the person or agent by name, null for a system entry (never an id)", async () => {
    const AGENT = "00000000-0000-4000-8300-00000000b007"
    await sql`UPDATE kernel.users SET name = 'Bob Builder' WHERE id = ${BOB}`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name) VALUES (${AGENT}, ${ORG}, 'role', '@tlvis-support', 'Support Desk') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.timeline_entries (org_id, app, entity_type, entity_id, actor_id, actor_type, action, summary, created_at) VALUES
      (${ORG}, 'kernel', 'message', ${MESSAGE}, ${BOB}, 'user', 'create', 'created', now() - interval '2 minutes'),
      (${ORG}, 'kernel', 'message', ${MESSAGE}, ${AGENT}, 'agent', 'reply', 'replied', now() - interval '1 minute')`
    const res = await app.request(`/api/timeline/kernel/message/${MESSAGE}`, {
      headers: { Authorization: `Bearer ${await token(BOB)}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: Array<{ action: string; actorName: string | null }> }
    const byAction = new Map(body.data.map((e) => [e.action, e.actorName]))
    expect(byAction.get("create")).toBe("Bob Builder")
    expect(byAction.get("reply")).toBe("Support Desk")
    // The seeded entry has no actor: a system change carries no name.
    expect(byAction.get("update")).toBeNull()
    await sql`DELETE FROM kernel.agents WHERE id = ${AGENT}`
  })

  it("an app record with no resolvable table shows no history, even to a holder of the read scope", async () => {
    const WIDGET = "00000000-0000-4000-8300-00000000b006"
    await sql`INSERT INTO kernel.timeline_entries (org_id, app, entity_type, entity_id, actor_type, action, summary) VALUES (${ORG}, 'nosuchapp', 'widget', ${WIDGET}, 'user', 'update', 'secret')`
    const res = await app.request(`/api/timeline/nosuchapp/widget/${WIDGET}`, {
      headers: { Authorization: `Bearer ${await token(BOB, ["nosuchapp:widgets:read"])}` },
    })
    expect(res.status).toBe(404)
  })
})
