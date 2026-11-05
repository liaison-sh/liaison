// SPDX-License-Identifier: FSL-1.1-ALv2
// A turn survives its process (S10, A8) across real `src/index.ts` processes:
// A is an `api` process (the turn of a message posted to A runs on A), B is an
// `all` process (the leader: the resume sweep, and the workers that run the
// resume job). Turns run on the scripted model provider, whose scripts live in
// Redis, so a resumed turn plays the same script on B.
//
// - A is SIGKILLed after a complete step: B resumes the turn from that step,
//   one reply, the step's write not run again (effect count 1);
// - A is SIGKILLed while a write tool runs (the effect happened, its ledger
//   claim is still pending under A): the re-issued call answers "outcome
//   unknown", the effect count stays 1, one reply;
// - A gets a SIGTERM with a short turn drain: the turn hands off at its step
//   boundary, A exits 0, B finishes it once.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import {
  api,
  bootstrap,
  createRoleCell,
  jsonLogLines,
  type RoleCell,
  type RoleProcess,
  scriptTurnOn,
} from "@liaison/test-helpers"

// Clear of the lanes (0-3), the helper tests (50-61, 99) and the other cell
// scenarios (70-75).
const CELL_WORKER = process.env.WORKER_ID != null ? Number(process.env.WORKER_ID) : 76

const WRITE = "kernel__test_effect_then_wait"
const READ_STEP = { name: "kernel__tool_search", args: { query: "contacts" } }

/** Faster instance liveness, so a killed process is seen gone in seconds. */
const CELL_ENV = {
  LIAISON_VERSION: "p3-cell-turns",
  LIVE_INSTANCE_TTL_MS: "6000",
  LIVE_INSTANCE_HEARTBEAT_MS: "2000",
}

async function until<T>(
  probe: () => Promise<T | undefined>,
  timeoutMs: number,
  everyMs = 200,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const v = await probe().catch(() => undefined)
    if (v !== undefined) return v
    await Bun.sleep(everyMs)
  }
  return undefined
}

interface TurnRow {
  id: string
  state: string
  step_count: number
  attempt: number
  runner_instance_id: string
  agent_message_id: string | null
}

