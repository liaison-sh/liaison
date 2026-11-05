// SPDX-License-Identifier: FSL-1.1-ALv2
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { registerSavedViewsHandler, resetRegistry } from "~/framework/app-registry"

const ME = "00000000-0000-0000-0000-000000000001"
const USER2 = "00000000-0000-0000-0000-000000000002"

const userState = vi.hoisted(() => ({
  current: { userId: "00000000-0000-0000-0000-000000000001", scopes: ["*"] as string[] },
}))

vi.mock("~/modules/auth/auth-store", () => ({
  userFromToken: () => userState.current,
  hasScope: (s: string) =>
    userState.current.scopes.includes(s) || userState.current.scopes.includes("*"),
  accessToken: () => "test-token",
}))

import { SavedViewsList } from "./SavedViewsList"

function setUser(u: { userId: string; scopes: string[] }) {
  userState.current = u
}

function viewFixture(overrides: any = {}) {
  return {
    id: overrides.id ?? "v1",
    app: "tickets",
    viewId: "inbox",
    manifestKey: null,
    name: overrides.name ?? "Mine",
    payload: overrides.payload ?? { assignedTo: "$me" },
    ownerUserId: overrides.ownerUserId ?? ME,
    owner: overrides.owner ?? { id: ME, name: "Taylor", status: "active" },
    sharedWithOrg: overrides.sharedWithOrg ?? false,
    isDefault: false,
    position: 0,
    createdAt: "2026-05-11T00:00:00Z",
    updatedAt: "2026-05-11T00:00:00Z",
    ...overrides,
  }
}

