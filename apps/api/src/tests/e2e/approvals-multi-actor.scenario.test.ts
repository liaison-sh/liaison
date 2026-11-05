// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { MODEL_PRICING_SEED } from "@liaison/shared"
import type { TestWorld, WorkerEnv } from "@liaison/test-helpers"
import { allocatePorts, api, connectWs, createUserWithScopes } from "@liaison/test-helpers"
import {
  createFreshThread,
  createGatedRequest,
  dbCountSystemMessages,
  dbExistsThreadReference,
  dbFetchApproval,
  dbFetchHandlerExecution,
  dbFetchSystemMessages,
  dbFetchThreadParticipants,
  decide,
  editPayload,
  enqueueKernelJobNow,
  getApproval,
  ks,
  pollUntil,
  scanWindowForApprovalEvent,
  snapshotMessageCount,
  triggerGatedEcho,
  waitForApprovalEditEvent,
  waitForApprovalEditMessage,
  waitForApprovalEvent,
  waitForSystemMessageEvent,
} from "./helpers/approvals"
import { LIVE_LLM } from "./helpers/live-llm"
import {
  queryConversations,
  queryMessages,
  seedConversation,
  seedMessage,
} from "./helpers/mail-seed"
import { startMockOidc } from "./helpers/mock-oidc"
import { setupScenario, teardownScenario } from "./setup"

// ─── SSE helpers (localized from agent-runtime.scenario.test.ts) ───────

interface SseEvent {
  event: string
  data: unknown
}

function parseSseEvents(body: string): SseEvent[] {
  const events: SseEvent[] = []
  const blocks = body.split("\n\n").filter((b) => b.trim())
  for (const block of blocks) {
    const lines = block.split("\n")
    let event = "message"
    let dataStr = ""
    for (const line of lines) {
      if (line.startsWith("event: ")) event = line.slice(7).trim()
      else if (line.startsWith("data: ")) dataStr = line.slice(6).trim()
    }
    try {
      events.push({ event, data: JSON.parse(dataStr) })
    } catch {
      events.push({ event, data: dataStr })
    }
  }
  return events
}

