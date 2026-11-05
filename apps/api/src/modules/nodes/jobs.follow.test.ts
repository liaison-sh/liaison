// SPDX-License-Identifier: FSL-1.1-ALv2
//
// W3 T09a (S41, S42, D28 b, A44, A45, A53, A54, A58, A62): a follow job's
// server life. It is claimed outside the run plan and the run caps, only by a
// node that speaks the import protocol; its start sets the session running
// and following; its end (a result, a failure, a dead run) leaves the session
// `needs_you` with `follow_ended` (or `imported` after a Take over's replay)
// and no notice; it never resumes and never writes (C1); and every command on
// a following session has one defined answer (M2).
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test"
import type { NodeSessionEventIn } from "@liaison/shared"
import { eq } from "drizzle-orm"
import { app } from "~/app"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { nodeJobs, nodeSessions } from "~/db/schema/kernel"
import * as eventBus from "~/infra/events/event-bus"
import { getWsManager, setWsManager, WebSocketManager } from "~/infra/websocket"
import { redis } from "~/lib/redis"
import { resumeSession } from "~/modules/node-sessions/lifecycle"
import type { NodeSessionRow } from "~/modules/node-sessions/store"
import { onSessionStatus, type SessionStatusChange } from "~/modules/node-sessions/waiting-hook"
import { notifyNodeSessionStatus } from "~/modules/push/node-session-notify"
import type { PushPayload, PushSendResult, PushTokenRow } from "~/modules/push/types"
import * as minimal from "~/seed/tiers/minimal"
import {
  callAs,
  connectImportNode,
  enableImportNode,
  type FakeNode,
  type FakeWs,
  IMPORT_HAIKU,
  json,
} from "~/tests/helpers/import-node"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import * as jobs from "./jobs"
import { createNodeJob, sweepNodeLeases } from "./jobs"

const FOLLOW_ENDED_LINE = "The follow ended before this message was sent; send it again."

