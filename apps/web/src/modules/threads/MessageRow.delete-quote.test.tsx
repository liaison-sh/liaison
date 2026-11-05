// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Deleting a message asks first, on every path (desktop ⋯ menu, agent menu,
// long-press sheet); the desktop ⋯ menu offers the sheet's Quote; a deleted
// message never draws its attachments.
import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
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
    content: "Ship it today",
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

function renderRow(message: Message, opts: { locale?: "en" | "fr"; quote?: boolean } = {}) {
  const onDelete = vi.fn()
  render(() => (
    <Router>
      <Route
        path="/*"
        component={() => (
          <I18nProvider initialLocale={opts.locale ?? "en"}>
            <ApiProvider>
              <MessageRow
                message={message}
                grouped={false}
                currentUserId="viewer"
                renderContent={renderContent}
                quoteSurfaceKey={opts.quote === false ? undefined : "t1"}
                onEdit={vi.fn()}
                onDelete={onDelete}
                onReaction={vi.fn()}
                onRemoveReaction={vi.fn()}
              />
            </ApiProvider>
          </I18nProvider>
        )}
      />
    </Router>
  ))
  return { onDelete }
}

async function openMenuAndPick(label: string) {
  const trigger = screen.getByLabelText(/Message actions|Actions du message/)
  trigger.focus()
  fireEvent.keyDown(trigger, { key: "ArrowDown" })
  const menu = await screen.findByRole("menu")
  const item = Array.from(menu.querySelectorAll("[role='menuitem']")).find(
    (el) => (el.textContent ?? "").trim() === label,
  ) as HTMLElement
  expect(item).toBeTruthy()
  fireEvent.keyDown(item, { key: "Enter" })
}

afterEach(() => cleanup())

describe("deleting a message asks for confirmation", () => {
  it("desktop ⋯ Delete opens the confirm; Cancel deletes nothing, Delete deletes", async () => {
    const { onDelete } = renderRow(makeMessage({}))
    await openMenuAndPick("Delete")
    expect(onDelete).not.toHaveBeenCalled()
    expect(await screen.findByText("Delete this message?")).toBeInTheDocument()
    expect(screen.getByText("This cannot be undone.")).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("delete-message-cancel"))
    expect(onDelete).not.toHaveBeenCalled()

    await openMenuAndPick("Delete")
    fireEvent.click(await screen.findByTestId("delete-message-confirm-btn"))
    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(onDelete).toHaveBeenCalledWith("m1")
  })

  it("an agent message's menu Delete asks too", async () => {
    const { onDelete } = renderRow(
      makeMessage({
        id: "ag1",
        authorType: "agent",
        metadata: { agentAuthorLabel: "Viewer's agent" },
      }),
    )
    await openMenuAndPick("Delete")
    expect(onDelete).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByTestId("delete-message-confirm-btn"))
    expect(onDelete).toHaveBeenCalledWith("ag1")
  })

  it("the confirm reads French in French", async () => {
    renderRow(makeMessage({}), { locale: "fr" })
    await openMenuAndPick("Supprimer")
    expect(await screen.findByText("Supprimer ce message ?")).toBeInTheDocument()
    expect(screen.getByText("Cette action est irréversible.")).toBeInTheDocument()
  })

  describe("on a touch screen", () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it("the long-press sheet's Delete asks before deleting", () => {
      const { onDelete } = renderRow(makeMessage({}))
      const row = screen.getByTestId("message-row")
      for (const type of ["pointerdown", "pointerup"]) {
        const ev = new Event(type, { bubbles: true, cancelable: true })
        Object.assign(ev, {
          pointerType: "touch",
          clientX: 20,
          clientY: 20,
          button: 0,
          pointerId: 1,
        })
        row.dispatchEvent(ev)
        if (type === "pointerdown") vi.advanceTimersByTime(LONG_PRESS_MS + 50)
      }
      fireEvent.click(screen.getByTestId("message-sheet-delete"))
      vi.advanceTimersByTime(500)
      expect(onDelete).not.toHaveBeenCalled()
      fireEvent.click(screen.getByTestId("delete-message-confirm-btn"))
      expect(onDelete).toHaveBeenCalledWith("m1")
    })
  })
})

describe("the desktop ⋯ menu offers Quote", () => {
  beforeEach(() => resetQuoteDrafts())

  it("Quote puts the whole message in the surface's composer, on someone else's message too", async () => {
    renderRow(makeMessage({ authorId: "u-other" }))
    await openMenuAndPick("Quote")
    await waitFor(() => expect(getQuoteDraft("t1")).not.toBeNull())
    expect(getQuoteDraft("t1")).toMatchObject({
      messageId: "m1",
      excerpt: "Ship it today",
      authorName: "Bob Martinez",
    })
  })

  it("someone else's message: the menu holds Quote only", async () => {
    renderRow(makeMessage({ authorId: "u-other" }))
    const trigger = screen.getByLabelText("Message actions")
    trigger.focus()
    fireEvent.keyDown(trigger, { key: "ArrowDown" })
    const menu = await screen.findByRole("menu")
    const labels = Array.from(menu.querySelectorAll("[role='menuitem']")).map((el) =>
      (el.textContent ?? "").trim(),
    )
    expect(labels).toEqual(["Quote"])
  })

  it("no quotable surface and not the author: no menu at all", () => {
    renderRow(makeMessage({ authorId: "u-other" }), { quote: false })
    expect(screen.queryByLabelText("Message actions")).toBeNull()
  })
})

describe("a deleted message draws no attachments", () => {
  it("even when the live copy still carries them", () => {
    renderRow(
      makeMessage({
        content: null,
        deletedAt: new Date().toISOString(),
        attachments: [
          {
            id: "f1",
            filename: "secret.pdf",
            mimeType: "application/pdf",
            sizeBytes: 10,
            disposition: "attachment",
          } as never,
        ],
      }),
    )
    expect(screen.queryByText("secret.pdf")).toBeNull()
  })
})

describe("an agent message draws its attachments", () => {
  it("the files an agent attached show under its post", () => {
    renderRow(
      makeMessage({
        authorType: "agent",
        authorName: "Bob Martinez's agent",
        attachments: [
          {
            id: "f2",
            filename: "layout.png",
            mimeType: "image/png",
            sizeBytes: 10,
            disposition: "attachment",
          } as never,
        ],
      }),
    )
    expect(screen.getByText("layout.png")).toBeTruthy()
  })
})
