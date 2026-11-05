// SPDX-License-Identifier: FSL-1.1-ALv2
import { vi } from "vitest"

/**
 * Install a `fetch` mock that pattern-matches each request path against the
 * route map. Keys are matched via substring (`includes`), so call sites can
 * pass either a full path or just a fragment that uniquely identifies the
 * endpoint (handy for endpoints with dynamic query strings). Values are the
 * JSON `data` payload the `createApiClient` envelope unwrap will return.
 * Calling the helper again replaces the active map.
 */
export function mockApiClient(routes: Record<string, unknown>): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    for (const [needle, data] of Object.entries(routes)) {
      if (url.includes(needle)) {
        return new Response(JSON.stringify({ data }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
    }
    return new Response(
      JSON.stringify({ error: { message: "mock not configured", code: "mock_miss" } }),
      { status: 404, headers: { "content-type": "application/json" } },
    )
  })
}
