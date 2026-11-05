// SPDX-License-Identifier: FSL-1.1-ALv2
// D21: mentions left Home with the rest of the conversations, so Messages has
// a Mentions filter: the conversations that hold an unread mention of me.
import type { AttentionItem } from "@liaison/shared"
import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiProvider } from "~/modules/shell/ApiContext"
import { attentionStore } from "~/modules/shell/attention-store"
import { resetTabStore } from "~/modules/shell/tab-store"
import { resetSidebarSections } from "~/modules/threads/sidebar-sections"
import { addThread, resetThreadStore } from "~/modules/threads/thread-store"
import HomeSidebar, { mentionedThreadIds } from "./HomeSidebar"

vi.stubGlobal(
  "fetch",
  vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null),
      },
      text: () => Promise.resolve(JSON.stringify({ data: [] })),
    }),
  ),
)

const mention = (
  id: string,
  entityId: string,
  metadata?: Record<string, unknown>,
): AttentionItem => ({
  id,
  app: "kernel",
  entity: "thread",
  entityId,
  kind: "mention",
  summary: "Alice mentioned you",
  urgency: 60,
  occurredAt: "2026-10-12T08:00:00.000Z",
  action: { type: "open_entity", tabType: "kernel:thread", entityId },
  metadata,
})

describe("Messages: the Mentions filter", () => {
  it("keeps the conversations holding an unread mention, and only those", () => {
    const ids = mentionedThreadIds([
      mention("m1", "thread-a"),
      // A mention inside a reply thread names its channel.
      mention("m2", "root-1", { threadId: "thread-b" }),
      { ...mention("r1", "thread-c"), kind: "thread_reply" },
    ])
    expect([...ids].sort()).toEqual(["thread-a", "thread-b"])
  })
})

describe("Messages sidebar: the Mentions chip", () => {
  beforeEach(() => {
    resetThreadStore()
    resetTabStore()
    resetSidebarSections()
    attentionStore._setForTest({ items: [], errors: [], loading: false })
  })
  afterEach(() => cleanup())

  it("narrows the list to the conversations that mention me", async () => {
    for (const [id, title] of [
      ["thread-a", "Alpha room"],
      ["thread-b", "Beta room"],
    ]) {
      addThread({
        id,
        handle: `#${id}`,
        title,
        type: "channel",
        isPinned: false,
        isMuted: false,
        participants: [],
        updatedAt: new Date().toISOString(),
        unreadCount: 1,
      } as never)
    }
    attentionStore._setForTest({ items: [mention("m1", "thread-b")] })
    render(() => (
      <Router>
        <Route
          path="/*"
          component={() => (
            <ApiProvider>
              <HomeSidebar />
            </ApiProvider>
          )}
        />
      </Router>
    ))
    expect(await screen.findByText("Alpha room")).toBeTruthy()
    const tab = screen.getAllByRole("tab").find((el) => el.textContent === "Mentions")
    expect(tab).toBeTruthy()
    fireEvent.click(tab as HTMLElement)
    expect(screen.queryByText("Alpha room")).toBeNull()
    expect(screen.getByText("Beta room")).toBeTruthy()
  })
})
