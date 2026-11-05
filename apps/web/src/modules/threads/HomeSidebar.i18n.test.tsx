// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Surface 80: the Home sidebar's All / Unread filter pills were literals in
// the FILTERS table, so they stayed English beside a fully French thread list.
// They now name catalog keys, and reuse the phone Chats root's entries rather
// than shipping a second copy of the same two words.
import { Route, Router } from "@solidjs/router"
import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { ApiProvider } from "~/modules/shell/ApiContext"
import { resetTabStore } from "~/modules/shell/tab-store"
import HomeSidebar from "~/modules/threads/HomeSidebar"
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

function renderSidebar(locale: "en" | "fr") {
  return render(() => (
    <I18nProvider initialLocale={locale}>
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
    </I18nProvider>
  ))
}

beforeEach(() => {
  resetThreadStore()
  resetTabStore()
  addThread({
    id: "t1",
    handle: "@thread-1",
    title: "Point hebdomadaire",
    isPinned: false,
    isMuted: false,
    participants: [{ id: "me", name: "Moi", avatarUrl: null }],
    lastMessage: {
      content: "Bonjour",
      authorName: "Moi",
      authorId: "me",
      createdAt: new Date().toISOString(),
    },
    updatedAt: new Date().toISOString(),
  })
})
afterEach(() => cleanup())

describe("the Home sidebar filter pills follow the reader's language", () => {
  it("reads Tous / Non lus in French", () => {
    renderSidebar("fr")
    const tabs = screen.getAllByRole("tab").map((el) => el.textContent)
    expect(tabs).toContain("Tous")
    expect(tabs).toContain("Non lus")
    expect(tabs).not.toContain("All")
    expect(tabs).not.toContain("Unread")
  })

  it("still reads All / Unread in English", () => {
    renderSidebar("en")
    const tabs = screen.getAllByRole("tab").map((el) => el.textContent)
    expect(tabs).toContain("All")
    expect(tabs).toContain("Unread")
  })
})