describe("S10: a turn survives its process", () => {
  let cell: RoleCell
  let apiA: RoleProcess
  let allB: RoleProcess
  let ks: string
  let orgId: string
  let uToken: string
  let uId: string

  async function thread(): Promise<string> {
    const threadId = crypto.randomUUID()
    await cell.db.sql.unsafe(
      `INSERT INTO ${ks}.threads (id, org_id, handle, type, created_by) VALUES ($1, $2, $3, 'agent_chat', $4)`,
      [threadId, orgId, `turns-${threadId.slice(0, 8)}`, uId],
    )
    await cell.db.sql.unsafe(
      `INSERT INTO ${ks}.thread_participants (thread_id, user_id, org_id) VALUES ($1, $2, $3)`,
      [threadId, uId, orgId],
    )
    return threadId
  }

  async function post(proc: RoleProcess, threadId: string, content: string): Promise<number> {
    const res = await api(proc.url, `/api/threads/${threadId}/messages`, {
      method: "POST",
      token: uToken,
      body: { content },
    })
    return res.status
  }

  async function registerTools(proc: RoleProcess): Promise<void> {
    const res = await api(proc.url, "/api/_test/effect-tools", { method: "POST", body: { orgId } })
    expect(res.status).toBe(200)
  }

  async function effects(key: string): Promise<number> {
    const res = await api(allB.url, `/api/_test/effect-tools/count?key=${encodeURIComponent(key)}`)
    return Number(res.body?.data?.count ?? -1)
  }

  async function turnOf(threadId: string): Promise<TurnRow | undefined> {
    const rows = await cell.db.sql.unsafe<TurnRow[]>(
      `SELECT id, state, step_count, attempt, runner_instance_id, agent_message_id
         FROM ${ks}.agent_turns WHERE thread_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [threadId],
    )
    return rows[0]
  }

  async function replies(
    threadId: string,
  ): Promise<Array<{ id: string; content: string; metadata: unknown }>> {
    return cell.db.sql.unsafe<Array<{ id: string; content: string; metadata: unknown }>>(
      `SELECT id, content, metadata FROM ${ks}.messages
        WHERE thread_id = $1 AND author_type = 'agent' ORDER BY created_at`,
      [threadId],
    )
  }

  /** A fresh `api` process A in place of the one a case killed. */
  async function freshA(env?: Record<string, string>): Promise<RoleProcess> {
    const p = await cell.spawn("api", env)
    await registerTools(p)
    return p
  }

  beforeAll(async () => {
    cell = await createRoleCell(CELL_WORKER, ["api", "all"], { serverEnv: CELL_ENV })
    ;[apiA, allB] = cell.processes as [RoleProcess, RoleProcess]
    ks = `"${cell.schemaPrefix}kernel"`
    const boot = await bootstrap(allB.url)
    uToken = boot.accessToken
    uId = boot.userId
    orgId = boot.orgId
    await registerTools(apiA)
    await registerTools(allB)
  }, 240_000)

  afterAll(async () => {
    await cell?.teardown()
  }, 60_000)

  it("SIGKILL after a complete step: B resumes from it, one reply, the step's write not run again", async () => {
    const threadId = await thread()
    const key = `kill-step-${crypto.randomUUID()}`
    await scriptTurnOn(apiA, threadId, [
      { toolCalls: [{ name: WRITE, args: { key } }] },
      // Step 2 is slow, so A dies inside it with step 1 journaled.
      { delayMs: 5_000, toolCalls: [READ_STEP] },
      { text: "Recorded once." },
    ])
    expect(await post(apiA, threadId, "record it")).toBe(200)
    const journaled = await until(async () => {
      const t = await turnOf(threadId)
      return t && t.step_count >= 1 ? t : undefined
    }, 20_000)
    expect(journaled?.state).toBe("running")
    expect(await effects(key)).toBe(1)
    apiA.proc.kill("SIGKILL")
    await apiA.proc.exited

    const done = await until(
      async () => {
        const t = await turnOf(threadId)
        return t?.state === "done" ? t : undefined
      },
      120_000,
      500,
    )
    console.log(`[S10 kill-step] turn ${JSON.stringify(done)}`)
    expect(done?.attempt).toBe(1)
    expect(done?.step_count).toBe(3)
    expect(done?.runner_instance_id).not.toBe(journaled?.runner_instance_id)
    const r = await replies(threadId)
    expect(r.map((m) => m.content)).toEqual(["Recorded once."])
    expect(done?.agent_message_id).toBe(r[0]?.id)
    expect(await effects(key)).toBe(1)
    apiA = await freshA()
  }, 180_000)

  it("SIGKILL mid-write: the re-issued call answers outcome unknown, the effect is not doubled", async () => {
    const threadId = await thread()
    const key = `kill-write-${crypto.randomUUID()}`
    await scriptTurnOn(apiA, threadId, [
      // The effect lands at once, then the tool waits: A dies with its claim pending.
      { toolCalls: [{ name: WRITE, args: { key } }], toolDelayMs: 30_000 },
      { text: "Could not confirm it." },
    ])
    expect(await post(apiA, threadId, "record it")).toBe(200)
    expect(await until(async () => ((await effects(key)) === 1 ? true : undefined), 20_000)).toBe(
      true,
    )
    apiA.proc.kill("SIGKILL")
    await apiA.proc.exited

    const done = await until(
      async () => {
        const t = await turnOf(threadId)
        return t?.state === "done" ? t : undefined
      },
      120_000,
      500,
    )
    console.log(`[S10 kill-write] turn ${JSON.stringify(done)}`)
    expect(done?.attempt).toBe(1)
    const r = await replies(threadId)
    expect(r.map((m) => m.content)).toEqual(["Could not confirm it."])
    const meta = r[0]?.metadata as
      | { toolCalls?: Array<{ toolName: string; result: unknown }> }
      | undefined
    const calls = meta?.toolCalls
    expect(calls?.map((c) => c.toolName)).toEqual([WRITE])
    expect(JSON.stringify(calls?.[0]?.result)).toContain("outcome_unknown")
    expect(await effects(key)).toBe(1)
    apiA = await freshA()
  }, 180_000)

  it("SIGTERM past the turn drain: the turn hands off at its step boundary, A exits 0, B finishes it once", async () => {
    // A process whose turn drain is short, so the turn outlives it.
    apiA.proc.kill("SIGTERM")
    await apiA.proc.exited
    apiA = await freshA({ SHUTDOWN_TURN_DRAIN_MS: "1000" })
    const threadId = await thread()
    const key = `handoff-${crypto.randomUUID()}`
    await scriptTurnOn(apiA, threadId, [
      { toolCalls: [{ name: WRITE, args: { key } }] },
      // Outlasts A's 1 s drain: the turn stops at this step's boundary, or is cut in it.
      { delayMs: 5_000, toolCalls: [READ_STEP] },
      { text: "Handed over." },
    ])
    expect(await post(apiA, threadId, "record it")).toBe(200)
    const journaled = await until(async () => {
      const t = await turnOf(threadId)
      return t && t.step_count >= 1 ? t : undefined
    }, 20_000)
    expect(journaled?.state).toBe("running")
    apiA.proc.kill("SIGTERM")
    expect(await apiA.proc.exited).toBe(0)
    expect(jsonLogLines(apiA).some((l) => l.msg === "turn_handed_off")).toBe(true)

    const done = await until(
      async () => {
        const t = await turnOf(threadId)
        return t?.state === "done" ? t : undefined
      },
      60_000,
      500,
    )
    console.log(`[S10 handoff] turn ${JSON.stringify(done)}`)
    expect(done?.attempt).toBe(1)
    expect(done?.step_count).toBe(3)
    const r = await replies(threadId)
    expect(r.map((m) => m.content)).toEqual(["Handed over."])
    expect(await effects(key)).toBe(1)
  }, 180_000)
})
