// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The supersede wait across processes (A31). A demo visitor's newer request
// waits for their earlier turn to stop before it reads the history. With
// several API processes the earlier turn may run in another one: the wait
// reads the cell-wide live turn registry, and that turn's end reaches it from
// there. A second registry handle with its own instance id stands for the
// other process; its turns are invisible to this process's module state.
import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test"
import crypto from "node:crypto"
import { LIVE_INSTANCE_KEY } from "~/infra/instance-registry"
import { redis } from "~/lib/redis"
import * as registryModule from "~/modules/agent/runtime/stream-registry"
import {
  AgentStreamRegistryTestAccess,
  LiveTurnRegistry,
  LiveTurnTimeout,
} from "~/modules/agent/runtime/stream-registry"
import { waitForEarlierLiveTurn } from "~/modules/agent/runtime/superseded-turn"

const ORG_ID = "00000000-0000-4000-8000-0000000b3101"
const USER_ID = "00000000-0000-4000-8000-0000000b3102"

/** Another process: its own registry handle and instance id, with a live heartbeat. */
async function otherProcess(): Promise<LiveTurnRegistry> {
  const instanceId = `other-${crypto.randomUUID()}`
  await redis.set(LIVE_INSTANCE_KEY(instanceId), "{}", "PX", 30_000)
  return new LiveTurnRegistry({ instanceId })
}

afterEach(async () => {
  await AgentStreamRegistryTestAccess.reset()
})

afterAll(async () => {
  await AgentStreamRegistryTestAccess.reset()
})

describe("waitForEarlierLiveTurn across processes", () => {
  it("the wait sees an earlier turn recorded by another process, and its end", async () => {
    const other = await otherProcess()
    const threadId = crypto.randomUUID()
    const earlier = crypto.randomUUID()
    const vis = { requesterId: USER_ID, agentId: null, turnId: earlier }
    await other.record(threadId, ORG_ID, "start", {}, vis)
    await other.record(threadId, ORG_ID, "delta", { delta: "working on it" }, vis)

    let outcome: string | null = null
    const waiting = waitForEarlierLiveTurn({
      threadId,
      messageId: crypto.randomUUID(),
      senderId: USER_ID,
      agentId: null,
    }).then((o) => {
      outcome = o
      return o
    })
    await Bun.sleep(400)
    // Still running in the other process: the wait holds.
    expect(outcome).toBeNull()

    const ended = Date.now()
    await other.record(threadId, ORG_ID, "done", { finishReason: "superseded" }, vis)
    expect(await waiting).toBe("ended")
    expect(Date.now() - ended).toBeLessThan(1_000)
  })

  it("a turn of another process that is not the person's earlier one is not waited for", async () => {
    const other = await otherProcess()
    const threadId = crypto.randomUUID()
    const own = crypto.randomUUID()
    await other.record(threadId, ORG_ID, "start", {}, { requesterId: USER_ID, turnId: own })
    await other.record(
      threadId,
      ORG_ID,
      "start",
      {},
      { requesterId: crypto.randomUUID(), turnId: crypto.randomUUID() },
    )
    expect(
      await waitForEarlierLiveTurn({ threadId, messageId: own, senderId: USER_ID, agentId: null }),
    ).toBe("none")
  })

  it("a registry Redis does not answer waits for nothing (the newer turn goes ahead)", async () => {
    const spy = spyOn(registryModule, "listLiveAgentTurns").mockImplementation(() =>
      Promise.reject(new LiveTurnTimeout("list live turns", 1_000)),
    )
    try {
      const started = Date.now()
      expect(
        await waitForEarlierLiveTurn({
          threadId: crypto.randomUUID(),
          messageId: crypto.randomUUID(),
          senderId: USER_ID,
          agentId: null,
        }),
      ).toBe("none")
      expect(Date.now() - started).toBeLessThan(500)
    } finally {
      spy.mockRestore()
    }
  })
})
