// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The pool of workerd processes behind the sandbox service.
//
//  - A process serves ONE key, `<cell>:<org>:<app>@<version>#<sha>` (the
//    loader's dynamic worker id), one run at a time. It is bound to the key on
//    its first run and never serves another: not another app, not another org.
//    workerd never evicts a dynamic worker it loaded, so a second key would
//    also grow the process for good.
//  - A process is replaced after `recycleRuns` runs, stopped after `idleMs`
//    idle, and killed (SIGKILL) when a run on it overruns a limit
//    (supervisor.ts). A few blank processes are kept started (`spares`).
//  - Top-level runs (depth 0) come in two lanes (the run body's `lane`).
//    Interactive runs (a person or an agent waits: tool calls, attention
//    computes, summarizers, page reads) may hold at most `poolSize - reserved`
//    processes at once; background runs (jobs, events, syncs) at most that
//    less `reservedInteractive` (config.ts laneCaps), so a burst of long
//    background runs always leaves processes for interactive ones. A run
//    that may not take one queues, first come first served within its lane,
//    until its deadline; a freed process goes to the oldest waiter whose lane
//    may take it. Nested runs
//    (depth 1..maxDepth: a cross-app call, a render, a summarizer started by
//    another run) may take any process and, when the pool is full, start up to
//    `overflow` more. They never queue (their parent holds a process while it
//    waits for them): past that they fail at once, so a chain never deadlocks
//    the pool.
//
// Each process listens on a unix socket in the pool's work dir and is started
// with its own random key in its environment (host-worker.ts PROCESS_KEY):
// only the supervisor, which signs every /run with it, can drive it.
//
// With `processUids` (the service runs as root, the compose file), each
// process also runs as its own uid from that range, with no supplementary
// group and no capability, in a private directory (mode 0700, its own) that
// holds its socket and is its TMPDIR. A process that escaped V8 then cannot
// read another process's memory or environment (its key, its runs' tokens):
// the kernel (or gVisor) refuses /proc/<pid>/mem and /environ across uids, and
// it cannot open another process's socket or files. A uid serves one process
// at a time and is free again once that process has exited.

import { randomBytes } from "node:crypto"
import { chmodSync, chownSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RunLane } from "@liaison/app-loader"
import type { Subprocess } from "bun"
import { type LaneCaps, laneCaps, type SupervisorConfig } from "./config"
import { resolveWorkerdBinary } from "./workerd-bin"

export const COMPATIBILITY_DATE = "2026-10-01"
const START_TIMEOUT_MS = 10_000

export interface WorkerdProcess {
  readonly n: number
  readonly socket: string
  readonly pid: number
  readonly child: Subprocess
  /** This process's own key; the supervisor signs its /run requests with it. */
  readonly processKey: string
  /** Its own uid (`processUids`), or undefined when processes share the service's. */
  readonly uid?: number
  /** The one key it serves, once bound. */
  key?: string
  /** Module bundle keys already pushed to it. */
  readonly pushed: Set<string>
  runs: number
  busy: boolean
  /** Depth of the run on it (0 top-level). */
  depth: number
  /** Lane of the run on it. */
  lane: RunLane
  dead: boolean
  lastUsed: number
  readyMs?: number
  killReason?: string
  stderrTail: string
}

export type Acquired = {
  proc: WorkerdProcess
  how: "warm" | "blank" | "spawn" | "evict" | "overflow"
}

export class PoolError extends Error {
  constructor(
    readonly code: "nesting_depth" | "nested_capacity" | "queue_timeout" | "stopped",
    message: string,
  ) {
    super(message)
  }
}

type Waiter = { lane: RunLane; wake: () => void }

export interface LaneCounters {
  /** Top-level runs of the lane that started. */
  started: number
  /** Of those, the ones that waited in the queue first. */
  waited: number
  /** Their total time in the queue. */
  waitMsTotal: number
  /** The longest time a run of the lane waited (started or not). */
  waitMsMax: number
  /** Runs of the lane whose deadline passed in the queue. */
  queueTimeouts: number
}

