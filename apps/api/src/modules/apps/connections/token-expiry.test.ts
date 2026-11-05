// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `tokenDebugUrl` (Meta's debug_token): the token's own expiry and its data
// access expiry, asked of the provider with the app token, for the expiry
// reminder (attention.ts). A failed or empty answer keeps the stored expiry.
import { afterEach, describe, expect, it } from "bun:test"
import { OutboundFetchTestAccess } from "~/lib/outbound-fetch"
import { fetchTokenExpiry } from "~/modules/apps/connections/service"

const URL_ = "https://graph.facebook.com/v26.0/debug_token"
const CTX = { orgId: "o", appName: "social", connectionName: "facebook" }

afterEach(() => OutboundFetchTestAccess.setFetch(null))

function answer(body: unknown, status = 200, seen: Array<{ url: string; auth: string }> = []) {
  OutboundFetchTestAccess.setFetch((async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({
      url: String(input),
      auth: new Headers(init?.headers).get("authorization") ?? "",
    })
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })
  }) as never)
  return seen
}

describe("fetchTokenExpiry", () => {
  it("reads both expiries, with the app token as bearer and never in the URL", async () => {
    const seen = answer({
      data: { expires_at: 1_800_000_000, data_access_expires_at: 1_790_000_000 },
    })
    const got = await fetchTokenExpiry(URL_, "user-token", "app-id|app-secret", CTX)
    expect(got).toMatchObject({
      expiresAt: new Date(1_800_000_000 * 1000).toISOString(),
      dataAccessExpiresAt: new Date(1_790_000_000 * 1000).toISOString(),
    })
    expect(seen[0]?.url).toContain("input_token=user-token")
    expect(seen[0]?.url).not.toContain("app-secret")
    expect(seen[0]?.auth).toBe("Bearer app-id|app-secret")
  })

  it("reads 0 as never", async () => {
    answer({ data: { expires_at: 0 } })
    expect(await fetchTokenExpiry(URL_, "t", "a|s", CTX)).toMatchObject({
      expiresAt: null,
      dataAccessExpiresAt: null,
    })
  })

  it("keeps the stored expiry (null) on a refusal or an empty answer", async () => {
    answer({ error: { message: "bad" } }, 400)
    expect(await fetchTokenExpiry(URL_, "t", "a|s", CTX)).toBeNull()
    answer({ data: {} })
    expect(await fetchTokenExpiry(URL_, "t", "a|s", CTX)).toBeNull()
  })
})
