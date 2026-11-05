// SPDX-License-Identifier: FSL-1.1-ALv2

import { afterEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  acquireSlot,
  formatStatus,
  isDeadProcessState,
  liveWaiters,
  type MemorySample,
  maxLoad,
  maxSwapMb,
  memoryHold,
  memorySampler,
  minFreeMb,
  minIdlePct,
  type ProcessProbe,
  parseDarwinSysctl,
  parseMeminfo,
  readMemory,
  realProbe,
  releaseHeldBy,
  releaseOnFailure,
  slotDir,
} from "./machine-slots"

const created: string[] = []

function freshEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "machine-slots-"))
  created.push(dir)
  return {
    TEST_SLOT_DIR: path.join(dir, "slots"),
    TEST_LOCK_PATH: path.join(dir, "legacy.lock"),
    LIAISON_SLOT_MAX_LOAD: "off",
    LIAISON_SLOT_MIN_IDLE: "off",
    LIAISON_SLOT_MIN_FREE_MB: "off",
    LIAISON_SLOT_MAX_SWAP_MB: "off",
    ...extra,
  }
}

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

/** A fake process table: pid -> start stamp. Absent = not running. */
function fakeProcs(initial: Record<number, string>, ancestors: number[] = []) {
  const table = new Map<number, string>(Object.entries(initial).map(([k, v]) => [Number(k), v]))
  const probe: ProcessProbe = {
    isAlive: (pid) => table.has(pid),
    startTime: (pid) => table.get(pid) ?? null,
    ancestors: () => ancestors,
  }
  return { table, probe }
}

/** A fake clock whose sleep advances time and runs a hook (the world moving on). */
function fakeClock(onTick: (t: number) => void = () => {}) {
  let t = 1_000_000
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms
      onTick(t)
      // Yield to timers and the other acquirers, as a real sleep would.
      await new Promise((r) => setImmediate(r))
    },
  }
}

const quiet = { log: () => {}, installExitHandlers: false, pollMs: 1_000 } as const

describe("zombie holders", () => {
  it("treats a zombie or dead process state as not alive", () => {
    expect(isDeadProcessState("Z")).toBe(true)
    expect(isDeadProcessState("Z+")).toBe(true)
    expect(isDeadProcessState("X")).toBe(true)
    expect(isDeadProcessState("S+")).toBe(false)
    expect(isDeadProcessState("R")).toBe(false)
    expect(isDeadProcessState(null)).toBe(false)
  })

  it("reports a finished child as not alive, reaped or zombie", async () => {
    const { spawn } = await import("node:child_process")
    const { realProbe } = await import("./machine-slots")
    // A child that exits while its parent does not wait for it stays a zombie.
    const child = spawn("sh", ["-c", "exit 0"], { stdio: "ignore" })
    const pid = child.pid as number
    await new Promise((r) => setTimeout(r, 300))
    expect(realProbe.isAlive(pid)).toBe(false)
    expect(realProbe.isAlive(process.pid)).toBe(true)
  })
})

