// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S8: the Messages badge reads the server total through the REAL api client,
// whose `get` unwraps the `{ data }` envelope. The store read `res.data.count`,
// which only the tests' hand-made mocks returned, so in the app the server total
// was never taken and the badge showed the local sum of the 50 listed threads
// (walked on demo: badge 30, server total 37).
import { afterEach, describe, expect, it, vi } from "vitest"
import { createApiClient } from "~/lib/api-client"
import {
  messagesUnreadCount,
  refreshUnreadCount,
  resetUnreadCountStore,
  setUnreadCountApi,
} from "~/modules/threads/unread-count-store"

describe("Messages badge with the real api client", () => {
  afterEach(() => {
    resetUnreadCountStore()
    vi.unstubAllGlobals()
  })

  it("takes the server total from /threads/unread-count", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: { count: 37 } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    )
    const api = createApiClient({ getAccessToken: () => "t", onUnauthorized: () => {} })
    setUnreadCountApi(api)
    await refreshUnreadCount()
    expect(messagesUnreadCount()).toBe(37)
  })
})
