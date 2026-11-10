// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A client sends its `hello` the moment its socket opens, while the server's
// `open` handler may still be awaiting (the org checks, the event cursor) and
// has not registered the connection yet. The hello loads the person's thread
// membership onto the connection; landing before the registration, it used to
// be dropped (no connection to write it on), and the registration then gave
// the connection an empty membership: every conversation event (a message, an
// agent's live turn) was withheld from that socket for its whole life, while
// org-wide events still arrived. A slow machine made it routine.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import type { Server } from "bun"
import { LIVE_INSTANCE_KEY } from "~/infra/instance-registry"
import { getWsManager, setWsManager, WebSocketManager } from "~/infra/websocket"
import { redis } from "~/lib/redis"
import { createServer, type WsData } from "~/lib/server"
import { type IsolationOrg, newIsolationOrg, postAs } from "~/tests/helpers/org-isolation"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

async function until(ok: () => boolean, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms
  while (!ok() && Date.now() < end) await Bun.sleep(25)
  return ok()
}

/** A manager whose event cursor answers late: `open` is still awaiting when the hello lands. */
class SlowOpenManager extends WebSocketManager {
  openDelayMs = 0
  override async currentEventSeq(orgId: string): Promise<number> {
    if (this.openDelayMs > 0) await Bun.sleep(this.openDelayMs)
    return super.currentEventSeq(orgId)
  }
}

describe("a hello sent before the server finished opening the socket", () => {
  const sessions = new Map<string, IsolationOrg>()
  const clients: WebSocket[] = []
  const instanceId = `hello-before-open-test-${crypto.randomUUID()}`
  let manager: SlowOpenManager
  let server: Server<WsData>
  let previous: WebSocketManager | null

  beforeAll(async () => {
    await acquireTestLock()
    previous = getWsManager()
    await redis.set(LIVE_INSTANCE_KEY(instanceId), "{}", "PX", 120_000)
    manager = new SlowOpenManager(redis, undefined, { instanceId })
    setWsManager(manager)
    server = await createServer(
      { fetch: () => new Response("not found", { status: 404 }) },
      {
        wsManager: manager,
        port: 0,
        publicDir: "/nonexistent-public-dir",
        logPrefix: "ws-hello-before-open-test",
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
  })

  afterAll(async () => {
    for (const ws of clients.splice(0)) ws.close()
    await Bun.sleep(100)
    server?.stop(true)
    await redis.del(LIVE_INSTANCE_KEY(instanceId))
    if (previous) setWsManager(previous)
    await releaseTestLock()
  })

  it("still loads the person's conversations onto the connection", async () => {
    const s = await newIsolationOrg()
    sessions.set(s.userId, s)
    const res = await postAs(s, "/api/threads", { participantIds: [], title: "hello race" })
    expect(res.status).toBeLessThan(300)
    const body = (await res.json()) as { data: { id: string } }
    const threadId = body.data.id

    manager.openDelayMs = 400
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?as=${s.userId}`)
    clients.push(ws)
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => {
        // As the web client does: the hello goes out on open.
        ws.send(JSON.stringify({ type: "hello", clientKind: "browser", lastActiveAt: Date.now() }))
        resolve()
      }
      ws.onerror = (e) => reject(e)
    })
    expect(await until(() => manager.getConnectionCount() > 0, 3000)).toBe(true)

    // The conversation's events reach this socket: its membership is loaded.
    const loaded = await until(
      () => manager.getThreadMembershipForUser(s.userId)?.has(threadId) === true,
      3000,
    )
    expect(loaded).toBe(true)
  })
})
