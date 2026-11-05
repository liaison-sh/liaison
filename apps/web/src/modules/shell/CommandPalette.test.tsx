// SPDX-License-Identifier: FSL-1.1-ALv2
import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  registerCommand,
  registerEntityOpener,
  registerTabType,
  resetRegistry,
} from "~/framework/app-registry"
import { ApiProvider } from "~/modules/shell/ApiContext"
import CommandPalette from "~/modules/shell/CommandPalette"
import { resetTabStore, tabStore } from "~/modules/shell/tab-store"

// Mock fetch for ApiProvider
vi.stubGlobal(
  "fetch",
  vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null),
      },
      text: () => Promise.resolve(JSON.stringify({ data: { threads: [], users: [] } })),
    }),
  ),
)

function renderPalette() {
  const [isOpen, setIsOpen] = createSignal(true)
  const onClose = vi.fn(() => setIsOpen(false))

  const result = render(() => (
    <Router>
      <Route
        path="/*"
        component={() => (
          <ApiProvider>
            <CommandPalette isOpen={isOpen()} onClose={onClose} />
          </ApiProvider>
        )}
      />
    </Router>
  ))

  return { ...result, onClose, setIsOpen }
}

function seedCommand(id: string, label: string, shortcut?: string) {
  const execute = vi.fn()
  registerCommand({ id, label, shortcut, execute })
  return execute
}

function seedTabType(type: string) {
  registerTabType(type, {
    component: () => null,
    sidebar: null,
    icon: () => null,
    urlPattern: `/${type}/:entityId`,
    defaultLabel: type,
  })
}