describe("start-time stamping", () => {
  it("records the holder's process start time", async () => {
    const env = freshEnv()
    const { probe } = fakeProcs({ 10: "boot-a 09:00" })
    const lock = await acquireSlot({ cmd: "x", env, pid: 10, probe, ...quiet })
    const rec = JSON.parse(fs.readFileSync(lock.path as string, "utf8"))
    expect(rec.procStart).toBe("boot-a 09:00")
    expect(rec.cwd).toBe(process.cwd())
    lock.release()
  })

  it("treats a dead holder as free", async () => {
    const env = freshEnv({ LIAISON_TEST_SLOTS: "1" })
    const procs = fakeProcs({ 10: "s10", 20: "s20" })
    await acquireSlot({ cmd: "gone", env, pid: 10, probe: procs.probe, ...quiet })
    procs.table.delete(10)
    const b = await acquireSlot({ cmd: "next", env, pid: 20, probe: procs.probe, ...quiet })
    expect(b.slot).toBe(0)
    b.release()
  })

  it("treats a REUSED pid (same pid, another start time) as free", async () => {
    const env = freshEnv({ LIAISON_TEST_SLOTS: "1", TEST_LOCK_WAIT_SEC: "0" })
    const procs = fakeProcs({ 10: "before-reboot", 20: "s20" })
    await acquireSlot({ cmd: "old", env, pid: 10, probe: procs.probe, ...quiet })
    // Same pid, still "alive", but a different process now.
    procs.table.set(10, "after-reboot")
    const b = await acquireSlot({ cmd: "new", env, pid: 20, probe: procs.probe, ...quiet })
    expect(b.slot).toBe(0)
    expect(JSON.parse(fs.readFileSync(b.path as string, "utf8")).cmd).toBe("new")
    b.release()
  })

  it("keeps a live holder with a matching start time", async () => {
    const env = freshEnv({ LIAISON_TEST_SLOTS: "1", TEST_LOCK_WAIT_SEC: "0" })
    const procs = fakeProcs({ 10: "s10", 20: "s20" })
    const a = await acquireSlot({ cmd: "a", env, pid: 10, probe: procs.probe, ...quiet })
    await expect(
      acquireSlot({ cmd: "b", env, pid: 20, probe: procs.probe, ...quiet }),
    ).rejects.toThrow(/slot 0: pid 10/)
    a.release()
  })

  it("the real probe stamps this process and sees its parent as an ancestor", () => {
    expect(realProbe.startTime(process.pid)).toBeTruthy()
    expect(realProbe.startTime(process.pid)).toBe(realProbe.startTime(process.pid))
    expect(realProbe.ancestors()[0]).toBe(process.ppid)
  })
})

describe("FIFO tickets", () => {
  it("serves waiters in arrival order, not polling luck", async () => {
    const env = freshEnv({ LIAISON_TEST_SLOTS: "1" })
    const procs = fakeProcs({ 1: "s1", 2: "s2", 3: "s3", 4: "s4" })
    const holder = await acquireSlot({ cmd: "h", env, pid: 1, probe: procs.probe, ...quiet })
    const order: number[] = []
    const clock = fakeClock()
    const waiter = (pid: number, now: () => number) =>
      acquireSlot({
        cmd: `w${pid}`,
        env,
        pid,
        probe: procs.probe,
        now,
        sleep: clock.sleep,
        ...quiet,
      }).then((lock) => {
        order.push(pid)
        // Hold briefly, then hand over.
        setTimeout(() => lock.release(), 0)
        return lock
      })
    // Arrivals at distinct times: 3 first, then 2, then 4.
    const w3 = waiter(3, () => clock.now())
    await Promise.resolve()
    const w2 = waiter(2, () => clock.now() + 1)
    await Promise.resolve()
    const w4 = waiter(4, () => clock.now() + 2)
    await new Promise((r) => setTimeout(r, 5))
    holder.release()
    await Promise.all([w3, w2, w4])
    expect(order).toEqual([3, 2, 4])
  })

  it("drops a dead waiter's ticket so the queue moves on", async () => {
    const env = freshEnv()
    const procs = fakeProcs({ 5: "s5" })
    fs.mkdirSync(slotDir(env), { recursive: true })
    const ghost = path.join(
      slotDir(env),
      `ticket-${"1".padStart(15, "0")}-${"9".padStart(10, "0")}.wait`,
    )
    fs.writeFileSync(ghost, JSON.stringify({ pid: 9, startedAt: "", cmd: "ghost" }))
    const lock = await acquireSlot({ cmd: "a", env, pid: 5, probe: procs.probe, ...quiet })
    expect(lock.slot).toBe(0)
    expect(fs.existsSync(ghost)).toBe(false)
    lock.release()
  })

  it("removes its own ticket when it gets a slot and when it gives up", async () => {
    const env = freshEnv({ LIAISON_TEST_SLOTS: "1", TEST_LOCK_WAIT_SEC: "0" })
    const procs = fakeProcs({ 1: "s1", 2: "s2" })
    const a = await acquireSlot({ cmd: "a", env, pid: 1, probe: procs.probe, ...quiet })
    expect(liveWaiters(env, procs.probe)).toEqual([])
    await expect(
      acquireSlot({ cmd: "b", env, pid: 2, probe: procs.probe, ...quiet }),
    ).rejects.toThrow()
    expect(liveWaiters(env, procs.probe)).toEqual([])
    a.release()
  })
})

