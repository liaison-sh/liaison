// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A turn is running from the moment the server takes it on, not from its first
// stream frame. Setting a turn up (the org's apps, the credit check, a long
// history to compact) can take many seconds before `start`, and a view that
// loads in that window (a page reload just after the ask was sent) reads
// GET /api/agent/stream-state to learn what runs. It used to hear "nothing", so
// the conversation showed no live block and a guided step offered to send the
// same ask again.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
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
})
