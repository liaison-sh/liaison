// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, test } from "bun:test"
import {
  beginShutdown,
  handleShutdownSignal,
  registerShutdownPhase,
  type ShutdownClock,
  ShutdownTestAccess,
  shutdownBudgets,
} from "./shutdown"
import {
  AFTER_DRAIN_BUDGET_MS,
  drainGroupMs,
  HARD_DEADLINE_SLACK_MS,
  JOB_ABORT_SETTLE_MS,
  JOB_QUEUE_CLOSE_MS,
  LEADERSHIP_STOP_MS,
  requiredHardDeadlineMs,
  TURN_HANDOFF_MS,
} from "./shutdown-budget"

/**
 * A virtual clock: one macrotask at a time, the earliest pending sleep wakes
 * and time jumps to its target, so a long hard deadline wakes last.
 */
function fakeClock(): ShutdownClock & { t: number } {
  const pending: Array<{ at: number; resolve: () => void }> = []
  let ticking = false
  const tick = () => {
    ticking = false
    pending.sort((a, b) => a.at - b.at)
    const next = pending.shift()
    if (!next) return
    clock.t = Math.max(clock.t, next.at)
    next.resolve()
    schedule()
  }
  const schedule = () => {
    if (ticking || pending.length === 0) return
    ticking = true
    setTimeout(tick, 1)
  }
  const clock = {
    t: 0,
    now: () => clock.t,
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        pending.push({ at: clock.t + ms, resolve })
        schedule()
      }),
  }
  return clock
}

afterEach(() => ShutdownTestAccess.reset())

