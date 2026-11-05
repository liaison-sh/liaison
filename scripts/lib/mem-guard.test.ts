// SPDX-License-Identifier: FSL-1.1-ALv2
// The thresholds are driven with fixed samples, so every number in the trip
// rule is pinned rather than inferred from whatever this machine happens to
// have free. The tree kill is driven against a REAL process tree spawned here:
// the bug it guards is that a run keeps its children alive, and asserting that
// a function calls process.kill would not have caught that.
import { afterEach, describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  collectTree,
  decideMemGuard,
  formatMemGuard,
  formatTopProcesses,
  formatTripLine,
  HYSTERESIS_BYTES,
  killProcessTree,
  killProcessTreeNow,
  LOW_SAMPLES_TO_TRIP,
  MEM_GUARD_EXIT_CODE,
  type MemGuardThresholds,
  memGuardEnabled,
  memGuardPollMs,
  type ProcRow,
  parseMemAvailable,
  parsePsOutput,
  parseVmStat,
  readAvailableBytes,
  readProcessTable,
  startMemGuard,
  sumRss,
  TRIP_FILE_NAME,
  topProcesses,
} from "./mem-guard"

const MIB = 1024 * 1024
const GIB = 1024 * MIB

const THRESHOLDS: MemGuardThresholds = {
  reserveBytes: 8 * GIB,
  hysteresisBytes: 512 * MIB,
  budgetBytes: 8 * GIB,
  lowSamplesToTrip: 2,
}

const tmpDirs: string[] = []
const strays: number[] = []

afterEach(async () => {
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid, 9)
    } catch {
      /* already gone */
    }
  }
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tmpDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mem-guard-"))
  tmpDirs.push(dir)
  return dir
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await Bun.sleep(25)
  }
  return predicate()
}

describe("decideMemGuard", () => {
  it("on macOS counts low available memory only under the kernel's warn or critical pressure", () => {
    const low = { availableBytes: 5 * GIB, treeRssBytes: GIB }
    const calm = decideMemGuard({ ...low, pressureLevel: 1 }, THRESHOLDS, 5)
    expect(calm.trip).toBe(false)
    expect(calm.lowStreak).toBe(0)
    const warn = decideMemGuard({ ...low, pressureLevel: 2 }, THRESHOLDS, 1)
    expect(warn).toMatchObject({ trip: true, reason: "available" })
    // The tree's own budget still trips at normal pressure.
    const fat = decideMemGuard(
      { availableBytes: 12 * GIB, treeRssBytes: 100 * GIB, pressureLevel: 1 },
      THRESHOLDS,
    )
    expect(fat).toMatchObject({ trip: true, reason: "tree-rss" })
  })

  it("does not trip with plenty available and a small tree", () => {
    const d = decideMemGuard({ availableBytes: 12 * GIB, treeRssBytes: 2 * GIB }, THRESHOLDS)
    expect(d.trip).toBe(false)
    expect(d.lowStreak).toBe(0)
    expect(d.floorBytes).toBe(7680 * MIB)
  })

  it("does not trip in the hysteresis band just under the reserve", () => {
    // 7.9 GiB available is under the 8 GiB reserve but above the 7.5 GiB floor.
    const d = decideMemGuard(
      { availableBytes: Math.floor(7.9 * GIB), treeRssBytes: GIB },
      THRESHOLDS,
    )
    expect(d.trip).toBe(false)
    expect(d.lowStreak).toBe(0)
  })

  it("needs two consecutive low samples and not one", () => {
    const low = { availableBytes: 2 * GIB, treeRssBytes: GIB }
    const first = decideMemGuard(low, THRESHOLDS, 0)
    expect(first.trip).toBe(false)
    expect(first.lowStreak).toBe(1)
    const second = decideMemGuard(low, THRESHOLDS, first.lowStreak)
    expect(second.trip).toBe(true)
    expect(second.reason).toBe("available")
    expect(second.lowStreak).toBe(2)
  })

  it("resets the streak when a sample recovers", () => {
    const first = decideMemGuard({ availableBytes: 2 * GIB, treeRssBytes: GIB }, THRESHOLDS, 0)
    expect(first.lowStreak).toBe(1)
    const recovered = decideMemGuard(
      { availableBytes: 12 * GIB, treeRssBytes: GIB },
      THRESHOLDS,
      first.lowStreak,
    )
    expect(recovered.trip).toBe(false)
    expect(recovered.lowStreak).toBe(0)
    const again = decideMemGuard(
      { availableBytes: 2 * GIB, treeRssBytes: GIB },
      THRESHOLDS,
      recovered.lowStreak,
    )
    expect(again.trip).toBe(false)
    expect(again.lowStreak).toBe(1)
  })

  it("trips on the first sample when the tree is over its budget", () => {
    const d = decideMemGuard({ availableBytes: 20 * GIB, treeRssBytes: 9 * GIB }, THRESHOLDS, 0)
    expect(d.trip).toBe(true)
    expect(d.reason).toBe("tree-rss")
  })

  it("treats a budget of zero as no tree ceiling", () => {
    const d = decideMemGuard(
      { availableBytes: 20 * GIB, treeRssBytes: 9 * GIB },
      { ...THRESHOLDS, budgetBytes: 0 },
    )
    expect(d.trip).toBe(false)
  })

  it("floors at zero when the hysteresis exceeds the reserve", () => {
    const d = decideMemGuard(
      { availableBytes: 1, treeRssBytes: 1 },
      { ...THRESHOLDS, reserveBytes: 100 * MIB, budgetBytes: 0 },
    )
    expect(d.floorBytes).toBe(0)
    expect(d.trip).toBe(false)
  })
})

