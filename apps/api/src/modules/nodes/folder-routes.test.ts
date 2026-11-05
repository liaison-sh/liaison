// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A node's folders from any client: the owner asks through the API, the
// node's own connection gets a `node_folder_request` frame, the node pulls
// the request with its credential and answers it; the owner gets the answer.
// Owner-only, fenced to the node: another member, another node of the same
// owner, a node credential on the owner routes, all refused; an offline node
// is said at once; a lookup's folders are shared by id, never by path.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { decodeJwt } from "jose"
import { app } from "~/app"
import { sql } from "~/db"
import { getWsManager, setWsManager, WebSocketManager } from "~/infra/websocket"
import { env } from "~/lib/env"
import { redis } from "~/lib/redis"
import { signAccessToken } from "~/modules/auth/jwt"
import { onNodeConnectionHello } from "~/modules/nodes/hooks"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

interface FakeWs {
  send(data: string): void
  close(): void
  readyState: number
  frames: Array<Record<string, any>>
}

function fakeWs(): FakeWs {
  const ws: FakeWs = {
    frames: [],
    readyState: 1,
    send(data: string) {
      ws.frames.push(JSON.parse(data))
    },
    close() {},
  }
  return ws
}

interface Node {
  nodeId: string
  credential: string
  deviceId: string
  ws?: FakeWs
}

