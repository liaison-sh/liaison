// SPDX-License-Identifier: FSL-1.1-ALv2
//
// run_on_my_computer on a folder the person's computer does not share: the
// refusal is structured and actionable. The folder is looked up on the online
// node (inside the owner's search roots); the result carries the shared
// folder names, what the lookup found (ids and ~/ paths, never a full path),
// the exact way to share it in the app with a link to the node's Folders
// section, and a clone offer when the folder is not on the computer (none
// when it is). One card is posted so the person can fix it and start again.
// share_folder_on_my_computer shares a found folder only as the owner's own
// approval: owner-routed, refused without it, applied by the node after it.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { getWsManager, setWsManager, WebSocketManager } from "~/infra/websocket"
import { redis } from "~/lib/redis"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { registerKernelAgentTools } from "~/modules/agent/tools/kernel-tools"
import { resolveApprovalResourceOwner } from "~/modules/approvals/resource-owner"
import { toolRegistry } from "~/modules/apps/app-registries"
import { handleToolCall } from "~/modules/mcp/tool-call"
import { listMcpTools } from "~/modules/mcp/tool-projection"
import { mintNodeCredential } from "~/modules/nodes/credentials"
import { onNodeConnectionHello } from "~/modules/nodes/hooks"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  cloneRepoPreflight,
  handleCloneRepo,
  handleShareFolder,
  shareFolderPreflight,
} from "./folder-tools"
import { handleRunOnMyComputer } from "./run-on-my-computer"

const HAIKU = "claude-haiku-4-5-20251001"
const PATH = "/Users/owner/Documents/work/liaison-monorepo"

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

