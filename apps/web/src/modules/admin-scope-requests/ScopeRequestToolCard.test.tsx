// SPDX-License-Identifier: FSL-1.1-ALv2
import { render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const scopes = vi.hoisted(() => ({ held: new Set<string>() }))
const apiMocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))

vi.mock("~/modules/auth/auth-store", async (orig) => ({
  ...(await orig<typeof import("~/modules/auth/auth-store")>()),
  hasScope: (scope: string) => scopes.held.has(scope),
}))
vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => apiMocks,
  useOptionalApi: () => apiMocks,
}))

import { I18nProvider } from "~/modules/i18n/i18n-context"
import ScopeRequestToolCard from "./ScopeRequestToolCard"
import { scopeRequestsStore } from "./scope-requests-store"

const row = (over: Record<string, unknown> = {}) => ({
  id: "sr-1",
  requestedBy: "u-1",
  requestedByName: "Dana",
  requestedByType: "agent",
  agentName: "Support Desk",
  targetUserId: "u-1",
  requestedScopes: ["kernel:approvals:write"],
  reason: "edit the pending draft",
  status: "pending",
  createdAt: "2026-10-22T10:00:00Z",
  updatedAt: "2026-10-22T10:00:00Z",
  ...over,
})

const mount = () =>
  render(() => (
    <I18nProvider>
      <ScopeRequestToolCard requestId="sr-1" />
    </I18nProvider>
  ))

describe("ScopeRequestToolCard", () => {
  beforeEach(() => {
    scopes.held.clear()
    apiMocks.get.mockReset()
  })
  afterEach(() => scopeRequestsStore.stop())

  it("an approver answers the pending request in place", async () => {
    scopes.held.add("kernel:scope_requests:admin")
    apiMocks.get.mockResolvedValue(row())
    mount()
    expect(await screen.findByTestId("scope-request-sr-1")).toBeInTheDocument()
    expect(apiMocks.get).toHaveBeenCalledWith("/scope-requests/sr-1")
  })

  it("shows nothing to someone who cannot grant access, and never asks the server", () => {
    mount()
    expect(screen.queryByTestId("scope-request-tool-card")).toBeNull()
    expect(apiMocks.get).not.toHaveBeenCalled()
  })

  it("shows nothing once the request was decided", async () => {
    scopes.held.add("kernel:scope_requests:admin")
    apiMocks.get.mockResolvedValue(row({ status: "approved" }))
    mount()
    await waitFor(() => expect(apiMocks.get).toHaveBeenCalled())
    expect(screen.queryByTestId("scope-request-tool-card")).toBeNull()
  })
})
