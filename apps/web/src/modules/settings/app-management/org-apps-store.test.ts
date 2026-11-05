// SPDX-License-Identifier: FSL-1.1-ALv2
// MGT-14: an admin's own add, remove or On/Off changes which apps the main
// sidebar lists. The store tells the shell to resync its manifests right after
// the change, so the sidebar follows without a reload (other sessions hear the
// `kernel:org_app:update` event).
import { afterEach, describe, expect, it, vi } from "vitest"
import { onAppsChanged } from "~/framework/unavailable-apps"
import { type ApiClient, createApiClient } from "~/lib/api-client"
import { orgAppsStore } from "./org-apps-store"

const VIEW = { name: "monitoring", status: "active", accessMode: "everyone", principals: {} }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

/** The real client over a stubbed network: POSTs answer the new state, GETs an empty list. */
function fakeApi() {
  let refuseNextPost = false
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST" && refuseNextPost) {
        refuseNextPost = false
        return json(
          { error: { message: "knowledge cannot be removed", code: "app_required" } },
          409,
        )
      }
      return json({ data: init?.method === "POST" ? VIEW : [] })
    }),
  )
  const api: ApiClient = createApiClient({ getAccessToken: () => "t", onUnauthorized: vi.fn() })
  return { api, refuseNextPost: () => (refuseNextPost = true) }
}

describe("orgAppsStore: the shell resyncs after an admin's change", () => {
  const off: Array<() => void> = []
  afterEach(() => {
    for (const fn of off.splice(0)) fn()
    orgAppsStore.reset()
    vi.unstubAllGlobals()
  })

  for (const [label, act] of [
    ["add", (api: ApiClient) => orgAppsStore.add(api, "monitoring")],
    ["remove", (api: ApiClient) => orgAppsStore.remove(api, "monitoring")],
    ["turn off", (api: ApiClient) => orgAppsStore.setEnabled(api, "monitoring", false)],
    ["turn on", (api: ApiClient) => orgAppsStore.setEnabled(api, "monitoring", true)],
  ] as const) {
    it(`${label} asks for a manifest resync once the server answered`, async () => {
      const heard = vi.fn()
      off.push(onAppsChanged(heard))
      await act(fakeApi().api)
      expect(heard).toHaveBeenCalledTimes(1)
    })
  }

  it("a refused change asks for nothing", async () => {
    const heard = vi.fn()
    off.push(onAppsChanged(heard))
    const { api, refuseNextPost } = fakeApi()
    refuseNextPost()
    await expect(orgAppsStore.remove(api, "knowledge")).rejects.toThrow()
    expect(heard).not.toHaveBeenCalled()
  })
})
