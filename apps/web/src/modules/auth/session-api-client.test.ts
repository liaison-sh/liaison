// SPDX-License-Identifier: FSL-1.1-ALv2
//
// EVERY SIGNED-IN CLIENT REFRESHES THROUGH THE ONE AUTH MANAGER. A client
// built without its refresh hooks sends an expired token, meets a 401 and
// either fails or starts a rotation of its own beside the page's: on a page
// coming back from the background that is a second rotation racing the first.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

function makeJwt(exp: number, n: number): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const body = btoa(
    JSON.stringify({
      userId: "u1",
      orgId: "o1",
      name: "T",
      roles: [],
      scopes: [],
      dimensionGrants: {},
      exp,
      n,
    }),
  )
  return `${header}.${body}.sig`
}

const nowS = () => Math.floor(Date.now() / 1000)

describe("the session's api clients", () => {
  beforeEach(() => {
    vi.resetModules()
    window.localStorage.clear()
  })
  afterEach(async () => {
    const { _teardownAuth } = await import("~/modules/auth/auth-store")
    _teardownAuth()
    vi.unstubAllGlobals()
  })

  it("joins the single refresh for an expired token, from any of them", async () => {
    let refreshes = 0
    const fresh = makeJwt(nowS() + 900, 1)
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        if (String(input).includes("/auth/refresh")) {
          refreshes += 1
          await new Promise((resolve) => setTimeout(resolve, 20))
          return new Response(JSON.stringify({ data: { accessToken: fresh } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        }
        const ok = new Headers(init?.headers).get("Authorization") === `Bearer ${fresh}`
        return new Response(
          JSON.stringify(ok ? { data: {} } : { error: { code: "invalid_token" } }),
          {
            status: ok ? 200 : 401,
            headers: { "Content-Type": "application/json" },
          },
        )
      }),
    )
    const store = await import("~/modules/auth/auth-store")
    const { createAuthManager } = await import("~/modules/auth/createAuthManager")
    const { createSessionApiClient } = await import("~/modules/auth/session-api-client")
    const manager = createAuthManager()
    const a = createSessionApiClient({ onUnauthorized: () => {} }, manager)
    const b = createSessionApiClient({ onUnauthorized: () => {} }, manager)
    store.setTokens(makeJwt(nowS() - 60, 0))
    void manager.ensureFreshToken()
    await Promise.all([a.get("/nodes/me"), b.get("/agents"), a.get("/threads")])
    expect(refreshes).toBe(1)
    expect(store.accessToken()).toBe(fresh)
  })

  // The clients the shell and the startup module own, built at module scope:
  // none of them is a bare createApiClient that skips the refresh.
  it("is how the shell and startup build their signed-in clients", () => {
    const src = join(import.meta.dirname, "..", "..")
    for (const file of ["modules/shell/Shell.tsx", "startup.ts"]) {
      const body = readFileSync(join(src, file), "utf8")
      expect({ file, bare: /\bcreateApiClient\(/.test(body) }).toEqual({ file, bare: false })
      expect(body).toMatch(/\bcreateSessionApiClient\(/)
    }
  })
})
