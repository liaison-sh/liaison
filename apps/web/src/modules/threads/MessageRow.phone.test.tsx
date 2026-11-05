// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A touch screen has no hover. Everything the hover toolbar and the reaction
// chip hint offer a mouse must be reachable by a finger: a tap or a long press
// on a message opens its action sheet (quote included), and a tap or a long
// press on a reaction chip opens the reactions card. A finger's tap on a chip
// never toggles a reaction; a mouse click still does.
import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library"
import type { JSX } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { ApiProvider } from "~/modules/shell/ApiContext"
import MessageRow from "~/modules/threads/MessageRow"
import type { Message } from "~/modules/threads/message-store"
import { getQuoteDraft, resetQuoteDrafts } from "~/modules/threads/quote-store"
import { LONG_PRESS_MS } from "~/ui/SwipeRow"

function makeMessage(overrides: Partial<Message>): Message {
  return {
    id: "m1",
    threadId: "t1",
    authorId: "viewer",
    authorName: "Bob Martinez",
    authorAvatarUrl: null,
    authorType: "user",
    authorAgentId: null,
    content: "Ship it **today**",
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

const renderContent = (content: string): JSX.Element => content

function renderRow(
  message: Message,
  locale: "en" | "fr" = "en",
  content: (content: string) => JSX.Element = renderContent,
) {
  const handlers = {
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onReaction: vi.fn(),
    onRemoveReaction: vi.fn(),
    onReplyInThread: vi.fn(),
  }
  render(() => (
    <Router>
      <Route
        path="/*"
        component={() => (
          <I18nProvider initialLocale={locale}>
            <ApiProvider>
              <MessageRow
                message={message}
                grouped={false}
                currentUserId="viewer"
                renderContent={content}
                quoteSurfaceKey="t1"
                {...handlers}
              />
            </ApiProvider>
          </I18nProvider>
        )}
      />
    </Router>
  ))
  return handlers
}

/** jsdom has no PointerEvent: a plain event carrying the fields read. */
function pointer(el: Element, type: string, pointerType: "touch" | "mouse", x = 20, y = 20) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(event, { pointerType, clientX: x, clientY: y, button: 0, pointerId: 1 })
  el.dispatchEvent(event)
}

/** A quick tap: down, up, and the click the browser sends after it. */
function tap(el: Element, pointerType: "touch" | "mouse" = "touch") {
  pointer(el, "pointerdown", pointerType)
  pointer(el, "pointerup", pointerType)
  fireEvent.click(el)
}

function longPress(el: Element, pointerType: "touch" | "mouse" = "touch") {
  pointer(el, "pointerdown", pointerType)
  vi.advanceTimersByTime(LONG_PRESS_MS + 50)
  pointer(el, "pointerup", pointerType)
}

describe("MessageRow on a touch screen", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetQuoteDrafts()
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it("a long press on a message opens its actions: quote, reply in thread, copy, edit, delete", () => {
    renderRow(makeMessage({}))
    longPress(screen.getByTestId("message-row"))

    for (const id of ["quote", "reply-in-thread", "copy", "edit", "delete"]) {
      expect(screen.getByTestId(`message-sheet-${id}`)).toBeTruthy()
    }
    expect(screen.getByTestId("message-sheet-reactions")).toBeTruthy()
  })

  it("Quote puts the whole message in the surface's composer", () => {
    renderRow(makeMessage({}))
    longPress(screen.getByTestId("message-row"))
    fireEvent.click(screen.getByTestId("message-sheet-quote"))

    expect(getQuoteDraft("t1")).toMatchObject({
      messageId: "m1",
      excerpt: "Ship it **today**",
      authorName: "Bob Martinez",
    })
  })

  it("a favourite emoji in the sheet reacts to the message", () => {
    const { onReaction } = renderRow(makeMessage({}))
    longPress(screen.getByTestId("message-row"))
    fireEvent.click(screen.getByRole("button", { name: "React with 👍" }))

    expect(onReaction).toHaveBeenCalledWith("m1", "👍")
  })

  it("someone else's message offers no edit or delete", () => {
    renderRow(makeMessage({ authorId: "u-other" }))
    longPress(screen.getByTestId("message-row"))

    expect(screen.getByTestId("message-sheet-quote")).toBeTruthy()
    expect(screen.queryByTestId("message-sheet-edit")).toBeNull()
    expect(screen.queryByTestId("message-sheet-delete")).toBeNull()
  })

  it("a mouse holding the button opens nothing: it has the hover toolbar", () => {
    renderRow(makeMessage({}))
    longPress(screen.getByTestId("message-row"), "mouse")

    expect(screen.queryByTestId("message-sheet-m1")).toBeNull()
  })

  it("a long press on an agent message offers quote and copy too", () => {
    renderRow(makeMessage({ authorType: "agent", content: "Posted the summary." }))
    longPress(screen.getByTestId("message-row"))

    expect(screen.getByTestId("message-sheet-quote")).toBeTruthy()
    expect(screen.getByTestId("message-sheet-copy")).toBeTruthy()
    expect(screen.getByTestId("message-sheet-delete")).toBeTruthy()
  })

  it("a tap on a message opens the same action sheet", () => {
    renderRow(makeMessage({}))
    tap(screen.getByTestId("message-row"))

    expect(screen.getByTestId("message-sheet-m1")).toBeTruthy()
    expect(screen.getByTestId("message-sheet-quote")).toBeTruthy()
  })

  it("a tap on an agent message opens its sheet too", () => {
    renderRow(makeMessage({ authorType: "agent", content: "Posted the summary." }))
    tap(screen.getByTestId("message-row"))

    expect(screen.getByTestId("message-sheet-copy")).toBeTruthy()
  })

  it("a drag is not a tap: a scroll that ends in a click opens nothing", () => {
    renderRow(makeMessage({}))
    const row = screen.getByTestId("message-row")
    pointer(row, "pointerdown", "touch")
    pointer(row, "pointermove", "touch", 20, 20 + 30)
    pointer(row, "pointerup", "touch", 20, 20 + 30)
    fireEvent.click(row)

    expect(screen.queryByTestId("message-sheet-m1")).toBeNull()
  })

  it("a scroll that takes the pointer away (pointercancel) is not a tap", () => {
    renderRow(makeMessage({}))
    const row = screen.getByTestId("message-row")
    pointer(row, "pointerdown", "touch")
    pointer(row, "pointercancel", "touch")
    fireEvent.click(row)

    expect(screen.queryByTestId("message-sheet-m1")).toBeNull()
  })

  it("a tap on a link or a mention inside the message keeps its own action", () => {
    const onLink = vi.fn()
    const content = (): JSX.Element => (
      <span>
        see{" "}
        <a href="#doc" data-testid="msg-link">
          the doc
        </a>{" "}
        <span data-mention-ref="user:u1" data-testid="msg-mention">
          @Alice
        </span>
      </span>
    )
    renderRow(makeMessage({}), "en", content)
    // The link's own click still arrives, not cancelled by the row.
    screen.getByTestId("msg-link").addEventListener("click", (e) => onLink(e.defaultPrevented))
    tap(screen.getByTestId("msg-link"))
    tap(screen.getByTestId("msg-mention"))

    expect(onLink).toHaveBeenCalledTimes(1)
    expect(onLink).toHaveBeenCalledWith(false)
    expect(screen.queryByTestId("message-sheet-m1")).toBeNull()
  })

  it("a mouse click on a message opens nothing: it has the hover toolbar", () => {
    renderRow(makeMessage({}))
    tap(screen.getByTestId("message-row"), "mouse")

    expect(screen.queryByTestId("message-sheet-m1")).toBeNull()
  })

  it("a tap while editing leaves the field alone", () => {
    renderRow(makeMessage({}))
    tap(screen.getByTestId("message-row"))
    fireEvent.click(screen.getByTestId("message-sheet-edit"))
    expect(screen.queryByTestId("message-sheet-m1")).toBeNull()
    tap(screen.getByRole("textbox"))

    // The sheet stays shut and the field stays in edit mode.
    expect(screen.queryByTestId("message-sheet-m1")).toBeNull()
    expect(screen.getByRole("textbox")).toBeTruthy()
  })

  describe("a reaction chip", () => {
    // The viewer and Alice reacted with 🎉 (and one person the server did not
    // name); only Alice reacted with 👌.
    const reactions = [
      {
        emoji: "🎉",
        count: 3,
        reacted: true,
        users: [
          { id: "viewer", name: "Me" },
          { id: "u-alice", name: "Alice" },
        ],
      },
      {
        emoji: "👌",
        count: 1,
        reacted: false,
        users: [{ id: "u-alice", name: "Alice" }],
      },
    ]

    it("a tap on someone else's reaction opens the card and adds nothing", () => {
      const { onReaction, onRemoveReaction } = renderRow(makeMessage({ reactions }))
      tap(screen.getByTestId("reaction-chip-👌"))

      expect(screen.getByTestId("reactions-card-m1")).toBeTruthy()
      expect(onReaction).not.toHaveBeenCalled()
      expect(onRemoveReaction).not.toHaveBeenCalled()
      // The chip's tap is its own: the message sheet stays shut.
      expect(screen.queryByTestId("message-sheet-m1")).toBeNull()
    })

    it("a tap on the viewer's own reaction opens the card and removes nothing", () => {
      const { onReaction, onRemoveReaction } = renderRow(makeMessage({ reactions }))
      tap(screen.getByTestId("reaction-chip-🎉"))

      expect(screen.getByTestId("reactions-card-m1")).toBeTruthy()
      expect(onReaction).not.toHaveBeenCalled()
      expect(onRemoveReaction).not.toHaveBeenCalled()
    })

    it("the card lists every reaction and who reacted, the viewer first as You", () => {
      renderRow(makeMessage({ reactions }))
      tap(screen.getByTestId("reaction-chip-👌"))

      const party = screen.getByTestId("reactions-card-group-🎉")
      expect(party.textContent).toContain("You, Alice")
      expect(party.textContent).toContain("and 1 other")
      expect(screen.getByTestId("reactions-card-group-👌").textContent).toContain("Alice")
    })

    it("only the viewer's own reaction can be removed, and removing it removes only that", () => {
      const { onReaction, onRemoveReaction } = renderRow(makeMessage({ reactions }))
      tap(screen.getByTestId("reaction-chip-👌"))

      expect(screen.queryByTestId("reactions-card-remove-👌")).toBeNull()
      const mine = screen.getByTestId("reactions-card-group-🎉")
      expect(mine.dataset.mine).toBe("true")
      expect(screen.getByTestId("reactions-card-group-👌").dataset.mine).toBeUndefined()
      // No control anywhere in someone else's group.
      expect(screen.getByTestId("reactions-card-group-👌").querySelector("button")).toBeNull()

      fireEvent.click(screen.getByRole("button", { name: "Remove your 🎉 reaction" }))
      expect(onRemoveReaction).toHaveBeenCalledTimes(1)
      expect(onRemoveReaction).toHaveBeenCalledWith("m1", "🎉")
      expect(onReaction).not.toHaveBeenCalled()
    })

    it("adding from the card reacts once and closes it", () => {
      const { onReaction, onRemoveReaction } = renderRow(makeMessage({ reactions }))
      tap(screen.getByTestId("reaction-chip-👌"))
      const add = screen.getByTestId("reactions-card-add")
      fireEvent.click(within(add).getByRole("button", { name: "React with 👍" }))

      expect(onReaction).toHaveBeenCalledTimes(1)
      expect(onReaction).toHaveBeenCalledWith("m1", "👍")
      expect(onRemoveReaction).not.toHaveBeenCalled()
    })

    it("the card opens the full picker from its add strip", () => {
      renderRow(makeMessage({ reactions }))
      tap(screen.getByTestId("reaction-chip-👌"))
      fireEvent.click(screen.getByTestId("reactions-card-more-emoji"))

      expect(screen.getByTestId("reactions-card-picker")).toBeTruthy()
    })

    it("one touch is one gesture: a second click from the same touch does nothing", () => {
      const { onReaction, onRemoveReaction } = renderRow(makeMessage({ reactions }))
      const chip = screen.getByTestId("reaction-chip-👌")
      pointer(chip, "pointerdown", "touch")
      pointer(chip, "pointerup", "touch")
      fireEvent.click(chip)
      fireEvent.click(chip)

      expect(onReaction).not.toHaveBeenCalled()
      expect(onRemoveReaction).not.toHaveBeenCalled()
    })

    it("a long press opens the same card, and the lift is not a tap", () => {
      const { onRemoveReaction } = renderRow(makeMessage({ reactions }))
      const chip = screen.getByTestId("reaction-chip-🎉")
      longPress(chip)
      fireEvent.click(chip)

      expect(screen.getByTestId("reactions-card-m1")).toBeTruthy()
      expect(onRemoveReaction).not.toHaveBeenCalled()
      expect(screen.queryByTestId("message-sheet-m1")).toBeNull()
    })

    it("says it in French", () => {
      renderRow(makeMessage({ reactions }), "fr")
      tap(screen.getByTestId("reaction-chip-🎉"))

      const party = screen.getByTestId("reactions-card-group-🎉")
      expect(party.textContent).toContain("Vous")
      expect(party.textContent).toContain("et 1 autre")
      expect(screen.getByRole("button", { name: "Retirer votre réaction 🎉" })).toBeTruthy()
    })

    it("a mouse click still toggles, once per click", () => {
      const { onReaction, onRemoveReaction } = renderRow(makeMessage({ reactions }))
      tap(screen.getByTestId("reaction-chip-👌"), "mouse")
      tap(screen.getByTestId("reaction-chip-🎉"), "mouse")

      expect(onReaction).toHaveBeenCalledTimes(1)
      expect(onReaction).toHaveBeenCalledWith("m1", "👌")
      expect(onRemoveReaction).toHaveBeenCalledTimes(1)
      expect(onRemoveReaction).toHaveBeenCalledWith("m1", "🎉")
      expect(screen.queryByTestId("reactions-card-m1")).toBeNull()
    })
  })
})
