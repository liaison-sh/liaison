// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An ended session's access tokens stop working at once, through the real
// routes (session-revocation.ts): sign-out, password change, and a sign-out
// handled by ANOTHER server process (pub/sub, and the resync a process runs on
// boot). Its open WebSockets close, and a ticket minted before the end opens
// nothing.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Server } from "bun"
import { decodeJwt } from "jose"
import { app } from "~/app"
import { LIVE_INSTANCE_KEY } from "~/infra/instance-registry"
import { WebSocketManager } from "~/infra/websocket"
import { env } from "~/lib/env"
import { redis } from "~/lib/redis"
import { createServer, type WsData } from "~/lib/server"
import { signAccessToken } from "~/modules/auth/jwt"
import { initSessionRevocation, isSessionRevoked } from "~/modules/auth/session-revocation"
import { consumeWsTicket } from "~/modules/auth/ws-ticket"
import { acquireTestLock, clearRedisPatterns, releaseTestLock } from "~/tests/route-test-setup"

const ORIGIN = "http://localhost:5173"
const EMAIL = "sessionrevoke@test.com"
const PASSWORD = "testpass123"

interface Pair {
  cookie: string
  accessToken: string
}

function cookieOf(res: Response): string {
  const header = res.headers.get("set-cookie") ?? ""
  const rt = header
    .split(/,(?=\s*[^;,=\s]+=)/)
    .map((v) => v.trim())
    .find((v) => v.includes("liaison_rt="))
  if (!rt) throw new Error(`no refresh cookie in: ${header}`)
  return rt.split(";")[0] as string
}

async function pairOf(res: Response): Promise<Pair> {
  expect(res.status).toBe(200)
  const body = (await res.json()) as { data: { accessToken: string } }
  return { cookie: cookieOf(res), accessToken: body.data.accessToken }
}

async function login(password = PASSWORD): Promise<Pair> {
  return pairOf(
    await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ email: EMAIL, password }),
    }),
  )
}

async function logout(cookie: string): Promise<void> {
  const res = await app.request("/api/auth/logout", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
    body: "{}",
  })
  expect(res.status).toBe(200)
}

async function statusWith(accessToken: string): Promise<number> {
  const res = await app.request("/api/auth/totp/status", {
    headers: { Authorization: `Bearer ${accessToken}`, Origin: ORIGIN },
  })
  return res.status
}

const sidOf = (accessToken: string) => decodeJwt(accessToken).sid as string

async function until(ok: () => boolean, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms
  while (!ok() && Date.now() < end) await Bun.sleep(20)
  return ok()
}

/**
 * Runs `body` in a separate bun process: another server process sharing this
 * run's database and Redis (the env carries the namespace). Answers its stdout.
 */
async function inPeerProcess(body: string, args: string[]): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "session-revoke-peer-"))
  const auth = new URL("./auth.ts", import.meta.url).pathname
  const revocation = new URL("./session-revocation.ts", import.meta.url).pathname
  const redisLib = new URL("../../lib/redis.ts", import.meta.url).pathname
  const file = join(dir, "peer.ts")
  writeFileSync(
    file,
    `const { logout } = await import(${JSON.stringify(auth)})
const R = await import(${JSON.stringify(revocation)})
const { redis } = await import(${JSON.stringify(redisLib)})
const args = process.argv.slice(2)
${body}
process.exit(0)
`,
  )
  try {
    const proc = Bun.spawn(["bun", file, ...args], {
      cwd: new URL("../../..", import.meta.url).pathname,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (code !== 0) throw new Error(`peer process exited ${code}: ${err.slice(-2000)}`)
    return out
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// One lock for the file: taking it truncates the tables.
beforeAll(async () => {
  await acquireTestLock()
  await initSessionRevocation()
  await app.request("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, name: "Session Revoke" }),
  })
}, 120_000)
afterAll(async () => {
  await releaseTestLock()
})

describe("an ended session's access tokens", () => {
  beforeEach(async () => {
    await clearRedisPatterns(["ratelimit:*", "bruteforce:*"])
  })

  it("are refused right after sign-out; another session of the same user is not", async () => {
    const a = await login()
    const b = await login()
    expect(await statusWith(a.accessToken)).toBe(200)
    await logout(a.cookie)
    expect(await statusWith(a.accessToken)).toBe(401)
    expect(await statusWith(b.accessToken)).toBe(200)
  })

  it("are refused after a password change; the session it hands back works", async () => {
    const a = await login()
    const other = await login()
    const res = await app.request("/api/auth/password/change", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: ORIGIN,
        Authorization: `Bearer ${a.accessToken}`,
      },
      body: JSON.stringify({ currentPassword: PASSWORD, newPassword: "newpass456" }),
    })
    const fresh = await pairOf(res)
    try {
      expect(isSessionRevoked(sidOf(a.accessToken))).toBe(true)
      expect(isSessionRevoked(sidOf(other.accessToken))).toBe(true)
      expect(isSessionRevoked(sidOf(fresh.accessToken))).toBe(false)
      expect(await statusWith(a.accessToken)).toBe(401)
      expect(await statusWith(other.accessToken)).toBe(401)
      expect(await statusWith(fresh.accessToken)).toBe(200)
    } finally {
      // Back to the password the other tests sign in with.
      const back = await app.request("/api/auth/password/change", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: ORIGIN,
          Authorization: `Bearer ${fresh.accessToken}`,
        },
        body: JSON.stringify({ currentPassword: "newpass456", newPassword: PASSWORD }),
      })
      expect(back.status).toBe(200)
    }
  })

  it("are refused on this process when another process handled the sign-out", async () => {
    const a = await login()
    const sid = sidOf(a.accessToken)
    expect(await statusWith(a.accessToken)).toBe(200)
    const refreshToken = decodeURIComponent(a.cookie.slice(a.cookie.indexOf("=") + 1))
    // The peer signs out, then waits for its Redis writes (same connection,
    // so the PING answers after the MULTI it queued).
    await inPeerProcess(
      `const ended = await logout(args[0])
if (!ended) throw new Error("peer found no session")
await redis.ping()`,
      [refreshToken],
    )
    expect(await until(() => isSessionRevoked(sid))).toBe(true)
    expect(await statusWith(a.accessToken)).toBe(401)
  })

  it("are known to a process that starts after the sign-out (boot resync)", async () => {
    const a = await login()
    await logout(a.cookie)
    const out = await inPeerProcess(
      `await R.initSessionRevocation()
console.log(JSON.stringify({ revoked: R.isSessionRevoked(args[0]), other: R.isSessionRevoked(crypto.randomUUID()) }))`,
      [sidOf(a.accessToken)],
    )
    const line = out.trim().split("\n").pop() ?? "{}"
    expect(JSON.parse(line)).toEqual({ revoked: true, other: false })
  })

  it("leave a token without a session id alone (service and API tokens)", async () => {
    const a = await login()
    const claims = decodeJwt(a.accessToken) as {
      userId: string
      orgId: string
      authVersion: number
      permissionVersion: number
      scopes?: string[]
    }
    const noSid = await signAccessToken(
      {
        userId: claims.userId,
        orgId: claims.orgId,
        name: "Session Revoke",
        authVersion: claims.authVersion,
        permissionVersion: claims.permissionVersion,
        scopes: claims.scopes ?? [],
      },
      env.JWT_SECRET,
    )
    await logout(a.cookie)
    expect(await statusWith(a.accessToken)).toBe(401)
    expect(await statusWith(noSid)).toBe(200)
  })
})

