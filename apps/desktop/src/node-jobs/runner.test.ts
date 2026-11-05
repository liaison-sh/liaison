// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE NODE JOB CLIENT (P4 N-D T5, A20, A21, A23, F10; P1-T39): claim,
// started, heartbeat every 30 s, the session's event batches in order, result
// or fail, all fenced by the lease generation; the local run is aborted on a
// stale generation, never on a lost network (P3-T10, L4); sessions run in
// parallel up to the node's cap (D35), My node chat one turn at a time (G9);
// the backlog is offered on start with no prompt (L19).

import {
  capEvent,
  eventBytes,
  NODE_EVENT_LIMITS,
  type NodeSessionEventIn,
} from "@liaison/shared/node-session-protocol"
import { describe, expect, it, vi } from "vitest"
import {
  BOOT_TIMEOUT_TEXT,
  CLAIM_RETRY_MS,
  type ClaimedJob,
  type ClaimedSession,
  createNodeJobRunner,
  END_POST_RETRY_MS,
  EVENT_DRAIN_MS,
  HEARTBEAT_MS,
  NodeHttpError,
  type NodeJobHttp,
  type NodeJobShell,
  NodeShellRefusal,
  PERMISSION_POLL_MS,
  PERMISSION_TIMEOUT_MS,
  type RunExit,
  type RunLine,
  type ShellLiveRun,
} from "./runner"

const SESSION = (id: string) => ({
  id: `session-${id}`,
  folderPath: "/Users/owner/code/app",
  folderName: "app",
  repo: null,
  model: "claude-haiku-4-5",
  level: "standard",
  profileLevel: "standard",
  configKind: "owner",
  liaisonTools: true,
})

function claimed(id: string, overrides: Partial<ClaimedJob["job"]> = {}): ClaimedJob {
  const interactive = overrides.kind === "interactive"
  return {
    job: {
      id,
      agentId: "agent-1",
      agentName: "Dev",
      source: "dispatch",
      prompt: `do ${id}`,
      trigger: { report: "x" },
      hardTokenLimit: null,
      ...overrides,
    },
    leaseGeneration: 7,
    profile: { level: "standard", liaisonTools: true },
    ...(interactive ? {} : { session: SESSION(id) }),
  }
}

interface Harness {
  http: { [K in keyof NodeJobHttp]-?: ReturnType<typeof vi.fn> }
  shell: { [K in keyof NodeJobShell]: ReturnType<typeof vi.fn> }
  /** A run's stdout line; the job is the line's own, else its session's. */
  emitLine: (line: Record<string, unknown>, jobId?: string) => void
  emitExit: (jobId?: string) => void
  /** An exit exactly as the shell emits it (a follow's carries `follow`). */
  emitExitRaw: (exit: RunExit) => void
  /** A line exactly as the shell tags it (with its outbox index). */
  emitRun: (line: RunLine) => void
  tick: (ms: number) => Promise<void>
  runner: ReturnType<typeof createNodeJobRunner>
}

function harness(
  options: {
    finish?: (jobId: string, h: Harness) => void
    model?: (agentModel: string | null) => string
    offered?: string[]
    onUnattendedStart?: () => void
    /** What the shell holds after a "reload". */
    live?: ShellLiveRun[]
    outbox?: Record<string, Array<{ index: number; line: string }>>
    acked?: Record<string, { index: number; batchNo: number }>
  } = {},
): Harness {
  let now = 0
  const timers: Array<{ at: number; every: number; fn: () => void; live: boolean }> = []
  const lineListeners = new Set<(line: RunLine) => void>()
  const exitListeners = new Set<(exit: RunExit) => void>()
  const h = {} as Harness
  h.http = {
    claim: vi.fn(async (id: string, _connection: string | null) => claimed(id)),
    getJob: vi.fn(async (id: string) => ({ id, agentId: "agent-1", kind: "unattended" })),
    postEvents: vi.fn(async () => ({ lastSeq: 1 })),
    rerun: vi.fn(async (_id: string) => {}),
    started: vi.fn(async () => {}),
    heartbeat: vi.fn(async () => {}),
    result: vi.fn(async () => {}),
    fail: vi.fn(async () => {}),
    backlog: vi.fn(async () => []),
    definition: vi.fn(async () => "You are Dev."),
    permissionRequest: vi.fn(async () => ({ id: "prompt-1", status: "pending" })),
    permissionStatus: vi.fn(async () => ({ status: "pending" })),
    turnProgress: vi.fn(async () => {}),
    getCommands: vi.fn(async () => []),
    report: vi.fn(async () => ({ sessions: [] })),
    putFullOutput: vi.fn(async () => {}),
  }
  h.shell = {
    startJob: vi.fn(async (req: { jobId: string }) => {
      options.finish?.(req.jobId, h)
    }),
    stopJob: vi.fn(async (_sessionId?: string, _jobId?: string) => {}),
    startFollow: vi.fn(async (_request: Record<string, unknown>) => {}),
    stopFollow: vi.fn(async (_sessionId: string, _jobId: string) => true),
    writeSession: vi.fn(async () => true),
    onLine: vi.fn((listener: (line: RunLine) => void) => {
      lineListeners.add(listener)
      return () => lineListeners.delete(listener)
    }),
    onExit: vi.fn((listener: (exit: RunExit) => void) => {
      exitListeners.add(listener)
      return () => exitListeners.delete(listener)
    }),
    ensureConnection: vi.fn(async (_agentId: string) => "conn-new" as string | null),
    confirmConnection: vi.fn(async () => ({ confirmed: true, connected: true })),
    connectionFor: vi.fn(async (_agentId: string) => "conn-1" as string | null),
    answerPermission: vi.fn(async () => {}),
    liveSessions: vi.fn(async () => options.live ?? []),
    outbox: vi.fn(async (sessionId: string, jobId: string, fromIndex: number, max: number) =>
      (options.outbox?.[`${sessionId}/${jobId}`] ?? [])
        .filter((l) => l.index >= fromIndex)
        .slice(0, max),
    ),
    ack: vi.fn(async () => {}),
    spill: vi.fn(async () => null as string | null),
    acked: vi.fn(
      async (sessionId: string, jobId: string) =>
        options.acked?.[`${sessionId}/${jobId}`] ?? { index: 0, batchNo: 0 },
    ),
  }
  const jobOf = (line: Record<string, unknown>) =>
    typeof line.jobId === "string"
      ? line.jobId
      : String(line.sessionId ?? "").replace(/^session-/, "")
  h.emitLine = (line, jobId) => {
    const job = jobId ?? jobOf(line)
    const sessionId = job.startsWith("chat-") ? undefined : `session-${job}`
    for (const l of Array.from(lineListeners)) {
      l({ jobId: job, ...(sessionId ? { sessionId } : {}), line: JSON.stringify(line) })
    }
  }
  h.emitRun = (line) => {
    for (const l of Array.from(lineListeners)) l(line)
  }
  h.emitExit = (jobId = "job-a") => {
    for (const l of Array.from(exitListeners)) l({ jobId, sessionId: `session-${jobId}` })
  }
  h.emitExitRaw = (exit) => {
    for (const l of Array.from(exitListeners)) l(exit)
  }
  h.tick = async (ms: number) => {
    const target = now + ms
    for (;;) {
      const next = timers.filter((t) => t.live && t.at <= target).sort((a, b) => a.at - b.at)[0]
      if (!next) break
      now = next.at
      next.at += next.every
      next.fn()
      await flush()
    }
    now = target
    await flush()
  }
  h.runner = createNodeJobRunner({
    http: h.http as unknown as NodeJobHttp,
    shell: h.shell as unknown as NodeJobShell,
    model: options.model ?? (() => "claude-haiku-4-5"),
    offeredModels: () =>
      (options.offered ?? ["claude-haiku-4-5", "claude-sonnet-5"]).map((id) => ({ id })),
    ...(options.onUnattendedStart ? { onUnattendedStart: options.onUnattendedStart } : {}),
    clock: {
      now: () => now,
      every: (ms, fn) => {
        const timer = { at: now + ms, every: ms, fn, live: true }
        timers.push(timer)
        return () => {
          timer.live = false
        }
      },
    },
  })
  return h
}

/** The jobs the shell was asked to start, in order. */
function startedIds(h: Harness): string[] {
  return h.shell.startJob.mock.calls.map((c) => (c[0] as { jobId: string }).jobId)
}

async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

const DONE = (jobId: string, extra: Record<string, unknown> = {}) => ({
  type: "job_done",
  jobId,
  status: "done",
  text: `PR for ${jobId}`,
  refusals: [{ tool: "Bash", reason: "git push: main", detail: "git push origin HEAD:main" }],
  usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 2, totalTokens: 12 },
  ...extra,
})