describe("parseMemAvailable", () => {
  it("reads MemAvailable in bytes", () => {
    const meminfo = [
      "MemTotal:       32793320 kB",
      "MemFree:          812344 kB",
      "MemAvailable:   20680276 kB",
      "Buffers:          220116 kB",
    ].join("\n")
    expect(parseMemAvailable(meminfo)).toBe(20_680_276 * 1024)
  })

  it("is null on a kernel too old to report it", () => {
    expect(parseMemAvailable("MemTotal: 100 kB\nMemFree: 50 kB")).toBe(null)
  })
})

describe("parseVmStat", () => {
  const VM_STAT = [
    "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
    "Pages free:                                8000.",
    "Pages active:                            400000.",
    "Pages inactive:                           12000.",
    "Pages speculative:                         3000.",
    "Pages wired down:                        200000.",
    "Pages purgeable:                            500.",
    "Pages purged:                          17691050.",
  ].join("\n")

  it("adds free, inactive, speculative and purgeable pages at the reported page size", () => {
    const parsed = parseVmStat(VM_STAT)
    expect(parsed?.pageSizeBytes).toBe(16384)
    expect(parsed?.freePages).toBe(8000)
    expect(parsed?.inactivePages).toBe(12000)
    expect(parsed?.speculativePages).toBe(3000)
    // The cumulative "Pages purged" counter must not be read as purgeable.
    expect(parsed?.purgeablePages).toBe(500)
    expect(parsed?.availableBytes).toBe((8000 + 12000 + 3000 + 500) * 16384)
  })

  it("counts a missing speculative or purgeable line as zero pages", () => {
    const parsed = parseVmStat(
      [
        "Mach Virtual Memory Statistics: (page size of 4096 bytes)",
        "Pages free:                                100.",
        "Pages inactive:                            200.",
      ].join("\n"),
    )
    expect(parsed?.availableBytes).toBe(300 * 4096)
  })

  it("is null when the page size line is missing", () => {
    expect(parseVmStat("Pages free: 10.")).toBe(null)
  })
})

