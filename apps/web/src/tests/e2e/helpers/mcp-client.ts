// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 12 MCP E2E helper: the OAuth dance + SDK client construction, factored
// out of S0–S4. The MCP SDK lives only in `apps/api`'s node_modules; this file
// lazy-imports the cross-package shim
// (`apps/api/src/tests/e2e/helpers/mcp-test-client`) via the exact pattern the
// fixture uses for `mock-drive` — there is NO bare `@modelcontextprotocol/sdk`
// specifier anywhere under `apps/web`.
import { createHash, randomBytes } from "node:crypto"
import type { StandardWorld } from "@liaison/test-helpers"
import { api, type WorkerEnv } from "@liaison/test-helpers"
import { freshAccessToken } from "./fresh-token"

// Mirror of the shim's connected-client return shape (kept structural so this
// file needs no SDK types).
export interface McpClientHandle {
  // biome-ignore lint/suspicious/noExplicitAny: SDK Client type lives in apps/api
  client: any
  // biome-ignore lint/suspicious/noExplicitAny: SDK transport type lives in apps/api
  transport: any
}

export interface McpConnectionHandle extends McpClientHandle {
  accessToken: string
  refreshToken: string
  clientId: string
  connectionId: string
}

const SHIM = "../../../../../api/src/tests/e2e/helpers/mcp-test-client"

async function connectMcpClient(serverUrl: string, accessToken: string): Promise<McpClientHandle> {
  const mod = await import(SHIM)
  return mod.connectMcpClient(serverUrl, accessToken)
}

/** DCR — register a public OAuth client. Returns the minted client id. */
export async function registerOAuthClient(
  serverUrl: string,
  opts: { clientName: string; redirectUri: string },
): Promise<{ clientId: string }> {
  const res = await fetch(`${serverUrl}/mcp/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: opts.clientName,
      redirect_uris: [opts.redirectUri],
    }),
  })
  const body = (await res.json()) as { client_id?: string }
  if (res.status !== 201 || !body.client_id) {
    throw new Error(`registerOAuthClient failed (${res.status}): ${JSON.stringify(body)}`)
  }
  return { clientId: body.client_id }
}

/** PKCE S256 pair — base64url(sha256(verifier)). */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url") // ≥ 43 chars
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  return { verifier, challenge }
}

/**
 * POST the OAuth token endpoint. The endpoint reads a form body
 * (`c.req.parseBody()`), so this MUST be `application/x-www-form-urlencoded` —
 * the `api()` helper always JSON-encodes, so we use raw `fetch` here.
 */
export async function oauthToken(
  serverUrl: string,
  form: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${serverUrl}/mcp/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  })
  let body: Record<string, unknown>
  try {
    body = (await res.json()) as Record<string, unknown>
  } catch {
    body = { _rawText: await res.text().catch(() => "") }
  }
  return { status: res.status, body }
}

/**
 * Full Authorization-Code + PKCE journey via the SOLE consent path:
 *  1. DCR
 *  2. GET /authorize — assert the consent HTML renders (real validateAuthorize)
 *  3. authenticated POST /authorize/consent?...&consent=approve
 *     (Bearer = just-in-time freshAccessToken — NEVER a cached qa.*.token)
 *  4. token exchange → connected SDK Client
 *
 * No `page`, no browser-Approve branch: the API-origin consent page cannot see
 * the Vite-origin web-login cookie (port-scoped), so the authenticated POST is
 * the only — and the production — consent path.
 */
/**
 * A fresh emailed step-up code for connecting an AI tool with full access, stored
 * as `POST /api/auth/totp/step-up` (purpose `mcp_connect`) stores it, for the
 * user the access token belongs to. The emailed code is the only proof such an
 * approval takes.
 */
async function seedMcpConnectCode(env: WorkerEnv, accessToken: string): Promise<string> {
  const payload = accessToken.split(".")[1]
  if (!payload) throw new Error("malformed access token (no JWT payload)")
  const { userId } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
    userId?: string
  }
  if (!userId) throw new Error("access token missing userId claim")
  const code = String(100000 + Math.floor(Math.random() * 900000))
  await env.redis.redis.set(
    `${env.redisPrefix}totp:stepup:${userId}:mcp_connect`,
    createHash("sha256").update(code).digest("hex"),
    "EX",
    600,
  )
  return code
}

export async function establishMcpConnection(
  env: WorkerEnv,
  qa: StandardWorld,
  opts: {
    clientName: string
    /** Consenting user. Defaults to admin (the world admin). */
    as?: { email: string; password: string }
  },
): Promise<McpConnectionHandle> {
  const consenter = opts.as ?? { email: qa.admin.email, password: "12345678" }
  const redirectUri = "http://localhost:1/callback"
  const { clientId } = await registerOAuthClient(env.serverUrl, {
    clientName: opts.clientName,
    redirectUri,
  })
  const { verifier, challenge } = pkcePair()
  const state = `st-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  })

  // GET /authorize → public consent HTML (exercises validateAuthorize).
  const authzRes = await fetch(`${env.serverUrl}/mcp/oauth/authorize?${params.toString()}`)
  const authzHtml = await authzRes.text()
  if (authzRes.status !== 200 || !authzHtml.includes(`Connect ${opts.clientName}`)) {
    throw new Error(`consent page did not render (${authzRes.status}): ${authzHtml.slice(0, 200)}`)
  }

  // Authenticated consent POST — the only place a code is minted.
  const token = await freshAccessToken(env.serverUrl, consenter.email, consenter.password)
  const consentRes = await fetch(
    `${env.serverUrl}/mcp/oauth/authorize/consent?${params.toString()}&consent=approve&ack=full`,
    // Full access (no agent binding) also takes a fresh step-up: the emailed code.
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ stepUpCode: await seedMcpConnectCode(env, token) }),
    },
  )
  const consentBody = (await consentRes.json()) as { redirect?: string }
  if (consentRes.status !== 200 || !consentBody.redirect) {
    throw new Error(`consent POST failed (${consentRes.status}): ${JSON.stringify(consentBody)}`)
  }
  const code = new URL(consentBody.redirect).searchParams.get("code")
  if (!code) {
    throw new Error(`no code in redirect: ${consentBody.redirect}`)
  }

  const tok = await oauthToken(env.serverUrl, {
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    client_id: clientId,
    redirect_uri: redirectUri,
  })
  if (tok.status !== 200 || typeof tok.body.access_token !== "string") {
    throw new Error(`token exchange failed (${tok.status}): ${JSON.stringify(tok.body)}`)
  }
  const accessToken = tok.body.access_token as string
  const refreshToken = tok.body.refresh_token as string
  const connectionId = mcpConnectionIdFromToken(accessToken)

  const { client, transport } = await connectMcpClient(env.serverUrl, accessToken)
  return { client, transport, accessToken, refreshToken, clientId, connectionId }
}

