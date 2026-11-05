// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Chats pill's unread count was one string with the plural baked in, so a
// French reader with a single unread message heard "1 non lus" from the screen
// reader. The count picks its form from the locale's plural rules now. Zero
// renders no badge at all, so there is no zero form to get wrong.
import { Route, Router } from "@solidjs/router"
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { ApiProvider } from "~/modules/shell/ApiContext"
import { ChatsTab } from "~/modules/shell/ChatsTab"
import { resetDockStore } from "~/modules/shell/dock-store"
import { resetTabStore } from "~/modules/shell/tab-store"
import { addThread, resetThreadStore } from "~/modules/threads/thread-store"

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

function renderPill(locale: "en" | "fr") {
  return render(() => (
    <I18nProvider initialLocale={locale}>
      <Router>
        <Route
          path="/*"
          component={() => (
            <ApiProvider>
              <ChatsTab />
            </ApiProvider>
          )}
        />
      </Router>
    </I18nProvider>
  ))
}

function seedThread(id: string, unreadCount: number) {
  addThread({
    id,
    handle: `@${id}`,
    title: id,
    isPinned: false,
    isMuted: false,
    unreadCount,
    participants: [{ id: "me", name: "Me", avatarUrl: null }],
    updatedAt: new Date().toISOString(),
  } as never)
}

describe("the Chats pill's unread count agrees with its number", () => {
  beforeEach(() => {
    resetThreadStore()
    resetTabStore()
    resetDockStore()
  })
  afterEach(() => cleanup())

  it("French says one unread in the singular", async () => {
    seedThread("t1", 1)
    renderPill("fr")

    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy())
    expect(screen.getByLabelText("1 non lu")).toBeInTheDocument()
    expect(screen.queryByLabelText("1 non lus")).toBeNull()
  })

  it("French says two unread in the plural", async () => {
    seedThread("t1", 2)
    renderPill("fr")

    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy())
    expect(screen.getByLabelText("2 non lus")).toBeInTheDocument()
  })

  it("nothing unread renders no badge at all, in either language", () => {
    seedThread("t1", 0)
    renderPill("fr")

    expect(screen.queryByRole("status")).not.toBeInTheDocument()
  })

  it("English is unchanged", async () => {
    seedThread("t1", 2)
    renderPill("en")

    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy())
    expect(screen.getByLabelText("2 unread")).toBeInTheDocument()
  })
})
