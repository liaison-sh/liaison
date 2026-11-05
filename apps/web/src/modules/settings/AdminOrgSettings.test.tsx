// SPDX-License-Identifier: FSL-1.1-ALv2
import { Route, Router } from "@solidjs/router"
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import AdminOrgSettings from "~/modules/settings/AdminOrgSettings"
import { ApiProvider } from "~/modules/shell/ApiContext"

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

interface OrgMockOpts {
  org?: any
  patchStatus?: number
  capturePatch?: { body?: unknown }
}

function mockOrg(opts: OrgMockOpts = {}): ReturnType<typeof vi.fn> {
  const org = opts.org ?? {
    id: "o1",
    name: "Acme",
    timezone: "America/New_York",
    defaultLocale: "en-US",
    settings: { tickets: { sla: { targets: {} } } },
  }
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET"
    if (url.endsWith("/org") && method === "PATCH") {
      if (opts.capturePatch) opts.capturePatch.body = JSON.parse((init?.body as string) ?? "{}")
      return jsonResp({ data: { ok: true } }, opts.patchStatus ?? 200)
    }
    if (url.endsWith("/org") && method === "GET") {
      return jsonResp({ data: org })
    }
    return jsonResp({})
  })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

function renderPage(Component: any) {
  return render(() => (
    <Router>
      <Route
        path="*"
        component={() => (
          <ApiProvider>
            <Component />
          </ApiProvider>
        )}
      />
    </Router>
  ))
}

afterEach(() => vi.unstubAllGlobals())

describe("AdminOrgSettings", () => {
  it("ContextualSaveBar appears only on dirty edits", async () => {
    mockOrg()
    renderPage(AdminOrgSettings as any)
    await screen.findByTestId("admin-org-timezone-select")
    expect(screen.queryByTestId("save-bar")).toBeNull()
    fireEvent.change(screen.getByTestId("admin-org-timezone-select"), {
      target: { value: "Europe/Paris" },
    })
    expect(await screen.findByTestId("save-bar")).toBeInTheDocument()
  })

  it("invalid timezone shows inline error and disables save", async () => {
    mockOrg()
    renderPage(AdminOrgSettings as any)
    const manual = (await screen.findByTestId("admin-org-timezone-manual")) as HTMLInputElement
    fireEvent.input(manual, { target: { value: "Mars/Base" } })
    expect(await screen.findByTestId("admin-org-timezone-error")).toBeInTheDocument()
    expect(screen.getByTestId("admin-org-save")).toBeDisabled()
  })

  it("save calls PATCH /api/org with timezone", async () => {
    const capture: { body?: any } = {}
    const fetchMock = mockOrg({ capturePatch: capture })
    renderPage(AdminOrgSettings as any)
    await screen.findByTestId("admin-org-timezone-select")
    fireEvent.change(screen.getByTestId("admin-org-timezone-select"), {
      target: { value: "Europe/Paris" },
    })
    fireEvent.click(screen.getByTestId("admin-org-save"))
    await waitFor(() => {
      const patches = fetchMock.mock.calls.filter(
        (c) => (c[1] as RequestInit | undefined)?.method === "PATCH",
      )
      expect(patches.length).toBeGreaterThan(0)
    })
    expect(capture.body).toMatchObject({ timezone: "Europe/Paris" })
  })
})
