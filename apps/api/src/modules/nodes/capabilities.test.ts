// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P1-T12 (C1, D37, D42, L21): the node advertises its shared folders, models
// and per-agent level pins. Paths are stored owner-only (kernel.node_capabilities)
// and never answered; GET /me shows folder names, models and pins. A node that
// published no pins reads as Strict for every agent.
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { sql as q } from "drizzle-orm"
import { app } from "~/app"
import { withRlsContext } from "~/db/rls"
import * as eventBusModule from "~/infra/events/event-bus"
import { loadNodeCandidates } from "~/modules/node-sessions/resolve"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { foldersWithin, loadNodePins, nodePinFor } from "./routes"

describe("node capabilities (P1-T12)", () => {
  let owner: minimal.Session
  let admin: minimal.Session

  beforeAll(async () => {
    await acquireTestLock()
    admin = await minimal.adminSession((await createTestOrg()).id)
    owner = await minimal.session(admin.orgId)
  })
  afterAll(releaseTestLock)

  const call = (
    path: string,
    method: string,
    session: minimal.Session,
    body?: unknown,
    cred?: string,
  ) =>
    app.request(path, {
      method,
      headers: {
        Authorization: `Bearer ${session.bearer}`,
        ...(cred ? { "X-Node-Credential": cred } : {}),
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  const data = async (res: Response) => ((await res.json()) as { data: any }).data

  async function enable(session: minimal.Session) {
    const res = await call("/api/nodes", "POST", session, {
      deviceId: `d.${crypto.randomUUID()}`,
      os: "macos",
    })
    expect(res.status).toBe(201)
    const d = await data(res)
    return { nodeId: d.node.id as string, credential: d.credential as string }
  }

  const agentA = crypto.randomUUID()
  const capabilities = {
    sharedFolders: [
      {
        name: "liaison",
        path: "/Users/someone/code/liaison",
        kind: "repo",
        gitDefaultBranch: "main",
      },
      { name: "notes", path: "/Users/someone/notes", kind: "root" },
      { name: "site", path: "/Users/someone/notes/site", kind: "repo" },
    ],
    models: [{ id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" }],
    levelPins: [{ agentId: agentA, level: "standard" }],
  }

  it("the node PUTs its folders, models and level pins; GET /me shows names and pins, never paths", async () => {
    const n = await enable(owner)
    const put = await call(
      `/api/nodes/${n.nodeId}/capabilities`,
      "PUT",
      owner,
      capabilities,
      n.credential,
    )
    expect(put.status).toBe(200)
    const answered = await data(put)
    expect(answered).toEqual({ folders: ["liaison", "notes", "site"], models: capabilities.models })

    const me = await call("/api/nodes/me", "GET", owner)
    const body = await me.text()
    expect(body).not.toContain("/Users/someone")
    const view = (JSON.parse(body).data.nodes as any[]).find((x) => x.id === n.nodeId)
    expect(view).toMatchObject({
      sharedFolderNames: ["liaison", "notes", "site"],
      // A repo inside a shared folder is named with the folder that holds it.
      sharedFolderWithin: { site: "notes" },
      models: capabilities.models,
      levelPins: capabilities.levelPins,
    })

    // A second PUT replaces the first.
    await call(
      `/api/nodes/${n.nodeId}/capabilities`,
      "PUT",
      owner,
      { sharedFolders: [], models: [] },
      n.credential,
    )
    const again = (await data(await call("/api/nodes/me", "GET", owner))).nodes.find(
      (x: any) => x.id === n.nodeId,
    )
    expect(again).toMatchObject({
      sharedFolderNames: [],
      sharedFolderWithin: {},
      models: [],
      levelPins: [],
    })
  })

  // 2026-10-15: a desktop older than the current-models rule publishes every
  // pinned version its SDK lists, and an agent offered them picked
  // claude-opus-4-6. The Sessions switch (GET /me) and the offered list
  // (loadNodeCandidates) show each family's current model only.
  it("offers only each family's current model, whatever an older desktop published", async () => {
    const n = await enable(owner)
    const published = [
      "claude-opus-5-5",
      "claude-fable-5-1",
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
      "claude-haiku-4-5-20251001",
      "claude-sonnet-5",
      "claude-opus-5",
      "claude-fable-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-sonnet-4-6",
    ].map((id) => ({ id, label: id }))
    const put = await call(
      `/api/nodes/${n.nodeId}/capabilities`,
      "PUT",
      owner,
      { sharedFolders: [], models: published },
      n.credential,
    )
    expect(put.status).toBe(200)
    const current = ["claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5", "claude-haiku-5-5"]
    const view = (await data(await call("/api/nodes/me", "GET", owner))).nodes.find(
      (x: any) => x.id === n.nodeId,
    )
    expect(view.models.map((m: { id: string }) => m.id)).toEqual(current)
    const candidate = (await loadNodeCandidates(owner.orgId, owner.userId)).find(
      (c) => c.nodeId === n.nodeId,
    )
    expect(candidate?.models.map((m) => m.id)).toEqual(current)
    // What a session is resolved against stays the full list (older versions run).
    expect(candidate?.runs.map((m) => m.id)).toEqual(published.map((m) => m.id))
  })

  it("PUT capabilities publishes change capabilities, with no folder or model in the frame (S18)", async () => {
    const n = await enable(owner)
    const spy = spyOn(eventBusModule, "broadcastEphemeral")
    try {
      const put = await call(
        `/api/nodes/${n.nodeId}/capabilities`,
        "PUT",
        owner,
        capabilities,
        n.credential,
      )
      expect(put.status).toBe(200)
      const frames = spy.mock.calls
        .map((c) => c[0])
        .filter((e) => e.app === "kernel" && e.entity === "node")
      expect(frames.map((e) => e.data)).toEqual([
        { ownerUserId: owner.userId, nodeId: n.nodeId, change: "capabilities" },
      ])
    } finally {
      spy.mockRestore()
    }
  })

  it("S25: capabilities keep efforts", async () => {
    const n = await enable(owner)
    const models = [
      {
        id: "claude-opus-5-5",
        label: "Opus 5.5",
        efforts: ["low", "medium", "high", "xhigh", "max"],
      },
      { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
    ]
    const put = await call(
      `/api/nodes/${n.nodeId}/capabilities`,
      "PUT",
      owner,
      { sharedFolders: [], models },
      n.credential,
    )
    expect(put.status).toBe(200)
    expect((await data(put)).models).toEqual(models)
    const view = (await data(await call("/api/nodes/me", "GET", owner))).nodes.find(
      (x: any) => x.id === n.nodeId,
    )
    expect(view.models).toEqual(models)
    const bad = await call(
      `/api/nodes/${n.nodeId}/capabilities`,
      "PUT",
      owner,
      { sharedFolders: [], models: [{ id: "m", label: "M", efforts: ["extreme"] }] },
      n.credential,
    )
    expect(bad.status).toBe(400)
  })

  it("another node's credential is refused 403", async () => {
    const a = await enable(owner)
    const b = await enable(owner)
    const res = await call(
      `/api/nodes/${a.nodeId}/capabilities`,
      "PUT",
      owner,
      capabilities,
      b.credential,
    )
    expect(res.status).toBe(403)
    const none = await call(`/api/nodes/${a.nodeId}/capabilities`, "PUT", owner, capabilities)
    expect(none.status).toBe(401)
  })

  it("a relative path or an unknown level is refused 400", async () => {
    const n = await enable(owner)
    const relative = await call(
      `/api/nodes/${n.nodeId}/capabilities`,
      "PUT",
      owner,
      { ...capabilities, sharedFolders: [{ name: "x", path: "code/x", kind: "root" }] },
      n.credential,
    )
    expect(relative.status).toBe(400)
    const level = await call(
      `/api/nodes/${n.nodeId}/capabilities`,
      "PUT",
      owner,
      { ...capabilities, levelPins: [{ agentId: agentA, level: "Open" }] },
      n.credential,
    )
    expect(level.status).toBe(400)
  })

  it("an admin session reads no capability row", async () => {
    const n = await enable(owner)
    await call(`/api/nodes/${n.nodeId}/capabilities`, "PUT", owner, capabilities, n.credential)
    const as = (userId: string, scopes: string[]) =>
      withRlsContext(
        { actorType: "user", userId, orgId: owner.orgId, scopes, dimensionGrants: {} },
        async (tx) =>
          (await tx.execute(
            q`SELECT node_id FROM kernel.node_capabilities WHERE node_id = ${n.nodeId}`,
          )) as unknown as unknown[],
      )
    expect(await as(admin.userId, ["*"])).toHaveLength(0)
    expect(await as(owner.userId, ["kernel:threads:read"])).toHaveLength(1)
  })

  it("a node that published no pins reads as strict for every agent", async () => {
    const quiet = await enable(owner)
    const pinned = await enable(owner)
    await call(
      `/api/nodes/${pinned.nodeId}/capabilities`,
      "PUT",
      owner,
      capabilities,
      pinned.credential,
    )
    const pins = await loadNodePins(owner.orgId, owner.userId)
    expect(nodePinFor(pins, quiet.nodeId, agentA)).toBe("strict")
    expect(nodePinFor(pins, pinned.nodeId, agentA)).toBe("standard")
    expect(nodePinFor(pins, pinned.nodeId, crypto.randomUUID())).toBe("strict")
  })
})

describe("foldersWithin", () => {
  const f = (name: string, path: string) => ({ name, path, kind: "repo" as const })

  it("names the nearest folder holding a repo, never a sibling sharing a prefix", () => {
    expect(
      foldersWithin([
        f("code", "/u/code"),
        f("app", "/u/code/app"),
        f("ui", "/u/code/app/ui"),
        f("code2", "/u/code2"),
        f("notes", "/u/notes/"),
      ]),
    ).toEqual({ app: "code", ui: "app" })
  })

  it("reads Windows paths", () => {
    expect(foldersWithin([f("code", "C:\\u\\code"), f("app", "C:\\u\\code\\app")])).toEqual({
      app: "code",
    })
  })
})
