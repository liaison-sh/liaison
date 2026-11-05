// SPDX-License-Identifier: FSL-1.1-ALv2
//
// 0080 refuses an agent-authored row that names no agent, so "we could not
// work out which agent spoke" must never be an outcome on the write path: it
// would cost the reply itself, not just its attribution. The last resort is
// the org's own `@base` system agent, created here if the org has none.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import type { RlsClient } from "~/db"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { sendMessage } from "~/modules/threads/message"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = crypto.randomUUID()
const USER = crypto.randomUUID()
const THREAD = crypto.randomUUID()
const tag = crypto.randomUUID().slice(0, 8)

describe("an agent reply nobody can attribute", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Base Attr Org', ${`ba-${tag}`})`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER}, ${ORG}, ${`ba-${tag}@t.com`}, 'Nobody')`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${THREAD}, ${ORG}, ${`ba-thread-${tag}`}, 'agent_chat', ${USER})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${THREAD}, ${USER}, ${ORG})`
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

  it("is written and attributed to the org's base agent, which is created if missing", async () => {
    // The org has no personal agent and no system agent at all.
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.agents WHERE org_id = ${ORG}`
    expect(n).toBe(0)

    const sent = await withPrivilegedDb(ORG, "test-base-attribution", (tx) =>
      sendMessage(tx as unknown as RlsClient, {
        orgId: ORG,
        userId: USER,
        threadId: THREAD,
        content: "an answer nobody can attribute",
        authorType: "agent",
        // No agent named by the caller, and no run frame open.
        requiredScopes: [],
      }),
    )
    if (!sent) throw new Error("the agent reply was not written")

    const [row] = await sql<{ author_agent_id: string | null }[]>`
      SELECT author_agent_id FROM kernel.messages WHERE id = ${sent.id}`
    expect(row.author_agent_id).not.toBe(null)
    const [base] = await sql<{ id: string; kind: string; handle: string }[]>`
      SELECT id, kind, handle FROM kernel.agents WHERE org_id = ${ORG}`
    expect(base.handle).toBe("@base")
    expect(base.kind).toBe("system")
    expect(row.author_agent_id).toBe(base.id)
  })
})
