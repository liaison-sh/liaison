// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * S28 LIVE TURN ORDER. A turn's live view is an ordered list of items (one
 * reasoning run, one text run or one tool call each), and every frame says
 * where it goes: its turn's `seq` and its `itemId`. Frames can reach a viewer
 * out of order (two server processes publish one turn, a publish retry lets a
 * later frame overtake), twice (a frame already folded into the snapshot a late
 * joiner seeded from), or not at all (a socket that dropped). Without the
 * ordering the live block shuffled and duplicated items while the turn
 * streamed, then the persisted message redrew it in a different order.
 *
 * The script is the frames of one turn: reasoning r0, tool A (call, result),
 * text t2, reasoning r3, tool B (call, result), text t5, seq 1 to 8.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
})

import {
  AGENT_STREAM_GAP_WAIT_MS,
  getAgentStream,
  getGroupedMessages,
  handleWsAgentStreamEvent,
  handleWsMessageEvent,
  loadMessages,
  loadMessagesIntoStore,
  resetMessageStore,
  seedAgentStreamState,
  type TurnTimelineEntry,
} from "~/modules/threads/message-store"

const threadId = "t-order"
const agentId = "agent-1"
const turnId = "ask-1"

type Frame = { action: string; data: Record<string, unknown> }

const base = { threadId, agentId, turnId, askId: turnId }

/** The scripted turn, one frame per seq. */
const SCRIPT: Frame[] = [
  {
    action: "reasoning",
    data: { delta: "Let me look.", seq: 1, itemId: "r0", itemKind: "reasoning" },
  },
  {
    action: "tool_call",
    data: {
      toolCallId: "A",
      toolName: "search_tickets",
      args: {},
      seq: 2,
      itemId: "A",
      itemKind: "tool",
    },
  },
  {
    action: "tool_result",
    data: { toolCallId: "A", result: { ok: true }, seq: 3, itemId: "A", itemKind: "tool" },
  },
  {
    action: "delta",
    data: { delta: "Found the ticket. ", seq: 4, itemId: "t2", itemKind: "text" },
  },
  {
    action: "reasoning",
    data: { delta: "Now the order.", seq: 5, itemId: "r3", itemKind: "reasoning" },
  },
  {
    action: "tool_call",
    data: {
      toolCallId: "B",
      toolName: "get_order",
      args: {},
      seq: 6,
      itemId: "B",
      itemKind: "tool",
    },
  },
  {
    action: "tool_result",
    data: { toolCallId: "B", result: { ok: true }, seq: 7, itemId: "B", itemKind: "tool" },
  },
  {
    action: "delta",
    data: { delta: "It shipped yesterday.", seq: 8, itemId: "t5", itemKind: "text" },
  },
]

const EXPECTED = ["reasoning:r0", "tool:A", "text:t2", "reasoning:r3", "tool:B", "text:t5"]

function deliver(seq: number): void {
  const frame = SCRIPT[seq - 1]
  if (!frame) throw new Error(`no frame ${seq}`)
  handleWsAgentStreamEvent(frame.action, { ...base, ...frame.data })
}

function start(): void {
  handleWsAgentStreamEvent("start", { ...base })
}

/** The live timeline as `kind:item` (a tool by its call id, a run by its text). */
function order(): string[] {
  const stream = getAgentStream(threadId, agentId)
  return stream.timeline.map((entry) => {
    if (entry.kind === "tool") return `tool:${entry.toolCallId}`
    const id = SCRIPT.find(
      (f) => f.data.itemKind === entry.kind && entry.text.startsWith(String(f.data.delta)),
    )?.data.itemId
    return `${entry.kind}:${id ?? "?"}`
  })
}

/** The folded snapshot the server serves at `seq` (the frames through it). */
function snapshotThrough(seq: number) {
  const timeline: Array<TurnTimelineEntry & { itemId: string }> = []
  const toolCalls: Array<Record<string, unknown>> = []
  let content = ""
  let reasoning = ""
  for (const frame of SCRIPT.slice(0, seq)) {
    const d = frame.data
    const itemId = String(d.itemId)
    if (frame.action === "reasoning" || frame.action === "delta") {
      const kind = frame.action === "reasoning" ? "reasoning" : "text"
      if (kind === "reasoning") reasoning += String(d.delta)
      else content += String(d.delta)
      const last = timeline[timeline.length - 1]
      if (last && last.itemId === itemId && last.kind !== "tool") last.text += String(d.delta)
      else timeline.push({ kind, text: String(d.delta), itemId })
    } else if (frame.action === "tool_call") {
      toolCalls.push({
        toolCallId: d.toolCallId,
        toolName: d.toolName,
        args: {},
        status: "running",
      })
      timeline.push({ kind: "tool", toolCallId: String(d.toolCallId), itemId })
    } else if (frame.action === "tool_result") {
      const call = toolCalls.find((c) => c.toolCallId === d.toolCallId)
      if (call) {
        call.result = d.result
        call.status = "completed"
      }
    }
  }
  const run = {
    agentId,
    turnId,
    askId: turnId,
    state: "streaming",
    content,
    reasoning,
    reasoningStreaming: false,
    toolCalls,
    timeline,
    startedAt: Date.now(),
    seq,
  }
  return { data: { active: true, ...run, streams: [run] } }
}