describe("one job, start to result (S20, A19, A20)", () => {
  // D50: a server switch stops the node's runs too (account.rs leave_current);
  // each run's end reaches the server being left before the page moves, and
  // the next server's page never re-adopts it (node_live_sessions).
  it("D50: settleNodeJobs (a server switch) waits until a run the shell stopped posted its end, and gives up after its timeout", async () => {
    const h = harness()
    await h.runner.ready
    h.runner.offer("job-a")
    await flush()
    expect(h.shell.startJob).toHaveBeenCalledTimes(1)
    let settled = false
    const settling = h.runner.settleNodeJobs(3_000).then(() => {
      settled = true
    })
    await flush()
    expect(settled).toBe(false)
    h.emitLine(DONE("job-a", { status: "stopped", text: "" }))
    h.emitExit("job-a")
    await settling
    expect(h.http.result.mock.calls.length + h.http.fail.mock.calls.length).toBe(1)
    expect([...h.http.result.mock.calls, ...h.http.fail.mock.calls][0]?.[0]).toBe("job-a")
    // A run that never ends does not hold the switch past the timeout.
    h.runner.offer("job-b")
    await flush()
    let late = false
    const waiting = h.runner.settleNodeJobs(3_000).then(() => {
      late = true
    })
    await h.tick(2_999)
    expect(late).toBe(false)
    await h.tick(1)
    await waiting
    expect(late).toBe(true)
  })

  // B2-1 (D52): the 3 s settle once ran with the runner fully alive. A slot
  // the switch freed pumped the old server's queued offer, and an offer heard
  // during the settle was claimed too; the shell then started both under the
  // NEW server's address with the old server's token.
  it("B2-1: once frozen for a server switch, the runner launches nothing: no queued job, no offer heard during the settle", async () => {
    const h = harness()
    await h.runner.ready
    h.runner.offer("job-a")
    await flush()
    h.http.claim.mockRejectedValueOnce(new NodeHttpError(409, "node_busy"))
    h.runner.offer("job-b")
    await flush()
    expect(startedIds(h)).toEqual(["job-a"])
    const claimsBefore = h.http.claim.mock.calls.length
    h.runner.freezeNodeJobs()
    const settling = h.runner.settleNodeJobs(3_000)
    // The shell's switch stops job-a; its slot frees while the page settles.
    h.emitLine(DONE("job-a", { status: "stopped", text: "" }))
    h.emitExit("job-a")
    h.runner.offer("job-c")
    await settling
    await h.tick(CLAIM_RETRY_MS * 3)
    const launchedDuringSettle = startedIds(h).slice(1)
    expect(launchedDuringSettle).toEqual([])
    expect(h.http.claim.mock.calls.length - claimsBefore).toBe(0)
    expect(h.runner.running()).toEqual([])
  })

  it("B2-1: a claim answered after the freeze is never started; its job is failed on the server that answered it", async () => {
    const h = harness()
    let answer: (value: ClaimedJob) => void = () => {}
    h.http.claim.mockImplementationOnce(
      () =>
        new Promise<ClaimedJob>((resolve) => {
          answer = resolve
        }),
    )
    h.runner.offer("job-a")
    await flush()
    h.runner.freezeNodeJobs()
    answer({ ...claimed("job-a"), claimedFrom: "https://a.example" })
    await flush()
    expect(startedIds(h)).toEqual([])
    expect(h.http.fail).toHaveBeenCalledTimes(1)
    expect(h.http.fail.mock.calls[0]?.[0]).toBe("job-a")
    expect(h.http.fail.mock.calls[0]?.[1]).toMatchObject({ code: "error" })
  })

  it("B2-1: each start names the server that answered its claim, never the shell's current one", async () => {
    const h = harness()
    h.http.claim.mockImplementation(async (id: string) => ({
      ...claimed(id),
      claimedFrom: "https://a.example",
    }))
    h.runner.offer("job-a")
    await flush()
    expect(h.shell.startJob.mock.calls[0]?.[0]).toMatchObject({
      jobId: "job-a",
      server: "https://a.example",
    })
  })

  it("B2-1: a refused switch thaws the runner: what is offered again runs", async () => {
    const h = harness()
    h.runner.freezeNodeJobs()
    h.runner.offer("job-a")
    await flush()
    expect(startedIds(h)).toEqual([])
    // The offer dropped at the freeze is still in the server's backlog.
    h.http.backlog.mockResolvedValue([{ id: "job-a", agentId: "agent-1" }])
    h.runner.thawNodeJobs()
    await flush()
    expect(startedIds(h)).toEqual(["job-a"])
  })

  it("My node chat asks for the definition of the job's own room, so the server bounds it by that room's floor", async () => {
    const h = harness()
    h.http.claim.mockImplementation(async (id: string) =>
      claimed(id, { threadId: "thread-r", kind: "interactive", permissionMode: "manual" }),
    )
    h.runner.offer("job-r")
    await flush()
    expect(h.http.definition).toHaveBeenCalledWith("agent-1", "thread-r")
  })

  it("a session runs raw Claude Code: no definition is read or sent (S13, L7)", async () => {
    const h = harness()
    h.runner.offer("job-a")
    await flush()
    expect(h.http.definition).not.toHaveBeenCalled()
    expect(h.shell.startJob).toHaveBeenCalledWith(expect.objectContaining({ agentDefinition: "" }))
  })

  it("claims, starts, heartbeats every 30 s, and posts the result fenced by its generation", async () => {
    const h = harness()
    h.runner.offer("job-a")
    await flush()
    expect(h.http.claim).toHaveBeenCalledWith("job-a", "conn-1")
    expect(h.shell.startJob).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "job-a",
        agentId: "agent-1",
        prompt: "do job-a",
        trigger: { report: "x" },
        model: "claude-haiku-4-5",
        mcpConnectionId: "conn-1",
        profile: { level: "standard", liaisonTools: true },
        sessionId: "session-job-a",
        source: "dispatch",
        level: "standard",
        profileLevel: "standard",
        configKind: "owner",
        folderPath: "/Users/owner/code/app",
        folderName: "app",
        repo: null,
      }),
    )
    expect(h.http.started).toHaveBeenCalledWith("job-a", 7)
    await h.tick(HEARTBEAT_MS)
    await h.tick(HEARTBEAT_MS)
    expect(h.http.heartbeat).toHaveBeenCalledTimes(2)
    expect(h.http.heartbeat).toHaveBeenCalledWith("job-a", 7)
    h.emitLine(DONE("job-a"))
    await flush()
    expect(h.http.result).toHaveBeenCalledWith("job-a", {
      leaseGeneration: 7,
      text: "PR for job-a",
      refusals: [{ tool: "Bash", reason: "git push: main", detail: "git push origin HEAD:main" }],
      usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 2, totalTokens: 12 },
    })
    // The heartbeat stops with the job.
    await h.tick(HEARTBEAT_MS * 3)
    expect(h.http.heartbeat).toHaveBeenCalledTimes(2)
  })

  it("W2-D4: a result answered 401 is posted again after a backoff, with the same body, and the job then ends", async () => {
    const h = harness()
    h.http.result.mockRejectedValueOnce(new NodeHttpError(401, "invalid_token"))
    h.runner.offer("job-a")
    await flush()
    h.emitLine(DONE("job-a", { status: "done", text: "Which one?" }))
    await flush()
    expect(h.http.result).toHaveBeenCalledTimes(1)
    expect(h.runner.running()).toEqual(["job-a"])
    await h.tick(END_POST_RETRY_MS[0])
    expect(h.http.result).toHaveBeenCalledTimes(2)
    expect(h.http.result.mock.calls[1]).toEqual(h.http.result.mock.calls[0])
    expect(h.runner.running()).toEqual([])
    await h.tick(60_000)
    expect(h.http.result).toHaveBeenCalledTimes(2)
  })

  it("W2-D4: a network failure or 5xx keeps trying through the backoff, then gives up; a 409 (stale lease) is never retried", async () => {
    const h = harness()
    h.http.result.mockRejectedValue(new NodeHttpError(503, "unavailable"))
    h.runner.offer("job-a")
    await flush()
    h.emitLine(DONE("job-a"))
    await flush()
    for (const wait of END_POST_RETRY_MS) await h.tick(wait)
    expect(h.http.result).toHaveBeenCalledTimes(END_POST_RETRY_MS.length + 1)
    await h.tick(120_000)
    expect(h.http.result).toHaveBeenCalledTimes(END_POST_RETRY_MS.length + 1)
    expect(h.runner.running()).toEqual([])

    const h2 = harness()
    h2.http.result.mockRejectedValue(new NodeHttpError(409, "stale_lease"))
    h2.runner.offer("job-b")
    await flush()
    h2.emitLine(DONE("job-b"))
    await flush()
    await h2.tick(120_000)
    expect(h2.http.result).toHaveBeenCalledTimes(1)
  })

  it("W2-D4: a wake for a session that runs nothing here reports the live runs; a wake for a live one does not", async () => {
    const h = harness()
    await h.runner.ready
    h.runner.offer("job-a")
    await flush()
    const before = h.http.report.mock.calls.length
    await h.runner.wake("session-job-a")
    expect(h.http.report.mock.calls.length).toBe(before)
    await h.runner.wake("session-gone")
    expect(h.http.report.mock.calls.length).toBe(before + 1)
    expect(h.http.report.mock.calls.at(-1)?.[0]).toEqual([
      { id: "session-job-a", jobId: "job-a", leaseGeneration: 7, alive: true },
    ])
    // A plain wake (no session named) only pulls.
    await h.runner.wake()
    expect(h.http.report.mock.calls.length).toBe(before + 1)
  })

  it("W2-D5: the start carries the claim's folder holder to the shell", async () => {
    const h = harness()
    h.http.claim.mockImplementation(async (id: string) => {
      const c = claimed(id)
      return {
        ...c,
        session: { ...(c.session as ClaimedSession), folderHeldBy: '"Fix" (ac492ea4, running)' },
      }
    })
    h.runner.offer("job-a")
    await flush()
    expect(h.shell.startJob).toHaveBeenCalledWith(
      expect.objectContaining({ folderHeldBy: '"Fix" (ac492ea4, running)' }),
    )
    h.http.claim.mockImplementation(async (id: string) => claimed(id))
    h.runner.offer("job-b")
    await flush()
    expect(h.shell.startJob.mock.calls[1]?.[0]).not.toHaveProperty("folderHeldBy")
  })

  it("W2-D4: a failure post is retried the same way", async () => {
    const h = harness()
    h.http.fail.mockRejectedValueOnce(new TypeError("fetch failed"))
    h.runner.offer("job-a")
    await flush()
    h.emitLine(DONE("job-a", { status: "error", code: "error", error: "boom" }))
    await flush()
    expect(h.http.fail).toHaveBeenCalledTimes(1)
    await h.tick(END_POST_RETRY_MS[0])
    expect(h.http.fail).toHaveBeenCalledTimes(2)
  })

  it("My node chat runs on the model its agent names, and reports the model the node ran it on", async () => {
    const seen: Array<string | null> = []
    const h = harness({
      model: (agentModel) => {
        seen.push(agentModel)
        return agentModel === "claude-haiku-4-5" ? "claude-haiku-4-5-20251001" : "claude-sonnet-5"
      },
    })
    h.http.claim.mockImplementation(async (id: string) =>
      claimed(id, {
        agentModel: "claude-haiku-4-5",
        kind: "interactive",
        permissionMode: "manual",
      } as Partial<ClaimedJob["job"]>),
    )
    h.runner.offer("job-a")
    await flush()
    expect(seen).toEqual(["claude-haiku-4-5"])
    expect(h.shell.startJob).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-haiku-4-5-20251001" }),
    )
    h.emitLine(DONE("job-a", { model: "claude-haiku-4-5-20251001" }))
    await flush()
    expect(h.http.result).toHaveBeenCalledWith(
      "job-a",
      expect.objectContaining({ modelId: "claude-haiku-4-5-20251001" }),
    )
  })

  it("posts a run stopped at the hard token limit as a partial result (A34)", async () => {
    const h = harness()
    h.runner.offer("job-a")
    await flush()
    h.emitLine(
      DONE("job-a", {
        status: "token_limit",
        code: "token_limit",
        text: "half. Stopped: limit 1000",
      }),
    )
    await flush()
    expect(h.http.result).toHaveBeenCalledWith(
      "job-a",
      expect.objectContaining({ leaseGeneration: 7, text: "half. Stopped: limit 1000" }),
    )
  })

  it("S1: job_done.completion is posted with the result", async () => {
    const h = harness()
    h.runner.offer("job-a")
    await flush()
    h.emitLine(DONE("job-a", { completion: { by: "session", summary: "Shipped the fix." } }))
    await flush()
    expect(h.http.result).toHaveBeenCalledWith(
      "job-a",
      expect.objectContaining({ completion: { by: "session", summary: "Shipped the fix." } }),
    )
    const body = h.http.result.mock.calls[0]?.[1] as Record<string, unknown>
    expect("endedBy" in body).toBe(false)
  })

  it("S1: a run with no completion posts none (the server ends it Needs you)", async () => {
    const h = harness()
    h.runner.offer("job-a")
    await flush()
    h.emitLine(DONE("job-a"))
    await flush()
    const body = h.http.result.mock.calls[0]?.[1] as Record<string, unknown>
    expect("completion" in body).toBe(false)
    expect("endedBy" in body).toBe(false)
  })

  it("S4: a token_limit result posts endedBy token_limit", async () => {
    const h = harness()
    h.runner.offer("job-a")
    await flush()
    h.emitLine(
      DONE("job-a", {
        status: "token_limit",
        code: "token_limit",
        text: "half",
        completion: { by: "needs_you", reason: "Which branch?" },
      }),
    )
    await flush()
    expect(h.http.result).toHaveBeenCalledWith(
      "job-a",
      expect.objectContaining({
        endedBy: "token_limit",
        completion: { by: "needs_you", reason: "Which branch?" },
      }),
    )
  })

  it("S24: the start request carries the session's effort, null when it names none", async () => {
    const h = harness()
    h.http.claim.mockImplementation(async (id: string) => {
      const c = claimed(id)
      return id === "job-a" ? { ...c, session: { ...SESSION(id), effort: "xhigh" } } : c
    })
    h.runner.offer("job-a")
    await flush()
    expect(h.shell.startJob).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "job-a", effort: "xhigh" }),
    )
    h.runner.offer("job-b")
    await flush()
    expect(h.shell.startJob).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "job-b", effort: null }),
    )
  })

  it("S30: the start request carries autonomy and finishWith", async () => {
    const h = harness()
    h.http.claim.mockImplementation(async (id: string) => {
      const c = claimed(id)
      return id === "job-a"
        ? { ...c, session: { ...SESSION(id), autonomy: "autonomous", finishWith: "commit" } }
        : c
    })
    h.runner.offer("job-a")
    await flush()
    expect(h.shell.startJob).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "job-a", autonomy: "autonomous", finishWith: "commit" }),
    )
    // A claim that names neither (an older server): guided, and no finish step chosen.
    h.runner.offer("job-b")
    await flush()
    expect(h.shell.startJob).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "job-b", autonomy: "guided", finishWith: null }),
    )
  })

  it("A44: the start request carries cwdSubdir, and the resume its catchUpFrom (A62)", async () => {
    const h = harness()
    const SDK = "5e0c1d2a-7b3f-4c8e-9a1d-2f3e4d5c6b7a"
    h.http.claim.mockImplementation(async (id: string) => {
      const c = claimed(id)
      return id === "job-a"
        ? {
            ...c,
            session: {
              ...SESSION(id),
              cwdSubdir: "sub",
              resume: { sdkSessionId: SDK, after: "message", catchUpFrom: 1234 },
            },
          }
        : c
    })
    h.runner.offer("job-a")
    await flush()
    expect(h.shell.startJob).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "job-a",
        cwdSubdir: "sub",
        resume: { sdkSessionId: SDK, after: "message", catchUpFrom: 1234 },
      }),
    )
    // A claim without one (any session but an import): none sent.
    h.runner.offer("job-b")
    await flush()
    const b = h.shell.startJob.mock.calls
      .map((call: unknown[]) => call[0] as Record<string, unknown>)
      .find((r) => r.jobId === "job-b")
    expect(b && "cwdSubdir" in b).toBe(false)
  })

  it("D53: the start request carries the claim's worktreePath; a claim without one sends none", async () => {
    const h = harness()
    h.http.claim.mockImplementation(async (id: string) => {
      const c = claimed(id)
      return id === "job-a"
        ? { ...c, session: { ...SESSION(id), cwdSubdir: "pkg", worktreePath: "/tmp/app-wt" } }
        : c
    })
    h.runner.offer("job-a")
    await flush()
    expect(h.shell.startJob).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "job-a", cwdSubdir: "pkg", worktreePath: "/tmp/app-wt" }),
    )
    h.runner.offer("job-b")
    await flush()
    const b = h.shell.startJob.mock.calls
      .map((call: unknown[]) => call[0] as Record<string, unknown>)
      .find((r) => r.jobId === "job-b")
    expect(b && "worktreePath" in b).toBe(false)
  })

  it("S57: the result to a claim without autonomy carries the protocol-3 completion shape (by session, no prUrl, no reasonCode)", async () => {
    const h = harness()
    h.runner.offer("job-a")
    await flush()
    h.emitLine(
      DONE("job-a", {
        completion: {
          by: "atelier",
          summary: "Opened the pull request.",
          prUrl: "https://github.com/acme/app/pull/7",
          reasonCode: "pr_missing",
        },
      }),
    )
    await flush()
    const body = h.http.result.mock.calls[0]?.[1] as Record<string, unknown>
    expect(body.completion).toEqual({
      by: "session",
      summary: "Opened the pull request.",
      reason: "pr_missing",
    })
  })

  it("S57: the result to a claim from a server advertising protocol 4 carries prUrl and by atelier", async () => {
    const h = harness()
    h.http.claim.mockImplementation(async (id: string) => ({
      ...claimed(id),
      serverProtocol: 4,
      session: { ...SESSION(id), autonomy: "guided", finishWith: null },
    }))
    h.runner.offer("job-a")
    await flush()
    const completion = {
      by: "atelier",
      summary: "Opened the pull request.",
      prUrl: "https://github.com/acme/app/pull/7",
    }
    h.emitLine(DONE("job-a", { completion }))
    await flush()
    const body = h.http.result.mock.calls[0]?.[1] as Record<string, unknown>
    expect(body.completion).toEqual(completion)
  })

  it("S57 (D43 F2): the start request keeps the server's advertised protocol, 3 when the claim names none", async () => {
    const h = harness()
    h.http.claim.mockImplementation(async (id: string) =>
      id === "job-a" ? { ...claimed(id), serverProtocol: 4 } : claimed(id),
    )
    h.runner.offer("job-a")
    await flush()
    expect(h.shell.startJob).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "job-a", serverProtocol: 4 }),
    )
    h.runner.offer("job-b")
    await flush()
    expect(h.shell.startJob).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "job-b", serverProtocol: 3 }),
    )
  })

  it("S57 (D43 F2): a claim that names autonomy but advertises no protocol 4 still gets the protocol-3 shape", async () => {
    const h = harness()
    h.http.claim.mockImplementation(async (id: string) => ({
      ...claimed(id),
      session: { ...SESSION(id), autonomy: "guided", finishWith: null },
    }))
    h.runner.offer("job-a")
    await flush()
    h.emitLine(
      DONE("job-a", {
        completion: {
          by: "atelier",
          summary: "Opened it.",
          prUrl: "https://github.com/acme/app/pull/7",
        },
      }),
    )
    await flush()
    const body = h.http.result.mock.calls[0]?.[1] as Record<string, unknown>
    expect(body.completion).toEqual({ by: "session", summary: "Opened it." })
  })

  it("fails a job whose sidecar exits without a result", async () => {
    const h = harness()
    h.runner.offer("job-a")
    await flush()
    h.emitExit()
    await flush()
    expect(h.http.fail).toHaveBeenCalledWith(
      "job-a",
      expect.objectContaining({ leaseGeneration: 7, code: "error" }),
    )
  })
})