describe("run_on_my_computer on a folder that is not shared", () => {
  let owner: minimal.Session
  let agentId: string
  let threadId: string
  let manager: WebSocketManager
  let previous: WebSocketManager | null
  const sockets: FakeWs[] = []

  const actor = (): UserContext => ({
    actorType: "user",
    userId: owner.userId,
    orgId: owner.orgId,
    scopes: ["*"],
    dimensionGrants: {},
  })

  function frame(): RunContext {
    const runId = crypto.randomUUID()
    const turnScopeAccumulator = createTurnScopeAccumulator()
    turnScopeAccumulator.recordInjected([])
    return {
      runId,
      parentRunId: null,
      rootRunId: runId,
      nestingDepth: 0,
      agentId,
      agentCeiling: ["*"],
      effectiveScope: ["*"],
      turnScopeAccumulator,
    }
  }

  function run(params: Record<string, unknown>) {
    return withRlsContext(actor(), (tx) =>
      runContextStore.run(frame(), () =>
        handleRunOnMyComputer(
          { task: "Fix the flaky test", model: HAIKU, ...params } as Parameters<
            typeof handleRunOnMyComputer
          >[0],
          {
            userId: owner.userId,
            orgId: owner.orgId,
            db: tx,
            agentExecutionThreadId: threadId,
            scopes: ["*"],
            actingAgentId: agentId,
          },
        ),
      ),
    )
  }

  interface Node {
    id: string
    deviceId: string
    credential: string
    ws?: FakeWs
  }

  async function node(name: string, folders: string[]): Promise<Node> {
    const deviceId = `d.${crypto.randomUUID()}`
    const { token: credential, hash } = mintNodeCredential()
    const [n] = await sql<{ id: string }[]>`
      INSERT INTO kernel.nodes (org_id, owner_user_id, device_id, name, last_seen_at, credential_hash)
      VALUES (${owner.orgId}, ${owner.userId}, ${deviceId}, ${name}, now(), ${hash})
      RETURNING id`
    await sql`INSERT INTO kernel.node_capabilities (node_id, org_id, owner_user_id, shared_folders, models)
      VALUES (${n.id}, ${owner.orgId}, ${owner.userId},
              ${JSON.stringify(folders.map((f) => ({ kind: "root", name: f, path: `/Users/owner/${f}` })))}::jsonb,
              ${JSON.stringify([{ id: HAIKU, label: "Haiku 4.5" }])}::jsonb)`
    return { id: n.id, deviceId, credential }
  }

  async function connect(n: Node) {
    const ws = fakeWs()
    sockets.push(ws)
    manager.addConnection(owner.userId, ws, ["*"], owner.orgId)
    const entry = await manager.registerNotifyClient(ws, "desktop_app", Date.now(), {
      deviceId: n.deviceId,
    })
    await onNodeConnectionHello({
      orgId: owner.orgId,
      userId: owner.userId,
      deviceId: n.deviceId,
      connId: entry!.connId,
      nodeCredential: n.credential,
      bindConnection: (id) => manager.markNodeConnection(ws, id),
    })
    n.ws = ws
  }

  /** The node answers its folder requests from Redis directly, as the pull route would. */
  function answering(n: Node, answer: (op: any) => unknown) {
    const seen = new Set<string>()
    const ops: any[] = []
    let stop = false
    const loop = (async () => {
      while (!stop) {
        for (const f of n.ws?.frames ?? []) {
          if (f.type !== "node_folder_request" || seen.has(f.requestId)) continue
          seen.add(f.requestId)
          const key = `nfr:${f.requestId}`
          const row = JSON.parse((await redis.get(key)) as string)
          ops.push(row.op)
          await redis.set(key, JSON.stringify({ ...row, result: answer(row.op) }), "EX", 60)
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

  const lookupAnswer = (searchRoots: number, found: boolean) => ({
    ok: true,
    data: {
      searchRoots,
      candidates: found
        ? [
            {
              name: "liaison-monorepo",
              path: PATH,
              token: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              display: "~/Documents/work/liaison-monorepo",
              isRepo: true,
              shared: false,
              shareable: true,
            },
          ]
        : [],
    },
  })

  const cards = () =>
    sql<Array<{ content: string; metadata: Record<string, any> }>>`
      SELECT content, metadata FROM kernel.messages
       WHERE thread_id = ${threadId} AND author_type = 'agent' ORDER BY created_at`

  async function cleanup() {
    const limits = await redis.keys(`nflr:*:${owner.userId}:*`)
    if (limits.length > 0) await redis.del(...limits)
    for (const ws of sockets.splice(0)) manager.removeConnection(ws)
    await Bun.sleep(20)
    await sql`DELETE FROM kernel.node_sessions WHERE org_id = ${owner.orgId}`
    await sql`DELETE FROM kernel.node_jobs WHERE org_id = ${owner.orgId}`
    await sql`DELETE FROM kernel.messages WHERE thread_id = ${threadId}`
    await sql`DELETE FROM kernel.node_capabilities WHERE org_id = ${owner.orgId}`
    await sql`DELETE FROM kernel.nodes WHERE org_id = ${owner.orgId}`
  }

  beforeAll(async () => {
    await acquireTestLock()
    owner = await minimal.session((await createTestOrg()).id)
    const [agent] = await sql<{ id: string }[]>`
      INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling, owner_user_id)
      VALUES (${owner.orgId}, 'personal', ${`@rf-${crypto.randomUUID().slice(0, 8)}`}, 'Olive',
              '["*"]'::jsonb, ${owner.userId})
      RETURNING id`
    agentId = agent.id
    threadId = await minimal.thread(owner.orgId, owner.userId)
    previous = getWsManager()
    manager = new WebSocketManager(redis)
    setWsManager(manager)
  })

  beforeEach(cleanup)

  afterAll(async () => {
    if (owner) {
      await cleanup()
      await sql`DELETE FROM kernel.agents WHERE id = ${agentId}`
    }
    if (previous) setWsManager(previous)
    await releaseTestLock()
  })

  it("found on the node: the shared names, the found folder by id and ~/ path, the real way to share it, no clone offer, one card", async () => {
    const mac = await node("Mac", ["Reports"])
    await connect(mac)
    const nodeSide = answering(mac, () => lookupAnswer(1, true))
    const res = await run({ folder: "liaison-monorepo" })
    await nodeSide.done()
    expect(nodeSide.ops).toEqual([{ kind: "lookup", query: "liaison-monorepo" }])
    expect(res.status).toBe("refused")
    expect(res.reason).toBe("folder_unresolved")
    expect(res.sharedFolders).toEqual(["Reports"])
    expect(res.lookup?.status).toBe("found")
    expect(res.lookup?.node).toBe("Mac")
    expect(res.lookup?.candidates).toHaveLength(1)
    expect(res.lookup?.candidates[0]).toMatchObject({
      name: "liaison-monorepo",
      display: "~/Documents/work/liaison-monorepo",
      isRepo: true,
    })
    expect(res.lookup?.candidates[0]?.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(JSON.stringify(res)).not.toContain(PATH)
    // The exact path in the app, and a link to that computer's Folders tab.
    expect(res.howToShare?.inApp).toContain('Settings > Computers > Mac > Folders > "Add a folder"')
    expect(res.howToShare?.inApp).toContain('"Find it by name"')
    expect(res.howToShare?.inApp).not.toMatch(/\bnodes?\b/i)
    expect(res.howToShare?.onTheComputer).toContain(
      'Settings > Computers > This computer > Folders > "Add a folder"',
    )
    const link = new URL(res.howToShare?.link as string)
    expect(link.pathname).toBe(`/settings/computers/${mac.id}`)
    expect(link.searchParams.get("folder")).toBe("liaison-monorepo")
    expect(res.cloneOffer).toBeUndefined()
    expect(res.instruction).toContain("share_folder_on_my_computer")
    expect(res.instruction).toContain("Never invent")
    const posted = await cards()
    expect(posted).toHaveLength(1)
    expect(posted[0]?.metadata).toMatchObject({
      kind: "node_dispatch_blocked",
      ownerUserId: owner.userId,
      nodeId: mac.id,
      name: "liaison-monorepo",
      field: "folder",
      task: "Fix the flaky test",
    })
  })

  it("not on the node: a clone offer that asks for the URL", async () => {
    const mac = await node("Mac", ["Reports"])
    await connect(mac)
    const nodeSide = answering(mac, () => lookupAnswer(2, false))
    const res = await run({ folder: "liaison-monorepo" })
    await nodeSide.done()
    expect(res.lookup?.status).toBe("not_found")
    expect(res.cloneOffer).toEqual({
      repo: null,
      how: 'run_on_my_computer with repo: "<the git URL the person gives you>"',
      intoSharedFolders: 'clone_repo_on_my_computer with url: "<the git URL the person gives you>"',
      nodeId: mac.id,
    })
    expect(res.instruction).toContain("kernel__clone_repo_on_my_computer")
    expect(res.instruction).toContain("only after they say yes")
  })

  it("places the computer refused to read: the agent says which, and how to give access", async () => {
    const mac = await node("Mac", ["Reports"])
    await connect(mac)
    const nodeSide = answering(mac, () => {
      const answer = lookupAnswer(1, false)
      return { ...answer, data: { ...answer.data, denied: ["~/Documents"] } }
    })
    const res = await run({ folder: "liaison-monorepo" })
    await nodeSide.done()
    expect(res.lookup?.status).toBe("not_found")
    expect(res.lookup?.denied).toEqual(["~/Documents"])
    expect(res.instruction).toContain("did not let Liaison read ~/Documents")
    expect(res.instruction).toContain("Privacy & Security")
  })

  it("no search roots: the agent proposes the owner's own gesture, with the link", async () => {
    const mac = await node("Mac", ["Reports"])
    await connect(mac)
    const nodeSide = answering(mac, () => lookupAnswer(0, false))
    const res = await run({ repo: "liaison-monorepo" })
    await nodeSide.done()
    expect(res.lookup?.status).toBe("no_search_roots")
    expect(res.instruction).toContain("you cannot add it yourself")
    expect(res.instruction).toContain("howToShare.link")
    expect(res.cloneOffer?.repo).toBeNull()
    expect((await cards())[0]?.metadata.field).toBe("repo")
  })

  it("an offline node is said, with the way to share it and no lookup", async () => {
    await node("Mac", ["Reports"])
    const res = await run({ folder: "liaison-monorepo" })
    expect(res.lookup?.status).toBe("offline")
    expect(res.lookup?.candidates).toEqual([])
    expect(res.howToShare?.link).toContain("/settings/computers/")
  })

  it("a git URL named as a folder is offered as a clone", async () => {
    const { id: macId } = await node("Mac", ["Reports"])
    const url = "git@example.com:acme/liaison-monorepo.git"
    const res = await run({ folder: url })
    expect(res.cloneOffer).toEqual({
      repo: url,
      how: `run_on_my_computer with repo: "${url}"`,
      intoSharedFolders: `clone_repo_on_my_computer with url: "${url}"`,
      nodeId: macId,
    })
  })

  it("a name close to shared folders still asks which one, with no lookup and no card", async () => {
    const mac = await node("Mac", ["liaison-monorepo", "liaison-site"])
    await connect(mac)
    const res = await run({ folder: "liaison" })
    expect(res.candidates).toEqual(["liaison-monorepo", "liaison-site"])
    expect(res.lookup).toBeUndefined()
    expect(res.howToShare).toBeUndefined()
    expect(res.cloneOffer).toBeUndefined()
    expect(mac.ws?.frames.some((f) => f.type === "node_folder_request")).toBe(false)
    expect(await cards()).toHaveLength(0)
  })

  it("share_folder_on_my_computer: owner-routed and gated; refused without the owner's approval, applied by the node after it", async () => {
    await registerKernelAgentTools(owner.orgId)
    const def = toolRegistry.get([owner.orgId, "kernel", "share_folder_on_my_computer"])
    expect(def?.gated).toBe(true)
    expect(
      await resolveApprovalResourceOwner(
        owner.orgId,
        "kernel",
        "share_folder_on_my_computer",
        { candidateId: crypto.randomUUID() },
        owner.userId,
      ),
    ).toBe(owner.userId)

    const mac = await node("Mac", ["Reports"])
    await connect(mac)
    const shared = [PATH]
    const nodeSide = answering(mac, (op) =>
      op.kind === "lookup"
        ? lookupAnswer(1, true)
        : {
            ok: true,
            data: {
              shared: { roots: ["/Users/owner/Reports", ...shared], isDefault: false, missing: [] },
              search: { roots: [], display: [], missing: [] },
            },
          },
    )
    const res = await run({ folder: "liaison-monorepo" })
    const candidateId = res.lookup?.candidates[0]?.id as string
    const ctx = { orgId: owner.orgId, userId: owner.userId }
    // Stage time: a candidate this person's lookup never found is refused.
    expect(await shareFolderPreflight({ candidateId: crypto.randomUUID() }, ctx)).toMatchObject({
      error: { code: "NOT_FOUND" },
    })
    expect(await shareFolderPreflight({ candidateId }, ctx)).toEqual({ ok: true })
    // No approval, an auto-approve (no decider), another decider: refused, nothing asked.
    for (const approverUserId of [undefined, null, crypto.randomUUID()]) {
      const refused = await handleShareFolder({ candidateId }, { ...ctx, approverUserId })
      expect(refused).toMatchObject({ status: "refused", reason: "approval_required" })
    }
    expect(nodeSide.ops.filter((o) => o.kind === "share")).toEqual([])
    // Another person cannot use this person's candidate.
    const other = await minimal.session(owner.orgId)
    expect(
      await handleShareFolder(
        { candidateId },
        { orgId: owner.orgId, userId: other.userId, approverUserId: other.userId },
      ),
    ).toMatchObject({ status: "refused", reason: "candidate_unknown" })
    // The owner's own approval: the node shares that exact path.
    const ok = await handleShareFolder({ candidateId }, { ...ctx, approverUserId: owner.userId })
    await nodeSide.done()
    expect(ok).toMatchObject({ status: "shared", folder: "liaison-monorepo" })
    expect(nodeSide.ops.filter((o) => o.kind === "share")).toEqual([
      { kind: "share", token: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    ])
    expect(JSON.stringify(nodeSide.ops)).not.toContain(PATH)
  })

  it("share_folder_on_my_computer says the node's refusal in words", async () => {
    const mac = await node("Mac", ["Reports"])
    await connect(mac)
    const nodeSide = answering(mac, (op) =>
      op.kind === "lookup" ? lookupAnswer(1, true) : { ok: false, code: "SharedRootHome" },
    )
    const res = await run({ folder: "liaison-monorepo" })
    const candidateId = res.lookup?.candidates[0]?.id as string
    const refused = await handleShareFolder(
      { candidateId },
      { orgId: owner.orgId, userId: owner.userId, approverUserId: owner.userId },
    )
    await nodeSide.done()
    expect(refused).toMatchObject({ status: "refused", reason: "SharedRootHome" })
    expect(refused.instruction).toContain("home folder")
  })

  it("Start again on the card: refused while still not shared, started once it is, once only, by the owner only", async () => {
    const mac = await node("Mac", ["Reports"])
    await connect(mac)
    const nodeSide = answering(mac, () => lookupAnswer(0, false))
    await run({ folder: "liaison-monorepo" })
    await nodeSide.done()
    const [card] = await sql<{ id: string }[]>`
      SELECT id FROM kernel.messages WHERE thread_id = ${threadId}
         AND metadata->>'kind' = 'node_dispatch_blocked'`
    const retry = (who: minimal.Session = owner) =>
      app.request(`/api/nodes/dispatch-blocked/${card.id}/retry`, {
        method: "POST",
        headers: { Authorization: `Bearer ${who.bearer}` },
      })
    const framesBefore = mac.ws?.frames.length ?? 0
    const still = await retry()
    expect(still.status).toBe(409)
    expect(((await still.json()) as any).error.code).toBe("still_not_shared")
    // No new lookup and no second card for a retry.
    expect(mac.ws?.frames.length).toBe(framesBefore)
    expect(await cards()).toHaveLength(1)
    // Another member of the org cannot start it.
    const other = await minimal.session(owner.orgId)
    expect((await retry(other)).status).toBe(404)
    // The owner shares it (the node publishes its folders); Start again starts it.
    await sql`UPDATE kernel.node_capabilities
                 SET shared_folders = shared_folders || ${JSON.stringify([
                   { kind: "repo", name: "liaison-monorepo", path: PATH },
                 ])}::jsonb
               WHERE node_id = ${mac.id}`
    const started = await retry()
    expect(started.status).toBe(201)
    const sessionId = ((await started.json()) as any).data.sessionId
    const [session] = await sql<
      { folder_name: string; prompt: string; source_thread_id: string }[]
    >`
      SELECT folder_name, prompt, source_thread_id FROM kernel.node_sessions WHERE id = ${sessionId}`
    expect(session).toMatchObject({
      folder_name: "liaison-monorepo",
      prompt: "Fix the flaky test",
      source_thread_id: threadId,
    })
    // A second tap gets the session the first one started.
    const again = await retry()
    expect(again.status).toBe(200)
    expect(((await again.json()) as any).data).toEqual({ sessionId, already: true })
  })

  it("Start again tapped twice at once starts one session, and both taps get it", async () => {
    const mac = await node("Mac", ["Reports"])
    await connect(mac)
    const nodeSide = answering(mac, () => lookupAnswer(0, false))
    await run({ folder: "liaison-monorepo" })
    await nodeSide.done()
    const [card] = await sql<{ id: string }[]>`
      SELECT id FROM kernel.messages WHERE thread_id = ${threadId}
         AND metadata->>'kind' = 'node_dispatch_blocked'`
    await sql`UPDATE kernel.node_capabilities
                 SET shared_folders = shared_folders || ${JSON.stringify([
                   { kind: "repo", name: "liaison-monorepo", path: PATH },
                 ])}::jsonb
               WHERE node_id = ${mac.id}`
    const tap = () =>
      app.request(`/api/nodes/dispatch-blocked/${card.id}/retry`, {
        method: "POST",
        headers: { Authorization: `Bearer ${owner.bearer}` },
      })
    const answers = await Promise.all([tap(), tap(), tap()])
    const bodies = await Promise.all(answers.map((r) => r.json() as Promise<any>))
    const ids = new Set(bodies.map((b) => b.data?.sessionId))
    expect(answers.map((r) => r.status).sort()).toEqual([200, 200, 201])
    expect(ids.size).toBe(1)
    const sessions = await sql`SELECT id FROM kernel.node_sessions WHERE org_id = ${owner.orgId}`
    expect(sessions).toHaveLength(1)
  })

  it("clone_repo_on_my_computer: gated and owner-routed; refused without the owner's approval; the node clones then it starts", async () => {
    await registerKernelAgentTools(owner.orgId)
    expect(toolRegistry.get([owner.orgId, "kernel", "clone_repo_on_my_computer"])?.gated).toBe(true)
    expect(
      await resolveApprovalResourceOwner(
        owner.orgId,
        "kernel",
        "clone_repo_on_my_computer",
        { url: "git@github.com:acme/app.git" },
        owner.userId,
      ),
    ).toBe(owner.userId)
    const ctx = { orgId: owner.orgId, userId: owner.userId }
    // Stage time: no computer yet, then a URL no node clones.
    expect(
      await cloneRepoPreflight(
        { url: "git@github.com:acme/app.git", nodeId: crypto.randomUUID() },
        ctx,
      ),
    ).toMatchObject({ error: { code: "NOT_FOUND" } })
    const mac = await node("Mac", ["Reports"])
    await connect(mac)
    for (const url of ["file:///etc", "-uhttps://x/y", "/Users/me/repo", "ext::sh -c x"]) {
      expect(await cloneRepoPreflight({ url, nodeId: mac.id }, ctx)).toMatchObject({
        error: { code: "INVALID_PARAMS" },
      })
    }
    expect(
      await cloneRepoPreflight({ url: "git@github.com:acme/app.git", nodeId: mac.id }, ctx),
    ).toEqual({ ok: true })
    // The computer is bound when the approval is raised: another person's is refused.
    const other = await minimal.session(owner.orgId)
    expect(
      await cloneRepoPreflight(
        { url: "git@github.com:acme/app.git", nodeId: mac.id },
        { orgId: owner.orgId, userId: other.userId },
      ),
    ).toMatchObject({ error: { code: "NOT_FOUND" } })
    const nodeSide = answering(mac, (op) =>
      op.url.includes("private")
        ? { ok: false, code: "CloneAuthFailed" }
        : {
            ok: true,
            data: {
              shared: {
                roots: ["/Users/owner/Liaison Node/repos/liaison-monorepo"],
                isDefault: false,
                missing: [],
              },
              search: { roots: [], display: [], missing: [] },
            },
          },
    )
    const url = "git@github.com:acme/liaison-monorepo.git"
    for (const approverUserId of [undefined, null, crypto.randomUUID()]) {
      expect(
        await handleCloneRepo({ url, nodeId: mac.id }, { ...ctx, approverUserId }),
      ).toMatchObject({
        status: "refused",
        reason: "approval_required",
      })
    }
    expect(nodeSide.ops).toEqual([])
    // Exactly the computer named in the approval: an offline one is said, never another.
    const laptop = await node("Laptop", [])
    const elsewhere = await handleCloneRepo(
      { url, nodeId: laptop.id },
      { ...ctx, approverUserId: owner.userId },
    )
    expect(elsewhere).toMatchObject({ status: "refused", reason: "node_offline", on: "Laptop" })
    expect(nodeSide.ops).toEqual([])
    const cloned = await handleCloneRepo(
      { url, nodeId: mac.id },
      { ...ctx, approverUserId: owner.userId },
    )
    expect(cloned).toMatchObject({ status: "cloned", folder: "liaison-monorepo", on: "Mac" })
    const refused = await handleCloneRepo(
      { url: "git@github.com:acme/private.git", nodeId: mac.id },
      { ...ctx, approverUserId: owner.userId },
    )
    await nodeSide.done()
    expect(refused).toMatchObject({ status: "refused", reason: "CloneAuthFailed" })
    expect(refused.instruction).toContain("git login")
    expect(refused.instruction).toContain("Mac")
    expect(nodeSide.ops).toEqual([
      { kind: "clone", url },
      { kind: "clone", url: "git@github.com:acme/private.git" },
    ])
  })

  it("the clone routes: an owner gesture, followed while it runs, refused for a bad URL", async () => {
    const mac = await node("Mac", ["Reports"])
    await connect(mac)
    const call = (path: string, method: string, body?: unknown, who: minimal.Session = owner) =>
      app.request(path, {
        method,
        headers: { Authorization: `Bearer ${who.bearer}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    for (const url of ["file:///etc", "--upload-pack=x", "http://x/y", "/abs/path"]) {
      expect((await call(`/api/nodes/${mac.id}/folders/clone`, "POST", { url })).status).toBe(400)
    }
    expect(
      (
        await call(`/api/nodes/${mac.id}/folders/clone`, "POST", {
          url: "https://x.example/a/b.git",
          name: "../x",
        })
      ).status,
    ).toBe(400)
    // A node that takes longer than the route waits: 202, then followed to its end.
    const answered = (async () => {
      for (let i = 0; i < 400; i++) {
        const f = mac.ws?.frames.find((x) => x.type === "node_folder_request")
        if (f) return f.requestId as string
        await Bun.sleep(25)
      }
      return ""
    })()
    const started = await call(`/api/nodes/${mac.id}/folders/clone`, "POST", {
      url: "git@github.com:acme/liaison-monorepo.git",
    })
    expect(started.status).toBe(202)
    const body = (await started.json()) as any
    expect(body.data.state).toBe("cloning")
    const requestId = body.data.requestId
    expect(await answered).toBe(requestId)
    const follow = () => call(`/api/nodes/${mac.id}/folders/requests/${requestId}`, "GET")
    expect((await follow()).status).toBe(202)
    const other = await minimal.session(owner.orgId)
    expect(
      (await call(`/api/nodes/${mac.id}/folders/requests/${requestId}`, "GET", undefined, other))
        .status,
    ).toBe(404)
    const key = `nfr:${requestId}`
    const row = JSON.parse((await redis.get(key)) as string)
    expect(row.op).toEqual({ kind: "clone", url: "git@github.com:acme/liaison-monorepo.git" })
    await redis.set(
      key,
      JSON.stringify({ ...row, result: { ok: false, code: "CloneHostUnreachable" } }),
      "EX",
      60,
    )
    const failed = await follow()
    expect(failed.status).toBe(422)
    expect(((await failed.json()) as any).error.code).toBe("CloneHostUnreachable")
  }, 30_000)

  it("folder names reach the card, the agent and the approval without control or bidi characters", async () => {
    const mac = await node("Mac", ["Reports"])
    await connect(mac)
    const nodeSide = answering(mac, () => ({
      ok: true,
      data: {
        searchRoots: 1,
        candidates: [
          {
            name: "app\u202Egpj.exe",
            path: "/Users/owner/Documents/app\u202Egpj.exe",
            token: "b".repeat(32),
            display: "~/Documents/app\u202Egpj.exe\u0007",
            isRepo: false,
            shared: false,
            shareable: true,
          },
        ],
      },
    }))
    const res = await run({ folder: "app\u2066evil\u0000" })
    await nodeSide.done()
    const unsafe = (text: string) =>
      Array.from(text).some((ch) => {
        const c = ch.codePointAt(0) ?? 0
        return c < 0x20 || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)
      })
    expect(unsafe(JSON.stringify(res))).toBe(false)
    expect(JSON.stringify(res)).not.toContain("\\u0007")
    expect(res.lookup?.candidates[0]?.display).toBe("~/Documents/appgpj.exe")
    const [card] = await cards()
    expect(unsafe(card?.content ?? "")).toBe(false)
    expect(card?.metadata.name).toBe("appevil")
  })

  it("agent lookups are rate limited per owner and computer (3 a minute)", async () => {
    const mac = await node("Mac", ["Reports"])
    await connect(mac)
    const nodeSide = answering(mac, () => lookupAnswer(1, false))
    const statuses: string[] = []
    for (let i = 0; i < 4; i++) {
      statuses.push(((await run({ folder: `missing-${i}` })).lookup?.status ?? "") as string)
    }
    await nodeSide.done()
    expect(statuses).toEqual(["not_found", "not_found", "not_found", "rate_limited"])
    expect(nodeSide.ops).toHaveLength(3)
    const limited = await run({ folder: "missing-5" })
    expect(limited.howToShare?.link).toContain("/settings/computers/")
    expect(limited.instruction).toContain("too many")
  })

  it("an owner/name names its last segment, and a name that is no folder name offers a clone", async () => {
    const mac = await node("Mac", ["Reports"])
    await connect(mac)
    const nodeSide = answering(mac, () => lookupAnswer(1, true))
    const res = await run({ repo: "acme/liaison-monorepo" })
    await nodeSide.done()
    expect(nodeSide.ops).toEqual([{ kind: "lookup", query: "liaison-monorepo" }])
    expect(res.lookup?.status).toBe("found")
    const odd = await run({ folder: "acme/../.." })
    expect(odd.lookup?.status).toBe("not_found")
    expect(odd.cloneOffer).toBeDefined()
  })

  it("a session on the computer cannot share, clone or dispatch: its MCP connection does not list or run those tools", async () => {
    await registerKernelAgentTools(owner.orgId)
    await node("Mac", ["Reports"])
    const started = await run({ folder: "Reports" })
    expect(started.status).toBe("started")
    const connectionId = crypto.randomUUID()
    await sql`UPDATE kernel.node_jobs SET mcp_connection_id = ${connectionId}
               WHERE org_id = ${owner.orgId}`
    const blocked = [
      "kernel__share_folder_on_my_computer",
      "kernel__clone_repo_on_my_computer",
      "kernel__run_on_my_computer",
    ]
    const listed = async (conn?: string) =>
      (
        await listMcpTools(
          { orgId: owner.orgId, actor: actor(), agentId, ...(conn ? { connectionId: conn } : {}) },
          undefined,
        )
      ).map((t) => t.name)
    const agentTools = await listed(crypto.randomUUID())
    for (const name of blocked) expect(agentTools).toContain(name)
    const sessionTools = await listed(connectionId)
    for (const name of blocked) expect(sessionTools).not.toContain(name)
    for (const name of blocked) {
      const res = await handleToolCall(
        {
          orgId: owner.orgId,
          actor: actor(),
          connectionId,
          ownerUserId: owner.userId,
          agentId,
          connectionThreadId: null,
          discovered: new Set(),
        },
        name,
        {
          candidateId: crypto.randomUUID(),
          url: "git@github.com:a/b.git",
          nodeId: crypto.randomUUID(),
          task: "x",
        },
      )
      expect(res.isError).toBe(true)
      expect(JSON.stringify(res.content)).toContain("not_from_a_session")
    }
  })
})
