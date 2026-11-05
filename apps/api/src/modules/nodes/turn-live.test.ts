// SPDX-License-Identifier: FSL-1.1-ALv2
// A node chat turn shows in its chat like a cloud turn: Queued, then a live
// block with its steps, then the end. The frames are the cloud turn's own, the
// steps are redacted, and the content goes to the owner alone.
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import * as bus from "~/infra/events/event-bus"
import {
  getLiveAgentStream,
  MAX_SNAPSHOT_TOOL_CALLS,
} from "~/modules/agent/runtime/stream-registry"
import {
  NODE_TURN_STEP_TOOL,
  nodeTurnAlive,
  nodeTurnEnded,
  nodeTurnProgress,
  nodeTurnQueued,
  nodeTurnRunning,
  nodeTurnStepId,
} from "./turn-live"

// An obviously fake key, joined at runtime so the source holds no key-shaped literal.
const FAKE_ANTHROPIC_KEY = ["sk-ant-api03", "abcdefghijklmnopqrstuvwxyz0123456789"].join("-")

const job = {
  id: "11111111-1111-4111-8111-111111111111",
  orgId: "22222222-2222-4222-8222-222222222222",
  ownerUserId: "33333333-3333-4333-8333-333333333333",
  agentId: "44444444-4444-4444-8444-444444444444",
  threadId: "55555555-5555-4555-8555-555555555555",
  kind: "interactive",
}

type Frame = { entity: string; action: string; actorId?: string; data?: Record<string, unknown> }

describe("node chat turn, live", () => {
  let frames: Frame[]
  let spy: ReturnType<typeof spyOn>

  beforeEach(() => {
    frames = []
    spy = spyOn(bus, "broadcastEphemeral").mockImplementation(
      mock(async (event: Frame) => {
        frames.push(event)
      }) as never,
    )
  })
  afterEach(async () => {
    await nodeTurnEnded(job, "ended")
    spy.mockRestore()
  })

  it("announces a queued turn on the typing channel, with its thread", () => {
    nodeTurnQueued(job)
    expect(frames).toEqual([
      expect.objectContaining({
        entity: "typing",
        action: "start",
        data: expect.objectContaining({
          threadId: job.threadId,
          authorType: "agent",
          agentId: job.agentId,
        }),
      }),
    ])
  })

  it("opens the block on the claim with one running step naming the computer", async () => {
    await nodeTurnRunning(job, "Studio Mac")
    const stream = frames.filter((f) => f.entity === "agent_stream")
    expect(stream.map((f) => f.action)).toEqual(["start", "tool_call"])
    expect(stream[1]?.data).toMatchObject({
      toolCallId: nodeTurnStepId(job.id),
      toolName: NODE_TURN_STEP_TOOL,
      summary: "Studio Mac",
    })
    // Owner-only content: the requester is the owner and no scope tag is set.
    for (const f of stream) {
      expect(f.actorId).toBe(job.ownerUserId)
      expect(f.data?.accumulatedScopes).toBeUndefined()
    }
    // Each frame carries its turn's seq (S28), in order; the step carries its item.
    const seqs = stream.map((f) => Number(f.data?.seq))
    expect(seqs[1]).toBe((seqs[0] ?? 0) + 1)
    expect(stream[1]?.data).toMatchObject({ itemId: nodeTurnStepId(job.id), itemKind: "tool" })
    const live = await getLiveAgentStream(job.threadId)
    expect(live?.requesterId).toBe(job.ownerUserId)
    expect(live?.toolCalls[0]?.summary).toBe("Studio Mac")
  })

  it("streams the node's steps, redacted, and seeds a chat opened mid-turn", async () => {
    await nodeTurnRunning(job, "Studio Mac")
    frames = []
    await nodeTurnProgress(job, [
      {
        type: "tool_call",
        id: "toolu_1",
        toolName: "Bash",
        summary: `curl -H 'Authorization: Bearer ${FAKE_ANTHROPIC_KEY}'`,
      },
      { type: "tool_result", id: "toolu_1" },
    ])
    expect(frames.map((f) => f.action)).toEqual(["tool_call", "tool_result"])
    const summary = String(frames[0]?.data?.summary)
    expect(summary).toContain("curl")
    expect(summary).not.toContain(FAKE_ANTHROPIC_KEY)
    const live = await getLiveAgentStream(job.threadId)
    const step = live?.toolCalls.find((t) => t.toolName === "Bash")
    expect(step?.status).toBe("completed")
  })

  it("ends the turn: done after an answer, cleared otherwise, typing stops", async () => {
    await nodeTurnRunning(job, null)
    frames = []
    await nodeTurnEnded(job, "answered")
    expect(frames.map((f) => `${f.entity}:${f.action}`)).toEqual([
      "agent_stream:tool_result",
      "agent_stream:done",
      "typing:stop",
    ])
    expect(await getLiveAgentStream(job.threadId)).toBeNull()

    await nodeTurnRunning(job, null)
    frames = []
    await nodeTurnEnded(job, "ended")
    expect(frames.map((f) => `${f.entity}:${f.action}`)).toEqual([
      "agent_stream:clear",
      "typing:stop",
    ])
  })

  it("shows a re-sent step once and keeps the latest steps of a long turn", async () => {
    await nodeTurnRunning(job, null)
    await nodeTurnProgress(job, [{ type: "tool_call", id: "dup", toolName: "Read" }])
    frames = []
    await nodeTurnProgress(job, [{ type: "tool_call", id: "dup", toolName: "Read" }])
    expect(frames).toEqual([])
    const many = Array.from({ length: MAX_SNAPSHOT_TOOL_CALLS + 5 }, (_, i) => ({
      type: "tool_call" as const,
      id: `s${i}`,
      toolName: "Read",
    }))
    await nodeTurnProgress(job, many)
    const live = await getLiveAgentStream(job.threadId)
    expect(live?.toolCalls).toHaveLength(MAX_SNAPSHOT_TOOL_CALLS)
    expect(live?.toolCalls.at(-1)?.toolCallId).toBe(
      `node-step:${job.id}:s${MAX_SNAPSHOT_TOOL_CALLS + 4}`,
    )
  })

  it("keeps a turn waiting on its owner past the stale cap while its job heartbeats", async () => {
    const realNow = Date.now
    let now = realNow()
    Date.now = () => now
    try {
      await nodeTurnRunning(job, null)
      for (let minute = 0; minute < 15; minute++) {
        now += 60_000
        await nodeTurnAlive(job)
      }
      expect(await getLiveAgentStream(job.threadId)).not.toBeNull()
      now += 12 * 60_000
      expect(await getLiveAgentStream(job.threadId)).toBeNull()
    } finally {
      Date.now = realNow
    }
  })

  it("says nothing for an unattended job", async () => {
    nodeTurnQueued({ ...job, kind: "unattended" })
    await nodeTurnRunning({ ...job, kind: "unattended" }, "Studio Mac")
    await nodeTurnProgress({ ...job, kind: "unattended" }, [{ type: "tool_result", id: "x" }])
    expect(frames).toEqual([])
  })
})