describe("load gate", () => {
  it("defaults to the core count on macOS, off elsewhere, and honours LIAISON_SLOT_MAX_LOAD", () => {
    expect(maxLoad({}, "darwin", 10)).toBe(10)
    expect(maxLoad({}, "darwin", 0)).toBe(1)
    expect(maxLoad({}, "linux")).toBe(0)
    expect(maxLoad({ LIAISON_SLOT_MAX_LOAD: "12" }, "darwin")).toBe(12)
    expect(maxLoad({ LIAISON_SLOT_MAX_LOAD: "6" }, "linux")).toBe(6)
    expect(maxLoad({ LIAISON_SLOT_MAX_LOAD: "off" }, "darwin")).toBe(0)
    expect(maxLoad({ LIAISON_SLOT_MAX_LOAD: "0" }, "darwin")).toBe(0)
  })

  it("holds a new job back while the load is at or above the gate, even with a free slot", async () => {
    const env = freshEnv({ LIAISON_SLOT_MAX_LOAD: "8" })
    const procs = fakeProcs({ 1: "s1" })
    let load = 20
    const lines: string[] = []
    const clock = fakeClock((t) => {
      if (t >= 1_000_000 + 5_000) load = 7.5
    })
    const lock = await acquireSlot({
      cmd: "a",
      env,
      pid: 1,
      probe: procs.probe,
      loadAvg: () => load,
      ...clock,
      ...quiet,
      log: (m) => lines.push(m),
      logEveryMs: 1,
    })
    expect(clock.now() - 1_000_000).toBeGreaterThanOrEqual(5_000)
    expect(lines.join("\n")).toContain("load 20.0 is at or above LIAISON_SLOT_MAX_LOAD 8")
    lock.release()
  })

  it("lets a job start over the load gate when the CPUs are idle (load from disk waits)", async () => {
    const env = freshEnv({ LIAISON_SLOT_MAX_LOAD: "8", LIAISON_SLOT_MIN_IDLE: "25" })
    const procs = fakeProcs({ 1: "s1" })
    const lock = await acquireSlot({
      cmd: "a",
      env,
      pid: 1,
      probe: procs.probe,
      loadAvg: () => 20,
      cpuIdle: () => 60,
      ...quiet,
    })
    expect(lock.bypassed).toBe(false)
    lock.release()
  })

  it("holds a job back over the gate while the CPUs are busy, and says how busy", async () => {
    const env = freshEnv({
      LIAISON_SLOT_MAX_LOAD: "8",
      LIAISON_SLOT_MIN_IDLE: "25",
      TEST_LOCK_WAIT_SEC: "0",
    })
    const procs = fakeProcs({ 1: "s1" })
    await expect(
      acquireSlot({
        cmd: "a",
        env,
        pid: 1,
        probe: procs.probe,
        loadAvg: () => 20,
        cpuIdle: () => 3,
        ...quiet,
      }),
    ).rejects.toThrow(
      /load 20.0 is at or above LIAISON_SLOT_MAX_LOAD 8 and the CPUs are busy \(3% idle\)/,
    )
  })

  it("reads LIAISON_SLOT_MIN_IDLE: a percentage, 25 by default, off to let the load alone decide", () => {
    expect(minIdlePct({})).toBe(25)
    expect(minIdlePct({ LIAISON_SLOT_MIN_IDLE: "40" })).toBe(40)
    expect(minIdlePct({ LIAISON_SLOT_MIN_IDLE: "off" })).toBeNull()
    expect(minIdlePct({ LIAISON_SLOT_MIN_IDLE: "abc" })).toBe(25)
  })

  it("applies at acquire only: a holder keeps its slot whatever the load does after", async () => {
    const env = freshEnv({ LIAISON_SLOT_MAX_LOAD: "8", TEST_LOCK_WAIT_SEC: "0" })
    const procs = fakeProcs({ 1: "s1", 2: "s2" })
    let load = 1
    const a = await acquireSlot({
      cmd: "a",
      env,
      pid: 1,
      probe: procs.probe,
      loadAvg: () => load,
      ...quiet,
    })
    load = 50
    // The holder's record is untouched; only the newcomer is held back.
    expect(fs.existsSync(a.path as string)).toBe(true)
    await expect(
      acquireSlot({ cmd: "b", env, pid: 2, probe: procs.probe, loadAvg: () => load, ...quiet }),
    ).rejects.toThrow(/load 50.0/)
    expect(JSON.parse(fs.readFileSync(a.path as string, "utf8")).pid).toBe(1)
    a.release()
  })
})

