// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Two turns of ONE agent in one conversation: a newer request to the agent
 * while it still answers starts a second turn (on a demo the first stops at
 * its next step and says it was replaced). The conversation shows both as
 * they are: the newer turn's start keeps the older turn's block, and the older
 * turn's reply and end never end the newer turn's block.
 */
import { beforeEach, describe, expect, it } from "vitest"
import {
  getChannelAgentStream,
  getLiveAgentStreams,
  handleWsAgentStreamEvent,
  handleWsMessageEvent,
  loadMessagesIntoStore,
  resetMessageStore,
} from "~/modules/threads/message-store"

const threadId = "t-replaced"
const agentId = "agent-1"

function frame(action: string, turnId: string, extra: Record<string, unknown> = {}) {
  handleWsAgentStreamEvent(action, { threadId, agentId, turnId, ...extra })
}

function agentReply(id: string, turnId: string | null, content: string) {
  handleWsMessageEvent("create", {
    id,
    threadId,
    authorId: "u1",
    authorType: "agent",
    authorAgentId: agentId,
    content,
    metadata: turnId ? { turnId } : null,
    createdAt: new Date().toISOString(),
  })
}

describe("two turns of one agent in one conversation", () => {
  beforeEach(() => {
    resetMessageStore()
    loadMessagesIntoStore(threadId, [])
  })

  it("the newer turn's start keeps the older turn's block", () => {
    frame("start", "ask-1")
    frame("tool_call", "ask-1", { toolCallId: "c1", toolName: "kernel__web_search", args: {} })
    frame("start", "ask-2")
    frame("reasoning", "ask-2", { delta: "Thinking about the task" })

    const live = getLiveAgentStreams(threadId)
    expect(live).toHaveLength(2)
    expect(live[0]?.replaced).toBe(true)
    expect(live[0]?.stream.toolCalls.map((c) => c.toolName)).toEqual(["kernel__web_search"])
    expect(live[1]?.stream.reasoning).toBe("Thinking about the task")
    // What the conversation's state label and the tours read is the newer turn.
    expect(getChannelAgentStream(threadId).turnId).toBe("ask-2")
  })

  it("the older turn's frames stay on its own block", () => {
    frame("start", "ask-1")
    frame("start", "ask-2")
    frame("tool_result", "ask-1", { toolCallId: "c1", result: {} })
    frame("delta", "ask-1", { delta: "older text" })
    const live = getLiveAgentStreams(threadId)
    expect(live.find((r) => !r.replaced)?.stream.content).toBe("")
    expect(live.find((r) => r.replaced)?.stream.content).toBe("older text")
  })

  it("the replaced turn's reply and end leave the newer turn running", () => {
    frame("start", "ask-1")
    frame("start", "ask-2")
    frame("tool_call", "ask-2", { toolCallId: "c2", toolName: "kernel__web_search", args: {} })
    // The replaced turn persists its line (the outbox copy first, with no
    // metadata, then the live copy naming its turn), then ends.
    agentReply("reply-1", null, "I stopped working on this message.")
    agentReply("reply-1", "ask-1", "I stopped working on this message.")
    frame("done", "ask-1")

    const live = getLiveAgentStreams(threadId)
    expect(live).toHaveLength(1)
    expect(live[0]?.replaced).toBeUndefined()
    expect(live[0]?.stream.state).toBe("streaming")
    expect(live[0]?.stream.toolCalls).toHaveLength(1)
  })

  it("the newer turn's own reply ends its block", () => {
    frame("start", "ask-1")
    frame("start", "ask-2")
    frame("done", "ask-1")
    frame("delta", "ask-2", { delta: "The answer" })
    agentReply("reply-2", null, "The answer")
    expect(getLiveAgentStreams(threadId)).toHaveLength(1)
    agentReply("reply-2", "ask-2", "The answer")
    frame("done", "ask-2")
    expect(getLiveAgentStreams(threadId)).toHaveLength(0)
  })

  it("a turn that names none ends on any reply of its agent, as before", () => {
    handleWsAgentStreamEvent("start", { threadId, agentId })
    agentReply("reply-x", null, "Done")
    expect(getLiveAgentStreams(threadId)).toHaveLength(0)
  })
})

/**
 * The server tells the requester's open views of a turn it took on before the
 * turn's `start`: setting a turn up can take seconds, and an older turn of the
 * same agent can answer in that window. Drawn from `start` alone, the newer
 * turn appeared only once the older reply had landed, so the conversation never
 * showed both turns at once (agent-overlapping-turns, gate run 42647816287).
 */
describe("a turn the server took on shows before its start", () => {
  beforeEach(() => {
    resetMessageStore()
    loadMessagesIntoStore(threadId, [])
  })

  it("the newer turn shows beside the older one while the older still answers", () => {
    frame("start", "ask-1", { seq: 1 })
    frame("reasoning", "ask-1", { delta: "Looking it up", seq: 2 })
    frame("accepted", "ask-2")
    expect(getLiveAgentStreams(threadId)).toHaveLength(2)
    expect(getChannelAgentStream(threadId).turnId).toBe("ask-2")

    // The older reply lands before the newer turn's setup is done.
    agentReply("reply-1", "ask-1", "The answer.")
    frame("done", "ask-1", { seq: 3 })
    expect(getLiveAgentStreams(threadId).map((r) => r.stream.turnId)).toEqual(["ask-2"])

    // Its start takes the block over: still one block, now drawing frames.
    frame("start", "ask-2", { seq: 1 })
    frame("delta", "ask-2", { delta: "Created it.", seq: 2 })
    const live = getLiveAgentStreams(threadId)
    expect(live).toHaveLength(1)
    expect(live[0]?.stream.content).toBe("Created it.")
  })

  it("two turns accepted before either starts stay two blocks, never three", () => {
    frame("accepted", "ask-1")
    frame("accepted", "ask-2")
    expect(getLiveAgentStreams(threadId)).toHaveLength(2)
    // The older start lands after the newer turn was accepted.
    frame("start", "ask-1", { seq: 1 })
    frame("delta", "ask-1", { delta: "older", seq: 2 })
    expect(getLiveAgentStreams(threadId)).toHaveLength(2)
    frame("start", "ask-2", { seq: 1 })
    frame("delta", "ask-2", { delta: "newer", seq: 2 })
    const live = getLiveAgentStreams(threadId)
    expect(live.map((r) => r.stream.content).sort()).toEqual(["newer", "older"])
    expect(getChannelAgentStream(threadId).turnId).toBe("ask-2")
  })

  it("an accepted frame that arrives after its start redraws nothing", () => {
    frame("start", "ask-1", { seq: 1 })
    frame("delta", "ask-1", { delta: "drawn", seq: 2 })
    frame("accepted", "ask-1")
    const live = getLiveAgentStreams(threadId)
    expect(live).toHaveLength(1)
    expect(live[0]?.stream.content).toBe("drawn")
  })

  it("an accepted frame of a turn already answered opens no block", () => {
    agentReply("reply-1", "ask-1", "The answer.")
    frame("accepted", "ask-1")
    expect(getLiveAgentStreams(threadId)).toHaveLength(0)
  })

  it("a withdrawn turn's empty block goes; a started one stays", () => {
    frame("start", "ask-1", { seq: 1 })
    frame("accepted", "ask-2")
    frame("withdrawn", "ask-2")
    expect(getLiveAgentStreams(threadId).map((r) => r.stream.turnId)).toEqual(["ask-1"])
    frame("withdrawn", "ask-1")
    expect(getLiveAgentStreams(threadId).map((r) => r.stream.turnId)).toEqual(["ask-1"])
  })
})