describe("the claim names the job's MCP connection (A18)", () => {
  it("claims with the connection pinned for the job's agent on this node", async () => {
    const h = harness()
    h.http.getJob.mockResolvedValue({ id: "job-a", agentId: "agent-7", kind: "unattended" })
    h.shell.connectionFor.mockImplementation(async (agentId: string) =>
      agentId === "agent-7" ? "conn-7" : null,
    )
    h.runner.offer("job-a")
    await flush()
    expect(h.http.claim).toHaveBeenCalledWith("job-a", "conn-7")
    expect(h.shell.startJob).toHaveBeenCalledWith(
      expect.objectContaining({ mcpConnectionId: "conn-7" }),
    )
  })

  it("without a connection that can be made here the job is refused auth_required, never run untagged", async () => {
    const h = harness()
    h.shell.connectionFor.mockResolvedValue(null)
    h.shell.ensureConnection.mockResolvedValue(null)
    // The shell refuses a Liaison job that claimed without its connection.
    h.shell.startJob.mockImplementation(async (req: { mcpConnectionId: string | null }) => {
      if (!req.mcpConnectionId) throw new NodeShellRefusal("auth_required")
    })
    h.runner.offer("job-a")
    await flush()
    expect(h.http.claim).toHaveBeenCalledWith("job-a", null)
    expect(h.http.fail).toHaveBeenCalledWith(
      "job-a",
      expect.objectContaining({ code: "auth_required" }),
    )
    expect(h.http.result).not.toHaveBeenCalled()
    expect(h.shell.confirmConnection).not.toHaveBeenCalled()
  })

  it("an agent without a connection is connected with no dialog, then claimed with it (CAV14)", async () => {
    const h = harness()
    h.shell.connectionFor.mockResolvedValue(null)
    h.runner.offer("job-a", "agent-1")
    await flush()
    expect(h.shell.ensureConnection).toHaveBeenCalledWith("agent-1")
    expect(h.shell.confirmConnection).not.toHaveBeenCalled()
    expect(h.http.claim).toHaveBeenCalledWith("job-a", "conn-new")
  })

  it("the job's own agent is used (the offer's when it names one); the job is read for its kind and source", async () => {
    const h = harness()
    h.http.getJob.mockResolvedValueOnce({ id: "job-a", agentId: "agent-9", kind: "unattended" })
    h.runner.offer("job-a", "agent-9")
    await flush()
    expect(h.http.getJob).toHaveBeenCalledWith("job-a")
    expect(h.shell.connectionFor).toHaveBeenCalledWith("agent-9")
    h.emitLine(DONE("job-a"))
    await flush()
    h.runner.offer("job-b")
    await flush()
    expect(h.http.getJob).toHaveBeenCalledWith("job-b")
    expect(h.shell.connectionFor).toHaveBeenLastCalledWith("agent-1")
  })

  it("a job that is gone is not claimed", async () => {
    const h = harness()
    h.http.getJob.mockResolvedValue(null)
    h.runner.offer("job-a")
    await flush()
    expect(h.http.claim).not.toHaveBeenCalled()
  })
})

describe("abort (A20)", () => {
  it("stops the local run when a heartbeat says the lease is stale, and posts nothing", async () => {
    const h = harness()
    h.http.heartbeat.mockRejectedValue(new NodeHttpError(409, "stale_lease"))
    h.runner.offer("job-a")
    await flush()
    await h.tick(HEARTBEAT_MS)
    expect(h.shell.stopJob).toHaveBeenCalledTimes(1)
    h.emitLine(DONE("job-a", { status: "aborted" }))
    await flush()
    expect(h.http.result).not.toHaveBeenCalled()
    expect(h.http.fail).not.toHaveBeenCalled()
  })

  it("heartbeats failing for 5 minutes do not stop the run; a stale lease does (L4)", async () => {
    const h = harness()
    h.http.heartbeat.mockRejectedValue(new TypeError("Failed to fetch"))
    h.runner.offer("job-a")
    await flush()
    await h.tick(5 * 60_000)
    expect(h.shell.stopJob).not.toHaveBeenCalled()
    // The network is back: the run goes on and ends as usual.
    h.http.heartbeat.mockResolvedValue(undefined)
    await h.tick(HEARTBEAT_MS)
    h.emitLine(DONE("job-a"))
    await flush()
    expect(h.http.result).toHaveBeenCalledTimes(1)
    // A stale lease still stops a run, that run only.
    const s = harness()
    s.runner.offer("job-a")
    await flush()
    s.http.heartbeat.mockRejectedValue(new TypeError("Failed to fetch"))
    await s.tick(HEARTBEAT_MS * 4)
    s.http.heartbeat.mockRejectedValue(new NodeHttpError(409, "stale_lease"))
    await s.tick(HEARTBEAT_MS)
    expect(s.shell.stopJob).toHaveBeenCalledWith("session-job-a", "job-a")
  })

  it("a stopped job_done fails the job with code stopped (G7)", async () => {
    const h = harness()
    h.runner.offer("job-a")
    await flush()
    h.emitLine(DONE("job-a", { status: "stopped", text: "" }))
    await flush()
    expect(h.http.fail).toHaveBeenCalledWith(
      "job-a",
      expect.objectContaining({ leaseGeneration: 7, code: "stopped", error: "Stopped by you." }),
    )
    expect(h.http.result).not.toHaveBeenCalled()
  })

  it("a stale generation on `started` stops the run too", async () => {
    const h = harness()
    h.http.started.mockRejectedValue(new NodeHttpError(409, "stale_lease"))
    h.runner.offer("job-a")
    await flush()
    expect(h.shell.stopJob).toHaveBeenCalledTimes(1)
  })
})

describe("refusals before the run (A21, F10, A15, R9)", () => {
  it("level_unconfirmed: the job is refused with that code, and nobody is asked on this computer (D24)", async () => {
    const h = harness()
    h.shell.startJob.mockRejectedValue(new NodeShellRefusal("level_unconfirmed"))
    h.runner.offer("job-a")
    await flush()
    expect(h.http.fail).toHaveBeenCalledWith(
      "job-a",
      expect.objectContaining({ leaseGeneration: 7, code: "level_unconfirmed" }),
    )
    expect(h.shell.confirmConnection).not.toHaveBeenCalled()
    expect(h.http.rerun).not.toHaveBeenCalled()
  })

  it("a boot past 30 s is reported as timeout, with the shell's sentence (L25)", async () => {
    const h = harness()
    h.shell.startJob.mockRejectedValue(new NodeShellRefusal("timeout"))
    h.runner.offer("job-a")
    await flush()
    expect(h.http.fail).toHaveBeenCalledWith(
      "job-a",
      expect.objectContaining({ code: "timeout", error: BOOT_TIMEOUT_TEXT }),
    )
  })

  it("an unattended auth_required fails, and asks nobody (the agent was connected before the claim)", async () => {
    const h = harness()
    h.shell.startJob.mockRejectedValue(new NodeShellRefusal("auth_required"))
    h.runner.offer("job-a")
    await flush()
    expect(h.http.fail).toHaveBeenCalledWith(
      "job-a",
      expect.objectContaining({ code: "auth_required" }),
    )
    expect(h.shell.confirmConnection).not.toHaveBeenCalled()
  })

  it("an unknown shell refusal is reported as error", async () => {
    const h = harness()
    h.shell.startJob.mockRejectedValue(new NodeShellRefusal("profile_unconfirmed"))
    h.runner.offer("job-a")
    await flush()
    expect(h.http.fail).toHaveBeenCalledWith("job-a", expect.objectContaining({ code: "error" }))
  })

  it("sandbox_unavailable is reported as such", async () => {
    const h = harness()
    h.shell.startJob.mockRejectedValue(new NodeShellRefusal("sandbox_unavailable"))
    h.runner.offer("job-a")
    await flush()
    expect(h.http.fail).toHaveBeenCalledWith(
      "job-a",
      expect.objectContaining({ code: "sandbox_unavailable" }),
    )
    expect(h.shell.confirmConnection).not.toHaveBeenCalled()
  })

  it("a model the computer does not offer fails model_unavailable and starts nothing (L18)", async () => {
    const h = harness({ offered: ["claude-haiku-4-5", "claude-sonnet-5"] })
    h.http.claim.mockImplementation(async (id: string) => ({
      ...claimed(id),
      session: { ...SESSION(id), model: "claude-opus-9" },
    }))
    h.runner.offer("job-a")
    await flush()
    expect(h.shell.startJob).not.toHaveBeenCalled()
    expect(h.http.fail).toHaveBeenCalledWith(
      "job-a",
      expect.objectContaining({
        code: "model_unavailable",
        error: expect.stringContaining("claude-opus-9"),
      }),
    )
  })

  // Re-review of #63: the refusal listed every model the SDK runs, older
  // versions included, inviting a pick nobody is offered.
  it("a model_unavailable refusal lists each family's current model only", async () => {
    const h = harness({ offered: ["claude-opus-5-5", "claude-haiku-5-5", "claude-opus-4-6"] })
    h.http.claim.mockImplementation(async (id: string) => ({
      ...claimed(id),
      session: { ...SESSION(id), model: "claude-opus-9" },
    }))
    h.runner.offer("job-a")
    await flush()
    expect(h.http.fail).toHaveBeenCalledWith(
      "job-a",
      expect.objectContaining({
        code: "model_unavailable",
        error: expect.stringContaining("(offered: claude-opus-5-5, claude-haiku-5-5)."),
      }),
    )
  })

  it("after each unattended start the capabilities are republished (D42)", async () => {
    const republish = vi.fn()
    const h = harness({ onUnattendedStart: republish })
    h.runner.offer("job-a")
    await flush()
    expect(republish).toHaveBeenCalledTimes(1)
  })
})

