// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A32: while a desktop holds a claim on a conversation for an agent, the SERVER
// does not run that agent's turn there, and the machine that is running it posts
// the reply. The claim is a lease, so the thing that must be provable without a
// live desktop is what happens when nobody renews it.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { dispatchAgentMention } from "~/modules/threads/agent-dispatch-guard"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const FOLDER_HASH = "a".repeat(64)
/** This window. A claim belongs to the user AND the window that took it. */
const HOLDER = "holder-one-window"
/**
 * A second window, of the same person or of somebody else in the room.
 *
 * WHICH AGENT A COLLEAGUE'S SECOND MACHINE CAN BE HOLDING (A41,
 * spec-chat-dock.md:151-153): "Another user's personal agent is never listed,
 * mentionable or messageable anywhere", and the claim route gates on that same
 * mentionable predicate. So the two-people case is a ROLE agent, which both of
 * them can address; a colleague pointed at somebody's personal agent is
 * refused outright, which this file asserts separately.
 */
const OTHER_HOLDER = "holder-other-window"

describe("local session claims", () => {
  let session: minimal.Session
  let colleague: minimal.Session
  let agentId: string
  let roleAgentId: string
  let systemAgentId: string
  let threadId: string

  const post = (path: string, body: unknown, bearer?: string) =>
    app.request(path, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer ?? session.bearer}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    })

  const del = (path: string, bearer?: string) =>
    app.request(path, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${bearer ?? session.bearer}` },
    })

  const claimRows = () =>
    sql<Array<{ agent_id: string; user_id: string; holder_key: string; expires_at: Date }>>`
      SELECT agent_id, user_id, holder_key, expires_at FROM kernel.agent_local_claims
      WHERE thread_id = ${threadId}`

  /** One human message in the thread, as the dispatch path sees it. */
  async function humanMessage(content: string): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, content, required_scopes)
      VALUES (${threadId}, ${session.orgId}, ${session.userId}, 'user', ${content}, '{}')
      RETURNING id`
    return row.id
  }

  /**
   * The dispatch path, called exactly as `POST /threads/:id/messages` calls it.
   * `runRls` is a no-op passthrough onto the privileged client: this test is
   * about the claim branch, which runs before any RLS read.
   */
  async function dispatch(triggerMessageId: string, questionText: string) {
    const { withPrivilegedDb } = await import("~/db/privileged")
    return dispatchAgentMention(
      (fn) => withPrivilegedDb(session.orgId, "claim-test-dispatch", fn as never) as never,
      {
        orgId: session.orgId,
        threadId,
        calleeAgentId: agentId,
        callerAgentId: null,
        parentMessageId: null,
        triggerMessageId,
        questionText,
        actor: { userId: session.userId, orgId: session.orgId, scopes: ["*"] },
        adderName: "Tester",
      },
    )
  }

  beforeAll(async () => {
    await acquireTestLock()
    const org = await createTestOrg()
    session = await minimal.session(org.id, { role: "admin" })
    const [agent] = await sql<{ id: string }[]>`
      INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling, owner_user_id)
      VALUES (${session.orgId}, 'personal', '@claimed', 'Claimed', '["*"]'::jsonb, ${session.userId})
      RETURNING id`
    agentId = agent.id
    // The agent BOTH of them can address: a role agent belongs to nobody, so
    // the two-machines-two-people cases below are about it, not about the
    // personal agent above (A41).
    const [roleAgent] = await sql<{ id: string }[]>`
      INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling)
      VALUES (${session.orgId}, 'role', '@claim-role', 'Claim Role', '["*"]'::jsonb)
      RETURNING id`
    roleAgentId = roleAgent.id
    const [systemAgent] = await sql<{ id: string }[]>`
      INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling)
      VALUES (${session.orgId}, 'system', '@claim-sys', 'System', '["*"]'::jsonb)
      RETURNING id`
    systemAgentId = systemAgent.id
    threadId = await minimal.thread(session.orgId, session.userId)
    // A second member of the SAME room: the impersonation case is a colleague
    // who can see the conversation, not a stranger to it.
    colleague = await minimal.session(session.orgId, { role: "member" })
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
              VALUES (${threadId}, ${colleague.userId}, ${session.orgId}, 'member')`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.agent_local_claims WHERE thread_id = ${threadId}`
    await sql`DELETE FROM kernel.audit_log WHERE org_id = ${session.orgId}`
    await sql`DELETE FROM kernel.agents WHERE id IN (${agentId}, ${roleAgentId}, ${systemAgentId})`
    await releaseTestLock()
  })

  afterEach(async () => {
    await sql`DELETE FROM kernel.agent_local_claims WHERE thread_id = ${threadId}`
    await sql`DELETE FROM kernel.audit_log WHERE org_id = ${session.orgId}`
  })

  it("registers a claim on the conversation with a lease that expires", async () => {
    const response = await post(`/api/agents/${agentId}/local-claims`, {
      threadId,
      holderKey: HOLDER,
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: { expiresAt: string } }
    expect(new Date(body.data.expiresAt).getTime()).toBeGreaterThan(Date.now())

    const rows = await claimRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].agent_id).toBe(agentId)
    expect(rows[0].user_id).toBe(session.userId)
    expect(rows[0].holder_key).toBe(HOLDER)
  })

  it("heartbeats the same claim rather than stacking a second one", async () => {
    await post(`/api/agents/${agentId}/local-claims`, { threadId, holderKey: HOLDER })
    const first = (await claimRows())[0].expires_at
    await sql`UPDATE kernel.agent_local_claims SET expires_at = now() + interval '1 second'
              WHERE thread_id = ${threadId}`
    await post(`/api/agents/${agentId}/local-claims`, { threadId, holderKey: HOLDER })
    const rows = await claimRows()
    expect(rows).toHaveLength(1)
    expect(new Date(rows[0].expires_at).getTime()).toBeGreaterThanOrEqual(
      new Date(first).getTime() - 2_000,
    )
  })

  it("releases the claim, and a release with nothing to release still succeeds", async () => {
    await post(`/api/agents/${agentId}/local-claims`, { threadId, holderKey: HOLDER })
    const release = `/api/agents/${agentId}/local-claims/${threadId}?holderKey=${HOLDER}`
    expect((await del(release)).status).toBe(204)
    expect(await claimRows()).toHaveLength(0)
    expect((await del(release)).status).toBe(204)
  })

  it("refuses a claim on an agent of another org", async () => {
    const response = await post("/api/agents/00000000-0000-0000-0000-0000000000aa/local-claims", {
      threadId,
      holderKey: HOLDER,
    })
    expect(response.status).toBe(403)
  })

  // Taking a claim silences the org's agent in that conversation, renewably.
  // That is worth a row; a heartbeat every twenty seconds is not, and would
  // bury the two events that change WHO answers.
  it("audits taking the claim and releasing it, and does not audit a heartbeat", async () => {
    const auditRows = () =>
      sql<Array<{ action: string; entity_id: string; agent_id: string }>>`
        SELECT action, entity_id, agent_id FROM kernel.audit_log
        WHERE org_id = ${session.orgId} AND action LIKE 'agent.local_claim.%'
        ORDER BY timestamp ASC`

    await post(`/api/agents/${agentId}/local-claims`, { threadId, holderKey: HOLDER })
    await post(`/api/agents/${agentId}/local-claims`, { threadId, holderKey: HOLDER })
    await post(`/api/agents/${agentId}/local-claims`, { threadId, holderKey: HOLDER })
    let rows = await auditRows()
    expect(rows.map((row) => row.action)).toEqual(["agent.local_claim.registered"])
    expect(rows[0].entity_id).toBe(threadId)
    expect(rows[0].agent_id).toBe(agentId)

    await del(`/api/agents/${agentId}/local-claims/${threadId}?holderKey=${HOLDER}`)
    rows = await auditRows()
    expect(rows.map((row) => row.action)).toEqual([
      "agent.local_claim.registered",
      "agent.local_claim.released",
    ])

    // And a release with nothing to release writes nothing at all.
    await del(`/api/agents/${agentId}/local-claims/${threadId}?holderKey=${HOLDER}`)
    expect(await auditRows()).toHaveLength(2)
  })

  it("refuses a claim for an agent the caller could not have addressed", async () => {
    const response = await post(`/api/agents/${systemAgentId}/local-claims`, {
      threadId,
      holderKey: HOLDER,
    })
    expect(response.status).toBe(403)
    expect(await claimRows()).toHaveLength(0)
  })

  // A41 (spec-chat-dock.md:151-153): "Another user's personal agent is never
  // listed, mentionable or messageable anywhere". A personal agent's ceiling
  // IS its owner's own grants (spec-agents.md:27), so running one on your
  // machine would hand you a colleague's whole reach. Same room, same org, and
  // still not yours to run.
  it("refuses a claim on a colleague's personal agent", async () => {
    const response = await post(
      `/api/agents/${agentId}/local-claims`,
      { threadId, holderKey: OTHER_HOLDER },
      colleague.bearer,
    )
    expect(response.status).toBe(403)
    expect(await claimRows()).toHaveLength(0)
  })

  // A SECOND WINDOW IS NOT THE HOLDER. Two machines both renewing one lease is
  // two machines answering one conversation, which is the state the lease
  // exists to make impossible.
  it("refuses a second machine while the claim is live, and says when it lapses", async () => {
    await post(`/api/agents/${roleAgentId}/local-claims`, { threadId, holderKey: HOLDER })
    const response = await post(
      `/api/agents/${roleAgentId}/local-claims`,
      { threadId, holderKey: OTHER_HOLDER },
      colleague.bearer,
    )
    expect(response.status).toBe(409)
    const body = (await response.json()) as {
      error: { details: { expiresAt: string; heldByYou: boolean } }
    }
    expect(new Date(body.error.details.expiresAt).getTime()).toBeGreaterThan(Date.now())
    // P6d-FX7 (SK-5): the refusal says WHOSE lease it is, because the desktop
    // cannot see the row and the two answers are different things to do. This
    // one really is another machine.
    expect(body.error.details.heldByYou).toBe(false)
    const rows = await claimRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].user_id).toBe(session.userId)
    expect(rows[0].holder_key).toBe(HOLDER)
  })

  // P6d-FX7 (SK-5): a window that starts the same conversation again presents
  // the key it already holds, and that is a renewal. It used to mint a fresh
  // key per claim, so a window's own live lease refused its own next start
  // with a 409 and the page told the user to go and stop the session on
  // another machine. There is no other machine.
  it("never refuses a window its own lease, whatever order the restart arrives in", async () => {
    await post(`/api/agents/${agentId}/local-claims`, { threadId, holderKey: HOLDER })
    const again = await post(`/api/agents/${agentId}/local-claims`, { threadId, holderKey: HOLDER })
    expect(again.status).toBe(200)
    const rows = await claimRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].holder_key).toBe(HOLDER)
  })

  it("hands the conversation over when the second machine says so, and audits it", async () => {
    await post(`/api/agents/${roleAgentId}/local-claims`, { threadId, holderKey: HOLDER })
    const response = await post(
      `/api/agents/${roleAgentId}/local-claims`,
      { threadId, holderKey: OTHER_HOLDER, takeOver: true },
      colleague.bearer,
    )
    expect(response.status).toBe(200)
    const rows = await claimRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].user_id).toBe(colleague.userId)
    expect(rows[0].holder_key).toBe(OTHER_HOLDER)

    const [audit] = await sql<Array<{ actor_id: string; metadata: Record<string, unknown> }>>`
      SELECT actor_id, metadata FROM kernel.audit_log
      WHERE org_id = ${session.orgId} AND action = 'agent.local_claim.taken_over'`
    expect(audit.actor_id).toBe(colleague.userId)
    expect(audit.metadata).toMatchObject({ previousHolderUserId: session.userId })
  })

  // 2026-09-23, production: the desktop app was quit (its sidecar killed by
  // the shell, no release sent) and relaunched at once. The new instance
  // presented a new window key, the dead instance's lease had up to a minute
  // left, and the start was refused with 409 "another machine": there was no
  // other machine. A key that names the SAME INSTALL of the SAME user, on a
  // registration, supersedes at once; the dead instance cannot be asked.
  describe("the same install, relaunched", () => {
    const DEVICE = "0123456789abcdef0123456789abcdef"
    const OTHER_DEVICE = "fedcba9876543210fedcba9876543210"
    const DEAD_INSTANCE = `d.${DEVICE}.11111111-dead-4000-8000-000000000001`
    const RELAUNCHED = `d.${DEVICE}.22222222-live-4000-8000-000000000002`

    const auditActions = () =>
      sql<Array<{ action: string; metadata: Record<string, unknown> }>>`
        SELECT action, metadata FROM kernel.audit_log
        WHERE org_id = ${session.orgId} AND action LIKE 'agent.local_claim.%'
        ORDER BY timestamp ASC`

    it("supersedes the dead instance's live claim immediately, and audits it", async () => {
      await post(`/api/agents/${agentId}/local-claims`, { threadId, holderKey: DEAD_INSTANCE })
      const response = await post(`/api/agents/${agentId}/local-claims`, {
        threadId,
        holderKey: RELAUNCHED,
        register: true,
      })
      expect(response.status).toBe(200)
      const rows = await claimRows()
      expect(rows).toHaveLength(1)
      expect(rows[0].holder_key).toBe(RELAUNCHED)
      const actions = await auditActions()
      expect(actions.map((row) => row.action)).toEqual([
        "agent.local_claim.registered",
        "agent.local_claim.taken_over",
      ])
      expect(actions[1].metadata).toMatchObject({ sameDevice: true })
    })

    it("does not let the superseded instance's heartbeat take it back", async () => {
      await post(`/api/agents/${agentId}/local-claims`, { threadId, holderKey: DEAD_INSTANCE })
      await post(`/api/agents/${agentId}/local-claims`, {
        threadId,
        holderKey: RELAUNCHED,
        register: true,
      })
      const heartbeat = await post(`/api/agents/${agentId}/local-claims`, {
        threadId,
        holderKey: DEAD_INSTANCE,
      })
      expect(heartbeat.status).toBe(409)
      expect((await claimRows())[0].holder_key).toBe(RELAUNCHED)
    })

    it("refuses the same user's OTHER computer, and says it is theirs", async () => {
      await post(`/api/agents/${agentId}/local-claims`, { threadId, holderKey: DEAD_INSTANCE })
      const response = await post(`/api/agents/${agentId}/local-claims`, {
        threadId,
        holderKey: `d.${OTHER_DEVICE}.33333333-4000-8000-000000000003`,
        register: true,
      })
      expect(response.status).toBe(409)
      const body = (await response.json()) as {
        error: { details: { heldByYou: boolean; sameUser: boolean; canTakeOver: boolean } }
      }
      expect(body.error.details).toMatchObject({
        heldByYou: false,
        sameUser: true,
        canTakeOver: true,
      })
      expect((await claimRows())[0].holder_key).toBe(DEAD_INSTANCE)
    })

    it("refuses another person presenting the same install id, and names the holder", async () => {
      await post(`/api/agents/${roleAgentId}/local-claims`, { threadId, holderKey: DEAD_INSTANCE })
      const response = await post(
        `/api/agents/${roleAgentId}/local-claims`,
        { threadId, holderKey: RELAUNCHED, register: true },
        colleague.bearer,
      )
      expect(response.status).toBe(409)
      const body = (await response.json()) as {
        error: { details: { sameUser: boolean; holderName: string | null } }
      }
      expect(body.error.details.sameUser).toBe(false)
      expect(body.error.details.holderName).toBe("Test Admin")
      const rows = await claimRows()
      expect(rows[0].user_id).toBe(session.userId)
      expect(rows[0].holder_key).toBe(DEAD_INSTANCE)
    })

    it("never supersedes on a key that names no install", async () => {
      await post(`/api/agents/${agentId}/local-claims`, { threadId, holderKey: HOLDER })
      const response = await post(`/api/agents/${agentId}/local-claims`, {
        threadId,
        holderKey: RELAUNCHED,
        register: true,
      })
      expect(response.status).toBe(409)
    })
  })

  it("refuses a release from a machine that does not hold the claim", async () => {
    await post(`/api/agents/${agentId}/local-claims`, { threadId, holderKey: HOLDER })
    const response = await del(
      `/api/agents/${agentId}/local-claims/${threadId}?holderKey=${OTHER_HOLDER}`,
      colleague.bearer,
    )
    expect(response.status).toBe(403)
    expect(await claimRows()).toHaveLength(1)
  })

  // The shell runs what the SERVER says a message is, never what an event on
  // the page said: the event is a notification, this is the source.
  it("hands back the message the conversation actually holds", async () => {
    const messageId = await humanMessage("the real question")
    const response = await app.request(
      `/api/agents/${agentId}/local-claims/${threadId}/messages/${messageId}`,
      { headers: { Authorization: `Bearer ${session.bearer}` } },
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      data: {
        id: string
        threadId: string
        authorKind: string
        text: string
        replyRootId: string | null
      }
    }
    expect(body.data).toEqual({
      id: messageId,
      threadId,
      authorKind: "user",
      text: "the real question",
      replyRootId: null,
    })
  })

  // A7: the shell answers a message asked in a reply thread IN that thread,
  // and learns which from this read, not from the page.
  it("names the reply thread a message was asked in", async () => {
    const rootId = await humanMessage("the root")
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO kernel.messages
        (thread_id, org_id, author_id, author_type, content, required_scopes, reply_root_id)
      VALUES (${threadId}, ${session.orgId}, ${session.userId}, 'user', 'in the thread', '{}', ${rootId})
      RETURNING id`
    const response = await app.request(
      `/api/agents/${agentId}/local-claims/${threadId}/messages/${row.id}`,
      { headers: { Authorization: `Bearer ${session.bearer}` } },
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: { replyRootId: string | null } }
    expect(body.data.replyRootId).toBe(rootId)
  })

  it("answers nothing for a message id this conversation does not hold", async () => {
    const response = await app.request(
      `/api/agents/${agentId}/local-claims/${threadId}/messages/${crypto.randomUUID()}`,
      { headers: { Authorization: `Bearer ${session.bearer}` } },
    )
    expect(response.status).toBe(404)
  })

  // THE WHOLE POINT: the server stops answering while the machine answers.
  it("does not start a server turn for a claimed agent, and says so in the audit", async () => {
    await post(`/api/agents/${agentId}/local-claims`, { threadId, holderKey: HOLDER })
    const messageId = await humanMessage("@[Claimed](agent:x) do the thing")
    const outcome = await dispatch(messageId, "do the thing")
    expect(outcome.allowed).toBe(false)
    expect(outcome.allowed === false && outcome.reason).toBe("claimed_locally")

    const [row] = await sql<Array<{ agent_id: string; metadata: Record<string, unknown> }>>`
      SELECT agent_id, metadata FROM kernel.audit_log
      WHERE org_id = ${session.orgId} AND action = 'agent.dispatch.skipped_for_local'`
    expect(row.agent_id).toBe(agentId)
    expect(row.metadata).toMatchObject({ threadId, runLocation: "local" })

    // And nothing was said in the room: a skip is not a refusal, the answer is
    // coming from somewhere else.
    const [{ count }] = await sql<Array<{ count: string }>>`
      SELECT count(*)::text AS count FROM kernel.messages
      WHERE thread_id = ${threadId} AND author_type = 'system'`
    expect(count).toBe("0")
  })

  // THE LAPTOP THAT DIED MID QUESTION. The guard held the message back for a
  // machine that never answered it; when the lease lapses, the server answers
  // it after all, once, rather than leaving the room with silence.
  it("answers the question the lapsed machine took with it, exactly once", async () => {
    await post(`/api/agents/${agentId}/local-claims`, { threadId, holderKey: HOLDER })
    const messageId = await humanMessage("@[Claimed](agent:x) what is the status?")
    const skipped = await dispatch(messageId, "what is the status?")
    expect(skipped.allowed).toBe(false)

    await sql`UPDATE kernel.agent_local_claims SET expires_at = now() - interval '1 second'
              WHERE thread_id = ${threadId}`
    const { sweepLapsedLocalClaims } = await import(
      "~/modules/agent/local-sessions/local-claim-lapse"
    )
    const first = await sweepLapsedLocalClaims()
    expect(first.dispatched).toBe(1)
    expect(await claimRows()).toHaveLength(0)

    const audits = await sql<Array<{ entity_id: string }>>`
      SELECT entity_id FROM kernel.audit_log
      WHERE org_id = ${session.orgId} AND action = 'agent.dispatch.after_local_lapse'`
    expect(audits).toHaveLength(1)
    expect(audits[0].entity_id).toBe(messageId)

    // A second pass has nothing to sweep: the row it acted on is gone.
    const second = await sweepLapsedLocalClaims()
    expect(second).toEqual({ swept: 0, dispatched: 0 })
    expect(
      await sql<Array<{ entity_id: string }>>`
        SELECT entity_id FROM kernel.audit_log
        WHERE org_id = ${session.orgId} AND action = 'agent.dispatch.after_local_lapse'`,
    ).toHaveLength(1)
  })

  it("dispatches again once the claim has lapsed, so a dead laptop is not a dead agent", async () => {
    await post(`/api/agents/${agentId}/local-claims`, { threadId, holderKey: HOLDER })
    await sql`UPDATE kernel.agent_local_claims SET expires_at = now() - interval '1 second'
              WHERE thread_id = ${threadId}`
    const messageId = await humanMessage("@[Claimed](agent:x) still there?")
    const outcome = await dispatch(messageId, "still there?")
    expect(outcome.allowed).toBe(true)
    // The turn itself is not this test's business, and this substrate has no
    // model configured for it: a dispatch that was allowed is the assertion.
    if (outcome.allowed) outcome.turn?.catch(() => undefined)
  })
})

describe("the agent's reply from a local turn", () => {
  let session: minimal.Session
  let colleague: minimal.Session
  let agentId: string
  let threadId: string
  let sessionId: string

  const post = (path: string, body: unknown, bearer?: string) =>
    app.request(path, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer ?? session.bearer}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    })

  beforeAll(async () => {
    await acquireTestLock()
    const org = await createTestOrg()
    session = await minimal.session(org.id, { role: "admin" })
    const [agent] = await sql<{ id: string }[]>`
      INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling, owner_user_id)
      VALUES (${session.orgId}, 'personal', '@replier', 'Replier', '["*"]'::jsonb, ${session.userId})
      RETURNING id`
    agentId = agent.id
    threadId = await minimal.thread(session.orgId, session.userId)
    colleague = await minimal.session(session.orgId, { role: "member" })
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
              VALUES (${threadId}, ${colleague.userId}, ${session.orgId}, 'member')`
    const started = await post(`/api/agents/${agentId}/local-sessions`, {
      permissionMode: "manual",
      folderHash: FOLDER_HASH,
      model: "claude-haiku-4-5",
    })
    sessionId = ((await started.json()) as { data: { sessionId: string } }).data.sessionId
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.agent_local_claims WHERE thread_id = ${threadId}`
    await sql`DELETE FROM kernel.audit_log WHERE org_id = ${session.orgId}`
    await sql`DELETE FROM kernel.agents WHERE id = ${agentId}`
    await releaseTestLock()
  })

  it("refuses a reply for a conversation no machine has claimed", async () => {
    const response = await post(`/api/agents/${agentId}/local-sessions/${sessionId}/reply`, {
      threadId,
      text: "I did it",
      holderKey: HOLDER,
    })
    expect(response.status).toBe(409)
  })

  // THE IMPERSONATION CASE: a member of the room, with no session of their own,
  // posting as the agent by spending somebody else's lease.
  it("refuses a reply from a machine that does not hold the claim", async () => {
    await post(`/api/agents/${agentId}/local-claims`, { threadId, holderKey: HOLDER })
    const before = await sql<Array<{ count: string }>>`
      SELECT count(*)::text AS count FROM kernel.messages WHERE thread_id = ${threadId}`
    const response = await post(
      `/api/agents/${agentId}/local-sessions/${sessionId}/reply`,
      { threadId, text: "I am the agent now", holderKey: OTHER_HOLDER },
      colleague.bearer,
    )
    expect(response.status).toBe(403)
    // And the same refusal for another window of the CLAIM HOLDER's own account.
    const sameUser = await post(`/api/agents/${agentId}/local-sessions/${sessionId}/reply`, {
      threadId,
      text: "I am the other window",
      holderKey: OTHER_HOLDER,
    })
    expect(sameUser.status).toBe(403)
    const after = await sql<Array<{ count: string }>>`
      SELECT count(*)::text AS count FROM kernel.messages WHERE thread_id = ${threadId}`
    expect(after[0].count).toBe(before[0].count)
    await sql`DELETE FROM kernel.agent_local_claims WHERE thread_id = ${threadId}`
  })

  it("posts the answer as the agent and audits it as having run locally", async () => {
    await post(`/api/agents/${agentId}/local-claims`, { threadId, holderKey: HOLDER })
    const response = await post(`/api/agents/${agentId}/local-sessions/${sessionId}/reply`, {
      threadId,
      text: "Created hello.txt in the folder.",
      holderKey: HOLDER,
    })
    expect(response.status).toBe(201)
    const { data } = (await response.json()) as { data: { messageId: string } }

    const [message] = await sql<
      Array<{ author_type: string; author_agent_id: string; content: string }>
    >`SELECT author_type, author_agent_id, content FROM kernel.messages WHERE id = ${data.messageId}`
    expect(message.author_type).toBe("agent")
    expect(message.author_agent_id).toBe(agentId)
    expect(message.content).toBe("Created hello.txt in the folder.")

    const [audit] = await sql<Array<{ agent_id: string; metadata: Record<string, unknown> }>>`
      SELECT agent_id, metadata FROM kernel.audit_log
      WHERE org_id = ${session.orgId} AND action = 'agent.local_session.reply'`
    expect(audit.agent_id).toBe(agentId)
    expect(audit.metadata).toMatchObject({ runLocation: "local", sessionId, threadId })
  })

  // D3, spec-security.md: an EMPTY `requiredScopes` is a positive assertion
  // that the turn touched no scoped data, so it is computed, never assumed. A
  // local turn reads Liaison data only through this server: its tool calls,
  // the agent's definition and the conversation it was handed. The reply is
  // tagged with those (local-context-scopes.ts). It used to be the turn's whole
  // effective scope, which for an admin whose agent's ceiling is `*` is `*`:
  // history then carried `*` into every later cloud turn of the conversation.
  it("tags the reply with the conversation the turn was handed, not the whole effective scope", async () => {
    const handed = "kernel:contacts:read"
    await sql`INSERT INTO kernel.messages (org_id, thread_id, author_type, author_id, content, required_scopes)
      VALUES (${session.orgId}, ${threadId}, 'user', ${session.userId}, 'the dealer list', ${[handed]})`
    await post(`/api/agents/${agentId}/local-claims`, { threadId, holderKey: HOLDER })
    const response = await post(`/api/agents/${agentId}/local-sessions/${sessionId}/reply`, {
      threadId,
      text: "I read the payouts and here they are.",
      holderKey: HOLDER,
    })
    expect(response.status).toBe(201)
    const { data } = (await response.json()) as { data: { messageId: string } }
    const [message] = await sql<Array<{ required_scopes: string[] }>>`
      SELECT required_scopes FROM kernel.messages WHERE id = ${data.messageId}`
    expect(message.required_scopes).toContain(handed)
    expect(message.required_scopes).not.toContain("*")
  })

  // T26 F12, the ws_08 item: the EXACT taint on top of that bound. A local
  // session's Liaison calls run through the agent bound MCP path, which
  // persists what they touched, so the reply can be tagged with the leaf scope
  // the call actually needed and not only with the room's wide effective set.
  it("adds what the sidecar's Liaison calls touched to the reply tag", async () => {
    const {
      saveConnectionTurnTaint,
      recordConnectionTaintMarks,
      mcpTurnTaintKey,
      mcpTurnTaintMarksKey,
    } = await import("~/modules/mcp/connection-service")
    const { redis } = await import("~/lib/redis")
    // A connector scope no role in this org holds, so the assertion cannot pass
    // by way of the room's own effective scope.
    const touched = "mcp:local-sidecar:read"
    await saveConnectionTurnTaint(session.orgId, agentId, [touched])
    // Touched DURING this turn, which is what the gateway's own write records.
    await recordConnectionTaintMarks(session.orgId, agentId, [touched])
    try {
      await post(`/api/agents/${agentId}/local-claims`, { threadId, holderKey: HOLDER })
      const response = await post(`/api/agents/${agentId}/local-sessions/${sessionId}/reply`, {
        threadId,
        text: "The connector says the shipment left this morning.",
        holderKey: HOLDER,
      })
      expect(response.status).toBe(201)
      const { data } = (await response.json()) as { data: { messageId: string } }
      const [message] = await sql<Array<{ required_scopes: string[] }>>`
        SELECT required_scopes FROM kernel.messages WHERE id = ${data.messageId}`
      expect(message.required_scopes).toContain(touched)
    } finally {
      await redis.del(mcpTurnTaintKey(session.orgId, agentId))
      await redis.del(mcpTurnTaintMarksKey(session.orgId, agentId))
    }
  })

  // P8-FX2, SK-1. The taint key is one set per (org, agent), kept for fifteen
  // sliding minutes and never cleared, so a connector call made in ANOTHER
  // conversation is still in it when this turn replies here. Folding it in
  // tagged this answer with a scope this turn never touched, and the room then
  // hides the answer from every member without it, the asker included.
  it("does not tag the reply with a scope an earlier, unrelated run touched", async () => {
    const { saveConnectionTurnTaint, mcpTurnTaintKey, mcpTurnTaintMarksKey } = await import(
      "~/modules/mcp/connection-service"
    )
    const { redis } = await import("~/lib/redis")
    const stale = "pennylane:transactions:read"
    await saveConnectionTurnTaint(session.orgId, agentId, [stale])
    // Stamped BEFORE this session ever started: another conversation's call,
    // still inside the fifteen minute window.
    await redis.hset(
      mcpTurnTaintMarksKey(session.orgId, agentId),
      stale,
      String(Date.now() - 10 * 60_000),
    )
    try {
      // The turn this reply ends: the desktop says so, and the server stamps it.
      const event = await post(`/api/agents/${agentId}/local-sessions/${sessionId}/events`, {
        kind: "turn",
        promptChecksum: "b".repeat(64),
      })
      expect(event.status).toBe(204)
      await post(`/api/agents/${agentId}/local-claims`, { threadId, holderKey: HOLDER })
      const response = await post(`/api/agents/${agentId}/local-sessions/${sessionId}/reply`, {
        threadId,
        text: "Here is the answer you asked for.",
        holderKey: HOLDER,
      })
      expect(response.status).toBe(201)
      const { data } = (await response.json()) as { data: { messageId: string } }
      const [message] = await sql<Array<{ required_scopes: string[] }>>`
        SELECT required_scopes FROM kernel.messages WHERE id = ${data.messageId}`
      expect(message.required_scopes).not.toContain(stale)
      // The person who asked reads their own answer under `isMessageVisible`.
      // (This used to be checked against the room's floor, which only held
      // because the tag WAS the floor; the tag is now what the turn was handed,
      // and this thread's history holds a reply tagged above the floor.)
      const { withPrivilegedDb } = await import("~/db/privileged")
      const { loadEffectivePermissions } = await import("~/modules/permissions/permissions")
      const asker = await withPrivilegedDb(session.orgId, "test-asker-grants", (tx) =>
        loadEffectivePermissions(tx, session.userId, session.orgId),
      )
      const { isMessageVisible } = await import("~/services/security/visibility")
      expect(
        isMessageVisible(
          { requiredScopes: message.required_scopes, disclosureList: [] },
          { userId: session.userId, grants: [...asker.scopes] },
        ),
      ).toBe(true)
    } finally {
      await redis.del(mcpTurnTaintKey(session.orgId, agentId))
      await redis.del(mcpTurnTaintMarksKey(session.orgId, agentId))
    }
  })

  it("keeps a scope this turn touched after the turn began", async () => {
    const {
      saveConnectionTurnTaint,
      recordConnectionTaintMarks,
      mcpTurnTaintKey,
      mcpTurnTaintMarksKey,
    } = await import("~/modules/mcp/connection-service")
    const { redis } = await import("~/lib/redis")
    const touched = "mcp:local-sidecar:read"
    try {
      const event = await post(`/api/agents/${agentId}/local-sessions/${sessionId}/events`, {
        kind: "turn",
        promptChecksum: "c".repeat(64),
      })
      expect(event.status).toBe(204)
      // The call happens after the turn started, which is the ordinary case.
      await saveConnectionTurnTaint(session.orgId, agentId, [touched])
      await recordConnectionTaintMarks(session.orgId, agentId, [touched])
      await post(`/api/agents/${agentId}/local-claims`, { threadId, holderKey: HOLDER })
      const response = await post(`/api/agents/${agentId}/local-sessions/${sessionId}/reply`, {
        threadId,
        text: "The connector says it shipped.",
        holderKey: HOLDER,
      })
      expect(response.status).toBe(201)
      const { data } = (await response.json()) as { data: { messageId: string } }
      const [message] = await sql<Array<{ required_scopes: string[] }>>`
        SELECT required_scopes FROM kernel.messages WHERE id = ${data.messageId}`
      expect(message.required_scopes).toContain(touched)
    } finally {
      await redis.del(mcpTurnTaintKey(session.orgId, agentId))
      await redis.del(mcpTurnTaintMarksKey(session.orgId, agentId))
    }
  })

  // --- P4c-E1: the desktop learns the cold decision -------------------------
  //
  // The rule is the server's (`isColdResume` over this agent's last turn in
  // this conversation), and the desktop cannot recompute it: it holds no
  // transcript. Without this the shell resumed its SDK conversation on every
  // turn, including one the server had just decided to reassemble from a
  // checkpoint plus a cold tail: two contexts for one rule.
  describe("P4c-E1 the turn claim carries the cold decision", () => {
    let coldThreadId: string
    let warmThreadId: string

    const get = (path: string) =>
      app.request(path, { headers: { Authorization: `Bearer ${session.bearer}` } })

    const turnContext = (thread: string) =>
      `/api/agents/${agentId}/local-claims/${thread}/turn-context`

    /** A conversation whose newest row is this agent's, `minutes` ago. */
    async function seedAnsweredThread(minutes: number): Promise<string> {
      const id = await minimal.thread(session.orgId, session.userId)
      const at = new Date(Date.now() - minutes * 60_000).toISOString()
      await sql`INSERT INTO kernel.messages
        (thread_id, org_id, author_id, author_type, content, created_at, required_scopes)
        VALUES (${id}, ${session.orgId}, ${session.userId}, 'user', 'Where did we land?',
                ${new Date(Date.now() - (minutes + 1) * 60_000).toISOString()}, '{}')`
      await sql`INSERT INTO kernel.messages
        (thread_id, org_id, author_id, author_type, author_agent_id, content, created_at, required_scopes)
        VALUES (${id}, ${session.orgId}, ${session.userId}, 'agent', ${agentId}, 'We landed here.',
                ${at}, '{}')`
      return id
    }

    beforeAll(async () => {
      coldThreadId = await seedAnsweredThread(61)
      warmThreadId = await seedAnsweredThread(59)
    })

    afterAll(async () => {
      await sql`DELETE FROM kernel.messages WHERE thread_id IN (${coldThreadId}, ${warmThreadId})`
      await sql`DELETE FROM kernel.thread_participants WHERE thread_id IN (${coldThreadId}, ${warmThreadId})`
      await sql`DELETE FROM kernel.threads WHERE id IN (${coldThreadId}, ${warmThreadId})`
    })

    it("answers coldResume true 61 minutes after the agent's last turn", async () => {
      const response = await get(turnContext(coldThreadId))
      expect(response.status).toBe(200)
      const body = (await response.json()) as { data: { coldResume: boolean } }
      expect(body.data.coldResume).toBe(true)
    })

    it("answers coldResume false 59 minutes after the agent's last turn", async () => {
      const response = await get(turnContext(warmThreadId))
      expect(response.status).toBe(200)
      const body = (await response.json()) as { data: { coldResume: boolean } }
      expect(body.data.coldResume).toBe(false)
    })

    // 2026-09-23: the desktop starts a NEW session when the agent's
    // definition changed, and that turn is usually warm. Without the flag the
    // warm answer carries nothing, so the new session started empty.
    it("a warm turn asked for a fresh session carries the warm context", async () => {
      const response = await get(`${turnContext(warmThreadId)}?fresh=1`)
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        data: {
          coldResume: boolean
          fresh?: boolean
          checkpoint?: { summary: string }
          tail?: Array<{ authorType: string; content: string }>
          recall?: string | null
          resumeLine?: string | null
        }
      }
      expect(body.data.coldResume).toBe(false)
      expect(body.data.fresh).toBe(true)
      expect(typeof body.data.checkpoint?.summary).toBe("string")
      expect(body.data.tail?.map((row) => row.content)).toEqual([
        "Where did we land?",
        "We landed here.",
      ])
      expect(body.data.recall).toBeNull()
      expect(body.data.resumeLine).toBeNull()
    })

    it("a warm turn without the flag still answers the boolean alone", async () => {
      const response = await get(turnContext(warmThreadId))
      const body = (await response.json()) as { data: Record<string, unknown> }
      expect(body.data).toEqual({ coldResume: false })
    })

    it("refuses to answer for an agent of another org", async () => {
      const response = await get(
        `/api/agents/00000000-0000-4000-8000-0000000000aa/local-claims/${coldThreadId}/turn-context`,
      )
      expect(response.status).toBe(403)
    })
  })

  // --- P4c-T26b: the cold turn is FED, not just labelled --------------------
  //
  // T26 taught the desktop that a turn is cold, and a cold turn starts a fresh
  // SDK session. Nothing then fed that session, so the shell traded a stale
  // context for none at all. The server already assembles the cold context for
  // a cloud turn (checkpoint, cold tail, recall, resume line); this is the same
  // assembly, through the same functions, handed to the machine running it.
  describe("P4c-T26b the cold turn carries the checkpoint and the tail", () => {
    let coldThreadId: string
    let warmThreadId: string

    const get = (path: string) =>
      app.request(path, { headers: { Authorization: `Bearer ${session.bearer}` } })

    const turnContext = (thread: string) =>
      `/api/agents/${agentId}/local-claims/${thread}/turn-context`

    /** `chars / 4`, the estimator every budget in this slice is measured with. */
    const tokens = (text: string) => Math.ceil(text.length / 4)

    const SCRIPTED_SUMMARY =
      "The shipment to Lyon was split into two cartons and the customer was told so."

    /**
     * A conversation carrying about 20,000 tokens of transcript, whose newest
     * row is this agent's, `minutes` ago. One agent row calls `memory_search`
     * (a retrieval tool, which A50 drops) alongside a business tool, so the
     * strip is observable rather than vacuous.
     */
    async function seedLongThread(minutes: number): Promise<string> {
      const id = await minimal.thread(session.orgId, session.userId)
      // 26 rows x 3,200 characters = 83,200 chars ~ 20,800 tokens.
      const ROWS = 26
      for (let i = 0; i < ROWS; i++) {
        // The NEWEST row of the loop (the agent's last turn, i = ROWS - 1) sits
        // exactly `minutes` back, which is the quantity the rule measures: an
        // extra row's worth of offset there put a 59 minute thread over the
        // hour by the time the request ran.
        const at = new Date(Date.now() - (minutes + (ROWS - 1 - i)) * 60_000).toISOString()
        const body = `turn ${i} `.padEnd(3200, "x")
        if (i % 2 === 0) {
          await sql`INSERT INTO kernel.messages
            (thread_id, org_id, author_id, author_type, content, created_at, required_scopes)
            VALUES (${id}, ${session.orgId}, ${session.userId}, 'user', ${body}, ${at}, '{}')`
        } else {
          const metadata =
            i === ROWS - 1
              ? JSON.stringify({
                  toolCalls: [
                    {
                      toolCallId: "c1",
                      toolName: "memory_search",
                      args: {},
                      result: "old wording",
                    },
                    { toolCallId: "c2", toolName: "boxtal__quote", args: {}, result: "42 EUR" },
                  ],
                })
              : null
          await sql`INSERT INTO kernel.messages
            (thread_id, org_id, author_id, author_type, author_agent_id, content, created_at,
             metadata, required_scopes)
            VALUES (${id}, ${session.orgId}, ${session.userId}, 'agent', ${agentId}, ${body}, ${at},
                    ${metadata}::jsonb, '{}')`
        }
      }
      // The newest row is the incoming human message the turn answers, so the
      // agent's last turn is `minutes` old exactly as the rule measures it.
      await sql`INSERT INTO kernel.messages
        (thread_id, org_id, author_id, author_type, content, created_at, required_scopes)
        VALUES (${id}, ${session.orgId}, ${session.userId}, 'user', 'Where did we land on Lyon?',
                ${new Date(Date.now() - 30_000).toISOString()}, '{}')`
      return id
    }

    /** Every prefix rebuild this thread recorded, newest first. */
    const rebuilds = (thread: string) =>
      sql<Array<{ metadata: { cause?: string } }>>`
        SELECT metadata FROM kernel.audit_log
        WHERE entity_id = ${thread} AND action = 'history_prefix_rebuilt'`

    beforeAll(async () => {
      const { CheckpointTestAccess } = await import("~/modules/agent/context/checkpoint")
      // The two model calls an advance makes, scripted: this test is about what
      // the route assembles, not about what a summarizer writes.
      CheckpointTestAccess.setSummarizer(async () => SCRIPTED_SUMMARY)
      CheckpointTestAccess.setBriefRowExtractor(async () => [])
      coldThreadId = await seedLongThread(61)
      warmThreadId = await seedLongThread(59)
    })

    afterAll(async () => {
      const { CheckpointTestAccess } = await import("~/modules/agent/context/checkpoint")
      CheckpointTestAccess.setSummarizer()
      CheckpointTestAccess.setBriefRowExtractor()
      await sql`DELETE FROM kernel.agent_thread_checkpoints
                WHERE thread_id IN (${coldThreadId}, ${warmThreadId})`
      await sql`DELETE FROM kernel.messages WHERE thread_id IN (${coldThreadId}, ${warmThreadId})`
      await sql`DELETE FROM kernel.thread_participants
                WHERE thread_id IN (${coldThreadId}, ${warmThreadId})`
      await sql`DELETE FROM kernel.threads WHERE id IN (${coldThreadId}, ${warmThreadId})`
    })

    it("a local turn after the warm window is served the cold tail and the checkpoint", async () => {
      const response = await get(turnContext(coldThreadId))
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        data: {
          coldResume: boolean
          checkpoint: { summary: string }
          tail: Array<{ content: string; authorType: string; toolNames: string[] }>
          resumeLine: string | null
        }
      }
      const { data } = body
      expect(data.coldResume).toBe(true)

      // THE CHECKPOINT. A cold session with no summary starts from nothing,
      // which is the defect this task exists for.
      expect(data.checkpoint.summary.length).toBeGreaterThan(0)
      expect(data.checkpoint.summary).toContain("Lyon")

      // THE TAIL, inside the cold budget the cloud path renders against.
      expect(data.tail.length).toBeGreaterThan(0)
      const tailTokens = data.tail.reduce((sum, row) => sum + tokens(row.content), 0)
      expect(tailTokens).toBeLessThanOrEqual(8_000)

      // A50: the retrieval call is gone, the business one is not.
      const called = data.tail.flatMap((row) => row.toolNames)
      expect(called).not.toContain("memory_search")

      expect(data.resumeLine).toContain("Resumed after")

      // THE ADVANCE RAN, ONCE, AS A COLD RESUME.
      const rows = await rebuilds(coldThreadId)
      expect(rows.length).toBe(1)
      expect(rows[0].metadata.cause).toBe("cold_resume")
    })

    it("a warm local turn is served no cold context", async () => {
      const response = await get(turnContext(warmThreadId))
      expect(response.status).toBe(200)
      const body = (await response.json()) as { data: Record<string, unknown> }
      expect(body.data).toEqual({ coldResume: false })
      expect((await rebuilds(warmThreadId)).length).toBe(0)
    })
  })
})
