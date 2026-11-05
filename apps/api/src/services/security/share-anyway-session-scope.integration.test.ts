// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Share anyway discloses at the NARROWER of two scope sets: the requester's
// LIVE grants and the scopes the requester's own session carries.
//
// The two can disagree in both directions, because a session's scopes come from
// the JWT claim (`middleware/auth.ts` sets them from `payload.scopes`) while the
// live grants come from the database:
//
//   - a scope REVOKED after the token was minted is still in the token. Reading
//     the token alone would disclose a capability the admin has taken away.
//   - a scope GRANTED after the token was minted is not in the token yet. Every
//     other route in the product refuses that scope until the user re-
//     authenticates, so reading the live grants alone would let Share anyway
//     disclose at a scope no other surface would honour: an elevation relative
//     to the rest of the system.
//
// The intersection refuses both. When the two agree, which is the ordinary
// case, nothing changes.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import type { UserContext } from "~/db/rls"
import {
  type ShareAnywayRerun,
  type ShareAnywayRerunInput,
  shareAnyway,
} from "~/services/security/share-anyway"

const A = "shatok:a:read"
const CEILING = [A]

describe("Share anyway discloses at live grants intersected with the session's own scopes", () => {
  const ORG_ID = crypto.randomUUID()
  const tag = ORG_ID.slice(0, 8)

  type Fixture = {
    userId: string
    agentId: string
    threadId: string
    turnId: string
    /** The scopes this requester's session carries, as the JWT claim would. */
    sessionScopes: string[]
  }

  let agree: Fixture
  let revoked: Fixture
  let granted: Fixture

  /** A requester with `liveGrants` in the database and `sessionScopes` in their session. */
  async function makeFixture(
    label: string,
    liveGrants: string[],
    sessionScopes: string[],
  ): Promise<Fixture> {
    const userId = crypto.randomUUID()
    const agentId = crypto.randomUUID()
    const threadId = crypto.randomUUID()
    const slug = `${label}-${tag}`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
      VALUES (${userId}, ${ORG_ID}, ${`share-anyway-session-${slug}@test.com`}, ${label}, 'x')`
    for (const scope of liveGrants) {
      await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
        VALUES (${userId}, ${ORG_ID}, ${scope})`
    }
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id, scope_ceiling)
      VALUES (${agentId}, ${ORG_ID}, 'personal', ${`@share-anyway-session-${slug}`},
        'Share anyway agent', ${userId}, ${JSON.stringify(CEILING)}::jsonb)`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${threadId}, ${ORG_ID}, ${`share-anyway-session-${slug}`}, 'thread', ${userId})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
      VALUES (${threadId}, ${userId}, ${ORG_ID})`
    const [turn] = await sql<{ id: string }[]>`
      INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, content, required_scopes)
      VALUES (${threadId}, ${ORG_ID}, ${userId}, 'user', '@agent show the deal', '{}')
      RETURNING id`
    return { userId, agentId, threadId, turnId: turn?.id ?? "", sessionScopes }
  }

  function ctxFor(f: Fixture): UserContext {
    return {
      actorType: "user",
      userId: f.userId,
      orgId: ORG_ID,
      scopes: f.sessionScopes,
      dimensionGrants: {},
    }
  }

  function recordingRerun(requiredScopes: string[]): {
    rerun: ShareAnywayRerun
    calls: ShareAnywayRerunInput[]
  } {
    const calls: ShareAnywayRerunInput[] = []
    return {
      calls,
      rerun: async (input) => {
        calls.push(input)
        return [{ content: "shared result", requiredScopes, agentAuthorLabel: "agent" }]
      },
    }
  }

  function share(f: Fixture, rerun: ShareAnywayRerun): Promise<{ messageIds: string[] }> {
    return shareAnyway(
      ctxFor(f),
      { turnId: f.turnId, requesterId: f.userId, roomId: f.threadId, agentId: f.agentId },
      { rerun },
    )
  }

  async function messageCount(f: Fixture): Promise<number> {
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.messages WHERE thread_id = ${f.threadId}`
    return row?.n ?? -1
  }

  async function auditCount(f: Fixture): Promise<number> {
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.audit_log
       WHERE org_id = ${ORG_ID} AND action = 'share_anyway' AND entity_id = ${f.threadId}`
    return row?.n ?? -1
  }

  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG_ID}, 'ShareAnywaySessionOrg', ${`share-anyway-session-${tag}`})`
    // The ordinary case: what the database says and what the session carries agree.
    agree = await makeFixture("agree", [A], [A])
    // Revoked at 10:00, the 09:00 token still carries it.
    revoked = await makeFixture("revoked", [], [A])
    // Granted at 10:00, the 09:00 token does not carry it yet.
    granted = await makeFixture("granted", [A], [])
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${ORG_ID}`.catch(() => {})
    await sql`DELETE FROM kernel.audit_log WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
  })

  it("a scope revoked from the live grants but still in the session token is not disclosed", async () => {
    const beforeMessages = await messageCount(revoked)
    const beforeAudit = await auditCount(revoked)
    const { rerun, calls } = recordingRerun([A])

    // The rerun is handed the intersection, which no longer contains the
    // revoked scope, and a result claiming it is refused before anything is
    // persisted.
    await expect(share(revoked, rerun)).rejects.toThrow(/E_SHARE_ANYWAY_SCOPE_WIDENED/)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.effectiveScope).toEqual([])
    expect(await messageCount(revoked)).toBe(beforeMessages)
    expect(await auditCount(revoked)).toBe(beforeAudit)
  })

  it("a scope granted in the live grants but absent from the session token is not disclosed", async () => {
    const beforeMessages = await messageCount(granted)
    const beforeAudit = await auditCount(granted)
    const { rerun, calls } = recordingRerun([A])

    // The other direction. Every other route refuses this scope until the
    // requester re-authenticates, so Share anyway refuses it too.
    await expect(share(granted, rerun)).rejects.toThrow(/E_SHARE_ANYWAY_SCOPE_WIDENED/)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.effectiveScope).toEqual([])
    expect(await messageCount(granted)).toBe(beforeMessages)
    expect(await auditCount(granted)).toBe(beforeAudit)
  })

  it("when the live grants and the session token agree, the share is unchanged", async () => {
    const beforeAudit = await auditCount(agree)
    const { rerun, calls } = recordingRerun([A])
    const { messageIds } = await share(agree, rerun)

    expect(calls[0]?.effectiveScope).toEqual([A])
    expect(messageIds).toHaveLength(1)
    const [row] = await sql<{ required_scopes: string[] }[]>`
      SELECT required_scopes FROM kernel.messages WHERE id = ${messageIds[0] ?? ""}`
    expect(row?.required_scopes).toEqual([A])
    expect(await auditCount(agree)).toBe(beforeAudit + 1)
    const [audit] = await sql<{ effective_scope: string[] | null }[]>`
      SELECT effective_scope FROM kernel.audit_log
       WHERE org_id = ${ORG_ID} AND action = 'share_anyway' AND entity_id = ${agree.threadId}
       ORDER BY timestamp DESC, id DESC LIMIT 1`
    expect(audit?.effective_scope).toEqual([A])
  })
})
