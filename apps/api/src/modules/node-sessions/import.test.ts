// SPDX-License-Identifier: FSL-1.1-ALv2
//
// W3 T08 (S41, S42, A44, A46, A47, A56): `importStart`, the one function that
// creates an imported session. One import in flight per node (a Redis lock,
// released whatever happens), one Liaison session per CLI session per owner
// (an import or the owner's own in-place session with that id), the
// transcript's model when the node offers it else the node's default with a
// system line, and reachable only from the owner route and the agent's gated
// import tool.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { getWsManager, setWsManager, WebSocketManager } from "~/infra/websocket"
import { redis } from "~/lib/redis"
import { getOrCreatePersonalAgentId } from "~/modules/agent/directory/personal-agent"
import * as minimal from "~/seed/tiers/minimal"
import {
  answeringImports,
  checkOk,
  connectImportNode,
  enableImportNode,
  type FakeNode,
  type FakeWs,
  IMPORT_HAIKU,
  importRow,
  listAndCheck,
} from "~/tests/helpers/import-node"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { importStart, listImportable } from "./import"

describe("importStart (W3 T08)", () => {
  let owner: minimal.Session
  let manager: WebSocketManager
  let previous: WebSocketManager | null
  const sockets: FakeWs[] = []

  async function online(opts: Parameters<typeof enableImportNode>[1] = {}) {
    const node = await enableImportNode(owner, opts)
    sockets.push(await connectImportNode(manager, node))
    return node
  }

  /** Candidates for `ids` on the node (one listing). */
  async function candidates(node: FakeNode, ids: string[]): Promise<string[]> {
    const nodeSide = answeringImports(node, listAndCheck(ids.map((id) => importRow(id))))
    const listed = await listImportable({
      orgId: owner.orgId,
      userId: owner.userId,
      nodeId: node.nodeId,
    })
    await nodeSide.done()
    if (listed.status !== "done") throw new Error(`listing: ${listed.status}`)
    return listed.rows.map((r) => r.candidateId as string)
  }

  const start = (candidateId: string, mode: "follow" | "take_over" = "follow") =>
    importStart({ orgId: owner.orgId, userId: owner.userId, candidateId, mode })

  async function imports(): Promise<number> {
    const [row] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM kernel.node_sessions
       WHERE org_id = ${owner.orgId} AND source = 'import'`
    return row.n
  }

  async function cleanup() {
    for (const ws of sockets.splice(0)) manager.removeConnection(ws)
    await Bun.sleep(20)
    await sql`DELETE FROM kernel.node_sessions WHERE org_id = ${owner.orgId}`
    await sql`DELETE FROM kernel.node_jobs WHERE org_id = ${owner.orgId}`
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

  it("S42: two concurrent POSTs for the same node → one 409 import_in_flight", async () => {
    const node = await online()
    const [a, b] = await candidates(node, [crypto.randomUUID(), crypto.randomUUID()])
    const nodeSide = answeringImports(
      node,
      listAndCheck([], async () => {
        await Bun.sleep(400)
        return checkOk()
      }),
    )
    const outcomes = await Promise.all([start(a), start(b)])
    await nodeSide.done()
    const codes = outcomes.map((o) => (o.ok ? "ok" : o.code)).sort()
    expect(codes).toEqual(["import_in_flight", "ok"])
    // One node check only: the refused start never reached the node.
    expect(nodeSide.ops.filter((o) => o.kind === "check")).toHaveLength(1)
    expect(await imports()).toBe(1)
  })

  it("S42: the lock is released after a refusal", async () => {
    const node = await online()
    const [a, b] = await candidates(node, [crypto.randomUUID(), crypto.randomUUID()])
    let n = 0
    const nodeSide = answeringImports(
      node,
      listAndCheck([], () => (n++ === 0 ? { ok: false, code: "symlink" } : checkOk())),
    )
    const refused = await start(a)
    const accepted = await start(b)
    await nodeSide.done()
    expect(refused).toEqual({ ok: false, code: "symlink" })
    expect(accepted.ok).toBe(true)
    expect(await redis.exists(`nil:${node.nodeId}`)).toBe(0)
  })

  it("S42: importing the same CLI id twice → 409 already_in_liaison with the first session id", async () => {
    const node = await online()
    const id = crypto.randomUUID()
    const [first] = await candidates(node, [id])
    const [second] = await candidates(node, [id])
    const nodeSide = answeringImports(node, listAndCheck([]))
    const one = await start(first)
    const two = await start(second, "take_over")
    await nodeSide.done()
    expect(one.ok).toBe(true)
    expect(two).toEqual({
      ok: false,
      code: "already_in_liaison",
      sessionId: (one as { sessionId: string }).sessionId,
    })
    expect(await imports()).toBe(1)
  })

  it("A56: importing the id that is the sdk_session_id of the owner's own in-place dispatch session → 409 already_in_liaison with that session, nothing created", async () => {
    const node = await online()
    const id = crypto.randomUUID()
    const agentId = await withPrivilegedDb(owner.orgId, "test", (tx) =>
      getOrCreatePersonalAgentId(tx, { orgId: owner.orgId, userId: owner.userId }),
    )
    const [mine] = await sql<Array<{ id: string }>>`
      INSERT INTO kernel.node_sessions (org_id, owner_user_id, agent_id, source, config_kind, title,
        prompt, model, level, status, sdk_session_id, folder_name)
      VALUES (${owner.orgId}, ${owner.userId}, ${agentId}, 'dispatch', 'owner', 'Mine', 'p',
        ${IMPORT_HAIKU}, 'strict', 'needs_you', ${id}, 'code')
      RETURNING id`
    const [candidate] = await candidates(node, [id])
    const nodeSide = answeringImports(node, listAndCheck([]))
    const outcome = await start(candidate)
    await nodeSide.done()
    expect(outcome).toEqual({ ok: false, code: "already_in_liaison", sessionId: mine.id })
    expect(await imports()).toBe(0)
    const [jobs] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM kernel.node_jobs WHERE org_id = ${owner.orgId}`
    expect(jobs.n).toBe(0)
  })

  it("S41: a model the node does not offer → the node default and an imported system line", async () => {
    const node = await online()
    const [candidate] = await candidates(node, [crypto.randomUUID()])
    const nodeSide = answeringImports(
      node,
      listAndCheck([], () => checkOk("claude-opus-9-9")),
    )
    const outcome = await start(candidate)
    await nodeSide.done()
    expect(outcome.ok).toBe(true)
    const sessionId = (outcome as { sessionId: string }).sessionId
    const [row] = await sql<Array<{ model: string }>>`
      SELECT model FROM kernel.node_sessions WHERE id = ${sessionId}`
    expect(row.model).toBe(IMPORT_HAIKU)
    const events = await sql<Array<{ type: string; payload: Record<string, unknown> }>>`
      SELECT type, payload FROM kernel.node_session_events
       WHERE session_id = ${sessionId} ORDER BY seq`
    expect(events.filter((e) => e.type === "system")).toEqual([
      {
        type: "system",
        payload: {
          subtype: "imported",
          text: `Model claude-opus-9-9 is not offered on this computer; using ${IMPORT_HAIKU}.`,
        },
      },
    ])
  })

  it("S41: a model the node offers as its dated snapshot is kept, with no system line", async () => {
    const node = await online()
    const [candidate] = await candidates(node, [crypto.randomUUID()])
    const nodeSide = answeringImports(
      node,
      listAndCheck([], () => checkOk("claude-haiku-4-5")),
    )
    const outcome = await start(candidate)
    await nodeSide.done()
    const sessionId = (outcome as { sessionId: string }).sessionId
    const [row] = await sql<Array<{ model: string }>>`
      SELECT model FROM kernel.node_sessions WHERE id = ${sessionId}`
    expect(row.model).toBe(IMPORT_HAIKU)
    const [system] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM kernel.node_session_events
       WHERE session_id = ${sessionId} AND type = 'system'`
    expect(system.n).toBe(0)
  })

  it("A46: importStart is imported only by routes-import.ts and nodes/import-tools.ts", () => {
    const srcDir = path.resolve(__dirname, "../..")
    const files: string[] = []
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory() && entry.name !== "node_modules") walk(full)
        else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) files.push(full)
      }
    }
    walk(srcDir)
    expect(files.length).toBeGreaterThan(100)
    const rel = (f: string) => path.relative(srcDir, f).split(path.sep).join("/")
    const naming = files
      .filter((f) => /\bimportStart\b/.test(fs.readFileSync(f, "utf8")))
      .map(rel)
      .filter((f) => f !== "modules/node-sessions/import.ts")
      .sort()
    const allowed = ["modules/node-sessions/routes-import.ts", "modules/nodes/import-tools.ts"]
    expect(naming).toContain("modules/node-sessions/routes-import.ts")
    expect(naming.filter((f) => !allowed.includes(f))).toEqual([])
    // No agent, MCP or app module reaches the module by path either.
    const reaching = files
      .filter((f) => /node-sessions\/import["']/.test(fs.readFileSync(f, "utf8")))
      .map(rel)
      .filter((f) => !allowed.includes(f))
    expect(reaching).toEqual([])
  })
})
