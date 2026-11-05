// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A32: a local session's input is the conversation. The store that already
// learns about every message is what asks the shell to run it.
//
// It used to say so by dispatching an event on the document, which anything in
// the page could dispatch too. Since P6d-T16b it asks the BRIDGE, by message
// id, and the shell re-reads that message from the server before anything
// runs. What is pinned here is unchanged: one ask per message, from whichever
// of the two racing paths learns about it first, and never for the agent's own
// reply.

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  ASKED_STORAGE_KEY,
  forgetLocalTurnsInThisWindow,
  resetLocalTurnMessages,
} from "~/modules/desktop/desktop-store"
import { installFakeBridge, uninstallFakeBridge } from "~/modules/desktop/fake-bridge"
import {
  handleWsMessageEvent,
  loadMessagesIntoStore,
  resetMessageStore,
  sendMessage,
} from "~/modules/threads/message-store"

const threadId = "t-local"

function seed() {
  return {
    id: "m1",
    threadId,
    authorId: "u1",
    authorName: "Alice",
    authorAvatarUrl: null,
    authorType: "user",
    authorAgentId: null,
    content: "Hello",
    mentions: null,
    reactions: [],
    editedAt: null,
    deletedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
  }
}

describe("the message store asks the shell to run new messages", () => {
  let shell: ReturnType<typeof installFakeBridge>
  let seen: string[]

  beforeEach(() => {
    resetMessageStore()
    resetLocalTurnMessages()
    loadMessagesIntoStore(threadId, [seed()])
    // A LIVE SESSION ON THIS CONVERSATION. Without one the shell is asked
    // nothing, which is the case below.
    shell = installFakeBridge({
      sessionStatus: "running",
      threadId,
      agentId: "a1",
    })
    seen = shell.calls.turns
  })

  afterEach(() => {
    uninstallFakeBridge()
  })

  function stop() {
    // Nothing to unsubscribe any more; kept so each case reads the same way.
  }

  it("asks for a human message arriving over the socket", () => {
    handleWsMessageEvent("create", {
      id: "m2",
      threadId,
      authorId: "u1",
      authorName: "Alice",
      authorType: "user",
      content: "@[Liaison](agent:a1) create hello.txt",
      createdAt: "2026-01-01T00:01:00Z",
    })
    stop()
    expect(seen).toEqual(["m2"])
  })

  it("asks nothing for the agent's own reply", () => {
    handleWsMessageEvent("create", {
      id: "m3",
      threadId,
      authorId: "u1",
      authorName: "Liaison",
      authorType: "agent",
      authorAgentId: "a1",
      content: "Done.",
      createdAt: "2026-01-01T00:02:00Z",
    })
    stop()
    expect(seen).toEqual([])
  })

  // THE DEFECT THE DRIVEN WALK FOUND: the message the person at this machine
  // types is answered by the POST before the socket frame arrives, so the
  // socket path alone asked for nothing and the local session sat idle while
  // its own conversation filled up.
  it("asks for the sender's own message from the send path", async () => {
    const api = {
      post: async () => ({
        data: {
          id: "m-sent",
          threadId,
          authorId: "u1",
          authorName: "Alice",
          authorType: "user",
          content: "Create a file named hello.txt",
          createdAt: "2026-01-01T00:05:00Z",
        },
      }),
    }
    await sendMessage(api as never, threadId, "Create a file named hello.txt", {
      id: "u1",
      name: "Alice",
    })
    stop()
    expect(seen).toEqual(["m-sent"])
  })

  it("does not ask for the sender's own message a second time over the socket", async () => {
    const sent = {
      id: "m-sent2",
      threadId,
      authorId: "u1",
      authorName: "Alice",
      authorType: "user",
      content: "again",
      createdAt: "2026-01-01T00:06:00Z",
    }
    await sendMessage({ post: async () => ({ data: sent }) } as never, threadId, "again", {
      id: "u1",
      name: "Alice",
    })
    handleWsMessageEvent("create", sent)
    stop()
    expect(seen).toHaveLength(1)
  })

  it("asks once, even when the same create arrives twice", () => {
    const event = {
      id: "m4",
      threadId,
      authorId: "u1",
      authorName: "Alice",
      authorType: "user",
      content: "again",
      createdAt: "2026-01-01T00:03:00Z",
    }
    handleWsMessageEvent("create", event)
    handleWsMessageEvent("create", event)
    stop()
    expect(seen).toHaveLength(1)
  })

  // P6d-FX2 (SK-6): TWO TABS ARE ONE MACHINE. A module level Set is per
  // window, so two tabs open on one conversation ran the same message twice and
  // paid for two turns. The record the tabs share is what stops it, and until
  // now nothing drove a second window at all: a regression in the shared read
  // was free.
  it("a second tab of the same app asks for a message the first tab already ran", () => {
    const event = {
      id: "m-cross-tab",
      threadId,
      authorId: "u1",
      authorName: "Alice",
      authorType: "user",
      content: "one message, two tabs",
      createdAt: "2026-01-01T00:08:00Z",
    }
    handleWsMessageEvent("create", event)
    expect(seen).toEqual(["m-cross-tab"])
    // What a freshly opened second tab starts with: its own empty window
    // memory, and the record every tab of this origin shares.
    forgetLocalTurnsInThisWindow()
    expect(localStorage.getItem(ASKED_STORAGE_KEY) ?? "").toContain("m-cross-tab")
    handleWsMessageEvent("create", event)
    stop()
    expect(seen).toEqual(["m-cross-tab"])
  })

  it("a second tab with no shared record of its own still asks once", () => {
    const event = {
      id: "m-first-run",
      threadId,
      authorId: "u1",
      authorName: "Alice",
      authorType: "user",
      content: "nothing has run this yet",
      createdAt: "2026-01-01T00:09:00Z",
    }
    // The shared record is empty, so the second window is the FIRST to ask,
    // which is the half that must still work.
    forgetLocalTurnsInThisWindow()
    localStorage.removeItem(ASKED_STORAGE_KEY)
    handleWsMessageEvent("create", event)
    handleWsMessageEvent("create", event)
    stop()
    expect(seen).toEqual(["m-first-run"])
  })

  // A BROWSER, AND A DESKTOP WITH NO SESSION ON THIS CONVERSATION, ask for
  // nothing. The store is the same store in all three cases; what differs is
  // whether a shell is holding this thread.
  it("asks nothing when the live session is another conversation's", () => {
    shell.push({ sessionStatus: "running", threadId: "somewhere-else", agentId: "a1" })
    handleWsMessageEvent("create", {
      id: "m5",
      threadId,
      authorId: "u1",
      authorName: "Alice",
      authorType: "user",
      content: "not for this machine",
      createdAt: "2026-01-01T00:07:00Z",
    })
    stop()
    expect(seen).toEqual([])
  })

  it("asks nothing in a browser, where there is no shell at all", () => {
    uninstallFakeBridge()
    handleWsMessageEvent("create", {
      id: "m6",
      threadId,
      authorId: "u1",
      authorName: "Alice",
      authorType: "user",
      content: "just a message",
      createdAt: "2026-01-01T00:08:00Z",
    })
    expect(seen).toEqual([])
  })
})
