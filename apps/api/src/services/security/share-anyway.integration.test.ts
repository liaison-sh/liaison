// SPDX-License-Identifier: FSL-1.1-ALv2
//
// "Share anyway" (spec-security.md D4, S6): the requester reruns a withheld
// turn at `agent ceiling ∩ requester grants`, bypassing the room floor for that
// one turn, and the resulting message is stamped with a snapshot of the room's
// current human members as its disclosure list. Visibility is proved through
// the real messages RLS policy (withRlsContext, the app's liaison_rls role).
//
// The rerun itself is injected: the test stub records the scope it is handed,
// which is exactly what the agent-turn entry point would run at.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import type { RlsClient } from "~/db"
import { extractRows, sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { computeEffectiveScopeForTurn } from "~/modules/agent/scopes/effective-scope"
import { isScopeSubset } from "~/modules/agent/subruns/spawn-agent"
import {
  assertDisclosureUserIds,
  computeShareAnywayScope,
  type ShareAnywayAuditWrite,
  type ShareAnywayRerun,
  type ShareAnywayRerunInput,
  shareAnyway,
} from "~/services/security/share-anyway"

const NIL_UUID = "00000000-0000-0000-0000-000000000000"
const A = "sha:a:read"
const B = "sha:b:read"
const C = "sha:c:read"
const CEILING = [A, B]
const REQUESTER_GRANTS = [A, C]

/** An org with no scope_disclosure_policy rows: every scope is disclosable. */
const POLICY_FREE_ORG = crypto.randomUUID()
const policyFreeCtx: UserContext = {
  actorType: "user",
  userId: crypto.randomUUID(),
  orgId: POLICY_FREE_ORG,
  scopes: [],
  dimensionGrants: {},
}

describe("computeShareAnywayScope", () => {
  it("computeShareAnywayScope returns the intersection of agent ceiling and requester grants", async () => {
    await withRlsContext(policyFreeCtx, async (db) => {
      const compute = (ceiling: string[], grants: string[]) =>
        computeShareAnywayScope(db, POLICY_FREE_ORG, ceiling, grants)
      expect(await compute(CEILING, REQUESTER_GRANTS)).toEqual({ ok: true, scope: [A] })
      // Globs resolve the same way the turn path does: the narrower side wins.
      expect(await compute(["*"], [A])).toEqual({ ok: true, scope: [A] })
      expect(await compute(["sha:*"], ["*"])).toEqual({ ok: true, scope: ["sha:*"] })
      expect(await compute(CEILING, [])).toEqual({ ok: true, scope: [] })
      expect(await compute([], REQUESTER_GRANTS)).toEqual({ ok: true, scope: [] })
    })
  })

  it("the share anyway scope never widens past the agent ceiling or the requester grants", async () => {
    const sides = [[], ["*"], ["sha:*"], ["sha:a:*"], [A], [A, B], [B, C], ["sha"], ["other:*"]]
    await withRlsContext(policyFreeCtx, async (db) => {
      for (const ceiling of sides) {
        for (const grants of sides) {
          const result = await computeShareAnywayScope(db, POLICY_FREE_ORG, ceiling, grants)
          if (!result.ok) throw new Error("nothing is non-disclosable in an org with no policy")
          for (const scope of result.scope) {
            expect({ ceiling, grants, scope, inCeiling: isScopeSubset([scope], ceiling) }).toEqual({
              ceiling,
              grants,
              scope,
              inCeiling: true,
            })
            expect({ ceiling, grants, scope, inGrants: isScopeSubset([scope], grants) }).toEqual({
              ceiling,
              grants,
              scope,
              inGrants: true,
            })
          }
        }
      }
    })
  })
})

describe("assertDisclosureUserIds", () => {
  it("refuses the NIL uuid, a non-uuid or an empty id, and accepts real user ids", () => {
    const real = crypto.randomUUID()
    expect(() => assertDisclosureUserIds([real, NIL_UUID])).toThrow(/E_DISCLOSURE_INVALID_MEMBER/)
    expect(() => assertDisclosureUserIds(["system"])).toThrow(/E_DISCLOSURE_INVALID_MEMBER/)
    expect(() => assertDisclosureUserIds([""])).toThrow(/E_DISCLOSURE_INVALID_MEMBER/)
    expect(() => assertDisclosureUserIds([real])).not.toThrow()
  })
})

describe("Share anyway: rerun and disclosure snapshot", () => {
  const ORG_ID = crypto.randomUUID()
  const THREAD_ID = crypto.randomUUID()
  const AGENT_ID = crypto.randomUUID() // the requester's personal agent: the turn's acting agent
  const OTHER_AGENT_ID = crypto.randomUUID() // a live org agent that did not act in the turn
  const REQUESTER = crypto.randomUUID() // holds A and C
  const LACKER = crypto.randomUUID() // member at share time, no grants
  const LATE = crypto.randomUUID() // joins after the share, no grants
  const tag = ORG_ID.slice(0, 8)
  let turnId = ""

  const ctx = (userId: string, scopes: string[]): UserContext => ({
    actorType: "user",
    userId,
    orgId: ORG_ID,
    scopes,
    dimensionGrants: {},
  })

  function recordingRerun(requiredScopes: string[]): {
    rerun: ShareAnywayRerun
    calls: ShareAnywayRerunInput[]
  } {
    const calls: ShareAnywayRerunInput[] = []
    return {
      calls,
      rerun: async (input) => {
        calls.push(input)
        return [{ content: "shared result", requiredScopes, agentAuthorLabel: "Requester's agent" }]
      },
    }
  }

  async function visibleIds(userId: string, scopes: string[]): Promise<string[]> {
    return withRlsContext(ctx(userId, scopes), async (tx) => {
      const rows = extractRows<{ id: string }>(
        await tx.execute(
          drizzleSql`SELECT id FROM kernel.messages WHERE thread_id = ${THREAD_ID} ORDER BY created_at`,
        ),
      )
      return rows.map((r) => r.id)
    })
  }

  async function messageCount(): Promise<number> {
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.messages WHERE thread_id = ${THREAD_ID}`
    return row?.n ?? -1
  }

  type AuditRow = {
    action: string
    actor_id: string | null
    actor_type: string
    entity_type: string | null
    entity_id: string | null
    agent_id: string | null
    requester_user_id: string | null
    room_member_snapshot: string[] | null
    effective_scope: string[] | null
    disclosure_list: string[] | null
    metadata: Record<string, unknown> | null
  }

  /** Every share_anyway audit row this org has, oldest first. */
  async function shareAnywayAuditRows(): Promise<AuditRow[]> {
    return sql<AuditRow[]>`
      SELECT action, actor_id, actor_type, entity_type, entity_id, agent_id, requester_user_id,
             room_member_snapshot, effective_scope, disclosure_list, metadata
        FROM kernel.audit_log
       WHERE org_id = ${ORG_ID} AND action = 'share_anyway'
       ORDER BY timestamp, id`
  }

  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG_ID}, 'ShareAnywayOrg', ${`share-anyway-${tag}`})`
    for (const [id, name] of [
      [REQUESTER, "requester"],
      [LACKER, "lacker"],
      [LATE, "late"],
    ] as const) {
      await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
        VALUES (${id}, ${ORG_ID}, ${`share-anyway-${name}-${tag}@test.com`}, ${name}, 'x')`
    }
    for (const scope of REQUESTER_GRANTS) {
      await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
        VALUES (${REQUESTER}, ${ORG_ID}, ${scope})`
    }
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id, scope_ceiling)
      VALUES (${AGENT_ID}, ${ORG_ID}, 'personal', ${`@share-anyway-${tag}`}, 'Share anyway agent',
        ${REQUESTER}, ${JSON.stringify(CEILING)}::jsonb)`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling)
      VALUES (${OTHER_AGENT_ID}, ${ORG_ID}, 'role', ${`@share-anyway-other-${tag}`}, 'Other agent',
        ${JSON.stringify(["*"])}::jsonb)`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${THREAD_ID}, ${ORG_ID}, ${`share-anyway-${tag}`}, 'thread', ${REQUESTER})`
    for (const userId of [REQUESTER, LACKER]) {
      await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
        VALUES (${THREAD_ID}, ${userId}, ${ORG_ID})`
    }
    const [turn] = await sql<{ id: string }[]>`
      INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, content, required_scopes)
      VALUES (${THREAD_ID}, ${ORG_ID}, ${REQUESTER}, 'user', '@agent show the deal', '{}')
      RETURNING id`
    turnId = turn?.id ?? ""
  })

  // A FRESH turn per case. Share anyway is idempotent per turn: the first
  // disclosure of a turn is the only one, and a second call returns the ids it
  // already wrote. So a file that shared one seeded turn over and over was
  // testing the cache from its second case on, not the behaviour each case
  // names. Every case below still asserts exactly what it asserted before.
  beforeEach(async () => {
    const [turn] = await sql<{ id: string }[]>`
      INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, content, required_scopes)
      VALUES (${THREAD_ID}, ${ORG_ID}, ${REQUESTER}, 'user', '@agent show the deal', '{}')
      RETURNING id`
    turnId = turn?.id ?? ""
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

  it("Share anyway persists the resulting message with a disclosureList matching the room's current human members", async () => {
    const { rerun, calls } = recordingRerun([A])
    const { messageIds } = await shareAnyway(
      ctx(REQUESTER, REQUESTER_GRANTS),
      { turnId, requesterId: REQUESTER, roomId: THREAD_ID, agentId: AGENT_ID },
      { rerun },
    )
    expect(messageIds).toHaveLength(1)

    // The rerun ran at ceiling ∩ requester, not at the room floor: the lacker's
    // empty grants floor the room to nothing.
    expect(calls).toHaveLength(1)
    expect(calls[0]?.effectiveScope).toEqual([A])
    const roomTurn = await withPrivilegedDb(ORG_ID, "test-share-anyway-floor", (tx) =>
      computeEffectiveScopeForTurn(tx, ORG_ID, THREAD_ID, REQUESTER, CEILING),
    )
    expect(roomTurn.effectiveScope).toEqual([])

    const [row] = await sql<
      { disclosure_list: string[] | null; required_scopes: string[]; author_type: string }[]
    >`SELECT disclosure_list, required_scopes, author_type FROM kernel.messages
      WHERE id = ${messageIds[0] ?? ""}`
    expect(row?.author_type).toBe("agent")
    expect(row?.required_scopes).toEqual([A])
    expect([...(row?.disclosure_list ?? [])].sort()).toEqual([REQUESTER, LACKER].sort())
  })

  it("a disclosed member sees the shared message through RLS, a member added later does not", async () => {
    const { rerun } = recordingRerun([A])
    const { messageIds } = await shareAnyway(
      ctx(REQUESTER, REQUESTER_GRANTS),
      { turnId, requesterId: REQUESTER, roomId: THREAD_ID, agentId: AGENT_ID },
      { rerun },
    )
    const sharedId = messageIds[0] ?? ""
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
      VALUES (${THREAD_ID}, ${LATE}, ${ORG_ID})`
    try {
      expect(await visibleIds(REQUESTER, REQUESTER_GRANTS)).toContain(sharedId)
      expect(await visibleIds(LACKER, [])).toContain(sharedId)
      // A snapshot, not a live grant: a later member without the scope never sees it.
      expect(await visibleIds(LATE, [])).not.toContain(sharedId)
      // Control: the late member does see an unscoped message, so it is the scope that hides it.
      expect(await visibleIds(LATE, [])).toContain(turnId)
    } finally {
      await sql`DELETE FROM kernel.thread_participants
        WHERE thread_id = ${THREAD_ID} AND user_id = ${LATE}`
    }
  })

  it("Share anyway refuses a rerun result whose requiredScopes exceed the computed scope", async () => {
    const before = await messageCount()
    const { rerun } = recordingRerun([B]) // in the ceiling, not in the requester's grants
    await expect(
      shareAnyway(
        ctx(REQUESTER, REQUESTER_GRANTS),
        { turnId, requesterId: REQUESTER, roomId: THREAD_ID, agentId: AGENT_ID },
        { rerun },
      ),
    ).rejects.toThrow(/E_SHARE_ANYWAY_SCOPE_WIDENED/)
    expect(await messageCount()).toBe(before)
  })

  it("Share anyway is refused to anyone but the turn's requester", async () => {
    const { rerun, calls } = recordingRerun([A])
    // Another member claiming the requester's turn.
    await expect(
      shareAnyway(
        ctx(LACKER, []),
        { turnId, requesterId: LACKER, roomId: THREAD_ID, agentId: AGENT_ID },
        { rerun },
      ),
    ).rejects.toThrow(/E_SHARE_ANYWAY_NOT_REQUESTER/)
    // A session that is not the named requester.
    await expect(
      shareAnyway(
        ctx(LACKER, []),
        { turnId, requesterId: REQUESTER, roomId: THREAD_ID, agentId: AGENT_ID },
        { rerun },
      ),
    ).rejects.toThrow(/E_SHARE_ANYWAY_NOT_REQUESTER/)
    expect(calls).toHaveLength(0)
  })

  it("Share anyway reruns only as the withheld turn's acting agent: any other live agent is refused", async () => {
    const before = await messageCount()
    const { rerun, calls } = recordingRerun([A])
    // A live org agent with a wide ceiling that did not act in the requester's turn.
    await expect(
      shareAnyway(
        ctx(REQUESTER, REQUESTER_GRANTS),
        { turnId, requesterId: REQUESTER, roomId: THREAD_ID, agentId: OTHER_AGENT_ID },
        { rerun },
      ),
    ).rejects.toThrow(/E_SHARE_ANYWAY_AGENT_MISMATCH/)
    expect(calls).toHaveLength(0)
    expect(await messageCount()).toBe(before)

    // The turn's own acting agent (the requester's personal agent) is accepted.
    const { messageIds } = await shareAnyway(
      ctx(REQUESTER, REQUESTER_GRANTS),
      { turnId, requesterId: REQUESTER, roomId: THREAD_ID, agentId: AGENT_ID },
      { rerun },
    )
    expect(messageIds).toHaveLength(1)
    expect(calls.map((c) => c.agentId)).toEqual([AGENT_ID])
  })

  it("Share anyway writes one audit_log row with action share_anyway naming the discloser, scope and room", async () => {
    const before = (await shareAnywayAuditRows()).length
    const { rerun } = recordingRerun([A])
    const { messageIds } = await shareAnyway(
      ctx(REQUESTER, REQUESTER_GRANTS),
      { turnId, requesterId: REQUESTER, roomId: THREAD_ID, agentId: AGENT_ID },
      { rerun },
    )
    const rows = await shareAnywayAuditRows()
    expect(rows).toHaveLength(before + 1)

    // Who disclosed, what scope, and to whom: the three facts S6 requires.
    const row = rows[rows.length - 1]
    expect(row?.actor_id).toBe(REQUESTER)
    expect(row?.effective_scope).toEqual([A])
    expect([...(row?.disclosure_list ?? [])].sort()).toEqual([REQUESTER, LACKER].sort())
    // The room, and the room's member list at call time.
    expect(row?.entity_type).toBe("thread")
    expect(row?.entity_id).toBe(THREAD_ID)
    expect([...(row?.room_member_snapshot ?? [])].sort()).toEqual([REQUESTER, LACKER].sort())
    // Which turn was rerun, and exactly which messages it disclosed.
    expect(row?.metadata?.turnId).toBe(turnId)
    expect(row?.metadata?.messageIds).toEqual(messageIds)
  })

  it("the share anyway audit row carries the acting agent id and the requester", async () => {
    const { rerun } = recordingRerun([A])
    await shareAnyway(
      ctx(REQUESTER, REQUESTER_GRANTS),
      { turnId, requesterId: REQUESTER, roomId: THREAD_ID, agentId: AGENT_ID },
      { rerun },
    )
    const rows = await shareAnywayAuditRows()
    const row = rows[rows.length - 1]
    // The acting agent is recorded independently of the human actor, so "what
    // did this agent disclose" is queryable on its own.
    expect(row?.agent_id).toBe(AGENT_ID)
    expect(row?.requester_user_id).toBe(REQUESTER)
  })

  it("a refused Share anyway writes no audit row", async () => {
    const before = await shareAnywayAuditRows()
    // Refused on the acting-agent bind: another live org agent did not act here.
    await expect(
      shareAnyway(
        ctx(REQUESTER, REQUESTER_GRANTS),
        { turnId, requesterId: REQUESTER, roomId: THREAD_ID, agentId: OTHER_AGENT_ID },
        { rerun: recordingRerun([A]).rerun },
      ),
    ).rejects.toThrow(/E_SHARE_ANYWAY_AGENT_MISMATCH/)
    expect(await shareAnywayAuditRows()).toHaveLength(before.length)

    // Refused on scope: the rerun reported a scope outside ceiling and requester.
    await expect(
      shareAnyway(
        ctx(REQUESTER, REQUESTER_GRANTS),
        { turnId, requesterId: REQUESTER, roomId: THREAD_ID, agentId: AGENT_ID },
        { rerun: recordingRerun([B]).rerun },
      ),
    ).rejects.toThrow(/E_SHARE_ANYWAY_SCOPE_WIDENED/)
    expect(await shareAnywayAuditRows()).toHaveLength(before.length)

    // Refused to a caller who is not the turn's requester.
    await expect(
      shareAnyway(
        ctx(LACKER, []),
        { turnId, requesterId: LACKER, roomId: THREAD_ID, agentId: AGENT_ID },
        { rerun: recordingRerun([A]).rerun },
      ),
    ).rejects.toThrow(/E_SHARE_ANYWAY_NOT_REQUESTER/)
    expect(await shareAnywayAuditRows()).toHaveLength(before.length)
  })

  it("a disclosure can never exist without its audit row: an audit failure leaves nothing visible", async () => {
    const PROBE = "audit atomicity probe"
    const beforeMessages = await messageCount()
    const beforeAudit = (await shareAnywayAuditRows()).length
    const beforeVisible = await visibleIds(LACKER, [])

    const rerun: ShareAnywayRerun = async () => [
      { content: PROBE, requiredScopes: [A], agentAuthorLabel: "Requester's agent" },
    ]
    // The audit INSERT fails the way a constraint violation would, inside the
    // transaction that wrote the message.
    const writeAudit: ShareAnywayAuditWrite = async () => {
      throw new Error("audit insert exploded")
    }
    await expect(
      shareAnyway(
        ctx(REQUESTER, REQUESTER_GRANTS),
        { turnId, requesterId: REQUESTER, roomId: THREAD_ID, agentId: AGENT_ID },
        { rerun, writeAudit },
      ),
    ).rejects.toThrow(/audit insert exploded/)

    // The message rolled back with the audit row: nothing was disclosed.
    const [probe] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.messages
       WHERE thread_id = ${THREAD_ID} AND content = ${PROBE}`
    expect(probe?.n).toBe(0)
    expect(await messageCount()).toBe(beforeMessages)
    expect(await shareAnywayAuditRows()).toHaveLength(beforeAudit)
    // The disclosed-to member sees no new message through the real RLS policy.
    expect(await visibleIds(LACKER, [])).toEqual(beforeVisible)
  })

  // An admin can mark a capability non-disclosable (S7), which takes "Share
  // anyway" away for it. The gate looks at the withheld set only, i.e. the
  // ceiling entries `ceiling ∩ requester` does not cover, and ONE
  // non-disclosable entry refuses the whole action rather than narrowing it:
  // the card's offer is the turn, not a per-scope menu.
  describe("non-disclosable scopes (S7)", () => {
    const OTHER_ORG = crypto.randomUUID()

    /** Seeded from outside RLS: 0068 gives liaison_rls no DELETE policy. */
    async function markNonDisclosable(orgId: string, scope: string): Promise<void> {
      await sql`INSERT INTO kernel.scope_disclosure_policy (org_id, scope, disclosable)
        VALUES (${orgId}, ${scope}, false)`
    }

    /**
     * A case that TIGHTENS gets its OWN org, and nothing here resets anything.
     *
     * Marking a scope non-disclosable cannot be undone: it is tighten-only in
     * code (P2b-T09) and, since migration 0069, in the database too, where
     * deleting a non-disclosable row is SUPPRESSED while its organization
     * exists (the statement reports 0 rows and warns). A reset helper is
     * therefore not available to any test in this file, and one shared org
     * would carry the first tightening into every later case. Dropping the
     * organization is the one delete 0069 lets through, so that is the cleanup.
     */
    type Fixture = {
      orgId: string
      requester: string
      agentId: string
      threadId: string
      turnId: string
    }
    const tighteningOrgs: string[] = []

    async function makeTighteningFixture(label: string): Promise<Fixture> {
      const orgId = crypto.randomUUID()
      const requester = crypto.randomUUID()
      const agentId = crypto.randomUUID()
      const threadId = crypto.randomUUID()
      tighteningOrgs.push(orgId)
      const slug = `${label}-${tag}`
      await sql`INSERT INTO kernel.organizations (id, name, slug)
        VALUES (${orgId}, ${`ShareAnyway ${label}`}, ${`share-anyway-${slug}`})`
      await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
        VALUES (${requester}, ${orgId}, ${`share-anyway-${slug}@test.com`}, 'requester', 'x')`
      for (const scope of REQUESTER_GRANTS) {
        await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
          VALUES (${requester}, ${orgId}, ${scope})`
      }
      await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id, scope_ceiling)
        VALUES (${agentId}, ${orgId}, 'personal', ${`@share-anyway-${slug}`}, 'Share anyway agent',
          ${requester}, ${JSON.stringify(CEILING)}::jsonb)`
      await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
        VALUES (${threadId}, ${orgId}, ${`share-anyway-${slug}`}, 'thread', ${requester})`
      await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
        VALUES (${threadId}, ${requester}, ${orgId})`
      const [turn] = await sql<{ id: string }[]>`
        INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, content, required_scopes)
        VALUES (${threadId}, ${orgId}, ${requester}, 'user', '@agent show the deal', '{}')
        RETURNING id`
      return { orgId, requester, agentId, threadId, turnId: turn?.id ?? "" }
    }

    /**
     * A second turn in the SAME fixture room. Share anyway is idempotent per
     * turn, so a case that shares twice has to ask about two turns; sharing the
     * first one again returns the ids it already wrote, which is the answer to
     * a different question.
     */
    async function anotherTurn(f: { orgId: string; requester: string; threadId: string }) {
      const [turn] = await sql<{ id: string }[]>`
        INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, content, required_scopes)
        VALUES (${f.threadId}, ${f.orgId}, ${f.requester}, 'user', '@agent show the deal again', '{}')
        RETURNING id`
      return turn?.id ?? ""
    }

    function ctxFor(f: Fixture): UserContext {
      return {
        actorType: "user",
        userId: f.requester,
        orgId: f.orgId,
        scopes: REQUESTER_GRANTS,
        dimensionGrants: {},
      }
    }

    /** Share anyway for one owned fixture, whichever org it lives in. */
    async function shareIn(
      f: Fixture,
    ): Promise<{ messageIds: string[]; calls: ShareAnywayRerunInput[] }> {
      const { rerun, calls } = recordingRerun([A])
      const { messageIds } = await shareAnyway(
        ctxFor(f),
        { turnId: f.turnId, requesterId: f.requester, roomId: f.threadId, agentId: f.agentId },
        { rerun },
      )
      return { messageIds, calls }
    }

    async function messageCountIn(f: Fixture): Promise<number> {
      const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM kernel.messages WHERE thread_id = ${f.threadId}`
      return row?.n ?? -1
    }

    async function auditRowsIn(f: Fixture): Promise<{ action: string }[]> {
      return sql<{ action: string }[]>`
        SELECT action FROM kernel.audit_log
         WHERE org_id = ${f.orgId} AND action = 'share_anyway'`
    }

    /** The shared fixture's share: this org is never tightened, by design. */
    async function share(): Promise<{ messageIds: string[]; calls: ShareAnywayRerunInput[] }> {
      const { rerun, calls } = recordingRerun([A])
      const { messageIds } = await shareAnyway(
        ctx(REQUESTER, REQUESTER_GRANTS),
        { turnId, requesterId: REQUESTER, roomId: THREAD_ID, agentId: AGENT_ID },
        { rerun },
      )
      return { messageIds, calls }
    }

    beforeAll(async () => {
      await sql`INSERT INTO kernel.organizations (id, name, slug)
        VALUES (${OTHER_ORG}, 'ShareAnywayOtherOrg', ${`share-anyway-other-${tag}`})`
    })

    afterAll(async () => {
      for (const orgId of [...tighteningOrgs, OTHER_ORG]) {
        await sql`DELETE FROM kernel.pending_events WHERE org_id = ${orgId}`.catch(() => {})
        await sql`DELETE FROM kernel.audit_log WHERE org_id = ${orgId}`
        await sql`DELETE FROM kernel.messages WHERE org_id = ${orgId}`
        await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${orgId}`
        await sql`DELETE FROM kernel.threads WHERE org_id = ${orgId}`
        await sql`DELETE FROM kernel.agents WHERE org_id = ${orgId}`
        await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${orgId}`
        await sql`DELETE FROM kernel.users WHERE org_id = ${orgId}`
        await sql`DELETE FROM kernel.organizations WHERE id = ${orgId}`
      }
    })

    it("Share anyway throws E_SCOPE_NOT_DISCLOSABLE when the withheld scope is marked non-disclosable", async () => {
      const f = await makeTighteningFixture("nondisclosable")
      const beforeMessages = await messageCountIn(f)
      const beforeAudit = (await auditRowsIn(f)).length
      const { rerun, calls } = recordingRerun([A])
      // B is exactly the withheld capability here: it is in the agent ceiling
      // and outside the requester's grants, so it is what Share anyway would
      // disclose.
      await markNonDisclosable(f.orgId, B)
      const refusal = await shareAnyway(
        ctxFor(f),
        { turnId: f.turnId, requesterId: f.requester, roomId: f.threadId, agentId: f.agentId },
        { rerun },
      ).then(
        () => null,
        (err: Error) => err,
      )
      expect(refusal?.message).toMatch(/E_SCOPE_NOT_DISCLOSABLE/)
      // The route hands this message straight back to the requester, so the
      // closed scope must not be named in it (A14): which app an admin locked
      // down, and what the scope is called, are not the requester's to read.
      expect(refusal?.message).not.toContain(B)
      // Refused before the turn is rerun, so nothing was even computed at the
      // wider scope, and no message and no audit row exist (T19 holds here too).
      expect(calls).toHaveLength(0)
      expect(await messageCountIn(f)).toBe(beforeMessages)
      expect(await auditRowsIn(f)).toHaveLength(beforeAudit)
    })

    it("a policy read failure refuses the share, naming every withheld scope", async () => {
      // P2b-T09 fails closed, so an unreadable policy produces exactly the
      // refusal above rather than a silent disclosure.
      const broken = {
        select: () => {
          throw new Error("policy read failed")
        },
      } as unknown as RlsClient
      expect(await computeShareAnywayScope(broken, ORG_ID, CEILING, REQUESTER_GRANTS)).toEqual({
        ok: false,
        nonDisclosable: [B],
      })
    })

    it("the same turn is shared normally while the withheld scope stays disclosable", async () => {
      const { messageIds, calls } = await share()
      expect(messageIds).toHaveLength(1)
      expect(calls[0]?.effectiveScope).toEqual([A])
    })

    it("a non-disclosable scope the requester already holds does not block Share anyway", async () => {
      // A is inside `ceiling ∩ requester`, so it is not withheld and Share
      // anyway discloses nothing new about it: the gate must read the withheld
      // set, not the whole ceiling.
      const f = await makeTighteningFixture("already-held")
      await markNonDisclosable(f.orgId, A)
      const { messageIds } = await shareIn(f)
      expect(messageIds).toHaveLength(1)
    })

    it("another org marking the scope non-disclosable does not affect this org", async () => {
      const f = await makeTighteningFixture("org-boundary")
      await markNonDisclosable(OTHER_ORG, B)
      const { messageIds } = await shareIn(f)
      expect(messageIds).toHaveLength(1)

      // Control: the same scope marked in THIS org does refuse, so it is the
      // org boundary and not a missing policy row that let the share through.
      await markNonDisclosable(f.orgId, B)
      await expect(
        shareAnyway(
          ctxFor(f),
          {
            turnId: await anotherTurn(f),
            requesterId: f.requester,
            roomId: f.threadId,
            agentId: f.agentId,
          },
          { rerun: recordingRerun([A]).rerun },
        ),
      ).rejects.toThrow(/E_SCOPE_NOT_DISCLOSABLE/)
    })
  })

  describe("disclosure_list never holds the NIL uuid (DB CHECK)", () => {
    async function insertMessage(list: string): Promise<void> {
      await sql.unsafe(
        `INSERT INTO kernel.messages (thread_id, org_id, author_id, content, disclosure_list, required_scopes)
         VALUES ($1, $2, $3, 'nil probe', ${list}, '{}')`,
        [THREAD_ID, ORG_ID, REQUESTER],
      )
    }
    async function insertAudit(list: string): Promise<void> {
      await sql.unsafe(
        `INSERT INTO kernel.audit_log (org_id, actor_type, action, disclosure_list)
         VALUES ($1, 'agent', 'share_anyway', ${list})`,
        [ORG_ID],
      )
    }

    afterAll(async () => {
      await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG_ID} AND content = 'nil probe'`
    })

    it("kernel.messages refuses a NIL or NULL disclosure_list entry and accepts real user ids", async () => {
      const nil = `ARRAY['${REQUESTER}', '${NIL_UUID}']::uuid[]`
      const withNull = `ARRAY['${REQUESTER}', NULL]::uuid[]`
      await expect((async () => await insertMessage(nil))()).rejects.toMatchObject({
        code: "23514",
      })
      await expect((async () => await insertMessage(withNull))()).rejects.toMatchObject({
        code: "23514",
      })
      await insertMessage(`ARRAY['${REQUESTER}', '${LACKER}']::uuid[]`)
      await insertMessage("NULL")
    })

    it("kernel.audit_log refuses a NIL disclosure_list entry", async () => {
      await expect(
        (async () => await insertAudit(`ARRAY['${NIL_UUID}']::uuid[]`))(),
      ).rejects.toMatchObject({ code: "23514" })
    })
  })
})
