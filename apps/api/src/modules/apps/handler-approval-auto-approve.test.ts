// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A handler that parks itself (ctx.requestApproval) and says it can carry on (`auto_approvable`,
// e.g. invoicing credit notes and purchase orders) is answered by the org's auto-approve policy
// for that tool, like any gated tool: the approval is recorded as decided by the policy and the
// handler proceeds. Without the flag, without a policy, or past a two-person rule, it parks for a
// person. A person's own click is decided by the OUTER tool's own required scopes, on the person's
// own scopes: granted inline when they hold them (no row, no thread), refused 403 when they do
// not. The approve scope plays no part, except under an org two-approver policy: the request then
// parks, the person's click counting as one sign-off when they hold the deciding scope.
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { sql } from "~/db"
import * as eventBusModule from "~/infra/events/event-bus"
import { createHandlerApprovalRequest } from "~/modules/apps/execute-tool"

const broadcastSpy = spyOn(eventBusModule, "broadcastEphemeral").mockImplementation(async () => {})

const ORG = "00000000-0000-4000-8000-0000000aa501"
const USER = "00000000-0000-4000-8000-0000000aa502"
const THREAD = "00000000-0000-4000-8000-0000000aa503"
const PEER = "00000000-0000-4000-8000-0000000aa504"
const TOOL = "widgets:credit_issue"

function request(
  opts: {
    autoApprovable?: boolean
    origin?: "in-app-agent" | "human-ui"
    scopes?: string[]
    /** The person's own scopes; defaults to `scopes` for a person's own call. */
    personScopes?: string[]
    /** The outer tool's own required scopes (a person's own call). */
    toolScopes?: string[]
    threadId?: string
    payload?: unknown
  } = {},
) {
  const scopes = opts.scopes ?? ["widgets:issue"]
  const personScopes = opts.personScopes ?? (opts.origin === "human-ui" ? scopes : undefined)
  return createHandlerApprovalRequest({
    orgId: ORG,
    requestedBy: USER,
    actorScopes: scopes,
    ...(personScopes
      ? { personScopes, personToolRequiredScopes: opts.toolScopes ?? ["widgets:issue"] }
      : {}),
    defaultAppName: "widgets",
    threadId: "threadId" in opts ? opts.threadId : THREAD,
    origin: opts.origin ?? "in-app-agent",
    input: {
      tool_name: TOOL,
      summary: "Issue a credit",
      current_payload: opts.payload ?? { amount: 1 },
      ...(opts.autoApprovable !== undefined ? { auto_approvable: opts.autoApprovable } : {}),
    },
  })
}

async function metadataOf(id: string | null) {
  if (id === null) throw new Error("expected an approval row id")
  const [row] = await sql`SELECT status, metadata FROM kernel.approval_requests WHERE id = ${id}`
  return row as { status: string; metadata: Record<string, unknown> | null }
}

async function statusOf(id: string | null) {
  if (id === null) throw new Error("expected an approval row id")
  const [row] = await sql`SELECT status, reason FROM kernel.approval_requests WHERE id = ${id}`
  return row as { status: string; reason: string } | undefined
}