describe("the queue: sessions in parallel up to the cap (D35, L2, G9)", () => {
  const started = (h: Harness) =>
    h.shell.startJob.mock.calls.map((c) => (c[0] as { jobId: string }).jobId)

  it("three offers run three sessions at once; a fifth waits for a slot", async () => {
    const h = harness()
    for (const id of ["job-a", "job-b", "job-c"]) h.runner.offer(id)
    h.runner.offer("job-b")
    await flush()
    expect(started(h)).toEqual(["job-a", "job-b", "job-c"])
    h.runner.offer("job-d")
    h.runner.offer("job-e")
    await flush()
    expect(started(h)).toEqual(["job-a", "job-b", "job-c", "job-d"])
    expect(h.runner.running().sort()).toEqual(["job-a", "job-b", "job-c", "job-d"])
    h.emitLine(DONE("job-b"))
    await flush()
    expect(started(h)).toEqual(["job-a", "job-b", "job-c", "job-d", "job-e"])
    // Every start names the caps the shell admits it under.
    expect(h.shell.startJob).toHaveBeenLastCalledWith(
      expect.objectContaining({ caps: { maxLive: 4, maxBackground: 2 } }),
    )
  })

  it("a third background session waits while two run; an app session does not", async () => {
    const h = harness()
    const source = (id: string) => (id.startsWith("bg") ? "routine" : "app")
    h.http.getJob.mockImplementation(async (id: string) => ({
      id,
      agentId: "agent-1",
      kind: "unattended",
      source: source(id),
    }))
    h.http.claim.mockImplementation(async (id: string) => claimed(id, { source: source(id) }))
    h.runner.offer("bg-1")
    h.runner.offer("bg-2")
    h.runner.offer("bg-3")
    h.runner.offer("app-1")
    await flush()
    expect(started(h)).toEqual(["bg-1", "bg-2", "app-1"])
    expect(h.http.claim).not.toHaveBeenCalledWith("bg-3", expect.anything())
    h.emitLine(DONE("bg-1"))
    await flush()
    expect(started(h)).toEqual(["bg-1", "bg-2", "app-1", "bg-3"])
  })

  it("the claim's caps replace the defaults", async () => {
    const h = harness()
    h.http.claim.mockImplementation(async (id: string) => ({
      ...claimed(id),
      caps: { maxLive: 2, maxBackground: 1 },
    }))
    h.runner.offer("job-a")
    await flush()
    h.runner.offer("job-b")
    h.runner.offer("job-c")
    await flush()
    expect(started(h)).toEqual(["job-a", "job-b"])
    h.emitLine(DONE("job-a"))
    await flush()
    expect(started(h)).toEqual(["job-a", "job-b", "job-c"])
  })

  it("a 409 node_busy keeps the offer queued and retries when a run ends", async () => {
    const h = harness()
    h.runner.offer("job-a")
    await flush()
    h.http.claim.mockRejectedValueOnce(new NodeHttpError(409, "node_busy"))
    h.runner.offer("job-b")
    await flush()
    expect(started(h)).toEqual(["job-a"])
    expect(h.http.fail).not.toHaveBeenCalled()
    h.emitLine(DONE("job-a"))
    await flush()
    expect(h.http.claim).toHaveBeenLastCalledWith("job-b", "conn-1")
    expect(started(h)).toEqual(["job-a", "job-b"])
  })

  it("a node_busy with nothing running here is retried after a while", async () => {
    const h = harness()
    h.http.claim.mockRejectedValueOnce(new NodeHttpError(409, "node_busy"))
    h.runner.offer("job-a")
    await flush()
    expect(started(h)).toEqual([])
    await h.tick(CLAIM_RETRY_MS)
    expect(started(h)).toEqual(["job-a"])
  })

  // P1-walk D12: a claim refused 401 (the window's token had expired and its
  // refresh failed) once dropped the job for good: it sat offered until a restart.
  it("a claim refused 401 keeps the offer and claims it again after a while (D12)", async () => {
    const h = harness()
    h.http.claim.mockRejectedValueOnce(new NodeHttpError(401, "invalid_token"))
    h.runner.offer("job-a")
    await flush()
    expect(started(h)).toEqual([])
    expect(h.http.fail).not.toHaveBeenCalled()
    await h.tick(CLAIM_RETRY_MS)
    expect(h.http.claim).toHaveBeenCalledTimes(2)
    expect(started(h)).toEqual(["job-a"])
  })

  it("an interactive turn waits while another runs, beside sessions (G9)", async () => {
    const h = harness()
    const chat = (id: string) => id.startsWith("chat-")
    h.http.getJob.mockImplementation(async (id: string) => ({
      id,
      agentId: "agent-1",
      kind: chat(id) ? "interactive" : "unattended",
    }))
    h.http.claim.mockImplementation(async (id: string) =>
      chat(id) ? claimed(id, { kind: "interactive", permissionMode: "manual" }) : claimed(id),
    )
    h.runner.offer("chat-1")
    await flush()
    h.runner.offer("chat-2")
    h.runner.offer("job-a")
    await flush()
    expect(started(h)).toEqual(["chat-1", "job-a"])
    h.emitLine(DONE("chat-1"), "chat-1")
    await flush()
    expect(started(h)).toEqual(["chat-1", "job-a", "chat-2"])
  })

  it("a line for job B never reaches job A's poster, and B's exit settles only B", async () => {
    const h = harness()
    h.runner.offer("job-a")
    h.runner.offer("job-b")
    await flush()
    const ev = { at: "2026-10-13T12:00:00.000Z", type: "assistant_text", payload: { text: "b" } }
    h.emitLine({ type: "session_events", sessionId: "session-job-b", events: [ev] })
    // A line that names A's session but comes from B's process is not A's.
    h.emitLine({ type: "session_events", sessionId: "session-job-a", events: [ev] }, "job-b")
    await flush()
    expect(h.http.postEvents).toHaveBeenCalledTimes(1)
    expect(h.http.postEvents).toHaveBeenCalledWith(
      "session-job-b",
      expect.objectContaining({ jobId: "job-b", batchNo: 1 }),
    )
    h.emitExit("job-b")
    await flush()
    expect(h.http.fail).toHaveBeenCalledWith("job-b", expect.objectContaining({ code: "error" }))
    expect(h.http.fail).not.toHaveBeenCalledWith("job-a", expect.anything())
    expect(h.runner.running()).toEqual(["job-a"])
  })

  it("a claim another node won is skipped", async () => {
    const h = harness()
    h.http.claim.mockRejectedValueOnce(new NodeHttpError(409, "not_claimable"))
    h.runner.offer("job-a")
    h.runner.offer("job-b")
    await flush()
    expect(h.shell.startJob).toHaveBeenCalledTimes(1)
    expect(h.shell.startJob).toHaveBeenCalledWith(expect.objectContaining({ jobId: "job-b" }))
  })
})

describe("the backlog on start (L19)", () => {
  it("startup offers backlog jobs with no prompt, once per launch", async () => {
    const h = harness()
    h.http.backlog.mockResolvedValue([
      { id: "old-1", agentId: "agent-1" },
      { id: "old-2", agentId: "agent-1" },
    ])
    await h.runner.startup()
    await h.runner.startup()
    await flush()
    expect(h.http.backlog).toHaveBeenCalledTimes(1)
    expect(h.http.claim).toHaveBeenCalledWith("old-1", "conn-1")
    expect(h.http.claim).toHaveBeenCalledWith("old-2", "conn-1")
    expect(h.shell).not.toHaveProperty("backlogPrompt")
  })

  it("a reconnect reads the backlog again: what queued while the node was away is offered, a run live here is not claimed twice (walk D4)", async () => {
    const h = harness()
    await h.runner.ready
    await h.runner.startup()
    h.runner.offer("live-1")
    await flush()
    expect(h.http.claim).toHaveBeenCalledTimes(1)
    h.http.backlog.mockResolvedValue([
      { id: "live-1", agentId: "agent-1" },
      { id: "away-1", agentId: "agent-1" },
    ])
    await h.runner.reconnected()
    await flush()
    expect(h.http.backlog).toHaveBeenCalledTimes(2)
    expect(h.http.claim).toHaveBeenCalledWith("away-1", "conn-1")
    expect(h.http.claim.mock.calls.filter((c) => c[0] === "live-1")).toHaveLength(1)
  })
})

