// SPDX-License-Identifier: FSL-1.1-ALv2
// A live turn followed from any replica (S6, S28), a mailbox answer and the
// cancels that cross processes (S7 as amended by A30 and A31), and a retried
// post applied once across replicas (A27), over real `src/index.ts` processes:
// two `api` replicas and one `worker` on one worker's schemas and Redis prefix
// (createRoleCell).
//
// Turns run on the scripted model provider (LIAISON_MODEL_PROVIDER=scripted,
// the spawn env): a thread's script is registered on the process that runs
// the turn (scriptTurnOn), and the no-thread key is scripted on both api
// replicas before anything runs, so no model call in this file reaches a
// provider. A posted message in an agent chat runs its turn in the process
// that took the post.
//
// S6:  a client on B sees a turn running on A: the snapshot, then the tail;
//      a socket that reconnects to the other replica mid-turn sees the turn so far.
// S28: the frames B delivers for A's turn carry strictly increasing `seq` and
//      the same item ids A delivers.
// S7:  a mailbox answer posted to B settles the request minted on A (A30: a
//      signed internal call, never Redis); a newer request on B waits for the
//      earlier turn running on A (the demo's supersede wait); a sub-run cancel
//      issued on B stops the sub-run running on A (A31).
// A27: a send retried on the other replica is applied once.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import {
  api,
  bootstrap,
  type CellFrame,
  type CellSocket,
  createRoleCell,
  openCellSocket,
  type RoleCell,
  type RoleProcess,
  scriptTurnOn,
} from "@liaison/test-helpers"

// The parallel runner gives this file a private worker id; a plain `bun test`
// run takes one clear of the lanes (0-3), the helper tests (50-61, 99), the
// other cell scenarios (70, 71, 73) and the cell clients' own test (72).
const CELL_WORKER = process.env.WORKER_ID != null ? Number(process.env.WORKER_ID) : 74

/** A model step boundary: a cheap read tool, so the turn comes back for its next step. */
const STEP_TOOL = { name: "kernel__tool_search", args: { query: "contacts" } }

interface StreamData {
  threadId?: unknown
  turnId?: unknown
  agentId?: unknown
  seq?: unknown
  itemId?: unknown
  itemKind?: unknown
  delta?: unknown
}

interface StreamFrame {
  action: string
  data: StreamData
}

/** The `agent_stream` frame inside a socket frame, or null. */
function asStreamFrame(f: CellFrame): StreamFrame | null {
  if (f.type !== "event") return null
  const p = f.payload as { entity?: unknown; action?: unknown; data?: unknown } | undefined
  if (p?.entity !== "agent_stream" || typeof p.action !== "string") return null
  const data = (p.data ?? {}) as StreamData
  return { action: p.action, data }
}

/** Every `agent_stream` frame of `threadId` the socket received so far, in order. */
function streamFrames(s: CellSocket, threadId: string): StreamFrame[] {
  const out: StreamFrame[] = []
  for (const f of s.frames) {
    const sf = asStreamFrame(f)
    if (sf && sf.data.threadId === threadId) out.push(sf)
  }
  return out
}

function streamFrame(
  threadId: string,
  action: string,
  extra?: (d: StreamData) => boolean,
): (f: CellFrame) => boolean {
  return (f) => {
    const sf = asStreamFrame(f)
    return (
      sf !== null &&
      sf.data.threadId === threadId &&
      sf.action === action &&
      (extra ? extra(sf.data) : true)
    )
  }
}

interface StreamState {
  active: boolean
  content?: string
  seq?: number
  agentId?: string | null
  turnId?: string | null
  timeline?: Array<{ itemId?: unknown; kind?: unknown }>
}

async function until<T>(
  probe: () => Promise<T | undefined>,
  timeoutMs: number,
  everyMs = 100,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const v = await probe().catch(() => undefined)
    if (v !== undefined) return v
    await Bun.sleep(everyMs)
  }
  return undefined
}