export interface PoolCounters {
  spawned: number
  runs: number
  killed: Record<string, number>
  lanes: Record<RunLane, LaneCounters>
}

const laneCounters = (): LaneCounters => ({
  started: 0,
  waited: 0,
  waitMsTotal: 0,
  waitMsMax: 0,
  queueTimeouts: 0,
})

export class WorkerdPool {
  readonly procs: WorkerdProcess[] = []
  readonly counters: PoolCounters = {
    spawned: 0,
    runs: 0,
    killed: {},
    lanes: { interactive: laneCounters(), background: laneCounters() },
  }
  /** How many processes each lane's top-level runs may hold (config.ts laneCaps). */
  readonly caps: LaneCaps
  private seq = 0
  private waiters: Waiter[] = []
  private stopped = false
  private topping = false
  /** Where process configs, sockets and the bridge relay's socket live. */
  readonly workDir: string
  /**
   * Where a process's bridge calls go (`host:port` or `unix:<path>`): the
   * supervisor's bridge relay (supervisor.ts). Unset: the configured address.
   */
  bridgeTarget: string | null = null
  private readonly ownWorkDir: boolean
  private readonly bin: string
  private readonly sweep: ReturnType<typeof setInterval>
  private readonly uidsInUse = new Set<number>()

  constructor(
    private readonly cfg: SupervisorConfig,
    readonly hostSource: string,
  ) {
    this.caps = laneCaps(cfg)
    this.bin = cfg.workerdBin ?? resolveWorkerdBinary()
    // Short paths: a unix socket path is capped near 100 bytes.
    this.ownWorkDir = !cfg.workDir
    this.workDir = cfg.workDir ?? mkdtempSync(join(tmpdir(), "wkd-"))
    writeFileSync(join(this.workDir, "host.js"), hostSource, { mode: 0o644 })
    // Processes of other uids pass through it (to their own directory and the
    // bridge relay's socket) and read host.js and their configs; they list nothing.
    if (cfg.processUids) chmodSync(this.workDir, 0o711)
    const every = Math.min(5_000, Math.max(50, Math.floor(cfg.idleMs / 2)))
    this.sweep = setInterval(() => this.sweepIdle(), every)
  }

  /** Whether a top-level run of this lane may take a process now (its lane cap). */
  private laneHasRoom(lane: RunLane): boolean {
    let top = 0
    let background = 0
    for (const p of this.procs) {
      if (!p.busy || p.depth !== 0) continue
      top++
      if (p.lane === "background") background++
    }
    if (top >= this.caps.interactive) return false
    return lane === "interactive" || background < this.caps.background
  }

  /**
   * A process for a run. `lane` is the run's (top-level runs only: a nested
   * run's parent already holds a process of its lane).
   */
  async acquire(
    key: string,
    depth: number,
    deadlineAt: number,
    lane: RunLane = "interactive",
  ): Promise<Acquired> {
    if (depth > this.cfg.maxDepth) {
      throw new PoolError(
        "nesting_depth",
        `nesting depth ${depth} is over the cap of ${this.cfg.maxDepth}`,
      )
    }
    const queuedAt = Date.now()
    let waited = false
    let woken = false
    const started = (a: Acquired): Acquired => {
      if (depth === 0) {
        const c = this.counters.lanes[lane]
        const ms = Date.now() - queuedAt
        c.started++
        if (waited) {
          c.waited++
          c.waitMsTotal += ms
          if (ms > c.waitMsMax) c.waitMsMax = ms
        }
      }
      return a
    }
    for (;;) {
      if (this.stopped) throw new PoolError("stopped", "the sandbox is stopping")
      // First come first served within a lane: a new run never passes a
      // queued one of its own lane (a woken waiter goes ahead of them).
      const mayTake =
        depth > 0 ||
        (this.laneHasRoom(lane) && (woken || !this.waiters.some((w) => w.lane === lane)))
      if (mayTake) {
        const got = await this.takeAny(key, depth, lane)
        if (got) return started(got)
      }
      if (depth > 0) {
        if (this.procs.length < this.cfg.poolSize + this.cfg.overflow) {
          return this.take(await this.spawn(true, depth, lane), key, depth, lane, "overflow")
        }
        throw new PoolError(
          "nested_capacity",
          "no sandbox process is free for a nested run (retry later)",
        )
      }
      const left = deadlineAt - Date.now()
      waited = true
      if (left <= 0 || !(await this.waitForRelease(lane, left, woken))) {
        const c = this.counters.lanes[lane]
        c.queueTimeouts++
        const ms = Date.now() - queuedAt
        if (ms > c.waitMsMax) c.waitMsMax = ms
        throw new PoolError("queue_timeout", "no sandbox process became free before the deadline")
      }
      woken = true
    }
  }

