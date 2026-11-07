// SPDX-License-Identifier: FSL-1.1-ALv2
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ApiClient } from "~/lib/api-client"
import { ApiContext } from "~/modules/shell/ApiContext"

const state = vi.hoisted(() => ({ scopes: [] as string[], customApps: false }))
vi.mock("~/modules/auth/auth-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/modules/auth/auth-store")>()
  return { ...actual, hasScope: (s: string) => state.scopes.includes(s) }
})
vi.mock("~/modules/shell/branding-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/modules/shell/branding-store")>()
  return {
    ...actual,
    customAppsEnabled: () => state.customApps,
    ensureBrandingLoaded: async () => undefined,
  }
})

import { DraftsSection } from "./DraftsSection"

function mount(rows: unknown[] = []) {
  const api = { get: vi.fn(async () => rows) }
  render(() => (
    <ApiContext.Provider value={api as unknown as ApiClient}>
      <DraftsSection />
    </ApiContext.Provider>
  ))
  return api
}

beforeEach(() => {
  state.scopes = ["kernel:apps:build"]
  state.customApps = false
})
afterEach(cleanup)

describe("DraftsSection", () => {
  it("is absent, and asks nothing, where the server has organisations' own apps off", async () => {
    const api = mount()
    await Promise.resolve()
    expect(screen.queryByTestId("builder-drafts")).toBeNull()
    expect(api.get).not.toHaveBeenCalled()
  })

  it("lists the drafts where the server has them on", async () => {
    state.customApps = true
    const api = mount()
    await waitFor(() => expect(screen.getByTestId("builder-drafts-empty")).toBeTruthy())
    expect(api.get).toHaveBeenCalled()
  })

  it("names each draft by its title", async () => {
    state.customApps = true
    mount([
      {
        id: "d1",
        orgId: "o",
        baseName: "tracker",
        title: "Returns tracker",
        status: "draft",
        publishedAppName: null,
        latestVersion: 3,
        createdAt: "",
        updatedAt: "",
      },
    ])
    await waitFor(() =>
      expect(screen.getByTestId("builder-draft-d1").textContent).toContain("Returns tracker"),
    )
  })

  it("is absent, and asks nothing, without kernel:apps:build", async () => {
    state.customApps = true
    state.scopes = []
    const api = mount()
    await Promise.resolve()
    expect(screen.queryByTestId("builder-drafts")).toBeNull()
    expect(api.get).not.toHaveBeenCalled()
  })
})