async function consumeSse(
  url: string,
  path: string,
  token: string,
  body: Record<string, unknown>,
): Promise<{ status: number; events: SseEvent[]; rawBody: string }> {
  const res = await fetch(`${url}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  })
  const rawBody = await res.text()
  if (!res.headers.get("content-type")?.includes("text/event-stream")) {
    return { status: res.status, events: [], rawBody }
  }
  return { status: res.status, events: parseSseEvents(rawBody), rawBody }
}

async function seedAgentThread(
  sql: any,
  schema: string,
  orgId: string,
  userId: string,
): Promise<string> {
  const threadId = crypto.randomUUID()
  await sql.unsafe(
    `INSERT INTO ${schema}.threads (id, org_id, handle, type, created_by) VALUES ($1, $2, $3, 'agent_chat', $4)`,
    [threadId, orgId, `agent-${threadId.slice(0, 8)}`, userId],
  )
  await sql.unsafe(
    `INSERT INTO ${schema}.thread_participants (thread_id, user_id, org_id) VALUES ($1, $2, $3)`,
    [threadId, userId, orgId],
  )
  return threadId
}

// Auto-mode resolves to the cheapest auto-eligible model (gemini-flash-lite
// per MODEL_PRICING_SEED). Never hardcode an expensive Anthropic model in E2E
// — per `apps/web/src/tests/e2e/CLAUDE.md` and project policy.
const TOOL_MODEL: string | null = null

// ═══════════════════════════════════════════════════════════════════════
//  Approvals Multi-Actor Scenario (Phase 6.2)
// ═══════════════════════════════════════════════════════════════════════

describe("Approvals Multi-Actor Scenario", () => {
  let env: WorkerEnv
  let world: TestWorld
  let url: string
  let kernelSchema: string

  // Actors — see plan §Actors. Created once; never mutated mid-scenario.
  let requester: { id: string; email: string; token: string; name: string }
  let approver: { id: string; email: string; token: string; name: string }
  let outsider: { id: string; email: string; token: string; name: string }
  let agentRequester: { id: string; email: string; token: string; name: string }

  beforeAll(async () => {
    const result = await setupScenario({
      seed: 81,
      org: { name: "Approvals Multi-Actor E2E Org" },
      populate: {
        users: { count: 10 },
        threads: { count: 20, participants: "random(2-4)", messages: "random(1-3)" },
      },
    })
    env = result.env
    world = result.world
    url = env.serverUrl
    kernelSchema = ks(env)

    // Seed model pricing + credit balance — needed by agent SSE in S-CT-7.
    for (const m of MODEL_PRICING_SEED) {
      await env.db.sql.unsafe(
        `INSERT INTO ${kernelSchema}.model_pricing (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (provider, model_id) DO NOTHING`,
        [
          m.provider,
          m.modelId,
          m.displayName,
          m.inputCostPerM,
          m.outputCostPerM,
          m.contextWindow,
          m.autoEligible,
          m.tierMinimum,
          m.source,
        ],
      )
    }
    await env.db.sql.unsafe(
      `INSERT INTO ${kernelSchema}.credit_balances (org_id, included_balance, purchased_balance, currency)
       VALUES ($1, '50.00000000', '50.00000000', 'EUR')
       ON CONFLICT (org_id) DO UPDATE SET included_balance = '50.00000000', purchased_balance = '50.00000000'`,
      [world.org.id],
    )

    requester = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
      scopes: [
        "test:gated:write",
        "kernel:threads",
        "kernel:threads:read",
        "kernel:threads:write",
        "kernel:approvals:read",
        "kernel:approvals:write",
      ],
      dimensions: { "*": ["*"] },
      schemaPrefix: env.schemaPrefix,
    })
    approver = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
      scopes: [
        "test:approve",
        "test:gated:write",
        "kernel:threads",
        "kernel:threads:read",
        "kernel:threads:write",
        "kernel:approvals:read",
        "kernel:approvals:write",
      ],
      dimensions: { "*": ["*"] },
      schemaPrefix: env.schemaPrefix,
    })
    outsider = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
      scopes: [
        "kernel:threads",
        "kernel:threads:read",
        "kernel:threads:write",
        "kernel:approvals:read",
      ],
      dimensions: { "*": ["*"] },
      schemaPrefix: env.schemaPrefix,
    })
    agentRequester = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
      scopes: [
        "test:gated:write",
        "kernel:threads",
        "kernel:threads:read",
        "kernel:threads:write",
        "kernel:approvals:read",
        "kernel:approvals:write",
      ],
      dimensions: { "*": ["*"] },
      schemaPrefix: env.schemaPrefix,
    })
  }, 180_000)

  afterAll(async () => {
    await teardownScenario(env, world)
  }, 30_000)

  // ─── S-CT-1 — Cross-thread create + WS filter + detail parity ─────
  it("S-CT-1: create surfaces on the originating thread and stays there", async () => {
    const tOrig = await createFreshThread(url, requester.token, requester.id, "S-CT-1 origin")

    const wsRequester = await connectWs(url, requester.token)
    const wsApprover = await connectWs(url, approver.token)
    const wsOutsider = await connectWs(url, outsider.token)
    await Bun.sleep(150)

    try {
      const outsiderBaseline = snapshotMessageCount(wsOutsider)

      const { res, requestId, blocked } = await triggerGatedEcho(
        url,
        requester.token,
        tOrig,
        "ct-create",
      )
      expect(res.status).toBe(200)
      expect(blocked.reason).toBe("gated")
      expect(typeof blocked.approvalRequestId).toBe("string")
      expect(blocked.summary).toBeDefined()

      const reqEvt = await waitForApprovalEvent(wsRequester, "create", requestId)
      const apEvt = await waitForApprovalEvent(wsApprover, "create", requestId)

      const row = await dbFetchApproval(env, requestId)
      expect(row.status).toBe("pending")
      expect(row.originating_thread_id).toBe(tOrig)
      // An approval has no discussion thread of its own: it lives on the
      // thread it was raised from, for its whole life.
      expect(row.thread_id).toBe(tOrig)
      // Snapshot starts with the requester; world admin's `*` scope also matches
      // `<app>:approve`, so the membership check is "requester first + approver present".
      expect(row.notify_user_ids[0]).toBe(requester.id)
      expect(row.notify_user_ids).toContain(approver.id)
      expect(row.current_payload).toEqual({ message: "ct-create" })

      // approval-created posted once, on the originating thread only.
      expect(await dbCountSystemMessages(env, tOrig, "approval-created")).toBe(1)

      // Detail parity — Requester + Approver get same shape as the WS data.
      const reqDetail = await getApproval(url, requester.token, requestId)
      expect(reqDetail.status).toBe(200)
      const apDetail = await getApproval(url, approver.token, requestId)
      expect(apDetail.status).toBe(200)

      const wsCreateData = reqEvt.payload.data
      expect(reqDetail.body.data).toMatchObject({
        id: requestId,
        currentPayload: { message: "ct-create" },
        threadId: tOrig,
        originatingThreadId: tOrig,
        lastEdit: null,
      })
      expect(reqDetail.body.data.notifyUserIds).toEqual(row.notify_user_ids)
      expect(reqDetail.body.data.requestedBy.id).toBe(requester.id)
      expect(Array.isArray(reqDetail.body.data.editableFields)).toBe(true)
      // WS create event carries the same summary shape.
      expect(wsCreateData.id).toBe(requestId)
      expect(wsCreateData.notifyUserIds).toEqual(row.notify_user_ids)
      expect(wsCreateData.lastEdit).toBeNull()
      expect(wsCreateData.threadId).toBe(tOrig)
      expect(wsCreateData.originatingThreadId).toBe(tOrig)
      expect(apEvt.payload.data.id).toBe(requestId)

      // No thread_reference row is written any more: the reference existed only
      // to point the originating thread at a separate discussion thread. What
      // the originating thread carries now is the approval itself (the
      // `approval-created` anchor message counted above) and nothing else.
      expect(await dbExistsThreadReference(env, tOrig, requestId)).toBe(false)

      // Outsider — 404 detail, zero events for this request id.
      const outDetail = await getApproval(url, outsider.token, requestId)
      expect(outDetail.status).toBe(404)
      const stray = await scanWindowForApprovalEvent(wsOutsider, outsiderBaseline, requestId, 1500)
      expect(stray).toBeNull()
    } finally {
      wsRequester.close()
      wsApprover.close()
      wsOutsider.close()
    }
  }, 60_000)

  // ─── S-CT-2 — Payload edit posts diff to discussion only ─────────
  it("S-CT-2: payload edit posts its diff on the approval thread", async () => {
    const tOrig = await createFreshThread(url, requester.token, requester.id, "S-CT-2 origin")
    const { requestId, row } = await createGatedRequest({
      url,
      env,
      requesterToken: requester.token,
      originatingThreadId: tOrig,
      message: "before-edit",
    })
    expect(row.thread_id).toBe(tOrig)

    const wsRequester = await connectWs(url, requester.token)
    const wsApprover = await connectWs(url, approver.token)
    const wsOutsider = await connectWs(url, outsider.token)
    await Bun.sleep(150)
    try {
      const outsiderBaseline = snapshotMessageCount(wsOutsider)

      const editRes = await editPayload(url, approver.token, requestId, { message: "after-edit" })
      expect(editRes.status).toBe(200)
      expect(editRes.body.data.id).toBe(requestId)
      expect(editRes.body.data.currentPayload).toEqual({ message: "after-edit" })
      expect(editRes.body.data.lastEdit.editorUserId).toBe(approver.id)
      expect(editRes.body.data.lastEdit.diff).toEqual([
        { field: "message", from: "before-edit", to: "after-edit" },
      ])

      // Matched on `lastEdit` presence, not just "update": a non-edit update
      // event (lastEdit: null) may still be in flight/buffered from setup and
      // must not satisfy this wait.
      const reqUpdate = await waitForApprovalEditEvent(wsRequester, requestId)
      const apUpdate = await waitForApprovalEditEvent(wsApprover, requestId)
      expect(reqUpdate.payload.data.currentPayload).toEqual({ message: "after-edit" })
      expect(reqUpdate.payload.data.lastEdit.editorUserId).toBe(approver.id)
      expect(reqUpdate.payload.data.notifyUserIds).toContain(requester.id)
      expect(reqUpdate.payload.data.notifyUserIds).toContain(approver.id)
      expect(apUpdate.payload.data.lastEdit.diff[0]).toEqual({
        field: "message",
        from: "before-edit",
        to: "after-edit",
      })

      // The payload-edit message lands on the approval's thread, exactly once.
      // Waited for on the REQUESTER's socket: they are the participant of the
      // originating thread, so message events on it are theirs. What the
      // approver is entitled to is the approval_request update carrying the
      // diff, asserted above (`apUpdate`), plus the row in their approvals
      // feed. There is no thread they share with the requester here, and an
      // approval no longer invents one.
      await waitForApprovalEditMessage(wsRequester, tOrig, requestId)
      const dbRow = await dbFetchApproval(env, requestId)
      expect(dbRow.current_payload).toEqual({ message: "after-edit" })
      expect(await dbCountSystemMessages(env, tOrig, "payload-edit")).toBe(1)

      // Outsider — zero events in post-edit window.
      const stray = await scanWindowForApprovalEvent(wsOutsider, outsiderBaseline, requestId, 1500)
      expect(stray).toBeNull()
    } finally {
      wsRequester.close()
      wsApprover.close()
      wsOutsider.close()
    }
  }, 60_000)

  // ─── S-CT-3: approve runs the handler and posts the decision ───
  it("S-CT-3: approve runs the handler and posts the decision", async () => {
    const tOrig = await createFreshThread(url, requester.token, requester.id, "S-CT-3 origin")
    const { requestId, row } = await createGatedRequest({
      url,
      env,
      requesterToken: requester.token,
      originatingThreadId: tOrig,
      message: "approve-me",
    })
    expect(row.thread_id).toBe(tOrig)

    const wsRequester = await connectWs(url, requester.token)
    const wsApprover = await connectWs(url, approver.token)
    await Bun.sleep(150)
    try {
      const decided = await decide(url, approver.token, requestId, { decision: "approve" })
      expect(decided.status).toBe(200)
      expect(decided.body.data.status).toBe("approved")
      expect(decided.body.data.decidedBy).toBe(approver.id)

      const finalRow = await pollUntil(async () => {
        const r = await dbFetchApproval(env, requestId)
        return r?.status === "approved" ? r : null
      })
      expect(finalRow.approving_started_at).toBeNull()

      const exec = await dbFetchHandlerExecution(env, requestId, "test:gatedEcho")
      expect(exec).toBeDefined()
      expect(exec.status).toBe("succeeded")
      expect(exec.actor_id).toBe(approver.id)
      expect(exec.external_ref).toEqual({ synthetic: true })

      await waitForApprovalEvent(wsRequester, "update", requestId, "approved")
      await waitForApprovalEvent(wsApprover, "update", requestId, "approved")

      // The decision post reaches the ORIGINATING thread's participant (the
      // requester). The approver, who is on no thread here, learns the outcome
      // from the approval_request update event awaited just above.
      await waitForSystemMessageEvent(wsRequester, tOrig, "approval-decision")

      const origMsgs = await dbFetchSystemMessages(env, tOrig, "approval-decision")
      expect(origMsgs).toHaveLength(1)
      expect(origMsgs[0].metadata.decision).toBe("approved")
      expect(origMsgs[0].metadata.actorId).toBe(approver.id)
    } finally {
      wsRequester.close()
      wsApprover.close()
    }
  }, 60_000)

  // ─── S-CT-4: deny posts the decision and remains private ───
  it("S-CT-4: deny posts the decision and stays private", async () => {
    const tOrig = await createFreshThread(url, requester.token, requester.id, "S-CT-4 origin")
    const { requestId, row } = await createGatedRequest({
      url,
      env,
      requesterToken: requester.token,
      originatingThreadId: tOrig,
      message: "deny-me",
    })
    expect(row.thread_id).toBe(tOrig)

    const wsRequester = await connectWs(url, requester.token)
    const wsApprover = await connectWs(url, approver.token)
    const wsOutsider = await connectWs(url, outsider.token)
    await Bun.sleep(150)
    try {
      const outsiderBaseline = snapshotMessageCount(wsOutsider)

      // Per the existing decide.ts contract, only the requester can deny.
      const decided = await decide(url, requester.token, requestId, {
        decision: "deny",
        reason: "not-now",
      })
      expect(decided.status).toBe(200)
      expect(decided.body.data.status).toBe("denied")
      expect(decided.body.data.reason).toBe("not-now")
      expect(decided.body.data.decidedBy).toBe(requester.id)

      await waitForApprovalEvent(wsRequester, "update", requestId, "denied")
      await waitForApprovalEvent(wsApprover, "update", requestId, "denied")

      // The decision post reaches the ORIGINATING thread's participant (the
      // requester). The approver, who is on no thread here, learns the outcome
      // from the approval_request update event awaited just above.
      await waitForSystemMessageEvent(wsRequester, tOrig, "approval-decision")

      const origMsgs = await dbFetchSystemMessages(env, tOrig, "approval-decision")
      expect(origMsgs).toHaveLength(1)
      expect(origMsgs[0].metadata.decision).toBe("denied")
      expect(origMsgs[0].metadata.reason).toBe("not-now")

      const stray = await scanWindowForApprovalEvent(wsOutsider, outsiderBaseline, requestId, 1500)
      expect(stray).toBeNull()
    } finally {
      wsRequester.close()
      wsApprover.close()
      wsOutsider.close()
    }
  }, 60_000)

  // ─── S-CT-5: the expiry worker posts the decision ───────────────
  it("S-CT-5: the expiry worker posts the decision", async () => {
    const tOrig = await createFreshThread(url, requester.token, requester.id, "S-CT-5 origin")
    const { requestId, row } = await createGatedRequest({
      url,
      env,
      requesterToken: requester.token,
      originatingThreadId: tOrig,
      message: "expire-me",
    })
    expect(row.thread_id).toBe(tOrig)

    const wsRequester = await connectWs(url, requester.token)
    const wsApprover = await connectWs(url, approver.token)
    await Bun.sleep(150)
    try {
      await enqueueKernelJobNow(
        env,
        "approval-expiry",
        { orgId: world.org.id, requestId },
        `approval-expiry:${requestId}:e2e-ct5`,
      )

      const finalRow = await pollUntil(async () => {
        const r = await dbFetchApproval(env, requestId)
        return r?.status === "expired" ? r : null
      })
      expect(finalRow.status).toBe("expired")

      const reqUpdate = await waitForApprovalEvent(wsRequester, "update", requestId, "expired")
      const apUpdate = await waitForApprovalEvent(wsApprover, "update", requestId, "expired")
      expect(reqUpdate.payload.data.id).toBe(requestId)
      // Same ApprovalRequestSummary shape used for create/detail.
      expect(reqUpdate.payload.data.notifyUserIds).toContain(requester.id)
      expect(reqUpdate.payload.data.notifyUserIds).toContain(approver.id)
      expect(apUpdate.payload.data.threadId).toBe(tOrig)

      // The decision post reaches the ORIGINATING thread's participant (the
      // requester). The approver, who is on no thread here, learns the outcome
      // from the approval_request update event awaited just above.
      await waitForSystemMessageEvent(wsRequester, tOrig, "approval-decision")

      const origMsgs = await dbFetchSystemMessages(env, tOrig, "approval-decision")
      expect(origMsgs).toHaveLength(1)
      expect(origMsgs[0].metadata.decision).toBe("expired")
    } finally {
      wsRequester.close()
      wsApprover.close()
    }
  }, 60_000)

  // ─── S-CT-6 — WebSocket replay filters approval events ───────────
  it("S-CT-6: WS replay applies notifyUserIds filter", async () => {
    const tOrig = await createFreshThread(url, requester.token, requester.id, "S-CT-6 origin")
    const { requestId } = await createGatedRequest({
      url,
      env,
      requesterToken: requester.token,
      originatingThreadId: tOrig,
      message: "replay-test",
    })

    // Wait until the create event has been buffered by the outbox worker.
    const wsRequesterPrime = await connectWs(url, requester.token)
    try {
      await waitForApprovalEvent(wsRequesterPrime, "create", requestId)
    } finally {
      wsRequesterPrime.close()
    }

    // Open a fresh Outsider WS (lastEventId = 0, so no replay; the outsider must
    // see nothing for this approval: no live delivery and no buffered replay).
    const wsOutsider = await connectWs(url, outsider.token, 0)
    try {
      // Replay frames precede presence_sync, so any are already in the array
      // when connectWs resolves; the 1 s scan from index 0 covers them and any
      // late live delivery.
      const stray = await scanWindowForApprovalEvent(wsOutsider, 0, requestId, 1000)
      expect(stray).toBeNull()
    } finally {
      wsOutsider.close()
    }
  }, 60_000)

  // ─── S-CT-7 — Agent bridge edits payload through real SSE ────────
  // Drives a real model provider: live only (LIAISON_E2E_LIVE_LLM=1, helpers/live-llm.ts).
  it.if(LIVE_LLM)(
    "S-CT-7: agent bridge edits approval payload via SSE tool call",
    async () => {
      const tOrig = await createFreshThread(
        url,
        agentRequester.token,
        agentRequester.id,
        "S-CT-7 origin",
      )
      const { requestId } = await createGatedRequest({
        url,
        env,
        requesterToken: agentRequester.token,
        originatingThreadId: tOrig,
        message: "before-agent",
      })
      const tAgent = await seedAgentThread(
        env.db.sql,
        kernelSchema,
        world.org.id,
        agentRequester.id,
      )

      const prompt = `Use the kernel__approval_update_payload tool to set the editable field "message" to "agent-edited" on approval request ${requestId}.

The tool takes two REQUIRED parameters:
- requestId (string): "${requestId}"
- fields (object): { "message": "agent-edited" }

Call the tool now. Both requestId AND fields must be passed as arguments.`

      const { events } = await consumeSse(url, "/api/agent/chat", agentRequester.token, {
        threadId: tAgent,
        content: prompt,
        modelId: TOOL_MODEL,
      })

      // Skip gracefully on provider errors (agent-runtime convention).
      const providerErrors = events.filter(
        (e) => e.event === "error" && (e.data as any)?.code === "provider_error",
      )
      if (providerErrors.length > 0) {
        console.log("S-CT-7: provider error — skipping:", JSON.stringify(providerErrors[0].data))
        return
      }

      const toolCalls = events.filter(
        (e) =>
          e.event === "tool-call" &&
          (e.data as any)?.toolName === "kernel__approval_update_payload",
      )
      if (toolCalls.length === 0) {
        // Model didn't invoke the tool. Log the trace so the failure is diagnosable.
        console.log(
          "S-CT-7: model did not call the tool. Events:",
          JSON.stringify(events.slice(0, 50)),
        )
      }
      expect(toolCalls.length).toBeGreaterThanOrEqual(1)
      const toolCallId = (toolCalls[0].data as any).toolCallId

      const toolResults = events.filter(
        (e) => e.event === "tool-result" && (e.data as any)?.toolCallId === toolCallId,
      )
      if (toolResults.length === 0) {
        console.log(
          "S-CT-7: tool-call had no matching tool-result. Events:",
          JSON.stringify(events.slice(0, 80)),
        )
      }
      expect(toolResults.length).toBeGreaterThanOrEqual(1)
      const result = (toolResults[0].data as any).result
      expect(result.id).toBe(requestId)
      expect(result.currentPayload).toEqual({ message: "agent-edited" })
      expect(result.lastEdit?.editorUserId).toBe(agentRequester.id)

      const dbRow = await dbFetchApproval(env, requestId)
      expect(dbRow.current_payload).toEqual({ message: "agent-edited" })

      // payload-edit system message with editorUserId metadata on the approval thread.
      expect(dbRow.thread_id).toBe(tOrig)
      const editMsgs = await dbFetchSystemMessages(env, tOrig, "payload-edit")
      expect(editMsgs).toHaveLength(1)
      expect(editMsgs[0].metadata.editorUserId).toBe(agentRequester.id)
    },
    120_000,
  )
})

// ═══════════════════════════════════════════════════════════════════════
//  S-CT-8: mail reply manifest happy path
// ═══════════════════════════════════════════════════════════════════════

describe("Approvals Multi-Actor Mail Scenario", () => {
  let env: WorkerEnv
  let world: TestWorld
  let url: string
  let kernelSchema: string
  let oidc: Awaited<ReturnType<typeof startMockOidc>>
  let oidcPort: number

  let mailRequester: { id: string; email: string; token: string; name: string }
  let mailApprover: { id: string; email: string; token: string; name: string }
  let kernelAccountId: string
  let mailAccountId: string
  let conversationId: string
  let tMail: string

  function ms(): string {
    return env.schemaPrefix ? `"${env.schemaPrefix}app_mail"` : "app_mail"
  }

  async function patchOAuthState(state: string, port: number) {
    const redisPrefix = env.redisPrefix ?? ""
    const key = `${redisPrefix}oauth:state:${state}`
    const raw = await env.redis.redis.get(key)
    if (!raw) throw new Error("OAuth state not found in Redis")
    const parsed = JSON.parse(raw)
    parsed.tokenUrl = `http://localhost:${port}/token`
    const ttl = await env.redis.redis.ttl(key)
    await env.redis.redis.set(key, JSON.stringify(parsed), "EX", ttl > 0 ? ttl : 900)
  }

  async function doGmailOAuth(token: string, email: string): Promise<string> {
    const authRes = await api(url, "/api/connections/mail/gmail/authorize", {
      token,
      body: {},
    })
    expect(authRes.status).toBe(200)
    const redirectUrl = new URL(authRes.body.data.redirectUrl)
    const state = redirectUrl.searchParams.get("state")!
    await patchOAuthState(state, oidcPort)
    const callbackUri = `${url}/api/connections/callback`
    const oidcAuthUrl = `http://localhost:${oidcPort}/authorize?state=${state}&redirect_uri=${encodeURIComponent(callbackUri)}&login_hint=${encodeURIComponent(email)}`
    const oidcRes = await fetch(oidcAuthUrl, { redirect: "manual" })
    const oidcLocation = oidcRes.headers.get("location")!
    const cbUrl = new URL(oidcLocation)
    const code = cbUrl.searchParams.get("code")!
    // The callback must come from the browser that started the flow: it carries
    // the binding cookie the authorize response set.
    const cbRes = await fetch(`${url}/api/connections/callback?code=${code}&state=${state}`, {
      redirect: "manual",
      headers: { cookie: (authRes.headers.get("set-cookie") ?? "").split(";")[0] ?? "" },
    })
    expect(cbRes.status).toBe(302)

    const start = Date.now()
    while (Date.now() - start < 5000) {
      const rows = await env.db.sql.unsafe(
        `SELECT id FROM ${ms()}.accounts WHERE email_address = $1 AND sync_status != 'disconnected' ORDER BY created_at DESC LIMIT 1`,
        [email],
      )
      if (rows.length > 0) {
        const [kernelRow] = await env.db.sql.unsafe(
          `SELECT id FROM ${kernelSchema}.connected_accounts WHERE identifier = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
          [email],
        )
        return kernelRow.id
      }
      await Bun.sleep(150)
    }
    throw new Error(`Gmail account not connected within 5s: ${email}`)
  }

  async function grantInboxDimension(userId: string, accountIds: string[]) {
    const [membership] = await env.db.sql.unsafe(
      `SELECT role_id FROM ${kernelSchema}.user_roles WHERE user_id = $1 LIMIT 1`,
      [userId],
    )
    await env.db.sql.unsafe(
      `INSERT INTO ${kernelSchema}.role_dimension_grants (role_id, dimension_key, dimension_values)
       VALUES ($1, $2, $3)
       ON CONFLICT (role_id, dimension_key) DO UPDATE SET dimension_values = $3`,
      [membership.role_id, "mail:inbox", JSON.stringify(accountIds)],
    )
    await env.db.sql.unsafe(
      `UPDATE ${kernelSchema}.users SET permission_version = permission_version + 1 WHERE id = $1`,
      [userId],
    )
  }

  async function reloginUser(email: string): Promise<string> {
    const loginRes = await api(url, "/api/auth/login", {
      body: { email, password: "Pass1234!" },
    })
    return loginRes.body.data.accessToken
  }

  beforeAll(async () => {
    const result = await setupScenario({
      seed: 82,
      org: { name: "Approvals Multi-Actor Mail E2E" },
      populate: {
        users: { count: 5 },
        threads: { count: 5, participants: "random(2-3)", messages: "random(1-2)" },
      },
      serverEnv: {
        GMAIL_OAUTH_CLIENT_ID: "approvals-mail-gmail-client-id",
        GMAIL_OAUTH_CLIENT_SECRET: "approvals-mail-gmail-client-secret",
      },
    })
    env = result.env
    world = result.world
    url = env.serverUrl
    kernelSchema = ks(env)

    const [port] = await allocatePorts(1)
    oidcPort = port
    oidc = await startMockOidc(oidcPort)

    // Enable Gmail provider.
    const enableRes = await api(url, "/api/mail/providers/gmail", {
      token: world.admin.token,
      method: "PATCH",
      body: { enabled: true },
    })
    expect(enableRes.status).toBe(200)

    mailRequester = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
      scopes: [
        "mail:conversations:read",
        "mail:conversations:write",
        "mail:accounts:read",
        "mail:messages:read",
        "kernel:threads",
        "kernel:threads:read",
        "kernel:threads:write",
        "kernel:approvals:read",
        "kernel:approvals:write",
      ],
      dimensions: { "*": ["*"] },
      schemaPrefix: env.schemaPrefix,
    })
    mailApprover = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
      scopes: [
        "mail:approve",
        "mail:conversations:read",
        "mail:conversations:write",
        "mail:accounts:read",
        "mail:messages:read",
        "kernel:threads",
        "kernel:threads:read",
        "kernel:threads:write",
        "kernel:approvals:read",
        "kernel:approvals:write",
      ],
      dimensions: { "*": ["*"] },
      schemaPrefix: env.schemaPrefix,
    })

    // Connect a Gmail account for the requester via mock OIDC.
    kernelAccountId = await doGmailOAuth(mailRequester.token, "mail-requester@gmail.e2e.test")

    // Capture the app_mail.accounts row id.
    const [extRow] = await env.db.sql.unsafe(
      `SELECT id FROM ${ms()}.accounts WHERE email_address = $1 ORDER BY created_at DESC LIMIT 1`,
      ["mail-requester@gmail.e2e.test"],
    )
    mailAccountId = extRow.id

    // This scenario is the ORG-routed shape: a shared mailbox the whole team
    // answers, where a gated reply fans out to every `mail:approve` holder.
    // An OAuth-connected account lands `owner_type = 'user'`, which is the
    // PERSONAL shape, and personal-resource routing sends the approval to the
    // owner alone (resolveApprovalResourceOwner -> notify_user_ids = [owner]),
    // so no approver would ever see it. Mark the mailbox shared, which is what
    // a team mailbox really is.
    await env.db.sql.unsafe(`UPDATE ${ms()}.accounts SET visibility = 'shared' WHERE id = $1`, [
      mailAccountId,
    ])

    // Grant mail:inbox dimension for both users on the connected account, then re-login to refresh JWT claims.
    await grantInboxDimension(mailRequester.id, [kernelAccountId])
    await grantInboxDimension(mailApprover.id, [kernelAccountId])
    mailRequester.token = await reloginUser(mailRequester.email)
    mailApprover.token = await reloginUser(mailApprover.email)

    // Seed an inbound conversation + message attached to the connected account.
    const seeded = await seedConversation(env, {
      accountId: mailAccountId,
      orgId: world.org.id,
      ownerType: "user",
      ownerId: mailRequester.id,
      subject: "Customer Question",
      messageCount: 1,
    })
    conversationId = seeded.id
    await seedMessage(env, {
      conversationId,
      accountId: mailAccountId,
      orgId: world.org.id,
      ownerType: "user",
      ownerId: mailRequester.id,
      fromAddress: { name: "Cust", email: "customer@example.com" },
      toAddresses: [{ name: "Mail Requester", email: "mail-requester@gmail.e2e.test" }],
      subject: "Customer Question",
      textBody: "Can you help?",
      direction: "inbound",
      sentAt: new Date().toISOString(),
    })

    tMail = await createFreshThread(url, mailRequester.token, mailRequester.id, "Mail origin")
  }, 240_000)

  afterAll(async () => {
    if (oidc) oidc.stop()
    if (env && world) await teardownScenario(env, world)
    else if (env) await env.teardown()
  }, 30_000)

  it("S-CT-8: mail.reply create + edit + decision post on the approval thread", async () => {
    // The requester's agent proposes mail:reply (a person's own call never
    // parks an approval) — requester has no mail:approve.
    const triggerRes = await api(url, "/api/_test/agent-tool-call", {
      method: "POST",
      token: mailRequester.token,
      body: {
        toolName: "mail:reply",
        threadId: tMail,
        params: { conversationId, textBody: "reply text" },
      },
    })
    expect(triggerRes.status).toBe(200)
    const blocked = triggerRes.body.data.blocked
    expect(blocked?.reason).toBe("gated")
    const requestId = blocked.approvalRequestId
    expect(typeof requestId).toBe("string")

    const row = await dbFetchApproval(env, requestId)
    expect(row.tool_name).toBe("mail:reply")
    expect(row.originating_thread_id).toBe(tMail)
    // An approval has no discussion thread of its own: it lives on the thread
    // it was raised from.
    expect(row.thread_id).toBe(tMail)
    expect(row.notify_user_ids[0]).toBe(mailRequester.id)
    expect(row.notify_user_ids).toContain(mailApprover.id)
    expect(row.current_payload.textBody).toBe("reply text")

    const participants = await dbFetchThreadParticipants(env, tMail)
    expect(participants).toContain(mailRequester.id)
    // No thread_reference row: that pointer existed only for the separate
    // discussion thread this product no longer has.
    expect(await dbExistsThreadReference(env, tMail, requestId)).toBe(false)

    // Detail surfaces editableFields from manifest.
    const detail = await getApproval(url, mailRequester.token, requestId)
    expect(detail.status).toBe(200)
    expect(detail.body.data.editableFields).toEqual([
      { field: "textBody", label: "Body", widget: "richtext", invalidates: ["htmlBody"] },
      { field: "to", label: "To", widget: "email-list" },
      { field: "cc", label: "Cc", widget: "email-list" },
      { field: "bcc", label: "Bcc", widget: "email-list" },
    ])

    // Approver edits payload: one payload-edit message on the approval thread.
    const editRes = await editPayload(url, mailApprover.token, requestId, {
      textBody: "reply text edited",
    })
    expect(editRes.status).toBe(200)
    expect(editRes.body.data.currentPayload.textBody).toBe("reply text edited")
    expect(editRes.body.data.lastEdit.editorUserId).toBe(mailApprover.id)

    expect(await dbCountSystemMessages(env, tMail, "payload-edit")).toBe(1)

    // The approve handler would call gmail.googleapis.com/messages/send through a
    // sandboxed RPC bridge that resolves in the API-server process — outside the
    // test process, so globalThis.fetch cannot be stubbed from here. Instead,
    // exercise the decision-routing contract via the deny flow (only
    // the requester can deny per decide.ts). The handler-success path is covered
    // by the mail-agent-reply integration test where in-process fetch can be stubbed.
    const decideRes = await decide(url, mailRequester.token, requestId, {
      decision: "deny",
      reason: "rolled-up",
    })
    expect(decideRes.status).toBe(200)
    expect(decideRes.body.data.status).toBe("denied")
    expect(decideRes.body.data.decidedBy).toBe(mailRequester.id)

    const finalRow = await pollUntil(async () => {
      const r = await dbFetchApproval(env, requestId)
      return r?.status === "denied" ? r : null
    })
    expect(finalRow.reason).toBe("rolled-up")
    // Edited payload is preserved through the decision.
    expect(finalRow.current_payload.textBody).toBe("reply text edited")

    const origMsgs = await dbFetchSystemMessages(env, tMail, "approval-decision")
    expect(origMsgs).toHaveLength(1)
    expect(origMsgs[0].metadata.decision).toBe("denied")
    expect(origMsgs[0].metadata.reason).toBe("rolled-up")

    // Sanity: conversation row still exists.
    const convs = await queryConversations(env, `id = '${conversationId}'`)
    expect(convs).toHaveLength(1)
    // No outbound was created (handler never ran on deny).
    const outbound = await queryMessages(
      env,
      `conversation_id = '${conversationId}' AND direction = 'outbound'`,
    )
    expect(outbound).toHaveLength(0)
  }, 120_000)
})