describe("memory gate", () => {
  it("defaults to 1024 MB free and 4096 MB swap on macOS, off elsewhere, and honours the variables", () => {
    expect(minFreeMb({}, "darwin")).toBe(1024)
    expect(maxSwapMb({}, "darwin")).toBe(4096)
    expect(minFreeMb({}, "linux")).toBe(0)
    expect(maxSwapMb({}, "linux")).toBe(0)
    expect(minFreeMb({ LIAISON_SLOT_MIN_FREE_MB: "2048" }, "linux")).toBe(2048)
    expect(maxSwapMb({ LIAISON_SLOT_MAX_SWAP_MB: "512" }, "darwin")).toBe(512)
    expect(minFreeMb({ LIAISON_SLOT_MIN_FREE_MB: "off" }, "darwin")).toBe(0)
    expect(maxSwapMb({ LIAISON_SLOT_MAX_SWAP_MB: "0" }, "darwin")).toBe(0)
  })

  it("reads macOS sysctl output and /proc/meminfo", () => {
    const mac = parseDarwinSysctl(
      "16384\n4381\n24327\n188357\n4387\ntotal = 3072.00M  used = 1388.69M  free = 1683.31M  (encrypted)\n",
    )
    expect(Math.round(mac?.availableMb ?? 0)).toBe(
      Math.round(((4381 + 24327 + 188357 + 4387) * 16384) / 1048576),
    )
    expect(mac?.swapUsedMb).toBeCloseTo(1388.69)
    expect(mac?.pressureLevel).toBeUndefined()
    const withPressure = parseDarwinSysctl(
      "16384\n4381\n24327\n188357\n4387\ntotal = 3072.00M  used = 1388.69M  free = 1683.31M  (encrypted)\n2\n",
    )
    expect(withPressure?.pressureLevel).toBe(2)
    expect(parseDarwinSysctl("garbage")).toBeNull()
    const linux = parseMeminfo(
      "MemTotal: 100 kB\nMemAvailable:    2097152 kB\nSwapTotal: 1048576 kB\nSwapFree: 524288 kB\n",
    )
    expect(linux).toEqual({ availableMb: 2048, swapUsedMb: 512 })
  })

  it("the sampler reads once per interval", () => {
    let reads = 0
    let t = 0
    const sample = memorySampler(
      () => ({ availableMb: ++reads, swapUsedMb: 0 }),
      1_000,
      () => t,
    )
    sample()
    sample()
    expect(reads).toBe(1)
    t = 1_000
    sample()
    expect(reads).toBe(2)
  })

  it("holds a newcomer while available memory is low, and lets it in once memory recovers", async () => {
    const env = freshEnv({ LIAISON_SLOT_MIN_FREE_MB: "3072" })
    const procs = fakeProcs({ 1: "s1" })
    let mem: MemorySample = { availableMb: 1500, swapUsedMb: 1400 }
    const lines: string[] = []
    const clock = fakeClock((t) => {
      if (t >= 1_000_000 + 6_000) mem = { availableMb: 5000, swapUsedMb: 1400 }
    })
    const lock = await acquireSlot({
      cmd: "a",
      env,
      pid: 1,
      probe: procs.probe,
      memory: () => mem,
      ...clock,
      ...quiet,
      log: (m) => lines.push(m),
      logEveryMs: 1,
    })
    expect(clock.now() - 1_000_000).toBeGreaterThanOrEqual(6_000)
    expect(lines.join("\n")).toContain(
      "available memory 1500 MB is below LIAISON_SLOT_MIN_FREE_MB 3072 (swap used 1400 MB)",
    )
    lock.release()
  })

  it("holds on the kernel's warn or critical pressure, never at normal", () => {
    // A busy Mac at normal pressure: little free + cached-file memory, most of it reclaimable.
    expect(
      memoryHold({ availableMb: 2500, swapUsedMb: 2000, pressureLevel: 1 }, 1024, 4096),
    ).toBeNull()
    expect(memoryHold({ availableMb: 2500, swapUsedMb: 2000, pressureLevel: 2 }, 1024, 4096)).toBe(
      "macOS memory pressure is warn (available memory 2500 MB, swap used 2000 MB)",
    )
    expect(
      memoryHold({ availableMb: 2500, swapUsedMb: 2000, pressureLevel: 4 }, 1024, 4096),
    ).toContain("is critical")
    // Stale swap under normal pressure holds nothing; under warn it would.
    expect(
      memoryHold({ availableMb: 5000, swapUsedMb: 4800, pressureLevel: 1 }, 1024, 4096),
    ).toBeNull()
    expect(memoryHold({ availableMb: 5000, swapUsedMb: 4800 }, 1024, 4096)).toContain(
      "swap used 4800 MB",
    )
    // The free-memory backstop still holds at normal pressure.
    expect(memoryHold({ availableMb: 800, swapUsedMb: 0, pressureLevel: 1 }, 1024, 4096)).toContain(
      "below LIAISON_SLOT_MIN_FREE_MB 1024",
    )
  })

  it("holds a newcomer while swap in use is above the gate, and names both numbers", async () => {
    const env = freshEnv({ LIAISON_SLOT_MAX_SWAP_MB: "4096", TEST_LOCK_WAIT_SEC: "0" })
    const procs = fakeProcs({ 1: "s1" })
    await expect(
      acquireSlot({
        cmd: "a",
        env,
        pid: 1,
        probe: procs.probe,
        memory: () => ({ availableMb: 8000, swapUsedMb: 5000 }),
        ...quiet,
      }),
    ).rejects.toThrow(
      /swap used 5000 MB is above LIAISON_SLOT_MAX_SWAP_MB 4096 \(available memory 8000 MB\)/,
    )
  })

  it("never revokes a holder when memory drops after it started", async () => {
    const env = freshEnv({ LIAISON_SLOT_MIN_FREE_MB: "3072", TEST_LOCK_WAIT_SEC: "0" })
    const procs = fakeProcs({ 1: "s1", 2: "s2" })
    let mem: MemorySample = { availableMb: 9000, swapUsedMb: 0 }
    const a = await acquireSlot({
      cmd: "a",
      env,
      pid: 1,
      probe: procs.probe,
      memory: () => mem,
      ...quiet,
    })
    mem = { availableMb: 200, swapUsedMb: 6000 }
    await expect(
      acquireSlot({ cmd: "b", env, pid: 2, probe: procs.probe, memory: () => mem, ...quiet }),
    ).rejects.toThrow(/available memory 200 MB/)
    expect(JSON.parse(fs.readFileSync(a.path as string, "utf8")).pid).toBe(1)
    a.release()
  })

  it("opt-out: off reads no memory and lets a job start whatever memory says", async () => {
    const env = freshEnv({ TEST_LOCK_WAIT_SEC: "0" })
    const procs = fakeProcs({ 1: "s1" })
    let reads = 0
    const lock = await acquireSlot({
      cmd: "a",
      env,
      pid: 1,
      probe: procs.probe,
      platform: "darwin",
      memory: () => {
        reads++
        return { availableMb: 10, swapUsedMb: 99_999 }
      },
      ...quiet,
    })
    expect(lock.slot).toBe(0)
    expect(reads).toBe(0)
    lock.release()
  })

  it("an unreadable memory sample does not hold a job back", async () => {
    const env = freshEnv({ LIAISON_SLOT_MIN_FREE_MB: "3072", TEST_LOCK_WAIT_SEC: "0" })
    const procs = fakeProcs({ 1: "s1" })
    const lines: string[] = []
    const lock = await acquireSlot({
      cmd: "a",
      env,
      pid: 1,
      probe: procs.probe,
      memory: () => null,
      ...quiet,
      log: (m) => lines.push(m),
    })
    expect(lock.slot).toBe(0)
    expect(lines.join("\n")).toContain("memory is unreadable")
    lock.release()
  })

  it("the real reader returns plausible numbers on this machine", async () => {
    const m = readMemory()
    expect(m).not.toBeNull()
    expect(m?.availableMb).toBeGreaterThan(0)
    expect(m?.availableMb).toBeLessThan(os.totalmem() / 1048576 + 1)
    expect(m?.swapUsedMb).toBeGreaterThanOrEqual(0)
  })
})

