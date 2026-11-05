// SPDX-License-Identifier: FSL-1.1-ALv2
// Settings → Organization → Export organization (S3.7 and its charter): the
// five states (empty, running, completed, failed, expired), one active Export
// button at a time, a download only for a completed export.

import type { ShippedLocale } from "@liaison/shared"
import { Route, Router } from "@solidjs/router"
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import OrgExportSection from "~/modules/settings/OrgExportSection"
import { ApiProvider } from "~/modules/shell/ApiContext"

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

const base = {
  requestedBy: "u1",
  requestedByName: "Ada Admin",
  requestedVia: "settings",
  error: null,
  createdAt: "2026-10-30T10:00:00.000Z",
  completedAt: null,
  expiresAt: null,
  bytes: null,
}

function renderWith(
  list: unknown[],
  extra?: (url: string, init?: RequestInit) => Response | null,
  locale: ShippedLocale = "en",
) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const hit = extra?.(String(url), init)
    if (hit) return hit
    if (String(url).endsWith("/org/export") && (!init?.method || init.method === "GET")) {
      return jsonResp({ data: list })
    }
    return jsonResp({})
  })
  vi.stubGlobal("fetch", fetchMock)
  window.history.pushState({}, "", "/settings/admin/org")
  render(() => (
    <Router>
      <Route
        path="*"
        component={() => (
          <I18nProvider initialLocale={locale}>
            <ApiProvider>
              <OrgExportSection />
            </ApiProvider>
          </I18nProvider>
        )}
      />
    </Router>
  ))
  return fetchMock
}

afterEach(() => vi.unstubAllGlobals())

describe("OrgExportSection", () => {
  it("empty: says there is no export yet and offers the button", async () => {
    renderWith([])
    expect(await screen.findByTestId("org-export-empty")).toBeInTheDocument()
    expect(screen.getByTestId("org-export-start")).not.toBeDisabled()
    expect(screen.getByTestId("org-export-help").textContent).toContain("7 days")
  })

  it("running: the row says so and the button is disabled", async () => {
    renderWith([{ ...base, id: "e1", status: "running" }])
    expect(await screen.findByTestId("org-export-status-e1")).toHaveTextContent(/running|progress/i)
    expect(screen.getByTestId("org-export-start")).toBeDisabled()
    expect(screen.queryByTestId("org-export-download-e1")).toBeNull()
  })

  it("completed: size, expiry and a download that fetches a fresh link", async () => {
    // The link is followed as a download, never a navigation: the Settings
    // page stays even when the link fails.
    const clicked: HTMLAnchorElement[] = []
    const assign = vi.fn(function (this: HTMLAnchorElement) {
      clicked.push(this)
    })
    const fetchMock = renderWith(
      [
        {
          ...base,
          id: "e2",
          status: "completed",
          bytes: 5 * 1024 * 1024,
          completedAt: "2026-10-30T10:05:00.000Z",
          expiresAt: "2099-11-06T10:05:00.000Z",
        },
      ],
      (url) =>
        url.endsWith("/org/export/e2/download")
          ? jsonResp({
              data: { url: "/api/org-export-dl/tok", delivery: "relay", expiresInSec: 300 },
            })
          : null,
    )
    expect(await screen.findByTestId("org-export-size-e2")).toHaveTextContent("5 MB")
    expect(screen.getByTestId("org-export-expires-e2").textContent).not.toBe("")
    expect(screen.getByTestId("org-export-requester-e2")).toHaveTextContent("Ada Admin")
    expect(screen.getByTestId("org-export-start")).not.toBeDisabled()
    const opened = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(assign)
    fireEvent.click(screen.getByTestId("org-export-download-e2"))
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([u]) => String(u).endsWith("/org/export/e2/download")),
      ).toBe(true),
    )
    await waitFor(() => expect(assign).toHaveBeenCalled())
    expect(clicked[0]?.hasAttribute("download")).toBe(true)
    expect(clicked[0]?.getAttribute("href")).toBe("/api/org-export-dl/tok")
    opened.mockRestore()
  })

  it("French: the size says Ko/Mo, not KB/MB", async () => {
    renderWith(
      [
        {
          ...base,
          id: "e6",
          status: "completed",
          bytes: 397_845,
          completedAt: "2026-10-30T10:05:00.000Z",
          expiresAt: "2099-11-06T10:05:00.000Z",
        },
      ],
      () => null,
      "fr",
    )
    expect(await screen.findByTestId("org-export-size-e6")).toHaveTextContent("389 Ko")
  })

  it("failed: says it failed, in plain words, with no download", async () => {
    renderWith([
      {
        ...base,
        id: "e3",
        status: "failed",
        error:
          "EXPORT_TOO_LARGE: a zip archive without ZIP64 holds at most 4294967296 bytes and 65000 entries; this export reached 1 bytes and 70000 entries",
      },
    ])
    expect(await screen.findByTestId("org-export-status-e3")).toHaveTextContent(/failed/i)
    expect(screen.getByTestId("org-export-failed-e3")).toHaveTextContent(/too large/i)
    expect(screen.queryByTestId("org-export-download-e3")).toBeNull()
    expect(document.body.textContent).not.toContain("ZIP64")
  })

  it("expired: says so with no download, also when the sweep has not run yet", async () => {
    renderWith([
      { ...base, id: "e4", status: "expired", bytes: 10 },
      {
        ...base,
        id: "e5",
        status: "completed",
        bytes: 10,
        expiresAt: "2020-01-01T00:00:00.000Z",
      },
    ])
    expect(await screen.findByTestId("org-export-status-e4")).toHaveTextContent(/expired/i)
    expect(screen.getByTestId("org-export-status-e5")).toHaveTextContent(/expired/i)
    expect(screen.queryByTestId("org-export-download-e4")).toBeNull()
    expect(screen.queryByTestId("org-export-download-e5")).toBeNull()
  })

  it("starting an export posts and shows it running", async () => {
    let list: unknown[] = []
    const fetchMock = renderWith([], (url, init) => {
      if (url.endsWith("/org/export") && init?.method === "POST") {
        list = [{ ...base, id: "e6", status: "queued" }]
        return jsonResp({ data: { id: "e6", status: "queued" } }, 202)
      }
      if (url.endsWith("/org/export")) return jsonResp({ data: list })
      return null
    })
    await screen.findByTestId("org-export-empty")
    fireEvent.click(screen.getByTestId("org-export-start"))
    expect(await screen.findByTestId("org-export-status-e6")).toBeInTheDocument()
    expect(screen.getByTestId("org-export-start")).toBeDisabled()
    expect(
      fetchMock.mock.calls.some(([, i]) => (i as RequestInit | undefined)?.method === "POST"),
    ).toBe(true)
  })
})