describe("shutdown coordinator", () => {
  test("one SIGTERM runs every phase once, in order", async () => {
    const clock = fakeClock()
    const exits: number[] = []
    ShutdownTestAccess.configure({ clock, exit: (code) => exits.push(code), edgeGraceMs: 2500 })
    const started: Array<[string, number]> = []
    const record = (name: string) => () => {
      started.push([name, clock.now()])
    }
    registerShutdownPhase({ name: "late", at: "after-drain", order: 90, run: record("late") })
    registerShutdownPhase({ name: "ready", at: "t0", run: record("ready") })
    registerShutdownPhase({ name: "listener", at: "edge", run: record("listener") })
    registerShutdownPhase({ name: "drain", at: "after-drain", order: 0, run: record("drain") })

    await beginShutdown("SIGTERM")

    expect(started.map(([n]) => n)).toEqual(["ready", "listener", "drain", "late"])
    expect(started[0]?.[1]).toBe(0)
    expect(started[1]?.[1]).toBeGreaterThanOrEqual(2500)
    expect(exits).toEqual([0])
  })

  test("a hung phase is cut at its deadline and the rest still run", async () => {
    const clock = fakeClock()
    const exits: number[] = []
    ShutdownTestAccess.configure({ clock, exit: (code) => exits.push(code), edgeGraceMs: 0 })
    let aborted = false
    const ran: string[] = []
    registerShutdownPhase({
      name: "hung",
      at: "after-drain",
      order: 10,
      deadlineMs: 1000,
      run: (signal) =>
        new Promise<void>(() => {
          signal.addEventListener("abort", () => {
            aborted = true
          })
        }),
    })
    registerShutdownPhase({
      name: "after",
      at: "after-drain",
      order: 20,
      run: () => {
        ran.push("after")
      },
    })

    await beginShutdown("SIGTERM")

    expect(aborted).toBe(true)
    expect(ran).toEqual(["after"])
    expect(ShutdownTestAccess.outcomes().get("hung")).toBe("timeout")
    expect(ShutdownTestAccess.outcomes().get("after")).toBe("ok")
    expect(exits).toEqual([0])
  })

  test("a second signal during shutdown is ignored", async () => {
    const clock = fakeClock()
    const exits: number[] = []
    ShutdownTestAccess.configure({ clock, exit: (code) => exits.push(code), edgeGraceMs: 0 })
    let runs = 0
    registerShutdownPhase({
      name: "once",
      at: "t0",
      run: () => {
        runs++
      },
    })
    const first = beginShutdown("SIGTERM")
    const second = beginShutdown("SIGINT")
    await Promise.all([first, second])
    expect(runs).toBe(1)
    expect(exits).toEqual([0])
  })

  test("a throwing phase is logged as an error and does not stop the sequence", async () => {
    const clock = fakeClock()
    const exits: number[] = []
    ShutdownTestAccess.configure({ clock, exit: (code) => exits.push(code), edgeGraceMs: 0 })
    let later = false
    registerShutdownPhase({
      name: "boom",
      at: "t0",
      run: () => {
        throw new Error("boom")
      },
    })
    registerShutdownPhase({
      name: "later",
      at: "after-drain",
      run: () => {
        later = true
      },
    })
    await beginShutdown("SIGTERM")
    expect(ShutdownTestAccess.outcomes().get("boom")).toBe("error")
    expect(later).toBe(true)
    expect(exits).toEqual([0])
  })

  test('process.listenerCount("SIGTERM") === 1 after index-style registration', async () => {
    // A fresh process: import the uncaught handlers and the coordinator as
    // index.ts does, then create a health-only server (a worker's).
    const snippet = `
      import { registerProcessHandlers } from "${import.meta.dir}/process-handlers"
      import { installShutdownSignals } from "${import.meta.dir}/shutdown"
      import { rootLogger } from "${import.meta.dir}/logger"
      import { createServer } from "${import.meta.dir}/server"
      import { Hono } from "hono"
      registerProcessHandlers(rootLogger)
      installShutdownSignals()
      installShutdownSignals()
      const server = await createServer(new Hono(), { port: 0, healthOnly: true })
      console.error("sigterm listeners: " + process.listenerCount("SIGTERM"))
      console.error("sigint listeners: " + process.listenerCount("SIGINT"))
      server.stop(true)
      process.exit(0)
    `
    const proc = Bun.spawn(["bun", "--env-file=../../.env.test", "-e", snippet], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NODE_ENV: "test" },
    })
    await proc.exited
    const stderr = await new Response(proc.stderr).text()
    expect(stderr).toContain("sigterm listeners: 1")
    expect(stderr).toContain("sigint listeners: 1")
  })

  test("a phase registered after its stage ran runs at once (boot raced the signal)", async () => {
    const clock = fakeClock()
    ShutdownTestAccess.configure({ clock, exit: () => {}, edgeGraceMs: 0 })
    const done = beginShutdown("SIGTERM")
    await done
    let ran = false
    registerShutdownPhase({
      name: "late-listener",
      at: "edge",
      run: () => {
        ran = true
      },
    })
    await Bun.sleep(5)
    expect(ran).toBe(true)
  })

  test("a second SIGINT force-exits in development; a second SIGTERM is ignored", async () => {
    const clock = fakeClock()
    const exits: number[] = []
    ShutdownTestAccess.configure({ clock, exit: (c) => exits.push(c), devForceExit: true })
    registerShutdownPhase({
      name: "hang",
      at: "t0",
      deadlineMs: 60_000,
      run: () => new Promise(() => {}),
    })
    handleShutdownSignal("SIGTERM")
    handleShutdownSignal("SIGTERM")
    expect(exits).toEqual([])
    handleShutdownSignal("SIGINT")
    expect(exits).toEqual([130])
  })

  test("the drains are clamped under SHUTDOWN_HARD_DEADLINE_MS; unset, it covers every budget", () => {
    ShutdownTestAccess.configure({ edgeGraceMs: 2_000, hardDeadlineMs: 50_000 })
    const b = shutdownBudgets()
    expect(b.hardDeadlineMs).toBe(50_000)
    expect(requiredHardDeadlineMs(b)).toBeLessThanOrEqual(50_000)
    const room = 50_000 - AFTER_DRAIN_BUDGET_MS - HARD_DEADLINE_SLACK_MS
    expect(b.turnDrainMs + TURN_HANDOFF_MS).toBeLessThanOrEqual(room)
    expect(b.jobDrainMs + JOB_ABORT_SETTLE_MS + JOB_QUEUE_CLOSE_MS).toBeLessThanOrEqual(room)

    ShutdownTestAccess.reset()
    const d = shutdownBudgets()
    expect(d.hardDeadlineMs).toBe(requiredHardDeadlineMs(d))
  })

  test("the defaults fit a stop grace period of about a minute", () => {
    const d = shutdownBudgets()
    expect(d).toMatchObject({ httpDrainMs: 20_000, turnDrainMs: 20_000, jobDrainMs: 20_000 })
    // The drain group ends at its slowest member, counted from t0: a turn and
    // its handoff (25 s), above the job drain with its abort settle and queue
    // close (24 s) and the leadership stop at t0 (10 s).
    expect(drainGroupMs(d)).toBe(20_000 + TURN_HANDOFF_MS)
    expect(drainGroupMs({ ...d, jobDrainMs: 30_000 })).toBe(
      30_000 + JOB_ABORT_SETTLE_MS + JOB_QUEUE_CLOSE_MS,
    )
    expect(drainGroupMs({ ...d, httpDrainMs: 0, turnDrainMs: 0, jobDrainMs: 0 })).toBe(
      LEADERSHIP_STOP_MS,
    )
    expect(d.hardDeadlineMs).toBe(drainGroupMs(d) + AFTER_DRAIN_BUDGET_MS + HARD_DEADLINE_SLACK_MS)
    expect(d.hardDeadlineMs).toBeLessThanOrEqual(60_000)
  })

  test("a SIGTERM during boot exits 0 without binding the listener or taking the lease", async () => {
    // Boot as index.ts runs it, with the signal landing before the lease and the listener.
    const snippet = `
      import { installShutdownSignals, haltBootIfShuttingDown } from "${import.meta.dir}/shutdown"
      import { startLeadership, isLeader } from "${import.meta.dir}/../infra/leadership"
      import { createServer } from "${import.meta.dir}/server"
      import { Hono } from "hono"
      installShutdownSignals()
      process.kill(process.pid, "SIGTERM")
      await Bun.sleep(20)
      await startLeadership({ role: "all" })
      console.error("leader after signal: " + isLeader())
      await haltBootIfShuttingDown()
      await createServer(new Hono(), { port: 0, healthOnly: true })
      console.error("BOUND")
    `
    const proc = Bun.spawn(["bun", "--env-file=../../.env.test", "-e", snippet], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NODE_ENV: "test", SHUTDOWN_EDGE_GRACE_MS: "0" },
    })
    const code = await proc.exited
    const stderr = await new Response(proc.stderr).text()
    expect(stderr).toContain("leader after signal: false")
    expect(stderr).not.toContain("BOUND")
    expect(code).toBe(0)
  }, 30_000)

  test("a SIGTERM during a boot step: the pools wait for boot to park, and the process exits 0", async () => {
    // A boot step (ensureAppsForOrg, runPhase10Boot) is mid-query when the
    // signal lands: the pools must not close under it, or it throws and boot
    // exits 1 ("Startup failed").
    const snippet = `
      import { installShutdownSignals, haltBootIfShuttingDown, registerShutdownPhase, bootQuiet } from "${import.meta.dir}/shutdown"
      installShutdownSignals()
      let closed = false
      registerShutdownPhase({
        name: "pools",
        at: "after-drain",
        order: 100,
        run: async () => {
          await bootQuiet()
          closed = true
        },
      })
      await haltBootIfShuttingDown()
      process.kill(process.pid, "SIGTERM")
      // The boot step still in flight after the signal.
      await Bun.sleep(300)
      if (closed) {
        console.error("POOL CLOSED UNDER BOOT")
        process.exit(1)
      }
      await haltBootIfShuttingDown()
      console.error("BOOT WENT ON")
    `
    const proc = Bun.spawn(["bun", "--env-file=../../.env.test", "-e", snippet], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NODE_ENV: "test", SHUTDOWN_EDGE_GRACE_MS: "0" },
    })
    const code = await proc.exited
    const stderr = await new Response(proc.stderr).text()
    expect(stderr).not.toContain("POOL CLOSED UNDER BOOT")
    expect(stderr).not.toContain("BOOT WENT ON")
    expect(code).toBe(0)
  }, 30_000)
})