/** Decode the `mcpConnectionId` claim from an MCP access JWT (no verification —
 *  the test only needs the connection id to locate the Settings row). */
export function mcpConnectionIdFromToken(accessToken: string): string {
  const payload = accessToken.split(".")[1]
  if (!payload) throw new Error("malformed access token (no JWT payload)")
  const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
    mcpConnectionId?: string
  }
  if (!json.mcpConnectionId) {
    throw new Error("access token missing mcpConnectionId claim")
  }
  return json.mcpConnectionId
}

/** Build a connected SDK client from an already-minted access token. */
export async function mcpClientFromToken(
  serverUrl: string,
  accessToken: string,
): Promise<McpClientHandle> {
  return connectMcpClient(serverUrl, accessToken)
}

/**
 * S4 device-flow path: initiate → authenticated approve (Bearer =
 * freshAccessToken). Returns the device/user codes; the caller polls
 * `pollDeviceGrant` (so it can use Playwright `expect.poll` for the
 * rate-limit-respecting interval).
 */
export async function initiateAndApproveDeviceGrant(
  env: WorkerEnv,
  qa: StandardWorld,
  opts: { clientId: string },
): Promise<{ deviceCode: string; userCode: string }> {
  const initiate = await api(env.serverUrl, "/mcp/device/initiate", {
    method: "POST",
    body: { clientId: opts.clientId },
  })
  if (initiate.status !== 200) {
    throw new Error(`device initiate failed (${initiate.status}): ${JSON.stringify(initiate.body)}`)
  }
  const { deviceCode, userCode } = initiate.body.data as {
    deviceCode: string
    userCode: string
  }

  const approverToken = await freshAccessToken(env.serverUrl, qa.admin.email, "12345678")
  // No agent binding: the connection carries the approver's whole access, which
  // the approve route only accepts with that confirmed explicitly and a fresh
  // step-up (the emailed code).
  const approve = await api(env.serverUrl, `/api/auth/device-flow/approve/${userCode}`, {
    method: "POST",
    token: approverToken,
    body: { confirmFullAccess: true, stepUpCode: await seedMcpConnectCode(env, approverToken) },
  })
  if (approve.status !== 200) {
    throw new Error(`device approve failed (${approve.status}): ${JSON.stringify(approve.body)}`)
  }
  return { deviceCode, userCode }
}

/** One device-grant poll round-trip. */
export async function pollDeviceGrant(
  serverUrl: string,
  deviceCode: string,
  clientId: string,
): Promise<{ status: string; accessToken?: string; refreshToken?: string }> {
  const res = await api(
    serverUrl,
    `/mcp/device/poll/${deviceCode}?client_id=${encodeURIComponent(clientId)}`,
  )
  // 429 = slow_down (rate-limit); surface as a transient pending so expect.poll
  // keeps polling at the >=1.1s interval.
  if (res.status === 429) return { status: "authorization_pending" }
  return (res.body?.data ?? {}) as {
    status: string
    accessToken?: string
    refreshToken?: string
  }
}

/** Close an SDK client; safe to call in a test `finally`. */
export async function closeMcpClient(handle: McpClientHandle | null): Promise<void> {
  if (!handle?.client) return
  try {
    await handle.client.close()
  } catch {
    // best-effort — teardown of an already-dead transport must not fail a test
  }
}