describe("S6 + S7 + A27: live turns across 2 api + 1 worker", () => {
  let cell: RoleCell
  let apiA: RoleProcess
  let apiB: RoleProcess
  let ks: string
  let orgId: string
  let uToken: string
  let uId: string

  async function thread(type: "agent_chat" | "thread"): Promise<string> {
    const threadId = crypto.randomUUID()
    await cell.db.sql.unsafe(
      `INSERT INTO ${ks}.threads (id, org_id, handle, type, created_by) VALUES ($1, $2, $3, $4, $5)`,
      [threadId, orgId, `cell-${threadId.slice(0, 8)}`, type, uId],
    )
    await cell.db.sql.unsafe(
      `INSERT INTO ${ks}.thread_participants (thread_id, user_id, org_id) VALUES ($1, $2, $3)`,
      [threadId, uId, orgId],
    )
    return threadId
  }

  async function post(
    proc: RoleProcess,
    threadId: string,
    content: string,
    correlationId?: string,
  ): Promise<{ status: number; id: string }> {
    const res = await api(proc.url, `/api/threads/${threadId}/messages`, {
      method: "POST",
      token: uToken,
      body: { content, ...(correlationId ? { correlationId } : {}) },
    })
    return { status: res.status, id: String(res.body?.data?.id ?? "") }
  }

  async function streamState(proc: RoleProcess, threadId: string): Promise<StreamState> {
    const res = await api(proc.url, `/api/agent/stream-state/${threadId}`, { token: uToken })
    if (res.status !== 200) throw new Error(`stream-state on :${proc.port} answered ${res.status}`)
    return res.body.data as StreamState
  }

  /** Script the no-thread key on `proc` (auto-title, a sub-run): never a provider call. */
  async function scriptNoThread(proc: RoleProcess, steps: unknown[]): Promise<void> {
    const res = await api(proc.url, "/api/_test/agent-script", {
      method: "POST",
      body: { steps },
    })
    expect(res.status).toBe(200)
    expect(res.body.data.providerActive).toBe(true)
  }

  beforeAll(async () => {
    cell = await createRoleCell(CELL_WORKER, ["api", "api", "worker"], {
      serverEnv: { LIAISON_VERSION: "p2-cell-turns" },
    })
    ;[apiA, apiB] = cell.processes as [RoleProcess, RoleProcess, RoleProcess]
    ks = `"${cell.schemaPrefix}kernel"`
    const boot = await bootstrap(apiA.url)
    uToken = boot.accessToken
    uId = boot.userId
    orgId = boot.orgId
    await scriptNoThread(apiA, [])
    await scriptNoThread(apiB, [])
  }, 240_000)

  afterAll(async () => {
    await cell?.teardown()
  }, 60_000)

  it("S6: a client on B sees a turn running on A, snapshot then tail (S28: ordered, same items)", async () => {
    const threadId = await thread("agent_chat")
    await scriptTurnOn(apiA, threadId, [
      { text: "one", toolCalls: [STEP_TOOL] },
      { delayMs: 3_000, text: "two", toolCalls: [STEP_TOOL] },
      { delayMs: 3_000, text: "end" },
    ])
    const onA = await openCellSocket(apiA, uToken)
    const onB = await openCellSocket(apiB, uToken)
    try {
      const sent = await post(apiA, threadId, "follow me from the other replica")
      expect(sent.status).toBe(200)

      // B's snapshot of the turn running on A.
      const snap = await until(async () => {
        const s = await streamState(apiB, threadId)
        return s.active && s.content?.includes("one") && typeof s.seq === "number" ? s : undefined
      }, 15_000)
      console.log(
        `[S6] B stream-state while A runs: active=${snap?.active} seq=${snap?.seq} content=${JSON.stringify(snap?.content)}`,
      )
      expect(snap?.active).toBe(true)
      const snapSeq = snap?.seq ?? Number.POSITIVE_INFINITY

      // Then the tail on B's socket: delta "two" past the snapshot, then done.
      const two = await onB.waitFor(
        streamFrame(threadId, "delta", (d) => String(d.delta ?? "").includes("two")),
        15_000,
      )
      expect(Number(asStreamFrame(two)?.data.seq)).toBeGreaterThan(snapSeq)
      await onB.waitFor(streamFrame(threadId, "done"), 15_000)
      await onA.waitFor(streamFrame(threadId, "done"), 15_000)

      // B's stream-state goes inactive once the turn ended.
      const idle = await until(async () => {
        const s = await streamState(apiB, threadId)
        return s.active ? undefined : s
      }, 10_000)
      expect(idle?.active).toBe(false)

      // S28: B delivers A's turn in seq order, with the item ids A delivers.
      const key = (f: StreamFrame) =>
        `${String(f.data.seq)}:${f.action}:${String(f.data.itemId ?? "-")}:${String(f.data.itemKind ?? "-")}`
      const onBFrames = streamFrames(onB, threadId)
      const onAFrames = streamFrames(onA, threadId)
      console.log(`[S28] B frames: ${onBFrames.map(key).join(" ")}`)
      const seqs = onBFrames.map((f) => Number(f.data.seq))
      expect(seqs.length).toBeGreaterThan(4)
      for (let i = 1; i < seqs.length; i++) {
        expect(seqs[i]).toBeGreaterThan(seqs[i - 1] ?? Number.POSITIVE_INFINITY)
      }
      expect(onBFrames.map(key)).toEqual(onAFrames.map(key))
      // An item id names one item: one kind, and a tool call's result shares its call's id.
      const kindOf = new Map<string, string>()
      for (const f of onBFrames) {
        if (f.data.itemId === undefined) continue
        const id = String(f.data.itemId)
        const kind = String(f.data.itemKind)
        expect(kindOf.get(id) ?? kind).toBe(kind)
        kindOf.set(id, kind)
      }
      // A text run is one item: "one" (step 1) and "two" (step 2) are split by
      // step 2's tool call, so they are two items; "end" follows only a tool
      // result, which opens no item, so it extends "two"'s.
      const itemOfText = (t: string) =>
        onBFrames.find((f) => f.action === "delta" && String(f.data.delta).includes(t))?.data.itemId
      expect(String(itemOfText("one"))).toMatch(/^t\d+$/)
      expect(String(itemOfText("two"))).toMatch(/^t\d+$/)
      expect(itemOfText("two")).not.toBe(itemOfText("one"))
      expect(itemOfText("end")).toBe(itemOfText("two"))
      // The snapshot's items are the frames' items, under the same ids.
      for (const entry of snap?.timeline ?? []) {
        if (entry.itemId === undefined) continue
        expect(kindOf.has(String(entry.itemId))).toBe(true)
      }
    } finally {
      await onA.close()
      await onB.close()
    }
  }, 60_000)

  it("S6: a client that reconnects to the other replica mid-turn sees the turn so far", async () => {
    const threadId = await thread("agent_chat")
    await scriptTurnOn(apiA, threadId, [
      { text: "first part", toolCalls: [STEP_TOOL] },
      { delayMs: 3_000, text: "second part", toolCalls: [STEP_TOOL] },
      { delayMs: 3_000, text: "last part" },
    ])
    const onA = await openCellSocket(apiA, uToken)
    let onB: CellSocket | undefined
    try {
      const sent = await post(apiA, threadId, "reconnect mid-turn")
      expect(sent.status).toBe(200)
      await onA.waitFor(streamFrame(threadId, "delta"), 15_000)
      const seenOnA = streamFrames(onA, threadId)
      await onA.close()
      const lastSeen = Math.max(...seenOnA.map((f) => Number(f.data.seq)))
      const textSoFar = seenOnA
        .filter((f) => f.action === "delta")
        .map((f) => String(f.data.delta))
        .join("")

      onB = await openCellSocket(apiB, uToken)
      const resumed = await streamState(apiB, threadId)
      console.log(
        `[S6] reconnect: A had seq ${lastSeen} text ${JSON.stringify(textSoFar)}; B snapshot active=${resumed.active} seq=${resumed.seq} content=${JSON.stringify(resumed.content)}`,
      )
      expect(resumed.active).toBe(true)
      expect(textSoFar.length).toBeGreaterThan(0)
      expect(resumed.content ?? "").toContain(textSoFar)
      expect(resumed.seq ?? 0).toBeGreaterThanOrEqual(lastSeen)
      // The new socket on B follows the rest of it.
      await onB.waitFor(
        streamFrame(threadId, "delta", (d) => String(d.delta ?? "").includes("last part")),
        15_000,
      )
      await onB.waitFor(streamFrame(threadId, "done"), 15_000)
    } finally {
      await onA.close()
      await onB?.close()
    }
  }, 60_000)

  it("S7: a mailbox answer posted to B settles the request minted on A", async () => {
    const minted = await api(apiA.url, "/api/_test/live/mailbox-request", {
      method: "POST",
      token: uToken,
    })
    expect(minted.status).toBe(200)
    const requestId = String(minted.body.data.requestId)
    const turnNonce = String(minted.body.data.turnNonce)

    const answered = await api(apiB.url, `/api/agent/mailbox-plaintext/${requestId}`, {
      method: "POST",
      token: uToken,
      body: { turnNonce, items: [{ messageId: "m1", textBody: "cell plaintext" }] },
    })
    console.log(`[S7] answer to B for A's request: ${answered.status}`)
    expect(answered.status).toBe(200)

    const settled = await until(async () => {
      const r = await api(apiA.url, `/api/_test/live/mailbox-request/${requestId}`, {
        token: uToken,
      })
      return r.body?.data?.settled === true ? r.body.data : undefined
    }, 5_000)
    expect(settled?.outcome?.kind).toBe("plaintext")
    expect(settled?.outcome?.items?.[0]?.textBody).toBe("cell plaintext")
  }, 30_000)

  it("S7 (A31): a newer request on B waits for the earlier turn running on A", async () => {
    const threadId = await thread("agent_chat")
    await scriptTurnOn(apiA, threadId, [
      { text: "earlier", toolCalls: [STEP_TOOL] },
      { delayMs: 4_000, text: "earlier, done" },
    ])
    const onB = await openCellSocket(apiB, uToken)
    try {
      const sent = await post(apiA, threadId, "an earlier request")
      expect(sent.status).toBe(200)
      const live = await until(async () => {
        const s = await streamState(apiB, threadId)
        return s.active && s.content?.includes("earlier") ? s : undefined
      }, 15_000)
      expect(live?.active).toBe(true)

      let doneAt = 0
      const done = onB.waitFor(streamFrame(threadId, "done"), 20_000).then(() => {
        doneAt = Date.now()
      })
      const wait = await api(apiB.url, "/api/_test/live/supersede-wait", {
        method: "POST",
        token: uToken,
        body: { threadId, agentId: live?.agentId ?? null, timeoutMs: 20_000 },
      })
      await done
      const { outcome, waitedMs, endedAt } = wait.body.data as {
        outcome: string
        waitedMs: number
        endedAt: number
      }
      console.log(
        `[S7] supersede wait on B: ${outcome} after ${waitedMs} ms; A's done frame ${doneAt - endedAt} ms after the wait ended`,
      )
      expect(wait.status).toBe(200)
      expect(outcome).toBe("ended")
      // It waited for A's slow step, and ended with A's turn (not before it).
      expect(waitedMs).toBeGreaterThan(1_500)
      expect(Math.abs(doneAt - endedAt)).toBeLessThan(2_000)
      // With A's turn over, nothing is left to wait for.
      const again = await api(apiB.url, "/api/_test/live/supersede-wait", {
        method: "POST",
        token: uToken,
        body: { threadId, agentId: live?.agentId ?? null, timeoutMs: 5_000 },
      })
      expect(again.body.data.outcome).toBe("none")
    } finally {
      await onB.close()
    }
  }, 60_000)

  it("A27: a send retried on the other replica is applied once", async () => {
    const threadId = await thread("thread")
    const correlationId = `cell-${crypto.randomUUID()}`
    const first = await post(apiA, threadId, "sent once, retried on B", correlationId)
    const retry = await post(apiB, threadId, "sent once, retried on B", correlationId)
    const rows = await cell.db.sql.unsafe(
      `SELECT count(*)::int AS n FROM ${ks}.messages WHERE thread_id = $1 AND content = $2`,
      [threadId, "sent once, retried on B"],
    )
    console.log(
      `[A27] A=${first.status} ${first.id}, B=${retry.status} ${retry.id}, rows=${rows[0]?.n}`,
    )
    expect(first.status).toBe(200)
    expect(retry.status).toBe(200)
    expect(retry.id).toBe(first.id)
    expect(Number(rows[0]?.n)).toBe(1)
  }, 30_000)

  // Last: it scripts A's no-thread key, which an auto-title on A would also read.
  it("S7 (A31): a sub-run cancel issued on B stops the sub-run running on A", async () => {
    const started = await api(apiA.url, "/api/_test/live/sub-run", {
      method: "POST",
      token: uToken,
      body: { steps: [{ delayMs: 5_000, text: "a slow sub-run" }] },
    })
    expect(started.status).toBe(200)
    const runId = String(started.body.data.runId)
    const hiddenThreadId = String(started.body.data.hiddenThreadId)
    const status = async () => {
      const rows = await cell.db.sql.unsafe(`SELECT status FROM ${ks}.agent_runs WHERE id = $1`, [
        runId,
      ])
      return String(rows[0]?.status ?? "")
    }
    const running = await until(
      async () => ((await status()) === "running" ? true : undefined),
      10_000,
    )
    expect(running).toBe(true)
    // Inside its 5 s model step on A.
    await Bun.sleep(1_000)

    const t0 = Date.now()
    const cancel = await api(apiB.url, `/api/_test/live/sub-run/${runId}/cancel`, {
      method: "POST",
      token: uToken,
    })
    expect(cancel.status).toBe(200)
    expect(cancel.body.data.cancelled).toEqual([runId])

    // The step A was inside never finished: an aborted step persists nothing,
    // while a step that ran to its end writes its text into the hidden thread
    // (onStepFinish). Waited past the moment the 5 s step would have ended.
    // A cancel that reached A ends the run between the stream's chunks, which
    // returns without a log line (only an abort surfacing as a throw logs
    // "run cancelled by its caller"), so the evidence is the transcript.
    await Bun.sleep(6_000)
    const agentRows = await cell.db.sql.unsafe(
      `SELECT count(*)::int AS n FROM ${ks}.messages WHERE thread_id = $1 AND author_type = 'agent'`,
      [hiddenThreadId],
    )
    const promptRows = await cell.db.sql.unsafe(
      `SELECT count(*)::int AS n FROM ${ks}.messages WHERE thread_id = $1 AND author_type = 'user'`,
      [hiddenThreadId],
    )
    console.log(
      `[S7] sub-run on A cancelled from B ${Date.now() - t0} ms ago: hidden thread prompt rows=${promptRows[0]?.n}, step rows=${agentRows[0]?.n}; row ${await status()}`,
    )
    // It did run on A (its prompt is in its transcript), and stopped mid-step.
    expect(Number(promptRows[0]?.n)).toBe(1)
    expect(Number(agentRows[0]?.n)).toBe(0)
    expect(await status()).toBe("cancelled")
    await scriptNoThread(apiA, [])
  }, 60_000)
})