  /** A warm, blank, new or evicted process for the run, or null when none is free. */
  private async takeAny(key: string, depth: number, lane: RunLane): Promise<Acquired | null> {
    const warm = this.procs.find(
      (p) => !p.busy && !p.dead && p.key === key && p.runs < this.cfg.recycleRuns,
    )
    if (warm) return this.take(warm, key, depth, lane, "warm")
    const blank = this.procs.find((p) => !p.busy && !p.dead && p.key === undefined)
    if (blank) return this.take(blank, key, depth, lane, "blank")
    if (this.procs.length < this.cfg.poolSize) {
      return this.take(await this.spawn(true, depth, lane), key, depth, lane, "spawn")
    }
    // An idle process bound to another key is stopped, never rebound.
    const victim = this.procs
      .filter((p) => !p.busy && !p.dead)
      .sort((a, b) => a.lastUsed - b.lastUsed)[0]
    if (victim) {
      this.kill(victim, "evict")
      return this.take(await this.spawn(true, depth, lane), key, depth, lane, "evict")
    }
    return null
  }

  private take(
    p: WorkerdProcess,
    key: string,
    depth: number,
    lane: RunLane,
    how: Acquired["how"],
  ): Acquired {
    p.busy = true
    p.depth = depth
    p.lane = lane
    p.key ??= key
    if (p.key !== key) throw new Error("internal: a process is bound to another key")
    return { proc: p, how }
  }

  /** Wait for a process; `front`: a woken waiter that lost the race keeps its place. */
  private waitForRelease(lane: RunLane, ms: number, front: boolean): Promise<boolean> {
    return new Promise((resolve) => {
      const w: Waiter = {
        lane,
        wake: () => {
          clearTimeout(t)
          resolve(true)
        },
      }
      const t = setTimeout(() => {
        const i = this.waiters.indexOf(w)
        if (i >= 0) this.waiters.splice(i, 1)
        resolve(false)
      }, ms)
      if (front) {
        // Ahead of the others of its lane, behind none it was already behind.
        const i = this.waiters.findIndex((o) => o.lane === lane)
        this.waiters.splice(i === -1 ? this.waiters.length : i, 0, w)
      } else {
        this.waiters.push(w)
      }
    })
  }

  /** A process may be free: wake the oldest waiter whose lane may take one. */
  private wakeOne(): void {
    const i = this.waiters.findIndex((w) => this.laneHasRoom(w.lane))
    if (i === -1) return
    const [w] = this.waiters.splice(i, 1)
    w?.wake()
  }

  /** A run is over: the process goes back, or is replaced past its run count. */
  release(p: WorkerdProcess): void {
    p.busy = false
    p.depth = 0
    p.lane = "interactive"
    p.lastUsed = Date.now()
    if (!p.dead && p.runs >= this.cfg.recycleRuns) this.kill(p, "recycle")
    else if (!p.dead && this.procs.length > this.cfg.poolSize) this.kill(p, "overflow")
    void this.topUpSpares()
    this.wakeOne()
  }

  kill(p: WorkerdProcess, reason: string): void {
    if (p.dead) return
    p.killReason = reason
    p.dead = true
    this.counters.killed[reason] = (this.counters.killed[reason] ?? 0) + 1
    try {
      process.kill(p.pid, "SIGKILL")
    } catch {}
    const i = this.procs.indexOf(p)
    if (i >= 0) this.procs.splice(i, 1)
  }