describe("handler-requested approvals and auto-approve policies", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug, settings) VALUES (${ORG}, 'HandlerAA', 'handler-aa', '{}') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER}, ${ORG}, 'haa@test.com', 'HAA') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by, tainted)
      VALUES (${THREAD}, ${ORG}, 'haa-thread', 'agent_chat', ${USER}, false) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${THREAD}, ${USER}, ${ORG}) ON CONFLICT DO NOTHING`
    // Two people may approve the tool, so a two-approver policy can be met.
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${PEER}, ${ORG}, 'haa-peer@test.com', 'Peer') ON CONFLICT DO NOTHING`
    for (const u of [USER, PEER]) {
      await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope) VALUES (${u}, ${ORG}, 'widgets:approve') ON CONFLICT DO NOTHING`
    }
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.auto_approve_policies WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.approval_policies WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    broadcastSpy.mockRestore()
  })

  it("parks for a person when no policy covers the tool", async () => {
    const r = await request({ autoApprovable: true })
    expect(r.auto_approved).toBeUndefined()
    expect((await statusOf(r.approval_id))?.status).toBe("pending")
  })

  it("is approved by the org's policy for the tool, and the record says so", async () => {
    await sql`INSERT INTO kernel.auto_approve_policies (org_id, tool_name, enabled, allow_after_untrusted_content)
      VALUES (${ORG}, ${TOOL}, true, true)`
    const r = await request({ autoApprovable: true })
    expect(r.auto_approved).toBe(true)
    expect(r.approved_by).toBe("policy")
    expect(await statusOf(r.approval_id)).toEqual({
      status: "approved",
      reason: "auto_approved_by_policy",
    })
  })

  it("still parks when the handler cannot carry on", async () => {
    const noFlag = await request()
    expect(noFlag.auto_approved).toBeUndefined()
    expect((await statusOf(noFlag.approval_id))?.status).toBe("pending")
  })

  it("a person's own click without the tool's own scope is refused: no policy answers it, nothing parks", async () => {
    const [{ n: before }] =
      await sql`SELECT count(*)::int AS n FROM kernel.approval_requests WHERE org_id = ${ORG}`
    let caught: any = null
    try {
      // Even holding the approve scope: the tool's own scope decides.
      await request({
        autoApprovable: true,
        origin: "human-ui",
        scopes: ["widgets:read", "widgets:approve"],
      })
    } catch (err) {
      caught = err
    }
    expect(caught?.status).toBe(403)
    expect(caught?.code).toBe("forbidden")
    expect(String(caught?.message)).toMatch(/^forbidden: .*widgets:issue/)
    const [{ n: after }] =
      await sql`SELECT count(*)::int AS n FROM kernel.approval_requests WHERE org_id = ${ORG}`
    expect(after).toBe(before)
  })

  async function counts() {
    const [{ a }] =
      await sql`SELECT count(*)::int AS a FROM kernel.approval_requests WHERE org_id = ${ORG}`
    const [{ t }] = await sql`SELECT count(*)::int AS t FROM kernel.threads WHERE org_id = ${ORG}`
    return { approvals: a as number, threads: t as number }
  }

  it("a person's own click holding the tool's own scope (no approve scope) is granted inline: nothing is written", async () => {
    const before = await counts()
    // With and without a conversation thread (a threadless direct call used to
    // get an approval anchor thread of its own), and whether or not the
    // handler could be auto-approved.
    for (const threadId of [THREAD, undefined]) {
      for (const autoApprovable of [true, false]) {
        const r = await request({
          origin: "human-ui",
          scopes: ["widgets:issue"],
          threadId,
          autoApprovable,
        })
        expect(r).toEqual({ approval_id: null, auto_approved: true, approved_by: "requester" })
      }
    }
    expect(await counts()).toEqual(before)
  })

  it("under an org two-approver policy a person who could decide parks with their own sign-off counted (1 of 2)", async () => {
    await sql`INSERT INTO kernel.approval_policies (org_id, tool_name, enabled, conditions, require_approval, min_approvers)
      VALUES (${ORG}, ${TOOL}, true, '[]'::jsonb, true, 2)`
    try {
      const r = await request({ origin: "human-ui", scopes: ["widgets:issue", "widgets:approve"] })
      expect(r.auto_approved).toBeUndefined()
      const row = await metadataOf(r.approval_id)
      expect(row.status).toBe("pending")
      expect(row.metadata?.minApprovers).toBe(2)
      expect(row.metadata?.approvedBy).toEqual([USER])
    } finally {
      await sql`DELETE FROM kernel.approval_policies WHERE org_id = ${ORG}`
    }
  })

  it("under an org two-approver policy a person without the deciding scope parks with no sign-off counted", async () => {
    await sql`INSERT INTO kernel.approval_policies (org_id, tool_name, enabled, conditions, require_approval, min_approvers)
      VALUES (${ORG}, ${TOOL}, true, '[]'::jsonb, true, 2)`
    try {
      const r = await request({ origin: "human-ui", scopes: ["widgets:issue"] })
      const row = await metadataOf(r.approval_id)
      expect(row.status).toBe("pending")
      expect(row.metadata?.minApprovers).toBe(2)
      expect(row.metadata?.approvedBy).toBeUndefined()
    } finally {
      await sql`DELETE FROM kernel.approval_policies WHERE org_id = ${ORG}`
    }
  })

  it("an agent's handler-requested approval under a two-approver policy carries the floor", async () => {
    await sql`INSERT INTO kernel.approval_policies (org_id, tool_name, enabled, conditions, require_approval, min_approvers)
      VALUES (${ORG}, ${TOOL}, true, '[]'::jsonb, true, 2)`
    try {
      const r = await request({ autoApprovable: true })
      const row = await metadataOf(r.approval_id)
      expect(row.status).toBe("pending")
      expect(row.metadata?.minApprovers).toBe(2)
      expect(row.metadata?.approvedBy).toBeUndefined()
    } finally {
      await sql`DELETE FROM kernel.approval_policies WHERE org_id = ${ORG}`
    }
  })

  it("under an org two-approver policy nobody else may approve: refused at once (409), nothing parks", async () => {
    await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG} AND user_id = ${PEER}`
    await sql`INSERT INTO kernel.approval_policies (org_id, tool_name, enabled, conditions, require_approval, min_approvers)
      VALUES (${ORG}, ${TOOL}, true, '[]'::jsonb, true, 2)`
    try {
      for (const origin of ["human-ui", "in-app-agent"] as const) {
        const before = await counts()
        let caught: any = null
        try {
          await request({
            origin,
            scopes: ["widgets:issue", "widgets:approve"],
            threadId: undefined,
          })
        } catch (err) {
          caught = err
        }
        expect(caught?.status).toBe(409)
        expect(caught?.code).toBe("approvers_unavailable")
        expect(await counts()).toEqual(before)
      }
    } finally {
      await sql`DELETE FROM kernel.approval_policies WHERE org_id = ${ORG}`
      await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope) VALUES (${PEER}, ${ORG}, 'widgets:approve') ON CONFLICT DO NOTHING`
    }
  })

  async function refusal(opts: Parameters<typeof request>[0]) {
    const before = await counts()
    let caught: any = null
    try {
      await request(opts)
    } catch (err) {
      caught = err
    }
    expect(await counts()).toEqual(before)
    return caught
  }

  it("is decided on the person's OWN scopes, never on a hop-widened actor holding the app's `*`", async () => {
    // The handler's actor carries widgets:* (as an RLS actor a cross-app hop
    // builds would), but the person never held the tool's widgets:issue.
    const caught = await refusal({
      origin: "human-ui",
      scopes: ["widgets:*"],
      personScopes: ["widgets:read"],
    })
    expect(caught?.status).toBe(403)
    expect(String(caught?.message)).toMatch(/^forbidden: .*widgets:issue/)
  })

  it("a person-origin request without the person's own scopes is refused, never granted, never parked", async () => {
    const before = await counts()
    let direct: any = null
    try {
      await createHandlerApprovalRequest({
        orgId: ORG,
        requestedBy: USER,
        actorScopes: ["widgets:*"],
        defaultAppName: "widgets",
        origin: "human-ui",
        input: { tool_name: TOOL, summary: "s", current_payload: {} },
      })
    } catch (err) {
      direct = err
    }
    expect(direct?.status).toBe(403)
    expect(await counts()).toEqual(before)
  })

  it("a scoped person's request carrying @ref placeholders is refused (sequenced): nothing parks", async () => {
    const caught = await refusal({
      origin: "human-ui",
      scopes: ["widgets:issue"],
      payload: { amount: "@ref:00000000-0000-4000-8000-0000000aa599:amount" },
    })
    expect(caught?.status).toBe(403)
    expect(String(caught?.message)).toMatch(/@ref/)
  })
})
