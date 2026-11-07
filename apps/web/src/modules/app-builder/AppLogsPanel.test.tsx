// SPDX-License-Identifier: FSL-1.1-ALv2
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ApiClient } from "~/lib/api-client"
import { ApiContext } from "~/modules/shell/ApiContext"

const state = vi.hoisted(() => ({ scopes: [] as string[] }))
vi.mock("~/modules/auth/auth-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/modules/auth/auth-store")>()
  return {
    ...actual,
    hasScope: (s: string) => state.scopes.includes("*") || state.scopes.includes(s),
  }
})

import { AppLogsPanel, showsAppLogs } from "./AppLogsPanel"
import { DraftsSection } from "./DraftsSection"

const APP = "tracker-oabcdef12"
const RUN = "22222222-2222-4222-8222-222222222222"

function mount(get: (path: string) => Promise<unknown>, node: () => any) {
  const api = { get: vi.fn(get), post: vi.fn(), rawGet: vi.fn() }
  render(() => (
    <ApiContext.Provider value={api as unknown as ApiClient}>{node()}</ApiContext.Provider>
  ))
  return api
}

beforeEach(() => {
  state.scopes = ["kernel:apps:logs"]
})
afterEach(cleanup)

describe("AppLogsPanel", () => {
  it("is shown for custom apps to holders of kernel:apps:logs only", () => {
    expect(showsAppLogs(APP)).toBe(true)
    expect(showsAppLogs("tickets")).toBe(false)
    state.scopes = []
    expect(showsAppLogs(APP)).toBe(false)
  })

  it("lists lines newest first and filters by level and run", async () => {
    const api = mount(
      async () => [
        {
          id: "1",
          app: APP,
          runId: RUN,
          level: "info",
          message: "older",
          fields: {},
          at: "2026-11-07T10:00:00Z",
        },
        {
          id: "2",
          app: APP,
          runId: RUN,
          level: "error",
          message: "newer",
          fields: {},
          at: "2026-11-07T11:00:00Z",
        },
      ],
      () => <AppLogsPanel app={APP} />,
    )
    await waitFor(() => expect(screen.getAllByTestId("app-log-line")).toHaveLength(2))
    const lines = screen.getAllByTestId("app-log-line")
    expect(lines[0]?.textContent).toContain("newer")
    expect(lines[0]?.dataset.level).toBe("error")
    expect(api.get).toHaveBeenLastCalledWith(`/apps/${APP}/logs?limit=200`, expect.anything())

    fireEvent.change(screen.getByTestId("app-logs-level"), { target: { value: "warn" } })
    await waitFor(() =>
      expect(api.get).toHaveBeenLastCalledWith(
        `/apps/${APP}/logs?level=warn&limit=200`,
        expect.anything(),
      ),
    )
    // A partial run id is not sent; clicking a line's run filters on it.
    fireEvent.input(screen.getByTestId("app-logs-run"), { target: { value: "2222" } })
    expect(api.get).toHaveBeenLastCalledWith(
      `/apps/${APP}/logs?level=warn&limit=200`,
      expect.anything(),
    )
    await waitFor(() => screen.getAllByTestId("app-log-run"))
    fireEvent.click(screen.getAllByTestId("app-log-run")[0] as HTMLElement)
    await waitFor(() =>
      expect(api.get).toHaveBeenLastCalledWith(
        `/apps/${APP}/logs?level=warn&runId=${RUN}&limit=200`,
        expect.anything(),
      ),
    )
  })

  it("says so when nothing was logged or the read failed", async () => {
    mount(
      async () => [],
      () => <AppLogsPanel app={APP} />,
    )
    await waitFor(() => screen.getByTestId("app-logs-empty"))
    cleanup()
    mount(
      async () => {
        throw new Error("boom")
      },
      () => <AppLogsPanel app={APP} />,
    )
    await waitFor(() => screen.getByTestId("app-logs-failed"))
  })
})

describe("DraftsSection", () => {
  it("lists the org's drafts for builders", async () => {
    state.scopes = ["kernel:apps:build"]
    mount(
      async () => [
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
      ],
      () => <DraftsSection />,
    )
    await waitFor(() =>
      expect(screen.getByTestId("builder-draft-d1").textContent).toContain("Returns tracker"),
    )
  })

  it("is absent without kernel:apps:build", () => {
    state.scopes = []
    const api = mount(
      async () => [],
      () => <DraftsSection />,
    )
    expect(screen.queryByTestId("builder-drafts")).toBeNull()
    expect(api.get).not.toHaveBeenCalled()
  })
})
