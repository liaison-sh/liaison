// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * A conversation learns which turns run from the server, not only from live
 * frames. A page reloaded just after the ask was sent (the turn taken on, its
 * first frame still to come) and a socket that came back after missing a
 * turn's start both used to show nothing live until the next frame: no
 * "Working" block, and a guided step offering to send the ask again.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
})

import { requestResync } from "~/framework/resync"
import {
  getChannelAgentStream,
  loadMessages,
  loadMessagesIntoStore,
  resetMessageStore,
  seedAgentStreamState,
  subscribeMessageResync,
} from "~/modules/threads/message-store"

const threadId = "t-running"
const agentId = "agent-1"

/** The run the server lists for a turn taken on and not yet streaming. */
const acceptedRun = {
  agentId,
  turnId: "ask-1",
  state: "streaming",
  content: "",
  reasoning: "",
  reasoningStreaming: false,
  toolCalls: [],
  timeline: [],
}

const ask = {
  id: "ask-1",
  threadId,
  authorId: "u1",
  authorName: "Visitor",
  authorAvatarUrl: null,
  authorType: "user" as const,
  authorAgentId: null,
  content: "Add an internal note to this ticket",
  mentions: null,
  metadata: {},
  reactions: [],
  editedAt: null,
  deletedAt: null,
  createdAt: new Date().toISOString(),
}

/** A server whose stream-state answer the test sets. */
function server() {
  const state = { running: false }
  const api = {
    get: vi.fn(async (path: string) => {
      if (path.startsWith("/agent/stream-state/")) {
        return state.running
          ? { data: { active: true, ...acceptedRun, streams: [acceptedRun] } }
          : { data: { active: false } }
      }
      return { data: [ask] }
    }),
  }
  return { api, state }
}

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe("a turn the server runs, before any of its frames reached this page", () => {
  beforeEach(() => resetMessageStore())

  it("a reload: the server's word draws the turn's live block at once", async () => {
    loadMessagesIntoStore(threadId, [ask])
    const { api, state } = server()
    state.running = true
    await seedAgentStreamState(api, threadId)
    const stream = getChannelAgentStream(threadId)
    expect(stream.state).toBe("streaming")
    expect(stream.turnId).toBe("ask-1")
  })

  it("a resync: a turn that started while the socket was away is drawn live", async () => {
    const { api, state } = server()
    await loadMessages(api, threadId)
    expect(getChannelAgentStream(threadId).state).toBe("idle")
    subscribeMessageResync()
    state.running = true
    requestResync("ws-reconnect")
    await flush()
    const stream = getChannelAgentStream(threadId)
    expect(stream.state).toBe("streaming")
    expect(stream.turnId).toBe("ask-1")
  })
})
