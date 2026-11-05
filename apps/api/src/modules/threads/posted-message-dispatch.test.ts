// SPDX-License-Identifier: FSL-1.1-ALv2
// A process that is shutting down starts no agent turn (S9 step 5): a message
// posted to it in the edge window is handed to a live worker as a job.
import { afterEach, describe, expect, it } from "bun:test"
import { ReadinessTestAccess, setDraining } from "~/lib/readiness"
import {
  dispatchForPostedMessage,
  type PostedMessageDispatchParams,
  PostedMessageDispatchTestAccess,
  runDeferredTurnDispatch,
  TURN_DISPATCH_JOB,
} from "~/modules/threads/posted-message-dispatch"

const params: PostedMessageDispatchParams = {
  orgId: "00000000-0000-4000-8000-000000000001",
  threadId: "00000000-0000-4000-8000-000000000002",
  message: {
    id: "00000000-0000-4000-8000-000000000003",
    content: "hello",
    mentions: [{ type: "agent", id: "00000000-0000-4000-8000-000000000004" }],
    authorName: "User",
    threadType: "channel",
  },
  actor: {
    userId: "00000000-0000-4000-8000-000000000005",
    orgId: "00000000-0000-4000-8000-000000000001",
    scopes: ["kernel:threads:write"],
    roles: ["role-a"],
  },
  turnContext: { clientSurface: "web", currentView: { tabType: "thread", entityId: "t" } },
  callerEffectiveScope: ["kernel:threads:read"],
}

afterEach(() => {
  ReadinessTestAccess.reset()
  PostedMessageDispatchTestAccess.reset()
})

describe("dispatch on a draining process", () => {
  it("a draining process enqueues agent-turn-dispatch and starts no turn", async () => {
    const enqueued: Array<{ name: string; payload: unknown; jobId: string }> = []
    PostedMessageDispatchTestAccess.setEnqueue(async (name, payload, jobId) => {
      enqueued.push({ name, payload, jobId })
    })
    let touched = 0
    setDraining(true)
    const result = await dispatchForPostedMessage(async () => {
      // Any agent resolution, guard or turn reads through here first.
      touched++
      throw new Error("a draining process must not dispatch")
    }, params)

    expect(touched).toBe(0)
    expect(result.dispatchedAgentIds).toEqual([])
    expect(enqueued).toHaveLength(1)
    expect(enqueued[0]?.name).toBe(TURN_DISPATCH_JOB)
    expect(enqueued[0]?.jobId).toBe(`dispatch:${params.message.id}`)
    // The whole call rides the job: the scope ceiling (m4), the turn context
    // and the actor's roles, so the live worker dispatches exactly this.
    const payload = enqueued[0]?.payload as PostedMessageDispatchParams
    expect(payload.callerEffectiveScope).toEqual(["kernel:threads:read"])
    expect(payload.turnContext).toEqual(params.turnContext)
    expect(payload.actor.roles).toEqual(["role-a"])
    expect(payload.message.id).toBe(params.message.id)
    // Serializable: what BullMQ stores is what the worker gets.
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload)
  })

  it("a ready process dispatches here, as before", async () => {
    const enqueued: unknown[] = []
    PostedMessageDispatchTestAccess.setEnqueue(async (...args) => {
      enqueued.push(args)
    })
    let touched = 0
    await dispatchForPostedMessage(async () => {
      touched++
      return [] as never
    }, params).catch(() => {})
    expect(touched).toBeGreaterThan(0)
    expect(enqueued).toEqual([])
  })

  it("the dispatch job itself, running as its process starts draining, never re-enqueues under its own id", async () => {
    // Its job holds `dispatch:<messageId>` while it runs: a re-enqueue under
    // that id would be dropped by BullMQ's dedup, and the turn lost. It
    // started before t0, so it dispatches here and the turn drain waits for it.
    const enqueued: unknown[] = []
    PostedMessageDispatchTestAccess.setEnqueue(async (...args) => {
      enqueued.push(args)
    })
    setDraining(true)
    let touched = 0
    await dispatchForPostedMessage(
      async () => {
        touched++
        return [] as never
      },
      params,
      { deferred: true },
    ).catch(() => {})
    expect(touched).toBeGreaterThan(0)
    // The job handler's own entry takes the same path.
    await runDeferredTurnDispatch(params).catch(() => {})
    expect(enqueued).toEqual([])
  })
})
