// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import type { TestWorld, WorkerEnv } from "@liaison/test-helpers"
import { connectWs, createUserWithScopes } from "@liaison/test-helpers"
import {
  dbCountOutboxEventsForRequest,
  dbCountOutboxMessageCreatesForThread,
  dbFetchApproval,
  dbFetchHandlerExecution,
  dbFetchSystemMessages,
  decide,
  enqueueKernelJobNow,
  expectNoWsEvent,
  pollUntil,
  triggerGatedEcho,
  waitForApprovalEvent,
  waitForSystemMessageEvent,
} from "./helpers/approvals"
import { setupScenario, teardownScenario } from "./setup"

describe("Approvals Scenario", () => {
  let env: WorkerEnv
  let world: TestWorld
  let url: string

  let testUser: { id: string; email: string; token: string; name: string }
  let ws: Awaited<ReturnType<typeof connectWs>>

  async function freshThread(): Promise<string> {
    const thread = await world.threads.create(testUser, {
      participantIds: [testUser.id],
      title: `Approval Scenario ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    })
    return thread.id
  }

  beforeAll(async () => {
    const result = await setupScenario({
      seed: 71,
      org: { name: "Approvals E2E Org" },
      populate: {
        users: { count: 10 },
        threads: { count: 20, participants: "random(2-4)", messages: "random(1-3)" },
      },
    })
    env = result.env
    world = result.world
    url = env.serverUrl

    // testUser is the REQUESTER (no test:approve scope) — direct UI calls
    // by an approver auto-execute past the gate, so we need a non-approver
    // to keep these tests asserting the create + decide lifecycle.
    // world.admin acts as the approver (has `*` scope, so test:approve).
    testUser = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
      scopes: [
        "kernel:threads:read",
        "kernel:threads:write",
        "kernel:threads",
        "test:gated:write",
        "kernel:approvals:read",
        "kernel:approvals:write",
      ],
      dimensions: { "*": ["*"] },
      schemaPrefix: env.schemaPrefix,
    })

    ws = await connectWs(url, testUser.token)
    // Brief settle window so the WS subscription is fully wired before the
    // first scenario starts triggering events.
    await Bun.sleep(200)
  }, 120_000)

  afterAll(async () => {
    try {
      ws?.close()
    } catch {}
    await teardownScenario(env, world)
  }, 30_000)

  // ─── S0 — Smoke: run-tool creates a pending approval ───
  it("S0: run-tool creates a pending approval and emits create event", async () => {
    const threadId = await freshThread()
    const { res, requestId, blocked } = await triggerGatedEcho(
      url,
      testUser.token,
      threadId,
      "hello from S0",
    )

    expect(res.status).toBe(200)
    expect(blocked).toBeDefined()
    expect(blocked.reason).toBe("gated")
    expect(typeof blocked.approvalRequestId).toBe("string")
    const row = await dbFetchApproval(env, requestId)
    expect(row).toBeDefined()
    expect(row.status).toBe("pending")
    expect(row.tool_name).toBe("test:gatedEcho")
    // testUser lacks test:approve, and an approval has no discussion thread:
    // the approval stays on its originating thread until an operator creates
    // one on demand.
    expect(row.originating_thread_id).toBe(threadId)
    expect(row.thread_id).toBe(threadId)
    expect(row.notify_user_ids[0]).toBe(testUser.id)
    expect(row.notify_user_ids).toContain(world.admin.id)
    expect(row.current_payload).toEqual({ message: "hello from S0" })
    expect(row.expires_at).toBeDefined()

    const evt = await waitForApprovalEvent(ws, "create", requestId)
    expect(evt.payload.data.notifyUserIds).toEqual(row.notify_user_ids)
    expect(evt.payload.data.currentPayload).toEqual({ message: "hello from S0" })
    expect(evt.payload.data.expiresAt).toBeDefined()
  }, 30_000)

  // ─── S1 — Approve lifecycle posts metadata-bearing system message ───
  it("S1: approve lifecycle terminalizes and posts system message", async () => {
    const threadId = await freshThread()
    const { requestId } = await triggerGatedEcho(url, testUser.token, threadId, "approve me")
    await waitForApprovalEvent(ws, "create", requestId)

    const decided = await decide(url, world.admin.token, requestId, { decision: "approve" })
    expect(decided.status).toBe(200)
    expect(decided.body.data.id).toBe(requestId)
    expect(decided.body.data.status).toBe("approved")
    expect(decided.body.data.decidedBy).toBe(world.admin.id)
    expect(decided.body.data.decidedAt).toBeDefined()

    const row = await pollUntil(async () => {
      const r = await dbFetchApproval(env, requestId)
      return r?.status === "approved" ? r : null
    })
    expect(row.decided_by).toBe(world.admin.id)
    expect(row.decided_at).toBeDefined()
    expect(row.approving_started_at).toBeNull()

    const exec = await dbFetchHandlerExecution(env, requestId, "test:gatedEcho")
    expect(exec).toBeDefined()
    expect(exec.status).toBe("succeeded")
    expect(exec.external_ref).toEqual({ synthetic: true })
    expect(exec.actor_id).toBe(world.admin.id)
    expect(exec.attempts).toBe(1)

    await waitForApprovalEvent(ws, "update", requestId, "approved")
    const msgEvt = await waitForSystemMessageEvent(ws, threadId, "approval-decision")
    expect(msgEvt.payload.data.metadata.decision).toBe("approved")
    // actorId is the DECIDER (world.admin), not the requester.
    expect(msgEvt.payload.data.metadata.actorId).toBe(world.admin.id)

    const sysMsgs = await dbFetchSystemMessages(env, threadId, "approval-decision")
    expect(sysMsgs.length).toBe(1)
    expect(sysMsgs[0].metadata.decision).toBe("approved")
    expect(sysMsgs[0].metadata.actorId).toBe(world.admin.id)
    expect(msgEvt.payload.data.metadata).toEqual(sysMsgs[0].metadata)
  }, 30_000)

  // ─── S2 — Deny lifecycle posts metadata-bearing system message ───
  it("S2: deny lifecycle records denial and posts system message", async () => {
    const threadId = await freshThread()
    const { requestId } = await triggerGatedEcho(url, testUser.token, threadId, "deny me")
    await waitForApprovalEvent(ws, "create", requestId)

    // Deny requires the REQUESTER (decide.ts gates deny by requested_by).
    // Only testUser can cancel their own request.
    const decided = await decide(url, testUser.token, requestId, {
      decision: "deny",
      reason: "not now",
    })
    expect(decided.status).toBe(200)
    expect(decided.body.data.id).toBe(requestId)
    expect(decided.body.data.status).toBe("denied")
    expect(decided.body.data.reason).toBe("not now")
    expect(decided.body.data.decidedBy).toBe(testUser.id)

    const row = await dbFetchApproval(env, requestId)
    expect(row.status).toBe("denied")
    expect(row.reason).toBe("not now")
    const exec = await dbFetchHandlerExecution(env, requestId, "test:gatedEcho")
    expect(exec).toBeUndefined()

    await waitForApprovalEvent(ws, "update", requestId, "denied")
    const msgEvt = await waitForSystemMessageEvent(ws, threadId, "approval-decision")
    expect(msgEvt.payload.data.metadata.decision).toBe("denied")
    expect(msgEvt.payload.data.metadata.reason).toBe("not now")
    expect(msgEvt.payload.data.metadata.actorId).toBe(testUser.id)

    const sysMsgs = await dbFetchSystemMessages(env, threadId, "approval-decision")
    expect(sysMsgs.length).toBe(1)
    expect(sysMsgs[0].metadata).toEqual(msgEvt.payload.data.metadata)
  }, 30_000)

  // ─── S3 — Expiry worker transitions a pending request once ───
  it("S3: expiry worker transitions pending request to expired", async () => {
    const threadId = await freshThread()
    const { requestId } = await triggerGatedEcho(url, testUser.token, threadId, "expire me")
    await waitForApprovalEvent(ws, "create", requestId)

    await enqueueKernelJobNow(
      env,
      "approval-expiry",
      { orgId: world.org.id, requestId },
      `approval-expiry:${requestId}:e2e`,
    )

    const row = await pollUntil(async () => {
      const r = await dbFetchApproval(env, requestId)
      return r?.status === "expired" ? r : null
    })
    expect(row.status).toBe("expired")

    const sysMsgs = await dbFetchSystemMessages(env, threadId, "approval-decision")
    expect(sysMsgs.length).toBe(1)
    expect(sysMsgs[0].metadata.decision).toBe("expired")

    await waitForApprovalEvent(ws, "update", requestId, "expired")
    const msgEvt = await waitForSystemMessageEvent(ws, threadId, "approval-decision")
    expect(msgEvt.payload.data.metadata.decision).toBe("expired")
    expect(msgEvt.payload.data.metadata).toEqual(sysMsgs[0].metadata)
  }, 30_000)

  // ─── S4 — Late expiry job after decision is a no-op ───
  it("S4: late expiry job after decision is a no-op", async () => {
    const threadId = await freshThread()
    const { requestId } = await triggerGatedEcho(url, testUser.token, threadId, "late expiry")
    await waitForApprovalEvent(ws, "create", requestId)

    // Deny requires the REQUESTER; testUser is the requester here.
    const decided = await decide(url, testUser.token, requestId, {
      decision: "deny",
      reason: "preempt",
    })
    expect(decided.status).toBe(200)

    await waitForApprovalEvent(ws, "update", requestId, "denied")
    await waitForSystemMessageEvent(ws, threadId, "approval-decision")

    const baselineApproval = await pollUntil(async () => {
      const r = await dbFetchApproval(env, requestId)
      return r?.status === "denied" ? r : null
    })
    const baselineSysMsgs = (await dbFetchSystemMessages(env, threadId, "approval-decision")).length
    const baselineUpdates = await dbCountOutboxEventsForRequest(env, requestId, "update")
    const baselineMsgEvents = await dbCountOutboxMessageCreatesForThread(env, threadId)

    await enqueueKernelJobNow(
      env,
      "approval-expiry",
      { orgId: world.org.id, requestId },
      `approval-expiry:${requestId}:late`,
    )

    // The 1.5 s no-update window comes first and doubles as the settle window
    // for any async work the late expiry might start, so the DB checks after
    // it read a settled state.
    await expectNoWsEvent(
      ws,
      (m) => {
        const p = m?.payload
        if (!p) return false
        if (p.app !== "kernel" || p.entity !== "approval_request" || p.action !== "update")
          return false
        return p.data?.id === requestId
      },
      1500,
    )

    const after = await dbFetchApproval(env, requestId)
    expect(after.status).toBe(baselineApproval.status)

    const afterSysMsgs = (await dbFetchSystemMessages(env, threadId, "approval-decision")).length
    expect(afterSysMsgs).toBe(baselineSysMsgs)

    const afterUpdates = await dbCountOutboxEventsForRequest(env, requestId, "update")
    expect(afterUpdates).toBe(baselineUpdates)

    const afterMsgEvents = await dbCountOutboxMessageCreatesForThread(env, threadId)
    expect(afterMsgEvents).toBe(baselineMsgEvents)
  }, 30_000)
})
