// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A message held back for a desktop that then lapsed is answered by the
// server later (local-claim-lapse.ts). When the person posted it from a
// restricted (device-flow) session, the later turn stays marked restricted:
// the tools whose REST counterpart refuses such a session refuse it then too.
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { dispatchAgentMention } from "~/modules/threads/agent-dispatch-guard"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const HOLDER = "holder-lapse-window"

describe("the lapse sweep keeps a restricted session's mark", () => {
  let session: minimal.Session
  let agentId: string
  let threadId: string
  let calls: unknown[][] = []
  let realAgentService: typeof import("~/modules/agent/runtime/agent-service")
  let realInvoke: (typeof realAgentService)["invokeAgentForThread"]

  const claim = () =>
    app.request(`/api/agents/${agentId}/local-claims`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify({ threadId, holderKey: HOLDER }),
    })

  async function humanMessage(content: string): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, content, required_scopes)
      VALUES (${threadId}, ${session.orgId}, ${session.userId}, 'user', ${content}, '{}')
      RETURNING id`
    return row.id
  }

  async function dispatch(triggerMessageId: string, restricted: boolean) {
    const { withPrivilegedDb } = await import("~/db/privileged")
    return dispatchAgentMention(
      (fn) => withPrivilegedDb(session.orgId, "lapse-test-dispatch", fn as never) as never,
      {
        orgId: session.orgId,
        threadId,
        calleeAgentId: agentId,
        callerAgentId: null,
        parentMessageId: null,
        triggerMessageId,
        questionText: "stop that session",
        actor: { userId: session.userId, orgId: session.orgId, scopes: ["*"] },
        adderName: "Tester",
        ...(restricted ? { turnContext: { sessionRestricted: true } } : {}),
      },
    )
  }

  async function lapseAndSweep() {
    await sql`UPDATE kernel.agent_local_claims SET expires_at = now() - interval '1 second'
              WHERE thread_id = ${threadId}`
    const { sweepLapsedLocalClaims } = await import(
      "~/modules/agent/local-sessions/local-claim-lapse"
    )
    return sweepLapsedLocalClaims()
  }

  beforeAll(async () => {
    await acquireTestLock()
    const org = await createTestOrg()
    session = await minimal.session(org.id, { role: "admin" })
    const [agent] = await sql<{ id: string }[]>`
      INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling, owner_user_id)
      VALUES (${session.orgId}, 'personal', '@lapse', 'Lapse', '["*"]'::jsonb, ${session.userId})
      RETURNING id`
    agentId = agent.id
    threadId = await minimal.thread(session.orgId, session.userId)
    // The turn itself is not this file's business: what the sweep hands it is.
    realAgentService = await import("~/modules/agent/runtime/agent-service")
    realInvoke = realAgentService.invokeAgentForThread
    mock.module("~/modules/agent/runtime/agent-service", () => ({
      ...realAgentService,
      invokeAgentForThread: (...args: unknown[]) => {
        calls.push(args)
        return Promise.resolve({ finishReason: "stop" })
      },
    }))
  })

  afterAll(async () => {
    mock.module("~/modules/agent/runtime/agent-service", () => ({
      ...realAgentService,
      invokeAgentForThread: realInvoke,
    }))
    await sql`DELETE FROM kernel.agent_local_claims WHERE thread_id = ${threadId}`
    await sql`DELETE FROM kernel.audit_log WHERE org_id = ${session.orgId}`
    await sql`DELETE FROM kernel.agents WHERE id = ${agentId}`
    await releaseTestLock()
  })

  beforeEach(async () => {
    calls = []
    await sql`DELETE FROM kernel.agent_local_claims WHERE thread_id = ${threadId}`
    await sql`DELETE FROM kernel.audit_log WHERE org_id = ${session.orgId}`
  })

  it("a restricted session's held-back message is answered as restricted after the lapse", async () => {
    expect((await claim()).status).toBe(200)
    const messageId = await humanMessage("stop that session")
    const skipped = await dispatch(messageId, true)
    expect(skipped.allowed).toBe(false)
    const result = await lapseAndSweep()
    expect(result.dispatched).toBe(1)
    expect(calls).toHaveLength(1)
    // Last positional of invokeAgentForThread: the turn context.
    expect(calls[0][11]).toMatchObject({ sessionRestricted: true })
  })

  it("an unrestricted one is answered unmarked", async () => {
    expect((await claim()).status).toBe(200)
    const messageId = await humanMessage("stop that session")
    expect((await dispatch(messageId, false)).allowed).toBe(false)
    expect((await lapseAndSweep()).dispatched).toBe(1)
    expect(calls).toHaveLength(1)
    expect(
      (calls[0][11] as { sessionRestricted?: boolean } | undefined)?.sessionRestricted,
    ).not.toBe(true)
  })
})