describe("parsePsOutput", () => {
  const PS = [
    "    1     0  12000 /sbin/launchd",
    " 4200     1 350000 bun run scripts/test-run.ts unit",
    " 4201  4200 900000 bun test --env-file=/x/.env.test src/modules",
    "  bad row",
    " 4202  4201  12345 sh -c echo hello world",
  ].join("\n")

  it("keeps spaces in the command and converts rss from KiB", () => {
    const rows = parsePsOutput(PS)
    expect(rows).toHaveLength(4)
    expect(rows[1]).toEqual({
      pid: 4200,
      ppid: 1,
      rssBytes: 350_000 * 1024,
      command: "bun run scripts/test-run.ts unit",
    })
    expect(rows[3].command).toBe("sh -c echo hello world")
  })

  it("skips lines that are not process rows", () => {
    expect(parsePsOutput("PID PPID RSS COMMAND\n\n").length).toBe(0)
  })
})

describe("collectTree", () => {
  const ROWS: ProcRow[] = [
    { pid: 1, ppid: 0, rssBytes: 10 * MIB, command: "init" },
    { pid: 100, ppid: 1, rssBytes: 100 * MIB, command: "runner" },
    { pid: 101, ppid: 100, rssBytes: 300 * MIB, command: "suite" },
    { pid: 102, ppid: 101, rssBytes: 500 * MIB, command: "worker" },
    { pid: 200, ppid: 1, rssBytes: 900 * MIB, command: "unrelated browser" },
  ]

  it("includes the root, its children and its grandchildren only", () => {
    const tree = collectTree(ROWS, 100)
    expect(tree.map((r) => r.pid)).toEqual([100, 101, 102])
    expect(sumRss(tree)).toBe(900 * MIB)
  })

  it("never walks up to an ancestor", () => {
    expect(collectTree(ROWS, 101).map((r) => r.pid)).toEqual([101, 102])
  })

  it("is empty when the root is gone", () => {
    expect(collectTree(ROWS, 999)).toEqual([])
  })

  it("terminates on a ppid cycle from pid reuse", () => {
    const cyclic: ProcRow[] = [
      { pid: 10, ppid: 11, rssBytes: MIB, command: "a" },
      { pid: 11, ppid: 10, rssBytes: MIB, command: "b" },
    ]
    expect(collectTree(cyclic, 10).map((r) => r.pid)).toEqual([10, 11])
  })

  it("ranks the top processes by rss", () => {
    expect(topProcesses(ROWS, 2).map((r) => r.pid)).toEqual([200, 102])
  })
})

describe("guard messages", () => {
  it("reports the available-memory trip with every number and no dash punctuation", () => {
    const sample = { availableBytes: 2 * GIB, treeRssBytes: 5 * GIB }
    const decision = decideMemGuard(sample, THRESHOLDS, 1)
    const line = formatTripLine("available", sample, decision, THRESHOLDS)
    expect(line).toContain("2048 MB of memory is available")
    expect(line).toContain("under the floor of 7680 MB")
    expect(line).toContain("reserve 8192 MB minus 512 MB of hysteresis")
    expect(line).toContain("for 2 samples in a row")
    expect(line).toContain("5120 MB")
    expect(line).not.toMatch(/--|–|—/)
  })

  it("reports the tree-rss trip with the budget it exceeded", () => {
    const sample = { availableBytes: 20 * GIB, treeRssBytes: 9 * GIB }
    const decision = decideMemGuard(sample, THRESHOLDS, 0)
    const line = formatTripLine("tree-rss", sample, decision, THRESHOLDS)
    expect(line).toContain("9216 MB")
    expect(line).toContain("over its budget of 8192 MB")
    expect(line).not.toMatch(/--|–|—/)
  })

  it("lists at most five processes with pid and rss", () => {
    const rows: ProcRow[] = Array.from({ length: 9 }, (_, i) => ({
      pid: 500 + i,
      ppid: 500,
      rssBytes: (i + 1) * 100 * MIB,
      command: `child ${i}`,
    }))
    const lines = formatTopProcesses(rows)
    expect(lines).toHaveLength(5)
    expect(lines[0]).toContain("pid 508")
    expect(lines[0]).toContain("900 MB")
    expect(lines.join("\n")).not.toMatch(/--|–|—/)
  })

  it("announces the armed banner and the disabled banner without dash punctuation", () => {
    const armed = formatMemGuard(8192, 8192, {})
    expect(armed).toContain("armed")
    expect(armed).toContain("every 2000 ms")
    expect(armed).toContain(`${LOW_SAMPLES_TO_TRIP} samples`)
    expect(armed).toContain("7680 MB available")
    expect(armed).not.toMatch(/--|–|—/)
    expect(formatMemGuard(8192, 8192, { TEST_MEM_GUARD: "0" })).toContain("DISABLED")
  })
})

