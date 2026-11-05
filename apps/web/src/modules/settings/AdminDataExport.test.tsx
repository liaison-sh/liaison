// SPDX-License-Identifier: FSL-1.1-ALv2
import { Route, Router } from "@solidjs/router"
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import AdminDataExport from "~/modules/settings/AdminDataExport"
import { ApiProvider } from "~/modules/shell/ApiContext"

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function zipResp(skipped: Array<{ app: string; reason: string }> = []): Response {
  return new Response(new Blob([new Uint8Array([1, 2, 3])]), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": 'attachment; filename="liaison-export.zip"',
      "X-Export-Skipped": JSON.stringify(skipped),
    },
  })
}

function renderView() {
  window.history.pushState({}, "", "/settings/admin/data-export")
  return render(() => (
    <Router>
      <Route
        path="*"
        component={() => (
          <ApiProvider>
            <AdminDataExport />
          </ApiProvider>
        )}
      />
    </Router>
  ))
}

afterEach(() => vi.unstubAllGlobals())

describe("AdminDataExport", () => {
  it("Export is disabled when no apps are selected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (typeof url === "string" && url.includes("/export/apps")) {
          return jsonResp({ data: { apps: ["tickets", "mail"] } })
        }
        return jsonResp({})
      }),
    )
    renderView()
    await screen.findByTestId("data-export-app-tickets")
    expect(screen.getByTestId("data-export-submit")).toBeDisabled()
  })

  it("selecting apps + format + Export POSTs /export with the right body", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (typeof url === "string" && url.includes("/export/apps")) {
        return jsonResp({ data: { apps: ["tickets", "mail"] } })
      }
      if (typeof url === "string" && url.endsWith("/export") && init?.method === "POST") {
        return zipResp([])
      }
      return jsonResp({})
    })
    vi.stubGlobal("fetch", fetchMock)
    URL.createObjectURL = vi.fn().mockReturnValue("blob:x")
    URL.revokeObjectURL = vi.fn()
    renderView()

    fireEvent.click(await screen.findByTestId("data-export-app-tickets"))
    fireEvent.click(screen.getByTestId("data-export-format-csv"))
    fireEvent.click(screen.getByTestId("data-export-submit"))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        (c) => typeof c[0] === "string" && (c[0] as string).endsWith("/export"),
      )
      expect(call).toBeTruthy()
      const body = JSON.parse((call![1] as RequestInit).body as string)
      expect(body.appNames).toEqual(["tickets"])
      expect(body.format).toBe("csv")
    })
  })

  it("lists export-capable apps from /export/apps", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (typeof url === "string" && url.includes("/export/apps")) {
        return jsonResp({ data: { apps: ["tickets", "knowledge"] } })
      }
      return jsonResp({})
    })
    vi.stubGlobal("fetch", fetchMock)
    renderView()
    expect(await screen.findByTestId("data-export-app-tickets")).toBeInTheDocument()
    expect(screen.getByTestId("data-export-app-knowledge")).toBeInTheDocument()
  })

  it("partial response renders the skipped app list with reasons", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (typeof url === "string" && url.includes("/export/apps")) {
        return jsonResp({ data: { apps: ["tickets", "mail"] } })
      }
      if (typeof url === "string" && url.endsWith("/export") && init?.method === "POST") {
        return zipResp([{ app: "mail", reason: "no csv handler" }])
      }
      return jsonResp({})
    })
    vi.stubGlobal("fetch", fetchMock)
    URL.createObjectURL = vi.fn().mockReturnValue("blob:x")
    URL.revokeObjectURL = vi.fn()
    renderView()

    fireEvent.click(await screen.findByTestId("data-export-app-mail"))
    fireEvent.click(screen.getByTestId("data-export-submit"))

    const skipped = await screen.findByTestId("data-export-skipped")
    expect(skipped).toHaveTextContent("mail")
    expect(skipped).toHaveTextContent("no csv handler")
  })
})