describe("follow jobs on the server (W3 T09a)", () => {
  let owner: minimal.Session
  let agentId: string
  let manager: WebSocketManager
  let previous: WebSocketManager | null
  const sockets: FakeWs[] = []
  const changes: Array<{ id: string; change: SessionStatusChange }> = []
  let off: (() => void) | null = null

  /** A node call with its credential and protocol header. */
  async function fetchAs(node: FakeNode, path: string, body: unknown, protocol: number) {
    return app.request(path, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${owner.bearer}`,
        "X-Node-Credential": node.credential,
        "X-Liaison-Node-Protocol": String(protocol),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    })
  }
  const nodeCall = (node: FakeNode, path: string, body: unknown, protocol = 5) =>
    fetchAs(node, path, body, protocol)

  const command = (sessionId: string, type: string, payload: Record<string, unknown> = {}) =>
    callAs(owner, `/api/me/node-sessions/${sessionId}/commands`, "POST", { type, payload })

  async function online(opts: Parameters<typeof enableImportNode>[1] = {}) {
    const node = await enableImportNode(owner, opts)
    sockets.push(await connectImportNode(manager, node))
    return node
  }

  /** An imported session and its follow job, as importStart makes them. */
  async function importFollow(
    node: FakeNode,
    mode: "follow" | "take_over" = "follow",
    worktreePath?: string,
  ) {
    const job = await createNodeJob({
      orgId: owner.orgId,
      ownerUserId: owner.userId,
      agentId,
      threadId: null,
      source: "import",
      kind: "follow",
      prompt: "Fix the build",
      sourceRequiredScopes: [],
      targetNodeId: node.nodeId,
      trigger: { follow: { startAt: "window", once: mode === "take_over", inPlace: false } },
      session: {
        source: "import",
        configKind: "owner",
        title: "Fix the build",
        folderName: "code",
        folderPath: "/Users/o/code",
        model: IMPORT_HAIKU,
        level: "strict",
        autonomy: "guided",
        finishWith: "none",
        import: {
          mode,
          sdkSessionId: crypto.randomUUID(),
          from: "vscode",
          cwdSubdir: "app",
          ...(worktreePath !== undefined ? { worktreePath } : {}),
        },
      },
    })
    return { jobId: job.id, sessionId: job.sessionId as string }
  }

  async function claim(node: FakeNode, jobId: string, protocol = 5, body: unknown = {}) {
    return nodeCall(node, `/api/nodes/jobs/${jobId}/claim`, body, protocol)
  }

  /** Claim and start a follow (or run) job; returns its lease generation. */
  async function start(node: FakeNode, jobId: string, protocol = 5): Promise<number> {
    const claimed = await claim(node, jobId, protocol)
    expect(claimed.status).toBe(200)
    const gen = (await json(claimed)).data.leaseGeneration as number
    const started = await nodeCall(
      node,
      `/api/nodes/jobs/${jobId}/started`,
      { leaseGeneration: gen },
      protocol,
    )
    expect(started.status).toBe(200)
    return gen
  }

  const followResult = (
    node: FakeNode,
    jobId: string,
    gen: number,
    follow: Record<string, unknown>,
  ) => nodeCall(node, `/api/nodes/jobs/${jobId}/result`, { leaseGeneration: gen, follow })

  /** An in-place app session (owner config, the shared folder) the node ran. */
  async function inPlaceRun(node: FakeNode, protocol = 5) {
    const job = await createNodeJob({
      orgId: owner.orgId,
      ownerUserId: owner.userId,
      agentId,
      threadId: null,
      source: "app",
      prompt: "Tidy the README",
      sourceRequiredScopes: [],
      targetNodeId: node.nodeId,
      session: {
        source: "app",
        configKind: "owner",
        folderName: "code",
        folderPath: "/Users/o/code",
        model: IMPORT_HAIKU,
        level: "strict",
      },
    })
    const sessionId = job.sessionId as string
    const gen = await start(node, job.id, protocol)
    const sdk = crypto.randomUUID()
    const res = await nodeCall(
      node,
      `/api/node/sessions/${sessionId}/events`,
      {
        jobId: job.id,
        leaseGeneration: gen,
        batchNo: 1,
        events: [
          {
            at: new Date().toISOString(),
            type: "system",
            payload: { subtype: "start", text: "started", data: { sessionId: sdk } },
          } satisfies NodeSessionEventIn,
        ],
      },
      protocol,
    )
    expect(res.status).toBe(200)
    return { sessionId, jobId: job.id, gen, sdk }
  }

  /** The run ends refused because VS Code drives the session (S51). */
  const drivenElsewhere = (node: FakeNode, run: { jobId: string; gen: number }, protocol = 5) =>
    nodeCall(
      node,
      `/api/nodes/jobs/${run.jobId}/result`,
      {
        leaseGeneration: run.gen,
        text: "",
        completion: { by: "needs_you", reasonCode: "driven_elsewhere_vscode" },
      },
      protocol,
    )

  const sessionRow = async (id: string) =>
    (
      await sql<
        Array<{
          status: string
          job_id: string
          following: boolean
          reason_code: string | null
          import_replay_offset: string | null
          node_id: string | null
        }>
      >`SELECT status, job_id, following, reason_code, import_replay_offset::text, node_id
          FROM kernel.node_sessions WHERE id = ${id}`
    )[0]
  const jobRow = async (id: string) =>
    (
      await sql<
        Array<{
          status: string
          kind: string
          lease_expires_at: Date | null
          mcp_connection_id: string | null
          resume_after: string | null
          resume_command_id: string | null
          trigger: Record<string, any> | null
        }>
      >`SELECT status, kind, lease_expires_at, mcp_connection_id, resume_after, resume_command_id,
               trigger FROM kernel.node_jobs WHERE id = ${id}`
    )[0]
  const jobsOf = () =>
    sql<Array<{ id: string; kind: string; status: string; resume_command_id: string | null }>>`
      SELECT id, kind, status, resume_command_id FROM kernel.node_jobs
       WHERE org_id = ${owner.orgId} ORDER BY created_at`
  const commandsOf = (sessionId: string) =>
    sql<
      Array<{
        id: string
        type: string
        outcome: string | null
        acked_at: Date | null
        result: Record<string, any> | null
      }>
    >`SELECT id, type, outcome, acked_at, result FROM kernel.node_session_commands
       WHERE session_id = ${sessionId} ORDER BY seq`
  const report = (node: FakeNode, sessions: unknown[]) =>
    nodeCall(node, "/api/node/sessions/report", { sessions })
  const changesOf = (sessionId: string) =>
    changes.filter((c) => c.id === sessionId).map((c) => c.change)
  const rowOf = async (id: string): Promise<NodeSessionRow> => {
    const [row] = await withPrivilegedDb(owner.orgId, "test-follow-row", (tx) =>
      tx.select().from(nodeSessions).where(eq(nodeSessions.id, id)),
    )
    return row as NodeSessionRow
  }

  async function cleanup() {
    for (const ws of sockets.splice(0)) manager.removeConnection(ws)
    await Bun.sleep(20)
    changes.length = 0
    await sql`DELETE FROM kernel.attention_events WHERE org_id = ${owner.orgId}`
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
    const [agent] = await sql<{ id: string }[]>`
      INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling, owner_user_id)
      VALUES (${owner.orgId}, 'personal', ${`@fl-${crypto.randomUUID().slice(0, 8)}`}, 'Olive',
              '["*"]'::jsonb, ${owner.userId})
      RETURNING id`
    agentId = agent.id
    off = onSessionStatus((row, change) => {
      changes.push({ id: row.id, change })
    })
  })

  beforeEach(cleanup)

  afterAll(async () => {
    off?.()
    if (owner) {
      await cleanup()
      await sql`DELETE FROM kernel.agents WHERE id = ${agentId}`
    }
    if (previous) setWsManager(previous)
    await releaseTestLock()
  })

  describe("start, end and the claim answer (A45, A44)", () => {
    it("A45: a follow claim answers kind follow, the session and its follow parameters; nothing of a run plan", async () => {
      const node = await online()
      const f = await importFollow(node)
      const res = await claim(node, f.jobId)
      expect(res.status).toBe(200)
      const data = (await json(res)).data
      const [sdk] = await sql<Array<{ s: string }>>`
        SELECT import_sdk_session_id AS s FROM kernel.node_sessions WHERE id = ${f.sessionId}`
      expect(data.kind).toBe("follow")
      expect(data.job.kind).toBe("follow")
      expect(data.follow).toEqual({
        sdkSessionId: sdk.s,
        folderName: "code",
        cwdSubdir: "app",
        startAt: "window",
        once: false,
        inPlace: false,
      })
      expect(data.session).toMatchObject({
        id: f.sessionId,
        folderName: "code",
        configKind: "owner",
      })
      expect(data.profile).toBeUndefined()
      // Claimed, not started: the session waits for /started.
      expect((await sessionRow(f.sessionId)).status).toBe("queued")
      expect((await sessionRow(f.sessionId)).node_id).toBe(node.nodeId)
    })

    it("A45: a follow job's start sets running and following; its result {why:'driver_left'} ends needs_you follow_ended with no notice on any channel and the earlier rows marked read", async () => {
      const node = await online()
      const f = await importFollow(node)
      const gen = await start(node, f.jobId)
      expect(await sessionRow(f.sessionId)).toMatchObject({ status: "running", following: true })
      const startChange = changesOf(f.sessionId).at(-1)
      expect(startChange).toMatchObject({ from: "queued", to: "running", cause: "node" })

      // An earlier notice of this session, unread.
      const pushes: Array<{ token: PushTokenRow; payload: PushPayload }> = []
      const deps = {
        send: async (token: PushTokenRow, payload: PushPayload): Promise<PushSendResult> => {
          pushes.push({ token, payload })
          return { kind: "sent" }
        },
        badgeCount: async () => 1,
        jobScopes: async () => [] as string[],
      }
      const before = await rowOf(f.sessionId)
      await notifyNodeSessionStatus(
        { ...before, status: "failed", endedAt: new Date() } as NodeSessionRow,
        { from: "running", to: "failed", cause: "node" },
        deps,
      )
      const pushedBefore = pushes.length

      const res = await followResult(node, f.jobId, gen, { why: "driver_left" })
      expect(res.status).toBe(201)
      expect(await sessionRow(f.sessionId)).toMatchObject({
        status: "needs_you",
        following: false,
        reason_code: "follow_ended",
      })
      expect((await jobRow(f.jobId)).status).toBe("done")
      const end = changesOf(f.sessionId).at(-1) as SessionStatusChange
      expect(end).toMatchObject({ from: "running", to: "needs_you", cause: "follow" })

      await notifyNodeSessionStatus(await rowOf(f.sessionId), end, deps)
      const rows = await sql<Array<{ kind: string; read_at: Date | null }>>`
        SELECT kind, read_at FROM kernel.attention_events
         WHERE org_id = ${owner.orgId} AND entity_type = 'node_session' AND entity_id = ${f.sessionId}
         ORDER BY created_at`
      expect(rows.map((r) => [r.kind, r.read_at !== null])).toEqual([["node_session_failed", true]])
      expect(pushes.length).toBe(pushedBefore)
      expect((await jobsOf()).filter((j) => j.id !== f.jobId)).toHaveLength(0)
    })

    it("A44: a once follow ending replayed with endOffset 1234 leaves needs_you imported and import_replay_offset 1234", async () => {
      const node = await online()
      const f = await importFollow(node, "take_over")
      const gen = await start(node, f.jobId)
      const res = await followResult(node, f.jobId, gen, { why: "replayed", endOffset: 1234 })
      expect(res.status).toBe(201)
      expect(await sessionRow(f.sessionId)).toMatchObject({
        status: "needs_you",
        following: false,
        reason_code: "imported",
        import_replay_offset: "1234",
      })
      expect(changesOf(f.sessionId).at(-1)).toMatchObject({ to: "needs_you", cause: "follow" })
    })

    it("A45: a follow result carrying a completion, or a run result carrying a follow, is refused", async () => {
      const node = await online()
      const f = await importFollow(node)
      const gen = await start(node, f.jobId)
      const both = await nodeCall(node, `/api/nodes/jobs/${f.jobId}/result`, {
        leaseGeneration: gen,
        text: "",
        follow: { why: "owner" },
        completion: { by: "session" },
      })
      expect(both.status).toBe(400)
      expect((await sessionRow(f.sessionId)).status).toBe("running")
    })

    it("A45: /fail of a follow job (host exit) ends needs_you follow_ended and creates no job", async () => {
      const node = await online()
      const f = await importFollow(node)
      const gen = await start(node, f.jobId)
      const res = await nodeCall(node, `/api/nodes/jobs/${f.jobId}/fail`, {
        leaseGeneration: gen,
        error: "the follow host exited",
        code: "error",
      })
      expect(res.status).toBe(200)
      expect(await sessionRow(f.sessionId)).toMatchObject({
        status: "needs_you",
        following: false,
        reason_code: "follow_ended",
      })
      expect(changesOf(f.sessionId).at(-1)).toMatchObject({ to: "needs_you", cause: "follow" })
      expect(await jobsOf()).toHaveLength(1)
    })
  })

  describe("a follow never resumes and never writes (C1, A53, D45)", () => {
    it("A53: a node report that omits a live follow ends it follow_ended and creates no job", async () => {
      const node = await online()
      const f = await importFollow(node)
      await start(node, f.jobId)
      await sql`UPDATE kernel.node_jobs SET claimed_at = now() - interval '5 minutes' WHERE id = ${f.jobId}`
      const res = await report(node, [])
      expect(res.status).toBe(200)
      expect(await sessionRow(f.sessionId)).toMatchObject({
        status: "needs_you",
        following: false,
        reason_code: "follow_ended",
        job_id: f.jobId,
      })
      expect(await jobsOf()).toHaveLength(1)
      expect(changesOf(f.sessionId).at(-1)).toMatchObject({ to: "needs_you", cause: "follow" })
    })

    it("A53: a node report that lists a live follow extends its lease and changes nothing else", async () => {
      const node = await online()
      const f = await importFollow(node)
      const gen = await start(node, f.jobId)
      await sql`UPDATE kernel.node_jobs SET claimed_at = now() - interval '5 minutes',
                  lease_expires_at = now() + interval '5 seconds' WHERE id = ${f.jobId}`
      const res = await report(node, [
        { id: f.sessionId, jobId: f.jobId, leaseGeneration: gen, alive: true },
      ])
      expect(res.status).toBe(200)
      const lease = new Date((await jobRow(f.jobId)).lease_expires_at as Date)
      expect(lease.getTime()).toBeGreaterThan(Date.now() + 60_000)
      expect(await sessionRow(f.sessionId)).toMatchObject({ status: "running", following: true })
      expect((await jobRow(f.jobId)).status).toBe("running")
      expect(await jobsOf()).toHaveLength(1)
    })

    it("A53: a follow lease lapsed 10 min while the node is online ends follow_ended and creates no resume job", async () => {
      const node = await online()
      const f = await importFollow(node)
      await start(node, f.jobId)
      await sql`UPDATE kernel.node_jobs SET lease_expires_at = now() - interval '11 minutes'
                 WHERE id = ${f.jobId}`
      await sweepNodeLeases()
      expect(await sessionRow(f.sessionId)).toMatchObject({
        status: "needs_you",
        following: false,
        reason_code: "follow_ended",
      })
      expect(await jobsOf()).toHaveLength(1)
    })

    it("A53: resumeSession of a follow-mode import returns null and creates no job", async () => {
      const node = await online()
      const f = await importFollow(node)
      const gen = await start(node, f.jobId)
      await followResult(node, f.jobId, gen, { why: "transcript_gone" })
      const row = await rowOf(f.sessionId)
      expect(row.status).toBe("needs_you")
      const resumed = await resumeSession(row, {
        after: "message",
        from: ["needs_you"],
        text: "go on",
      })
      expect(resumed).toBeNull()
      expect(await jobsOf()).toHaveLength(1)
      expect((await sessionRow(f.sessionId)).status).toBe("needs_you")
    })

    it("A53: a dead follow with an unread message acks it failed and creates no job", async () => {
      const node = await online()
      const f = await importFollow(node, "take_over")
      await start(node, f.jobId)
      const sent = await command(f.sessionId, "message", { text: "carry on" })
      expect(sent.status).toBe(201)
      await sql`UPDATE kernel.node_jobs SET claimed_at = now() - interval '5 minutes' WHERE id = ${f.jobId}`
      expect((await report(node, [])).status).toBe(200)
      const [msg] = await commandsOf(f.sessionId)
      expect(msg).toMatchObject({ type: "message", outcome: "failed" })
      expect(msg.result).toEqual({ error: FOLLOW_ENDED_LINE })
      expect(await jobsOf()).toHaveLength(1)
      expect((await sessionRow(f.sessionId)).reason_code).toBe("follow_ended")
    })

    it("A53: afterRunEnded of an in-place follow with an unconfirmed unread message creates no job; with confirmDrivenElsewhere it creates one resume job", async () => {
      const node = await online()
      for (const confirm of [false, true]) {
        const run = await inPlaceRun(node)
        expect((await drivenElsewhere(node, run)).status).toBe(201)
        const follow = (await jobsOf()).find((j) => j.kind === "follow" && j.status === "offered")
        expect(follow).toBeTruthy()
        const gen = await start(node, follow!.id)
        // A message the node never got (as an older client could leave one).
        const [cmd] = await sql<Array<{ id: string }>>`
          WITH s AS (
            UPDATE kernel.node_sessions SET last_command_seq = last_command_seq + 1
             WHERE id = ${run.sessionId} RETURNING last_command_seq)
          INSERT INTO kernel.node_session_commands (session_id, seq, type, payload)
          SELECT ${run.sessionId}, last_command_seq, 'message',
                 ${JSON.stringify(confirm ? { text: "go", confirmDrivenElsewhere: true } : { text: "go" })}::jsonb
            FROM s RETURNING id`
        expect((await followResult(node, follow!.id, gen, { why: "driver_left" })).status).toBe(201)
        const resumes = (await jobsOf()).filter((j) => j.resume_command_id === cmd.id)
        if (confirm) {
          expect(resumes).toHaveLength(1)
          expect((await jobRow(resumes[0].id)).resume_after).toBe("message")
          expect((await sessionRow(run.sessionId)).status).toBe("queued")
        } else {
          expect(resumes).toHaveLength(0)
          expect((await sessionRow(run.sessionId)).reason_code).toBe("follow_ended")
          const [msg] = await commandsOf(run.sessionId)
          expect(msg).toMatchObject({ outcome: "failed" })
        }
        await sql`UPDATE kernel.node_jobs SET status = 'cancelled' WHERE org_id = ${owner.orgId}
                    AND status IN ('queued', 'offered')`
      }
    })
  })

  describe("claims outside the run plan and caps (M1, A58)", () => {
    it("A45: 4 running unattended jobs do not block a follow claim; 4 live follows do not block a run claim; the 9th follow claim → node_busy", async () => {
      const node = await online()
      for (let i = 0; i < 4; i++) await inPlaceRun(node)
      const first = await importFollow(node)
      expect((await claim(node, first.jobId)).status).toBe(200)

      const other = await online()
      const follows = [] as Array<{ jobId: string }>
      for (let i = 0; i < 4; i++) {
        const f = await importFollow(other)
        expect((await claim(other, f.jobId)).status).toBe(200)
        follows.push(f)
      }
      const run = await inPlaceRun(other)
      expect((await sessionRow(run.sessionId)).status).toBe("running")
      for (let i = 0; i < 4; i++) {
        const f = await importFollow(other)
        expect((await claim(other, f.jobId)).status).toBe(200)
      }
      const ninth = await importFollow(other)
      const busy = await claim(other, ninth.jobId)
      expect(busy.status).toBe(409)
      expect((await json(busy)).error.code).toBe("node_busy")
      expect((await jobRow(ninth.jobId)).status).not.toBe("running")
    })

    it("A45: a follow claim mints no MCP connection and calls no model plan", async () => {
      // The node offers no model of the session's: a run plan would refuse it.
      const node = await online({ models: [{ id: "claude-sonnet-4-5", label: "Sonnet" }] })
      const f = await importFollow(node)
      const withConnection = await claim(node, f.jobId, 5, { mcpConnectionId: crypto.randomUUID() })
      expect(withConnection.status).toBe(422)
      expect((await json(withConnection)).error.code).toBe("bad_connection")
      const res = await claim(node, f.jobId)
      expect(res.status).toBe(200)
      // No run plan: no profile, no caps, no level or model taken from the agent's profile.
      const data = (await json(res)).data
      expect(data.profile).toBeUndefined()
      expect(data.caps).toBeUndefined()
      expect(await jobRow(f.jobId)).toMatchObject({ status: "running", mcp_connection_id: null })
      const [model] = await sql<Array<{ model: string }>>`
        SELECT model FROM kernel.node_sessions WHERE id = ${f.sessionId}`
      expect(model.model).toBe(IMPORT_HAIKU)
    })

    it("A45: a follow claim from protocol 4 → 409 node_outdated, the job stays queued (not refused)", async () => {
      const node = await online()
      const f = await importFollow(node)
      const res = await claim(node, f.jobId, 4)
      expect(res.status).toBe(409)
      expect((await json(res)).error.code).toBe("node_outdated")
      expect(["queued", "offered"]).toContain((await jobRow(f.jobId)).status)
      expect((await sessionRow(f.sessionId)).status).toBe("queued")
    })

    it("A45: a follow is never offered to a node without importProtocol 5", async () => {
      const old = await online({ importProtocol: null })
      const f = await importFollow(old)
      const ws = old.ws as FakeWs
      expect(ws.frames.some((fr) => fr.type === "node_job_offer" && fr.jobId === f.jobId)).toBe(
        false,
      )
      expect((await jobRow(f.jobId)).status).toBe("queued")

      const current = await online()
      const g = await importFollow(current)
      const cws = current.ws as FakeWs
      expect(cws.frames.some((fr) => fr.type === "node_job_offer" && fr.jobId === g.jobId)).toBe(
        true,
      )
    })
  })

  describe("commands on a following session (M2, A54)", () => {
    it("A54: message to a following follow-mode import → 409 follow_read_only", async () => {
      const node = await online()
      const f = await importFollow(node)
      await start(node, f.jobId)
      const res = await command(f.sessionId, "message", { text: "hello" })
      expect(res.status).toBe(409)
      expect((await json(res)).error.code).toBe("follow_read_only")
      expect(await commandsOf(f.sessionId)).toHaveLength(0)
    })

    it("A54: message during a take_over replay is queued and the replay's end creates one resume job carrying it", async () => {
      const node = await online()
      const f = await importFollow(node, "take_over")
      const gen = await start(node, f.jobId)
      const ws = node.ws as FakeWs
      const framesBefore = ws.frames.length
      const res = await command(f.sessionId, "message", { text: "carry on" })
      expect(res.status).toBe(201)
      const { commandId } = (await json(res)).data
      // Nobody reads it during the replay: no wake.
      expect(ws.frames.slice(framesBefore).some((fr) => fr.type === "node_session_command")).toBe(
        false,
      )
      expect(await jobsOf()).toHaveLength(1)
      await followResult(node, f.jobId, gen, { why: "replayed", endOffset: 10 })
      const resumes = (await jobsOf()).filter((j) => j.id !== f.jobId)
      expect(resumes).toHaveLength(1)
      expect(resumes[0]).toMatchObject({ kind: "unattended", resume_command_id: commandId })
      expect((await sessionRow(f.sessionId)).status).toBe("queued")
    })

    it("A54: message to an auto-followed in-place session without confirm → 409 driven_elsewhere_confirm; with confirm → the follow is stopped and one resume job carries confirmDrivenElsewhere", async () => {
      const node = await online()
      const run = await inPlaceRun(node)
      await drivenElsewhere(node, run)
      const follow = (await jobsOf()).find((j) => j.kind === "follow")!
      await start(node, follow.id)

      const bare = await command(run.sessionId, "message", { text: "go" })
      expect(bare.status).toBe(409)
      expect((await json(bare)).error.code).toBe("driven_elsewhere_confirm")
      expect(await commandsOf(run.sessionId)).toHaveLength(0)

      const confirmed = await command(run.sessionId, "message", {
        text: "go",
        confirmDrivenElsewhere: true,
      })
      expect(confirmed.status).toBe(201)
      const { commandId } = (await json(confirmed)).data
      expect((await jobRow(follow.id)).status).toBe("cancelled")
      const resumes = (await jobsOf()).filter((j) => j.resume_command_id === commandId)
      expect(resumes).toHaveLength(1)
      expect((await sessionRow(run.sessionId)).following).toBe(false)
      const claimed = await claim(node, resumes[0].id)
      expect(claimed.status).toBe(200)
      expect((await json(claimed)).data.session.resume).toMatchObject({
        after: "message",
        commandId,
        confirmDrivenElsewhere: true,
      })
    })

    it("A54: answer, set_model and stop_task on a following session → noop", async () => {
      const node = await online()
      const f = await importFollow(node)
      await start(node, f.jobId)
      const sent = [
        await command(f.sessionId, "answer", { requestId: "q1", answers: { a: "b" } }),
        await command(f.sessionId, "set_model", { model: "claude-sonnet-4-5" }),
        await command(f.sessionId, "stop_task", { taskId: "t1" }),
      ]
      for (const r of sent) expect(r.status).toBe(201)
      const cmds = await commandsOf(f.sessionId)
      expect(cmds.map((c) => [c.type, c.outcome])).toEqual([
        ["answer", "noop"],
        ["set_model", "noop"],
        ["stop_task", "noop"],
      ])
      const [model] = await sql<Array<{ model: string }>>`
        SELECT model FROM kernel.node_sessions WHERE id = ${f.sessionId}`
      expect(model.model).toBe(IMPORT_HAIKU)
    })

    it("A45: Stop on a following import ends follow_ended, no notice", async () => {
      const node = await online()
      const f = await importFollow(node)
      const gen = await start(node, f.jobId)
      const ws = node.ws as FakeWs
      const res = await command(f.sessionId, "stop")
      expect(res.status).toBe(201)
      // The node stops its follow and reports where it stopped.
      expect(
        ws.frames.some((fr) => fr.type === "node_session_command" && fr.sessionId === f.sessionId),
      ).toBe(true)
      expect((await followResult(node, f.jobId, gen, { why: "owner", endOffset: 5 })).status).toBe(
        201,
      )
      expect(await sessionRow(f.sessionId)).toMatchObject({
        status: "needs_you",
        reason_code: "follow_ended",
        following: false,
      })
      expect(changesOf(f.sessionId).at(-1)).toMatchObject({ to: "needs_you", cause: "owner" })
      const [stop] = await commandsOf(f.sessionId)
      expect(stop).toMatchObject({ type: "stop", outcome: "applied" })
      expect(await jobsOf()).toHaveLength(1)
    })

    it("A54: Stop during a take_over replay → needs_you imported", async () => {
      const node = await online()
      const f = await importFollow(node, "take_over")
      const gen = await start(node, f.jobId)
      expect((await command(f.sessionId, "stop")).status).toBe(201)
      await followResult(node, f.jobId, gen, { why: "owner", endOffset: 99 })
      expect(await sessionRow(f.sessionId)).toMatchObject({
        status: "needs_you",
        reason_code: "imported",
        import_replay_offset: "99",
      })
    })

    it("A54: Stop on a follow not yet claimed cancels it and ends needs_you follow_ended", async () => {
      const node = await online()
      const f = await importFollow(node)
      expect((await command(f.sessionId, "stop")).status).toBe(201)
      expect((await jobRow(f.jobId)).status).toBe("cancelled")
      expect(await sessionRow(f.sessionId)).toMatchObject({
        status: "needs_you",
        reason_code: "follow_ended",
      })
      const [stop] = await commandsOf(f.sessionId)
      expect(stop.outcome).toBe("applied")
    })
  })

  describe("Take over, catch-up and delete (W3 T09b: A44, A49, A61, A62)", () => {
    const remove = (sessionId: string, who: minimal.Session = owner) =>
      callAs(who, `/api/me/node-sessions/${sessionId}`, "DELETE")

    /** Claim, start and end a resume run with a turn end. */
    async function runResume(node: FakeNode, jobId: string) {
      const claimed = await claim(node, jobId)
      expect(claimed.status).toBe(200)
      const data = (await json(claimed)).data
      const gen = data.leaseGeneration as number
      await nodeCall(node, `/api/nodes/jobs/${jobId}/started`, { leaseGeneration: gen })
      const done = await nodeCall(node, `/api/nodes/jobs/${jobId}/result`, {
        leaseGeneration: gen,
        text: "",
        completion: { by: "needs_you" },
      })
      expect(done.status).toBe(201)
      return data
    }

    it("A44: a once follow ending replayed leaves needs_you imported; a message then creates one resume job whose claim carries the imported sdkSessionId and catchUpFrom, and a second claim of a later resume carries none", async () => {
      const node = await online()
      const f = await importFollow(node, "take_over")
      const gen = await start(node, f.jobId)
      await followResult(node, f.jobId, gen, { why: "replayed", endOffset: 1234 })
      expect((await sessionRow(f.sessionId)).reason_code).toBe("imported")
      const [ids] = await sql<Array<{ s: string }>>`
        SELECT import_sdk_session_id AS s FROM kernel.node_sessions WHERE id = ${f.sessionId}`

      const sent = await command(f.sessionId, "message", { text: "carry on" })
      expect(sent.status).toBe(201)
      const first = (await jobsOf()).filter((j) => j.id !== f.jobId)
      expect(first).toHaveLength(1)
      const answer = await runResume(node, first[0].id)
      expect(answer.session.resume).toMatchObject({
        sdkSessionId: ids.s,
        after: "message",
        catchUpFrom: 1234,
      })
      expect((await sessionRow(f.sessionId)).import_replay_offset).toBeNull()

      expect((await command(f.sessionId, "message", { text: "and then" })).status).toBe(201)
      const second = (await jobsOf()).filter((j) => j.id !== f.jobId && j.id !== first[0].id)
      expect(second).toHaveLength(1)
      const later = await runResume(node, second[0].id)
      expect(later.session.resume.after).toBe("message")
      expect("catchUpFrom" in later.session.resume).toBe(false)
    })

    it("A44: a Take over import's resume claim carries its cwdSubdir; an in-place app run's carries none", async () => {
      const node = await online()
      const f = await importFollow(node, "take_over")
      const gen = await start(node, f.jobId)
      await followResult(node, f.jobId, gen, { why: "replayed", endOffset: 10 })
      expect((await command(f.sessionId, "message", { text: "carry on" })).status).toBe(201)
      const [resume] = (await jobsOf()).filter((j) => j.id !== f.jobId)
      const answer = await runResume(node, resume.id)
      expect(answer.session.cwdSubdir).toBe("app")
      expect(answer.session.finishWith).toBe("none")

      const other = await createNodeJob({
        orgId: owner.orgId,
        ownerUserId: owner.userId,
        agentId,
        threadId: null,
        source: "app",
        prompt: "Again",
        sourceRequiredScopes: [],
        targetNodeId: node.nodeId,
        session: {
          source: "app",
          configKind: "owner",
          folderName: "code",
          folderPath: "/Users/o/code",
          model: IMPORT_HAIKU,
          level: "strict",
        },
      })
      const plain = await claim(node, other.id)
      expect(plain.status).toBe(200)
      expect("cwdSubdir" in (await json(plain)).data.session).toBe(false)
    })

    it("D53: an import from the shared repo's worktree outside the folder names it in the follow claim and in the Take over's resume claim", async () => {
      const node = await online()
      const f = await importFollow(node, "take_over", "/tmp/code-wt")
      const res = await claim(node, f.jobId)
      expect(res.status).toBe(200)
      const data = (await json(res)).data
      expect(data.follow).toMatchObject({
        folderName: "code",
        worktreePath: "/tmp/code-wt",
        cwdSubdir: "app",
      })
      const gen = data.leaseGeneration as number
      const started = await nodeCall(node, `/api/nodes/jobs/${f.jobId}/started`, {
        leaseGeneration: gen,
      })
      expect(started.status).toBe(200)
      await followResult(node, f.jobId, gen, { why: "replayed", endOffset: 10 })
      expect((await command(f.sessionId, "message", { text: "carry on" })).status).toBe(201)
      const [resume] = (await jobsOf()).filter((j) => j.id !== f.jobId)
      const answer = await runResume(node, resume.id)
      expect(answer.session.worktreePath).toBe("/tmp/code-wt")
      expect(answer.session.cwdSubdir).toBe("app")
      // A plain import names none.
      const plain = await importFollow(node)
      const plainRes = await claim(node, plain.jobId)
      expect("worktreePath" in (await json(plainRes)).data.follow).toBe(false)
    })

    it("A44: a run the node refuses unsafe_subdir ends the job refused", async () => {
      const node = await online()
      const f = await importFollow(node, "take_over")
      const gen = await start(node, f.jobId)
      await followResult(node, f.jobId, gen, { why: "replayed", endOffset: 10 })
      expect((await command(f.sessionId, "message", { text: "carry on" })).status).toBe(201)
      const [resume] = (await jobsOf()).filter((j) => j.id !== f.jobId)
      const claimed = await claim(node, resume.id)
      const runGen = (await json(claimed)).data.leaseGeneration as number
      const failed = await nodeCall(node, `/api/nodes/jobs/${resume.id}/fail`, {
        leaseGeneration: runGen,
        code: "unsafe_subdir",
        error: "The session's folder is not inside the shared folder.",
      })
      expect(failed.status).toBe(200)
      expect((await jobRow(resume.id)).status).toBe("refused")
    })

    it("B2-3: a run the node refuses already_liaison (another server ran the session) ends the job refused", async () => {
      const node = await online()
      const f = await importFollow(node, "take_over")
      const gen = await start(node, f.jobId)
      await followResult(node, f.jobId, gen, { why: "replayed", endOffset: 10 })
      expect((await command(f.sessionId, "message", { text: "carry on" })).status).toBe(201)
      const [resume] = (await jobsOf()).filter((j) => j.id !== f.jobId)
      const claimed = await claim(node, resume.id)
      const runGen = (await json(claimed)).data.leaseGeneration as number
      const failed = await nodeCall(node, `/api/nodes/jobs/${resume.id}/fail`, {
        leaseGeneration: runGen,
        code: "already_liaison",
        error: "This session was run on this computer for another Liaison server.",
      })
      expect(failed.status).toBe(200)
      expect((await jobRow(resume.id)).status).toBe("refused")
    })

    it("A44: take_over on a follow import stops the follow and leaves needs_you imported", async () => {
      const node = await online()
      const f = await importFollow(node)
      const gen = await start(node, f.jobId)
      const ws = node.ws as FakeWs
      const before = ws.frames.length
      const res = await command(f.sessionId, "take_over")
      expect(res.status).toBe(201)
      // The node stops the follow and reports where it reached (A62).
      expect(
        ws.frames
          .slice(before)
          .some((fr) => fr.type === "node_session_command" && fr.sessionId === f.sessionId),
      ).toBe(true)
      const [mode] = await sql<Array<{ import_mode: string }>>`
        SELECT import_mode FROM kernel.node_sessions WHERE id = ${f.sessionId}`
      expect(mode.import_mode).toBe("take_over")
      expect((await followResult(node, f.jobId, gen, { why: "owner", endOffset: 77 })).status).toBe(
        201,
      )
      expect(await sessionRow(f.sessionId)).toMatchObject({
        status: "needs_you",
        reason_code: "imported",
        following: false,
        import_replay_offset: "77",
      })
      expect(changesOf(f.sessionId).at(-1)).toMatchObject({ to: "needs_you", cause: "owner" })
      const [cmd] = await commandsOf(f.sessionId)
      expect(cmd).toMatchObject({ type: "take_over", outcome: "applied" })
      // Now steerable: a message resumes it by id.
      expect((await command(f.sessionId, "message", { text: "go on" })).status).toBe(201)
      expect((await jobsOf()).filter((j) => j.id !== f.jobId)).toHaveLength(1)
    })

    it("A44: take_over on a follow not yet claimed cancels it and ends needs_you imported; on a take_over import or a dispatch it is noop", async () => {
      const node = await online()
      const f = await importFollow(node)
      expect((await command(f.sessionId, "take_over")).status).toBe(201)
      expect((await jobRow(f.jobId)).status).toBe("cancelled")
      expect(await sessionRow(f.sessionId)).toMatchObject({
        status: "needs_you",
        reason_code: "imported",
        following: false,
      })
      expect((await commandsOf(f.sessionId))[0].outcome).toBe("applied")

      const t = await importFollow(node, "take_over")
      await start(node, t.jobId)
      expect((await command(t.sessionId, "take_over")).status).toBe(201)
      expect((await commandsOf(t.sessionId))[0].outcome).toBe("noop")

      const run = await inPlaceRun(node)
      expect((await command(run.sessionId, "take_over")).status).toBe(201)
      const [ack] = (await commandsOf(run.sessionId)).filter((c) => c.type === "take_over")
      expect(ack.outcome).toBe("noop")
    })

    it("A44: take_over on a follow import whose follow already ended makes it steerable, needs_you imported", async () => {
      const node = await online()
      const f = await importFollow(node)
      const gen = await start(node, f.jobId)
      await followResult(node, f.jobId, gen, { why: "driver_left" })
      expect((await sessionRow(f.sessionId)).reason_code).toBe("follow_ended")
      expect((await command(f.sessionId, "take_over")).status).toBe(201)
      expect(await sessionRow(f.sessionId)).toMatchObject({
        status: "needs_you",
        reason_code: "imported",
      })
      expect((await commandsOf(f.sessionId))[0].outcome).toBe("applied")
      expect((await command(f.sessionId, "message", { text: "go on" })).status).toBe(201)
      expect((await jobsOf()).filter((j) => j.id !== f.jobId)).toHaveLength(1)
    })

    it("A49: DELETE of a following import stops the follow, removes the row, its events and its attention rows, and sends node_session_deleted", async () => {
      const node = await online()
      const f = await importFollow(node)
      await start(node, f.jobId)
      const [{ n: eventsBefore }] = await sql<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM kernel.node_session_events WHERE session_id = ${f.sessionId}`
      expect(eventsBefore).toBeGreaterThan(0)
      await sql`
        INSERT INTO kernel.attention_events
          (org_id, user_id, app, entity_type, entity_id, kind, urgency, summary, actor_type,
           occurred_at, digest_eligible_at)
        VALUES (${owner.orgId}, ${owner.userId}, 'kernel', 'node_session', ${f.sessionId},
                'node_session_needs_you', 1, 'x', 'system', now(), now())`
      const spy = spyOn(eventBus, "broadcastEphemeral")
      try {
        const res = await remove(f.sessionId)
        expect(res.status).toBe(200)
        const frame = spy.mock.calls
          .map((c) => c[0] as { entity: string; action: string; data: Record<string, unknown> })
          .find((e) => e.entity === "node_session" && e.action === "delete")
        expect(frame?.data).toEqual({
          ownerUserId: owner.userId,
          sessionId: f.sessionId,
          deleted: true,
        })
      } finally {
        spy.mockRestore()
      }
      expect((await jobRow(f.jobId)).status).toBe("cancelled")
      const [{ s, e, a }] = await sql<Array<{ s: number; e: number; a: number }>>`
        SELECT (SELECT count(*)::int FROM kernel.node_sessions WHERE id = ${f.sessionId}) AS s,
               (SELECT count(*)::int FROM kernel.node_session_events WHERE session_id = ${f.sessionId}) AS e,
               (SELECT count(*)::int FROM kernel.attention_events
                 WHERE entity_type = 'node_session' AND entity_id = ${f.sessionId}) AS a`
      expect({ s, e, a }).toEqual({ s: 0, e: 0, a: 0 })
    })

    it("A61: DELETE with a queued resume job cancels it; a later claim of it gets not_claimable", async () => {
      const node = await online()
      const f = await importFollow(node, "take_over")
      const gen = await start(node, f.jobId)
      await followResult(node, f.jobId, gen, { why: "replayed", endOffset: 10 })
      expect((await command(f.sessionId, "message", { text: "go" })).status).toBe(201)
      const [resume] = (await jobsOf()).filter((j) => j.id !== f.jobId)
      expect(["queued", "offered"]).toContain(resume.status)
      expect((await remove(f.sessionId)).status).toBe(200)
      expect((await jobRow(resume.id)).status).toBe("cancelled")
      const late = await claim(node, resume.id)
      expect(late.status).toBe(409)
      expect((await json(late)).error.code).toBe("not_claimable")
    })

    it("A49: DELETE of a live run of a take_over import → 409 session_live, nothing removed", async () => {
      const node = await online()
      const f = await importFollow(node, "take_over")
      const gen = await start(node, f.jobId)
      await followResult(node, f.jobId, gen, { why: "replayed", endOffset: 10 })
      await command(f.sessionId, "message", { text: "go" })
      const [resume] = (await jobsOf()).filter((j) => j.id !== f.jobId)
      await start(node, resume.id)
      const res = await remove(f.sessionId)
      expect(res.status).toBe(409)
      expect((await json(res)).error.code).toBe("session_live")
      expect((await sessionRow(f.sessionId)).status).toBe("running")
    })
  })

  describe("the in-place auto-follow (D28 b)", () => {
    it("D28b: an in-place result with driven_elsewhere_vscode from a protocol-5 node creates one follow job (inPlace, startAt end); from protocol 4 none; a second such result while one is live creates none", async () => {
      const node = await online()
      const run = await inPlaceRun(node)
      expect((await drivenElsewhere(node, run)).status).toBe(201)
      const follows = (await jobsOf()).filter((j) => j.kind === "follow")
      expect(follows).toHaveLength(1)
      expect((await jobRow(follows[0].id)).trigger).toEqual({
        follow: { startAt: "end", once: false, inPlace: true },
      })
      expect((await sessionRow(run.sessionId)).job_id).toBe(follows[0].id)
      const claimed = await claim(node, follows[0].id)
      expect(claimed.status).toBe(200)
      const answer = (await json(claimed)).data
      expect(answer.follow).toEqual({
        sdkSessionId: run.sdk,
        folderName: "code",
        cwdSubdir: "",
        startAt: "end",
        once: false,
        inPlace: true,
      })
      const gen = answer.leaseGeneration as number
      await nodeCall(node, `/api/nodes/jobs/${follows[0].id}/started`, { leaseGeneration: gen })

      // Another driven_elsewhere result of this session while its follow is live.
      const [runJob] = await withPrivilegedDb(owner.orgId, "test-run-job", (tx) =>
        tx.select().from(nodeJobs).where(eq(nodeJobs.id, run.jobId)),
      )
      expect(await jobs.followInPlaceAfterResult(runJob, "driven_elsewhere_vscode")).toBeNull()
      expect((await jobsOf()).filter((j) => j.kind === "follow")).toHaveLength(1)

      const old = await online()
      const oldRun = await inPlaceRun(old, 4)
      expect((await drivenElsewhere(old, oldRun, 4)).status).toBe(201)
      expect((await jobsOf()).filter((j) => j.kind === "follow")).toHaveLength(1)
    })
  })
})
