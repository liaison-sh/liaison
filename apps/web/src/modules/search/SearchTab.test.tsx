// SPDX-License-Identifier: FSL-1.1-ALv2
import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetRegistry } from "~/framework/app-registry"
import SearchTab from "~/modules/search/SearchTab"
import { resetSearchStore } from "~/modules/search/search-store"
import { ApiProvider } from "~/modules/shell/ApiContext"
import { resetTabStore } from "~/modules/shell/tab-store"

function mountFetch(handler: (url: string) => Response | Promise<Response>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: any) => {
      const url = typeof input === "string" ? input : input.url
      return handler(url)
    }),
  )
}

function renderTab() {
  return render(() => (
    <Router>
      <Route
        path="/*"
        component={() => (
          <ApiProvider>
            <SearchTab entityId="search" />
          </ApiProvider>
        )}
      />
    </Router>
  ))
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  })
}

describe("SearchTab", () => {
  beforeEach(() => {
    resetRegistry()
    resetTabStore()
    resetSearchStore()
    vi.useFakeTimers()
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it("shows empty hint when no query", () => {
    mountFetch(() => jsonResponse({ data: [], meta: { total: 0, limit: 25, offset: 0 } }))
    renderTab()
    expect(screen.getByTestId("search-empty-hint")).toBeInTheDocument()
  })

  it("renders results after typing and debounce", async () => {
    mountFetch((url) => {
      if (url.includes("/search/page")) {
        return jsonResponse({
          data: [{ id: "h1", app: "kernel", entity_type: "thread", title: "Sprint planning" }],
          meta: { total: 1, limit: 25, offset: 0 },
        })
      }
      return jsonResponse({})
    })
    renderTab()
    const input = screen.getByTestId("search-input") as HTMLInputElement
    fireEvent.input(input, { target: { value: "Sprint" } })
    await vi.advanceTimersByTimeAsync(220)
    await waitFor(() => expect(screen.queryByTestId("search-results")).toBeInTheDocument())
    expect(screen.getByText("Sprint planning")).toBeInTheDocument()
  })

  it("renders SEARCH_UNAVAILABLE inline state on 503", async () => {
    mountFetch(() =>
      jsonResponse(
        { error: { message: "Search unavailable", code: "SEARCH_UNAVAILABLE" } },
        { status: 503 },
      ),
    )
    renderTab()
    const input = screen.getByTestId("search-input") as HTMLInputElement
    fireEvent.input(input, { target: { value: "x" } })
    await vi.advanceTimersByTimeAsync(220)
    await waitFor(() => expect(screen.queryByTestId("search-unavailable")).toBeInTheDocument())
  })
})