// P4 N-D T6b (S24, A24, F9): an INTERACTIVE node chat turn. The job resumes
// the chat's SDK session in the chat's mode, relays each permission prompt to
// the owner through the server, waits for the decision (10 minutes, then
// deny), and posts the result with the session the next turn resumes.
describe("interactive node chat jobs (S24, A24)", () => {
  const chat = (id: string, overrides: Partial<ClaimedJob["job"]> = {}) =>
    claimed(id, {
      kind: "interactive",
      permissionMode: "edit",
      sdkSessionId: "sess-1",
      prompt: "rebuild the report",
      trigger: null,
      ...overrides,
    })

  function interactiveHarness(overrides: Partial<ClaimedJob["job"]> = {}) {
    const h = harness()
    h.http.claim.mockImplementation(async (id: string) => chat(id, overrides))
    return h
  }

  const ASK = {
    type: "permission_request",
    jobId: "job-a",
    requestId: "perm-1",
    toolName: "Bash",
    input: { command: "bun run build" },
  }

  it("starts the job resuming the chat's SDK session in its mode, and posts the new session", async () => {
    const h = interactiveHarness()
    h.runner.offer("job-a")
    await flush()
    expect(h.shell.startJob).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "job-a",
        kind: "interactive",
        permissionMode: "edit",
        resumeSessionId: "sess-1",
        prompt: "rebuild the report",
      }),
    )
    h.emitLine(DONE("job-a", { refusals: [], sdkSessionId: "sess-2" }))
    await flush()
    expect(h.http.result).toHaveBeenCalledWith(
      "job-a",
      expect.objectContaining({ leaseGeneration: 7, sdkSessionId: "sess-2" }),
    )
  })

  // Regression smoke 0759b0f89 (2026-10-08): a chat with the Researcher (its
  // profile has no Liaison tools) on My node failed auth_required; Allow pinned
  // the profile but minted no connection, because the confirmation only asked
  // the profile, and the job was re-queued into the same refusal and dialog.
  it("auth_required on a chat job asks the owner to connect for a chat, whatever the profile", async () => {
    const h = interactiveHarness()
    h.shell.startJob.mockRejectedValue(new NodeShellRefusal("auth_required"))
    h.runner.offer("job-a")
    await flush()
    expect(h.shell.confirmConnection).toHaveBeenCalledWith("agent-1", "Dev")
  })

  it("a chat job refused auth_required asks with confirmConnection and re-queues when confirmed and connected; Don't allow leaves it failed and not re-queued (K10, D43)", async () => {
    const h = interactiveHarness()
    let answer: (v: { confirmed: boolean; connected: boolean }) => void = () => {}
    h.shell.confirmConnection.mockImplementation(() => new Promise((resolve) => (answer = resolve)))
    h.shell.startJob.mockRejectedValue(new NodeShellRefusal("auth_required"))
    h.runner.offer("job-a")
    await flush()
    expect(h.http.fail).toHaveBeenCalledWith(
      "job-a",
      expect.objectContaining({ code: "auth_required" }),
    )
    // The dialog stays open for minutes: the failed job's lease is not kept alive.
    await h.tick(HEARTBEAT_MS * 3)
    expect(h.http.heartbeat).not.toHaveBeenCalled()
    // The server re-offers the re-queued job while this run is still winding
    // down: the offer is kept and the job is claimed again (walk N9).
    h.http.rerun.mockImplementation(async (id: string) => {
      h.runner.offer(id)
    })
    h.shell.startJob.mockImplementation(async () => {})
    answer({ confirmed: true, connected: true })
    await flush()
    await flush()
    expect(h.http.rerun).toHaveBeenCalledWith("job-a")
    expect(h.http.claim).toHaveBeenCalledTimes(2)

    const refused = interactiveHarness()
    refused.shell.confirmConnection.mockResolvedValue({ confirmed: false, connected: false })
    refused.shell.startJob.mockRejectedValue(new NodeShellRefusal("auth_required"))
    refused.runner.offer("job-a")
    await flush()
    expect(refused.http.fail).toHaveBeenCalledWith(
      "job-a",
      expect.objectContaining({ code: "auth_required" }),
    )
    expect(refused.http.rerun).not.toHaveBeenCalled()
  })

  it("an unattended job carries no chat fields", async () => {
    const h = harness()
    h.runner.offer("job-a")
    await flush()
    const request = h.shell.startJob.mock.calls[0][0] as Record<string, unknown>
    expect(request.kind).toBeUndefined()
    expect(request.resumeSessionId).toBeUndefined()
  })

  it("refuses bypass on this side too, before anything starts (A24)", async () => {
    const h = interactiveHarness({ permissionMode: "bypass" })
    h.runner.offer("job-a")
    await flush()
    expect(h.shell.startJob).not.toHaveBeenCalled()
    expect(h.http.fail).toHaveBeenCalledWith(
      "job-a",
      expect.objectContaining({
        leaseGeneration: 7,
        code: "error",
        error: expect.stringContaining("Bypass is not available"),
      }),
    )
  })

  it("relays the turn's steps to its chat, in order, under the lease", async () => {
    const h = interactiveHarness()
    h.runner.offer("job-a")
    await flush()
    const call = { type: "tool_call", id: "toolu_1", toolName: "Bash", summary: "ls" }
    const done = { type: "tool_result", id: "toolu_1" }
    h.emitLine({ type: "turn_progress", jobId: "job-a", events: [call] })
    h.emitLine({ type: "turn_progress", jobId: "job-a", events: [done] })
    await flush()
    expect(h.http.turnProgress.mock.calls).toEqual([
      ["job-a", { leaseGeneration: 7, events: [call] }],
      ["job-a", { leaseGeneration: 7, events: [done] }],
    ])
  })

  it("stops relaying steps to a server without the route (an older one)", async () => {
    const h = interactiveHarness()
    h.http.turnProgress.mockRejectedValue(new NodeHttpError(404, "not_found"))
    h.runner.offer("job-a")
    await flush()
    const step = { type: "tool_result", id: "toolu_1" }
    h.emitLine({ type: "turn_progress", jobId: "job-a", events: [step] })
    await flush()
    h.emitLine({ type: "turn_progress", jobId: "job-a", events: [step] })
    await flush()
    expect(h.http.turnProgress).toHaveBeenCalledTimes(1)
  })

  it("never relays an unattended job's steps", async () => {
    const h = harness()
    h.runner.offer("job-a")
    await flush()
    h.emitLine({
      type: "turn_progress",
      jobId: "job-a",
      events: [{ type: "tool_result", id: "x" }],
    })
    await flush()
    expect(h.http.turnProgress).not.toHaveBeenCalled()
  })

  it("relays a write's whole input, its content included, for the card", async () => {
    const h = interactiveHarness()
    h.runner.offer("job-a")
    await flush()
    h.emitLine({
      ...ASK,
      toolName: "Write",
      input: { file_path: "/etc/hosts", content: "127.0.0.1 evil.example" },
    })
    await flush()
    const body = h.http.permissionRequest.mock.calls[0]?.[1] as { detail: string }
    expect(body.detail).toContain("127.0.0.1 evil.example")
    expect(body.detail).toContain("/etc/hosts")
  })

  it("denies at once a call the server refused for the chat (a secret in its input)", async () => {
    const h = interactiveHarness()
    h.http.permissionRequest.mockResolvedValue({
      id: "prompt-1",
      status: "denied",
      refused: "secret",
    })
    h.runner.offer("job-a")
    await flush()
    h.emitLine(ASK)
    await flush()
    expect(h.shell.answerPermission).toHaveBeenCalledWith(
      "perm-1",
      false,
      expect.stringContaining("contains a secret"),
    )
    expect(h.http.permissionStatus).not.toHaveBeenCalled()
  })

  it("relays a prompt to the owner and answers the job with their allow", async () => {
    const h = interactiveHarness()
    h.runner.offer("job-a")
    await flush()
    h.emitLine(ASK)
    await flush()
    expect(h.http.permissionRequest).toHaveBeenCalledWith("job-a", {
      leaseGeneration: 7,
      toolName: "Bash",
      summary: "bun run build",
      detail: "bun run build",
    })
    expect(h.shell.answerPermission).not.toHaveBeenCalled()
    await h.tick(PERMISSION_POLL_MS)
    expect(h.http.permissionStatus).toHaveBeenCalledWith("prompt-1")
    expect(h.shell.answerPermission).not.toHaveBeenCalled()
    h.http.permissionStatus.mockResolvedValue({ status: "allowed" })
    await h.tick(PERMISSION_POLL_MS)
    expect(h.shell.answerPermission).toHaveBeenCalledWith("perm-1", true, undefined)
    // Answered once: polling stops.
    const polls = h.http.permissionStatus.mock.calls.length
    await h.tick(PERMISSION_POLL_MS * 5)
    expect(h.http.permissionStatus.mock.calls.length).toBe(polls)
  })

  it("answers deny when the owner denies", async () => {
    const h = interactiveHarness()
    h.http.permissionStatus.mockResolvedValue({ status: "denied" })
    h.runner.offer("job-a")
    await flush()
    h.emitLine(ASK)
    await flush()
    await h.tick(PERMISSION_POLL_MS)
    expect(h.shell.answerPermission).toHaveBeenCalledWith(
      "perm-1",
      false,
      expect.stringContaining("denied"),
    )
  })

  it("denies after 10 minutes with no answer, and never says yes on its own", async () => {
    const h = interactiveHarness()
    h.runner.offer("job-a")
    await flush()
    h.emitLine(ASK)
    await flush()
    await h.tick(PERMISSION_TIMEOUT_MS - PERMISSION_POLL_MS)
    expect(h.shell.answerPermission).not.toHaveBeenCalled()
    await h.tick(PERMISSION_POLL_MS)
    expect(h.shell.answerPermission).toHaveBeenCalledWith(
      "perm-1",
      false,
      expect.stringContaining("10 minutes"),
    )
    expect(h.shell.answerPermission).not.toHaveBeenCalledWith("perm-1", true, expect.anything())
  })

  it("denies a prompt that cannot reach the owner, and stops on a stale lease", async () => {
    const h = interactiveHarness()
    h.http.permissionRequest.mockRejectedValue(new NodeHttpError(409, "stale_lease"))
    h.runner.offer("job-a")
    await flush()
    h.emitLine(ASK)
    await flush()
    expect(h.shell.answerPermission).toHaveBeenCalledWith("perm-1", false, expect.any(String))
    expect(h.shell.stopJob).toHaveBeenCalled()
  })

  it("an unattended job's prompt is denied without asking anyone", async () => {
    const h = harness()
    h.runner.offer("job-a")
    await flush()
    h.emitLine(ASK)
    await flush()
    expect(h.http.permissionRequest).not.toHaveBeenCalled()
    expect(h.shell.answerPermission).toHaveBeenCalledWith("perm-1", false, expect.any(String))
  })
})

// P1-T39 (D33, K4): a session's events reach the server in order, one batch
// in flight, and the result waits for the last one.
describe("a session's events are posted in order (D33, K4)", () => {
  const ev = (text: string): NodeSessionEventIn => ({
    at: "2026-10-13T12:00:00.000Z",
    type: "assistant_text",
    payload: { text },
  })
  const line = (jobId: string, ...events: NodeSessionEventIn[]) => ({
    type: "session_events",
    sessionId: `session-${jobId}`,
    events,
  })

  /** postEvents answers held until the test releases them, in call order. */
  function held(h: Harness) {
    const calls: Array<{
      batchNo: number
      texts: string[]
      resolve: () => void
      reject: (e: unknown) => void
    }> = []
    h.http.postEvents.mockImplementation(
      (_sessionId: string, body: { batchNo: number; events: NodeSessionEventIn[] }) =>
        new Promise((resolve, reject) => {
          calls.push({
            batchNo: body.batchNo,
            texts: body.events.map((e) => String(e.payload.text)),
            resolve: () => resolve({ lastSeq: body.batchNo }),
            reject,
          })
        }),
    )
    return calls
  }

  it("batches post in order with batchNo 1, 2, 3, one in flight, fenced by the run", async () => {
    const h = harness()
    const calls = held(h)
    h.runner.offer("job-a")
    await flush()
    h.emitLine(line("job-a", ev("a")))
    h.emitLine(line("job-a", ev("b")))
    h.emitLine(line("job-a", ev("c")))
    await flush()
    expect(calls.map((c) => c.batchNo)).toEqual([1])
    expect(h.http.postEvents).toHaveBeenCalledWith("session-job-a", {
      jobId: "job-a",
      leaseGeneration: 7,
      batchNo: 1,
      events: [ev("a")],
    })
    calls[0]?.resolve()
    await flush()
    expect(calls.map((c) => c.batchNo)).toEqual([1, 2])
    calls[1]?.resolve()
    await flush()
    calls[2]?.resolve()
    await flush()
    expect(calls.map((c) => [c.batchNo, c.texts])).toEqual([
      [1, ["a"]],
      [2, ["b"]],
      [3, ["c"]],
    ])
    // Another session's line is not this run's.
    h.emitLine({ ...line("job-a", ev("x")), sessionId: "session-other" })
    await flush()
    expect(calls).toHaveLength(3)
  })

  it("a gap answer re-sends from the expected batch", async () => {
    const h = harness()
    const calls = held(h)
    h.runner.offer("job-a")
    await flush()
    h.emitLine(line("job-a", ev("a")))
    h.emitLine(line("job-a", ev("b")))
    h.emitLine(line("job-a", ev("c")))
    await flush()
    // The server already holds batch 1 (its answer was lost): it expects 2.
    calls[0]?.reject(new NodeHttpError(409, "gap", "Expected batch 2.", { expectedBatchNo: 2 }))
    await flush()
    calls[1]?.resolve()
    await flush()
    // Then a batch the server says it is still missing goes again under that number.
    calls[2]?.reject(new NodeHttpError(409, "gap", "Expected batch 3.", { expectedBatchNo: 3 }))
    await flush()
    calls[3]?.resolve()
    await flush()
    expect(calls.map((c) => [c.batchNo, c.texts])).toEqual([
      [1, ["a"]],
      [2, ["b"]],
      [3, ["c"]],
      [3, ["c"]],
    ])
  })

  it("a conflict stops the job and fails it", async () => {
    const h = harness()
    const calls = held(h)
    h.runner.offer("job-a")
    await flush()
    h.emitLine(line("job-a", ev("a")))
    await flush()
    calls[0]?.reject(new NodeHttpError(409, "conflict", "ingest conflict"))
    await flush()
    expect(h.shell.stopJob).toHaveBeenCalled()
    expect(h.http.fail).toHaveBeenCalledWith(
      "job-a",
      expect.objectContaining({ leaseGeneration: 7, code: "error" }),
    )
    h.emitLine(DONE("job-a"))
    await flush()
    expect(h.http.result).not.toHaveBeenCalled()
  })

  it("the result waits for the last batch", async () => {
    const h = harness()
    const calls = held(h)
    h.runner.offer("job-a")
    await flush()
    h.emitLine(line("job-a", ev("last words")))
    h.emitLine(DONE("job-a"))
    await flush()
    expect(h.http.result).not.toHaveBeenCalled()
    calls[0]?.resolve()
    await flush()
    expect(h.http.result).toHaveBeenCalledTimes(1)
  })

  it("the result goes after 30 s even when a batch never gets through", async () => {
    const h = harness()
    held(h)
    h.runner.offer("job-a")
    await flush()
    h.emitLine(line("job-a", ev("stuck")))
    h.emitLine(DONE("job-a"))
    await flush()
    await h.tick(EVENT_DRAIN_MS - 1)
    expect(h.http.result).not.toHaveBeenCalled()
    await h.tick(1)
    expect(h.http.result).toHaveBeenCalledTimes(1)
  })

  it("a network error retries the same batch, in order, with backoff", async () => {
    const h = harness()
    const calls = held(h)
    h.runner.offer("job-a")
    await flush()
    h.emitLine(line("job-a", ev("a")))
    h.emitLine(line("job-a", ev("b")))
    await flush()
    calls[0]?.reject(new TypeError("Failed to fetch"))
    await flush()
    expect(calls).toHaveLength(1)
    await h.tick(1_000)
    expect(calls.map((c) => c.batchNo)).toEqual([1, 1])
    calls[1]?.reject(new TypeError("Failed to fetch"))
    await flush()
    await h.tick(1_999)
    expect(calls).toHaveLength(2)
    await h.tick(1)
    expect(calls.map((c) => [c.batchNo, c.texts])).toEqual([
      [1, ["a"]],
      [1, ["a"]],
      [1, ["a"]],
    ])
  })

  it("a 413 event_too_large re-sends the same batchNo with that event re-capped", async () => {
    const h = harness()
    const calls = held(h)
    const bodies: NodeSessionEventIn[][] = []
    h.http.postEvents.mockImplementation(
      (_s: string, body: { batchNo: number; events: NodeSessionEventIn[] }) => {
        bodies.push(body.events.map((e) => structuredClone(e)))
        return new Promise((resolve, reject) => {
          calls.push({
            batchNo: body.batchNo,
            texts: [],
            resolve: () => resolve({ lastSeq: 1 }),
            reject,
          })
        })
      },
    )
    h.runner.offer("job-a")
    await flush()
    const big = { ...ev("x"), payload: { text: "x".repeat(70 * 1024) } }
    h.emitLine(line("job-a", ev("small"), big))
    await flush()
    calls[0]?.reject(new NodeHttpError(413, "event_too_large", "too big", { index: 1 }))
    await flush()
    expect(calls.map((c) => c.batchNo)).toEqual([1, 1])
    const resent = bodies[1]?.[1] as NodeSessionEventIn
    expect(resent).toEqual(capEvent(big))
    expect(eventBytes(resent)).toBeLessThanOrEqual(NODE_EVENT_LIMITS.eventBytes)
    expect(resent.truncated).toBe(true)
  })

  it("a 413 batch_too_large re-splits into batchNo and batchNo+1 and renumbers the rest (K4)", async () => {
    const h = harness()
    const calls = held(h)
    h.runner.offer("job-a")
    await flush()
    h.emitLine(line("job-a", ev("a1"), ev("a2")))
    h.emitLine(line("job-a", ev("b")))
    await flush()
    calls[0]?.reject(new NodeHttpError(413, "batch_too_large", "too big"))
    await flush()
    calls[1]?.resolve()
    await flush()
    calls[2]?.resolve()
    await flush()
    calls[3]?.resolve()
    await flush()
    expect(calls.map((c) => [c.batchNo, c.texts])).toEqual([
      [1, ["a1", "a2"]],
      [1, ["a1"]],
      [2, ["a2"]],
      [3, ["b"]],
    ])
  })
})

