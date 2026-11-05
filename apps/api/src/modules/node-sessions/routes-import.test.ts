// SPDX-License-Identifier: FSL-1.1-ALv2
//
// W3 T08 (S40, S41, S42, A42, A44, A47, A56): the owner's import routes,
// `/api/me/node-session-imports`. The owner lists one of their nodes'
// importable sessions (rows carry an opaque candidate, never the CLI id) and
// starts a Follow or a Take over from a candidate. Owner-only: another member,
// a node credential and a restricted device session are refused; a candidate
// is bound to its owner, single use and short-lived; the node re-checks the
// session before anything is created.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { getWsManager, setWsManager, WebSocketManager } from "~/infra/websocket"
import { redis } from "~/lib/redis"
import { getOrCreatePersonalAgentId } from "~/modules/agent/directory/personal-agent"
import * as minimal from "~/seed/tiers/minimal"
import {
  answeringImports,
  callAs,
  checkOk,
  connectImportNode,
  enableImportNode,
  type FakeNode,
  type FakeWs,
  IMPORT_HAIKU,
  importRow,
  json,
  listAndCheck,
  restrictedBearer,
} from "~/tests/helpers/import-node"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const BASE = "/api/me/node-session-imports"

describe("the owner's import routes (W3 T08)", () => {
  let owner: minimal.Session
  let member: minimal.Session
  let manager: WebSocketManager
  let previous: WebSocketManager | null
  const sockets: FakeWs[] = []

  async function online(who: minimal.Session, opts: Parameters<typeof enableImportNode>[1] = {}) {
    const node = await enableImportNode(who, opts)
    sockets.push(await connectImportNode(manager, node))
    return node
  }

  const importFrames = (node: FakeNode) =>
    (node.ws?.frames ?? []).filter((f) => f.type === "node_import_request").length

  /** Lists `rows` on the node and returns the client rows. */
  async function list(node: FakeNode, rows: unknown[], who = node.who) {
    const nodeSide = answeringImports(node, listAndCheck(rows))
    const res = await callAs(who, `${BASE}?nodeId=${node.nodeId}`, "GET")
    await nodeSide.done()
    expect(res.status).toBe(200)
    return (await json(res)).data as { rows: any[]; truncated: boolean }
  }

  async function counts(who = owner) {
    const [row] = await sql<Array<{ sessions: number; jobs: number }>>`
      SELECT (SELECT count(*)::int FROM kernel.node_sessions
                WHERE org_id = ${who.orgId} AND owner_user_id = ${who.userId}) AS sessions,
             (SELECT count(*)::int FROM kernel.node_jobs
                WHERE org_id = ${who.orgId} AND owner_user_id = ${who.userId}) AS jobs`
    return row
  }

  async function cleanup() {
    for (const ws of sockets.splice(0)) manager.removeConnection(ws)
    await Bun.sleep(20)
    await sql`DELETE FROM kernel.node_sessions WHERE org_id = ${owner.orgId}`
    await sql`DELETE FROM kernel.node_jobs WHERE org_id = ${owner.orgId}`
    await sql`DELETE FROM kernel.node_profiles WHERE org_id = ${owner.orgId}`
    await sql`DELETE FROM kernel.nodes WHERE org_id = ${owner.orgId}`
  }

  beforeAll(async () => {
    await acquireTestLock()
    const org = await createTestOrg()
    owner = await minimal.session(org.id)
    member = await minimal.session(org.id)
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

  it("S40: the owner lists a node's sessions; rows carry a candidate, never the CLI id", async () => {
    const node = await online(owner)
    const id = crypto.randomUUID()
    const nodeSide = answeringImports(node, listAndCheck([importRow(id)]))
    const res = await callAs(owner, `${BASE}?nodeId=${node.nodeId}&query=build`, "GET")
    await nodeSide.done()
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).not.toContain(id)
    const data = JSON.parse(body).data
    expect(nodeSide.ops).toEqual([{ kind: "list", query: "build", detail: true }])
    expect(data.truncated).toBe(false)
    expect(data.rows).toHaveLength(1)
    const { candidateId, ...rest } = data.rows[0]
    expect(candidateId).toMatch(/^[0-9a-f-]{36}$/)
    expect(rest).toEqual({
      folderName: "code",
      cwdSubdir: "app",
      title: "Fix the build",
      firstPrompt: "fix the build please",
      branch: "main",
      lastModified: 1_760_000_000_000,
      createdAt: null,
      sizeBytes: 4096,
      from: "vscode",
      liveNow: false,
      inLiaison: null,
    })
  })

  it("S12-S14: the detail fields pass through; an unshared group's token becomes a folder candidate", async () => {
    const node = await online(owner)
    const token = "c".repeat(32)
    const detail = {
      folders: [
        { name: "code", sessions: 412 },
        { name: "site", sessions: 0 },
      ],
      unshared: [
        {
          name: "tool",
          display: "~/work/tool",
          token,
          sessions: 3,
          lastModified: 1_760_000_000_000,
          refusal: null,
        },
        {
          name: "home folder",
          display: "~",
          token: null,
          sessions: 2,
          lastModified: 1_759_000_000_000,
          refusal: "home",
        },
      ],
      skipped: 4,
      unsharedPartial: true,
    }
    const nodeSide = answeringImports(node, async () => ({
      ok: true,
      data: { rows: [importRow(crypto.randomUUID())], truncated: true, ...detail },
    }))
    const res = await callAs(owner, `${BASE}?nodeId=${node.nodeId}&folder=code`, "GET")
    await nodeSide.done()
    expect(res.status).toBe(200)
    // The strict answer schema took the detail answer.
    expect(nodeSide.puts).toEqual([204])
    expect(nodeSide.ops).toEqual([{ kind: "list", detail: true, folder: "code" }])
    const body = await res.text()
    expect(body).not.toContain(token)
    expect(body).not.toContain('"token"')
    const data = JSON.parse(body).data
    expect(data.truncated).toBe(true)
    expect(data.rows).toHaveLength(1)
    expect(data.folders).toEqual(detail.folders)
    expect(data.skipped).toBe(4)
    expect(data.unsharedPartial).toBe(true)
    const [tool, home] = data.unshared
    expect(tool).toEqual({
      candidateId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      name: "tool",
      display: "~/work/tool",
      sessions: 3,
      lastModified: 1_760_000_000_000,
      refusal: null,
    })
    expect(home).toEqual({ ...detail.unshared[1], token: undefined, candidateId: null })
    // The same store the folder share route reads, bound to this owner and node.
    const stored = JSON.parse((await redis.get(`nfc:${tool.candidateId}`)) as string)
    expect(stored).toMatchObject({
      orgId: owner.orgId,
      ownerUserId: owner.userId,
      nodeId: node.nodeId,
      token,
    })
    const long = await callAs(
      owner,
      `${BASE}?nodeId=${node.nodeId}&folder=${"x".repeat(201)}`,
      "GET",
    )
    expect(long.status).toBe(400)
  })

  it("A1/S16: an older node refuses the detail op; it is asked once more plainly, no new fields", async () => {
    const node = await online(owner)
    const nodeSide = answeringImports(node, async (op) =>
      op.detail || op.folder
        ? { ok: false, code: "failed" }
        : { ok: true, data: { rows: [importRow(crypto.randomUUID())], truncated: false } },
    )
    const res = await callAs(owner, `${BASE}?nodeId=${node.nodeId}&query=build`, "GET")
    await nodeSide.done()
    expect(res.status).toBe(200)
    expect(nodeSide.ops).toEqual([
      { kind: "list", query: "build", detail: true },
      { kind: "list", query: "build" },
    ])
    const data = (await json(res)).data
    expect(Object.keys(data).sort()).toEqual(["rows", "truncated"])
    expect(data.rows).toHaveLength(1)
  })

  it("A1: a node that fails the plain listing too is refused failed after one retry", async () => {
    const node = await online(owner)
    const nodeSide = answeringImports(node, async () => ({ ok: false, code: "failed" }))
    const res = await callAs(owner, `${BASE}?nodeId=${node.nodeId}`, "GET")
    await nodeSide.done()
    expect(res.status).toBe(422)
    expect((await json(res)).error.code).toBe("failed")
    expect(nodeSide.ops).toHaveLength(2)
  })

  it("A56: a listed from-liaison row has no candidateId and is linked to its session", async () => {
    const node = await online(owner)
    const id = crypto.randomUUID()
    const agentId = await withPrivilegedDb(owner.orgId, "test", (tx) =>
      getOrCreatePersonalAgentId(tx, { orgId: owner.orgId, userId: owner.userId }),
    )
    const [s] = await sql<Array<{ id: string }>>`
      INSERT INTO kernel.node_sessions (org_id, owner_user_id, agent_id, source, config_kind, title,
        prompt, model, level, status, sdk_session_id)
      VALUES (${owner.orgId}, ${owner.userId}, ${agentId}, 'dispatch', 'owner', 'Mine', 'p',
        ${IMPORT_HAIKU}, 'strict', 'done', ${id})
      RETURNING id`
    const data = await list(node, [importRow(id, { from: "liaison" })])
    expect(data.rows[0].candidateId).toBeNull()
    expect(data.rows[0].inLiaison).toBe(s.id)
  })

  it("S42: GET by another user of the org for my node → 404 and no frame is sent", async () => {
    const node = await online(owner)
    const res = await callAs(member, `${BASE}?nodeId=${node.nodeId}`, "GET")
    expect(res.status).toBe(404)
    expect(importFrames(node)).toBe(0)
  })

  it("S42: a restricted (device-flow) session and a node credential are refused 403", async () => {
    const node = await online(owner)
    const bearer = await restrictedBearer(owner)
    const listed = await list(node, [importRow(crypto.randomUUID())])
    const framesBefore = importFrames(node)
    const candidateId = listed.rows[0].candidateId
    for (const opts of [{ bearer }, { cred: node.credential }]) {
      const get = await callAs(owner, `${BASE}?nodeId=${node.nodeId}`, "GET", undefined, opts)
      expect(get.status).toBe(403)
      const post = await callAs(owner, BASE, "POST", { candidateId, mode: "follow" }, opts)
      expect(post.status).toBe(403)
    }
    expect(importFrames(node)).toBe(framesBefore)
    expect(await counts()).toEqual({ sessions: 0, jobs: 0 })
  })

  it("S40: a node at protocol 4 → node_outdated, no frame", async () => {
    const node = await online(owner, { importProtocol: 4 })
    const res = await callAs(owner, `${BASE}?nodeId=${node.nodeId}`, "GET")
    expect(res.status).toBe(409)
    expect((await json(res)).error.code).toBe("node_outdated")
    expect(importFrames(node)).toBe(0)
  })

  it("S42: POST with a candidate minted for another user → not_found, nothing created, no node call", async () => {
    const theirs = await online(member)
    const mine = await online(owner)
    const listed = await list(theirs, [importRow(crypto.randomUUID())])
    const framesBefore = importFrames(theirs) + importFrames(mine)
    const res = await callAs(owner, BASE, "POST", {
      candidateId: listed.rows[0].candidateId,
      mode: "follow",
    })
    expect(res.status).toBe(404)
    expect((await json(res)).error.code).toBe("not_found")
    expect(importFrames(theirs) + importFrames(mine)).toBe(framesBefore)
    expect(await counts()).toEqual({ sessions: 0, jobs: 0 })
    expect(await counts(member)).toEqual({ sessions: 0, jobs: 0 })
    // Still theirs: refusing the stranger did not burn it.
    expect(await redis.exists(`nic:${listed.rows[0].candidateId}`)).toBe(1)
  })

  it("S42: a candidate is single use: the second POST → not_found", async () => {
    const node = await online(owner)
    const { rows } = await list(node, [importRow(crypto.randomUUID())])
    const nodeSide = answeringImports(node, listAndCheck([]))
    const first = await callAs(owner, BASE, "POST", {
      candidateId: rows[0].candidateId,
      mode: "follow",
    })
    const second = await callAs(owner, BASE, "POST", {
      candidateId: rows[0].candidateId,
      mode: "take_over",
    })
    await nodeSide.done()
    expect(first.status).toBe(201)
    expect(second.status).toBe(404)
    expect((await json(second)).error.code).toBe("not_found")
    expect(nodeSide.ops.filter((o) => o.kind === "check")).toHaveLength(1)
    expect(await counts()).toEqual({ sessions: 1, jobs: 1 })
  })

  it("S42: a candidate older than 1 h → not_found", async () => {
    const node = await online(owner)
    const { rows } = await list(node, [importRow(crypto.randomUUID())])
    const key = `nic:${rows[0].candidateId}`
    const ttl = await redis.ttl(key)
    expect(ttl).toBeGreaterThan(3_500)
    expect(ttl).toBeLessThanOrEqual(3_600)
    await redis.pexpire(key, 1)
    await Bun.sleep(10)
    const framesBefore = importFrames(node)
    const res = await callAs(owner, BASE, "POST", {
      candidateId: rows[0].candidateId,
      mode: "follow",
    })
    expect(res.status).toBe(404)
    expect(importFrames(node)).toBe(framesBefore)
  })

  it("S41: Follow creates an import row (follow) and one follow job with once false; Take over with once true; both personal agent, finish none, guided, profile level", async () => {
    const node = await online(owner)
    const agentId = await withPrivilegedDb(owner.orgId, "test", (tx) =>
      getOrCreatePersonalAgentId(tx, { orgId: owner.orgId, userId: owner.userId }),
    )
    await sql`INSERT INTO kernel.node_profiles (org_id, node_owner_user_id, agent_id, level, liaison_tools)
              VALUES (${owner.orgId}, ${owner.userId}, ${agentId}, 'standard', true)`
    const followId = crypto.randomUUID()
    const takeId = crypto.randomUUID()
    const { rows } = await list(node, [
      importRow(followId),
      importRow(takeId, { cwdSubdir: "", from: "cli" }),
    ])
    const nodeSide = answeringImports(
      node,
      listAndCheck([], (op) =>
        checkOk(IMPORT_HAIKU, op.sdkSessionId === takeId ? { from: "cli" } : {}),
      ),
    )
    const started: Record<string, string> = {}
    for (const [row, mode] of [
      [rows[0], "follow"],
      [rows[1], "take_over"],
    ] as const) {
      const res = await callAs(owner, BASE, "POST", { candidateId: row.candidateId, mode })
      expect(res.status).toBe(201)
      started[mode] = (await json(res)).data.sessionId
    }
    await nodeSide.done()
    expect(nodeSide.ops).toEqual([
      { kind: "check", sdkSessionId: followId, folderName: "code", cwdSubdir: "app" },
      { kind: "check", sdkSessionId: takeId, folderName: "code", cwdSubdir: "" },
    ])
    const out = await sql<Array<Record<string, any>>>`
      SELECT s.id, s.source, s.import_mode, s.import_sdk_session_id, s.sdk_session_id,
             s.import_from, s.cwd_subdir, s.folder_name, s.folder_path, s.title, s.agent_id,
             s.config_kind, s.finish_with, s.autonomy, s.level, s.model, s.status, s.following,
             j.kind, j.source AS job_source, j.target_node_id, j.thread_id, j.trigger,
             j.permission_mode
        FROM kernel.node_sessions s JOIN kernel.node_jobs j ON j.id = s.job_id
       WHERE s.org_id = ${owner.orgId}`
    expect(out).toHaveLength(2)
    const byMode = Object.fromEntries(out.map((r) => [r.import_mode, r]))
    const common = {
      source: "import",
      folder_name: "code",
      folder_path: "/Users/o/code",
      title: "Fix the build",
      agent_id: agentId,
      config_kind: "owner",
      finish_with: "none",
      autonomy: "guided",
      level: "standard",
      model: IMPORT_HAIKU,
      status: "queued",
      following: false,
      kind: "follow",
      job_source: "import",
      target_node_id: node.nodeId,
      thread_id: null,
      permission_mode: null,
    }
    expect(byMode.follow).toEqual({
      ...common,
      id: started.follow,
      import_mode: "follow",
      import_sdk_session_id: followId,
      sdk_session_id: followId,
      import_from: "vscode",
      cwd_subdir: "app",
      trigger: { follow: { startAt: "window", once: false, inPlace: false } },
    })
    expect(byMode.take_over).toEqual({
      ...common,
      id: started.take_over,
      import_mode: "take_over",
      import_sdk_session_id: takeId,
      sdk_session_id: takeId,
      import_from: "cli",
      cwd_subdir: "",
      trigger: { follow: { startAt: "window", once: true, inPlace: false } },
    })
  })

  it("D53: a row listed in the shared repo's worktree outside the folder shows that worktree, and its Take over checks and stores it", async () => {
    const node = await online(owner)
    const id = crypto.randomUUID()
    const plain = crypto.randomUUID()
    const { rows } = await list(node, [
      importRow(id, { worktreePath: "/tmp/code-wt", cwdSubdir: "pkg" }),
      importRow(plain),
    ])
    const byTitle = rows.map((r) => [r.worktreePath ?? null, r.cwdSubdir])
    expect(byTitle).toEqual([
      ["/tmp/code-wt", "pkg"],
      [null, "app"],
    ])
    const nodeSide = answeringImports(
      node,
      listAndCheck([], () => checkOk()),
    )
    const res = await callAs(owner, BASE, "POST", {
      candidateId: rows[0].candidateId,
      mode: "take_over",
    })
    expect(res.status).toBe(201)
    const sessionId = (await json(res)).data.sessionId
    await nodeSide.done()
    expect(nodeSide.ops).toEqual([
      {
        kind: "check",
        sdkSessionId: id,
        folderName: "code",
        worktreePath: "/tmp/code-wt",
        cwdSubdir: "pkg",
      },
    ])
    const [row] = await sql<Array<{ worktree_path: string | null; cwd_subdir: string }>>`
      SELECT worktree_path, cwd_subdir FROM kernel.node_sessions WHERE id = ${sessionId}`
    expect(row).toEqual({ worktree_path: "/tmp/code-wt", cwd_subdir: "pkg" })
  })

  it("S42: a node check answer {ok:false, code:'outside_shared'} creates nothing and answers that code", async () => {
    const node = await online(owner)
    const { rows } = await list(node, [importRow(crypto.randomUUID())])
    const nodeSide = answeringImports(
      node,
      listAndCheck([], () => ({ ok: false, code: "outside_shared" })),
    )
    const res = await callAs(owner, BASE, "POST", {
      candidateId: rows[0].candidateId,
      mode: "follow",
    })
    await nodeSide.done()
    expect(res.status).toBe(422)
    expect((await json(res)).error.code).toBe("outside_shared")
    expect(await counts()).toEqual({ sessions: 0, jobs: 0 })
  })

  it("A56: a node check answer already_liaison creates nothing", async () => {
    const node = await online(owner)
    const { rows } = await list(node, [importRow(crypto.randomUUID())])
    const nodeSide = answeringImports(
      node,
      listAndCheck([], () => ({ ok: false, code: "already_liaison" })),
    )
    const res = await callAs(owner, BASE, "POST", {
      candidateId: rows[0].candidateId,
      mode: "take_over",
    })
    await nodeSide.done()
    expect(res.status).toBe(422)
    expect((await json(res)).error.code).toBe("already_liaison")
    expect(await counts()).toEqual({ sessions: 0, jobs: 0 })
  })

  it("S42: a bad body and a node not yours are refused before any node call", async () => {
    const node = await online(owner)
    const bad = await callAs(owner, BASE, "POST", { candidateId: "x", mode: "follow" })
    expect(bad.status).toBe(400)
    const mode = await callAs(owner, BASE, "POST", {
      candidateId: crypto.randomUUID(),
      mode: "drive",
    })
    expect(mode.status).toBe(400)
    const noNode = await callAs(owner, `${BASE}?nodeId=${crypto.randomUUID()}`, "GET")
    expect(noNode.status).toBe(404)
    expect(importFrames(node)).toBe(0)
  })
})