  /** A process that exited by itself under a run: count it under the run's reason. */
  exitedUnderRun(p: WorkerdProcess, reason: string): void {
    if (!p.dead) {
      this.kill(p, reason)
      return
    }
    if (p.killReason !== "exited") return
    p.killReason = reason
    this.counters.killed.exited = (this.counters.killed.exited ?? 1) - 1
    this.counters.killed[reason] = (this.counters.killed[reason] ?? 0) + 1
  }

  /** After a kill: let a queued run start a replacement. */
  replaced(): void {
    void this.topUpSpares()
    this.wakeOne()
  }

  private sweepIdle(): void {
    const now = Date.now()
    for (const p of [...this.procs]) {
      if (!p.busy && p.key !== undefined && now - p.lastUsed > this.cfg.idleMs) this.kill(p, "idle")
    }
    void this.topUpSpares()
  }

  async topUpSpares(): Promise<void> {
    if (this.topping || this.stopped) return
    this.topping = true
    try {
      while (
        !this.stopped &&
        this.procs.filter((p) => p.key === undefined && !p.dead && !p.busy).length <
          this.cfg.spares &&
        this.procs.length < this.cfg.poolSize
      ) {
        try {
          await this.spawn(false, 0, "interactive")
        } catch {
          break
        }
        this.wakeOne()
      }
    } finally {
      this.topping = false
    }
  }

  private capnp(n: number, socket: string): string {
    const bridge = new URL(this.cfg.bridgeOrigin)
    const address =
      this.bridgeTarget ?? this.cfg.bridgeAddress ?? `${bridge.hostname}:${bridge.port || "80"}`
    return `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "main", worker = .host),
    (name = "bridge", external = (address = "${address}", http = ())),
  ],
  sockets = [ (name = "http", address = "unix:${socket}", http = (), service = "main") ],
  v8Flags = ["--max-old-space-size=${this.cfg.heapMb}"],
);
const host :Workerd.Worker = (
  modules = [ (name = "host.js", esModule = embed "host.js") ],
  compatibilityDate = "${COMPATIBILITY_DATE}",
  compatibilityFlags = ["experimental"],
  bindings = [
    (name = "LOADER", workerLoader = ()),
    (name = "PROCESS_KEY", fromEnvironment = "SANDBOX_PROCESS_KEY"),
    (name = "BRIDGE_ORIGIN", text = "${this.cfg.bridgeOrigin}"),
  ],
  globalOutbound = "bridge",
);
# process ${n}
`
  }

  /** A uid of the range no live process holds. */
  private takeUid(): number | undefined {
    const range = this.cfg.processUids
    if (!range) return undefined
    for (let i = 0; i < range.count; i++) {
      const uid = range.base + i
      if (!this.uidsInUse.has(uid)) {
        this.uidsInUse.add(uid)
        return uid
      }
    }
    throw new Error("no free sandbox process uid (raise SANDBOX_PROCESS_UID_COUNT)")
  }