describe("an ended session's WebSockets", () => {
  let server: Server<WsData>
  let instanceId: string
  const clients: WebSocket[] = []

  beforeAll(async () => {
    instanceId = `session-revoke-test-${crypto.randomUUID()}`
    await redis.set(LIVE_INSTANCE_KEY(instanceId), "{}", "PX", 60_000)
    const manager = new WebSocketManager(redis, undefined, { instanceId })
    server = await createServer(
      { fetch: () => new Response("not found", { status: 404 }) },
      {
        wsManager: manager,
        port: 0,
        publicDir: "/nonexistent-public-dir",
        logPrefix: "ws-session-revoke-test",
        // As index.ts does: the ticket is the only credential.
        onUpgrade: async (req) => {
          const ticket = new URL(req.url).searchParams.get("ticket") ?? ""
          const payload = await consumeWsTicket(redis, ticket)
          if (!payload) return null
          return { ...payload, authorized: true }
        },
      },
    )
  }, 120_000)

  afterAll(async () => {
    for (const ws of clients.splice(0)) ws.close()
    await Bun.sleep(100)
    server?.stop(true)
    await redis.del(LIVE_INSTANCE_KEY(instanceId))
  })

  beforeEach(async () => {
    await clearRedisPatterns(["ratelimit:*", "bruteforce:*"])
  })

  async function ticketFor(accessToken: string): Promise<string> {
    const res = await app.request("/api/auth/ws-ticket", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, Origin: ORIGIN },
    })
    expect(res.status).toBe(200)
    return ((await res.json()) as { data: { ticket: string } }).data.ticket
  }

  function open(ticket: string): { ws: WebSocket; closed: Promise<number> } {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?ticket=${ticket}`)
    clients.push(ws)
    const closed = new Promise<number>((resolve) => {
      ws.onclose = (ev) => resolve(ev.code)
    })
    return { ws, closed }
  }

  it("close with session_invalidated when the session signs out", async () => {
    const a = await login()
    const { ws, closed } = open(await ticketFor(a.accessToken))
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = (e) => reject(e)
    })
    // Still open a moment later: nothing closes a live session's socket.
    await Bun.sleep(200)
    expect(ws.readyState).toBe(WebSocket.OPEN)
    await logout(a.cookie)
    const code = await Promise.race([closed, Bun.sleep(5000).then(() => -1)])
    expect(code).toBe(4010)
  })

  it("open nothing with a ticket minted before the sign-out", async () => {
    const a = await login()
    const ticket = await ticketFor(a.accessToken)
    await logout(a.cookie)
    const { closed } = open(ticket)
    const code = await Promise.race([closed, Bun.sleep(5000).then(() => -1)])
    expect(code).toBe(4001)
  })
})
