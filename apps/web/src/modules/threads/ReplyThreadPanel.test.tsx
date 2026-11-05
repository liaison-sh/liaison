// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S10 / S12: the reply thread panel. It shows the root and its replies,
// marks the thread read when it opens, sends into the thread (optionally to
// the channel too), closes on its button and on Escape, and its own
// selection quote lands in its own composer.

import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createSignal, type JSX } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { editorOf, typeInto } from "~/modules/editor/test-helpers"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { ApiProvider } from "~/modules/shell/ApiContext"
import {
  handleWsMessageEvent,
  loadMessagesIntoStore,
  resetMessageStore,
} from "~/modules/threads/message-store"
import { resetQuoteDrafts } from "~/modules/threads/quote-store"
import ReplyThreadPanel from "~/modules/threads/ReplyThreadPanel"

const threadId = "11111111-1111-4111-8111-111111111111"
const rootId = "22222222-2222-4222-8222-222222222222"
const replyId = "33333333-3333-4333-8333-333333333333"
const newId = "44444444-4444-4444-8444-444444444444"

function row(overrides: Record<string, unknown>) {
  return {
    id: rootId,
    threadId,
    authorId: "u-root",
    authorName: "Alice",
    authorAvatarUrl: null,
    authorType: "user",
    authorAgentId: null,
    content: "Where is the Q3 file?",
    mentions: null,
    metadata: null,
    reactions: [],
    editedAt: null,
    deletedAt: null,
    createdAt: "2026-09-28T10:00:00.000Z",
    replyRootId: null,
    alsoInChannel: false,
    replyCount: 1,
    lastReplyAt: "2026-09-28T10:05:00.000Z",
    replyAuthors: [{ id: "u-bob", name: "Bob", avatarUrl: null }],
    ...overrides,
  }
}

const calls: Array<{ url: string; method: string; body: any }> = []
let replyAuthorId = "u-bob"

function respond(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null),
    },
    text: async () => JSON.stringify(body),
    json: async () => body,
  }
}

const fetchMock = vi.fn(async (input: string, init?: { method?: string; body?: string }) => {
  const url = String(input)
  const method = init?.method ?? "GET"
  calls.push({ url, method, body: init?.body ? JSON.parse(init.body) : null })
  if (method === "GET" && url.includes(`/messages/${rootId}/replies`)) {
    return respond({
      data: {
        root: row({}),
        replies: [
          row({
            id: replyId,
            replyRootId: rootId,
            authorId: replyAuthorId,
            authorName: "Bob",
            content: "It is in the **shared** drive, folder Finance.",
            createdAt: "2026-09-28T10:05:00.000Z",
            replyCount: 0,
            lastReplyAt: null,
            replyAuthors: [],
          }),
        ],
      },
      meta: { hasMore: false, cursor: null, hiddenRuns: [] },
    })
  }
  if (method === "POST" && url.endsWith("/replies/read")) {
    return respond({ data: { ok: true, following: true } })
  }
  if (method === "POST" && url.endsWith(`/threads/${threadId}/messages`)) {
    const sent = init?.body ? JSON.parse(init.body) : {}
    return respond({
      data: row({
        id: newId,
        replyRootId: rootId,
        alsoInChannel: false,
        authorId: "me",
        authorName: "Me",
        content: sent.content,
        createdAt: "2026-09-28T10:09:00.000Z",
        replyCount: 0,
        lastReplyAt: null,
        replyAuthors: [],
      }),
    })
  }
  return respond({ data: [] })
})
vi.stubGlobal("fetch", fetchMock)

const renderContent = (content: string): JSX.Element => content.replace(/\*\*/g, "")

function renderPanel(onClose = vi.fn(), compact?: boolean, showClose?: boolean) {
  render(() => (
    <Router>
      <Route
        path="/*"
        component={() => (
          <I18nProvider initialLocale="en">
            <ApiProvider>
              <ReplyThreadPanel
                threadId={threadId}
                rootId={rootId}
                currentUserId="me"
                onClose={onClose}
                compact={compact}
                showClose={showClose}
                renderContent={renderContent}
              />
            </ApiProvider>
          </I18nProvider>
        )}
      />
    </Router>
  ))
  return { onClose }
}

