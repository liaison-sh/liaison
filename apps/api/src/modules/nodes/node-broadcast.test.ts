// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P2-T03 (S18, C10, P2-D5): the owner's clients learn every node change live.
// Presence goes out as an ephemeral `kernel:node` frame `{ownerUserId, nodeId,
// change: "presence", online}` (no paths, no capability contents), and the
// presence listeners (P3's pause seam) run after it, their errors logged.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import * as eventBusModule from "~/infra/events/event-bus"
import { getWsManager, setWsManager, WebSocketManager } from "~/infra/websocket"
import { redis } from "~/lib/redis"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { onNodeConnectionHello } from "./hooks"
import { notifyNodePresence, onNodePresence } from "./node-broadcast"
import { closeNodeSession } from "./presence"

interface FakeWs {
  send(data: string): void
  close(): void
  readyState: number
}

const fakeWs = (): FakeWs => ({ send() {}, close() {}, readyState: 1 })

type Frame = { app: string; entity: string; data: Record<string, unknown> }

describe("node change broadcast (P2-T03)", () => {
  let owner: minimal.Session
  let manager: WebSocketManager
  let previous: WebSocketManager | null
  let spy: ReturnType<typeof spyOn>

  const nodeFrames = () =>
    spy.mock.calls
      .map((c: unknown[]) => c[0] as Frame)
      .filter((e: Frame) => e.app === "kernel" && e.entity === "node")

  async function enable(session: minimal.Session) {
    const deviceId = `d.${crypto.randomUUID()}`
    const res = await app.request("/api/nodes", {
      method: "POST",
      headers: { Authorization: `Bearer ${session.bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId, name: "Studio Mac", os: "macos" }),
    })
    expect(res.status).toBe(201)
    const d = ((await res.json()) as { data: any }).data
    return { nodeId: d.node.id as string, credential: d.credential as string, deviceId }
  }

  async function connect(session: minimal.Session, deviceId: string, credential: string) {
    const ws = fakeWs()
    manager.addConnection(session.userId, ws as never, ["*"], session.orgId)
    const entry = (await manager.registerNotifyClient(ws as never, "desktop_app", Date.now(), {
      deviceId,
    }))!
    const opened = await onNodeConnectionHello({
      orgId: session.orgId,
      userId: session.userId,
      deviceId,
      connId: entry.connId,
      nodeCredential: credential,
      bindConnection: (nodeId) => manager.markNodeConnection(ws as never, nodeId),
    })
    return { ws, opened }
  }

  beforeAll(async () => {
    await acquireTestLock()
    const org = await createTestOrg()
    owner = await minimal.session(org.id)
    previous = getWsManager()
    manager = new WebSocketManager(redis)
    setWsManager(manager)
  })

  beforeEach(() => {
    spy = spyOn(eventBusModule, "broadcastEphemeral")
  })

  afterEach(() => {
    spy.mockRestore()
  })

  afterAll(async () => {
    if (owner) await sql`DELETE FROM kernel.nodes WHERE org_id = ${owner.orgId}`
    if (previous) setWsManager(previous)
    await releaseTestLock()
  })

  it("a hello of a live node credential publishes online:true for its owner", async () => {
    const n = await enable(owner)
    spy.mockClear()
    const { ws, opened } = await connect(owner, n.deviceId, n.credential)
    expect(opened?.nodeId).toBe(n.nodeId)
    const frames = nodeFrames()
    expect(frames).toHaveLength(1)
    expect(frames[0].data).toEqual({
      ownerUserId: owner.userId,
      nodeId: n.nodeId,
      change: "presence",
      online: true,
    })
    manager.removeConnection(ws as never)
  })

  it("closing the connection publishes online:false", async () => {
    const n = await enable(owner)
    const { ws, opened } = await connect(owner, n.deviceId, n.credential)
    manager.removeConnection(ws as never)
    spy.mockClear()
    await closeNodeSession(owner.orgId, opened!.sessionId)
    const frames = nodeFrames()
    expect(frames).toHaveLength(1)
    expect(frames[0].data).toEqual({
      ownerUserId: owner.userId,
      nodeId: n.nodeId,
      change: "presence",
      online: false,
    })
  })

  it("a presence listener runs after the broadcast and its error is logged, not thrown", async () => {
    const order: string[] = []
    spy.mockImplementation(async () => {
      order.push("broadcast")
    })
    const offA = onNodePresence(() => {
      order.push("throwing listener")
      throw new Error("listener broke")
    })
    const offB = onNodePresence((c) => {
      order.push(`listener ${c.online}`)
    })
    await expect(
      notifyNodePresence({
        orgId: owner.orgId,
        ownerUserId: owner.userId,
        nodeId: "n1",
        online: false,
      }),
    ).resolves.toBeUndefined()
    offA()
    offB()
    expect(order).toEqual(["broadcast", "throwing listener", "listener false"])
    // Unregistered listeners no longer run.
    order.length = 0
    await notifyNodePresence({
      orgId: owner.orgId,
      ownerUserId: owner.userId,
      nodeId: "n1",
      online: true,
    })
    expect(order).toEqual(["broadcast"])
  })
})
