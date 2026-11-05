// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A stand in for the two Liaison routes a local session's token lives on: the
// MCP gateway (stateless streamable HTTP, one JSON-RPC request per POST, like
// `apps/api/src/modules/mcp/transport-routes.ts`) and the MCP OAuth token route
// (`refresh_token` grant, like `oauth-server-routes.ts`). Tokens are JWT shaped
// with an `exp` claim and expire on the server's clock, which a test moves, so
// "fifteen minutes later" takes no time at all.

import { NODE_TURN_CREDENTIAL_HEADER } from "../../../packages/shared/src/node-session-protocol"

export interface FakeLiaison {
  url: string
  mcpUrl: string
  tokenUrl: string
  /** A token the server accepts until `ttlMs` after `now()`. */
  mint(): string
  /** Moves the server's clock. */
  advance(ms: number): void
  now(): number
  /** The refresh token the token route accepts. */
  refreshToken: string
  /**
   * Every `tools/call`, with the token it presented, whether it was accepted,
   * and the turn credential header it carried (S59), null when none.
   */
  calls: Array<{ tool: string; token: string; accepted: boolean; turn: string | null }>
  /** How many renewals the token route granted. */
  renewals: number
  /** Revoke the connection: the token route refuses from now on. */
  revoke(): void
  stop(): void
}

export function fakeJwt(expSeconds: number, nonce: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({ exp: expSeconds, n: nonce })}.sig`
}

export function startFakeLiaison(options: { ttlMs: number; startMs?: number }): FakeLiaison {
  let clock = options.startMs ?? Date.now()
  let counter = 0
  let revoked = false
  const live = new Map<string, number>()
  const calls: FakeLiaison["calls"] = []
  const state = { renewals: 0 }
  const refreshToken = "conn-1.refresh-secret"

  const mint = () => {
    counter += 1
    const expiresAt = clock + options.ttlMs
    const token = fakeJwt(Math.floor(expiresAt / 1000), `t${counter}`)
    live.set(token, expiresAt)
    return token
  }
  const accepted = (header: string | null) => {
    const token = header?.startsWith("Bearer ") ? header.slice(7) : ""
    const expiresAt = live.get(token)
    return { token, ok: expiresAt !== undefined && expiresAt > clock }
  }
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/mcp/oauth/token" && request.method === "POST") {
        const form = new URLSearchParams(await request.text())
        if (
          revoked ||
          form.get("grant_type") !== "refresh_token" ||
          form.get("refresh_token") !== refreshToken
        ) {
          return json({ error: "invalid_grant" }, 400)
        }
        state.renewals += 1
        return json({
          access_token: mint(),
          token_type: "Bearer",
          expires_in: Math.floor(options.ttlMs / 1000),
          refresh_token: refreshToken,
        })
      }
      if (url.pathname !== "/mcp") return new Response("not found", { status: 404 })
      if (request.method !== "POST") return new Response(null, { status: 405 })
      const auth = accepted(request.headers.get("authorization"))
      const rpc = (await request.json()) as {
        id?: number | string
        method: string
        params?: { name?: string }
      }
      if (rpc.method === "tools/call") {
        calls.push({
          tool: rpc.params?.name ?? "",
          token: auth.token,
          accepted: auth.ok,
          turn: request.headers.get(NODE_TURN_CREDENTIAL_HEADER),
        })
      }
      if (!auth.ok) return json({ error: "invalid_token" }, 401)
      if (rpc.id === undefined) return new Response(null, { status: 202 })
      if (rpc.method === "initialize") {
        return json({
          jsonrpc: "2.0",
          id: rpc.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "fake-liaison", version: "1.0.0" },
          },
        })
      }
      if (rpc.method === "tools/list") {
        return json({
          jsonrpc: "2.0",
          id: rpc.id,
          result: {
            tools: [
              {
                name: "liaison_ping",
                description: "Answers pong. Call it when asked to ping Liaison.",
                inputSchema: { type: "object", properties: {} },
              },
            ],
          },
        })
      }
      if (rpc.method === "tools/call") {
        return json({
          jsonrpc: "2.0",
          id: rpc.id,
          result: { content: [{ type: "text", text: "pong" }] },
        })
      }
      return json({ jsonrpc: "2.0", id: rpc.id, result: {} })
    },
  })

  const url = `http://127.0.0.1:${server.port}`
  return {
    url,
    mcpUrl: `${url}/mcp`,
    tokenUrl: `${url}/mcp/oauth/token`,
    mint,
    advance: (ms) => {
      clock += ms
    },
    now: () => clock,
    refreshToken,
    calls,
    get renewals() {
      return state.renewals
    },
    revoke: () => {
      revoked = true
    },
    stop: () => server.stop(true),
  }
}
