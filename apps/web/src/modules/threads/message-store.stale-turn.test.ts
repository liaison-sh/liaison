// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * A conversation opened (or reloaded) just as the agent's turn ends: the
 * stream-state snapshot is read while the server still lists the turn, and the
 * turn's reply and end reach the socket before that snapshot comes back. The
 * snapshot must not bring the ended turn back as a live block (a typing cursor
 * under the finished answer, then "Stuck"), and a live block the server no
 * longer runs clears when the server is asked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  getChannelAgentStream,
  handleWsAgentStreamEvent,
  handleWsMessageEvent,
  loadMessages,
  loadMessagesIntoStore,
  reconcileAgentStreamsWithServer,
  resetMessageStore,
  seedAgentStreamState,
} from "~/modules/threads/message-store"

const threadId = "t-stale"
const agentId = "agent-1"

function frame(action: string, turnId: string, extra: Record<string, unknown> = {}) {
  handleWsAgentStreamEvent(action, { threadId, agentId, turnId, ...extra })
}

function agentReply(id: string, turnId: string, content: string) {
  handleWsMessageEvent("create", {
    id,
    threadId,
    authorId: "u1",
    authorType: "agent",
    authorAgentId: agentId,
    content,
    metadata: { turnId },
    createdAt: new Date().toISOString(),
  })
}

/** A snapshot the server answers with only once `release` is called. */
function deferredSnapshot(run: Record<string, unknown> | null) {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const api = {
    get: async (path: string) => {
      await gate
      if (path.startsWith("/agent/stream-state/")) {
        return run
          ? { data: { active: true, ...run, streams: [run] } }
          : { data: { active: false } }
      }
      return { data: [] }
    },
  }
  return { api, release: () => release() }
}

const liveRun = {
  agentId,
  turnId: "ask-1",
  state: "streaming",
  content: "Here is where things stand. Shall I continue",
  reasoning: "",
  reasoningStreaming: false,
  toolCalls: [],
  timeline: [],
}

describe("a snapshot read across the end of the turn", () => {
  beforeEach(() => {
    resetMessageStore()
    loadMessagesIntoStore(threadId, [])
  })

  it("does not bring back a turn whose reply and end arrived while it was on the wire", async () => {
    const { api, release } = deferredSnapshot(liveRun)
    const seeding = seedAgentStreamState(api, threadId)
    agentReply("reply-1", "ask-1", "Here is where things stand. Shall I continue?")
    frame("done", "ask-1")
    release()
    await seeding
    expect(getChannelAgentStream(threadId).state).toBe("idle")
  })

  it("does not seed a turn whose reply the loaded page already holds (a reload)", async () => {
    resetMessageStore()
    loadMessagesIntoStore(threadId, [
      {
        id: "reply-1",
        threadId,
        authorId: "u1",
        authorName: "Agent",
        authorAvatarUrl: null,
        authorType: "agent",
        authorAgentId: agentId,
        content: "Here is where things stand.",
        mentions: null,
        metadata: { turnId: "ask-1" },
        reactions: [],
        editedAt: null,
        deletedAt: null,
        createdAt: new Date().toISOString(),
      },
    ])
    const { api, release } = deferredSnapshot(liveRun)
    release()
    await seedAgentStreamState(api, threadId)
    expect(getChannelAgentStream(threadId).state).toBe("idle")
  })

  it("a page that brings the turn's reply ends its live block", async () => {
    frame("start", "ask-1")
    frame("delta", "ask-1", { delta: "Here is where things stand." })
    const api = {
      get: async () => ({
        data: [
          {
            id: "reply-1",
            threadId,
            authorId: "u1",
            authorType: "agent",
            authorAgentId: agentId,
            content: "Here is where things stand.",
            metadata: { turnId: "ask-1" },
            reactions: [],
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    }
    await loadMessages(api, threadId)
    expect(getChannelAgentStream(threadId).state).toBe("idle")
  })

  it("still seeds a turn that is running", async () => {
    const { api, release } = deferredSnapshot(liveRun)
    release()
    await seedAgentStreamState(api, threadId)
    expect(getChannelAgentStream(threadId).state).toBe("streaming")
  })
})

describe("asking the server about a live block", () => {
  beforeEach(() => {
    resetMessageStore()
    loadMessagesIntoStore(threadId, [])
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** The clock moves on with no frame for the block. */
  function quietFor(ms: number) {
    const later = Date.now() + ms
    vi.spyOn(Date, "now").mockReturnValue(later)
  }

  it("clears a quiet block the server no longer runs", async () => {
    frame("start", "ask-1")
    frame("delta", "ask-1", { delta: "Shall I continue" })
    quietFor(60_000)
    const { api, release } = deferredSnapshot(null)
    release()
    await reconcileAgentStreamsWithServer(api, threadId)
    expect(getChannelAgentStream(threadId).state).toBe("idle")
  })

  it("keeps a quiet block the server still runs", async () => {
    frame("start", "ask-1")
    quietFor(60_000)
    const { api, release } = deferredSnapshot(liveRun)
    release()
    await reconcileAgentStreamsWithServer(api, threadId)
    expect(getChannelAgentStream(threadId).state).toBe("streaming")
  })

  it("keeps a block that streamed recently, whatever the server says", async () => {
    frame("start", "ask-1")
    frame("delta", "ask-1", { delta: "Working" })
    const { api, release } = deferredSnapshot(null)
    release()
    await reconcileAgentStreamsWithServer(api, threadId)
    expect(getChannelAgentStream(threadId).state).toBe("streaming")
  })
})
