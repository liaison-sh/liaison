// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE VIEW FOLLOWS A TURN RUNNING ON THIS MACHINE (2026-09-23).
//
// A local turn draws its rows from the shell's tool activity and its question
// from the shell's pending prompts. The view only followed the SERVER's stream,
// so a local turn grew below the fold: new rows, then the permission card, with
// the view parked where it was. A command sat waiting on an Allow nobody could
// see for ten minutes. The view now follows a local turn while the reader is at
// the bottom, says "new activity" when she scrolled up, and always brings a new
// permission card into view.
import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { installFakeBridge, liveSession, uninstallFakeBridge } from "~/modules/desktop/fake-bridge"
import { resetLocalPrompts } from "~/modules/desktop/LocalPermissionCard"
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

const THREAD = "thread-local-follow"
const AGENT = "agent-personal"

function row(id: string, status: "running" | "done" = "running") {
  return { id, toolName: "Bash", summary: `command: ${id}`, status, startedAt: 1 }
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
      top = value
    },
  })
  return {
    /** A deliberate upward scroll by the reader, from the bottom. */
    scrollUpTo(value: number) {
      top = scrollHeight - clientHeight
      fireEvent.scroll(el)
      top = value
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

describe("a local turn's activity and the view", () => {
  let scrollIntoView: ReturnType<typeof vi.fn>

  beforeEach(() => {
    scrollIntoView = vi.fn()
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(
      scrollIntoView as unknown as HTMLElement["scrollIntoView"],
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
    uninstallFakeBridge()
    resetLocalPrompts()
    resetMessageStore()
    loadMessagesIntoStore(THREAD, [])
    cleanup()
  })

  async function mounted(extra = {}) {
    const fake = installFakeBridge(
      liveSession(THREAD, AGENT, { toolActivity: [row("toolu_1")], turnActive: true, ...extra }),
    )
    loadMessagesIntoStore(THREAD, [])
    renderList()
    await screen.findByTestId("agent-stream-block")
    const container = screen.getByTestId("message-scroll-container")
    const layout = fakeLayout(container)
    await frames()
    return { fake, container, layout }
  }

  it("follows a new tool row while the reader is at the bottom", async () => {
    const { fake, container, layout } = await mounted()
    layout.grow(300)
    fake.push({ toolActivity: [row("toolu_1", "done"), row("toolu_2")] })
    await frames()
    expect(container.scrollTop).toBe(2300)
    expect(screen.queryByTestId("new-activity-below")).toBeNull()
  })

  it("leaves a reader who scrolled up where she is, and says there is new activity", async () => {
    const { fake, container, layout } = await mounted()
    layout.scrollUpTo(200)
    layout.grow(300)
    fake.push({ toolActivity: [row("toolu_1", "done"), row("toolu_2")] })
    await frames()
    expect(container.scrollTop).toBe(200)
    const jump = await screen.findByTestId("new-activity-below")
    fireEvent.click(jump)
    expect(container.scrollTop).toBe(2300)
    await waitFor(() => expect(screen.queryByTestId("new-activity-below")).toBeNull())
  })

  it("brings a new permission card into view even when the reader scrolled up", async () => {
    const { fake, layout } = await mounted()
    layout.scrollUpTo(100)
    fake.push({
      pendingPermissions: [
        {
          requestId: "perm-1",
          toolName: "Bash",
          summary: "command: python3 run.py",
          toolUseId: "toolu_1",
        },
      ],
    })
    const card = await screen.findByTestId("local-permission-card")
    await frames()
    expect(scrollIntoView).toHaveBeenCalled()
    expect(scrollIntoView.mock.contexts).toContain(card)
  })
})
