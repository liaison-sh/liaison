// SPDX-License-Identifier: FSL-1.1-ALv2
//
// SCROLLING UP STAYS UP.
//
// A reader scrolling up from the bottom in small steps (a trackpad) was
// snapped back to the newest message on every step. The first step leaves the
// view within the "near the bottom" band, so the list still counted her as
// following; the step itself flips the scroll fade's class (it can now scroll
// down), the same-frame mutation observer saw that attribute change and
// re-pinned the follower to the bottom. Every later step did the same, so she
// could never leave the band. A deliberate upward scroll now stops following
// at once, wherever it lands.
import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { announceApprovalDecided } from "~/modules/approvals/decided-event"
import { ApiProvider } from "~/modules/shell/ApiContext"
import { TabVisibilityProvider } from "~/modules/shell/TabVisibilityContext"
import MessageList from "~/modules/threads/MessageList"
import { loadMessagesIntoStore, resetMessageStore } from "~/modules/threads/message-store"

vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
})
vi.stubGlobal(
  "fetch",
  vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null),
      },
      text: () => Promise.resolve("{}"),
    }),
  ),
)

const THREAD = "thread-scroll-up"

function makeMessage(index: number) {
  return {
    id: `m-${index + 1}`,
    threadId: THREAD,
    authorId: "u1",
    authorName: "Alex",
    authorAvatarUrl: null,
    authorType: "user" as const,
    authorAgentId: null,
    content: `Message ${index + 1}`,
    mentions: null,
    reactions: [],
    editedAt: null,
    deletedAt: null,
    createdAt: new Date(2024, 0, 1, 12, index).toISOString(),
  }
}

function renderList() {
  return render(() => (
    <Router>
      <Route
        path="/*"
        component={() => (
          <ApiProvider>
            <TabVisibilityProvider value={() => true}>
              <div style={{ display: "flex", height: "480px", "flex-direction": "column" }}>
                <MessageList threadId={THREAD} currentUserId="u1" />
              </div>
            </TabVisibilityProvider>
          </ApiProvider>
        )}
      />
    </Router>
  ))
}

/** jsdom lays nothing out: a mutable fake layout makes the scroll writes observable. */
function fakeLayout(el: HTMLElement, scrollHeight = 2000, clientHeight = 400) {
  let top = scrollHeight - clientHeight
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => scrollHeight })
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => clientHeight })
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = Math.max(0, Math.min(value, scrollHeight - clientHeight))
    },
  })
  return {
    bottom: () => scrollHeight - clientHeight,
    /** One wheel or trackpad step by the reader. */
    scrollBy(delta: number) {
      top += delta
      fireEvent.scroll(el)
    },
    grow(by: number) {
      scrollHeight += by
    },
  }
}

async function frames(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
  }
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe("MessageList: a reader scrolling up", () => {
  afterEach(() => {
    resetMessageStore()
    cleanup()
  })

  async function mounted() {
    loadMessagesIntoStore(
      THREAD,
      Array.from({ length: 20 }, (_, i) => makeMessage(i)),
    )
    renderList()
    await screen.findByText("Message 20")
    const container = screen.getByTestId("message-scroll-container")
    const layout = fakeLayout(container)
    // Settle at the bottom, following.
    fireEvent.scroll(container)
    await frames()
    return { container, layout }
  }

  it("small upward steps from the bottom are not snapped back", async () => {
    const { container, layout } = await mounted()
    const bottom = layout.bottom()
    for (let step = 1; step <= 6; step++) {
      layout.scrollBy(-20)
      await frames()
      expect(container.scrollTop).toBe(bottom - 20 * step)
    }
  })

  it("a new message while scrolled up a little does not yank the view", async () => {
    const { container, layout } = await mounted()
    const bottom = layout.bottom()
    layout.scrollBy(-30)
    await frames()
    layout.grow(120)
    loadMessagesIntoStore(
      THREAD,
      Array.from({ length: 21 }, (_, i) => makeMessage(i)),
    )
    await screen.findByText("Message 21")
    await frames()
    expect(container.scrollTop).toBe(bottom - 30)
  })

  it("a reader at the bottom still follows a new message", async () => {
    const { container, layout } = await mounted()
    layout.grow(120)
    loadMessagesIntoStore(
      THREAD,
      Array.from({ length: 21 }, (_, i) => makeMessage(i)),
    )
    await screen.findByText("Message 21")
    await frames()
    expect(container.scrollTop).toBe(layout.bottom())
  })

  it("scrolling back down into the bottom band resumes following", async () => {
    const { container, layout } = await mounted()
    layout.scrollBy(-300)
    await frames()
    layout.scrollBy(260)
    await frames()
    layout.grow(120)
    loadMessagesIntoStore(
      THREAD,
      Array.from({ length: 21 }, (_, i) => makeMessage(i)),
    )
    await screen.findByText("Message 21")
    await frames()
    expect(container.scrollTop).toBe(layout.bottom())
  })

  it("an approval decided in the list brings it back to following its newest message", async () => {
    const { container, layout } = await mounted()
    // The reader scrolled up to the card (or a tour brought it into view).
    layout.scrollBy(-600)
    await frames()
    const card = document.createElement("div")
    container.firstElementChild?.append(card)
    announceApprovalDecided(card)
    await frames()
    expect(container.scrollTop).toBe(layout.bottom())
    // The agent's follow-up is followed, not left below the fold.
    layout.grow(120)
    loadMessagesIntoStore(
      THREAD,
      Array.from({ length: 21 }, (_, i) => makeMessage(i)),
    )
    await screen.findByText("Message 21")
    await frames()
    expect(container.scrollTop).toBe(layout.bottom())
    expect(screen.queryByText("New activity below")).toBeNull()
  })
})
