// SPDX-License-Identifier: FSL-1.1-ALv2
// The task discussion reads as a chat: the comments run oldest to newest, the
// comment box sits under the newest one, and a comment posted by someone else
// (a teammate, an agent answering a mention) appears in the open discussion as
// its socket event lands, the list following it down unless the reader scrolled
// up to read. Driven through the real message store, the way the socket feeds it.
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ApiClient } from "~/lib/api-client"
import { TaskDiscussion } from "~/modules/projects/TaskDiscussion"
import { ApiContext } from "~/modules/shell/ApiContext"
import { handleWsMessageEvent, resetMessageStore } from "~/modules/threads/message-store"

vi.mock("~/modules/auth/auth-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/modules/auth/auth-store")>()),
  userFromToken: () => ({ userId: "u-me", name: "Me Myself" }),
}))

const THREAD = "thread-chat-flow"

const row = (id: string, minute: number, content: string, extra: Record<string, unknown> = {}) => ({
  id,
  threadId: THREAD,
  authorId: "u-ada",
  authorName: "Ada Fabrikam",
  authorType: "user",
  content,
  mentions: null,
  reactions: [],
  editedAt: null,
  deletedAt: null,
  createdAt: new Date(Date.UTC(2026, 0, 5, 9, minute)).toISOString(),
  ...extra,
})

// The server pages a thread newest first.
const PAGE = [row("m-3", 30, "third"), row("m-2", 20, "second"), row("m-1", 10, "first")]

function fakeApi(): ApiClient {
  const get = vi.fn(async (path: string) => {
    if (path.startsWith(`/threads/${THREAD}/messages`)) return { data: PAGE }
    return {}
  })
  return { get, rawGet: vi.fn(), post: vi.fn(), patch: vi.fn() } as unknown as ApiClient
}

function renderDiscussion() {
  return render(() => (
    <ApiContext.Provider value={fakeApi()}>
      <TaskDiscussion threadId={THREAD} />
    </ApiContext.Provider>
  ))
}

/** jsdom lays nothing out: give the scroller a viewport and a content height. */
function layOut(el: HTMLElement, box: { scrollHeight: number; clientHeight: number }) {
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => box.scrollHeight })
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => box.clientHeight })
}

const bodies = () =>
  screen.getAllByTestId("task-discussion.message-body").map((b) => b.textContent?.trim())

afterEach(() => {
  cleanup()
  resetMessageStore()
})

describe("TaskDiscussion as a chat", () => {
  it("lists the comments oldest first and puts the comment box under the newest", async () => {
    renderDiscussion()
    await waitFor(() => expect(bodies()).toEqual(["first", "second", "third"]))

    const list = screen.getByTestId("task-discussion.messages")
    const composer = screen.getByTestId("task-discussion.dropzone")
    // The box follows the list in the page: it is the discussion's bottom row.
    expect(list.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // The list scrolls on its own above the box, which stays put.
    const scroller = screen.getByTestId("task-discussion.scroller")
    expect(scroller.contains(list)).toBe(true)
    expect(scroller.contains(composer)).toBe(false)
  })

  it("an agent's reply arriving on the socket appears at the bottom of the open discussion", async () => {
    renderDiscussion()
    await waitFor(() => expect(bodies()).toHaveLength(3))

    handleWsMessageEvent(
      "create",
      row("m-agent", 40, "Here is what I found.", {
        authorId: "u-me",
        authorName: "Support Desk",
        authorType: "agent",
        authorAgentId: "agent-desk",
      }),
    )

    await waitFor(() =>
      expect(bodies()).toEqual(["first", "second", "third", "Here is what I found."]),
    )
  })

  it("opens at the newest comment and follows new ones, but never yanks a reader who scrolled up", async () => {
    renderDiscussion()
    await waitFor(() => expect(bodies()).toHaveLength(3))
    const scroller = screen.getByTestId("task-discussion.scroller")
    const box = { scrollHeight: 900, clientHeight: 300 }
    layOut(scroller, box)

    // A new comment while at the bottom: the view follows it.
    box.scrollHeight = 1000
    handleWsMessageEvent("create", row("m-4", 40, "fourth"))
    await waitFor(() => expect(scroller.scrollTop).toBe(700))

    // The reader scrolls up to read an older comment.
    scroller.scrollTop = 100
    scroller.dispatchEvent(new Event("scroll"))

    box.scrollHeight = 1100
    handleWsMessageEvent("create", row("m-5", 50, "fifth"))
    await waitFor(() => expect(bodies()).toContain("fifth"))
    expect(scroller.scrollTop).toBe(100)
  })
})