async function typeAndSend(text: string) {
  const editor = await screen.findByTestId("compose-editor")
  typeInto(editorOf(editor), text)
  fireEvent.click(screen.getByTestId("compose-send"))
}

function sentBody(): any {
  return calls.find((c) => c.method === "POST" && c.url.endsWith(`/threads/${threadId}/messages`))
    ?.body
}

beforeEach(() => {
  calls.length = 0
  replyAuthorId = "u-bob"
  fetchMock.mockClear()
  resetMessageStore()
  resetQuoteDrafts()
  loadMessagesIntoStore(threadId, [row({}) as never])
})

afterEach(() => {
  cleanup()
  window.getSelection()?.removeAllRanges()
})

describe("ReplyThreadPanel", () => {
  it("shows the root and its replies and marks the thread read on open", async () => {
    renderPanel()
    await screen.findByText("It is in the shared drive, folder Finance.")
    const panel = screen.getByTestId("reply-thread-panel")
    expect(panel.textContent).toContain("Where is the Q3 file?")
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.method === "POST" &&
            c.url.endsWith(`/threads/${threadId}/messages/${rootId}/replies/read`),
        ),
      ).toBe(true),
    )
  })

  // QA THR-10: the seat line an agent mention posts in the reply thread
  // ("Taylor added Base") is shown there, but it is not a reply.
  it("does not count a system line in the thread as a reply", async () => {
    renderPanel()
    await screen.findByText("It is in the shared drive, folder Finance.")
    handleWsMessageEvent("create", {
      id: newId,
      threadId,
      authorId: "u-bob",
      authorName: null,
      authorType: "system",
      authorAgentId: null,
      replyRootId: rootId,
      alsoInChannel: false,
      content: "Bob added Base",
      createdAt: "2026-09-28T10:06:00.000Z",
    })
    const panel = screen.getByTestId("reply-thread-panel")
    await waitFor(() => expect(panel.textContent).toContain("Bob added Base"))
    expect(panel.textContent).toContain("1 reply")
    expect(panel.textContent).not.toContain("2 replies")
  })

  it("sends a reply into the thread only: no also-send-to-channel box", async () => {
    renderPanel()
    await screen.findByText("It is in the shared drive, folder Finance.")
    expect(screen.queryByTestId("reply-also-send-to-channel")).toBeNull()
    await typeAndSend("Thanks!")
    await waitFor(() => expect(sentBody()).toBeTruthy())
    expect(sentBody()).toMatchObject({ content: "Thanks!", replyRootId: rootId })
    expect(sentBody()).not.toHaveProperty("alsoSendToChannel")
  })

  it("keeps its composer on the channel's bottom line, clear of the dock's floating bar", async () => {
    // The rail's composer was always compact (8px under it): on the full
    // surface the dock's pills sat over its send button, 50px below the
    // channel composer's edge. It follows the host's compact now.
    renderPanel()
    await screen.findByText("It is in the shared drive, folder Finance.")
    const bar = screen.getByTestId("compose-dropzone")
    expect(bar.className).toContain("--shell-dock-clearance")
    cleanup()
    renderPanel(vi.fn(), true)
    await screen.findByText("It is in the shared drive, folder Finance.")
    expect(screen.getByTestId("compose-dropzone").className).not.toContain("--shell-dock-clearance")
  })

  it("has no close button on the phone, where the nav bar's back arrow closes it", async () => {
    renderPanel(vi.fn(), false, false)
    await screen.findByTestId("reply-thread-panel")
    expect(screen.queryByTestId("reply-thread-close")).toBeNull()
  })

  it("closes on its button and on Escape", async () => {
    const { onClose } = renderPanel()
    fireEvent.click(screen.getByTestId("reply-thread-close"))
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(document, { key: "Escape" })
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it("quotes a selection of a reply into the panel's own composer and sends it", async () => {
    renderPanel()
    const text = await screen.findByText("It is in the shared drive, folder Finance.")
    const node = text.firstChild as Text
    const content = node.textContent ?? ""
    const start = content.indexOf("shared drive")
    const range = document.createRange()
    range.setStart(node, start)
    range.setEnd(node, start + "shared drive".length)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    fireEvent.mouseUp(text)

    fireEvent.click(await screen.findByTestId("quote-selection-button"))
    const chip = await screen.findByTestId("compose-quote-chip")
    expect(chip.textContent).toContain("Bob")
    expect(chip.textContent).toContain("shared drive")

    await typeAndSend("Which folder exactly?")
    await waitFor(() => expect(sentBody()).toBeTruthy())
    // The excerpt is mapped back onto the message's own text, markup
    // included, so the server finds it in the stored content.
    expect(sentBody().quote).toEqual({ messageId: replyId, excerpt: "**shared** drive" })
    expect(sentBody().replyRootId).toBe(rootId)
    await waitFor(() => expect(screen.queryByTestId("compose-quote-chip")).toBeNull())
  })

  it("focuses its composer when it opens (THR-01)", async () => {
    const opener = document.createElement("button")
    document.body.appendChild(opener)
    opener.focus()
    expect(document.activeElement).toBe(opener)
    renderPanel()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("compose-editor")))
    opener.remove()
  })

  it("Escape in a reaction picker opened in the panel closes the picker, not the panel (THR-06)", async () => {
    const { onClose } = renderPanel()
    await screen.findByText("It is in the shared drive, folder Finance.")
    const triggers = screen.getAllByLabelText("Add reaction")
    fireEvent.click(triggers[triggers.length - 1]!)
    const favorites = await screen.findByTestId("reaction-favorites")
    fireEvent.keyDown(favorites, { key: "Escape" })
    await waitFor(() => expect(screen.queryByTestId("reaction-favorites")).toBeNull())
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByTestId("reply-thread-panel")).toBeTruthy()
    // The next Escape, with nothing open inside, closes the panel.
    fireEvent.keyDown(document, { key: "Escape" })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("Escape while editing a reply cancels the edit and leaves the panel open (THR-06)", async () => {
    replyAuthorId = "me"
    const { onClose } = renderPanel()
    await screen.findByText("It is in the shared drive, folder Finance.")
    const triggers = screen.getAllByLabelText("Message actions")
    await fireEvent.pointerDown(triggers[triggers.length - 1]!)
    const edit = (await screen.findByText("Edit")).closest('[role="menuitem"]') as HTMLElement
    fireEvent.pointerDown(edit, { pointerType: "mouse" })
    fireEvent.pointerUp(edit, { pointerType: "mouse" })
    const field = await screen.findByTestId("message-edit-field")
    // The row's hover actions leave while it is edited (they sat on its text).
    expect(screen.getAllByLabelText("Message actions")).toHaveLength(triggers.length - 1)
    fireEvent.keyDown(field, { key: "Escape" })
    await waitFor(() => expect(screen.queryByTestId("message-edit-field")).toBeNull())
    expect(onClose).not.toHaveBeenCalled()
  })

  it("focuses its composer again when the open panel switches to another root (THR-01)", async () => {
    const [root, setRoot] = createSignal(rootId)
    render(() => (
      <Router>
        <Route
          path="/*"
          component={() => (
            <I18nProvider initialLocale="en">
              <ApiProvider>
                <ReplyThreadPanel
                  threadId={threadId}
                  rootId={root()}
                  currentUserId="me"
                  onClose={vi.fn()}
                  renderContent={renderContent}
                />
              </ApiProvider>
            </I18nProvider>
          )}
        />
      </Router>
    ))
    const editor = await screen.findByTestId("compose-editor")
    await waitFor(() => expect(document.activeElement).toBe(editor))
    const opener = document.createElement("button")
    document.body.appendChild(opener)
    opener.focus()
    setRoot(newId)
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("compose-editor")))
    opener.remove()
  })
})