describe("knobs", () => {
  it("is enabled unless TEST_MEM_GUARD is exactly 0", () => {
    expect(memGuardEnabled({})).toBe(true)
    expect(memGuardEnabled({ TEST_MEM_GUARD: "1" })).toBe(true)
    expect(memGuardEnabled({ TEST_MEM_GUARD: "" })).toBe(true)
    expect(memGuardEnabled({ TEST_MEM_GUARD: "0" })).toBe(false)
  })

  it("honours TEST_MEM_GUARD_POLL_MS and ignores nonsense", () => {
    expect(memGuardPollMs({})).toBe(2000)
    expect(memGuardPollMs({ TEST_MEM_GUARD_POLL_MS: "250" })).toBe(250)
    expect(memGuardPollMs({ TEST_MEM_GUARD_POLL_MS: "10" })).toBe(2000)
    expect(memGuardPollMs({ TEST_MEM_GUARD_POLL_MS: "nope" })).toBe(2000)
  })

  it("keeps the hysteresis at 512 MB", () => {
    expect(HYSTERESIS_BYTES).toBe(512 * MIB)
  })
})

describe("startMemGuard", () => {
  it("TEST_MEM_GUARD=0 returns an unarmed handle and says so loudly", () => {
    const lines: string[] = []
    const handle = startMemGuard({
      budgetMb: 8192,
      reserveMb: 8192,
      logDir: tmpDir(),
      label: "unit",
      env: { TEST_MEM_GUARD: "0" },
      log: (m) => lines.push(m),
      exit: () => {
        throw new Error("must not exit")
      },
      readAvailable: () => 0,
      readTable: () => [],
    })
    expect(handle.armed).toBe(false)
    expect(lines.join("\n")).toContain("memory guard DISABLED by TEST_MEM_GUARD=0")
    handle.stop()
  })

  it("trips on sustained low memory: writes the report, kills the tree, exits non-zero", async () => {
    const dir = tmpDir()
    const lines: string[] = []
    const killed: number[] = []
    // An array, not a nullable let: TypeScript narrows a let that is only ever
    // assigned inside a callback to its initial type.
    const exits: number[] = []
    const handle = startMemGuard({
      budgetMb: 8192,
      reserveMb: 8192,
      logDir: dir,
      label: "integration",
      rootPid: 100,
      env: { TEST_MEM_GUARD_POLL_MS: "100" },
      pollMs: 20,
      log: (m) => lines.push(m),
      exit: (code) => {
        exits.push(code)
      },
      readAvailable: () => 1 * GIB,
      readTable: () => [
        { pid: 100, ppid: 1, rssBytes: 200 * MIB, command: "bun run scripts/test-run.ts" },
        { pid: 101, ppid: 100, rssBytes: 700 * MIB, command: "bun test src/modules" },
      ],
      killTree: async (pid) => {
        killed.push(pid)
        return [101, 100]
      },
    })
    expect(handle.armed).toBe(true)
    await waitFor(() => exits.length > 0, 5_000)
    handle.stop()

    expect(exits).toEqual([MEM_GUARD_EXIT_CODE])
    expect(killed).toEqual([100])
    const reportPath = path.join(dir, TRIP_FILE_NAME)
    expect(existsSync(reportPath)).toBe(true)
    const report = JSON.parse(readFileSync(reportPath, "utf8"))
    expect(report.reason).toBe("available")
    expect(report.label).toBe("integration")
    expect(report.availableMb).toBe(1024)
    expect(report.floorMb).toBe(7680)
    expect(report.treeRssMb).toBe(900)
    expect(report.lowStreak).toBe(2)
    expect(report.top[0]).toMatchObject({ pid: 101, rssMb: 700 })
    expect(lines.join("\n")).toContain("MEMORY GUARD TRIPPED")
    expect(lines.join("\n")).toContain("signalled 2 processes")
  })

  it("writes the report into the directory handed to setLogDir", async () => {
    const first = tmpDir()
    const second = tmpDir()
    let exitCode: number | null = null
    const handle = startMemGuard({
      budgetMb: 1024,
      reserveMb: 8192,
      logDir: first,
      label: "unit",
      rootPid: 100,
      pollMs: 20,
      log: () => {},
      exit: (code) => {
        exitCode = code
      },
      readAvailable: () => 20 * GIB,
      readTable: () => [{ pid: 100, ppid: 1, rssBytes: 4096 * MIB, command: "bun test" }],
      killTree: async () => [],
    })
    handle.setLogDir(second)
    await waitFor(() => exitCode !== null, 5_000)
    handle.stop()
    expect(existsSync(path.join(second, TRIP_FILE_NAME))).toBe(true)
    expect(existsSync(path.join(first, TRIP_FILE_NAME))).toBe(false)
  })

  it("never trips while the readings fail", async () => {
    let exitCode: number | null = null
    const handle = startMemGuard({
      budgetMb: 8192,
      reserveMb: 8192,
      logDir: tmpDir(),
      label: "unit",
      rootPid: 100,
      pollMs: 20,
      log: () => {},
      exit: (code) => {
        exitCode = code
      },
      readAvailable: () => null,
      readTable: () => [],
      killTree: async () => [],
    })
    await Bun.sleep(300)
    handle.stop()
    expect(exitCode).toBe(null)
  })

  it("stop() ends the sampling", async () => {
    let samples = 0
    let exitCode: number | null = null
    const handle = startMemGuard({
      budgetMb: 8192,
      reserveMb: 8192,
      logDir: tmpDir(),
      label: "unit",
      rootPid: 100,
      pollMs: 20,
      log: () => {},
      exit: (code) => {
        exitCode = code
      },
      readAvailable: () => {
        samples++
        return 20 * GIB
      },
      readTable: () => [{ pid: 100, ppid: 1, rssBytes: MIB, command: "x" }],
      killTree: async () => [],
    })
    await Bun.sleep(200)
    handle.stop()
    const seen = samples
    await Bun.sleep(200)
    expect(samples).toBe(seen)
    expect(exitCode).toBe(null)
  })
})

