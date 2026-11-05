// SPDX-License-Identifier: FSL-1.1-ALv2
// One live state across the cell (S5, A12) and once-only event handlers
// (S24, A5), over real `src/index.ts` processes: two `api` replicas and one
// `worker` on one worker's schemas and Redis prefix (createRoleCell).
//
// S5:  a user with a tab on each replica stays online while one tab is open;
//      the per-user agent stream cap counts the streams on both replicas.
// A12: SIGKILL one replica: its user goes offline and its stream slots free.
//      Measured with the spawn env's 3 s instance TTL and 1 s sweep
//      (packages/test-helpers/src/worker-env.ts). The production bound (45 s)
//      is arithmetic: LIVE_INSTANCE_TTL_MS (30 s) plus the sweep interval; it
//      is not measured here.
// S24: an event published once runs each once handler once in the cell (an
//      event routine's tick, an app's manifest subscription); a per-replica
//      handler (closing a user's sockets on a permission change) runs on
//      every replica.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import {
  api,
  bootstrap,
  type CellFrame,
  type CellSocket,
  createRoleCell,
  createUserWithScopes,
  jsonLogLines,
  login,
  openCellSocket,
  type RoleCell,
  type RoleProcess,
  scriptTurnOn,
} from "@liaison/test-helpers"
import { Queue } from "bullmq"
import IORedis from "ioredis"

// The parallel runner gives this file a private worker id; a plain `bun test`
// run takes one clear of the lanes (0-3), the helper tests (50-61, 99), the
// other cell scenarios (70, 71) and the cell clients' own test (72).
const CELL_WORKER = process.env.WORKER_ID != null ? Number(process.env.WORKER_ID) : 73
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379"
const STREAM_CAP = 2
/** The A12 budget the test holds the cell to (the production bound; see the header). */
const A12_BUDGET_MS = 45_000

interface ReadyzBody {
  instanceId: string
}

async function readyz(p: RoleProcess): Promise<ReadyzBody> {
  const res = await fetch(`${p.url}/readyz`)
  return (await res.json()) as ReadyzBody
}

async function until<T>(
  probe: () => Promise<T | undefined>,
  timeoutMs: number,
  everyMs = 250,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const v = await probe().catch(() => undefined)
    if (v !== undefined) return v
    await Bun.sleep(everyMs)
  }
  return undefined
}

/** A `presence:update` frame for `userId` with `status`. */
function presenceFrame(userId: string, status: string): (f: CellFrame) => boolean {
  return (f) => {
    if (f.type !== "event") return false
    const p = f.payload as { entity?: unknown; action?: unknown; data?: unknown } | undefined
    if (p?.entity !== "presence" || p.action !== "update") return false
    const d = p.data as { userId?: unknown; status?: unknown } | undefined
    return d?.userId === userId && d.status === status
  }
}

/** A raw socket whose close code the test reads (the cell clients do not keep it). */
interface RawSocket {
  closed: Promise<{ code: number; reason: string }>
  close(): void
}

async function openRawSocket(proc: RoleProcess, token: string): Promise<RawSocket> {
  const t = await api(proc.url, "/api/auth/ws-ticket", { method: "POST", token })
  if (t.status !== 200) throw new Error(`ws-ticket on :${proc.port} answered ${t.status}`)
  const ticket = String(t.body.data.ticket)
  const ws = new WebSocket(
    `${proc.url.replace(/^http/, "ws")}/ws?ticket=${encodeURIComponent(ticket)}`,
  )
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.addEventListener("close", (e) => resolve({ code: e.code, reason: e.reason }))
  })
  const synced = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no presence_sync from :${proc.port}`)), 10_000)
    ws.addEventListener("message", (e) => {
      if (String(e.data).includes('"presence_sync"')) {
        clearTimeout(timer)
        resolve()
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve())
    ws.addEventListener("error", () => reject(new Error(`socket to :${proc.port} failed`)))
  })
  ws.send(JSON.stringify({ type: "hello", lastEventId: 0 }))
  await synced
  return { closed, close: () => ws.close() }
}

/** One agent chat request held open: its status, and a way to end it. */
interface HeldStream {
  status: number
  /** Resolves once the response body has ended (or was aborted). */
  ended: Promise<void>
  abort(): void
}

async function startChat(proc: RoleProcess, token: string, threadId: string): Promise<HeldStream> {
  const ctrl = new AbortController()
  const res = await fetch(`${proc.url}/api/agent/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ threadId, content: "hold this stream open" }),
    signal: ctrl.signal,
  })
  const ended = (async () => {
    if (res.status !== 200 || !res.body) {
      await res.text().catch(() => "")
      return
    }
    const reader = res.body.getReader()
    try {
      while (!(await reader.read()).done) {
        /* drain */
      }
    } catch {
      /* aborted, or the process died */
    }
  })()
  return { status: res.status, ended, abort: () => ctrl.abort() }
}