describe("a node's folders from any client", () => {
  let owner: minimal.Session
  let member: minimal.Session
  let manager: WebSocketManager
  let previous: WebSocketManager | null
  const sockets: FakeWs[] = []

  const call = (
    path: string,
    method: string,
    body?: unknown,
    opts: { cred?: string; who?: minimal.Session } = {},
  ) =>
    app.request(path, {
      method,
      headers: {
        Authorization: `Bearer ${(opts.who ?? owner).bearer}`,
        ...(opts.cred ? { "X-Node-Credential": opts.cred } : {}),
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  const json = async (res: Response) => (await res.json()) as any

  async function enable(who = owner): Promise<Node> {
    const deviceId = `d.${crypto.randomUUID()}`
    const res = await call("/api/nodes", "POST", { deviceId }, { who })
    const d = (await json(res)).data
    return { nodeId: d.node.id, credential: d.credential, deviceId }
  }

  async function connect(node: Node) {
    const ws = fakeWs()
    sockets.push(ws)
    manager.addConnection(owner.userId, ws, ["*"], owner.orgId)
    const entry = await manager.registerNotifyClient(ws, "desktop_app", Date.now(), {
      deviceId: node.deviceId,
    })
    await onNodeConnectionHello({
      orgId: owner.orgId,
      userId: owner.userId,
      deviceId: node.deviceId,
      connId: entry!.connId,
      nodeCredential: node.credential,
      bindConnection: (id) => manager.markNodeConnection(ws, id),
    })
    node.ws = ws
  }

  /** The node answers every folder request it is woken for, as the shell would. */
  function answering(node: Node, run: (op: any) => unknown) {
    const seen = new Set<string>()
    const ops: any[] = []
    let stop = false
    const loop = (async () => {
      while (!stop) {
        for (const f of node.ws?.frames ?? []) {
          if (f.type !== "node_folder_request" || seen.has(f.requestId)) continue
          seen.add(f.requestId)
          const pulled = await call(`/api/node/folder-requests/${f.requestId}`, "GET", undefined, {
            cred: node.credential,
          })
          // A request an earlier answerer already answered is not served again.
          if (pulled.status !== 200) continue
          const { op, claim } = (await json(pulled)).data
          ops.push(op)
          const put = await call(
            `/api/node/folder-requests/${f.requestId}`,
            "PUT",
            { claim, ...(run(op) as object) },
            { cred: node.credential },
          )
          expect(put.status).toBe(204)
        }
        await Bun.sleep(20)
      }
    })()
    return {
      ops,
      async done() {
        stop = true
        await loop
      },
    }
  }

  const LIST = {
    shared: {
      roots: ["/Users/o/a", "/Users/o/gone"],
      isDefault: false,
      missing: ["/Users/o/gone"],
    },
    search: { roots: ["/Users/o"], display: ["~"], missing: [] },
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

  it("the owner lists a node's folders through its own connection", async () => {
    const node = await enable()
    await connect(node)
    const nodeSide = answering(node, () => ({ ok: true, data: LIST }))
    const res = await call(`/api/nodes/${node.nodeId}/folders`, "GET")
    await nodeSide.done()
    expect(res.status).toBe(200)
    expect((await json(res)).data).toEqual({
      shared: { ...LIST.shared, refused: [] },
      search: { ...LIST.search, denied: [] },
    })
    expect(nodeSide.ops).toEqual([{ kind: "list" }])
  })

  it("an offline node is said at once; not your node is not found", async () => {
    const node = await enable()
    const started = Date.now()
    const res = await call(`/api/nodes/${node.nodeId}/folders`, "GET")
    expect(res.status).toBe(409)
    expect((await json(res)).error.code).toBe("node_offline")
    expect(Date.now() - started).toBeLessThan(2000)
    await connect(node)
    const other = await call(`/api/nodes/${node.nodeId}/folders`, "GET", undefined, {
      who: member,
    })
    expect(other.status).toBe(404)
    expect(node.ws?.frames.some((f) => f.type === "node_folder_request")).toBe(false)
  })

  it("a node credential is refused on the owner routes; another node cannot pull or answer", async () => {
    const node = await enable()
    const second = await enable()
    await connect(node)
    const refused = await call(`/api/nodes/${node.nodeId}/folders`, "GET", undefined, {
      cred: node.credential,
    })
    expect(refused.status).toBe(403)
    // The second node of the same owner tries the first node's request.
    const pending = call(`/api/nodes/${node.nodeId}/folders/unshare`, "POST", {
      path: "/Users/o/gone",
    })
    let requestId: string | undefined
    for (let i = 0; i < 100 && !requestId; i++) {
      requestId = node.ws?.frames.find((f) => f.type === "node_folder_request")?.requestId
      await Bun.sleep(20)
    }
    expect(requestId).toBeDefined()
    const stolen = await call(`/api/node/folder-requests/${requestId}`, "GET", undefined, {
      cred: second.credential,
    })
    expect(stolen.status).toBe(404)
    const forged = await call(
      `/api/node/folder-requests/${requestId}`,
      "PUT",
      { claim: crypto.randomUUID(), ok: true, data: {} },
      { cred: second.credential },
    )
    expect(forged.status).toBe(404)
    // The right node answers; the owner gets its answer.
    const pulled = await call(`/api/node/folder-requests/${requestId}`, "GET", undefined, {
      cred: node.credential,
    })
    const { op, claim } = (await json(pulled)).data
    expect(op).toEqual({ kind: "unshare", path: "/Users/o/gone" })
    // Claimed by that pull: another connection of the same node gets nothing,
    // and an answer without that claim is refused.
    const twice = await call(`/api/node/folder-requests/${requestId}`, "GET", undefined, {
      cred: node.credential,
    })
    expect(twice.status).toBe(404)
    const unclaimed = await call(
      `/api/node/folder-requests/${requestId}`,
      "PUT",
      { claim: crypto.randomUUID(), ok: true, data: {} },
      { cred: node.credential },
    )
    expect(unclaimed.status).toBe(404)
    await call(
      `/api/node/folder-requests/${requestId}`,
      "PUT",
      { claim, ok: true, data: LIST },
      { cred: node.credential },
    )
    expect((await pending).status).toBe(200)
    // Answered once: a second answer is refused.
    const again = await call(
      `/api/node/folder-requests/${requestId}`,
      "PUT",
      { claim, ok: true, data: {} },
      { cred: node.credential },
    )
    expect(again.status).toBe(404)
  })

  it("a lookup's folders are shared by id, never by path, and only on the node that found them", async () => {
    const node = await enable()
    const second = await enable()
    await connect(node)
    const nodeSide = answering(node, (op) =>
      op.kind === "lookup"
        ? {
            ok: true,
            data: {
              searchRoots: 1,
              skippedProtected: true,
              candidates: [
                {
                  name: "liaison-monorepo",
                  path: "/Users/o/Documents/liaison-monorepo",
                  token: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                  display: "~/Documents/liaison-monorepo",
                  isRepo: true,
                  shared: false,
                  shareable: true,
                },
              ],
            },
          }
        : { ok: true, data: LIST },
    )
    const found = await call(`/api/nodes/${node.nodeId}/folders/lookup`, "POST", {
      query: "liaison-monorepo",
    })
    expect(found.status).toBe(200)
    const data = (await json(found)).data
    expect(data.searchRoots).toBe(1)
    // The implicit home default skipped Documents, Desktop and Downloads: said.
    expect(data.skippedProtected).toBe(true)
    expect(data.candidates).toHaveLength(1)
    const candidate = data.candidates[0]
    expect(candidate.display).toBe("~/Documents/liaison-monorepo")
    expect(candidate.isRepo).toBe(true)
    expect(JSON.stringify(data)).not.toContain("/Users/o")
    // Another node, another member, an unknown id: refused.
    expect(
      (
        await call(`/api/nodes/${second.nodeId}/folders/share`, "POST", {
          candidateId: candidate.id,
        })
      ).status,
    ).toBe(404)
    expect(
      (
        await call(
          `/api/nodes/${node.nodeId}/folders/share`,
          "POST",
          { candidateId: candidate.id },
          { who: member },
        )
      ).status,
    ).toBe(404)
    expect(
      (
        await call(`/api/nodes/${node.nodeId}/folders/share`, "POST", {
          candidateId: crypto.randomUUID(),
        })
      ).status,
    ).toBe(404)
    const shared = await call(`/api/nodes/${node.nodeId}/folders/share`, "POST", {
      candidateId: candidate.id,
    })
    await nodeSide.done()
    expect(shared.status).toBe(200)
    expect(nodeSide.ops).toEqual([
      { kind: "lookup", query: "liaison-monorepo" },
      // The node's own proof, never a path: the node shares only what it found.
      { kind: "share", token: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    ])
  })

  it("the node's refusal comes back as its code; a query that is not a name is refused here", async () => {
    const node = await enable()
    await connect(node)
    const nodeSide = answering(node, () => ({ ok: false, code: "SearchRootAboveHome" }))
    const res = await call(`/api/nodes/${node.nodeId}/folders/search-roots`, "POST", { path: "/" })
    await nodeSide.done()
    expect(res.status).toBe(422)
    expect((await json(res)).error.code).toBe("SearchRootAboveHome")
    const bad = await call(`/api/nodes/${node.nodeId}/folders/lookup`, "POST", { query: "../x" })
    expect(bad.status).toBe(400)
  })

  it("a restricted device session reads the list but changes and searches nothing", async () => {
    const node = await enable()
    await connect(node)
    const claims = decodeJwt(owner.bearer) as Record<string, any>
    const restricted = await signAccessToken(
      {
        userId: claims.userId,
        orgId: claims.orgId,
        name: claims.name,
        authVersion: claims.authVersion,
        permissionVersion: claims.permissionVersion,
        roles: claims.roles,
        scopes: claims.scopes,
        restricted: true,
      },
      env.JWT_SECRET,
      600,
    )
    const who = { ...owner, bearer: restricted }
    const base = `/api/nodes/${node.nodeId}/folders`
    for (const [path, body] of [
      ["/lookup", { query: "app" }],
      ["/unshare", { path: "/Users/o/a" }],
      ["/share", { candidateId: crypto.randomUUID() }],
      ["/search-roots", { path: "~" }],
      ["/search-roots/remove", { path: "/Users/o" }],
      ["/clone", { url: "git@github.com:acme/app.git" }],
      ["/scan", undefined],
      ["/remotes", undefined],
      ["/share-many", { candidateIds: [crypto.randomUUID()] }],
    ] as const) {
      const res = await call(`${base}${path}`, "POST", body, { who })
      expect(res.status).toBe(403)
    }
    expect(node.ws?.frames.some((f) => f.type === "node_folder_request")).toBe(false)
    const nodeSide = answering(node, () => ({ ok: true, data: LIST }))
    const list = await call(base, "GET", undefined, { who })
    await nodeSide.done()
    expect(list.status).toBe(200)
  })
  const TOK = (c: string) => c.repeat(32)
  const SCAN = {
    searchRoots: 2,
    partial: true,
    candidates: [
      {
        name: "app",
        path: "/Users/o/code/app",
        token: TOK("a"),
        display: "~/code/app",
        shared: false,
        shareable: true,
        refusal: null,
      },
      {
        name: "site",
        path: "/Users/o/code/site",
        token: TOK("b"),
        display: "~/code/site",
        shared: false,
        shareable: true,
        refusal: null,
      },
      {
        name: "a",
        path: "/Users/o/a",
        token: null,
        display: "~/a",
        shared: true,
        shareable: false,
        refusal: null,
      },
    ],
  }

  async function scan(node: Node) {
    const nodeSide = answering(node, (op) =>
      op.kind === "scan" ? { ok: true, data: SCAN } : { ok: true, data: LIST },
    )
    const res = await call(`/api/nodes/${node.nodeId}/folders/scan`, "POST")
    await nodeSide.done()
    expect(res.status).toBe(200)
    return { body: await res.text(), ops: nodeSide.ops }
  }

  it("S1: a scan's repositories come back with candidate ids, never a token or a path", async () => {
    const node = await enable()
    await connect(node)
    const { body, ops } = await scan(node)
    expect(ops).toEqual([{ kind: "scan" }])
    for (const leak of ["/Users/o", TOK("a"), TOK("b")]) expect(body).not.toContain(leak)
    const data = JSON.parse(body).data
    expect(data).toMatchObject({
      searchRoots: 2,
      partial: true,
      denied: [],
      skippedProtected: false,
    })
    const [app, site, shared] = data.candidates
    expect(app.candidateId).toMatch(/^[0-9a-f-]{36}$/)
    expect(site.candidateId).toMatch(/^[0-9a-f-]{36}$/)
    expect(shared).toEqual({
      candidateId: null,
      name: "a",
      display: "~/a",
      shared: true,
      shareable: false,
      refusal: null,
    })
    expect(Object.keys(app).sort()).toEqual(
      ["candidateId", "display", "name", "refusal", "shareable", "shared"].sort(),
    )
    // A scan row is shared by id through the existing share route too.
    const nodeSide = answering(node, () => ({ ok: true, data: LIST }))
    const one = await call(`/api/nodes/${node.nodeId}/folders/share`, "POST", {
      candidateId: app.candidateId,
    })
    await nodeSide.done()
    expect(one.status).toBe(200)
    expect(nodeSide.ops).toEqual([{ kind: "share", token: TOK("a") }])
  })

  it("S2: share-many sends the tokens in one request; refusals come back by candidate id", async () => {
    const node = await enable()
    const second = await enable()
    await connect(node)
    const { body } = await scan(node)
    const [app, site] = JSON.parse(body).data.candidates
    // A candidate of another node of the same owner is not this node's.
    await connect(second)
    const theirs = await scan(second)
    const foreign = JSON.parse(theirs.body).data.candidates[0].candidateId
    const stranger = crypto.randomUUID()
    const nodeSide = answering(node, () => ({
      ok: true,
      data: { ...LIST, refused: [{ token: TOK("b"), code: "ShareNotIssued" }] },
    }))
    const res = await call(`/api/nodes/${node.nodeId}/folders/share-many`, "POST", {
      candidateIds: [app.candidateId, site.candidateId, foreign, stranger],
    })
    await nodeSide.done()
    expect(res.status).toBe(200)
    expect(nodeSide.ops).toEqual([{ kind: "shareMany", tokens: [TOK("a"), TOK("b")] }])
    const text = await res.clone().text()
    expect(text).not.toContain(TOK("b"))
    const data = (await json(res)).data
    expect(data.shared.roots).toEqual(LIST.shared.roots)
    expect(data.refused).toEqual([
      { candidateId: foreign, code: "not_found" },
      { candidateId: stranger, code: "not_found" },
      { candidateId: site.candidateId, code: "ShareNotIssued" },
    ])
  })

  it("S2: share-many with only foreign ids asks nothing; another owner's node is not found", async () => {
    const node = await enable()
    await connect(node)
    const { body } = await scan(node)
    const [app] = JSON.parse(body).data.candidates
    const before = node.ws?.frames.length ?? 0
    const foreign = await call(`/api/nodes/${node.nodeId}/folders/share-many`, "POST", {
      candidateIds: [crypto.randomUUID()],
    })
    expect(foreign.status).toBe(404)
    expect((await json(foreign)).error.code).toBe("candidate_unknown")
    const theirs = await call(
      `/api/nodes/${node.nodeId}/folders/share-many`,
      "POST",
      { candidateIds: [app.candidateId] },
      { who: member },
    )
    expect(theirs.status).toBe(404)
    expect((await json(theirs)).error.code).toBe("not_found")
    expect(node.ws?.frames.length ?? 0).toBe(before)
    const tooMany = await call(`/api/nodes/${node.nodeId}/folders/share-many`, "POST", {
      candidateIds: Array.from({ length: 101 }, () => crypto.randomUUID()),
    })
    expect(tooMany.status).toBe(400)
  })

  it("S3/S17: remotes answer local clones by candidate id; no token anywhere", async () => {
    const node = await enable()
    await connect(node)
    const REMOTES = {
      repos: [
        {
          source: "github",
          fullName: "acme/app",
          host: "github.com",
          cloneUrl: "git@github.com:acme/app.git",
          private: true,
          pushedAt: 1_760_000_000_000,
          local: { display: "~/code/app", shared: false, token: TOK("c") },
        },
        {
          source: "github",
          fullName: "acme/site",
          host: "github.com",
          cloneUrl: "https://github.com/acme/site.git",
          private: false,
          pushedAt: null,
          local: { display: "~/code/site", shared: true, token: null },
        },
        {
          source: "gitlab",
          fullName: "group/sub/tool",
          host: "gitlab.com",
          cloneUrl: "https://gitlab.com/group/sub/tool.git",
          private: true,
          pushedAt: null,
          local: null,
        },
      ],
      sources: [
        { tool: "gh", state: "ok" },
        { tool: "glab", state: "signed_out" },
      ],
      dropped: 1,
    }
    const nodeSide = answering(node, (op) =>
      op.kind === "remotes" ? { ok: true, data: REMOTES } : { ok: true, data: LIST },
    )
    const res = await call(`/api/nodes/${node.nodeId}/folders/remotes`, "POST")
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).not.toContain(TOK("c"))
    expect(body).not.toContain('"token"')
    const data = JSON.parse(body).data
    expect(data.sources).toEqual(REMOTES.sources)
    expect(data.dropped).toBe(1)
    const [app, site, tool] = data.repos
    expect(app).toMatchObject({ fullName: "acme/app", cloneUrl: "git@github.com:acme/app.git" })
    expect(app.local.candidateId).toMatch(/^[0-9a-f-]{36}$/)
    expect(site.local).toEqual({ display: "~/code/site", shared: true, candidateId: null })
    expect(tool.local).toBeNull()
    // The local clone shares by its id, with the node's own proof.
    const shared = await call(`/api/nodes/${node.nodeId}/folders/share`, "POST", {
      candidateId: app.local.candidateId,
    })
    await nodeSide.done()
    expect(shared.status).toBe(200)
    expect(nodeSide.ops).toEqual([{ kind: "remotes" }, { kind: "share", token: TOK("c") }])
  })

  it("S16: the new routes: not your node 404, a node credential 403, offline 409, an old node failed", async () => {
    const node = await enable()
    for (const path of ["scan", "remotes"]) {
      const offline = await call(`/api/nodes/${node.nodeId}/folders/${path}`, "POST")
      expect(offline.status).toBe(409)
      expect((await json(offline)).error.code).toBe("node_offline")
    }
    await connect(node)
    for (const path of ["scan", "remotes", "share-many"]) {
      const body = path === "share-many" ? { candidateIds: [crypto.randomUUID()] } : undefined
      const theirs = await call(`/api/nodes/${node.nodeId}/folders/${path}`, "POST", body, {
        who: member,
      })
      expect(theirs.status).toBe(404)
      const cred = await call(`/api/nodes/${node.nodeId}/folders/${path}`, "POST", body, {
        cred: node.credential,
      })
      expect(cred.status).toBe(403)
    }
    expect(node.ws?.frames.some((f) => f.type === "node_folder_request")).toBe(false)
    // A node that does not know the op answers `failed`.
    const nodeSide = answering(node, () => ({ ok: false, code: "failed" }))
    for (const path of ["scan", "remotes"]) {
      const old = await call(`/api/nodes/${node.nodeId}/folders/${path}`, "POST")
      expect(old.status).toBe(422)
      expect((await json(old)).error.code).toBe("failed")
    }
    await nodeSide.done()
  })
})
