// SPDX-License-Identifier: FSL-1.1-ALv2

import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { APPROVING_WEDGE_GRACE_MS } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { appsLogger } from "~/lib/logger"
import { assembleContext } from "~/modules/agent/context/context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { runApprovingReaper } from "~/modules/approvals/approving-reaper"
import { AlreadyDecidedError, decideApproval } from "~/modules/approvals/decide"
import {
  recordAmbiguous,
  recordEffectLanded,
  recordFailedNoEffect,
  recordStarted,
  recordSucceeded,
} from "~/modules/approvals/handler-protocol"
import { toolRegistry } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = "00000000-0000-4000-8000-000000061001"
const USER = "00000000-0000-4000-8000-000000061002"
const THREAD = "00000000-0000-4000-8000-000000061003"

const actor: UserContext = {
  actorType: "user",
  userId: USER,
  orgId: ORG,
  scopes: ["decide_test:gated:write", "decide_test:approve"],
  dimensionGrants: {},
}

async function grantScopes(scopes: string[]) {
  await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG} AND user_id = ${USER}`
  for (const scope of scopes) {
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
      VALUES (${USER}, ${ORG}, ${scope}) ON CONFLICT DO NOTHING`
  }
}

async function createRequest(tool: string, params: Record<string, unknown> = { message: "hello" }) {
  const result = await executeTool({
    toolName: `decide_test:${tool}`,
    orgId: ORG,
    actor,
    params,
    threadId: THREAD,
    // Force the gated approval path even when the actor holds :approve. The
    // direct-human-with-approve bypass only triggers when `origin` is unset.
    origin: "in-app-agent",
  })
  return result.blocked!.approvalRequestId!
}

const SENT_REF = {
  provider: "gmail",
  messageId: "<sent-1@mail.gmail.com>",
  externalThreadId: "thread-1",
}
let providerSends = 0

async function latestApprovalCtx(toolName: string) {
  const [row] =
    await sql`SELECT id, decided_by FROM kernel.approval_requests WHERE org_id = ${ORG} ORDER BY created_at DESC LIMIT 1`
  return {
    orgId: ORG,
    approvalRequestId: row.id as string,
    approvalDeciderId: row.decided_by as string,
    toolName,
  }
}

async function statusOf(id: string) {
  const [row] = await sql`SELECT status FROM kernel.approval_requests WHERE id = ${id}`
  return row.status as string
}