// P3-T13 (L3, D36, G6, C5): a reloaded page reattaches to the shell's live
// runs, reports them alive, posts on from the persisted ack, and delivers the
// owner's commands to the right session.
describe("reattach, report and commands (P3-T13)", () => {
  const SA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  const SB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
  const ev = (text: string): NodeSessionEventIn => ({
    at: "2026-10-13T12:00:00.000Z",
    type: "assistant_text",
    payload: { text },
  })
  const outLine = (sessionId: string, ...texts: string[]) =>
    JSON.stringify({ type: "session_events", sessionId, events: texts.map(ev) })
  const run = (sessionId: string, jobId: string, generation: number): ShellLiveRun => ({
    sessionId,
    jobId,
    pid: 100,
    interactive: false,
    background: false,
    leaseGeneration: generation,
    lines: 3,
  })
  const posted = (h: Harness) =>
    h.http.postEvents.mock.calls.map((c) => {
      const body = c[1] as {
        jobId: string
        batchNo: number
        leaseGeneration: number
        events: NodeSessionEventIn[]
      }
      return [
        c[0],
        body.jobId,
        body.leaseGeneration,
        body.batchNo,
        body.events.map((e) => e.payload.text),
      ]
    })

  it("after a reload, reattaches two live runs, reports them alive, and posts outbox lines from the acked index with the next batch numbers", async () => {
    const h = harness({
      live: [run(SA, "job-x", 4), run(SB, "job-y", 9)],
      outbox: {
        [`${SA}/job-x`]: [
          { index: 1, line: outLine(SA, "a1") },
          { index: 2, line: outLine(SA, "a2") },
          { index: 3, line: outLine(SA, "a3") },
        ],
        [`${SB}/job-y`]: [{ index: 1, line: outLine(SB, "b1") }],
      },
      acked: { [`${SA}/job-x`]: { index: 2, batchNo: 5 } },
    })
    await h.runner.ready
    await flush()
    expect(h.http.claim).not.toHaveBeenCalled()
    expect(h.shell.startJob).not.toHaveBeenCalled()
    expect(h.http.report).toHaveBeenCalledWith([
      { id: SA, jobId: "job-x", leaseGeneration: 4, alive: true },
      { id: SB, jobId: "job-y", leaseGeneration: 9, alive: true },
    ])
    expect(posted(h)).toEqual([
      [SA, "job-x", 4, 6, ["a3"]],
      [SB, "job-y", 9, 1, ["b1"]],
    ])
    // Each line's ack is persisted with its batch number (G6).
    expect(h.shell.ack).toHaveBeenCalledWith(SA, "job-x", 3, 6)
    expect(h.shell.ack).toHaveBeenCalledWith(SB, "job-y", 1, 1)
    // A live line already read from the outbox (same index) is not posted twice.
    h.emitRun({ sessionId: SA, jobId: "job-x", line: outLine(SA, "a3"), index: 3 })
    await flush()
    expect(posted(h)).toHaveLength(2)
    // The reattached run ends as any run: its result is fenced by its generation.
    h.emitLine(DONE("job-x"), "job-x")
    await flush()
    expect(h.http.result).toHaveBeenCalledWith(
      "job-x",
      expect.objectContaining({ leaseGeneration: 4 }),
    )
    expect(h.runner.running()).toEqual(["job-y"])
  })

  it("a reattached run's live lines after the outbox continue the numbering", async () => {
    const h = harness({
      live: [run(SA, "job-x", 4)],
      outbox: { [`${SA}/job-x`]: [{ index: 1, line: outLine(SA, "a1") }] },
    })
    await h.runner.ready
    await flush()
    // The shell tags each live line with its outbox index.
    h.emitRun({
      sessionId: SA,
      jobId: "job-x",
      line: JSON.stringify({ type: "session_events", sessionId: SA, events: [ev("a1")] }),
      index: 1,
    })
    h.emitRun({
      sessionId: SA,
      jobId: "job-x",
      line: JSON.stringify({ type: "session_events", sessionId: SA, events: [ev("a2")] }),
      index: 2,
    })
    await flush()
    expect(posted(h)).toEqual([
      [SA, "job-x", 4, 1, ["a1"]],
      [SA, "job-x", 4, 2, ["a2"]],
    ])
  })

  it("a gap answer realigns the batch number of a reattached run", async () => {
    const h = harness({
      live: [run(SA, "job-x", 4)],
      outbox: {
        [`${SA}/job-x`]: [
          { index: 1, line: outLine(SA, "a1") },
          { index: 2, line: outLine(SA, "a2") },
        ],
      },
    })
    // The server already holds batch 1 (the ack was lost with the page): it expects 2.
    h.http.postEvents.mockImplementationOnce(async () => {
      throw new NodeHttpError(409, "gap", "Expected batch 2.", { expectedBatchNo: 2 })
    })
    await h.runner.ready
    await flush()
    expect(posted(h)).toEqual([
      [SA, "job-x", 4, 1, ["a1"]],
      [SA, "job-x", 4, 2, ["a2"]],
    ])
    expect(h.shell.ack).toHaveBeenCalledWith(SA, "job-x", 1, 1)
    expect(h.shell.ack).toHaveBeenLastCalledWith(SA, "job-x", 2, 2)
  })

  it("a reconnect reports every live run, the ones started here too, then pulls", async () => {
    const h = harness({ live: [run(SA, "job-x", 4)] })
    await h.runner.ready
    h.runner.offer("job-a")
    await flush()
    h.http.report.mockClear()
    h.http.getCommands.mockClear()
    await h.runner.reconnected()
    expect(h.http.report).toHaveBeenCalledWith([
      { id: SA, jobId: "job-x", leaseGeneration: 4, alive: true },
      { id: "session-job-a", jobId: "job-a", leaseGeneration: 7, alive: true },
    ])
    expect(h.http.getCommands).toHaveBeenCalledTimes(1)
  })

  it("on creation with nothing live, it reports none (the server resumes what an app quit ended)", async () => {
    const h = harness()
    await h.runner.ready
    expect(h.http.report).toHaveBeenCalledWith([])
  })

  it("a wake writes the session's command to its own run only", async () => {
    const h = harness({ live: [run(SA, "job-x", 4), run(SB, "job-y", 9)] })
    await h.runner.ready
    h.http.getCommands.mockResolvedValue([
      {
        commandId: "00000000-0000-4000-8000-000000000001",
        sessionId: SB,
        jobId: "job-y",
        seq: 1,
        type: "stop",
        payload: {},
      },
    ])
    await h.runner.wake(SB)
    expect(h.shell.writeSession).toHaveBeenCalledTimes(1)
    expect(h.shell.writeSession).toHaveBeenCalledWith(SB, expect.stringContaining('"type":"stop"'))
  })

  it("a run started here passes its generation to the shell and pulls its commands once started", async () => {
    const h = harness()
    await h.runner.ready
    h.http.getCommands.mockClear()
    h.runner.offer("job-a")
    await flush()
    expect(h.shell.startJob).toHaveBeenCalledWith(expect.objectContaining({ leaseGeneration: 7 }))
    expect(h.http.getCommands).toHaveBeenCalled()
  })

  it("a 413 split persists the shifted numbering (G6)", async () => {
    const h = harness()
    await h.runner.ready
    h.runner.offer("job-a")
    await flush()
    h.http.postEvents.mockImplementationOnce(async () => {
      throw new NodeHttpError(413, "batch_too_large", "too big")
    })
    h.emitRun({
      sessionId: "session-job-a",
      jobId: "job-a",
      line: JSON.stringify({
        type: "session_events",
        sessionId: "session-job-a",
        events: [ev("x1"), ev("x2")],
      }),
      index: 1,
    })
    await flush()
    expect(h.shell.ack).toHaveBeenCalledTimes(1)
    expect(h.shell.ack).toHaveBeenCalledWith("session-job-a", "job-a", 1, 2)
  })
})

// P3-T22 (S7): "Show full output" asks the node; the node PUTs the spill file.
describe("full output (P3-T22)", () => {
  const SID = "9f8e7d6c-5b4a-4321-8fed-cba987654321"

  it("a full-output frame PUTs the spill file, or gone", async () => {
    const h = harness()
    await h.runner.ready
    h.shell.spill.mockResolvedValueOnce("1\n2\n3\n")
    await h.runner.fullOutput(SID, "toolu_01Big")
    expect(h.shell.spill).toHaveBeenCalledWith(SID, "toolu_01Big")
    expect(h.http.putFullOutput).toHaveBeenLastCalledWith(SID, "toolu_01Big", "1\n2\n3\n")
    h.shell.spill.mockResolvedValueOnce(null)
    await h.runner.fullOutput(SID, "toolu_01Gone")
    expect(h.http.putFullOutput).toHaveBeenLastCalledWith(SID, "toolu_01Gone", null)
  })

  it("a bad id reads nothing and sends nothing; a read error sends gone", async () => {
    const h = harness()
    await h.runner.ready
    await h.runner.fullOutput("../x", "toolu_01Big")
    await h.runner.fullOutput(SID, "toolu_../../etc")
    expect(h.shell.spill).not.toHaveBeenCalled()
    expect(h.http.putFullOutput).not.toHaveBeenCalled()
    h.shell.spill.mockRejectedValueOnce(new Error("refused"))
    await h.runner.fullOutput(SID, "toolu_01Err")
    expect(h.http.putFullOutput).toHaveBeenCalledWith(SID, "toolu_01Err", null)
  })
})