// The process-tree kill runs against processes that really exist on this
// machine. A fake kill() would pass while the real thing leaked children, which
// is the exact failure this guard exists to stop.
describe("killProcessTree against a real tree", () => {
  async function spawnTree(): Promise<{ root: number; descendants: number[] }> {
    const dir = tmpDir()
    const script = path.join(dir, "tree.sh")
    // A parent that outlives its own spawn, with two children of its own, so the
    // walk has a grandchild level to find.
    await Bun.write(
      script,
      ["#!/bin/sh", "sleep 300 &", "sleep 300 &", "echo $1 $2 > /dev/null", "wait"].join("\n"),
    )
    const proc = Bun.spawn(["sh", script], { stdout: "ignore", stderr: "ignore" })
    const root = proc.pid
    strays.push(root)
    // Wait until ps can see the grandchildren.
    await waitFor(() => collectTree(readProcessTable(), root).length >= 3, 10_000)
    const tree = collectTree(readProcessTable(), root)
    const descendants = tree.filter((r) => r.pid !== root).map((r) => r.pid)
    for (const pid of descendants) strays.push(pid)
    expect(descendants.length).toBeGreaterThanOrEqual(2)
    return { root, descendants }
  }

  it("kills the root and every descendant, and reports which pids it signalled", async () => {
    const { root, descendants } = await spawnTree()
    expect(alive(root)).toBe(true)
    for (const pid of descendants) expect(alive(pid)).toBe(true)

    const signalled = await killProcessTree(root, { graceMs: 500 })
    expect(signalled).toContain(root)
    for (const pid of descendants) expect(signalled).toContain(pid)

    expect(await waitFor(() => !alive(root), 10_000)).toBe(true)
    for (const pid of descendants) {
      expect(await waitFor(() => !alive(pid), 10_000)).toBe(true)
    }
  }, 30_000)

  // The runner excludes its OWN pid so it lives to write the report and exit with
  // a message. Proven here on a descendant instead, because excluding the root of
  // a spawned tree proves nothing: that `sh` exits on its own the moment its
  // `wait` returns.
  it("never signals the excluded pid", async () => {
    const { root, descendants } = await spawnTree()
    const spared = descendants[0]
    const signalled = await killProcessTree(root, { graceMs: 500, excludePid: spared })
    expect(signalled).not.toContain(spared)
    expect(signalled).toContain(root)
    expect(alive(spared)).toBe(true)
    for (const pid of descendants.filter((p) => p !== spared)) {
      expect(await waitFor(() => !alive(pid), 10_000)).toBe(true)
    }
    expect(alive(spared)).toBe(true)
  }, 30_000)

  it("signals leaves before their parents", async () => {
    const rows: ProcRow[] = [
      { pid: 10, ppid: 1, rssBytes: MIB, command: "parent" },
      { pid: 11, ppid: 10, rssBytes: MIB, command: "child" },
      { pid: 12, ppid: 11, rssBytes: MIB, command: "grandchild" },
    ]
    const order: Array<[number, number]> = []
    const signalled = await killProcessTree(10, {
      rows,
      excludePid: 0,
      graceMs: 0,
      sleep: async () => {},
      kill: (pid, signal) => order.push([pid, signal]),
    })
    expect(signalled).toEqual([12, 11, 10])
    expect(order.slice(0, 3)).toEqual([
      [12, 15],
      [11, 15],
      [10, 15],
    ])
  })

  it("never signals pid 1", async () => {
    const signalled = await killProcessTree(1, {
      rows: [{ pid: 1, ppid: 0, rssBytes: MIB, command: "init" }],
      excludePid: 0,
      graceMs: 0,
      sleep: async () => {},
      kill: () => {
        throw new Error("must not signal init")
      },
    })
    expect(signalled).toEqual([])
  })
})

