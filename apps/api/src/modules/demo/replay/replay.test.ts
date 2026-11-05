// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The demo replay (S31, C7): a recorded session on a simulated node of a demo
// org. Allow plays the rest and ends done with the pull request; Deny plays the
// short "stopped by you" ending; no decision leaves the session waiting and
// nothing else; a ticker killed mid-replay continues from the next event on
// the boot resume, with no duplicate; the lease sweeps never touch it and no
// real node is offered its job; presence reports the simulated node online
// with no socket; a regular org gets none of it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { sql } from "~/db"
import * as eventBusModule from "~/infra/events/event-bus"
import { isLeader, LeadershipTestAccess, startLeadership, stopLeadership } from "~/infra/leadership"
import { getWsManager, setWsManager, WebSocketManager } from "~/infra/websocket"
import { redis } from "~/lib/redis"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { invalidateDemoMarker, markOrgAsDemo, visitorMarker } from "~/modules/demo/demo-org"
import { submitCommand } from "~/modules/node-sessions/commands"
import { sweepSessionLeases } from "~/modules/node-sessions/lifecycle"
import { appendReplayEvents, ReplayAppendRefusedError } from "~/modules/node-sessions/store"
import { onNodeConnectionHello } from "~/modules/nodes/hooks"
import { createNodeJob, NodeJobRefusedError, sweepNodeLeases } from "~/modules/nodes/jobs"
import { liveDesktopConnections, sweepStaleNodeSessions } from "~/modules/nodes/presence"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  ensureSimulatedNode,
  pacingFactor,
  RECORDING,
  REPLAY_MAX_MS,
  type ReplayClock,
  ReplayRefusedError,
  replayInFlight,
  resumeRunningReplays,
  runReplay,
  startReplay,
} from "./replay"
import {
  ReplayResumeTestAccess,
  registerReplayResumeSingleton,
  resumeReplaysOnLeader,
} from "./resume"

const REQUEST_ID = "recorded-permission-1"

/** A clock whose sleep only moves time: a replay plays in milliseconds. */
function fakeClock(): ReplayClock & { slept: number } {
  let t = Date.now()
  const clock = {
    slept: 0,
    now: () => t,
    async sleep(ms: number) {
      clock.slept += ms
      t += ms
      await Promise.resolve()
    },
  }
  return clock
}