// P3-T24 (D34): a level switch restarts the session's process at the new
// level, resuming its SDK session, with the same poster and numbering.
describe("level switch restart (P3-T24)", () => {
  const CONF = "33333333-dddd-4eee-8fff-444444444444"
  const ev = (text: string): NodeSessionEventIn => ({
    at: "2026-10-13T12:00:00.000Z",
    type: "assistant_text",
    payload: { text },
  })
  const events = (text: string, index: number) => ({
    sessionId: "session-job-a",
    jobId: "job-a",
    line: JSON.stringify({
      type: "session_events",
      sessionId: "session-job-a",
      events: [ev(text)],
    }),
    index,
  })
  const RESTART = (level: string) => ({
    type: "job_done",
    jobId: "job-a",
    status: "restart",
    level,
    sdkSessionId: "sdk-1",
    text: "",
    refusals: [],
    usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, totalTokens: 2 },
  })

  async function raised(h: Harness, level: string, confirmationId?: string) {
    h.http.getCommands.mockResolvedValue([
      {
        commandId: "00000000-0000-4000-8000-000000000009",
        sessionId: "session-job-a",
        jobId: "job-a",
        seq: 1,
        type: "set_level",
        payload: { level, ...(confirmationId ? { confirmationId } : {}) },
      },
    ])
    await h.runner.wake("session-job-a")
  }

  it("a restart job_done restarts the same job at the new level with resume", async () => {
    const h = harness()
    await h.runner.ready
    h.runner.offer("job-a")
    await flush()
    // Allow the delivery to write to this session: its run is live with a uuid-free id here.
    await raised(h, "open", CONF)
    expect(h.shell.writeSession).toHaveBeenCalledWith(
      "session-job-a",
      expect.stringContaining('"set_level"'),
    )
    h.emitRun(events("before", 1))
    await flush()
    h.emitLine(RESTART("open"))
    await flush()
    // The old process has not exited yet: nothing starts.
    expect(h.shell.startJob).toHaveBeenCalledTimes(1)
    h.emitExit("job-a")
    await flush()
    expect(h.shell.startJob).toHaveBeenCalledTimes(2)
    const again = h.shell.startJob.mock.calls[1]?.[0] as Record<string, unknown>
    expect(again).toMatchObject({
      jobId: "job-a",
      sessionId: "session-job-a",
      level: "open",
      sessionConfirmationId: CONF,
      resume: { sdkSessionId: "sdk-1", after: "level" },
      levelChange: { from: "standard" },
      leaseGeneration: 7,
    })
    expect(again.profileConfirmationId).toBeUndefined()
    // No result, no fail, no second `started`: the job runs on.
    expect(h.http.result).not.toHaveBeenCalled()
    expect(h.http.fail).not.toHaveBeenCalled()
    expect(h.http.started).toHaveBeenCalledTimes(1)
    // The set_level the old process had not applied reaches the new one (D34).
    expect(
      h.shell.writeSession.mock.calls.filter((c) => String(c[1]).includes('"set_level"')),
    ).toHaveLength(2)
    // Same poster, numbering continues.
    h.emitRun(events("after", 2))
    await flush()
    expect(h.http.postEvents.mock.calls.map((c) => (c[1] as { batchNo: number }).batchNo)).toEqual([
      1, 2,
    ])
    h.emitLine(DONE("job-a"))
    await flush()
    expect(h.http.result).toHaveBeenCalledTimes(1)
  })

  it("S24: a level restart after set_effort starts with the new effort", async () => {
    const h = harness()
    h.http.claim.mockImplementation(async (id: string) => ({
      ...claimed(id),
      session: { ...SESSION(id), effort: "low" },
    }))
    await h.runner.ready
    h.runner.offer("job-a")
    await flush()
    await raised(h, "strict")
    h.emitLine({ ...RESTART("strict"), effort: "max" })
    h.emitExit("job-a")
    await flush()
    expect(h.shell.startJob.mock.calls[1]?.[0]).toMatchObject({ level: "strict", effort: "max" })
    // A restart with no set_effort applied keeps the job's own effort.
    h.emitLine(RESTART("standard"))
    h.emitExit("job-a")
    await flush()
    expect(h.shell.startJob.mock.calls[2]?.[0]).toMatchObject({
      level: "standard",
      effort: "max",
    })
  })

  it("lowering carries no confirmation", async () => {
    const h = harness()
    await h.runner.ready
    h.runner.offer("job-a")
    await flush()
    await raised(h, "strict")
    h.emitLine(RESTART("strict"))
    h.emitExit("job-a")
    await flush()
    const again = h.shell.startJob.mock.calls[1]?.[0] as Record<string, unknown>
    expect(again).toMatchObject({ level: "strict", levelChange: { from: "standard" } })
    expect(again.sessionConfirmationId).toBeUndefined()
  })

  it("S33: a restart for autonomy resumes the same SDK session with after autonomy and keeps the level", async () => {
    const h = harness()
    h.http.claim.mockImplementation(async (id: string) => ({
      ...claimed(id),
      session: { ...SESSION(id), autonomy: "guided", finishWith: null },
    }))
    await h.runner.ready
    h.runner.offer("job-a")
    await flush()
    // The sidecar passes the current level (GF-50) and the new autonomy.
    h.emitLine({ ...RESTART("standard"), autonomy: "autonomous", restartFor: "autonomy" })
    h.emitExit("job-a")
    await flush()
    expect(h.shell.startJob).toHaveBeenCalledTimes(2)
    const again = h.shell.startJob.mock.calls[1]?.[0] as Record<string, unknown>
    expect(again).toMatchObject({
      jobId: "job-a",
      level: "standard",
      autonomy: "autonomous",
      resume: { sdkSessionId: "sdk-1", after: "autonomy" },
    })
    expect("levelChange" in again).toBe(false)
    expect(h.http.fail).not.toHaveBeenCalled()
    // A later level restart keeps the autonomy the switch applied.
    h.emitLine(RESTART("strict"))
    h.emitExit("job-a")
    await flush()
    expect(h.shell.startJob.mock.calls[2]?.[0]).toMatchObject({
      level: "strict",
      autonomy: "autonomous",
      resume: { sdkSessionId: "sdk-1", after: "level" },
      levelChange: { from: "standard" },
    })
  })

  it("a refused restart fails the job with the shell's code", async () => {
    const h = harness()
    await h.runner.ready
    h.runner.offer("job-a")
    await flush()
    h.shell.startJob.mockRejectedValueOnce(new NodeShellRefusal("level_unconfirmed"))
    h.emitLine(RESTART("open"))
    h.emitExit("job-a")
    await flush()
    expect(h.http.fail).toHaveBeenCalledWith(
      "job-a",
      expect.objectContaining({ code: "level_unconfirmed" }),
    )
  })

  it("a reattached run restarts from the request the shell kept", async () => {
    const h = harness({
      live: [
        {
          sessionId: "session-job-a",
          jobId: "job-a",
          pid: 5,
          interactive: false,
          leaseGeneration: 3,
          lines: 0,
          request: {
            jobId: "job-a",
            agentId: "agent-1",
            agentName: "Dev",
            model: "claude-haiku-4-5",
            profile: { level: "standard", liaisonTools: true },
            prompt: "do it",
            sessionId: "session-job-a",
            level: "standard",
            profileLevel: "standard",
            configKind: "owner",
            mcpConnectionId: "conn-1",
            trigger: null,
            hardTokenLimit: null,
            agentDefinition: "",
          },
        },
      ],
    })
    await h.runner.ready
    await flush()
    h.emitLine(RESTART("strict"))
    h.emitExit("job-a")
    await flush()
    expect(h.shell.startJob).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "job-a",
        agentId: "agent-1",
        prompt: "do it",
        level: "strict",
        leaseGeneration: 3,
        resume: { sdkSessionId: "sdk-1", after: "level" },
        levelChange: { from: "standard" },
      }),
    )
  })
})

describe("a reattached run talks to the server it was claimed from (D43 F2)", () => {
  /** A live run whose kept request is what the runner wrote at its start. */
  const live = (request: Record<string, unknown>): ShellLiveRun => ({
    sessionId: "session-job-a",
    jobId: "job-a",
    pid: 5,
    interactive: false,
    leaseGeneration: 3,
    lines: 0,
    request: {
      jobId: "job-a",
      agentId: "agent-1",
      agentName: "Dev",
      model: "claude-haiku-4-5",
      profile: { level: "standard", liaisonTools: true },
      prompt: "do it",
      sessionId: "session-job-a",
      level: "standard",
      profileLevel: "standard",
      configKind: "owner",
      mcpConnectionId: "conn-1",
      trigger: null,
      hardTokenLimit: null,
      agentDefinition: "",
      // The runner always writes these, whatever the server sent.
      autonomy: "guided",
      finishWith: null,
      ...request,
    } as ShellLiveRun["request"],
  })
  const completion = {
    by: "atelier",
    summary: "Opened the pull request.",
    prUrl: "https://github.com/acme/app/pull/7",
    reasonCode: "pr_missing",
  }

  it("S57: a run claimed from a pre-wave-2 server and reattached after a reload posts the protocol-3 shape", async () => {
    const h = harness({ live: [live({ serverProtocol: 3 })] })
    await h.runner.ready
    await flush()
    h.emitLine(DONE("job-a", { completion }), "job-a")
    await flush()
    const body = h.http.result.mock.calls[0]?.[1] as Record<string, unknown>
    expect(body.completion).toEqual({
      by: "session",
      summary: "Opened the pull request.",
      reason: "pr_missing",
    })
  })

  it("S57 (batch-2 F8): a run kept by the previous desktop (no serverProtocol in its request) posts the protocol-3 shape", async () => {
    const kept = live({})
    const {
      serverProtocol: _p,
      autonomy: _a,
      finishWith: _f,
      ...previous
    } = kept.request as unknown as Record<string, unknown>
    const h = harness({
      live: [{ ...kept, request: previous as unknown as ShellLiveRun["request"] }],
    })
    await h.runner.ready
    await flush()
    h.emitLine(DONE("job-a", { completion }), "job-a")
    await flush()
    const body = h.http.result.mock.calls[0]?.[1] as Record<string, unknown>
    expect(body.completion).toEqual({
      by: "session",
      summary: "Opened the pull request.",
      reason: "pr_missing",
    })
  })

  it("S57: a run reattached from a wave-2 server posts the full completion", async () => {
    const h = harness({ live: [live({ serverProtocol: 4 })] })
    await h.runner.ready
    await flush()
    h.emitLine(DONE("job-a", { completion }), "job-a")
    await flush()
    const body = h.http.result.mock.calls[0]?.[1] as Record<string, unknown>
    expect(body.completion).toEqual(completion)
  })
})

describe("the claim's resume (P3-T12 shape)", () => {
  it("passes a resume with an SDK session, and starts fresh on a null one", async () => {
    const h = harness()
    await h.runner.ready
    h.http.claim.mockImplementationOnce(async (id: string) => ({
      ...claimed(id),
      session: { ...SESSION(id), resume: { sdkSessionId: "sdk-1", after: "offline" as const } },
    }))
    h.runner.offer("job-a")
    await flush()
    expect(h.shell.startJob).toHaveBeenLastCalledWith(
      expect.objectContaining({ resume: { sdkSessionId: "sdk-1", after: "offline" } }),
    )
    h.http.claim.mockImplementationOnce(async (id: string) => ({
      ...claimed(id),
      session: { ...SESSION(id), resume: { sdkSessionId: null, after: "offline" as const } },
    }))
    h.runner.offer("job-b")
    await flush()
    const last = h.shell.startJob.mock.calls.at(-1)?.[0] as Record<string, unknown>
    expect(last.jobId).toBe("job-b")
    expect(last.resume).toBeUndefined()
    // Walk D3: a null SDK session with the message that woke it: the message goes.
    const commandId = "0b0c3e1a-2f4d-4e5f-8a6b-7c8d9e0f1a2b"
    h.http.claim.mockImplementationOnce(async (id: string) => ({
      ...claimed(id),
      session: {
        ...SESSION(id),
        resume: { sdkSessionId: null, after: "message" as const, commandId },
      },
    }))
    h.runner.offer("job-c")
    await flush()
    const third = h.shell.startJob.mock.calls.at(-1)?.[0] as Record<string, unknown>
    expect(third.jobId).toBe("job-c")
    expect(third.resume).toEqual({ sdkSessionId: null, after: "message", commandId })
  })
})

describe("walk D7: the node's offered models reach the session's start", () => {
  it("a session start carries the ids the node offers", async () => {
    const h = harness({ offered: ["claude-haiku-4-5", "claude-sonnet-5"] })
    await h.runner.ready
    h.runner.offer("job-m")
    await flush()
    const start = h.shell.startJob.mock.calls.at(-1)?.[0] as Record<string, unknown>
    expect(start.offeredModels).toEqual(["claude-haiku-4-5", "claude-sonnet-5"])
  })
})

