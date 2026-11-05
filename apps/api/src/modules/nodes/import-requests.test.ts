// SPDX-License-Identifier: FSL-1.1-ALv2
//
// W3 T08 (S40, S42, A47): the relay that asks a node for its importable
// Claude Code sessions. The request waits in Redis, only that node's live
// connections are woken, only that node pulls it (once) and answers it, an
// answer that fails the shared schema is `failed` and never reaches anyone,
// and a node that never published import protocol 5 is `node_outdated`
// before any frame is sent.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { getWsManager, setWsManager, WebSocketManager } from "~/infra/websocket"
import { redis } from "~/lib/redis"
import * as minimal from "~/seed/tiers/minimal"
import {
  answeringImports,
  callAs,
  connectImportNode,
  enableImportNode,
  type FakeWs,
  importRow,
  json,
} from "~/tests/helpers/import-node"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { askNodeImport } from "./import-requests"

describe("the session import relay (W3 T08)", () => {
  let owner: minimal.Session
  let manager: WebSocketManager
  let previous: WebSocketManager | null
  const sockets: FakeWs[] = []

  const ask = (nodeId: string, op: any, waitMs = 3_000) =>
    askNodeImport({ orgId: owner.orgId, ownerUserId: owner.userId, nodeId, op, waitMs })

  async function connect(node: Awaited<ReturnType<typeof enableImportNode>>) {
    sockets.push(await connectImportNode(manager, node))
  }

  async function candidateKeys(): Promise<number> {
    const keys = await redis.keys("nic:*")
    let mine = 0
    for (const k of keys) {
      const raw = await redis.get(k)
      if (raw?.includes(owner.userId)) mine++
    }
    return mine
  }

  async function cleanup() {
    for (const ws of sockets.splice(0)) manager.removeConnection(ws)
    await Bun.sleep(20)
    await sql`DELETE FROM kernel.nodes WHERE org_id = ${owner.orgId}`
  }

  beforeAll(async () => {
    await acquireTestLock()
    const org = await createTestOrg()
    owner = await minimal.session(org.id)
    previous = getWsManager()
    manager = new WebSocketManager(redis)
    setWsManager(manager)
  })

  beforeEach(cleanup)

  afterAll(async () => {
    if (owner) await cleanup()
    if (previous) setWsManager(previous)
    await releaseTestLock()
  })

  it("S40: a node at protocol 4 (or none published) → node_outdated, no frame", async () => {
    for (const importProtocol of [4, null]) {
      const node = await enableImportNode(owner, { importProtocol })
      await connect(node)
      const asked = await ask(node.nodeId, { kind: "list" })
      expect(asked.status).toBe("node_outdated")
      expect(node.ws?.frames.some((f) => f.type === "node_import_request")).toBe(false)
    }
  })

  it("S40: an offline node is said at once", async () => {
    const node = await enableImportNode(owner)
    const started = Date.now()
    expect((await ask(node.nodeId, { kind: "list" })).status).toBe("offline")
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it("S40: the node's listing comes back parsed by the shared schema", async () => {
    const node = await enableImportNode(owner)
    await connect(node)
    const id = crypto.randomUUID()
    const nodeSide = answeringImports(node, () => ({
      ok: true,
      data: { rows: [importRow(id)], truncated: true },
    }))
    const asked = await ask(node.nodeId, { kind: "list", query: "build" })
    await nodeSide.done()
    expect(nodeSide.ops).toEqual([{ kind: "list", query: "build" }])
    expect(asked as unknown).toEqual({
      status: "done",
      answer: { rows: [importRow(id)], truncated: true },
    })
  })

  it("S42: a node answer that fails the schema (an absolute cwdSubdir) is failed, never stored", async () => {
    const node = await enableImportNode(owner)
    await connect(node)
    const before = await candidateKeys()
    const nodeSide = answeringImports(node, (op) =>
      op.kind === "list"
        ? {
            ok: true,
            data: {
              rows: [importRow(crypto.randomUUID(), { cwdSubdir: "/etc" })],
              truncated: false,
            },
          }
        : { ok: true, data: { ok: true, title: "x", model: "gpt 4; rm", from: "cli" } },
    )
    const listed = await ask(node.nodeId, { kind: "list" })
    const checked = await ask(node.nodeId, {
      kind: "check",
      sdkSessionId: crypto.randomUUID(),
      folderName: "code",
      cwdSubdir: "",
    })
    await nodeSide.done()
    expect(listed.status).toBe("failed")
    expect(checked.status).toBe("failed")
    // The node is told its answer was refused; nothing was kept for anyone.
    expect(nodeSide.puts).toEqual([422, 422])
    expect(await candidateKeys()).toBe(before)
  })

  it("S42: a node refusal passes as a code; an unknown shape of code is failed", async () => {
    const node = await enableImportNode(owner)
    await connect(node)
    let n = 0
    const nodeSide = answeringImports(node, () =>
      n++ === 0 ? { ok: false, code: "superseded" } : { ok: false, code: "no such thing; rm -rf" },
    )
    const first = await ask(node.nodeId, { kind: "list" })
    const second = await ask(node.nodeId, { kind: "list" })
    await nodeSide.done()
    expect(first).toEqual({ status: "refused", code: "superseded" })
    expect(second).toEqual({ status: "failed" })
  })

  it("S42: another node of the same owner cannot pull or answer; a pull is claimed once", async () => {
    const node = await enableImportNode(owner)
    const second = await enableImportNode(owner)
    await connect(node)
    await connect(second)
    const pending = ask(node.nodeId, { kind: "list" }, 4_000)
    let requestId: string | undefined
    for (let i = 0; i < 100 && !requestId; i++) {
      requestId = node.ws?.frames.find((f) => f.type === "node_import_request")?.requestId
      await Bun.sleep(20)
    }
    expect(typeof requestId).toBe("string")
    // Only the asked node's connection was woken.
    expect(second.ws?.frames.some((f) => f.type === "node_import_request")).toBe(false)
    const path = `/api/node/import-requests/${requestId}`
    const stolen = await callAs(owner, path, "GET", undefined, { cred: second.credential })
    expect(stolen.status).toBe(404)
    const pulled = await callAs(owner, path, "GET", undefined, { cred: node.credential })
    expect(pulled.status).toBe(200)
    const { op, claim } = (await json(pulled)).data
    expect(op).toEqual({ kind: "list" })
    const twice = await callAs(owner, path, "GET", undefined, { cred: node.credential })
    expect(twice.status).toBe(404)
    const forged = await callAs(
      owner,
      path,
      "PUT",
      { claim, ok: true, data: { rows: [], truncated: false } },
      { cred: second.credential },
    )
    expect(forged.status).toBe(404)
    const unclaimed = await callAs(
      owner,
      path,
      "PUT",
      { claim: crypto.randomUUID(), ok: true, data: { rows: [], truncated: false } },
      { cred: node.credential },
    )
    expect(unclaimed.status).toBe(404)
    // Without the node credential the pull is refused.
    const bare = await callAs(owner, path, "GET")
    expect(bare.status).toBeGreaterThanOrEqual(400)
    const put = await callAs(
      owner,
      path,
      "PUT",
      { claim, ok: true, data: { rows: [], truncated: false } },
      { cred: node.credential },
    )
    expect(put.status).toBe(204)
    expect(await pending).toEqual({ status: "done", answer: { rows: [], truncated: false } })
  })
})