/** A server whose stream-state answer is the snapshot at `state.seq`. */
function server(seq: number) {
  const state = { seq, calls: 0 }
  const api = {
    get: vi.fn(async (path: string) => {
      if (path.startsWith("/agent/stream-state/")) {
        state.calls += 1
        return snapshotThrough(state.seq)
      }
      return { data: [] }
    }),
  }
  return { api, state }
}

async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

const REPLY_TEXT = "Found the ticket. It shipped yesterday."

function replyCopy(metadata: Record<string, unknown> | null) {
  return {
    id: "reply-1",
    threadId,
    authorId: "agent-user",
    authorName: "Desk",
    authorType: "agent",
    authorAgentId: agentId,
    content: REPLY_TEXT,
    metadata,
    createdAt: new Date().toISOString(),
  }
}

describe("live turn order (S28)", () => {
  beforeEach(() => {
    resetMessageStore()
  })
  afterEach(() => {
    vi.useRealTimers()
    resetMessageStore()
  })

  it("in-order frames build the items in seq order", () => {
    start()
    for (let seq = 1; seq <= 8; seq++) deliver(seq)
    expect(order()).toEqual(EXPECTED)
    const stream = getAgentStream(threadId, agentId)
    expect(stream.toolCalls.map((c) => [c.toolCallId, c.status])).toEqual([
      ["A", "completed"],
      ["B", "completed"],
    ])
  })

  it("a frame overtaken on the wire is placed by seq", () => {
    start()
    for (const seq of [1, 2, 3, 5, 4, 6, 7, 8]) deliver(seq)
    expect(order()).toEqual(EXPECTED)
  })

  it("a frame delivered twice is applied once", () => {
    start()
    for (const seq of [1, 2, 3, 4, 4, 5, 6, 6, 7, 8]) deliver(seq)
    expect(order()).toEqual(EXPECTED)
    expect(getAgentStream(threadId, agentId).toolCalls).toHaveLength(2)
    expect(getAgentStream(threadId, agentId).content).toBe(REPLY_TEXT)
  })

  it("a frame folded into the snapshot and delivered after it is dropped", async () => {
    // A late joiner: no block, the snapshot at seq 5, then frames 4, 5 and 6.
    const { api } = server(5)
    await seedAgentStreamState(api, threadId)
    expect(order()).toEqual(EXPECTED.slice(0, 4))
    for (const seq of [4, 5, 6]) deliver(seq)
    expect(order()).toEqual(EXPECTED.slice(0, 5))
    const stream = getAgentStream(threadId, agentId)
    expect(stream.content).toBe("Found the ticket. ")
    expect(stream.toolCalls.filter((c) => c.toolCallId === "B")).toHaveLength(1)
  })

  it("frames that arrive while the snapshot is on the wire wait for it", async () => {
    const { api } = server(5)
    const seeding = seedAgentStreamState(api, threadId)
    // Frames 4 to 6 overtake the snapshot's answer.
    for (const seq of [4, 5, 6]) deliver(seq)
    await seeding
    expect(order()).toEqual(EXPECTED.slice(0, 5))
    expect(getAgentStream(threadId, agentId).content).toBe("Found the ticket. ")
  })

  it("a resume after a drop fills the gap in place", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    const { api, state } = server(6)
    await loadMessages(api, threadId)
    start()
    deliver(1)
    deliver(2)
    // Frames 3 to 6 are lost with the socket; frame 7 arrives after it.
    deliver(7)
    expect(order()).toEqual(EXPECTED.slice(0, 2))
    await vi.advanceTimersByTimeAsync(AGENT_STREAM_GAP_WAIT_MS + 10)
    await settle()
    expect(state.calls).toBe(1)
    expect(order()).toEqual(EXPECTED.slice(0, 5))
    const b = getAgentStream(threadId, agentId).toolCalls.find((c) => c.toolCallId === "B")
    expect(b?.status).toBe("completed")
    // The stream goes on from there, once.
    deliver(8)
    deliver(7)
    expect(order()).toEqual(EXPECTED)
  })

  it("a reconnect mid-turn replaces the partial block with the snapshot", async () => {
    const { api } = server(5)
    start()
    deliver(1)
    deliver(2)
    // The socket came back: the resync path reseeds with replace.
    await seedAgentStreamState(api, threadId, { replace: true })
    expect(order()).toEqual(EXPECTED.slice(0, 4))
    deliver(6)
    deliver(5)
    expect(order()).toEqual(EXPECTED.slice(0, 5))
    expect(getAgentStream(threadId, agentId).state).toBe("streaming")
  })

  it("a seq gap triggers a reseed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    const { api, state } = server(4)
    await loadMessages(api, threadId)
    start()
    deliver(1)
    deliver(5)
    expect(state.calls).toBe(0)
    await vi.advanceTimersByTimeAsync(AGENT_STREAM_GAP_WAIT_MS + 10)
    await settle()
    expect(state.calls).toBe(1)
    expect(order()).toEqual(EXPECTED.slice(0, 4))
  })

  it("the handover replaces the live view whole", () => {
    loadMessagesIntoStore(threadId, [])
    start()
    for (let seq = 1; seq <= 8; seq++) deliver(seq)
    // The outbox copy lands first, written before the reply's metadata.
    handleWsMessageEvent("create", replyCopy(null))
    expect(getAgentStream(threadId, agentId).state).toBe("streaming")
    const drawn = getGroupedMessages(threadId).filter((g) => g.msg.content === REPLY_TEXT)
    expect(drawn).toHaveLength(0)
    // Then the full copy, naming the turn and carrying its timeline.
    const timeline = snapshotThrough(8).data.timeline.map(({ itemId: _id, ...entry }) => entry)
    handleWsMessageEvent("create", replyCopy({ turnId, timeline }))
    expect(getAgentStream(threadId, agentId).state).toBe("idle")
    const rows = getGroupedMessages(threadId).filter((g) => g.msg.content === REPLY_TEXT)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.msg.metadata?.timeline?.map((e) => e.kind)).toEqual([
      "reasoning",
      "tool",
      "text",
      "reasoning",
      "tool",
      "text",
    ])
  })

  it("a late frame of a turn whose reply landed never reopens the block", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    const api = {
      get: vi.fn(async (path: string) =>
        path.startsWith("/agent/stream-state/") ? { data: { active: false } } : { data: [] },
      ),
    }
    await loadMessages(api, threadId)
    start()
    for (let seq = 1; seq <= 7; seq++) deliver(seq)
    // The reply naming the turn overtakes the turn's last frame.
    handleWsMessageEvent("create", replyCopy({ turnId }))
    expect(getAgentStream(threadId, agentId).state).toBe("idle")
    deliver(8)
    await vi.advanceTimersByTimeAsync(AGENT_STREAM_GAP_WAIT_MS * 4)
    await settle()
    const stream = getAgentStream(threadId, agentId)
    expect(stream.state).toBe("idle")
    expect(stream.content).toBe("")
    expect(api.get.mock.calls.some(([p]) => String(p).startsWith("/agent/stream-state/"))).toBe(
      false,
    )
  })

  it("frames that overtake their turn's start are drawn after it", () => {
    const text = (delta: string, seq: number) =>
      handleWsAgentStreamEvent("delta", { ...base, delta, seq, itemId: "t", itemKind: "text" })
    text("Hello ", 2)
    handleWsAgentStreamEvent("start", { ...base, seq: 1 })
    text("world", 3)
    const stream = getAgentStream(threadId, agentId)
    expect(stream.state).toBe("streaming")
    expect(stream.content).toBe("Hello world")
  })

  it("an unrelated unnamed agent message that merely starts like the live text is drawn", () => {
    loadMessagesIntoStore(threadId, [])
    start()
    handleWsAgentStreamEvent("delta", {
      ...base,
      delta: "Ok",
      seq: 1,
      itemId: "t",
      itemKind: "text",
    })
    const other = {
      ...replyCopy(null),
      id: "other-1",
      content: "Ok, I emailed the customer about the refund.",
    }
    handleWsMessageEvent("create", other)
    const rows = getGroupedMessages(threadId).filter((g) => g.msg.id === "other-1")
    expect(rows).toHaveLength(1)
    expect(getAgentStream(threadId, agentId).state).toBe("streaming")
  })

  it("frames without seq keep today's append", () => {
    start()
    for (const frame of SCRIPT) {
      const { seq: _seq, itemId: _item, itemKind: _kind, ...rest } = frame.data
      handleWsAgentStreamEvent(frame.action, { ...base, ...rest })
    }
    expect(getAgentStream(threadId, agentId).timeline.map((e) => e.kind)).toEqual([
      "reasoning",
      "tool",
      "text",
      "reasoning",
      "tool",
      "text",
    ])
  })
})