  /** A new process; `busy`: started for a run of this depth and lane, counted as one at once. */
  async spawn(busy: boolean, depth: number, lane: RunLane): Promise<WorkerdProcess> {
    if (this.stopped) throw new PoolError("stopped", "the sandbox is stopping")
    const n = ++this.seq
    const uid = this.takeUid()
    // Its own directory (its uid's only) for its socket and temp files.
    const dir = uid === undefined ? null : join(this.workDir, `p${n}`)
    let child: Subprocess
    let socket: string
    const file = join(this.workDir, `p${n}.capnp`)
    const processKey = randomBytes(32).toString("base64url")
    const t0 = performance.now()
    try {
      if (dir !== null && uid !== undefined) {
        mkdirSync(dir, { mode: 0o700 })
        chownSync(dir, uid, uid)
        socket = join(dir, "s.sock")
      } else {
        socket = join(this.workDir, `p${n}.sock`)
      }
      writeFileSync(file, this.capnp(n, socket), { mode: 0o644 })
      child = Bun.spawn([this.bin, "serve", file, "--experimental"], {
        cwd: dir ?? this.workDir,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
        // Nothing of the supervisor's environment: the process key (and, with
        // its own uid, its own temp directory) only.
        env: dir
          ? { SANDBOX_PROCESS_KEY: processKey, TMPDIR: dir }
          : { SANDBOX_PROCESS_KEY: processKey },
        ...(uid !== undefined ? { uid, gid: uid } : {}),
      })
    } catch (e) {
      if (uid !== undefined) this.uidsInUse.delete(uid)
      if (dir) rmSync(dir, { recursive: true, force: true })
      rmSync(file, { force: true })
      throw new Error(
        `a workerd process did not start${uid !== undefined ? ` as uid ${uid} (the service needs the SETUID, SETGID, CHOWN, KILL and DAC_OVERRIDE capabilities; SANDBOX_PROCESS_UIDS=off shares one uid)` : ""}: ${(e as Error).message}`,
      )
    }
    const p: WorkerdProcess = {
      n,
      socket,
      pid: child.pid,
      child,
      processKey,
      ...(uid !== undefined ? { uid } : {}),
      pushed: new Set(),
      runs: 0,
      busy: true,
      depth: busy ? depth : 0,
      lane: busy ? lane : "interactive",
      dead: false,
      lastUsed: Date.now(),
      stderrTail: "",
    }
    this.procs.push(p)
    this.counters.spawned++
    void (async () => {
      try {
        const dec = new TextDecoder()
        for await (const chunk of child.stderr as ReadableStream<Uint8Array>) {
          p.stderrTail = (p.stderrTail + dec.decode(chunk)).slice(-4000)
        }
      } catch {}
    })()
    void child.exited.then(() => {
      if (!p.dead) {
        p.dead = true
        p.killReason ??= "exited"
        this.counters.killed.exited = (this.counters.killed.exited ?? 0) + 1
        const i = this.procs.indexOf(p)
        if (i >= 0) this.procs.splice(i, 1)
        this.replaced()
      }
      try {
        rmSync(file, { force: true })
        rmSync(socket, { force: true })
        if (dir) rmSync(dir, { recursive: true, force: true })
      } catch {}
      // Its uid is free once nothing of it runs any more.
      if (uid !== undefined) this.uidsInUse.delete(uid)
    })
    const until = Date.now() + START_TIMEOUT_MS
    while (Date.now() < until && !p.dead) {
      try {
        const r = await fetch("http://sandbox/health", { unix: socket })
        if (r.ok) {
          p.readyMs = performance.now() - t0
          p.busy = busy
          return p
        }
      } catch {}
      await Bun.sleep(10)
    }
    await Bun.sleep(20)
    const why = p.stderrTail.slice(-400)
    this.kill(p, "start_failed")
    throw new Error(`a workerd process did not start: ${why}`)
  }

  stats() {
    return {
      size: this.procs.length,
      busy: this.procs.filter((p) => p.busy).length,
      waiting: this.waiters.length,
      lanes: {
        caps: this.caps,
        busy: {
          interactive: this.procs.filter((p) => p.busy && p.depth === 0 && p.lane === "interactive")
            .length,
          background: this.procs.filter((p) => p.busy && p.depth === 0 && p.lane === "background")
            .length,
          nested: this.procs.filter((p) => p.busy && p.depth > 0).length,
        },
        waiting: {
          interactive: this.waiters.filter((w) => w.lane === "interactive").length,
          background: this.waiters.filter((w) => w.lane === "background").length,
        },
      },
      counters: this.counters,
      procs: this.procs.map((p) => ({
        n: p.n,
        pid: p.pid,
        uid: p.uid ?? null,
        bound: p.key !== undefined,
        runs: p.runs,
        busy: p.busy,
        depth: p.depth,
        lane: p.lane,
        readyMs: p.readyMs === undefined ? null : Math.round(p.readyMs),
      })),
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    clearInterval(this.sweep)
    for (const p of [...this.procs]) this.kill(p, "stop")
    for (const w of this.waiters.splice(0)) w.wake()
    if (this.ownWorkDir) {
      try {
        rmSync(this.workDir, { recursive: true, force: true })
      } catch {}
    }
  }
}
