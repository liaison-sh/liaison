// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A turn is running from the moment the server takes it on, not from its first
// stream frame. Setting a turn up (the org's apps, the credit check, a long
// history to compact) can take many seconds before `start`, and a view that
// loads in that window (a page reload just after the ask was sent) reads
// GET /api/agent/stream-state to learn what runs. It used to hear "nothing", so
// the conversation showed no live block and a guided step offered to send the
// same ask again.
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test"
import crypto from "node:crypto"
import * as eventBusModule from "~/infra/events/event-bus"
import { AgentServiceTestAccess, invokeAgentForThread } from "~/modules/agent/runtime/agent-service"
import {
  type LiveAgentStreamSnapshot,
  listLiveAgentStreams,
} from "~/modules/agent/runtime/stream-registry"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

function finishedStream(onStart?: () => void) {
  return (async function* () {
    onStart?.()
    yield { type: "finish-step", finishReason: "stop", usage: { inputTokens: 0, outputTokens: 0 } }
    yield { type: "finish", finishReason: "stop" }
  })()
}

describe("a turn the server has taken on is live before its first frame", () => {
  let orgId: string
  let userId: string
  let threadId: string
  beforeAll(async () => {
    await acquireTestLock()
    const u = await minimal.orgAdmin((await createTestOrg()).id)
    orgId = u.orgId
    userId = u.id
    threadId = await minimal.thread(orgId, userId)
  })
  afterAll(async () => {
    AgentServiceTestAccess.setAgentRun(undefined)
    await releaseTestLock()
  })

  test("listed while the turn is still being set up, then one entry once it streams", async () => {
    const turnId = crypto.randomUUID()
    let release: () => void = () => {}
    const setUp = new Promise<void>((resolve) => {
      release = resolve
    })
    let duringStream: Promise<LiveAgentStreamSnapshot[]> = Promise.resolve([])
    AgentServiceTestAccess.setAgentRun(async () => {
      await setUp
      return {
        userMessageId: turnId,
        actingAgentId: null,
        fullStream: finishedStream(() => {
          duringStream = listLiveAgentStreams(threadId)
        }),
        finalize: async () => ({ messageId: "reply", creditCost: "0", finishReason: "stop" }),
        stepCtx: { stepBundleId: null },
      }
    })
    const turn = invokeAgentForThread(
      threadId,
      turnId,
      { userId, orgId, scopes: ["*"], dimensionGrants: {} },
      orgId,
    )
    // The setup has not returned: no frame has gone out yet.
    let listed: LiveAgentStreamSnapshot[] = []
    for (let i = 0; i < 100 && listed.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10))
      listed = await listLiveAgentStreams(threadId)
    }
    expect(listed.map((s) => s.turnId)).toEqual([turnId])
    expect(listed[0]?.requesterId).toBe(userId)
    expect(listed[0]?.orgId).toBe(orgId)
    release()
    await turn
    // Once it streams, the turn is one entry (its own), not the accepted one beside it.
    expect((await duringStream).map((s) => s.turnId)).toEqual([turnId])
    expect(await listLiveAgentStreams(threadId)).toEqual([])
  })

  test("a turn whose setup fails is no longer listed", async () => {
    const turnId = crypto.randomUUID()
    AgentServiceTestAccess.setAgentRun(async () => {
      await new Promise((r) => setTimeout(r, 20))
      throw new Error("no usable model")
    })
    await expect(
      invokeAgentForThread(
        threadId,
        turnId,
        { userId, orgId, scopes: ["*"], dimensionGrants: {} },
        orgId,
      ),
    ).rejects.toThrow("no usable model")
    expect(await listLiveAgentStreams(threadId)).toEqual([])
  })

  // An open view drew a turn from its `start` alone: a newer turn asked while
  // an older one of the same agent still answered showed only after the older
  // reply had landed (agent-overlapping-turns). The requester's views are told
  // when the server takes the turn on, before its setup returns.
  test("the requester's open views are told of the turn before its setup returns", async () => {
    const turnId = crypto.randomUUID()
    let release: () => void = () => {}
    const setUp = new Promise<void>((resolve) => {
      release = resolve
    })
    type Frame = {
      entity: string
      action: string
      actorId?: string
      data?: Record<string, unknown>
    }
    const frames: Frame[] = []
    const spy = spyOn(eventBusModule, "broadcastEphemeral").mockImplementation(async (event) => {
      frames.push(event as Frame)
    })
    const streamActions = () =>
      frames.filter((f) => f.entity === "agent_stream").map((f) => f.action)
    try {
      AgentServiceTestAccess.setAgentRun(async () => {
        await setUp
        // The agent the accepted entry named, as runAgentChat resolves it.
        const acceptedAgent = frames.find((f) => f.action === "accepted")?.data?.agentId
        return {
          userMessageId: turnId,
          actingAgentId: typeof acceptedAgent === "string" ? acceptedAgent : null,
          fullStream: finishedStream(),
          finalize: async () => ({ messageId: "reply", creditCost: "0", finishReason: "stop" }),
          stepCtx: { stepBundleId: null },
        }
      })
      const turn = invokeAgentForThread(
        threadId,
        turnId,
        { userId, orgId, scopes: ["*"], dimensionGrants: {} },
        orgId,
      )
      for (let i = 0; i < 100 && streamActions().length === 0; i++) {
        await new Promise((r) => setTimeout(r, 10))
      }
      // Setup has not returned, and the accepted frame is out already.
      expect(streamActions()).toEqual(["accepted"])
      const accepted = frames.find((f) => f.action === "accepted")
      expect(accepted?.actorId).toBe(userId)
      expect(accepted?.data?.turnId).toBe(turnId)
      expect(accepted?.data?.threadId).toBe(threadId)
      // No scopes known yet: the fan-out sends it to the requester alone.
      expect(accepted?.data?.accumulatedScopes).toBeUndefined()
      release()
      await turn
      // Its start took the entry over: nothing is withdrawn.
      expect(streamActions()[1]).toBe("start")
      expect(streamActions()).not.toContain("withdrawn")
    } finally {
      spy.mockRestore()
    }
  })

  test("a turn whose setup fails withdraws what its open views show", async () => {
    const turnId = crypto.randomUUID()
    type Frame = { entity: string; action: string; data?: Record<string, unknown> }
    const frames: Frame[] = []
    const spy = spyOn(eventBusModule, "broadcastEphemeral").mockImplementation(async (event) => {
      frames.push(event as Frame)
    })
    try {
      AgentServiceTestAccess.setAgentRun(async () => {
        await new Promise((r) => setTimeout(r, 20))
        throw new Error("no usable model")
      })
      await expect(
        invokeAgentForThread(
          threadId,
          turnId,
          { userId, orgId, scopes: ["*"], dimensionGrants: {} },
          orgId,
        ),
      ).rejects.toThrow("no usable model")
    } finally {
      spy.mockRestore()
    }
    const stream = frames.filter((f) => f.entity === "agent_stream")
    expect(stream.map((f) => f.action)).toEqual(["accepted", "withdrawn"])
    expect(stream[1]?.data?.turnId).toBe(turnId)
  })
})
