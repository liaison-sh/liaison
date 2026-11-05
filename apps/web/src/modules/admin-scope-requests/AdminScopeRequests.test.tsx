// SPDX-License-Identifier: FSL-1.1-ALv2
import { Route, Router } from "@solidjs/router"
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createApiClient } from "~/lib/api-client"
import AdminScopeRequests from "~/modules/admin-scope-requests/AdminScopeRequests"
import {
  pendingRequests,
  resetScopeRequestsStore,
  scopeRequestsStore,
} from "~/modules/admin-scope-requests/scope-requests-store"
import { DecisionQueueTestAccess } from "~/modules/approvals/decision-queue"
import { ApiProvider } from "~/modules/shell/ApiContext"

// These tests pin each surface's decide wiring; the 5 s Undo window itself is
// decision-queue.test.ts's.
beforeEach(() => {
  DecisionQueueTestAccess.reset()
  DecisionQueueTestAccess.setUndoWindow(0)
})

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

const PENDING_ROW = {
  id: "req-1",
  requestedBy: "user-1",
  requestedByName: "Alice",
  requestedByType: "user",
  targetUserId: "user-1",
  requestedScopes: ["kernel:contacts:write"],
  status: "pending",
  createdAt: "2026-06-09T10:00:00.000Z",
  updatedAt: "2026-06-09T10:00:00.000Z",
}

function renderInbox() {
  render(() => (
    <Router>
      <Route
        path="*"
        component={() => (
          <ApiProvider>
            <AdminScopeRequests />
          </ApiProvider>
        )}
      />
    </Router>
  ))
}

describe("AdminScopeRequests inbox", () => {
  beforeEach(() => {
    resetScopeRequestsStore()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    resetScopeRequestsStore()
  })

  it("admin approves a pending request from the inbox", async () => {
    const decideMock = vi.fn()
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.includes("/scope-requests/req-1/decide") && init?.method === "POST") {
        decideMock(url, init)
        return jsonResp({ data: { status: "approved" } }, 200)
      }
      if (url.includes("/scope-requests")) {
        return jsonResp({ data: [PENDING_ROW] }, 200)
      }
      return jsonResp({ data: [] }, 200)
    })
    vi.stubGlobal("fetch", fetchMock)

    renderInbox()

    const approveBtn = await screen.findByRole("button", { name: /approve/i })
    fireEvent.click(approveBtn)

    await waitFor(() =>
      expect(decideMock).toHaveBeenCalledWith(
        expect.stringContaining("/decide"),
        expect.objectContaining({ method: "POST" }),
      ),
    )
    // Row reflects the decision.
    expect(await screen.findByText(/approved/i)).toBeInTheDocument()
  })

  it("approver lacking the scope sees the inline 403 reason", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.includes("/scope-requests/req-1/decide") && init?.method === "POST") {
        return jsonResp(
          {
            error: {
              code: "PERMISSION_DENIED",
              message:
                "Cannot approve: you don't hold \"kernel:contacts:write\", so you can't grant it.",
              details: { missingScope: "kernel:contacts:write", requestable: true },
            },
          },
          403,
        )
      }
      if (url.includes("/scope-requests")) {
        return jsonResp({ data: [PENDING_ROW] }, 200)
      }
      return jsonResp({ data: [] }, 200)
    })
    vi.stubGlobal("fetch", fetchMock)

    renderInbox()

    const approveBtn = await screen.findByRole("button", { name: /approve/i })
    fireEvent.click(approveBtn)

    const err = await screen.findByTestId("scope-request-decide-error")
    expect(err).toHaveTextContent(/kernel:contacts:write/)
  })

  // I1: the scope_request WS broadcast carries only the attention summary (no row id),
  // so the bootstrap handler re-fetches via markStaleAndReload instead of an incremental
  // merge. This locks that a newly-arrived request surfaces immediately (no 60s poll wait).
  it("a WS-triggered reload surfaces a newly-arrived request without the poll", async () => {
    let pending: unknown[] = [PENDING_ROW]
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.includes("/scope-requests")) return jsonResp({ data: pending }, 200)
      return jsonResp({ data: [] }, 200)
    })
    vi.stubGlobal("fetch", fetchMock)
    const api = createApiClient({ getAccessToken: () => "tok", onUnauthorized: () => {} })

    await scopeRequestsStore.load(api)
    expect(pendingRequests().map((r) => r.id)).toEqual(["req-1"])

    // A second request arrives; a scope_request WS event triggers a reload.
    pending = [PENDING_ROW, { ...PENDING_ROW, id: "req-2", requestedScopes: ["kernel:org:admin"] }]
    scopeRequestsStore.markStaleAndReload(api)

    await waitFor(() => expect(pendingRequests().map((r) => r.id)).toContain("req-2"))
  })
})

// A request an agent filed credited the human whose turn it was and named no
// agent, so the admin could not tell who was asking. The row carries the same
// "via <agent>" line an approval card does.
describe("a request an agent filed", () => {
  beforeEach(() => {
    resetScopeRequestsStore()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    resetScopeRequestsStore()
  })

  // THE ROW PRINTED "ads:read" AND CLIPPED THE CASE FOR GRANTING. An admin
  // deciding on an access request had to know the scope catalog by heart, and
  // the reason, the one thing the decision turns on, was cut to a line.
  it("reads the capability beside the raw scope, and lets the reason wrap", async () => {
    const LONG_REASON =
      "The nightly campaign report needs yesterday's spend for every active adset, " +
      "which the reporting routine cannot assemble without reading the insights, " +
      "and the same routine already holds every other read it needs."
    const fetchMock = vi.fn(async () =>
      jsonResp({
        data: [
          {
            ...PENDING_ROW,
            requestedScopes: ["ads:read", "pennylane:transactions:read"],
            reason: LONG_REASON,
          },
        ],
      }),
    )
    vi.stubGlobal("fetch", fetchMock)
    renderInbox()
    await waitFor(() => expect(screen.getByTestId("scope-request-req-1")).toBeTruthy())

    const scopes = screen.getByTestId("scope-request-scopes")
    // The readable label the withheld card uses, BESIDE the raw scope: an
    // admin is entitled to the name, and the label is what makes it readable.
    expect(scopes.textContent).toContain("advertising")
    expect(scopes.textContent).toContain("ads:read")
    expect(scopes.textContent).toContain("finance data")
    expect(scopes.textContent).toContain("pennylane:transactions:read")

    const reason = screen.getByTestId("scope-request-reason")
    // The whole reason is in the DOM and the row does not clip it to one line.
    expect(reason.textContent).toBe(LONG_REASON)
    expect(reason.className).not.toContain("truncate")
    expect(reason.className).toContain("line-clamp-3")
    reason.click()
    await waitFor(() =>
      expect(screen.getByTestId("scope-request-reason").className).not.toContain("line-clamp"),
    )
  })

  it("names the agent beside the person whose turn it was", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResp({
        data: [
          {
            ...PENDING_ROW,
            requestedByType: "agent",
            requestedByName: "App Review",
            agentId: "agent-1",
            agentName: "Support Desk",
            requestedScopes: ["ads:insights:read"],
          },
        ],
      }),
    )
    vi.stubGlobal("fetch", fetchMock)
    renderInbox()
    await waitFor(() => expect(screen.getByTestId("scope-request-req-1")).toBeTruthy())
    const asker = screen.getByTestId("scope-request-asker")
    expect(asker.textContent).toContain("App Review")
    expect(asker.textContent).toContain("Support Desk")
  })
})