function mockListResponse(views: any[]) {
  const calls: Array<{ url: string; method: string; body?: any }> = []
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })
    if ((init?.method ?? "GET") === "GET") {
      return new Response(JSON.stringify({ data: views }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    return new Response(JSON.stringify({ data: views[0] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  })
  vi.stubGlobal("fetch", fetchMock)
  return { fetchMock, calls }
}

describe("SavedViewsList", () => {
  beforeEach(() => {
    resetRegistry()
    setUser({ userId: ME, scopes: ["kernel:saved_views:share"] })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it("renders private then org-shared with section header", async () => {
    mockListResponse([
      viewFixture({ id: "v1", name: "Mine" }),
      viewFixture({
        id: "v2",
        name: "Team",
        ownerUserId: USER2,
        owner: { id: USER2, name: "Alice", status: "active" },
        sharedWithOrg: true,
      }),
    ])
    render(() => <SavedViewsList app="tickets" viewId="inbox" />)
    await waitFor(() => expect(screen.getByText("Mine")).toBeInTheDocument())
    expect(screen.getByText("Team")).toBeInTheDocument()
    expect(screen.getByTestId("saved-views-section-shared")).toBeInTheDocument()
  })

  it("click invokes registered handler.apply with $me substituted to current user id", async () => {
    mockListResponse([viewFixture({ id: "v1", name: "Mine", payload: { assignedTo: "$me" } })])
    const apply = vi.fn()
    registerSavedViewsHandler("tickets", "inbox", { capture: () => ({}), apply })
    render(() => <SavedViewsList app="tickets" viewId="inbox" />)
    fireEvent.click(await screen.findByText("Mine"))
    await waitFor(() => expect(apply).toHaveBeenCalledWith({ assignedTo: ME }))
  })

  it("renders '(deactivated)' byline for shared views from deactivated owners", async () => {
    mockListResponse([
      viewFixture({
        id: "v1",
        name: "Old",
        ownerUserId: USER2,
        owner: { id: USER2, name: "Alice", status: "deactivated" },
        sharedWithOrg: true,
      }),
    ])
    render(() => <SavedViewsList app="tickets" viewId="inbox" />)
    expect(await screen.findByText(/Shared by Alice \(deactivated\)/)).toBeInTheDocument()
  })

  it("delete sends DELETE /api/saved-views/:id", async () => {
    const { fetchMock, calls } = mockListResponse([viewFixture({ id: "v1", name: "Mine" })])
    render(() => <SavedViewsList app="tickets" viewId="inbox" />)
    await screen.findByText("Mine")
    fireEvent.click(screen.getByTestId("saved-view-overflow-v1"))
    fireEvent.click(screen.getByTestId("saved-view-action-delete-v1"))
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled()
      expect(
        calls.some((c) => c.method === "DELETE" && c.url.endsWith("/api/saved-views/v1")),
      ).toBe(true)
    })
  })

  it("rename sends PATCH /api/saved-views/:id with the new name", async () => {
    const { calls } = mockListResponse([viewFixture({ id: "v1", name: "Mine" })])
    render(() => <SavedViewsList app="tickets" viewId="inbox" />)
    await screen.findByText("Mine")
    fireEvent.click(screen.getByTestId("saved-view-overflow-v1"))
    fireEvent.click(screen.getByTestId("saved-view-action-rename-v1"))
    fireEvent.input(await screen.findByTestId("saved-view-dialog-name"), {
      target: { value: "Renamed" },
    })
    fireEvent.click(screen.getByTestId("saved-view-dialog-submit"))
    await waitFor(() => {
      expect(calls).toContainEqual(
        expect.objectContaining({
          method: "PATCH",
          url: "/api/saved-views/v1",
          body: { name: "Renamed" },
        }),
      )
    })
  })

  it("share and unshare send PATCH sharedWithOrg", async () => {
    const { calls } = mockListResponse([viewFixture({ id: "v1", name: "Mine" })])
    render(() => <SavedViewsList app="tickets" viewId="inbox" />)
    await screen.findByText("Mine")
    fireEvent.click(screen.getByTestId("saved-view-overflow-v1"))
    fireEvent.click(screen.getByTestId("saved-view-action-share-v1"))
    await waitFor(() => {
      expect(calls).toContainEqual(
        expect.objectContaining({
          method: "PATCH",
          url: "/api/saved-views/v1",
          body: { sharedWithOrg: true },
        }),
      )
    })
  })

  it("unshare sends PATCH sharedWithOrg false", async () => {
    const { calls } = mockListResponse([
      viewFixture({ id: "v1", name: "Mine", sharedWithOrg: true }),
    ])
    render(() => <SavedViewsList app="tickets" viewId="inbox" />)
    await screen.findByText("Mine")
    fireEvent.click(screen.getByTestId("saved-view-overflow-v1"))
    fireEvent.click(screen.getByTestId("saved-view-action-share-v1"))
    await waitFor(() => {
      expect(calls).toContainEqual(
        expect.objectContaining({
          method: "PATCH",
          url: "/api/saved-views/v1",
          body: { sharedWithOrg: false },
        }),
      )
    })
  })

  it("clone calls POST /api/saved-views/:id/clone", async () => {
    const { calls } = mockListResponse([
      viewFixture({
        id: "v1",
        name: "Team",
        ownerUserId: USER2,
        owner: { id: USER2, name: "Alice", status: "active" },
        sharedWithOrg: true,
      }),
    ])
    render(() => <SavedViewsList app="tickets" viewId="inbox" />)
    await screen.findByText("Team")
    fireEvent.click(screen.getByTestId("saved-view-overflow-v1"))
    fireEvent.click(screen.getByTestId("saved-view-action-clone-v1"))
    await waitFor(() => {
      expect(calls).toContainEqual(
        expect.objectContaining({ method: "POST", url: "/api/saved-views/v1/clone" }),
      )
    })
  })

  it("save current view calls handler.capture and POST /api/saved-views", async () => {
    const { calls } = mockListResponse([])
    const capture = vi.fn(() => ({ smartFilter: "all-open" }))
    registerSavedViewsHandler("tickets", "inbox", { capture, apply: vi.fn() })
    render(() => <SavedViewsList app="tickets" viewId="inbox" />)
    fireEvent.click(screen.getByTestId("saved-view-create"))
    fireEvent.input(await screen.findByTestId("saved-view-dialog-name"), {
      target: { value: "Current" },
    })
    fireEvent.click(screen.getByTestId("saved-view-dialog-submit"))
    await waitFor(() => {
      expect(capture).toHaveBeenCalled()
      expect(calls).toContainEqual(
        expect.objectContaining({
          method: "POST",
          url: "/api/saved-views",
          body: {
            app: "tickets",
            viewId: "inbox",
            name: "Current",
            payload: { smartFilter: "all-open" },
            sharedWithOrg: false,
          },
        }),
      )
    })
  })

  it("non-owner sees 'Clone to private' instead of Rename/Delete", async () => {
    mockListResponse([
      viewFixture({
        id: "v1",
        name: "Team",
        ownerUserId: USER2,
        owner: { id: USER2, name: "Alice", status: "active" },
        sharedWithOrg: true,
      }),
    ])
    render(() => <SavedViewsList app="tickets" viewId="inbox" />)
    await screen.findByText("Team")
    fireEvent.click(screen.getByTestId("saved-view-overflow-v1"))
    expect(screen.getByText("Clone to private")).toBeInTheDocument()
    expect(screen.queryByTestId("saved-view-action-delete-v1")).toBeNull()
  })
})
