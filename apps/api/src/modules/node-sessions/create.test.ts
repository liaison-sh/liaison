// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P1-T19 (S4, D24, D32, D42, D45, K5, K9, K18): a session started from the app.
// It runs as the owner's personal agent unless another agent of theirs is
// picked, on the node that shares the folder, on a model that node offers
// exactly, at the profile level unless the owner chose another. A raise, and
// any choice of Open, needs the owner's in-app confirmation, attached to this
// very session in the same transaction as its job; lowering asks nothing.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { decodeJwt } from "jose"
import { app } from "~/app"
import { sql } from "~/db"
import { env } from "~/lib/env"
import { signAccessToken } from "~/modules/auth/jwt"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const HAIKU = "claude-haiku-4-5-20251001"

describe("new session from the app (P1-T19)", () => {
  let owner: minimal.Session
  let other: minimal.Session
  let agentId: string

  const call = (path: string, method: string, body?: unknown, nodeCredential?: string) =>
    app.request(path, {
      method,
      headers: {
        Authorization: `Bearer ${owner.bearer}`,
        ...(nodeCredential
          ? { "X-Node-Credential": nodeCredential, "X-Liaison-Node-Protocol": "2" }
          : {}),
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  const json = async (res: Response) => (await res.json()) as any

  async function enable(
    folders: Array<{ name: string; path: string }> = [],
    models: Array<{ id: string; label: string }> = [{ id: HAIKU, label: "Haiku 4.5" }],
  ) {
    const res = await call("/api/nodes", "POST", { deviceId: `d.${crypto.randomUUID()}` })
    expect(res.status).toBe(201)
    const d = (await json(res)).data
    const node = { nodeId: d.node.id as string, credential: d.credential as string }
    const caps = await call(
      `/api/nodes/${node.nodeId}/capabilities`,
      "PUT",
      {
        sharedFolders: folders.map((f) => ({ kind: "root", ...f })),
        models,
      },
      node.credential,
    )
    expect(caps.status).toBe(200)
    return node
  }

  async function profile(level: string) {
    await sql`INSERT INTO kernel.node_profiles (org_id, node_owner_user_id, agent_id, level, liaison_tools)
              VALUES (${owner.orgId}, ${owner.userId}, ${agentId}, ${level}, true)`
  }

  async function mint(nodeId: string, level: string): Promise<string> {
    const res = await call("/api/me/node-level-confirmations", "POST", {
      nodeId,
      agentId,
      level,
      purpose: "session_start",
    })
    expect(res.status).toBe(201)
    return (await json(res)).data.confirmationId as string
  }

  const start = (body: Record<string, unknown>) =>
    call("/api/me/node-sessions", "POST", {
      prompt: "Fix the flaky test",
      model: HAIKU,
      agentId,
      ...body,
    })

  async function counts() {
    const [row] = await sql<Array<{ sessions: number; jobs: number }>>`
      SELECT (SELECT count(*)::int FROM kernel.node_sessions WHERE org_id = ${owner.orgId}) AS sessions,
             (SELECT count(*)::int FROM kernel.node_jobs WHERE org_id = ${owner.orgId}) AS jobs`
    return row
  }

  async function jobOf(sessionId: string) {
    const [row] = await sql<
      Array<{
        thread_id: string | null
        source: string
        target_node_id: string | null
        folder_path: string | null
        level: string
        agent_id: string
      }>
    >`SELECT j.thread_id, j.source, j.target_node_id, s.folder_path, s.level, s.agent_id
        FROM kernel.node_sessions s JOIN kernel.node_jobs j ON j.id = s.job_id
       WHERE s.id = ${sessionId}`
    return row
  }

  beforeAll(async () => {
    await acquireTestLock()
    owner = await minimal.session((await createTestOrg()).id)
    other = await minimal.session(owner.orgId)
    const [agent] = await sql<{ id: string }[]>`
      INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling, owner_user_id)
      VALUES (${owner.orgId}, 'personal', ${`@ns-${crypto.randomUUID().slice(0, 8)}`}, 'Fixer',
              '[]'::jsonb, ${owner.userId})
      RETURNING id`
    agentId = agent.id
  })

  beforeEach(async () => {
    await sql`DELETE FROM kernel.node_level_confirmations WHERE org_id = ${owner.orgId}`
    await sql`DELETE FROM kernel.node_sessions WHERE org_id = ${owner.orgId}`
    await sql`DELETE FROM kernel.node_jobs WHERE org_id = ${owner.orgId}`
    await sql`DELETE FROM kernel.node_profiles WHERE org_id = ${owner.orgId}`
    await sql`DELETE FROM kernel.nodes WHERE org_id = ${owner.orgId}`
  })

  afterAll(async () => {
    if (owner) {
      await sql`DELETE FROM kernel.node_level_confirmations WHERE org_id = ${owner.orgId}`
      await sql`DELETE FROM kernel.node_sessions WHERE org_id = ${owner.orgId}`
      await sql`DELETE FROM kernel.node_jobs WHERE org_id = ${owner.orgId}`
      await sql`DELETE FROM kernel.node_profiles WHERE org_id = ${owner.orgId}`
      await sql`DELETE FROM kernel.nodes WHERE org_id = ${owner.orgId}`
    }
    await releaseTestLock()
  })

  it("S23: a start with an effort stores it on the session; without one it is null; 'ultra' is 400", async () => {
    await enable([{ name: "code", path: "/tmp/code" }])
    const res = await start({ folderName: "code", effort: "high" })
    expect(res.status).toBe(201)
    const row = (await json(res)).data
    expect(row.effort).toBe("high")
    const [stored] = await sql<Array<{ effort: string | null }>>`
      SELECT effort FROM kernel.node_sessions WHERE id = ${row.id}`
    expect(stored.effort).toBe("high")
    const plain = await start({ folderName: "code" })
    expect((await json(plain)).data.effort).toBeNull()
    expect((await start({ folderName: "code", effort: "ultra" })).status).toBe(400)
  })

  it("S30: an app start stores the autonomy and finish-with it was given; absent → guided and null; 'yolo' is 400", async () => {
    await enable([{ name: "code", path: "/tmp/code" }])
    const res = await start({ folderName: "code", autonomy: "autonomous", finishWith: "none" })
    expect(res.status).toBe(201)
    const row = (await json(res)).data
    expect(row).toMatchObject({ autonomy: "autonomous", finishWith: "none" })
    const [stored] = await sql<Array<{ autonomy: string; finish_with: string | null }>>`
      SELECT autonomy, finish_with FROM kernel.node_sessions WHERE id = ${row.id}`
    expect(stored).toEqual({ autonomy: "autonomous", finish_with: "none" })
    const plain = await start({ folderName: "code" })
    expect((await json(plain)).data).toMatchObject({ autonomy: "guided", finishWith: null })
    expect((await start({ folderName: "code", autonomy: "yolo" })).status).toBe(400)
    expect((await start({ folderName: "code", finishWith: "push" })).status).toBe(400)
  })

  it("no confirmation with a level above the profile is 403 confirmation_required", async () => {
    await enable([{ name: "code", path: "/tmp/code" }])
    const res = await start({ folderName: "code", level: "standard" })
    expect(res.status).toBe(403)
    expect((await json(res)).error.code).toBe("confirmation_required")
    expect(await counts()).toEqual({ sessions: 0, jobs: 0 })
  })

  it("with an attached confirmation it is 201, the job has no thread and source app", async () => {
    const n = await enable([{ name: "code", path: "/tmp/code" }])
    const id = await mint(n.nodeId, "standard")
    const res = await start({ folderName: "code", level: "standard", confirmationId: id })
    expect(res.status).toBe(201)
    const row = (await json(res)).data
    expect(row).toMatchObject({
      source: "app",
      configKind: "owner",
      folderName: "code",
      model: HAIKU,
      level: "standard",
      status: "queued",
      title: "Fix the flaky test",
    })
    expect(row.folderPath).toBeUndefined()
    expect(await jobOf(row.id)).toMatchObject({
      thread_id: null,
      source: "app",
      target_node_id: n.nodeId,
      folder_path: "/tmp/code",
      level: "standard",
    })
  })

  it("open from a standard profile needs the confirmation", async () => {
    await profile("standard")
    const n = await enable()
    expect((await start({ level: "open" })).status).toBe(403)
    const ok = await start({ level: "open", confirmationId: await mint(n.nodeId, "open") })
    expect(ok.status).toBe(201)
  })

  it("open from an open profile needs the confirmation", async () => {
    await profile("open")
    const n = await enable()
    const refused = await start({})
    expect(refused.status).toBe(403)
    expect((await json(refused)).error.code).toBe("confirmation_required")
    const ok = await start({ confirmationId: await mint(n.nodeId, "open") })
    expect(ok.status).toBe(201)
    expect((await json(ok)).data.level).toBe("open")
  })

  it("lowering needs none", async () => {
    await profile("standard")
    await enable()
    const res = await start({ level: "strict" })
    expect(res.status).toBe(201)
    expect((await json(res)).data.level).toBe("strict")
    // The profile level when none is chosen.
    const plain = await start({})
    expect(plain.status).toBe(201)
    expect((await json(plain)).data.level).toBe("standard")
  })

  it("the confirmation is attached to this session (attached_session_id) and the job targets the picked node", async () => {
    await enable([{ name: "notes", path: "/tmp/notes" }])
    const b = await enable([{ name: "liaison-monorepo", path: "/Users/me/liaison-monorepo" }])
    const id = await mint(b.nodeId, "standard")
    const res = await start({
      folderName: "liaison-monorepo",
      level: "standard",
      confirmationId: id,
    })
    expect(res.status).toBe(201)
    const sessionId = (await json(res)).data.id as string
    const [conf] = await sql<
      Array<{ attached_session_id: string | null; attached_at: Date | null }>
    >`SELECT attached_session_id, attached_at FROM kernel.node_level_confirmations WHERE id = ${id}`
    expect(conf.attached_session_id).toBe(sessionId)
    expect(conf.attached_at).not.toBeNull()
    expect(await jobOf(sessionId)).toMatchObject({
      target_node_id: b.nodeId,
      folder_path: "/Users/me/liaison-monorepo",
    })
    // The same confirmation cannot start a second session.
    const again = await start({
      folderName: "liaison-monorepo",
      level: "standard",
      confirmationId: id,
    })
    expect(again.status).toBe(403)
  })

  it("a confirmation minted for another node is refused", async () => {
    const a = await enable([{ name: "code", path: "/tmp/code" }])
    const b = await enable([{ name: "notes", path: "/tmp/notes" }])
    expect(a.nodeId).not.toBe(b.nodeId)
    const res = await start({
      folderName: "code",
      level: "standard",
      confirmationId: await mint(b.nodeId, "standard"),
    })
    expect(res.status).toBe(403)
    expect(await counts()).toEqual({ sessions: 0, jobs: 0 })
  })

  it("the 403 names the node the server would run it on, not one that never published capabilities (m6)", async () => {
    // A node enabled without capabilities: the server never picks it.
    const bare = await call("/api/nodes", "POST", { deviceId: `d.${crypto.randomUUID()}` })
    expect(bare.status).toBe(201)
    const b = await enable()
    const res = await start({ level: "standard" })
    expect(res.status).toBe(403)
    const error = (await json(res)).error
    expect(error.code).toBe("confirmation_required")
    expect(error.nodeIds).toEqual([b.nodeId])
    expect(error.nodes).toEqual([{ nodeId: b.nodeId, nodeName: expect.any(String) }])
    expect(error.level).toBe("standard")
    // Confirming exactly that node starts it.
    const ok = await start({
      level: "standard",
      confirmationIds: [await mint(b.nodeId, "standard")],
    })
    expect(ok.status).toBe(201)
  })

  it("a refused confirmation names the right node, and every id sent is tried (m6)", async () => {
    const a = await enable([{ name: "code", path: "/tmp/code" }])
    const b = await enable([{ name: "notes", path: "/tmp/notes" }])
    const wrong = await mint(b.nodeId, "standard")
    const refused = await start({ folderName: "code", level: "standard", confirmationId: wrong })
    expect(refused.status).toBe(403)
    expect((await json(refused)).error.nodeIds).toEqual([a.nodeId])
    const right = await mint(a.nodeId, "standard")
    const ok = await start({
      folderName: "code",
      level: "standard",
      confirmationIds: [wrong, right],
    })
    expect(ok.status).toBe(201)
    const [conf] = await sql<Array<{ attached_at: Date | null }>>`
      SELECT attached_at FROM kernel.node_level_confirmations WHERE id = ${wrong}`
    expect(conf.attached_at).toBeNull()
  })

  it("an unknown folder is 422 with candidates; an unknown model 422 with the offered list", async () => {
    await enable([
      { name: "liaison-monorepo", path: "/tmp/a" },
      { name: "liaison-site", path: "/tmp/b" },
    ])
    const folder = await start({ folderName: "liaison" })
    expect(folder.status).toBe(422)
    expect((await json(folder)).error).toMatchObject({
      code: "folder_unresolved",
      candidates: ["liaison-monorepo", "liaison-site"],
    })
    const model = await start({ folderName: "liaison-site", model: "claude-opus-9" })
    expect(model.status).toBe(422)
    expect((await json(model)).error).toMatchObject({
      code: "model_unavailable",
      offered: [HAIKU],
    })
    expect(await counts()).toEqual({ sessions: 0, jobs: 0 })
  })

  // Review of #63: only the OFFER is narrowed to each family's current model.
  // A session that names an older version the node runs ("Start again", an
  // app session on a model picked before) is created as named; a refusal
  // lists the current models only.
  it("an older version the node runs is accepted as named; a refusal lists current models", async () => {
    await profile("standard")
    await enable(
      [],
      ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", HAIKU, "claude-opus-4-6"].map(
        (id) => ({ id, label: id }),
      ),
    )
    const legacy = await start({ level: "strict", model: "claude-opus-4-6" })
    expect(legacy.status).toBe(201)
    const refused = await start({ level: "strict", model: "claude-opus-9" })
    expect(refused.status).toBe(422)
    expect((await json(refused)).error).toMatchObject({
      code: "model_unavailable",
      offered: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
    })
  })

  it("no node is refused no_node", async () => {
    const res = await start({})
    expect(res.status).toBe(409)
    expect((await json(res)).error.code).toBe("no_node")
  })

  it("a repo is not accepted from the app, and another user's agent is refused", async () => {
    await enable()
    expect((await start({ repo: "https://github.com/acme/app.git" })).status).toBe(400)
    const [theirs] = await sql<{ id: string }[]>`
      INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling, owner_user_id)
      VALUES (${owner.orgId}, 'personal', ${`@th-${crypto.randomUUID().slice(0, 8)}`}, 'Theirs',
              '[]'::jsonb, ${other.userId}) RETURNING id`
    try {
      expect((await start({ agentId: theirs.id })).status).toBe(403)
    } finally {
      await sql`DELETE FROM kernel.agents WHERE id = ${theirs.id}`
    }
  })

  it("the default agent is the personal agent", async () => {
    await enable()
    const res = await call("/api/me/node-sessions", "POST", {
      prompt: "Tidy the notes",
      model: HAIKU,
    })
    expect(res.status).toBe(201)
    const row = (await json(res)).data
    const [agent] = await sql<Array<{ kind: string; owner_user_id: string }>>`
      SELECT kind, owner_user_id FROM kernel.agents WHERE id = ${row.agentId}`
    expect(agent).toEqual({ kind: "personal", owner_user_id: owner.userId })
  })

  // P1a skeptic S1: an app session runs Claude Code on the owner's computer
  // with the agent's Liaison tools, so it is gated like run_on_my_computer
  // (kernel:threads:write) and refused to a restricted device session, whose
  // cap the session would otherwise act past (session-ceiling.ts).
  it("a restricted device session, or a token without kernel:threads:write, cannot start a session", async () => {
    await enable([{ name: "code", path: "/Users/someone/code" }])
    await profile("standard")
    const claims = decodeJwt(owner.bearer) as Record<string, any>
    const token = (over: { scopes: string[]; restricted?: boolean }) =>
      signAccessToken(
        {
          userId: claims.userId,
          orgId: claims.orgId,
          name: claims.name,
          authVersion: claims.authVersion,
          permissionVersion: claims.permissionVersion,
          roles: claims.roles,
          ...over,
        },
        env.JWT_SECRET,
        600,
      )
    const body = { prompt: "Fix the flaky test", model: HAIKU, agentId, folderName: "code" }
    const as = async (bearer: string) =>
      app.request("/api/me/node-sessions", {
        method: "POST",
        headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    for (const bearer of [
      await token({ scopes: [], restricted: true }),
      await token({ scopes: claims.scopes, restricted: true }),
      await token({ scopes: [] }),
    ]) {
      expect((await as(bearer)).status).toBe(403)
    }
    expect(await counts()).toEqual({ sessions: 0, jobs: 0 })
    expect((await as(owner.bearer)).status).toBe(201)
  })
})