describe("reading this machine", () => {
  it("reports an available memory between zero and total", () => {
    const available = readAvailableBytes()
    expect(available).not.toBe(null)
    expect(available as number).toBeGreaterThan(0)
    expect(available as number).toBeLessThanOrEqual(os.totalmem())
  })

  it("sees its own process in the process table", () => {
    const rows = readProcessTable()
    expect(rows.length).toBeGreaterThan(1)
    const me = rows.find((r) => r.pid === process.pid)
    expect(me).toBeDefined()
    expect((me as ProcRow).rssBytes).toBeGreaterThan(0)
  })
})

// The measured leak: one snapshot, then a 5 s grace period during which the
// harnesses still running spawned seven more e2e API servers and the runner
// spawned the next suite's child. None of them were in the snapshot, so none
// were signalled, and the next run inherited 6.4 GB of them.
describe("killProcessTree re-scans for processes born during the kill", () => {
  const row = (pid: number, ppid: number): ProcRow => ({
    pid,
    ppid,
    rssBytes: MIB,
    command: `proc ${pid}`,
  })

  it("signals a child that only appears after the first sweep", async () => {
    let pass = 0
    const killed: number[] = []
    const signalled = await killProcessTree(10, {
      excludePid: 0,
      graceMs: 0,
      sleep: async () => {},
      readTable: () => {
        pass++
        // Pass 1 sees only the root. The late child exists from pass 2 on.
        return pass === 1 ? [row(10, 1)] : [row(10, 1), row(11, 10)]
      },
      kill: (pid) => killed.push(pid),
    })
    expect(signalled).toEqual([10, 11])
    expect(killed).toContain(11)
  })

  it("stops early when the tree is already gone", async () => {
    let reads = 0
    const signalled = await killProcessTree(10, {
      excludePid: 0,
      graceMs: 0,
      sleep: async () => {},
      readTable: () => {
        reads++
        return []
      },
      kill: () => {
        throw new Error("nothing to signal")
      },
    })
    expect(signalled).toEqual([])
    expect(reads).toBe(1)
  })
})