describe("decideApproval lifecycle", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'Decide Approval Org', 'decide-approval-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
      VALUES (${USER}, ${ORG}, 'decide@test.com', 'Decider', 'active', 'hash') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${THREAD}, ${ORG}, 'decide-thread', 'agent_chat', ${USER}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
      VALUES (${THREAD}, ${USER}, ${ORG}, 'admin') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id)
      VALUES (${USER}, ${THREAD}, ${ORG}) ON CONFLICT DO NOTHING`

    toolRegistry.set([ORG, "decide_test", "gatedEcho"], {
      appName: "decide_test",
      name: "gatedEcho",
      description: "Gated echo",
      requiredScopes: ["decide_test:gated:write"],
      gated: true,
      handler: async (params: any) => {
        const [row] =
          await sql`SELECT id, decided_by FROM kernel.approval_requests WHERE org_id = ${ORG} ORDER BY created_at DESC LIMIT 1`
        await withPrivilegedDb(ORG, "decide-test-success", (tx) =>
          recordStarted(
            tx,
            {
              orgId: ORG,
              approvalRequestId: row.id,
              approvalDeciderId: row.decided_by,
              toolName: "decide_test:gatedEcho",
            },
            "decide_test:gatedEcho",
          ),
        )
        await withPrivilegedDb(ORG, "decide-test-success-finish", (tx) =>
          recordSucceeded(
            tx,
            {
              orgId: ORG,
              approvalRequestId: row.id,
              approvalDeciderId: row.decided_by,
              toolName: "decide_test:gatedEcho",
            },
            "decide_test:gatedEcho",
            { synthetic: true },
          ),
        )
        return { echoed: params.message }
      },
      returns: { schema: { echoed: "string" } },
    } as any)
    // A handler that RETURNS a soft-error envelope instead of throwing — the
    // boxtal create_shipment unresolved_lines class. Must be recorded as a
    // failure, never as 'succeeded' (a false success cancels dependent @ref
    // steps with an unactionable "missing output" while the audit trail claims
    // the action ran).
    toolRegistry.set([ORG, "decide_test", "softError"], {
      appName: "decide_test",
      name: "softError",
      description: "Returns { error } without throwing",
      requiredScopes: ["decide_test:gated:write"],
      gated: true,
      handler: async () => ({
        error: {
          code: "unresolved_lines",
          message: "set the carton with shipment_draft_set_package",
        },
      }),
    } as any)
    // The same with a plain string error (`{ error: "app not installed" }`, the
    // kernel:enable_app class): the card said "Tool executed successfully".
    toolRegistry.set([ORG, "decide_test", "softErrorString"], {
      appName: "decide_test",
      name: "softErrorString",
      description: "Returns { error: string } without throwing",
      requiredScopes: ["decide_test:gated:write"],
      gated: true,
      handler: async () => ({ error: "app not installed" }),
    } as any)
    // A FINAL refusal (the config tools' plan drift): re-approving the same
    // payload can never pass, so the request closes instead of re-pending.
    toolRegistry.set([ORG, "decide_test", "softErrorFinal"], {
      appName: "decide_test",
      name: "softErrorFinal",
      description: "Returns a final { error }",
      requiredScopes: ["decide_test:gated:write"],
      gated: true,
      handler: async () => ({
        error: {
          code: "plan_changed",
          message: "the plan changed since approval; propose again",
          final: true,
        },
      }),
    } as any)
    // A soft-error envelope carrying a restage payload patch — the boxtal
    // price_increased class: the failed execution must revert to pending AND
    // re-stage the card at the corrected payload (the new price), so the next
    // review approves what will actually be bought.
    toolRegistry.set([ORG, "decide_test", "softErrorRestage"], {
      appName: "decide_test",
      name: "softErrorRestage",
      description: "Returns { error } with a restage_payload_patch",
      requiredScopes: ["decide_test:gated:write"],
      gated: true,
      handler: async () => ({
        error: {
          code: "price_increased",
          message: "The live price is now 12.50 EUR, up from the approved 8.00.",
          restage_payload_patch: { quoted_price_ttc: 12.5 },
        },
      }),
    } as any)
    toolRegistry.set([ORG, "decide_test", "failNoEffect"], {
      appName: "decide_test",
      name: "failNoEffect",
      description: "No effect failure",
      requiredScopes: ["decide_test:gated:write"],
      gated: true,
      handler: async () => {
        const [row] =
          await sql`SELECT id, decided_by FROM kernel.approval_requests WHERE org_id = ${ORG} ORDER BY created_at DESC LIMIT 1`
        const ctx = {
          orgId: ORG,
          approvalRequestId: row.id,
          approvalDeciderId: row.decided_by,
          toolName: "decide_test:failNoEffect",
        }
        await withPrivilegedDb(ORG, "decide-test-fail-start", (tx) =>
          recordStarted(tx, ctx, "decide_test:failNoEffect"),
        )
        await withPrivilegedDb(ORG, "decide-test-fail-finish", (tx) =>
          recordFailedNoEffect(tx, ctx, "decide_test:failNoEffect", { code: "NO_EFFECT" }),
        )
        throw new Error("no effect")
      },
    } as any)
    toolRegistry.set([ORG, "decide_test", "ambiguous"], {
      appName: "decide_test",
      name: "ambiguous",
      description: "Ambiguous failure",
      requiredScopes: ["decide_test:gated:write"],
      gated: true,
      handler: async () => {
        const [row] =
          await sql`SELECT id, decided_by FROM kernel.approval_requests WHERE org_id = ${ORG} ORDER BY created_at DESC LIMIT 1`
        const ctx = {
          orgId: ORG,
          approvalRequestId: row.id,
          approvalDeciderId: row.decided_by,
          toolName: "decide_test:ambiguous",
        }
        await withPrivilegedDb(ORG, "decide-test-amb-start", (tx) =>
          recordStarted(tx, ctx, "decide_test:ambiguous"),
        )
        await withPrivilegedDb(ORG, "decide-test-amb-finish", (tx) =>
          recordAmbiguous(tx, ctx, "decide_test:ambiguous", { code: "TIMEOUT" }),
        )
        throw new Error("ambiguous")
      },
    } as any)
    // The prod shape behind ticket-10197 / ticket-10200: a DB-only tool
    // (approvalImpact "internal", e.g. knowledge:create) that THROWS an ordinary
    // deterministic error and never touches the handler protocol. Its effects all
    // live inside the kernel tx, which rolled back, so nothing landed.
    toolRegistry.set([ORG, "decide_test", "internalThrows"], {
      appName: "decide_test",
      name: "internalThrows",
      description: "DB-only tool that throws",
      requiredScopes: ["decide_test:gated:write"],
      gated: true,
      approvalImpact: "internal",
      handler: async () => {
        throw new Error(
          'Failed query: SELECT * FROM app_knowledge.collections WHERE id = $1::uuid — invalid input syntax for type uuid: "support"',
        )
      },
    } as any)
    // Control: same throw, but the tool reaches OUTSIDE the kernel tx. Its
    // outcome really is unknown and must stay parked for a human.
    toolRegistry.set([ORG, "decide_test", "externalThrows"], {
      appName: "decide_test",
      name: "externalThrows",
      description: "External-impact tool that throws",
      requiredScopes: ["decide_test:gated:write"],
      gated: true,
      approvalImpact: "external",
      handler: async () => {
        throw new Error("upstream exploded mid-send")
      },
    } as any)
    // The 2026-10-08 shape: the provider accepted the send, the handler recorded
    // the landed effect, then the sandbox ceiling cut it off in its post-send work
    // before it could record success.
    toolRegistry.set([ORG, "decide_test", "landedThenCutOff"], {
      appName: "decide_test",
      name: "landedThenCutOff",
      description: "Sends, records the landed send, then is interrupted",
      requiredScopes: ["decide_test:gated:write"],
      gated: true,
      approvalImpact: "external",
      handler: async () => {
        const ctx = await latestApprovalCtx("decide_test:landedThenCutOff")
        await withPrivilegedDb(ORG, "decide-test-landed-start", (tx) =>
          recordStarted(tx, ctx, ctx.toolName),
        )
        providerSends += 1
        await withPrivilegedDb(ORG, "decide-test-landed", (tx) =>
          recordEffectLanded(tx, ctx, ctx.toolName, SENT_REF),
        )
        throw new Error("App execution timed out")
      },
    } as any)
    // Control: interrupted after `started` and before anything was recorded as
    // landed. Its outcome really is unknown.
    toolRegistry.set([ORG, "decide_test", "cutOffBeforeLanded"], {
      appName: "decide_test",
      name: "cutOffBeforeLanded",
      description: "Interrupted before recording a landed effect",
      requiredScopes: ["decide_test:gated:write"],
      gated: true,
      approvalImpact: "external",
      handler: async () => {
        const ctx = await latestApprovalCtx("decide_test:cutOffBeforeLanded")
        await withPrivilegedDb(ORG, "decide-test-cutoff-start", (tx) =>
          recordStarted(tx, ctx, ctx.toolName),
        )
        providerSends += 1
        throw new Error("App execution timed out")
      },
    } as any)
    toolRegistry.set([ORG, "decide_test", "startedOnly"], {
      appName: "decide_test",
      name: "startedOnly",
      description: "Started only",
      requiredScopes: ["decide_test:gated:write"],
      gated: true,
      handler: async () => {
        const [row] =
          await sql`SELECT id, decided_by FROM kernel.approval_requests WHERE org_id = ${ORG} ORDER BY created_at DESC LIMIT 1`
        await withPrivilegedDb(ORG, "decide-test-started-only", (tx) =>
          recordStarted(
            tx,
            {
              orgId: ORG,
              approvalRequestId: row.id,
              approvalDeciderId: row.decided_by,
              toolName: "decide_test:startedOnly",
            },
            "decide_test:startedOnly",
          ),
        )
        return { echoed: "not enough" }
      },
    } as any)
  })

  afterEach(async () => {
    await grantScopes(["decide_test:gated:write", "decide_test:approve"])
    await sql`DELETE FROM kernel.approved_handler_executions WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
  })

  afterAll(async () => {
    toolRegistry.deleteByPrefix([ORG])
    await releaseTestLock()
  })

  it("decide approve wins exactly once under 50 concurrent calls", async () => {
    await grantScopes(["decide_test:gated:write", "decide_test:approve"])
    const id = await createRequest("gatedEcho")
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, () =>
        decideApproval({ orgId: ORG, requestId: id, actor, decision: "approve" }),
      ),
    )
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected")
    expect(rejected).toHaveLength(49)
    expect(rejected.every((r) => r.reason instanceof AlreadyDecidedError)).toBe(true)
    expect(await statusOf(id)).toBe("approved")
  })

  it("decide deny accepts an optional reason (trims it, blank is allowed)", async () => {
    await grantScopes(["decide_test:gated:write", "decide_test:approve"])
    // Whitespace-only reason is treated as no reason: deny still succeeds.
    const blankId = await createRequest("gatedEcho")
    const blank = await decideApproval({
      orgId: ORG,
      requestId: blankId,
      actor,
      decision: "deny",
      reason: "   ",
    })
    expect(blank.status).toBe("denied")
    expect(blank.reason).toBe("")
    // No reason field at all also succeeds.
    const noneId = await createRequest("gatedEcho")
    const none = await decideApproval({ orgId: ORG, requestId: noneId, actor, decision: "deny" })
    expect(none.status).toBe("denied")
    expect(none.reason).toBe("")
    // A supplied reason is trimmed and persisted.
    const withId = await createRequest("gatedEcho")
    const result = await decideApproval({
      orgId: ORG,
      requestId: withId,
      actor,
      decision: "deny",
      reason: " no ",
    })
    expect(result.status).toBe("denied")
    expect(result.reason).toBe("no")
  })

  it("decide deny rejects an over-long reason", async () => {
    await grantScopes(["decide_test:gated:write", "decide_test:approve"])
    const id = await createRequest("gatedEcho")
    await expect(
      decideApproval({
        orgId: ORG,
        requestId: id,
        actor,
        decision: "deny",
        reason: "x".repeat(1001),
      }),
    ).rejects.toMatchObject({ code: "invalid_reason", status: 400 })
  })

  // Regression (Finding 10): an eligible approver — in the audience + holding
  // :approve — may DENY, not only the requester. Prior code gated deny on
  // requested_by === actor only, so an approver could approve but never reject —
  // a spec violation (approvers may approve OR deny). We simulate "someone else
  // requested it" by re-pointing requested_by at a second real user; USER remains
  // an eligible approver (in notify_user_ids + holds :approve) but is no longer
  // the requester.
  const OTHER_REQUESTER = "00000000-0000-4000-8000-000000061099"
  const seedOtherRequester = () =>
    sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
      VALUES (${OTHER_REQUESTER}, ${ORG}, 'other-requester@test.com', 'Other', 'active', 'h')
      ON CONFLICT DO NOTHING`

  it("a non-requester eligible approver CAN deny", async () => {
    await grantScopes(["decide_test:gated:write", "decide_test:approve"])
    await seedOtherRequester()
    const id = await createRequest("gatedEcho")
    await sql`UPDATE kernel.approval_requests SET requested_by = ${OTHER_REQUESTER} WHERE id = ${id}`
    const result = await decideApproval({
      orgId: ORG,
      requestId: id,
      actor,
      decision: "deny",
      reason: "approver reject",
    })
    expect(result.status).toBe("denied")
    expect(await statusOf(id)).toBe("denied")
  })

  it("a decider who is neither requester nor eligible approver CANNOT deny (404 — request not visible)", async () => {
    // The approval_requests RLS SELECT scopes visibility to requester OR
    // (in-audience AND holds :approve). After revoking :approve and re-pointing
    // requested_by away, USER can no longer SEE the request, so deny → 404
    // (existence not leaked). This is the secure outer guard; the decide.ts deny
    // authz check is defense-in-depth behind it.
    await grantScopes(["decide_test:gated:write", "decide_test:approve"])
    await seedOtherRequester()
    const id = await createRequest("gatedEcho")
    await sql`UPDATE kernel.approval_requests SET requested_by = ${OTHER_REQUESTER} WHERE id = ${id}`
    await grantScopes(["decide_test:gated:write"]) // revoke :approve
    await expect(
      decideApproval({ orgId: ORG, requestId: id, actor, decision: "deny", reason: "nope" }),
    ).rejects.toMatchObject({ code: "not_found", status: 404 })
    expect(await statusOf(id)).toBe("pending")
  })

  // Shared-surface (ticket) counterpoint to the decide_test 404 above. For a
  // `tickets:reply` draft the RLS SELECT (migration 0018) and the decide
  // authorization both widen to "anyone who can act on the ticket": a teammate
  // holding tickets:approve who is NEITHER the requester NOR in the notify-set
  // ({USER}) can still deny the colleague's draft. This is the exact gap that
  // left a stale draft card un-dismissable in a teammate's ticket view.
  const TICKET_APPROVER = "00000000-0000-4000-8000-000000061098"
  const TICKET_REQUEST = "00000000-0000-4000-8000-000000061097"
  it("a ticket-team approver not in the notify-set CAN deny a shared-surface tickets:reply draft", async () => {
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
      VALUES (${TICKET_APPROVER}, ${ORG}, 'ticket-approver@test.com', 'Ticket Approver', 'active', 'h')
      ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
      VALUES (${TICKET_APPROVER}, ${ORG}, 'tickets:approve') ON CONFLICT DO NOTHING`
    // Requester is USER (a participant of THREAD, so the deny audit note posts);
    // notify-set is USER only, so TICKET_APPROVER is out of the audience.
    await sql`INSERT INTO kernel.approval_requests (
      id, org_id, handle, thread_id, originating_thread_id, tool_name, tool_params,
      current_payload, expires_at, notify_user_ids, requested_by, status, reason, summary
    ) VALUES
      (${TICKET_REQUEST}, ${ORG}, 'decide-ticket-reply', ${THREAD}, ${THREAD}, 'tickets:reply', '{"message":"draft"}'::jsonb,
       '{"message":"draft"}'::jsonb, now() + interval '1 hour', ARRAY[${USER}]::uuid[], ${USER}, 'pending', 'gated',
       '{"kind":"reply","title":"Ticket Reply","lines":[]}'::jsonb)
      ON CONFLICT DO NOTHING`
    const result = await decideApproval({
      orgId: ORG,
      requestId: TICKET_REQUEST,
      actor: {
        actorType: "user",
        userId: TICKET_APPROVER,
        orgId: ORG,
        scopes: ["tickets:approve", "tickets:tickets:read"],
        dimensionGrants: {},
      },
      decision: "deny",
      reason: "handled by me",
    })
    expect(result.status).toBe("denied")
    expect(await statusOf(TICKET_REQUEST)).toBe("denied")
    await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG} AND user_id = ${TICKET_APPROVER}`
  })

  it("the requester may still self-withdraw via deny even without :approve scope", async () => {
    await grantScopes(["decide_test:gated:write", "decide_test:approve"])
    const id = await createRequest("gatedEcho") // requested_by = USER
    await grantScopes(["decide_test:gated:write"]) // drop :approve — requester self-cancel still allowed
    const result = await decideApproval({
      orgId: ORG,
      requestId: id,
      actor,
      decision: "deny",
      reason: "withdraw",
    })
    expect(result.status).toBe("denied")
  })

  it("decide approve returns 403 when current approve scope was revoked", async () => {
    await grantScopes(["decide_test:gated:write", "decide_test:approve"])
    const id = await createRequest("gatedEcho")
    await grantScopes(["decide_test:gated:write"])
    await expect(
      decideApproval({ orgId: ORG, requestId: id, actor, decision: "approve" }),
    ).rejects.toMatchObject({ code: "forbidden", status: 403 })
    expect(await statusOf(id)).toBe("pending")
  })

  it("decide failed_no_effect reverts to pending and posts approval-error", async () => {
    await grantScopes(["decide_test:gated:write", "decide_test:approve"])
    const id = await createRequest("failNoEffect")
    await expect(
      decideApproval({ orgId: ORG, requestId: id, actor, decision: "approve" }),
    ).rejects.toMatchObject({ code: "handler_failed", status: 422 })
    expect(await statusOf(id)).toBe("pending")
    const errorRows =
      await sql`SELECT metadata FROM kernel.messages WHERE org_id = ${ORG} AND metadata->>'type' = 'approval-error'`
    expect(errorRows.length).toBe(1)
    expect(errorRows[0].metadata.type).toBe("approval-error")
  })

  // The two approval error notices quote handler output: "Handler failed:
  // <err.message>" and "Approval execution did not complete: <detail>", and
  // both carry the raw error in metadata. A handler that failed while holding
  // scoped data can put that data in either place, so the notice fails closed
  // to the requester's own scope set, exactly as the bundle failure notice and
  // the re-invocation failure context do.
  const LACKER = "00000000-0000-4000-8000-000000061009"

  async function seedLacker() {
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
      VALUES (${LACKER}, ${ORG}, 'decide-lacker@test.com', 'Lacker', 'active', 'hash')
      ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
      VALUES (${THREAD}, ${LACKER}, ${ORG}) ON CONFLICT DO NOTHING`
  }

  async function dropLacker() {
    await sql`DELETE FROM kernel.thread_participants WHERE thread_id = ${THREAD} AND user_id = ${LACKER}`
    await sql`DELETE FROM kernel.users WHERE id = ${LACKER}`
  }

  async function visibleIds(userId: string, scopes: string[]): Promise<string[]> {
    return withRlsContext(
      { actorType: "user", userId, orgId: ORG, scopes, dimensionGrants: {} },
      async (tx) =>
        extractRows<{ id: string }>(
          await tx.execute(drizzleSql`SELECT id FROM kernel.messages WHERE thread_id = ${THREAD}`),
        ).map((r) => r.id),
    )
  }

  async function expectRequesterScopedErrorNotice(id: string) {
    // No record of what the proposing turn read: only then the requester's whole set.
    const rows = await sql<{ id: string; required_scopes: string[] }[]>`
      SELECT id, required_scopes FROM kernel.messages
      WHERE org_id = ${ORG} AND metadata->>'type' = 'approval-error'
        AND metadata->>'requestHandle' = (SELECT handle FROM kernel.approval_requests WHERE id = ${id})`
    expect(rows.length).toBeGreaterThan(0)
    const lackerSees = await visibleIds(LACKER, [])
    const requesterSees = await visibleIds(USER, actor.scopes)
    for (const row of rows) {
      expect(row.required_scopes).toEqual(["decide_test:approve", "decide_test:gated:write"])
      expect(lackerSees).not.toContain(row.id)
      expect(requesterSees).toContain(row.id)
    }
  }

  it("the handler-failed notice carries the requester's scopes and RLS hides it from a member lacking them", async () => {
    await grantScopes(["decide_test:gated:write", "decide_test:approve"])
    await seedLacker()
    try {
      const id = await createRequest("failNoEffect")
      await sql`UPDATE kernel.approval_requests SET proposing_turn_scopes = NULL WHERE id = ${id}`
      await expect(
        decideApproval({ orgId: ORG, requestId: id, actor, decision: "approve" }),
      ).rejects.toMatchObject({ code: "handler_failed", status: 422 })
      await expectRequesterScopedErrorNotice(id)
    } finally {
      await dropLacker()
    }
  })

  it("the execution-did-not-complete notice carries the requester's scopes and RLS hides it from a member lacking them", async () => {
    await grantScopes(["decide_test:gated:write", "decide_test:approve"])
    await seedLacker()
    try {
      const id = await createRequest("ambiguous")
      await sql`UPDATE kernel.approval_requests SET proposing_turn_scopes = NULL WHERE id = ${id}`
      await expect(
        decideApproval({ orgId: ORG, requestId: id, actor, decision: "approve" }),
      ).rejects.toMatchObject({ code: "handler_ambiguous", status: 422 })
      await expectRequesterScopedErrorNotice(id)
    } finally {
      await dropLacker()
    }
  })

  it("a failed approval does not hand its whole scope set to the conversation (walk: stuck thread)", async () => {
    // A person approved a card, the handler turned the date down. The notice was
    // stamped with everything that person may read, the next turn read it as
    // history, and every later gated write in the thread was refused for good, on
    // scopes the turn's actor does not hold.
    await grantScopes([
      "decide_test:gated:write",
      "decide_test:approve",
      "decide_test:elsewhere:read",
      "decide_test:docs:read",
    ])
    await seedLacker()
    // The thread is shared in this file: only this request's notice is under test.
    await sql`DELETE FROM kernel.messages WHERE thread_id = ${THREAD}`
    try {
      const id = await createRequest("failNoEffect")
      await sql`UPDATE kernel.approval_requests
        SET proposing_turn_scopes = ARRAY['decide_test:docs:read'] WHERE id = ${id}`
      await expect(
        decideApproval({ orgId: ORG, requestId: id, actor, decision: "approve" }),
      ).rejects.toMatchObject({ code: "handler_failed", status: 422 })

      const rows = await sql<{ id: string; required_scopes: string[] }[]>`
        SELECT id, required_scopes FROM kernel.messages
        WHERE org_id = ${ORG} AND metadata->>'type' = 'approval-error'
          AND metadata->>'requestHandle' = (SELECT handle FROM kernel.approval_requests WHERE id = ${id})`
      expect(rows.length).toBeGreaterThan(0)
      for (const row of rows) {
        expect(row.required_scopes).toEqual(["decide_test:docs:read", "decide_test:gated:write"])
      }
      // Still hidden from someone who could not have run the call.
      const lackerSees = await visibleIds(LACKER, [])
      for (const row of rows) expect(lackerSees).not.toContain(row.id)

      // And the next turn's taint, read through the real history loader, holds no more.
      const accumulator = createTurnScopeAccumulator({ orgId: ORG })
      await assembleContext({
        threadId: THREAD,
        orgId: ORG,
        actor: { ...actor, scopes: ["decide_test:docs:read", "decide_test:gated:write"] },
        turnScopeAccumulator: accumulator,
      })
      expect(accumulator.snapshot()).not.toContain("decide_test:elsewhere:read")
      expect(accumulator.snapshot()).not.toContain("decide_test:approve")
    } finally {
      await dropLacker()
    }
  })

  it("a handler RETURNING a soft-error envelope is recorded failed_no_effect and reverts to pending (never a false success)", async () => {
    await grantScopes(["decide_test:gated:write", "decide_test:approve"])
    const id = await createRequest("softError")
    await expect(
      decideApproval({ orgId: ORG, requestId: id, actor, decision: "approve" }),
    ).rejects.toMatchObject({ code: "handler_failed", status: 422 })
    expect(await statusOf(id)).toBe("pending")
    const [exec] =
      await sql`SELECT status, error FROM kernel.approved_handler_executions WHERE approval_request_id = ${id}`
    expect(exec.status).toBe("failed_no_effect")
    expect(JSON.stringify(exec.error)).toContain("unresolved_lines")
  })

  it("a handler RETURNING a plain string error is a failure too, never 'executed successfully'", async () => {
    await grantScopes(["decide_test:gated:write", "decide_test:approve"])
    const id = await createRequest("softErrorString")
    await expect(
      decideApproval({ orgId: ORG, requestId: id, actor, decision: "approve" }),
    ).rejects.toMatchObject({ code: "handler_failed", status: 422 })
    expect(await statusOf(id)).toBe("pending")
    const [exec] =
      await sql`SELECT status, error FROM kernel.approved_handler_executions WHERE approval_request_id = ${id}`
    expect(exec.status).toBe("failed_no_effect")
    expect(JSON.stringify(exec.error)).toContain("app not installed")
  })

  it("a FINAL soft error closes the request (cancelled), never re-pends it", async () => {
    await grantScopes(["decide_test:gated:write", "decide_test:approve"])
    const id = await createRequest("softErrorFinal")
    await expect(
      decideApproval({ orgId: ORG, requestId: id, actor, decision: "approve" }),
    ).rejects.toMatchObject({ code: "handler_failed", status: 422 })
    expect(await statusOf(id)).toBe("cancelled")
    const [exec] =
      await sql`SELECT status, error FROM kernel.approved_handler_executions WHERE approval_request_id = ${id}`
    expect(exec.status).toBe("failed_no_effect")
    expect(JSON.stringify(exec.error)).toContain("plan_changed")
  })

  it("a soft error carrying restage_payload_patch reverts to pending WITH the patch applied to the payload", async () => {
    await grantScopes(["decide_test:gated:write", "decide_test:approve"])
    const id = await createRequest("softErrorRestage", { message: "buy", quoted_price_ttc: 8 })
    await expect(
      decideApproval({ orgId: ORG, requestId: id, actor, decision: "approve" }),
    ).rejects.toMatchObject({ code: "handler_failed", status: 422 })
    expect(await statusOf(id)).toBe("pending")
    // The re-staged card carries the NEW price (the patch), not the stale approved one.
    const [row] = await sql`SELECT current_payload FROM kernel.approval_requests WHERE id = ${id}`
    expect(row.current_payload.quoted_price_ttc).toBe(12.5)
    // The persisted execution failure keeps the readable reason for the status pull.
    const [exec] =
      await sql`SELECT status, error FROM kernel.approved_handler_executions WHERE approval_request_id = ${id}`
    expect(exec.status).toBe("failed_no_effect")
    expect(JSON.stringify(exec.error)).toContain("price_increased")
  })

  it("a failed post-approval execution emits an approval_request:update event carrying lastFailure (attention feed source)", async () => {
    await grantScopes(["decide_test:gated:write", "decide_test:approve"])
    const id = await createRequest("softError")
    await expect(
      decideApproval({ orgId: ORG, requestId: id, actor, decision: "approve" }),
    ).rejects.toMatchObject({ code: "handler_failed", status: 422 })
    const events = (await sql`
      SELECT payload FROM kernel.pending_events
      WHERE org_id = ${ORG}
        AND payload->>'entity' = 'approval_request'
        AND payload->>'entityId' = ${id}
        AND payload->>'action' = 'update'`) as unknown as Array<{
      payload: { data?: { lastFailure?: { code?: string; message?: string } } }
    }>
    const withFailure = events.find((e) => e.payload?.data?.lastFailure)
    expect(withFailure).toBeDefined()
    expect(withFailure?.payload.data?.lastFailure?.code).toBe("unresolved_lines")
    expect(withFailure?.payload.data?.lastFailure?.message).toContain("shipment_draft_set_package")
  })

  it("decide ambiguous leaves approving, posts an on-hold approval-error notice, no decision message", async () => {
    await grantScopes(["decide_test:gated:write", "decide_test:approve"])
    const id = await createRequest("ambiguous")
    await expect(
      decideApproval({ orgId: ORG, requestId: id, actor, decision: "approve" }),
    ).rejects.toMatchObject({ code: "handler_ambiguous", status: 422 })
    expect(await statusOf(id)).toBe("approving")
    // The row is HELD, not decided — so no approval-decision message. But the approver must
    // SEE why their click did nothing (the silent wedge was a real prod UX bug), so exactly
    // one informational approval-error notice is posted to the thread.
    const decisionRows =
      await sql`SELECT id FROM kernel.messages WHERE org_id = ${ORG} AND metadata->>'type' = 'approval-decision'`
    expect(decisionRows.length).toBe(0)
    const errorRows =
      await sql`SELECT metadata FROM kernel.messages WHERE org_id = ${ORG} AND metadata->>'type' = 'approval-error'`
    expect(errorRows.length).toBe(1)
  })

  it("logs an ambiguous outcome at WARN, not ERROR (designed-recoverable, auto-heals — no page)", async () => {
    // Regression (prod alert-noise fix): the ambiguous outcome was logged at error(50) and paged,
    // but it is parked at `approving` and auto-heals after the grace window, so it must be warn(40).
    await grantScopes(["decide_test:gated:write", "decide_test:approve"])
    const warnSpy = spyOn(appsLogger, "warn")
    const errorSpy = spyOn(appsLogger, "error")
    warnSpy.mockClear()
    errorSpy.mockClear()
    try {
      const id = await createRequest("ambiguous")
      await expect(
        decideApproval({ orgId: ORG, requestId: id, actor, decision: "approve" }),
      ).rejects.toMatchObject({ code: "handler_ambiguous", status: 422 })
      const warnedAmbiguous = warnSpy.mock.calls.some((c) =>
        String(c[1] ?? "").includes("Handler ambiguous outcome"),
      )
      const erroredAmbiguous = errorSpy.mock.calls.some((c) =>
        String(c[1] ?? "").includes("Handler ambiguous outcome"),
      )
      expect(warnedAmbiguous).toBe(true)
      expect(erroredAmbiguous).toBe(false)
    } finally {
      warnSpy.mockRestore()
      errorSpy.mockRestore()
    }
  })

  it("logs an ERROR only when a wedged approving row fails to heal past the grace window", async () => {
    // The genuinely-stuck case (durable started/ambiguous protocol row, still wedged past the grace
    // window) SHOULD escalate to error(50) for manual reconciliation — distinct from the transient
    // ambiguous outcome above which is only warn.
    await grantScopes(["decide_test:gated:write", "decide_test:approve"])
    const id = await createRequest("ambiguous")
    await expect(
      decideApproval({ orgId: ORG, requestId: id, actor, decision: "approve" }),
    ).rejects.toMatchObject({ code: "handler_ambiguous" })
    // Age it past the grace window so healWedgedApproving sees it as stuck-not-healable.
    await sql`UPDATE kernel.approval_requests SET approving_started_at = now() - interval '11 minutes' WHERE id = ${id}`
    const errorSpy = spyOn(appsLogger, "error")
    errorSpy.mockClear()
    try {
      // A fresh decide runs healWedgedApproving; the ambiguous protocol row keeps
      // it !healable. The rejection is the ACTIONABLE code, not a bare
      // already_decided (see the escape-hatch tests below).
      await expect(
        decideApproval({ orgId: ORG, requestId: id, actor, decision: "approve" }),
      ).rejects.toMatchObject({ code: "execution_outcome_unknown" })
      const erroredWedged = errorSpy.mock.calls.some((c) =>
        String(c[1] ?? "").includes("wedged at approving past grace window"),
      )
      expect(erroredWedged).toBe(true)
    } finally {
      errorSpy.mockRestore()
    }
  })

  it("decide treats started-only handler return as ambiguous and the reaper leaves it alone", async () => {
    await grantScopes(["decide_test:gated:write", "decide_test:approve"])
    const id = await createRequest("startedOnly")
    await expect(
      decideApproval({ orgId: ORG, requestId: id, actor, decision: "approve" }),
    ).rejects.toMatchObject({
      code: "handler_ambiguous",
      details: { details: { status: "started" } },
    })
    await sql`UPDATE kernel.approval_requests SET approving_started_at = now() - interval '11 minutes' WHERE id = ${id}`
    await runApprovingReaper()
    expect(await statusOf(id)).toBe("approving")
  })

  // ── healWedgedApproving: recover rows stuck at `approving` on an explicit decide ──
  // The claim pending→approving commits BEFORE the handler runs; a handler death that maps
  // to no revert leaves the row wedged (hidden from the list, "pending" via status, every
  // decide 409s). An explicit human decide may heal PROVABLY-SAFE wedges and proceed.

  it("heals a stale wedge with NO handler record on approve (human re-decide = consent to run)", async () => {
    await grantScopes(["decide_test:gated:write", "decide_test:approve"])
    const id = await createRequest("gatedEcho")
    // Wedge it: claim committed, handler died before recording anything, grace elapsed.
    await sql`UPDATE kernel.approval_requests
      SET status = 'approving', decided_by = ${USER}, decided_at = now(),
          approving_started_at = now() - interval '11 minutes'
      WHERE id = ${id}`
    const result = await decideApproval({ orgId: ORG, requestId: id, actor, decision: "approve" })
    expect(result.status).toBe("approved")
    expect(await statusOf(id)).toBe("approved")
  })

  it("does NOT heal a FRESH wedge with no handler record (a live execution may still be running)", async () => {
    await grantScopes(["decide_test:gated:write", "decide_test:approve"])
    const id = await createRequest("gatedEcho")
    await sql`UPDATE kernel.approval_requests
      SET status = 'approving', decided_by = ${USER}, decided_at = now(), approving_started_at = now()
      WHERE id = ${id}`
    await expect(
      decideApproval({ orgId: ORG, requestId: id, actor, decision: "approve" }),
    ).rejects.toBeInstanceOf(AlreadyDecidedError)
    expect(await statusOf(id)).toBe("approving")
  })

  it("does NOT heal an ambiguous-recorded wedge even when stale, and says so ACTIONABLY", async () => {
    await grantScopes(["decide_test:gated:write", "decide_test:approve"])
    const id = await createRequest("ambiguous")
    await expect(
      decideApproval({ orgId: ORG, requestId: id, actor, decision: "approve" }),
    ).rejects.toMatchObject({ code: "handler_ambiguous" })
    await sql`UPDATE kernel.approval_requests SET approving_started_at = now() - interval '11 minutes' WHERE id = ${id}`
    // Refusing to re-run is right (the effect may have landed). Reporting it as a
    // bare already_decided was not: it reads as a dead button, which is why the
    // same request got clicked over and over for weeks (ticket-10197/10200).
    await expect(
      decideApproval({ orgId: ORG, requestId: id, actor, decision: "approve" }),
    ).rejects.toMatchObject({ code: "execution_outcome_unknown" })
    expect(await statusOf(id)).toBe("approving")
  })

  // ── The ESCAPE HATCH ──────────────────────────────────────────────────────
  // A wedge that no human can clear is the actual defect behind ticket-10197 /
  // ticket-10200: Approve refuses (may double-send), Reject 409'd on
  // `from: pending`, and the reaper leaves it alone. Three prod rows, one of
  // them stuck 22 days. Denying runs NOTHING, so it must always work.
  it("DENY terminates a wedged ambiguous row that approve refuses to touch", async () => {
    await grantScopes(["decide_test:gated:write", "decide_test:approve"])
    const id = await createRequest("ambiguous")
    await expect(
      decideApproval({ orgId: ORG, requestId: id, actor, decision: "approve" }),
    ).rejects.toMatchObject({ code: "handler_ambiguous" })
    await sql`UPDATE kernel.approval_requests SET approving_started_at = now() - interval '11 minutes' WHERE id = ${id}`
    const result = await decideApproval({
      orgId: ORG,
      requestId: id,
      actor,
      decision: "deny",
      reason: "closing out a stuck request",
    })
    expect(result.status).toBe("denied")
    expect(await statusOf(id)).toBe("denied")
    // The audit trail must keep the truth: this was denied while its outcome was
    // unknown, so nobody later reads it as proof the action never ran.
    const [row] = await sql`SELECT metadata FROM kernel.approval_requests WHERE id = ${id}`
    expect((row as { metadata: Record<string, unknown> }).metadata.deniedWhileWedged).toBeTruthy()
  })

  it("DENY terminates a wedged row whose handler recorded `started` (the 22-day prod row)", async () => {
    await grantScopes(["decide_test:gated:write", "decide_test:approve"])
    const id = await createRequest("gatedEcho")
    await sql`UPDATE kernel.approval_requests
      SET status = 'approving', decided_by = ${USER}, decided_at = now(),
          approving_started_at = now() - interval '11 minutes'
      WHERE id = ${id}`
    await sql`INSERT INTO kernel.approved_handler_executions
        (org_id, approval_request_id, tool_name, status, actor_id, attempts, last_attempt_at)
      VALUES (${ORG}, ${id}, 'decide_test:gatedEcho', 'started', ${USER}, 1, now())`
    const result = await decideApproval({ orgId: ORG, requestId: id, actor, decision: "deny" })
    expect(result.status).toBe("denied")
    expect(await statusOf(id)).toBe("denied")
  })

  it("a FRESH approving row is still protected from deny (a live execution is not a wedge)", async () => {
    // The escape hatch must not become a way to yank a running execution out
    // from under itself: only a claim past the grace window counts as wedged.
    await grantScopes(["decide_test:gated:write", "decide_test:approve"])
    const id = await createRequest("gatedEcho")
    await sql`UPDATE kernel.approval_requests
      SET status = 'approving', decided_by = ${USER}, decided_at = now(), approving_started_at = now()
      WHERE id = ${id}`
    await expect(
      decideApproval({ orgId: ORG, requestId: id, actor, decision: "deny" }),
    ).rejects.toBeInstanceOf(AlreadyDecidedError)
    expect(await statusOf(id)).toBe("approving")
  })

  it("heals a failed_no_effect wedge immediately (any age) and the re-approve executes", async () => {
    await grantScopes(["decide_test:gated:write", "decide_test:approve"])
    const id = await createRequest("gatedEcho")
    // Simulate a prior attempt that durably proved no effect but whose revert never ran.
    await withPrivilegedDb(ORG, "test-wedge-setup", async (tx) => {
      const ctx = {
        orgId: ORG,
        approvalRequestId: id,
        approvalDeciderId: USER,
        toolName: "decide_test:gatedEcho",
      }
      await recordStarted(tx, ctx, "decide_test:gatedEcho")
      await recordFailedNoEffect(tx, ctx, "decide_test:gatedEcho", { code: "MISSING_BUYER_EMAIL" })
    })
    await sql`UPDATE kernel.approval_requests
      SET status = 'approving', decided_by = ${USER}, decided_at = now(), approving_started_at = now()
      WHERE id = ${id}`
    const result = await decideApproval({ orgId: ORG, requestId: id, actor, decision: "approve" })
    expect(result.status).toBe("approved")
    expect(await statusOf(id)).toBe("approved")
  })

  it("heals a stale no-record wedge on DENY too (withdraw a wedged request)", async () => {
    await grantScopes(["decide_test:gated:write", "decide_test:approve"])
    const id = await createRequest("gatedEcho")
    await sql`UPDATE kernel.approval_requests
      SET status = 'approving', decided_by = ${USER}, decided_at = now(),
          approving_started_at = now() - interval '11 minutes'
      WHERE id = ${id}`
    const result = await decideApproval({
      orgId: ORG,
      requestId: id,
      actor,
      decision: "deny",
      reason: "stuck",
    })
    expect(result.status).toBe("denied")
    expect(await statusOf(id)).toBe("denied")
  })

  // ── The wedge SOURCE (ticket-10197 / ticket-10200) ─────────────────────────
  //
  // Three prod rows sat at `approving` unable to be decided by anyone. Two were
  // knowledge:create -- a DB-only tool -- failing on entirely ordinary things: a
  // sensitivity-grant 403, and a collection id passed as a name so the uuid cast
  // threw. Neither touched anything. But "no protocol row + threw" was classified
  // AMBIGUOUS for every tool, and ambiguous is a one-way door: nothing heals it and
  // every later decide 409s. An input typo permanently jammed an approval.
  describe("handler outcome classification by declared impact", () => {
    it.each([
      ["internal", "internalThrows"],
      ["external", "externalThrows"],
    ])("a %s-impact tool that throws with no protocol row", async (impact, tool) => {
      await grantScopes(["decide_test:gated:write", "decide_test:approve"])
      const id = await createRequest(tool)
      const err = await decideApproval({
        orgId: ORG,
        requestId: id,
        actor,
        decision: "approve",
      }).catch((e) => e)

      if (impact === "internal") {
        // Provably no effect: an ordinary retryable failure. The row goes back to
        // pending so the operator can fix the input and approve again, and the
        // real cause reaches the card instead of "ambiguous outcome".
        expect(err).toMatchObject({ code: "handler_failed" })
        expect(await statusOf(id)).toBe("pending")
        const [exec] = await sql`SELECT status, error FROM kernel.approved_handler_executions
          WHERE approval_request_id = ${id}`
        expect((exec as { status: string }).status).toBe("failed_no_effect")
        // The card carries the caller-safe text, never the failed SQL (the full error is logged).
        const stored = JSON.stringify((exec as { error: unknown }).error)
        expect(stored).toContain("failed on a database error and did not take effect")
        expect(stored).not.toContain("Failed query")
      } else {
        // Genuinely unknown: still parked, deliberately.
        expect(err).toMatchObject({ code: "handler_ambiguous" })
        expect(await statusOf(id)).toBe("approving")
      }
    })

    it("an internal-impact failure can be re-approved once the input is fixed -- no wedge", async () => {
      // The whole point: the operator is never stuck. Pre-fix this row was
      // undecidable forever after the first bad attempt.
      await grantScopes(["decide_test:gated:write", "decide_test:approve"])
      const id = await createRequest("internalThrows")
      await expect(
        decideApproval({ orgId: ORG, requestId: id, actor, decision: "approve" }),
      ).rejects.toMatchObject({ code: "handler_failed" })
      // Immediately, with no grace window to wait out: the row is pending again.
      expect(await statusOf(id)).toBe("pending")
      // And a deny closes it out cleanly through the ordinary path.
      const result = await decideApproval({ orgId: ORG, requestId: id, actor, decision: "deny" })
      expect(result.status).toBe("denied")
    })
  })

  // ── A handler cut off after its external effect landed ─────────────────────
  // 2026-10-08: Gmail accepted a mail:compose, then the sandbox ceiling fired
  // while the handler persisted its sent copy. The row stayed `started`, the
  // approval parked as unknown, and the only way out was closing it as stale.
  describe("a handler interrupted after or before its external effect", () => {
    it("landed then cut off -> approved and executed with the ref, never re-run", async () => {
      await grantScopes(["decide_test:gated:write", "decide_test:approve"])
      providerSends = 0
      const id = await createRequest("landedThenCutOff")
      const result = await decideApproval({ orgId: ORG, requestId: id, actor, decision: "approve" })
      expect(result.status).toBe("approved")
      expect(await statusOf(id)).toBe("approved")
      const [exec] = await sql`SELECT status, external_ref, result
        FROM kernel.approved_handler_executions WHERE approval_request_id = ${id}`
      expect(exec).toMatchObject({ status: "succeeded", external_ref: SENT_REF, result: SENT_REF })
      // The thread says it ran, like any approval.
      const [notice] = await sql`SELECT content FROM kernel.messages
        WHERE org_id = ${ORG} AND content LIKE 'Approved by%' ORDER BY created_at DESC LIMIT 1`
      expect(notice).toBeTruthy()
      // A second click, or the reaper, never sends again.
      await expect(
        decideApproval({ orgId: ORG, requestId: id, actor, decision: "approve" }),
      ).rejects.toBeInstanceOf(AlreadyDecidedError)
      await runApprovingReaper()
      expect(providerSends).toBe(1)
    })

    it("cut off before recording a landed effect -> ambiguous with the error, not left started", async () => {
      await grantScopes(["decide_test:gated:write", "decide_test:approve"])
      const id = await createRequest("cutOffBeforeLanded")
      await expect(
        decideApproval({ orgId: ORG, requestId: id, actor, decision: "approve" }),
      ).rejects.toMatchObject({ code: "handler_ambiguous" })
      expect(await statusOf(id)).toBe("approving")
      const [exec] = await sql`SELECT status, error
        FROM kernel.approved_handler_executions WHERE approval_request_id = ${id}`
      expect((exec as { status: string }).status).toBe("ambiguous")
      expect(JSON.stringify((exec as { error: unknown }).error)).toContain("timed out")
    })

    it("the reaper promotes a landed effect recorded after the run was classified ambiguous", async () => {
      // The landed write can reach the database after the host classified the cut-off
      // run (it was still in flight on the bridge). The reaper settles it as a success.
      await grantScopes(["decide_test:gated:write", "decide_test:approve"])
      const id = await createRequest("gatedEcho")
      await sql`UPDATE kernel.approval_requests
        SET status = 'approving', decided_by = ${USER}, decided_at = now(),
            approving_started_at = now() - make_interval(secs => ${APPROVING_WEDGE_GRACE_MS / 1000 + 60})
        WHERE id = ${id}`
      const c = {
        orgId: ORG,
        approvalRequestId: id,
        approvalDeciderId: USER,
        toolName: "decide_test:gatedEcho",
      }
      await withPrivilegedDb(ORG, "test-late-landed", async (tx) => {
        await recordStarted(tx, c, c.toolName)
        await recordAmbiguous(tx, c, c.toolName, { code: "handler_outcome_unknown" })
        await recordEffectLanded(tx, c, c.toolName, SENT_REF)
      })
      await runApprovingReaper()
      expect(await statusOf(id)).toBe("approved")
    })
  })

  // ── The stale grace window, shared with the approval card ──────────────────
  it("accepts the stale-request deny exactly past APPROVING_WEDGE_GRACE_MS", async () => {
    await grantScopes(["decide_test:gated:write", "decide_test:approve"])
    const id = await createRequest("ambiguous")
    await expect(
      decideApproval({ orgId: ORG, requestId: id, actor, decision: "approve" }),
    ).rejects.toMatchObject({ code: "handler_ambiguous" })
    const ageBy = (secs: number) => sql`UPDATE kernel.approval_requests
      SET approving_started_at = now() - make_interval(secs => ${secs}) WHERE id = ${id}`
    await ageBy(APPROVING_WEDGE_GRACE_MS / 1000 - 60)
    await expect(
      decideApproval({ orgId: ORG, requestId: id, actor, decision: "deny" }),
    ).rejects.toBeInstanceOf(AlreadyDecidedError)
    await ageBy(APPROVING_WEDGE_GRACE_MS / 1000 + 60)
    const result = await decideApproval({ orgId: ORG, requestId: id, actor, decision: "deny" })
    expect(result.status).toBe("denied")
  })
})
