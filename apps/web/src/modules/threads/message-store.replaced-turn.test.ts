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
