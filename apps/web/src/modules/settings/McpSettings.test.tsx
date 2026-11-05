// SPDX-License-Identifier: FSL-1.1-ALv2
import { Route, Router } from "@solidjs/router"
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import McpSettings from "~/modules/settings/McpSettings"
import { ApiProvider } from "~/modules/shell/ApiContext"

function Wrapped() {
  return (
    <ApiProvider>
      <McpSettings />
    </ApiProvider>
  )
}

function renderPage() {
  return render(() => (
    <Router>
      <Route path="*" component={Wrapped} />
    </Router>
  ))
}

const BASE = "https://example.test"

describe("McpSettings", () => {
  let connections: Array<Record<string, unknown>>
  let listShouldFail = false
  let deleteShouldFail = false

  beforeEach(() => {
    connections = []
    listShouldFail = false
    deleteShouldFail = false

    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        const method = init?.method ?? "GET"
        const json = (body: unknown, status = 200) =>
          Promise.resolve(
            new Response(JSON.stringify(body), {
              status,
              headers: { "Content-Type": "application/json" },
            }),
          )

        if (url.endsWith("/api/mcp/connect-info") && method === "GET") {
          return json({ data: { baseUrl: BASE } })
        }
        if (url.endsWith("/api/mcp/connections") && method === "GET") {
          if (listShouldFail) return json({ error: { message: "boom" } }, 500)
          return json({ data: connections })
        }
        if (/\/api\/mcp\/connections\/[^/]+$/.test(url) && method === "DELETE") {
          if (deleteShouldFail) return json({ error: { message: "no" } }, 500)
          const id = url.split("/").pop()
          connections = connections.filter((c) => c.id !== id)
          return json({ data: { revoked: true } })
        }
        return Promise.reject(new Error(`Unhandled fetch: ${url}`))
      }),
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("renders connect snippets with the server-provided baseUrl in both blocks", async () => {
    renderPage()
    await waitFor(() => {
      const cli = screen.getByTestId("mcp-cli-snippet")
      expect(cli.textContent).toContain(BASE)
    })
    const desktop = screen.getByTestId("mcp-desktop-snippet")
    expect(desktop.textContent).toContain(BASE)
  })

  it("each connect block has a working copy-to-clipboard control (B5)", async () => {
    const writeText = vi.fn((_text: string) => Promise.resolve())
    vi.stubGlobal("navigator", { clipboard: { writeText } })
    renderPage()
    await waitFor(() => {
      const cli = screen.getByTestId("mcp-cli-snippet")
      expect(cli.textContent).toContain(BASE)
    })
    const cliCopy = screen.getByTestId("mcp-cli-snippet-copy")
    const desktopCopy = screen.getByTestId("mcp-desktop-snippet-copy")
    expect(cliCopy).toBeTruthy()
    expect(desktopCopy).toBeTruthy()

    fireEvent.click(cliCopy)
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    expect(String(writeText.mock.calls[0][0])).toContain(`${BASE}/mcp`)
    // Transient "Copied" affordance.
    await waitFor(() => expect(cliCopy.textContent).toContain("Copied"))

    fireEvent.click(desktopCopy)
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2))
    expect(String(writeText.mock.calls[1][0])).toContain(`${BASE}/mcp`)
  })

  it("connection row shows the created date (N9)", async () => {
    const created = new Date("2026-01-15T10:00:00.000Z")
    connections = [
      { id: "c1", label: "Claude Code", createdAt: created.toISOString(), lastUsedAt: null },
    ]
    renderPage()
    await waitFor(() => expect(screen.getAllByTestId("mcp-connection-row").length).toBe(1))
    const row = screen.getByTestId("mcp-connection-row")
    expect(row.textContent).toContain("Added")
    expect(row.textContent).toContain("2026")
  })

  it("empty connections → 'No connections yet' line, connect section still rendered", async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId("mcp-empty")).toBeTruthy())
    expect(screen.getByTestId("mcp-connect-section")).toBeTruthy()
  })

  it("populated → one row per connection with label + relative last-used + Revoke", async () => {
    connections = [
      { id: "c1", label: "Claude Code", createdAt: new Date().toISOString(), lastUsedAt: null },
    ]
    renderPage()
    await waitFor(() => {
      const rows = screen.getAllByTestId("mcp-connection-row")
      expect(rows.length).toBe(1)
    })
    const row = screen.getByTestId("mcp-connection-row")
    expect(row.textContent).toContain("Claude Code")
    expect(row.textContent).toContain("Last used never")
    expect(screen.getByText("Revoke")).toBeTruthy()
  })

  it("revoke flow: confirm → optimistic removal → DELETE called", async () => {
    connections = [
      { id: "c1", label: "Claude Code", createdAt: new Date().toISOString(), lastUsedAt: null },
    ]
    renderPage()
    await waitFor(() => expect(screen.getAllByTestId("mcp-connection-row").length).toBe(1))
    fireEvent.click(screen.getByText("Revoke"))
    // Confirm dialog → click the destructive Revoke
    await waitFor(() => expect(screen.getByText("Revoke connection")).toBeTruthy())
    const confirmBtns = screen.getAllByText("Revoke")
    fireEvent.click(confirmBtns[confirmBtns.length - 1])
    await waitFor(() => {
      const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
      expect(
        fetchMock.mock.calls.some(
          (call) =>
            String(call[0]).includes("/api/mcp/connections/c1") &&
            (call[1] as RequestInit)?.method === "DELETE",
        ),
      ).toBe(true)
    })
  })

  it("revoke failure → inline row error, row remains", async () => {
    deleteShouldFail = true
    connections = [
      { id: "c1", label: "Claude Code", createdAt: new Date().toISOString(), lastUsedAt: null },
    ]
    renderPage()
    await waitFor(() => expect(screen.getAllByTestId("mcp-connection-row").length).toBe(1))
    fireEvent.click(screen.getByText("Revoke"))
    await waitFor(() => expect(screen.getByText("Revoke connection")).toBeTruthy())
    const confirmBtns = screen.getAllByText("Revoke")
    fireEvent.click(confirmBtns[confirmBtns.length - 1])
    await waitFor(() => expect(screen.getByTestId("mcp-row-error")).toBeTruthy())
    expect(screen.getAllByTestId("mcp-connection-row").length).toBe(1)
  })

  it("list-fetch failure → inline error region, connect section still usable", async () => {
    listShouldFail = true
    renderPage()
    await waitFor(() => expect(screen.getByTestId("mcp-connections-error")).toBeTruthy())
    expect(screen.getByTestId("mcp-connect-section")).toBeTruthy()
  })
})