describe("preflight failure", () => {
  it("releases the slot at once when the preflight throws", async () => {
    const env = freshEnv({ LIAISON_TEST_SLOTS: "1", TEST_LOCK_WAIT_SEC: "0" })
    const procs = fakeProcs({ 1: "s1", 2: "s2" })
    const a = await acquireSlot({ cmd: "a", env, pid: 1, probe: procs.probe, ...quiet })
    await expect(
      releaseOnFailure(a, () => {
        throw new Error("postgres is down")
      }),
    ).rejects.toThrow("postgres is down")
    // The holder (pid 1) is still alive, yet the next job gets the slot now.
    const b = await acquireSlot({ cmd: "b", env, pid: 2, probe: procs.probe, ...quiet })
    expect(b.slot).toBe(0)
    b.release()
  })

  it("releases on a false result and keeps the slot on success", async () => {
    const env = freshEnv({ LIAISON_TEST_SLOTS: "1" })
    const procs = fakeProcs({ 1: "s1" })
    const a = await acquireSlot({ cmd: "a", env, pid: 1, probe: procs.probe, ...quiet })
    expect(await releaseOnFailure(a, () => true)).toBe(true)
    expect(fs.existsSync(a.path as string)).toBe(true)
    expect(await releaseOnFailure(a, async () => false)).toBe(false)
    expect(fs.existsSync(a.path as string)).toBe(false)
  })
})

