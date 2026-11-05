// SPDX-License-Identifier: FSL-1.1-ALv2
import { Route, Router } from "@solidjs/router"
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { onMount } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiProvider, useApi } from "~/modules/shell/ApiContext"
import { ToastContainer } from "~/modules/shell/Toast"
import { resetToastStore } from "~/modules/shell/toast-store"

function jsonResp(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

// A tiny component that fires a denied POST on mount, exercising the ApiProvider
// 403 handler (which turns a scope-named denial into an actionable toast).
function DeniedTrigger() {
  const api = useApi()
  onMount(() => {
    api.post("/contacts", { name: "x" }).catch(() => {})
  })
  return <ToastContainer />
}

function renderTrigger() {
  render(() => (
    <Router>
      <Route
        path="*"
        component={() => (
          <ApiProvider>
            <DeniedTrigger />
          </ApiProvider>
        )}
      />
    </Router>
  ))
}

describe("permission-denied actionable toast", () => {
  beforeEach(() => {
    resetToastStore()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    resetToastStore()
  })

  it("403 with missingScope shows a scope-named toast with a Request access action that POSTs", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.includes("/scope-requests") && init?.method === "POST") {
        return jsonResp({ data: { id: "req-1", status: "pending" } }, 201)
      }
      // The denied action.
      return jsonResp(
        {
          error: {
            code: "PERMISSION_DENIED",
            message: "Permission denied",
            details: { missingScope: "kernel:contacts:write", requestable: true },
          },
        },
        403,
      )
    })
    vi.stubGlobal("fetch", fetchMock)

    renderTrigger()

    // Scope-named toast appears.
    await screen.findByText(/kernel:contacts:write/)

    // ...with a "Request access" action button.
    const btn = await screen.findByRole("button", { name: /request access/i })
    fireEvent.click(btn)

    // Clicking it POSTs to /scope-requests with the missing scope.
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/scope-requests"),
        expect.objectContaining({ method: "POST" }),
      ),
    )
  })

  it("403 without missingScope shows a plain toast and no action button", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResp({ error: { code: "PERMISSION_DENIED", message: "Permission denied" } }, 403),
    )
    vi.stubGlobal("fetch", fetchMock)

    renderTrigger()

    await waitFor(() => expect(screen.getByTestId("toast-error")).toBeInTheDocument())
    expect(screen.queryByRole("button", { name: /request access/i })).toBeNull()
  })
})