interface FakeWs {
  send(data: string): void
  close(): void
  readyState: number
  frames: Array<Record<string, unknown>>
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

describe("demo replay", () => {
  let visitor: minimal.Session
  let regular: minimal.Session
  let manager: WebSocketManager
  let previous: WebSocketManager | null

  const events = (sessionId: string) =>
    sql<Array<{ seq: number; type: string; payload: Record<string, unknown> }>>`
      SELECT seq, type, payload FROM kernel.node_session_events
       WHERE session_id = ${sessionId} ORDER BY seq`
  const session = async (id: string) =>
    (
      await sql<
        Array<{ status: string; pr_url: string | null; ended_at: Date | null; last_seq: number }>
      >`SELECT status, pr_url, ended_at, last_seq FROM kernel.node_sessions WHERE id = ${id}`
    )[0]
  const job = async (id: string) =>
    (
      await sql<
        Array<{
          status: string
          lease_holder: string | null
          node_id: string | null
          lease_expires_at: Date | null
        }>
      >`SELECT status, lease_holder, node_id, lease_expires_at FROM kernel.node_jobs WHERE id = ${id}`
    )[0]
  const replaySteps = (sessionId: string) =>
    sql<Array<{ payload: Record<string, any> }>>`
      SELECT payload FROM kernel.pending_events
       WHERE payload->>'entity' = 'node_session' AND payload->>'action' = 'replay_step'
         AND payload->>'entityId' = ${sessionId}
       ORDER BY seq`

  async function cleanup() {
    for (const s of [visitor, regular]) {
      if (!s) continue
      await sql`DELETE FROM kernel.node_sessions WHERE org_id = ${s.orgId}`
      await sql`DELETE FROM kernel.node_jobs WHERE org_id = ${s.orgId}`
      await sql`DELETE FROM kernel.nodes WHERE org_id = ${s.orgId}`
    }
  }

  /** Play until the session waits on the permission request. */
  async function playToRequest(clock = fakeClock()) {
    const started = await startReplay(
      { orgId: visitor.orgId, ownerUserId: visitor.userId },
      { launch: false },
    )
    const run = runReplay(visitor.orgId, started.sessionId, { clock, pollMs: 1000 })
    for (let i = 0; i < 400; i++) {
      if ((await session(started.sessionId)).status === "waiting") break
      await Bun.sleep(10)
    }
    expect((await session(started.sessionId)).status).toBe("waiting")
    return { ...started, run, clock }
  }

  const decide = (sessionId: string, allow: boolean) =>
    submitCommand({
      orgId: visitor.orgId,
      userId: visitor.userId,
      sessionId,
      command: {
        type: "permission_decision",
        payload: { requestId: REQUEST_ID, allow, scope: "once" },
      },
    })

  beforeAll(async () => {
    await acquireTestLock()
    previous = getWsManager()
    manager = new WebSocketManager(redis)
    setWsManager(manager)
    // createTestOrg truncates every org: the regular org first, the demo org beside it.
    const regularOrg = await createTestOrg()
    // Each registered person already owns the personal agent the replay drives.
    regular = await minimal.session(regularOrg.id)
    const demoOrgId = (await minimal.secondOrg({ name: "Replay Demo" })).orgId
    await markOrgAsDemo(demoOrgId, visitorMarker(24))
    invalidateDemoMarker(demoOrgId)
    visitor = await minimal.adminSession(demoOrgId)
    DemoModeTestAccess.set(true)
  })

  beforeEach(cleanup)

  afterAll(async () => {
    await cleanup()
    DemoModeTestAccess.set(null)
    if (previous) setWsManager(previous)
    await releaseTestLock()
  })

  it("the recording's longest path fits in 90 s at its pacing", () => {
    const factor = pacingFactor()
    const permAt = RECORDING.events.findIndex((e) => e.type === "permission_request")
    const total = (list: typeof RECORDING.events) =>
      list.reduce((n, e) => n + Math.round(e.delayMs * factor), 0)
    expect(total(RECORDING.events)).toBeLessThanOrEqual(REPLAY_MAX_MS)
    expect(
      total(RECORDING.events.slice(0, permAt + 1)) + total(RECORDING.denied),
    ).toBeLessThanOrEqual(REPLAY_MAX_MS)
    expect(RECORDING.events.length + RECORDING.denied.length).toBeLessThanOrEqual(200)
  })

  it("Allow plays the rest: the session ends done with its pull request, the tour step is durable", async () => {
    const { sessionId, jobId, run, clock } = await playToRequest()
    const result = await decide(sessionId, true)
    expect(result.ok).toBe(true)
    expect(await run).toBe("ended")
    const row = await session(sessionId)
    expect(row.status).toBe("done")
    expect(row.ended_at).not.toBeNull()
    expect(row.pr_url).toBe("https://git.example/resonant/resonant-fw/pull/128")
    expect((await job(jobId)).status).toBe("done")
    const log = await events(sessionId)
    expect(log.filter((e) => e.type === "result")).toHaveLength(1)
    expect(log.find((e) => e.type === "decision")?.payload).toMatchObject({
      requestId: REQUEST_ID,
      outcome: "allow",
      by: "owner",
    })
    const acked = await sql<Array<{ outcome: string | null; acked_at: Date | null }>>`
      SELECT outcome, acked_at FROM kernel.node_session_commands WHERE session_id = ${sessionId}`
    expect(acked).toHaveLength(1)
    expect(acked[0].outcome).toBe("applied")
    // The request queued `asked` (walk D38: the scenario waits on it), the allow `approved`.
    const steps = await replaySteps(sessionId)
    expect(steps.map((s) => s.payload.data.replayStep)).toEqual(["asked", "approved"])
    for (const step of steps) {
      expect(step.payload.data).toMatchObject({ sessionId, ownerUserId: visitor.userId })
      expect(step.payload.actorId).toBe(visitor.userId)
    }
    // Every recorded event once, in order, no seq twice.
    const recordedTypes = log.filter(
      (e) => !["status", "decision", "command_applied"].includes(e.type),
    )
    expect(recordedTypes.map((e) => e.type)).toEqual(RECORDING.events.map((e) => e.type))
    expect(new Set(log.map((e) => e.seq)).size).toBe(log.length)
    expect(clock.slept).toBeLessThanOrEqual(REPLAY_MAX_MS + 2_000)
  })

  it("Deny plays the stopped-by-you ending", async () => {
    const { sessionId, jobId, run } = await playToRequest()
    await decide(sessionId, false)
    expect(await run).toBe("ended")
    const row = await session(sessionId)
    expect(row.status).toBe("stopped")
    expect(row.pr_url).toBeNull()
    expect((await job(jobId)).status).toBe("cancelled")
    const log = await events(sessionId)
    const results = log.filter((e) => e.type === "result")
    expect(results).toHaveLength(1)
    expect(results[0].payload.pushed).toBe(false)
    expect(log.some((e) => e.type === "tool_call" && e.payload.id === "toolu_09")).toBe(false)
    expect((await replaySteps(sessionId)).map((s) => s.payload.data.replayStep)).toEqual([
      "asked",
      "denied",
    ])
  })

  it("no decision for 10 minutes: the session stays waiting and nothing else is appended", async () => {
    const clock = fakeClock()
    const started = await startReplay(
      { orgId: visitor.orgId, ownerUserId: visitor.userId },
      { launch: false },
    )
    const outcome = await runReplay(visitor.orgId, started.sessionId, {
      clock,
      pollMs: 15_000,
      decisionWaitMs: 10 * 60_000,
    })
    expect(outcome).toBe("parked")
    const row = await session(started.sessionId)
    expect(row.status).toBe("waiting")
    const log = await events(started.sessionId)
    const at = log.findIndex((e) => e.type === "permission_request")
    expect(log.slice(at + 1).map((e) => e.type)).toEqual(["status"])
    expect(log.at(-1)?.payload.status).toBe("waiting")
    // The request was asked, once; nothing was answered.
    expect((await replaySteps(started.sessionId)).map((s) => s.payload.data.replayStep)).toEqual([
      "asked",
    ])
  })

  it("a new run of the scenario ends the earlier run's replay and starts its own", async () => {
    const owner = { orgId: visitor.orgId, ownerUserId: visitor.userId }
    const first = await startReplay(owner, { launch: false })
    // Within the run (a reload, a stale reclaim): the playing replay is returned.
    const same = await startReplay(owner, { launch: false, notBefore: new Date(0) })
    expect(same).toMatchObject({ sessionId: first.sessionId, created: false })
    // Started again: the earlier replay ends, the new run gets its own session.
    await Bun.sleep(5)
    const next = await startReplay(owner, { launch: false, notBefore: new Date() })
    expect(next.created).toBe(true)
    expect(next.sessionId).not.toBe(first.sessionId)
    expect((await session(first.sessionId))?.ended_at).not.toBeNull()
    expect((await session(next.sessionId))?.ended_at).toBeNull()
  })

  it("a ticker killed mid-replay continues from the next event on the boot resume, no duplicate", async () => {
    const started = await startReplay(
      { orgId: visitor.orgId, ownerUserId: visitor.userId },
      { launch: false },
    )
    let steps = 0
    const dying: ReplayClock = {
      now: () => Date.now(),
      async sleep() {
        if (++steps > 6) throw new Error("process killed")
      },
    }
    await expect(runReplay(visitor.orgId, started.sessionId, { clock: dying })).rejects.toThrow(
      "process killed",
    )
    const before = (await events(started.sessionId)).filter((e) => e.type !== "status")
    expect(before).toHaveLength(6)

    // The boot hook: only on a demo instance, only on the leader.
    const launched = await resumeRunningReplays({ clock: fakeClock(), pollMs: 1000 })
    expect(launched).toBe(1)
    for (let i = 0; i < 400; i++) {
      if ((await session(started.sessionId)).status === "waiting") break
      await Bun.sleep(10)
    }
    await decide(started.sessionId, true)
    expect(await replayInFlight(started.sessionId)).toBe("ended")
    const log = await events(started.sessionId)
    const recordedTypes = log.filter(
      (e) => !["status", "decision", "command_applied"].includes(e.type),
    )
    expect(recordedTypes.map((e) => e.type)).toEqual(RECORDING.events.map((e) => e.type))
    const toolIds = log.filter((e) => e.type === "tool_call").map((e) => e.payload.id)
    expect(new Set(toolIds).size).toBe(toolIds.length)
    expect(new Set(log.map((e) => e.seq)).size).toBe(log.length)
  })

  it("the boot resume waits out the lock a stopped process left, then plays on", async () => {
    const started = await startReplay(
      { orgId: visitor.orgId, ownerUserId: visitor.userId },
      { launch: false },
    )
    // A process stopped mid-replay (a deploy): its lock outlives it.
    await redis.set(`demo:replay:lock:${started.sessionId}`, "stopped-process", "PX", 300)
    const launched = await resumeRunningReplays({ clock: fakeClock(), pollMs: 1000 })
    expect(launched).toBe(1)
    for (let i = 0; i < 400; i++) {
      if ((await session(started.sessionId)).status === "waiting") break
      await Bun.sleep(10)
    }
    expect((await session(started.sessionId)).status).toBe("waiting")
    await decide(started.sessionId, true)
    expect(await replayInFlight(started.sessionId)).toBe("ended")
  })

  it("the boot resume does nothing outside a demo instance", async () => {
    await startReplay({ orgId: visitor.orgId, ownerUserId: visitor.userId }, { launch: false })
    // This process leads, so only the demo-mode check can refuse the resume.
    await startLeadership({
      role: "all",
      lease: {
        key: `replay-test:${crypto.randomUUID()}`,
        ttlMs: 3_000,
        renewMs: 1_000,
        pollMs: 250,
      },
    })
    expect(isLeader()).toBe(true)
    DemoModeTestAccess.set(false)
    try {
      expect(await resumeReplaysOnLeader()).toBe(0)
    } finally {
      DemoModeTestAccess.set(true)
      await LeadershipTestAccess.reset()
    }
  })

  it("replay resume arms on acquire and disarms on loss", async () => {
    const key = `replay-resume-test:${crypto.randomUUID()}`
    try {
      // Registered while this process does not lead: nothing is armed.
      registerReplayResumeSingleton()
      expect(ReplayResumeTestAccess.armed()).toBe(false)
      await startLeadership({
        role: "all",
        lease: { key, ttlMs: 3_000, renewMs: 1_000, pollMs: 250 },
      })
      expect(isLeader()).toBe(true)
      expect(ReplayResumeTestAccess.armed()).toBe(true)
      // Losing the lease disarms the pending resume.
      await stopLeadership()
      expect(ReplayResumeTestAccess.armed()).toBe(false)
    } finally {
      await LeadershipTestAccess.reset()
      await redis.del(key)
    }
  })

  it("every sweep leaves a replay alone and its job is never offered to the owner's real node", async () => {
    // The owner's real, connected node.
    const deviceId = `d.${crypto.randomUUID()}`
    const enabled = await (await import("~/app")).app.request("/api/nodes", {
      method: "POST",
      headers: { Authorization: `Bearer ${visitor.bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId, name: "Studio Mac" }),
    })
    expect(enabled.status).toBe(201)
    const real = (await enabled.json()) as { data: { node: { id: string }; credential: string } }
    const ws = fakeWs()
    manager.addConnection(visitor.userId, ws, ["*"], visitor.orgId)
    const entry = await manager.registerNotifyClient(ws, "desktop_app", Date.now(), { deviceId })
    await onNodeConnectionHello({
      orgId: visitor.orgId,
      userId: visitor.userId,
      deviceId,
      connId: entry!.connId,
      nodeCredential: real.data.credential,
      bindConnection: (id) => manager.markNodeConnection(ws, id),
    })

    try {
      const { sessionId, jobId } = await playToRequest()
      // The worst case: its lease long lapsed, and a variant that never started.
      await sql`UPDATE kernel.node_jobs SET lease_expires_at = now() - interval '1 hour'
                 WHERE id = ${jobId}`
      const before = { job: await job(jobId), session: await session(sessionId) }
      ws.frames.length = 0
      await sweepNodeLeases()
      await sweepSessionLeases()
      await sweepStaleNodeSessions()
      await sql`UPDATE kernel.node_jobs SET started_at = NULL WHERE id = ${jobId}`
      await sweepNodeLeases()
      expect(await job(jobId)).toEqual({ ...before.job })
      expect(await session(sessionId)).toEqual(before.session)
      expect(ws.frames.filter((f) => f.type === "node_job_offer")).toHaveLength(0)
    } finally {
      manager.removeConnection(ws)
    }
  })

  it("presence: the simulated node is online with no socket on a demo instance, offline elsewhere", async () => {
    const node = await ensureSimulatedNode(visitor.orgId, visitor.userId)
    expect((await liveDesktopConnections(visitor.orgId, visitor.userId)).has(node.id)).toBe(true)
    const { app } = await import("~/app")
    const me = await app.request("/api/nodes/me", {
      headers: { Authorization: `Bearer ${visitor.bearer}` },
    })
    const body = (await me.json()) as {
      data: { nodes: Array<{ id: string; online: boolean; simulated: boolean; name: string }> }
    }
    const shown = body.data.nodes.find((n) => n.id === node.id)
    expect(shown).toMatchObject({ online: true, simulated: true, name: "Demo laptop (recorded)" })
    DemoModeTestAccess.set(false)
    try {
      expect((await liveDesktopConnections(visitor.orgId, visitor.userId)).has(node.id)).toBe(false)
    } finally {
      DemoModeTestAccess.set(true)
    }
  })

  it("the dispatch tells the owner's open clients the recorded laptop is online (walk D25)", async () => {
    // The Sessions page is open before the dispatch creates the node: without
    // a frame its nodes list stays empty ("No computer") and the session reads
    // as paused, so the permission request never shows.
    const spy = spyOn(eventBusModule, "broadcastEphemeral")
    try {
      const started = await startReplay(
        { orgId: visitor.orgId, ownerUserId: visitor.userId },
        { launch: false },
      )
      const frames = spy.mock.calls
        .map((c) => c[0])
        .filter((e) => e.app === "kernel" && e.entity === "node")
      expect(frames.map((e) => e.data)).toContainEqual({
        ownerUserId: visitor.userId,
        nodeId: started.nodeId,
        change: "presence",
        online: true,
      })
      expect(frames.every((e) => e.orgId === visitor.orgId)).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  it("no job of anyone else is ever created for the simulated node", async () => {
    const node = await ensureSimulatedNode(visitor.orgId, visitor.userId)
    const [agent] = await sql<{ id: string }[]>`
      SELECT id FROM kernel.agents WHERE org_id = ${visitor.orgId} LIMIT 1`
    await expect(
      createNodeJob({
        orgId: visitor.orgId,
        ownerUserId: visitor.userId,
        agentId: agent.id,
        threadId: null,
        source: "app",
        prompt: "anything",
        sourceRequiredScopes: [],
        targetNodeId: node.id,
      }),
    ).rejects.toBeInstanceOf(NodeJobRefusedError)
    const jobs = await sql`SELECT 1 FROM kernel.node_jobs WHERE target_node_id = ${node.id}`
    expect(jobs).toHaveLength(0)
  })

  it("a regular org: the replay is refused and writes nothing", async () => {
    const count = async () =>
      (
        await sql<Array<{ n: number }>>`
          SELECT (SELECT count(*) FROM kernel.nodes WHERE org_id = ${regular.orgId})
               + (SELECT count(*) FROM kernel.node_jobs WHERE org_id = ${regular.orgId})
               + (SELECT count(*) FROM kernel.node_sessions WHERE org_id = ${regular.orgId}) AS n`
      )[0].n
    const before = Number(await count())
    await expect(
      startReplay({ orgId: regular.orgId, ownerUserId: regular.userId }, { launch: false }),
    ).rejects.toBeInstanceOf(ReplayRefusedError)
    await expect(ensureSimulatedNode(regular.orgId, regular.userId)).rejects.toBeInstanceOf(
      ReplayRefusedError,
    )
    expect(Number(await count())).toBe(before)
  })

  it("appendReplayEvents refuses a session on a real node, and a regular org", async () => {
    const deviceId = `d.${crypto.randomUUID()}`
    const { app } = await import("~/app")
    const enabled = await app.request("/api/nodes", {
      method: "POST",
      headers: { Authorization: `Bearer ${visitor.bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId, name: "Studio Mac" }),
    })
    const real = (await enabled.json()) as { data: { node: { id: string } } }
    const [agent] = await sql<{ id: string }[]>`
      SELECT id FROM kernel.agents WHERE org_id = ${visitor.orgId} LIMIT 1`
    const created = await createNodeJob({
      orgId: visitor.orgId,
      ownerUserId: visitor.userId,
      agentId: agent.id,
      threadId: null,
      source: "app",
      prompt: "Fix it",
      sourceRequiredScopes: [],
      targetNodeId: real.data.node.id,
      session: { source: "app", configKind: "owner", model: "m", level: "strict" },
    })
    await sql`UPDATE kernel.node_sessions SET node_id = ${real.data.node.id}
               WHERE id = ${created.sessionId as string}`
    const append = {
      origin: "node" as const,
      events: [
        { at: new Date().toISOString(), type: "assistant_text" as const, payload: { text: "x" } },
      ],
    }
    await expect(
      appendReplayEvents(visitor.orgId, created.sessionId as string, append),
    ).rejects.toBeInstanceOf(ReplayAppendRefusedError)
    await expect(
      appendReplayEvents(regular.orgId, created.sessionId as string, append),
    ).rejects.toBeInstanceOf(ReplayAppendRefusedError)
    const log = await events(created.sessionId as string)
    expect(log.some((e) => e.type === "assistant_text")).toBe(false)
  })

  it("the replay spawns nothing: no process API in its module", () => {
    const dir = import.meta.dir
    for (const file of readdirSync(dir).filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
    )) {
      const text = readFileSync(join(dir, file), "utf8")
      expect(text).not.toMatch(/child_process|Bun\.spawn|\bexecSync\b|\bspawnSync\b/)
    }
  })
})
