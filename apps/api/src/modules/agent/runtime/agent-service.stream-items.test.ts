// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S28: every `agent_stream` frame of a turn carries its turn's `seq` and the
// item it belongs to (`itemId`, `itemKind`), the ones the live registry
// allocated when it recorded the frame. A client orders and dedups the live
// view by `seq` and draws the interleave by item, so a frame without them
// leaves the live block to guess (all thinking, then all tools, then text).
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test"
import crypto from "node:crypto"
import * as eventBusModule from "~/infra/events/event-bus"
import { AgentServiceTestAccess, invokeAgentForThread } from "~/modules/agent/runtime/agent-service"
import { AgentStreamRegistryTestAccess } from "~/modules/agent/runtime/stream-registry"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

type Frame = { entity: string; action: string; data?: Record<string, unknown> }

/** reasoning, tool A, text, reasoning, tool B, text: the interleave the item ids must follow. */
function interleavedStream() {
  return (async function* () {
    yield { type: "reasoning-delta", text: "think " }
    yield { type: "reasoning-delta", text: "more" }
    yield { type: "tool-call", toolCallId: "A", toolName: "kernel__probe_a", input: {} }
    yield { type: "tool-result", toolCallId: "A", toolName: "kernel__probe_a", output: { ok: 1 } }
    yield { type: "text-delta", text: "first " }
    yield { type: "text-delta", text: "answer" }
    yield { type: "reasoning-delta", text: "again" }
    yield { type: "tool-call", toolCallId: "B", toolName: "kernel__probe_b", input: {} }
    yield { type: "tool-result", toolCallId: "B", toolName: "kernel__probe_b", output: { ok: 2 } }
    yield { type: "text-delta", text: "done" }
    yield { type: "finish-step", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: "finish", finishReason: "stop" }
  })()
}

describe("agent_stream frames carry seq and the fold's item ids", () => {
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
    await AgentStreamRegistryTestAccess.reset()
    await releaseTestLock()
  })

  test("every agent_stream frame of a scripted interleaved turn carries increasing seq and the item ids of the fold", async () => {
    const turnId = crypto.randomUUID()
    AgentServiceTestAccess.setAgentRun(async () => ({
      userMessageId: turnId,
      actingAgentId: null,
      fullStream: interleavedStream(),
      finalize: async () => ({ messageId: "reply", creditCost: "0", finishReason: "stop" }),
      stepCtx: { stepBundleId: null },
    }))
    const frames: Frame[] = []
    const spy = spyOn(eventBusModule, "broadcastEphemeral").mockImplementation(async (event) => {
      frames.push(event as Frame)
    })
    try {
      await invokeAgentForThread(
        threadId,
        turnId,
        { userId, orgId, scopes: ["*"], dimensionGrants: {} },
        orgId,
      )
    } finally {
      spy.mockRestore()
    }
    // The turn's recorded frames: `accepted` (the requester's views told of the
    // turn before its setup returned) is no frame of its stream and has no seq.
    const stream = frames.filter(
      (f) => f.entity === "agent_stream" && f.action !== "accepted" && f.action !== "withdrawn",
    )
    const seqs = stream.map((f) => Number(f.data?.seq))
    // Strictly increasing, one per frame, in the order the frames left.
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBe((seqs[i - 1] ?? 0) + 1)
    expect(seqs[0]).toBeGreaterThan(0)
    const items = stream
      .filter((f) => f.action !== "start" && f.action !== "done")
      .map((f) => `${f.action}:${String(f.data?.itemId)}:${String(f.data?.itemKind)}`)
    expect(items).toEqual([
      "reasoning:r0:reasoning",
      "reasoning:r0:reasoning",
      "tool_call:A:tool",
      "tool_result:A:tool",
      "delta:t2:text",
      "delta:t2:text",
      "reasoning:r3:reasoning",
      "tool_call:B:tool",
      "tool_result:B:tool",
      "delta:t5:text",
    ])
    // `start` and the terminal frame carry seq and no item.
    for (const f of stream.filter((f) => f.action === "start" || f.action === "done")) {
      expect(typeof f.data?.seq).toBe("number")
      expect(f.data?.itemId).toBeUndefined()
    }
  })
})