describe("CommandPalette", () => {
  beforeEach(() => {
    resetRegistry()
    resetTabStore()
  })
  afterEach(() => cleanup())

  it("renders with search input when open", () => {
    renderPalette()
    expect(screen.getByPlaceholderText("Search threads, people, commands...")).toBeInTheDocument()
  })

  it("shows registered commands as initial results", () => {
    seedCommand("test:cmd1", "Do something")
    seedCommand("test:cmd2", "Do another thing")
    renderPalette()
    expect(screen.getByText("Do something")).toBeInTheDocument()
    expect(screen.getByText("Do another thing")).toBeInTheDocument()
  })

  it("hides alias commands so the same label is not listed twice", () => {
    registerCommand({ id: "test:toggle-chat", label: "Toggle chat", execute: vi.fn() })
    registerCommand({
      id: "test:toggle-agent-panel",
      label: "Toggle chat",
      alias: true,
      execute: vi.fn(),
    })
    renderPalette()
    expect(screen.getAllByText("Toggle chat")).toHaveLength(1)
  })

  it("filters commands by query (without API call)", () => {
    seedCommand("test:create", "Create item")
    seedCommand("test:delete", "Delete item")
    renderPalette()

    const input = screen.getByPlaceholderText("Search threads, people, commands...")
    fireEvent.input(input, { target: { value: "" } })

    // Both visible with empty query
    expect(screen.getByText("Create item")).toBeInTheDocument()
    expect(screen.getByText("Delete item")).toBeInTheDocument()
  })

  describe("keyboard navigation", () => {
    it("ArrowDown moves selection down", () => {
      seedCommand("test:a", "Alpha")
      seedCommand("test:b", "Beta")
      renderPalette()

      const input = screen.getByPlaceholderText("Search threads, people, commands...")

      // First item is selected by default — it should have the active class
      const buttons = screen.getAllByRole("button")
      const alphaBtn = buttons.find((b) => b.textContent?.includes("Alpha"))!
      expect(alphaBtn.className).toContain("bg-surface-hover")

      fireEvent.keyDown(input, { key: "ArrowDown" })

      // Now Beta should be highlighted
      const betaBtn = buttons.find((b) => b.textContent?.includes("Beta"))!
      expect(betaBtn.className).toContain("bg-surface-hover")
    })

    it("ArrowUp moves selection up", () => {
      seedCommand("test:a", "Alpha")
      seedCommand("test:b", "Beta")
      renderPalette()

      const input = screen.getByPlaceholderText("Search threads, people, commands...")

      // Move down then back up
      fireEvent.keyDown(input, { key: "ArrowDown" })
      fireEvent.keyDown(input, { key: "ArrowUp" })

      const buttons = screen.getAllByRole("button")
      const alphaBtn = buttons.find((b) => b.textContent?.includes("Alpha"))!
      expect(alphaBtn.className).toContain("bg-surface-hover")
    })

    it("ArrowDown does not go past last item", () => {
      seedCommand("test:only", "Only Command")
      renderPalette()

      const input = screen.getByPlaceholderText("Search threads, people, commands...")
      fireEvent.keyDown(input, { key: "ArrowDown" })
      fireEvent.keyDown(input, { key: "ArrowDown" })
      fireEvent.keyDown(input, { key: "ArrowDown" })

      // Should still be on the only item (index 0)
      const buttons = screen.getAllByRole("button")
      const btn = buttons.find((b) => b.textContent?.includes("Only Command"))!
      expect(btn.className).toContain("bg-surface-hover")
    })

    it("Enter executes the selected command", () => {
      const execute = seedCommand("test:run", "Run it")
      const { onClose } = renderPalette()

      const input = screen.getByPlaceholderText("Search threads, people, commands...")
      fireEvent.keyDown(input, { key: "Enter" })

      expect(execute).toHaveBeenCalled()
      expect(onClose).toHaveBeenCalled()
    })

    it("Escape closes the palette", () => {
      const { onClose } = renderPalette()
      const input = screen.getByPlaceholderText("Search threads, people, commands...")
      fireEvent.keyDown(input, { key: "Escape" })
      expect(onClose).toHaveBeenCalled()
    })
  })

  describe("result mapping from search API", () => {
    it("maps thread results from API", async () => {
      seedTabType("thread")
      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          Promise.resolve({
            ok: true,
            status: 200,
            headers: {
              get: (name: string) =>
                name.toLowerCase() === "content-type" ? "application/json" : null,
            },
            text: () =>
              Promise.resolve(
                JSON.stringify({
                  data: {
                    threads: [{ id: "t1", title: "Design discussion", handle: "@design" }],
                    users: [],
                  },
                }),
              ),
          }),
        ),
      )

      renderPalette()
      const input = screen.getByPlaceholderText("Search threads, people, commands...")
      fireEvent.input(input, { target: { value: "design" } })

      await waitFor(() => {
        expect(screen.getByText("Design discussion")).toBeInTheDocument()
      })
    })

    it("maps user results from API", async () => {
      seedTabType("user")
      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          Promise.resolve({
            ok: true,
            status: 200,
            headers: {
              get: (name: string) =>
                name.toLowerCase() === "content-type" ? "application/json" : null,
            },
            text: () =>
              Promise.resolve(
                JSON.stringify({
                  data: {
                    threads: [],
                    users: [{ id: "u1", name: "Alice", email: "alice@test.com" }],
                  },
                }),
              ),
          }),
        ),
      )

      renderPalette()
      const input = screen.getByPlaceholderText("Search threads, people, commands...")
      fireEvent.input(input, { target: { value: "alice" } })

      await waitFor(() => {
        expect(screen.getByText("Alice")).toBeInTheDocument()
      })
    })
  })

  describe("entity-opener routed results (approvals)", () => {
    function stubEntitySearch() {
      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          Promise.resolve({
            ok: true,
            status: 200,
            headers: {
              get: (name: string) =>
                name.toLowerCase() === "content-type" ? "application/json" : null,
            },
            text: () =>
              Promise.resolve(
                JSON.stringify({
                  data: {
                    threads: [],
                    users: [],
                    entities: [
                      {
                        id: "3f2a9c1e-7b1d-4c2a-9e0f-1234567890ab",
                        app: "kernel",
                        entityType: "approval_request",
                        label: "request-42",
                        handle: "request-42",
                      },
                    ],
                  },
                }),
              ),
          }),
        ),
      )
    }

    it("keeps an approval hit (no tab type, but a registered entity opener) and opens it through the opener", async () => {
      // Before: results were filtered on getTabType alone, so every
      // approval_request hit was silently dropped — searching "request-42"
      // or the uuid found nothing even when the server matched.
      seedTabType("thread")
      const opener = vi.fn(async () => ({
        tabType: "thread",
        entityId: "t-appr",
        label: "request-42",
      }))
      registerEntityOpener("kernel", "approval_request", opener)
      stubEntitySearch()

      renderPalette()
      const input = screen.getByPlaceholderText("Search threads, people, commands...")
      fireEvent.input(input, { target: { value: "3f2a9c1e" } })

      await waitFor(() => {
        expect(screen.getByText("request-42")).toBeInTheDocument()
      })
      // The uuid prefix is printed so a hit found by uuid is recognizable.
      expect(screen.getByText(/kernel:approval_request · 3f2a9c1e/)).toBeInTheDocument()

      fireEvent.keyDown(input, { key: "Enter" })
      await waitFor(() => {
        expect(opener).toHaveBeenCalledWith(
          expect.anything(),
          "3f2a9c1e-7b1d-4c2a-9e0f-1234567890ab",
        )
      })
      await waitFor(() => {
        expect(tabStore.tabs.find((t) => t.entityId === "t-appr")).toBeDefined()
      })
    })

    it("still drops entity hits with neither a tab type nor an entity opener", async () => {
      stubEntitySearch()
      renderPalette()
      const input = screen.getByPlaceholderText("Search threads, people, commands...")
      fireEvent.input(input, { target: { value: "3f2a9c1e" } })
      await waitFor(() => {
        expect(screen.getByText("No results found")).toBeInTheDocument()
      })
      expect(screen.queryByText("request-42")).not.toBeInTheDocument()
    })
  })

  describe("tab-open behavior", () => {
    it("opens a tab when selecting a thread result", async () => {
      seedTabType("thread")
      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          Promise.resolve({
            ok: true,
            status: 200,
            headers: {
              get: (name: string) =>
                name.toLowerCase() === "content-type" ? "application/json" : null,
            },
            text: () =>
              Promise.resolve(
                JSON.stringify({
                  data: {
                    threads: [{ id: "t1", title: "Project chat", handle: "@proj" }],
                    users: [],
                  },
                }),
              ),
          }),
        ),
      )

      renderPalette()
      const input = screen.getByPlaceholderText("Search threads, people, commands...")
      fireEvent.input(input, { target: { value: "project" } })

      await waitFor(() => {
        expect(screen.getByText("Project chat")).toBeInTheDocument()
      })

      fireEvent.keyDown(input, { key: "Enter" })

      const threadTab = tabStore.tabs.find((t) => t.entityId === "t1")
      expect(threadTab).toBeDefined()
      expect(threadTab!.label).toBe("Project chat")
    })
  })

  it("shows empty state when no results match", () => {
    // No commands registered
    renderPalette()
    expect(screen.getByText("No results found")).toBeInTheDocument()
  })

  it("resets query and results on reopen", async () => {
    seedCommand("test:cmd", "My Command")
    const { setIsOpen } = renderPalette()

    fireEvent.input(screen.getByPlaceholderText("Search threads, people, commands..."), {
      target: { value: "xyz" },
    })
    expect(screen.getByPlaceholderText("Search threads, people, commands...")).toHaveValue("xyz")

    // Close and reopen. Kobalte's Dialog unmounts content on close, so the
    // input element after reopen is a NEW DOM node — re-query it inside
    // waitFor rather than reusing a now-detached reference.
    setIsOpen(false)
    setIsOpen(true)

    await waitFor(() => {
      expect(screen.getByPlaceholderText("Search threads, people, commands...")).toHaveValue("")
    })
    expect(screen.getByText("My Command")).toBeInTheDocument()
  })
})