describe("follow jobs run in the shell's follow host (W3 T11: S41, A45, A53, A54)", () => {
  const FS = "f0f0f0f0-1111-4222-8333-444444444444"
  const SDK = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
  const FOLLOW = {
    sdkSessionId: SDK,
    folderName: "app",
    cwdSubdir: "sub",
    startAt: "window" as const,
    once: false,
    inPlace: false,
  }
  const followClaim = (id: string, follow: Partial<typeof FOLLOW> = {}) => ({
    kind: "follow" as const,
    job: {
      id,
      agentId: "agent-1",
      agentName: "Dev",
      source: "import",
      kind: "follow" as const,
      prompt: "",
      trigger: { follow: { ...FOLLOW, ...follow } },
      hardTokenLimit: null,
    },
    leaseGeneration: 3,
    leaseExpiresAt: "2026-10-16T12:00:00.000Z",
    leaseSeconds: 300,
    session: { ...SESSION(id), id: id === "follow-1" ? FS : `session-${id}` },
    follow: { ...FOLLOW, ...follow },
    serverProtocol: 5,
  })
  const ev = (text: string): NodeSessionEventIn => ({
    at: "2026-10-16T12:00:00.000Z",
    type: "assistant_text",
    payload: { text },
  })
  const eventsLine = (sessionId: string, jobId: string, ...texts: string[]) =>
    JSON.stringify({ type: "session_events", sessionId, jobId, events: texts.map(ev) })

  /** A harness whose `follow-*` jobs are follow jobs (their view and their claim). */
  function followHarness(options: Parameters<typeof harness>[0] = {}) {
    const h = harness(options)
    h.http.getJob.mockImplementation(async (id: string) =>
      id.startsWith("follow-")
        ? { id, agentId: "agent-1", kind: "follow", source: "import" }
        : { id, agentId: "agent-1", kind: "unattended" },
    )
    h.http.claim.mockImplementation(async (id: string) =>
      id.startsWith("follow-") ? followClaim(id) : claimed(id),
    )
    return h
  }

  it("D53: a follow claim naming the shared repo's worktree passes it to start_node_follow", async () => {
    const h = followHarness()
    h.http.claim.mockImplementation(async (id: string) =>
      followClaim(id, { worktreePath: "/tmp/app-wt", cwdSubdir: "pkg" } as Partial<typeof FOLLOW>),
    )
    h.runner.offer("follow-1")
    await flush()
    expect(h.shell.startFollow).toHaveBeenCalledWith({
      sessionId: FS,
      jobId: "follow-1",
      leaseGeneration: 3,
      ...FOLLOW,
      cwdSubdir: "pkg",
      worktreePath: "/tmp/app-wt",
    })
  })

  it("A45: a follow claim starts start_node_follow, never start_node_job, and is not counted toward the run cap", async () => {
    const h = followHarness()
    // The node's four live runs (the default cap) hold every run slot.
    for (const id of ["job-1", "job-2", "job-3", "job-4"]) h.runner.offer(id)
    await flush()
    expect(h.shell.startJob).toHaveBeenCalledTimes(4)
    h.runner.offer("follow-1")
    await flush()
    // A follow mints no MCP connection: it claims with none.
    expect(h.http.claim).toHaveBeenLastCalledWith("follow-1", null)
    expect(h.shell.startJob).toHaveBeenCalledTimes(4)
    expect(h.shell.startFollow).toHaveBeenCalledTimes(1)
    expect(h.shell.startFollow).toHaveBeenCalledWith({
      sessionId: FS,
      jobId: "follow-1",
      leaseGeneration: 3,
      ...FOLLOW,
    })
    expect(h.http.started).toHaveBeenCalledWith("follow-1", 3)
    // A fifth run still waits for a run slot: the follow took none.
    h.runner.offer("job-5")
    await flush()
    expect(h.shell.startJob).toHaveBeenCalledTimes(4)
    expect(h.runner.running()).toContain("follow-1")
  })

  it("B2-1: a follow names the server that answered its claim, and none starts once the runner is frozen", async () => {
    const h = followHarness()
    h.http.claim.mockImplementation(async (id: string) => ({
      ...followClaim(id),
      claimedFrom: "https://a.example",
    }))
    h.runner.offer("follow-1")
    await flush()
    expect(h.shell.startFollow.mock.calls[0]?.[0]).toMatchObject({
      jobId: "follow-1",
      server: "https://a.example",
    })
    let answer: (value: ReturnType<typeof followClaim> & { claimedFrom?: string }) => void =
      () => {}
    h.http.claim.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve
        }),
    )
    h.runner.offer("follow-2")
    await flush()
    h.runner.freezeNodeJobs()
    answer({ ...followClaim("follow-2"), claimedFrom: "https://a.example" })
    h.runner.offer("follow-3")
    await flush()
    expect(h.shell.startFollow).toHaveBeenCalledTimes(1)
    expect(h.http.fail.mock.calls.map((c) => c[0])).toEqual(["follow-2"])
  })

  it("A45: follow lines post as numbered batches and the result carries follow.why after the last batch", async () => {
    const h = followHarness()
    let release: () => void = () => {}
    h.http.postEvents.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ lastSeq: 1 })
        }),
    )
    h.runner.offer("follow-1")
    await flush()
    h.emitRun({ sessionId: FS, jobId: "follow-1", line: eventsLine(FS, "follow-1", "a"), index: 1 })
    h.emitRun({ sessionId: FS, jobId: "follow-1", line: eventsLine(FS, "follow-1", "b"), index: 2 })
    await flush()
    h.emitExitRaw({
      sessionId: FS,
      jobId: "follow-1",
      follow: { why: "replayed", endOffset: 1234 },
    })
    await flush()
    // The result waits for the batch in flight and the one behind it.
    expect(h.http.result).not.toHaveBeenCalled()
    release()
    await flush()
    const batches = h.http.postEvents.mock.calls.map((c) => [
      c[0],
      (c[1] as { jobId: string; leaseGeneration: number; batchNo: number }).jobId,
      (c[1] as { leaseGeneration: number }).leaseGeneration,
      (c[1] as { batchNo: number }).batchNo,
    ])
    expect(batches).toEqual([
      [FS, "follow-1", 3, 1],
      [FS, "follow-1", 3, 2],
    ])
    expect(h.http.result).toHaveBeenCalledTimes(1)
    expect(h.http.result).toHaveBeenCalledWith("follow-1", {
      leaseGeneration: 3,
      follow: { why: "replayed", endOffset: 1234 },
    })
    expect(h.http.postEvents.mock.invocationCallOrder.at(-1)).toBeLessThan(
      h.http.result.mock.invocationCallOrder[0] as number,
    )
    expect(h.http.fail).not.toHaveBeenCalled()
    expect(h.runner.running()).toEqual([])
  })

  it("A45: a 409 on heartbeat stops the follow and posts nothing", async () => {
    const h = followHarness()
    h.http.heartbeat.mockRejectedValue(new NodeHttpError(409, "stale"))
    h.runner.offer("follow-1")
    await flush()
    await h.tick(HEARTBEAT_MS)
    expect(h.http.heartbeat).toHaveBeenCalledWith("follow-1", 3)
    expect(h.shell.stopFollow).toHaveBeenCalledWith(FS, "follow-1")
    expect(h.shell.stopJob).not.toHaveBeenCalled()
    // The host's end of the removed follow posts nothing either.
    h.emitExitRaw({ sessionId: FS, jobId: "follow-1", follow: { why: "owner", endOffset: 10 } })
    await flush()
    expect(h.http.result).not.toHaveBeenCalled()
    expect(h.http.fail).not.toHaveBeenCalled()
    expect(h.runner.running()).toEqual([])
  })

  it("A54: the owner's Stop (or Take over) reaches the follow through stop_node_follow, and its end posts why owner with its offset", async () => {
    const h = followHarness()
    h.runner.offer("follow-1")
    await flush()
    h.http.getCommands.mockResolvedValue([
      {
        commandId: "00000000-0000-4000-8000-000000000009",
        sessionId: FS,
        jobId: "follow-1",
        seq: 4,
        type: "stop",
        payload: {},
      },
    ])
    await h.runner.wake(FS)
    expect(h.shell.stopFollow).toHaveBeenCalledWith(FS, "follow-1")
    expect(h.shell.writeSession).not.toHaveBeenCalled()
    h.emitExitRaw({ sessionId: FS, jobId: "follow-1", follow: { why: "owner", endOffset: 777 } })
    await flush()
    expect(h.http.result).toHaveBeenCalledWith("follow-1", {
      leaseGeneration: 3,
      follow: { why: "owner", endOffset: 777 },
    })
  })

  it("A45: an end without an offset posts why alone; a host exit posts host_exit", async () => {
    const h = followHarness()
    h.http.claim.mockImplementation(async (id: string) => followClaim(id))
    h.runner.offer("follow-1")
    h.runner.offer("follow-2")
    await flush()
    h.emitExitRaw({ sessionId: FS, jobId: "follow-1", follow: { why: "transcript_gone" } })
    h.emitExitRaw({ sessionId: "session-follow-2", jobId: "follow-2" })
    await flush()
    expect(h.http.result).toHaveBeenCalledWith("follow-1", {
      leaseGeneration: 3,
      follow: { why: "transcript_gone" },
    })
    expect(h.http.result).toHaveBeenCalledWith("follow-2", {
      leaseGeneration: 3,
      follow: { why: "host_exit" },
    })
  })

  it("D49 F9: settleNodeJobs (a server switch) waits until each follow ended by the shell posted its host_exit /result, and gives up after its timeout", async () => {
    const h = followHarness()
    h.http.claim.mockImplementation(async (id: string) => followClaim(id))
    h.runner.offer("follow-1")
    h.runner.offer("follow-2")
    await flush()
    let settled = false
    const settling = h.runner.settleNodeJobs(3_000).then(() => {
      settled = true
    })
    await flush()
    expect(settled).toBe(false)
    // The shell drained the follow host: one host_exit per follow.
    h.emitExitRaw({ sessionId: FS, jobId: "follow-1", follow: { why: "host_exit" } })
    await flush()
    expect(settled).toBe(false)
    h.emitExitRaw({
      sessionId: "session-follow-2",
      jobId: "follow-2",
      follow: { why: "host_exit" },
    })
    await settling
    expect(h.http.result.mock.calls.map((c) => c[0]).sort()).toEqual(["follow-1", "follow-2"])
    for (const call of h.http.result.mock.calls) {
      expect(call[1]).toEqual({ leaseGeneration: 3, follow: { why: "host_exit" } })
    }
    // A follow that never ends does not hold the switch past the timeout.
    h.runner.offer("follow-3")
    await flush()
    let late = false
    const waiting = h.runner.settleNodeJobs(3_000).then(() => {
      late = true
    })
    await h.tick(2_999)
    expect(late).toBe(false)
    await h.tick(1)
    await waiting
    expect(late).toBe(true)
    // No follow running: nothing to wait for.
    const h2 = followHarness()
    await h2.runner.settleNodeJobs(3_000)
  })

  it("A45: a shell refusal fails the follow with its code and starts nothing", async () => {
    const h = followHarness()
    h.shell.startFollow.mockRejectedValueOnce(new NodeShellRefusal("FOLDER_NOT_SHARED"))
    h.runner.offer("follow-1")
    await flush()
    expect(h.http.fail).toHaveBeenCalledWith(
      "follow-1",
      expect.objectContaining({ leaseGeneration: 3, code: "folder_missing" }),
    )
    expect(h.http.started).not.toHaveBeenCalled()
    expect(h.runner.running()).toEqual([])
  })

  it("A44: a follow the shell refuses unsafe_subdir fails with that code, which the web words", async () => {
    const h = followHarness()
    h.shell.startFollow.mockRejectedValueOnce(new NodeShellRefusal("unsafe_subdir"))
    h.runner.offer("follow-1")
    await flush()
    expect(h.http.fail).toHaveBeenCalledWith(
      "follow-1",
      expect.objectContaining({ leaseGeneration: 3, code: "unsafe_subdir" }),
    )
    expect(h.http.started).not.toHaveBeenCalled()
  })

  it("◆ C1 A53: a page reload re-adopts a live follow from node_live_sessions and keeps heartbeating it", async () => {
    const live: ShellLiveRun = {
      sessionId: FS,
      jobId: "follow-1",
      kind: "follow",
      leaseGeneration: 6,
      request: null,
      lines: 2,
    } as unknown as ShellLiveRun
    const h = followHarness({
      live: [live],
      outbox: {
        [`${FS}/follow-1`]: [
          { index: 1, line: eventsLine(FS, "follow-1", "x1") },
          { index: 2, line: eventsLine(FS, "follow-1", "x2") },
        ],
      },
      acked: { [`${FS}/follow-1`]: { index: 1, batchNo: 4 } },
    })
    await h.runner.ready
    await flush()
    expect(h.http.claim).not.toHaveBeenCalled()
    expect(h.shell.startFollow).not.toHaveBeenCalled()
    expect(h.shell.startJob).not.toHaveBeenCalled()
    // Its outbox posts on from the acked line, under its own generation.
    expect(h.http.postEvents).toHaveBeenCalledTimes(1)
    expect(h.http.postEvents).toHaveBeenCalledWith(
      FS,
      expect.objectContaining({ jobId: "follow-1", leaseGeneration: 6, batchNo: 5 }),
    )
    await h.tick(HEARTBEAT_MS)
    await h.tick(HEARTBEAT_MS)
    expect(h.http.heartbeat).toHaveBeenCalledTimes(2)
    expect(h.http.heartbeat).toHaveBeenCalledWith("follow-1", 6)
    // It ends as a follow, never as a run that died.
    h.emitExitRaw({ sessionId: FS, jobId: "follow-1", follow: { why: "driver_left" } })
    await flush()
    expect(h.http.fail).not.toHaveBeenCalled()
    expect(h.http.result).toHaveBeenCalledWith("follow-1", {
      leaseGeneration: 6,
      follow: { why: "driver_left" },
    })
  })

  it("◆ A53: the reconnect report lists a live follow alive with its lease generation", async () => {
    const h = followHarness({
      live: [
        {
          sessionId: FS,
          jobId: "follow-1",
          kind: "follow",
          leaseGeneration: 6,
          lines: 0,
        } as unknown as ShellLiveRun,
      ],
    })
    await h.runner.ready
    h.runner.offer("follow-2")
    await flush()
    h.http.report.mockClear()
    await h.runner.reconnected()
    expect(h.http.report).toHaveBeenCalledWith([
      { id: FS, jobId: "follow-1", leaseGeneration: 6, alive: true },
      { id: "session-follow-2", jobId: "follow-2", leaseGeneration: 3, alive: true },
    ])
    // Re-adopted as a follow: a Stop for it goes to the follow host.
    h.http.getCommands.mockResolvedValue([
      {
        commandId: "00000000-0000-4000-8000-00000000000a",
        sessionId: FS,
        jobId: "follow-1",
        seq: 1,
        type: "stop",
        payload: {},
      },
    ])
    await h.runner.wake(FS)
    expect(h.shell.stopFollow).toHaveBeenCalledWith(FS, "follow-1")
    expect(h.shell.writeSession).not.toHaveBeenCalled()
  })
})
