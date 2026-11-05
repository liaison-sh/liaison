// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An org's deletion closes its open sockets through the REAL realtime server
// path (lib/server.ts), and a socket of an org being deleted is served no frame:
// no pong, no presence_sync, and no presence key written after the mark (the
// purge removes the org's Redis keys and must not see them come back).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import type { Server } from "bun"
import { sql } from "~/db"
import { LIVE_INSTANCE_KEY } from "~/infra/instance-registry"
import { getWsManager, setWsManager, WebSocketManager } from "~/infra/websocket"
import { redis } from "~/lib/redis"
import { createServer, type WsData } from "~/lib/server"
import { forgetOrgApps } from "~/modules/apps/org-apps"
import { markOrgDeleting } from "~/modules/org/purge/deleting"
import { type IsolationOrg, newIsolationOrg } from "~/tests/helpers/org-isolation"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

async function until(ok: () => boolean, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms
  while (!ok() && Date.now() < end) await Bun.sleep(25)
  return ok()
}

describe("org deletion and open sockets", () => {
  const sessions = new Map<string, IsolationOrg>()
  const servers: Server<WsData>[] = []
  const clients: WebSocket[] = []
  const instanceId = `org-deleting-test-${crypto.randomUUID()}`
  let manager: WebSocketManager
  let server: Server<WsData>
  let previous: WebSocketManager | null

  // Orgs side by side (createTestOrg would truncate the previous one).
  async function newSession(): Promise<IsolationOrg> {
    const s = await newIsolationOrg()
    sessions.set(s.userId, s)
    return s
  }

  /** An open socket that records what it receives and how it closes. */
  async function connect(s: IsolationOrg) {
    const before = manager.getConnectionCount()
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?as=${s.userId}`)
    clients.push(ws)
    const got: string[] = []
    const state: { closeCode: number | null } = { closeCode: null }
    ws.onmessage = (ev) => got.push((JSON.parse(String(ev.data)) as { type: string }).type)
    ws.onclose = (ev) => {
      state.closeCode = ev.code
    }
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = (e) => reject(e)
    })
    await until(() => manager.getConnectionCount() > before)
    return { ws, got, state }
  }

  async function presenceKeys(orgId: string): Promise<string[]> {
    const out: string[] = []
    let cursor = "0"
    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", `*presence:${orgId}:*`, "COUNT", 1000)
      cursor = next
      out.push(...keys)
    } while (cursor !== "0")
    return out
  }

  async function dropPresence(orgId: string): Promise<void> {
    const { REDIS_PREFIX } = await import("~/lib/redis")
    for (const k of await presenceKeys(orgId)) await redis.del(k.slice(REDIS_PREFIX.length))
  }

  beforeAll(async () => {
    await acquireTestLock()
    previous = getWsManager()
    await redis.set(LIVE_INSTANCE_KEY(instanceId), "{}", "PX", 120_000)
    manager = new WebSocketManager(redis, undefined, { instanceId })
    setWsManager(manager)
    server = await createServer(
      { fetch: () => new Response("not found", { status: 404 }) },
      {
        wsManager: manager,
        port: 0,
        publicDir: "/nonexistent-public-dir",
        logPrefix: "ws-org-deleting-test",
        onUpgrade: async (req) => {
          const s = sessions.get(new URL(req.url).searchParams.get("as") ?? "")
          if (!s) return null
          return {
            userId: s.userId,
            orgId: s.orgId,
            scopes: ["*"],
            dimensionGrants: {},
            authorized: true,
          }
        },
      },
    )
    servers.push(server)
  })

  afterAll(async () => {
    for (const ws of clients.splice(0)) ws.close()
    await Bun.sleep(100)
    for (const s of servers.splice(0)) s.stop(true)
    await redis.del(LIVE_INSTANCE_KEY(instanceId))
    if (previous) setWsManager(previous)
    await releaseTestLock()
  })

  it("marking the org deleting closes its open sockets at once, not another org's", async () => {
    const u = await newSession()
    const other = await newSession()
    const sock = await connect(u)
    const otherSock = await connect(other)

    await markOrgDeleting(u.orgId)

    expect(await until(() => sock.state.closeCode !== null, 3000)).toBe(true)
    expect(sock.state.closeCode).toBe(4010)
    await Bun.sleep(200)
    expect(otherSock.state.closeCode).toBeNull()
  })

  it("a frame on a socket whose org is being deleted is not served and writes no presence", async () => {
    const u = await newSession()
    const sock = await connect(u)
    // The deletion mark lands without this process hearing of it (a lost
    // invalidation), and the purge has already removed the org's Redis keys.
    await sql`UPDATE kernel.organizations SET deleting_at = now() WHERE id = ${u.orgId}::uuid`
    forgetOrgApps(u.orgId)
    await dropPresence(u.orgId)

    sock.ws.send(JSON.stringify({ type: "ping" }))
    sock.ws.send(JSON.stringify({ type: "hello", clientKind: "web", lastActiveAt: Date.now() }))
    expect(await until(() => sock.state.closeCode !== null, 3000)).toBe(true)
    expect(sock.state.closeCode).toBe(4010)
    expect(sock.got).not.toContain("pong")
    expect(sock.got).not.toContain("presence_sync")
    await Bun.sleep(300)
    expect(await presenceKeys(u.orgId)).toEqual([])
  })
})
