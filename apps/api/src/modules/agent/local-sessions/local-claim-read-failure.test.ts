// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHAT HAPPENS WHEN THE CLAIM CANNOT BE READ (A32).
//
// The claim is what stops the server answering a conversation a machine is
// already answering. A read that fails therefore leaves the server with no idea
// whether a desktop is mid turn, and answering anyway is the double reply the
// lease exists to prevent: the machine posts, the cloud posts, the room gets two
// answers to one question and pays for both. So the guard fails CLOSED, and this
// file is the proof, with the failure injected rather than waited for.
//
// Its own file because the claim read is replaced in the module registry: a
// mocked read has no business leaking into the suites that exercise the real one.
import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test"
import { sql } from "~/db"
import * as realClaimService from "~/modules/agent/local-sessions/local-claim-service"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

// The EAGER snapshot, taken before the mock is installed: `import * as` is a
// live view that mock.module patches in place, so spreading it inside the
// factory would spread the mock. A partial factory here would poison the module
// for every later file in the flat run, which is the leak
// modules/apps/mock-module-hygiene.test.ts exists to refuse.
const realClaimServiceModule = { ...realClaimService }

mock.module("~/modules/agent/local-sessions/local-claim-service", () => ({
  ...realClaimServiceModule,
  liveLocalClaims: async () => {
    throw new Error("claim read unavailable")
  },
  liveLocalClaimHolders: async () => {
    throw new Error("claim read unavailable")
  },
}))

describe("the dispatch guard when the local claim cannot be read", () => {
  let session: minimal.Session
  let agentId: string
  let threadId: string

  beforeAll(async () => {
    await acquireTestLock()
    const org = await createTestOrg()
    session = await minimal.session(org.id, { role: "admin" })
    const [agent] = await sql<{ id: string }[]>`
      INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling, owner_user_id)
      VALUES (${session.orgId}, 'personal', '@unreadable', 'Unreadable', '["*"]'::jsonb, ${session.userId})
      RETURNING id`
    agentId = agent.id
    threadId = await minimal.thread(session.orgId, session.userId)
  })

  afterAll(async () => {
    // The OVERRIDE'S VALUE misleads too, not just its presence: a later file
    // reading a claim would get the injected failure. Put the real pair back.
    mock.module("~/modules/agent/local-sessions/local-claim-service", () => realClaimServiceModule)
    await sql`DELETE FROM kernel.audit_log WHERE org_id = ${session.orgId}`
    await sql`DELETE FROM kernel.agents WHERE id = ${agentId}`
    await releaseTestLock()
  })

  it("starts no server turn, and leaves the reason in the audit", async () => {
    const [message] = await sql<{ id: string }[]>`
      INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, content, required_scopes)
      VALUES (${threadId}, ${session.orgId}, ${session.userId}, 'user', 'are you there?', '{}')
      RETURNING id`
    const { dispatchAgentMention } = await import("~/modules/threads/agent-dispatch-guard")
    const { withPrivilegedDb } = await import("~/db/privileged")
    const outcome = await dispatchAgentMention(
      (fn) => withPrivilegedDb(session.orgId, "claim-read-failure-test", fn as never) as never,
      {
        orgId: session.orgId,
        threadId,
        calleeAgentId: agentId,
        callerAgentId: null,
        parentMessageId: null,
        triggerMessageId: message.id,
        questionText: "are you there?",
        actor: { userId: session.userId, orgId: session.orgId, scopes: ["*"] },
        adderName: "Tester",
      },
    )
    expect(outcome.allowed).toBe(false)
    expect(outcome.allowed === false && outcome.reason).toBe("claim_read_failed")

    const [row] = await sql<Array<{ agent_id: string; metadata: Record<string, unknown> }>>`
      SELECT agent_id, metadata FROM kernel.audit_log
      WHERE org_id = ${session.orgId} AND action = 'agent.dispatch.claim_read_failed'`
    expect(row.agent_id).toBe(agentId)
    expect(row.metadata).toMatchObject({ threadId })
  })
})
