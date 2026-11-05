// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The runner's MCP credential (lib/api.ts McpCredential). An MCP access token
// lives 15 minutes and a full matrix run takes longer, so the runner holds the
// connection's REFRESH token and mints access tokens from it: once, reused
// while fresh, again before the 15 minutes run out, and again on a 401.
import { describe, expect, it } from "bun:test"
import { ApiClient, McpCredential } from "./lib/api"
import { parseConfig } from "./lib/config"

const BASE = "https://demo.example"

interface Call {
  url: string
  auth: string | null
  body: string
}

function fakeFetch(answers: { mcpStatus?: number[] } = {}) {
  const calls: Call[] = []
  let minted = 0
  const mcpStatus = [...(answers.mcpStatus ?? [])]
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const headers = new Headers(init?.headers)
    calls.push({ url, auth: headers.get("Authorization"), body: String(init?.body ?? "") })
    if (url.endsWith("/mcp/oauth/token")) {
      minted++
      return new Response(JSON.stringify({ access_token: `access-${minted}`, expires_in: 900 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }
    if (url.endsWith("/mcp")) {
      const status = mcpStatus.shift() ?? 200
      if (status !== 200) return new Response("no", { status })
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }
    return new Response("not found", { status: 404 })
  }) as typeof fetch
  return { impl, calls, mintedCount: () => minted }
}

describe("McpCredential", () => {
  it("mints an access token from the refresh token and calls the tool with it", async () => {
    const f = fakeFetch()
    const cred = new McpCredential(BASE, { refreshToken: "conn.secret" }, f.impl)
    const client = new ApiClient(BASE, { email: "a@x", password: "p" }, f.impl)
    await client.mcpTool(cred, "kernel__notify_user", { summary: "x" })
    const mint = f.calls.find((c) => c.url.endsWith("/mcp/oauth/token"))
    expect(mint?.body).toContain("grant_type=refresh_token")
    expect(mint?.body).toContain("refresh_token=conn.secret")
    const tool = f.calls.find((c) => c.url.endsWith("/mcp"))
    expect(tool?.auth).toBe("Bearer access-1")
  })

  it("reuses a fresh token and mints again once it nears its 15 minute life", async () => {
    let now = 0
    const f = fakeFetch()
    const cred = new McpCredential(BASE, { refreshToken: "conn.secret" }, f.impl, () => now)
    expect(await cred.token()).toBe("access-1")
    now = 5 * 60_000
    expect(await cred.token()).toBe("access-1")
    now = 11 * 60_000
    expect(await cred.token()).toBe("access-2")
    expect(f.mintedCount()).toBe(2)
  })

  it("mints again and retries once when the tool call answers 401", async () => {
    const f = fakeFetch({ mcpStatus: [401, 200] })
    const cred = new McpCredential(BASE, { refreshToken: "conn.secret" }, f.impl)
    const client = new ApiClient(BASE, { email: "a@x", password: "p" }, f.impl)
    await client.mcpTool(cred, "kernel__notify_user", {})
    const tools = f.calls.filter((c) => c.url.endsWith("/mcp"))
    expect(tools.map((c) => c.auth)).toEqual(["Bearer access-1", "Bearer access-2"])
  })

  it("keeps a static access token as it is (no refresh token given)", async () => {
    const f = fakeFetch()
    const cred = new McpCredential(BASE, { accessToken: "static" }, f.impl)
    expect(await cred.token()).toBe("static")
    expect(f.mintedCount()).toBe(0)
  })
})

describe("MCP credentials from the environment", () => {
  it("reads the refresh tokens, and a static token still works", () => {
    const cfg = parseConfig([], {
      MATRIX_RECIPIENT_MCP_REFRESH_TOKEN: "r.1",
      MATRIX_SENDER_MCP_TOKEN: "s-static",
    })
    expect(cfg.recipientMcp).toEqual({ refreshToken: "r.1" })
    expect(cfg.senderMcp).toEqual({ accessToken: "s-static" })
    const none = parseConfig([], {})
    expect(none.recipientMcp).toBeNull()
    expect(none.senderMcp).toBeNull()
  })
})

// Every login is a new server session, and a user keeps at most 10: the
// runner re-logging in on each 401 (15-minute access tokens) evicted the
// simulator's and the desktop app's sessions mid-run on demo, signing those
// surfaces out. On a 401 the client now refreshes its own session.
describe("ApiClient session upkeep", () => {
  function sessionFetch() {
    const calls: Array<{ path: string; cookie: string | null; auth: string | null }> = []
    let issued = 0
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      const headers = new Headers(init?.headers)
      calls.push({
        path: url.pathname,
        cookie: headers.get("Cookie"),
        auth: headers.get("Authorization"),
      })
      const json = (body: unknown, extra: Record<string, string> = {}) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json", ...extra },
        })
      if (url.pathname === "/api/auth/login") {
        issued++
        return json(
          { data: { accessToken: `a${issued}`, userId: "u1", orgId: "o1" } },
          {
            "Set-Cookie": `liaison_rt=rt${issued}; Path=/api/auth; HttpOnly`,
          },
        )
      }
      if (url.pathname === "/api/auth/refresh") {
        issued++
        return json(
          { data: { accessToken: `a${issued}` } },
          {
            "Set-Cookie": `liaison_rt=rt${issued}; Path=/api/auth; HttpOnly`,
          },
        )
      }
      // The first token has expired; every later one is good.
      if (headers.get("Authorization") === "Bearer a1") return new Response("{}", { status: 401 })
      return json({ data: { ok: true } })
    }) as typeof fetch
    return { impl, calls }
  }

  it("refreshes with its session cookie on a 401 instead of signing in again", async () => {
    const f = sessionFetch()
    const client = new ApiClient(BASE, { email: "a@x", password: "p" }, f.impl)
    await client.login()
    await client.request("GET", "/notifications/settings")
    expect(f.calls.filter((c) => c.path === "/api/auth/login")).toHaveLength(1)
    const refresh = f.calls.find((c) => c.path === "/api/auth/refresh")
    expect(refresh?.cookie).toBe("liaison_rt=rt1")
    expect(f.calls.at(-1)?.auth).toBe("Bearer a2")
  })
})