describe("leases and ancestors", () => {
  it("a slot leased to an ancestor covers its descendants without a second slot", async () => {
    const env = freshEnv({ LIAISON_TEST_SLOTS: "1", TEST_LOCK_WAIT_SEC: "0" })
    const procs = fakeProcs({ 700: "runner-worker" }, [650, 700, 1])
    await acquireSlot({ cmd: "ci job", env, pid: 700, probe: procs.probe, ...quiet })
    const inner = await acquireSlot({ cmd: "bun run typecheck", env, probe: procs.probe, ...quiet })
    expect(inner.inherited).toBe(true)
    expect(inner.path).toBeNull()
  })

  it("releaseHeldBy gives back a lease and leaves other holders alone", async () => {
    const env = freshEnv()
    const procs = fakeProcs({ 700: "w", 800: "x" })
    await acquireSlot({ cmd: "lease", env, pid: 700, probe: procs.probe, ...quiet })
    const other = await acquireSlot({ cmd: "other", env, pid: 800, probe: procs.probe, ...quiet })
    expect(releaseHeldBy(700, env)).toBe(1)
    expect(fs.existsSync(other.path as string)).toBe(true)
    other.release()
  })
})

describe("status", () => {
  it("lists holders with pid, age, cwd and command, waiters in order, and the load", async () => {
    const env = freshEnv({ LIAISON_SLOT_MAX_LOAD: "8" })
    const procs = fakeProcs({ 1: "s1", 9: "s9" })
    const t0 = Date.parse("2026-11-02T10:00:00Z")
    const a = await acquireSlot({
      cmd: "test-run.ts unit",
      env,
      pid: 1,
      probe: procs.probe,
      now: () => t0,
      // The machine's own load and memory must not hold this acquire back.
      loadAvg: () => 1,
      memory: () => ({ availableMb: 8192, swapUsedMb: 0 }),
      ...quiet,
    })
    fs.writeFileSync(
      path.join(slotDir(env), `ticket-${"5".padStart(15, "0")}-${"9".padStart(10, "0")}.wait`),
      JSON.stringify({ pid: 9, startedAt: "2026-11-02T10:04:00Z", cmd: "tsc", cwd: "/w" }),
    )
    const out = formatStatus({
      env,
      probe: procs.probe,
      now: t0 + 600_000,
      load: 3.25,
      memory: { availableMb: 5120.4, swapUsedMb: 1388.7 },
      platform: "darwin",
    })
    expect(out).toContain("1/2 held, load 3.3 (new jobs wait at 8)")
    expect(out).toContain("memory: available memory 5120 MB, swap used 1389 MB (no memory gate)")
    expect(out).toContain(`slot 0: pid 1, 10m, cwd ${process.cwd()}, test-run.ts unit`)
    expect(out).toContain("slot 1: free")
    expect(out).toContain("1. pid 9, 6m, cwd /w, tsc")
    a.release()
  })
})