describe("startMemGuard onTrip", () => {
  it("fires before the tree is killed, so the runner can stop starting suites", async () => {
    const order: string[] = []
    const got: { code: number | null } = { code: null }
    const rows = [{ pid: process.pid, ppid: 1, rssBytes: 16 * GIB, command: "runner" }]
    const guard = startMemGuard({
      budgetMb: 1,
      reserveMb: 8 * 1024,
      logDir: tmpDir(),
      label: "onTrip test",
      pollMs: 100,
      env: {},
      log: () => {},
      readAvailable: () => 1 * MIB,
      readTable: () => rows,
      onTrip: () => order.push("onTrip"),
      killTree: async () => {
        order.push("killTree")
        return []
      },
      exit: (code) => {
        got.code = code
        order.push("exit")
      },
    })
    await waitFor(() => got.code !== null, 5_000)
    guard.stop()
    expect(order).toEqual(["onTrip", "killTree", "exit"])
    expect(got.code).toBe(MEM_GUARD_EXIT_CODE)
  }, 15_000)
})

// A runner that dies has no time to await a grace period, and killing only its
// direct child was measured leaving a `bunx playwright test` child's own workers
// (and the API servers those had spawned) alive for 15 minutes.
describe("killProcessTreeNow", () => {
  it("SIGKILLs the whole tree synchronously, leaves first", () => {
    const killed: Array<[number, number]> = []
    const pids = killProcessTreeNow(10, {
      excludePid: 0,
      rows: [
        { pid: 10, ppid: 1, rssBytes: MIB, command: "suite child" },
        { pid: 11, ppid: 10, rssBytes: MIB, command: "playwright" },
        { pid: 12, ppid: 11, rssBytes: MIB, command: "worker" },
      ],
      kill: (pid, signal) => killed.push([pid, signal]),
    })
    expect(pids).toEqual([12, 11, 10])
    expect(killed).toEqual([
      [12, 9],
      [11, 9],
      [10, 9],
    ])
  })

  it("never signals pid 1 or the excluded pid", () => {
    const killed: number[] = []
    killProcessTreeNow(1, {
      excludePid: 10,
      rows: [
        { pid: 1, ppid: 0, rssBytes: MIB, command: "init" },
        { pid: 10, ppid: 1, rssBytes: MIB, command: "me" },
      ],
      kill: (pid) => killed.push(pid),
    })
    expect(killed).toEqual([])
  })
})

describe("killCurrentChild wiring", () => {
  it("test-run.ts kills the child TREE when the runner dies", async () => {
    const src = await Bun.file(path.resolve(import.meta.dir, "../test-run.ts")).text()
    expect(src).toContain("killProcessTreeNow(currentChildPid)")
  })
})