describe("S5 + S24: one live state across 2 api + 1 worker", () => {
  let cell: RoleCell
  let apiA: RoleProcess
  let apiB: RoleProcess
  let worker: RoleProcess
  let ks: string
  let orgId: string
  let uToken: string
  let uId: string
  let oToken: string
  let connection: IORedis
  let agentQueue: Queue

  /** An agent chat thread U owns. */
  async function chatThread(): Promise<string> {
    const threadId = crypto.randomUUID()
    await cell.db.sql.unsafe(
      `INSERT INTO ${ks}.threads (id, org_id, handle, type, created_by) VALUES ($1, $2, $3, 'agent_chat', $4)`,
      [threadId, orgId, `agent-${threadId.slice(0, 8)}`, uId],
    )
    await cell.db.sql.unsafe(
      `INSERT INTO ${ks}.thread_participants (thread_id, user_id, org_id) VALUES ($1, $2, $3)`,
      [threadId, uId, orgId],
    )
    return threadId
  }

  /** A held stream on `proc`: a scripted slow turn in a fresh thread. */
  async function slowStream(proc: RoleProcess, delayMs: number): Promise<HeldStream> {
    const threadId = await chatThread()
    await scriptTurnOn(proc, threadId, [{ delayMs, text: "slow reply" }])
    return startChat(proc, uToken, threadId)
  }

  /** Sum of a test-sink counter family (LIAISON_TEST_EVENT_SINK, event-bus.ts). */
  async function sinkCount(pattern: string): Promise<{ keys: number; total: number }> {
    const keys = await cell.redis.redis.keys(`${cell.redisPrefix}${pattern}`)
    let total = 0
    for (const k of keys) total += Number((await cell.redis.redis.get(k)) ?? 0)
    return { keys: keys.length, total }
  }

  /** The routine-tick jobs enqueued for `routineId` by an event, in any state. */
  async function routineEventJobs(routineId: string): Promise<number> {
    const jobs = await agentQueue.getJobs([
      "waiting",
      "prioritized",
      "delayed",
      "active",
      "completed",
      "failed",
    ])
    return jobs.filter(
      (j) =>
        j.name === "routine-tick" &&
        (j.data as { routineId?: unknown }).routineId === routineId &&
        String(j.opts.deduplication?.id ?? "").startsWith(`routine-event:${routineId}:`),
    ).length
  }

  beforeAll(async () => {
    cell = await createRoleCell(CELL_WORKER, ["api", "api", "worker"], {
      serverEnv: {
        LIAISON_VERSION: "p2-cell",
        AGENT_MAX_CONCURRENT_STREAMS: String(STREAM_CAP),
        LIAISON_TEST_EVENT_SINK: "1",
      },
    })
    ;[apiA, apiB, worker] = cell.processes as [RoleProcess, RoleProcess, RoleProcess]
    ks = `"${cell.schemaPrefix}kernel"`
    const boot = await bootstrap(apiA.url)
    uToken = boot.accessToken
    uId = boot.userId
    orgId = boot.orgId
    const o = await createUserWithScopes(apiA.url, cell.db.sql, uToken, orgId, {
      schemaPrefix: cell.schemaPrefix,
      name: "Observer",
    })
    oToken = o.token
    connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null })
    agentQueue = new Queue("kernel-agent", { connection, prefix: `${cell.redisPrefix}bull` })
  }, 240_000)

  afterAll(async () => {
    await agentQueue?.close()
    connection?.disconnect()
    await cell?.teardown()
  }, 60_000)

  it("S5: a user with a tab on each replica stays online when one tab closes", async () => {
    const uOnA = await openCellSocket(apiA, uToken)
    const uOnB = await openCellSocket(apiB, uToken)
    // O watches from both replicas: a replica's own departure broadcast reaches
    // its own sockets first, so each close is watched where it happens.
    const oOnA = await openCellSocket(apiA, oToken)
    const oOnB = await openCellSocket(apiB, oToken)
    let oAgain: CellSocket | undefined
    try {
      await uOnA.close()
      // Over 2 s, no departure on either replica: U still has a tab on B.
      const offlineWithin = async (s: CellSocket, ms: number) => {
        try {
          await s.waitFor(presenceFrame(uId, "offline"), ms)
          return true
        } catch {
          return false
        }
      }
      const [seenOnA, seenOnB] = await Promise.all([
        offlineWithin(oOnA, 2_000),
        offlineWithin(oOnB, 2_000),
      ])
      console.log(`[S5] after U's A tab closed: offline seen on A=${seenOnA}, on B=${seenOnB}`)
      expect(seenOnA).toBe(false)
      expect(seenOnB).toBe(false)

      // O's re-hello, on the replica U just left: its presence_sync lists U.
      oAgain = await openCellSocket(apiA, oToken)
      const sync = oAgain.frames.find((f) => f.type === "presence_sync")
      const users = (sync?.users ?? {}) as Record<string, string>
      expect(users[uId]).toBe("online")

      // U's last tab closes: now O hears U leave.
      await uOnB.close()
      const offline = await oOnB.waitFor(presenceFrame(uId, "offline"), 5_000)
      expect(offline.type).toBe("event")
    } finally {
      await uOnA.close()
      await uOnB.close()
      await oOnA.close()
      await oAgain?.close()
      await oOnB.close()
    }
  }, 60_000)

  it("S5: the stream cap counts across both replicas", async () => {
    const onA = await slowStream(apiA, 5_000)
    const onB = await slowStream(apiB, 5_000)
    try {
      expect(onA.status).toBe(200)
      expect(onB.status).toBe(200)
      // A third stream, on A: A alone holds one, but the cell holds two.
      const third = await startChat(apiA, uToken, await chatThread())
      console.log(`[S5] streams: A=${onA.status} B=${onB.status} third on A=${third.status}`)
      expect(third.status).toBe(429)
      await third.ended
    } finally {
      await Promise.all([onA.ended, onB.ended])
    }
  }, 60_000)

  it("S24: one published event runs each once handler exactly once", async () => {
    const created = await api(apiA.url, "/api/apps/run-tool", {
      method: "POST",
      token: uToken,
      body: {
        toolName: "kernel:create_routine",
        params: {
          name: `cell-evt-${Date.now()}`,
          description: "Fire a tick when a contact is created.",
          kind: "event",
          event: "kernel:contact:create",
          prompt: "A contact was created; acknowledge it briefly.",
          scopes: ["kernel:threads:read"],
          visibility: "personal",
        },
      },
    })
    expect(created.status).toBe(200)
    const routineId = String(created.body.data.routine.id)

    // Every process holds the subscription (T4) before the event is published.
    const subscribed = (p: RoleProcess) =>
      jsonLogLines(p).some((l) => l.msg === "event-routine subscribed" && l.routineId === routineId)
    const all = await until(
      async () => ([apiA, apiB, worker].every(subscribed) ? true : undefined),
      30_000,
    )
    expect(all).toBe(true)

    const contact = await api(apiB.url, "/api/contacts/resolve", {
      method: "POST",
      token: uToken,
      body: { email: `cell-${Date.now()}@example.com`, name: "Cell Contact" },
    })
    expect(contact.status).toBe(200)

    const pattern = `test:event-sink:event-routine:${routineId}:*`
    const first = await until(async () => {
      const s = await sinkCount(pattern)
      return s.total >= 1 ? s : undefined
    }, 30_000)
    expect(first).toBeDefined()
    const firstJob = await until(
      async () => ((await routineEventJobs(routineId)) >= 1 ? true : undefined),
      30_000,
    )
    expect(firstJob).toBe(true)
    // Settle: a peer's late copy of the event would land within this window.
    await Bun.sleep(3_000)
    const sink = await sinkCount(pattern)
    const jobs = await routineEventJobs(routineId)
    console.log(`[S24] event routine: sink=${sink.total} (keys ${sink.keys}), tick jobs=${jobs}`)
    expect(sink).toEqual({ keys: 1, total: 1 })
    expect(jobs).toBe(1)
  }, 90_000)

  it("S24: an app's manifest subscription writes one effect row per event", async () => {
    // test-support/apps/test: `items:created` → `onItemCreated` inserts one
    // `event_log` row per call.
    const item = await api(apiB.url, "/api/apps/tools/test:createItem", {
      method: "POST",
      token: uToken,
      body: { title: "Cell once item", team: "alpha" },
    })
    expect(item.status).toBe(200)
    const itemId = String(item.body.data.id)

    const effectRows = async () => {
      const rows = await cell.db.sql.unsafe(
        `SELECT count(*)::int AS n FROM "${cell.schemaPrefix}app_test".event_log WHERE entity_id = $1`,
        [itemId],
      )
      return Number(rows[0]?.n ?? 0)
    }
    const first = await until(async () => ((await effectRows()) >= 1 ? true : undefined), 30_000)
    expect(first).toBe(true)
    await Bun.sleep(3_000)
    const rows = await effectRows()
    const sink = await sinkCount(
      `test:event-sink:app-subscription:test:test:items:created:${itemId}`,
    )
    console.log(`[S24] app subscription: event_log rows=${rows}, sink=${sink.total}`)
    expect(rows).toBe(1)
    expect(sink).toEqual({ keys: 1, total: 1 })
  }, 60_000)

  it("S24: a per-replica handler still runs on every replica", async () => {
    const onA = await openRawSocket(apiA, uToken)
    const onB = await openRawSocket(apiB, uToken)
    try {
      const role = await api(apiA.url, "/api/admin/roles", {
        method: "POST",
        token: uToken,
        body: { name: `cell-role-${Date.now()}` },
      })
      expect(role.status).toBeLessThan(300)
      const roleId = String(role.body.data.id)
      const assigned = await api(apiA.url, `/api/admin/roles/${roleId}/users`, {
        method: "POST",
        token: uToken,
        body: { userId: uId },
      })
      expect(assigned.status).toBe(201)

      const timeout = <T>(p: Promise<T>) =>
        Promise.race([
          p,
          Bun.sleep(15_000).then(() => ({ code: -1, reason: "no close within 15 s" })),
        ])
      const [a, b] = await Promise.all([timeout(onA.closed), timeout(onB.closed)])
      console.log(`[S24] permission change: A closed ${a.code}, B closed ${b.code}`)
      expect(a.code).toBe(4010)
      expect(b.code).toBe(4010)
    } finally {
      onA.close()
      onB.close()
    }
  }, 60_000)

  it("S5 (A12): after SIGKILL of a replica its user is offline and its slots free", async () => {
    // The role change above bumped U's permission version: sign in again.
    uToken = (await login(apiB.url, "admin@e2e.test", "SecurePass1!")).accessToken
    const uOnA = await openCellSocket(apiA, uToken)
    const oOnB: CellSocket = await openCellSocket(apiB, oToken)
    const held: HeldStream[] = []
    try {
      // U's two slots: one on A, one on B. The cap is reached cell-wide.
      const onA = await slowStream(apiA, 5_000)
      expect(onA.status).toBe(200)
      held.push(onA)
      const firstOnB = await slowStream(apiB, 5_000)
      expect(firstOnB.status).toBe(200)
      held.push(firstOnB)
      const refused = await startChat(apiB, uToken, await chatThread())
      expect(refused.status).toBe(429)
      await refused.ended

      const killedId = (await readyz(apiA)).instanceId
      const t0 = Date.now()
      await apiA.kill(9)
      void uOnA.close()

      // O hears U leave (the leader's sweep of A).
      const offline = oOnB
        .waitFor(presenceFrame(uId, "offline"), A12_BUDGET_MS)
        .then(() => Date.now() - t0)
        .catch(() => undefined)

      // Two concurrent streams on B are admitted once A's slot stops counting:
      // keep one held on B and probe for a second beside it.
      const probeThread = await chatThread()
      await scriptTurnOn(apiB, probeThread, [{ delayMs: 5_000, text: "after the kill" }])
      let keeper: HeldStream | undefined
      let keeperEnded = true
      const freedAt = await until(async () => {
        if (keeperEnded) {
          keeper = await slowStream(apiB, 5_000)
          held.push(keeper)
          if (keeper.status !== 200) return undefined
          keeperEnded = false
          void keeper.ended.then(() => {
            keeperEnded = true
          })
        }
        const s = await startChat(apiB, uToken, probeThread)
        if (s.status === 200 && !keeperEnded) {
          held.push(s)
          return Date.now() - t0
        }
        held.push(s)
        return undefined
      }, A12_BUDGET_MS)
      const offlineAt = await offline

      // A fresh hello on B no longer lists U as online.
      const oAgain = await openCellSocket(apiB, oToken)
      const sync = oAgain.frames.find((f) => f.type === "presence_sync")
      const users = (sync?.users ?? {}) as Record<string, string>
      await oAgain.close()
      const fmt = (ms: number | undefined) =>
        ms === undefined ? "never" : `${(ms / 1000).toFixed(2)} s`
      console.log(
        `[A12] SIGKILL of api A (${killedId}), 3 s instance TTL, 1 s sweep: offline frame to O at ${fmt(offlineAt)}, two streams on B at ${fmt(freedAt)}, presence_sync U=${users[uId] ?? "absent"}`,
      )
      expect(freedAt).toBeDefined()
      expect(freedAt ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(A12_BUDGET_MS)
      expect(users[uId] === "online").toBe(false)
      // The sweep removed A's entries from the cell state.
      const slotHash = await cell.redis.redis.hgetall(`${cell.redisPrefix}agent:streams:${uId}`)
      expect(Object.keys(slotHash)).not.toContain(killedId)
      expect(offlineAt).toBeDefined()
      expect(offlineAt ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(A12_BUDGET_MS)
    } finally {
      for (const s of held) s.abort()
      await Promise.all(held.map((s) => s.ended))
      await oOnB.close()
    }
  }, 150_000)
})
