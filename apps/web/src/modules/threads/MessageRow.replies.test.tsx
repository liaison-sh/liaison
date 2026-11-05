// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S10 / S14 on the message row: "Reply in thread" on human AND agent rows,
// the summary line under a root, and the quote block above a quoting message.

import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import type { JSX } from "solid-js"
import { afterEach, describe, expect, it, vi } from "vitest"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { ApiProvider } from "~/modules/shell/ApiContext"
import MessageRow from "~/modules/threads/MessageRow"
import type { Message } from "~/modules/threads/message-store"

function makeMessage(overrides: Partial<Message>): Message {
  return {
    id: "m1",
    threadId: "t1",
    authorId: "u1",
    authorName: "Bob Martinez",
    authorAvatarUrl: null,
    authorType: "user",
    authorAgentId: null,
    content: "Hello",
    mentions: null,
    metadata: null,
    reactions: [],
    attachments: [],
    editedAt: null,
    deletedAt: null,
    createdAt: new Date("2026-05-21T10:00:00Z").toISOString(),
    ...overrides,
  }
}

const noop = () => {}
const renderContent = (content: string): JSX.Element => content

function renderRow(
  message: Message,
  handlers: {
    onReplyInThread?: (id: string) => void
    onQuoteClick?: (q: unknown) => void
    locale?: "en" | "fr"
  } = {},
) {
  return render(() => (
    <Router>
      <Route
        path="/*"
        component={() => (
          <I18nProvider initialLocale={handlers.locale ?? "en"}>
            <ApiProvider>
              <MessageRow
                message={message}
                grouped={false}
                currentUserId="viewer"
                onEdit={noop}
                onDelete={noop}
                onReaction={noop}
                onRemoveReaction={noop}
                renderContent={renderContent}
                onReplyInThread={handlers.onReplyInThread}
                onQuoteClick={handlers.onQuoteClick as never}
              />
            </ApiProvider>
          </I18nProvider>
        )}
      />
    </Router>
  ))
}

afterEach(cleanup)

describe("MessageRow reply threads", () => {
  it("offers Reply in thread on a human row", () => {
    const onReply = vi.fn()
    renderRow(makeMessage({ id: "h1" }), { onReplyInThread: onReply })
    fireEvent.click(screen.getByTestId("message-reply-in-thread-h1"))
    expect(onReply).toHaveBeenCalledWith("h1")
  })

  it("offers Reply in thread on an agent row", () => {
    const onReply = vi.fn()
    renderRow(
      makeMessage({ id: "a1", authorType: "agent", authorAgentId: "ag-1", authorName: "Data" }),
      { onReplyInThread: onReply },
    )
    fireEvent.click(screen.getByTestId("message-reply-in-thread-a1"))
    expect(onReply).toHaveBeenCalledWith("a1")
  })

  it("draws no reply action on a reply itself", () => {
    renderRow(makeMessage({ id: "r1", replyRootId: "root" }), { onReplyInThread: vi.fn() })
    expect(screen.queryByTestId("message-reply-in-thread-r1")).toBeNull()
  })

  it("draws the summary under a root and opens the thread from it", () => {
    const onReply = vi.fn()
    renderRow(
      makeMessage({
        id: "root",
        replyCount: 2,
        lastReplyAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        replyAuthors: [
          { id: "u2", name: "Carol", avatarUrl: null },
          { id: "u3", name: "Dan", avatarUrl: null },
        ],
      }),
      { onReplyInThread: onReply, locale: "fr" },
    )
    const summary = screen.getByTestId("reply-summary-root")
    expect(summary.textContent).toContain("2 réponses")
    expect(summary.querySelectorAll("[data-testid='reply-summary-avatar']").length).toBe(2)
    fireEvent.click(summary)
    expect(onReply).toHaveBeenCalledWith("root")
  })

  it("renders the quote block above the content and jumps from it", () => {
    const onQuote = vi.fn()
    const quote = {
      messageId: "src",
      excerpt: "the **Q3** file",
      authorName: "Alice",
      replyRootId: null,
    }
    renderRow(makeMessage({ id: "q1", content: "Found it", metadata: { quote } }), {
      onQuoteClick: onQuote,
    })
    const block = screen.getByTestId("message-quote-q1")
    expect(block.textContent).toContain("Alice")
    expect(block.textContent).toContain("the Q3 file")
    fireEvent.click(block)
    expect(onQuote).toHaveBeenCalledWith(quote)
  })
})
