// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { edge5xxMeasured, effectDuplicatesMeasured } from "./deploy-counters"
import {
  buildReport,
  type DeployWindow,
  doubledSinkKeys,
  k6Env,
  launchStages,
  measureLog,
  parseDriverArgs,
  parseDuration,
  prepareOut,
  RunFold,
  type RunOutcome,
  readSinks,
  type ServerCounters,
  sh,
  shCapture,
  stats,
  writePrivateFile,
} from "./deploy-under-load"

const KEY = "k".repeat(48)
const ENV = { LOAD_HARNESS_KEY: KEY, TMPDIR: "/tmp" }
const T0 = Date.parse("2026-10-30T10:00:00Z")

const point = (
  metric: string,
  tOffsetMs: number,
  value: number,
  tags: Record<string, string> = {},
) =>
  JSON.stringify({
    type: "Point",
    metric,
    data: { time: new Date(T0 + tOffsetMs).toISOString(), value, tags },
  })

const NO_SERVER: ServerCounters = {
  edge5xx: null,
  cutTurns: null,
  effectDuplicates: null,
  doubledEffects: 0,
  doubledEffectKeys: [],
}

const RUN: RunOutcome = {
  expectedDeploys: 2,
  k6Code: 0,
  k6Early: false,
  k6StoppedByDriver: true,
}

describe("parseDriverArgs", () => {
  it("takes the box, the key and the deploy command from flags or the environment, never defaults", () => {
    const cfg = parseDriverArgs(
      [
        "--deploys",
        "10",
        "--box",
        "https://box.test/",
        "--deploy-cmd",
        "deploy.sh",
        "--orgs",
        "10",
      ],
      ENV,
    )
    expect(cfg).toMatchObject({
      mode: "deploys",
      box: "https://box.test",
      deploys: 10,
      orgs: 10,
      deployCmd: "deploy.sh",
    })
    expect(
      parseDriverArgs(["--deploys=2"], { ...ENV, LOAD_BOX_URL: "http://b", LOAD_DEPLOY_CMD: "x" })
        .deployCmd,
    ).toBe("x")
    expect(() => parseDriverArgs(["--deploys", "2", "--deploy-cmd", "x"], ENV)).toThrow(/--box/)
    expect(() =>
      parseDriverArgs(["--deploys", "2", "--box", "http://b", "--deploy-cmd", "x"], {}),
    ).toThrow(/LOAD_HARNESS_KEY/)
    expect(() => parseDriverArgs(["--deploys", "2", "--box", "http://b"], ENV)).toThrow(
      /--deploy-cmd/,
    )
    expect(() => parseDriverArgs(["--deploys", "0", "--box", "http://b"], ENV)).toThrow(
      /--duration/,
    )
    expect(() =>
      parseDriverArgs(
        ["--deploys", "1", "--box", "http://b", "--deploy-cmd", "x", "--bogus", "1"],
        ENV,
      ),
    ).toThrow(/unknown flag/)
  })

  it("the launch flags: levels, ramp, hold, arrival rate, walk", () => {
    const cfg = parseDriverArgs(
      [
        "--launch",
        "--box",
        "http://b",
        "--levels",
        "300,1000",
        "--ramp",
        "5m",
        "--hold",
        "10m",
        "--walk",
        "4m",
      ],
      ENV,
    )
    expect(cfg).toMatchObject({
      mode: "launch",
      levels: [300, 1000],
      rampMs: 300_000,
      holdMs: 600_000,
      walkS: 240,
      arrivalPerMin: null,
    })
    expect(launchStages(cfg)).toEqual([
      { target: 300, duration: "300s" },
      { target: 300, duration: "600s" },
      { target: 1000, duration: "300s" },
      { target: 1000, duration: "600s" },
      { target: 0, duration: "300s" },
    ])
    const rate = parseDriverArgs(
      ["--launch", "--box", "http://b", "--arrival-rate", "20", "--ramp", "1m", "--hold", "30m"],
      ENV,
    )
    expect(launchStages(rate)).toEqual([
      { target: 20, duration: "60s" },
      { target: 20, duration: "1800s" },
    ])
    expect(JSON.parse(k6Env(rate, { orgs: null, summary: "s" }).LAUNCH_ARRIVAL!).timeUnit).toBe(
      "1m",
    )
    expect(parseDuration("90")).toBe(90_000)
    expect(parseDuration("2h")).toBe(7_200_000)
  })

  it("hands k6 the box, the key and the reply catalog through the environment", () => {
    const cfg = parseDriverArgs(["--deploys", "1", "--box", "http://b", "--deploy-cmd", "x"], ENV)
    const env = k6Env(cfg, { orgs: "/o.json", summary: "/s.json" })
    expect(env).toMatchObject({
      HOST: "http://b",
      LOAD_MODE: "deploys",
      LOAD_HARNESS_KEY: KEY,
      LOAD_ORGS_FILE: "/o.json",
      LOAD_FALLBACK: "Acknowledged.",
    })
    expect(JSON.parse(env.LOAD_REPLIES!).length).toBe(4)
  })
})

describe("the run report", () => {
  const windows: DeployWindow[] = [
    { index: 1, start: T0 + 10_000, end: T0 + 20_000, exitCode: 0 },
    { index: 2, start: T0 + 60_000, end: T0 + 70_000, exitCode: 0 },
  ]
  const clean = () => {
    const fold = new RunFold(windows, 5_000)
    // Outside the deploys.
    fold.add(point("http_req_duration", 1_000, 20, { status: "200", name: "threads" }))
    fold.add(point("load_turn_ms", 2_000, 300, { verdict: "ok" }))
    fold.add(point("load_turn_result", 2_000, 1, { verdict: "ok", followed: "no" }))
    // During deploy 1, inside its grace, and during deploy 2.
    fold.add(point("http_req_duration", 12_000, 900, { status: "200", name: "threads" }))
    fold.add(point("http_req_duration", 24_000, 400, { status: "200", name: "agent-chat" }))
    fold.add(point("load_turn_ms", 65_000, 4_000, { verdict: "ok", followed: "yes" }))
    fold.add(point("load_turn_result", 65_000, 1, { verdict: "ok", followed: "yes" }))
    fold.add(point("load_ws_gap_ms", 15_000, 1_200))
    fold.add(point("load_ws_server_close", 14_000, 1, { code: "1012" }))
    fold.add("not json")
    fold.add(JSON.stringify({ type: "Metric", metric: "http_req_duration", data: {} }))
    return fold
  }

  it("splits delays into during and outside the deploys, per deploy too, and passes when every counter is 0", () => {
    const r = buildReport({
      cfg: { mode: "deploys", box: "http://b" },
      startedAt: T0,
      endedAt: T0 + 90_000,
      windows,
      fold: clean(),
      server: NO_SERVER,
      run: RUN,
    })
    expect(r.delays.duringDeploys.http).toEqual({ count: 2, p50: 400, p95: 900, max: 900 })
    expect(r.delays.outsideDeploys.http).toEqual({ count: 1, p50: 20, p95: 20, max: 20 })
    expect(r.delays.duringDeploys.turn.max).toBe(4_000)
    expect(r.delays.duringDeploys.wsReconnectGap.max).toBe(1_200)
    expect(r.deploys.map((d) => [d.index, d.httpMaxMs, d.turnMaxMs])).toEqual([
      [1, 900, 0],
      [2, 0, 4_000],
    ])
    expect(r.turns).toEqual({ total: 2, byVerdict: { ok: 2 }, followedRestart: 1 })
    expect(r.wsServerCloses).toEqual({ "1012": 1 })
    expect(r.ok).toBe(true)
    expect(r.summary).toContain("only delayed work")
    expect(r.summary).toContain("NOT MEASURED: edge5xx (not requested)")
    expect(r.summary).toContain("NOT MEASURED: cutTurns (not requested)")
    expect(r.summary).toContain("NOT MEASURED: effectDuplicates (not requested)")
    expect(r.counterStatus.doubledEffects).toEqual({ status: "measured", requested: true })
  })

  it("fails on a client 5xx, a cut request, a wrong reply, a failed deploy or any server counter", () => {
    const cases: Array<
      (f: RunFold) => {
        windows?: DeployWindow[]
        server?: Partial<ServerCounters>
        run?: RunOutcome
      }
    > = [
      (f) => {
        f.add(point("http_req_duration", 12_000, 5, { status: "502" }))
        return {}
      },
      (f) => {
        f.add(point("http_req_duration", 12_000, 5, { status: "0" }))
        return {}
      },
      (f) => {
        f.add(point("load_turn_result", 12_000, 1, { verdict: "mismatch" }))
        return {}
      },
      (f) => {
        f.add(point("load_turn_result", 12_000, 1, { verdict: "doubled" }))
        return {}
      },
      () => ({ windows: [{ ...windows[0]!, exitCode: 1 }] }),
      () => ({ server: { edge5xx: 1 } }),
      () => ({ server: { cutTurns: [{ id: "t", reason: "reply-mismatch" }] } }),
      () => ({ server: { effectDuplicates: 2 } }),
      () => ({ server: { doubledEffects: 1, doubledEffectKeys: ["o|mail|k"] } }),
    ]
    for (const make of cases) {
      const fold = clean()
      const over = make(fold)
      const r = buildReport({
        cfg: { mode: "deploys", box: "http://b" },
        startedAt: T0,
        endedAt: T0 + 90_000,
        windows: over.windows ?? windows,
        fold,
        server: { ...NO_SERVER, ...over.server },
        run: over.run ?? RUN,
      })
      expect(r.ok).toBe(false)
      expect(r.summary).toContain("stopped, cut or doubled")
    }
  })

  it("counts errors by type and refuses a run with no turn at all", () => {
    const fold = new RunFold([], 0)
    fold.add(point("http_req_duration", 1, 5, { status: "429" }))
    fold.add(point("load_errors", 1, 1, { type: "api_read", status: "404" }))
    fold.add(point("load_errors", 2, 1, { type: "turn_refused_429" }))
    const r = buildReport({
      cfg: { mode: "deploys", box: "http://b" },
      startedAt: T0,
      endedAt: T0 + 1,
      windows: [],
      fold,
      server: NO_SERVER,
      run: RUN,
    })
    expect(r.errorsByType).toEqual({ http_429: 1, api_read_404: 1, turn_refused_429: 1 })
    expect(r.ok).toBe(false)
  })

  it("the launch scenario reports the warm-pool hit rate and the time to a workspace, pooled and fresh", () => {
    const fold = clean()
    for (const [v, pooled] of [
      [120, "yes"],
      [180, "yes"],
      [9_000, "no"],
      [150, "yes"],
    ] as const) {
      fold.add(point("load_time_to_workspace_ms", 30_000, v, { pooled, org: `o-${v}` }))
      fold.add(point("load_pool_hit", 30_000, pooled === "yes" ? 1 : 0))
      fold.add(point("load_signup_result", 30_000, 1, { status: "201" }))
    }
    // A busy box's "being prepared" answers, before one of those 201s.
    fold.add(point("load_signup_preparing", 30_000, 2))
    const r = buildReport({
      cfg: { mode: "launch", box: "http://b" },
      startedAt: T0,
      endedAt: T0 + 90_000,
      windows,
      fold,
      server: NO_SERVER,
      run: RUN,
    })
    expect(r.launch).toEqual({
      signupsByStatus: { "201": 4, "202_preparing": 2 },
      poolHitRate: 0.75,
      timeToWorkspace: {
        all: { count: 4, p50: 150, p95: 9_000, max: 9_000 },
        pooled: { count: 3, p50: 150, p95: 180, max: 180 },
        fresh: { count: 1, p50: 9_000, p95: 9_000, max: 9_000 },
      },
    })
    expect(fold.launchOrgs.size).toBe(4)
    expect(r.summary).toContain("warm-pool hit rate 75%")
  })
})

describe("a run is clean only when everything asked for was measured", () => {
  const windows: DeployWindow[] = [
    { index: 1, start: T0 + 10_000, end: T0 + 20_000, exitCode: 0 },
    { index: 2, start: T0 + 60_000, end: T0 + 70_000, exitCode: 0 },
  ]
  const fold = () => {
    const f = new RunFold(windows, 5_000)
    f.add(point("load_turn_result", 2_000, 1, { verdict: "ok", followed: "no" }))
    return f
  }
  const report = (over: {
    windows?: DeployWindow[]
    server?: Partial<ServerCounters>
    run?: Partial<RunOutcome>
    fold?: RunFold
  }) =>
    buildReport({
      cfg: { mode: "deploys", box: "http://b" },
      startedAt: T0,
      endedAt: T0 + 90_000,
      windows: over.windows ?? windows,
      fold: over.fold ?? fold(),
      server: { ...NO_SERVER, ...over.server },
      run: { ...RUN, ...over.run },
    })

  it("is clean with all deploys done and k6 stopped by the driver", () => {
    expect(report({}).ok).toBe(true)
  })

  it("D1: a requested counter that was not measured fails, and the summary names it with its reason", () => {
    const r = report({
      server: {
        edge5xx: null,
        detail: {
          edge5xx: { requested: true, state: "not_measured", reason: "the edge log was empty" },
        },
      },
    })
    expect(r.ok).toBe(false)
    expect(r.counterStatus.edge5xx).toEqual({
      status: "not_measured",
      requested: true,
      reason: "the edge log was empty",
    })
    expect(r.summary).toContain("NOT MEASURED: edge5xx (the edge log was empty)")
  })

  it("D1: a failed read fails the run even with every value 0, and doubles found are kept", () => {
    const r = report({
      server: {
        doubledEffects: 3,
        doubledEffectKeys: ["a|mail|x", "a|mail|y", "b|mail|z"],
        detail: {
          doubledEffects: { requested: true, state: "failed", reason: "1 of 4 sink reads failed" },
        },
      },
    })
    expect(r.ok).toBe(false)
    expect(r.counters.doubledEffects).toBe(3)
    expect(r.counterStatus.doubledEffects.status).toBe("failed")
    expect(r.summary).toContain("FAILED: doubledEffects (1 of 4 sink reads failed)")
    expect(r.summary).toContain("3 doubled effects (sink)")
  })

  it("D2: fewer deploys than asked fails (none at all too)", () => {
    expect(report({ windows: [windows[0]!] }).ok).toBe(false)
    const none = report({ windows: [] })
    expect(none.ok).toBe(false)
    expect(none.run).toMatchObject({ deploysRequested: 2, deploysDone: 0 })
    expect(none.summary).toContain("2 deploys not run")
  })

  it("D2: k6 ending early, or exiting non-zero on its own, fails; a driver stop is not judged by the code", () => {
    expect(report({ run: { k6Early: true, k6StoppedByDriver: false, k6Code: 137 } }).ok).toBe(false)
    expect(report({ run: { k6StoppedByDriver: false, k6Code: 99 } }).ok).toBe(false)
    expect(report({ run: { k6StoppedByDriver: false, k6Code: 0 } }).ok).toBe(true)
    expect(report({ run: { k6StoppedByDriver: true, k6Code: 105 } }).ok).toBe(true)
    expect(report({ run: { k6Code: 105 } }).run.k6ExitCode).toBe(105)
  })

  it("D5: a dropped session (401), a 429, a signup or verify error fails the run", () => {
    for (const make of [
      (f: RunFold) => f.add(point("http_req_duration", 1_000, 5, { status: "401" })),
      (f: RunFold) => f.add(point("http_req_duration", 1_000, 5, { status: "429" })),
      (f: RunFold) => f.add(point("load_errors", 1_000, 1, { type: "signup", status: "500" })),
      (f: RunFold) => f.add(point("load_errors", 1_000, 1, { type: "verify", status: "422" })),
      (f: RunFold) => f.add(point("load_errors", 1_000, 1, { type: "sink_code", status: "404" })),
      (f: RunFold) => f.add(point("load_errors", 1_000, 1, { type: "workspace_not_ready" })),
      (f: RunFold) => f.add(point("load_errors", 1_000, 1, { type: "api_read", status: "401" })),
    ]) {
      const f = fold()
      make(f)
      expect(report({ fold: f }).ok).toBe(false)
    }
    const f = fold()
    f.add(point("load_errors", 1_000, 1, { type: "api_read", status: "404" }))
    expect(report({ fold: f }).ok).toBe(true)
  })
})

describe("reading the sources", () => {
  it("D1: a failed sink read keeps the doubles the other orgs showed and marks the counter failed", async () => {
    const client = {
      async sink(orgId: string) {
        if (orgId === "bad") throw new Error("sink read of bad: 500")
        return {
          demoCode: null,
          effects: [{ kind: "mail", key: "k", count: orgId === "o1" ? 2 : 1, lastAt: T0 + 1 }],
        }
      },
    }
    const r = await readSinks(client as never, ["o1", "bad", "o2"], T0)
    expect(r.value).toBe(1)
    expect(r.keys).toEqual(["o1|mail|k"])
    expect(r.detail).toMatchObject({ state: "failed", requested: true })
    expect(r.detail?.reason).toContain("1 of 3")
    const clean = await readSinks(client as never, ["o2"], T0)
    expect(clean).toEqual({ value: 0, keys: [] })
  })

  it("D1: no load org at all, or every read failed, is not a measured 0", async () => {
    const none = await readSinks({ sink: async () => ({ demoCode: null, effects: [] }) }, [], T0)
    expect(none.value).toBeNull()
    expect(none.detail).toMatchObject({ state: "not_measured", requested: true })
    const allBad = await readSinks(
      {
        sink: async () => {
          throw new Error("down")
        },
      },
      ["a", "b"],
      T0,
    )
    expect(allBad.value).toBeNull()
    expect(allBad.detail?.state).toBe("failed")
  })

  it("D3: a log source with no usable line, or that cannot be read, is not a measured 0", async () => {
    const w = { start: T0, end: T0 + 60_000 }
    const empty = await measureLog(
      true,
      "the edge log",
      async () => "",
      (l) => edge5xxMeasured(l, w),
    )
    expect(empty.value).toBeNull()
    expect(empty.detail?.state).toBe("not_measured")
    const clf = await measureLog(
      true,
      "the edge log",
      async () => '1.2.3.4 - - [30/Oct/2026:10:00:01 +0000] "GET / HTTP/1.1" 502 12\n',
      (l) => edge5xxMeasured(l, w),
    )
    expect(clf.value).toBeNull()
    const broken = await measureLog(
      true,
      "the app log",
      async () => {
        throw new Error("exited 1")
      },
      (l) => effectDuplicatesMeasured(l, w),
    )
    expect(broken.detail).toMatchObject({ state: "failed" })
    expect(broken.detail?.reason).toContain("exited 1")
    const good = await measureLog(
      true,
      "the edge log",
      async () => JSON.stringify({ ts: (T0 + 1000) / 1000, status: 200 }),
      (l) => edge5xxMeasured(l, w),
    )
    expect(good).toEqual({ value: 0 })
    expect(
      await measureLog(
        false,
        "x",
        async () => "",
        () => 0,
      ),
    ).toEqual({ value: null })
  })
})

describe("running commands", () => {
  const dir = mkdtempSync(join(tmpdir(), "p3e-driver-"))

  it("LOW-D6: all the output of a compound command lands in the log, comments included", async () => {
    const log = join(dir, "d.log")
    expect(await sh("echo first && echo second >&2 && echo third # a comment", log, 10_000)).toBe(0)
    const text = readFileSync(log, "utf8")
    expect(text).toContain("first")
    expect(text).toContain("second")
    expect(text).toContain("third")
    expect(await sh("echo before; exit 3", log, 10_000)).toBe(3)
    expect(readFileSync(log, "utf8")).toContain("before")
  })

  it("D4: a hung deploy or log command is killed at its timeout (124 / rejection)", async () => {
    const t0 = Date.now()
    expect(await sh("sleep 30", join(dir, "h.log"), 300)).toBe(124)
    await expect(shCapture("sleep 30", 300)).rejects.toThrow(/timed out/)
    expect(Date.now() - t0).toBeLessThan(5_000)
    expect(await shCapture("echo hi", 5_000)).toBe("hi\n")
  })

  it("the box's key never reaches a deploy or log command", async () => {
    process.env.LOAD_HARNESS_KEY = KEY
    try {
      expect((await shCapture('echo "[$LOAD_HARNESS_KEY]"', 5_000)).trim()).toBe("[]")
    } finally {
      process.env.LOAD_HARNESS_KEY = undefined
      delete process.env.LOAD_HARNESS_KEY
    }
  })

  it("LOW-D7: a secrets file is 600 even when it already existed as 644; a pre-existing out dir keeps its mode", () => {
    const f = join(dir, "orgs.json")
    writeFileSync(f, "old", { mode: 0o644 })
    chmodSync(f, 0o644)
    writePrivateFile(f, "new")
    expect(statSync(f).mode & 0o777).toBe(0o600)
    expect(readFileSync(f, "utf8")).toBe("new")
    chmodSync(dir, 0o755)
    prepareOut(dir)
    expect(statSync(dir).mode & 0o777).toBe(0o755)
    const fresh = join(dir, "a", "b")
    prepareOut(fresh)
    expect(statSync(fresh).mode & 0o777).toBe(0o700)
    rmSync(dir, { recursive: true, force: true })
  })

  it("D4: the timeouts are flags with defaults", () => {
    const cfg = parseDriverArgs(["--deploys", "1", "--box", "http://b", "--deploy-cmd", "x"], ENV)
    expect(cfg).toMatchObject({
      deployTimeoutMs: 1_800_000,
      logTimeoutMs: 300_000,
      fetchTimeoutMs: 30_000,
      k6GraceMs: 120_000,
    })
    const set = parseDriverArgs(
      [
        "--deploys=1",
        "--box=http://b",
        "--deploy-cmd=x",
        "--deploy-timeout=10m",
        "--log-timeout=20s",
        "--fetch-timeout=5s",
        "--k6-grace=30s",
      ],
      ENV,
    )
    expect(set).toMatchObject({
      deployTimeoutMs: 600_000,
      logTimeoutMs: 20_000,
      fetchTimeoutMs: 5_000,
      k6GraceMs: 30_000,
    })
  })
})

describe("helpers", () => {
  it("stats: nearest-rank percentiles", () => {
    expect(stats([])).toEqual({ count: 0, p50: null, p95: null, max: null })
    const r = stats(Array.from({ length: 100 }, (_, i) => i + 1))
    expect([r.p50, r.p95, r.max]).toEqual([50, 95, 100])
  })

  it("doubledSinkKeys: keys counted more than once since the run started", () => {
    expect(
      doubledSinkKeys(
        [
          {
            orgId: "o1",
            effects: [
              { kind: "mail", key: "a", count: 2, lastAt: T0 + 5 },
              { kind: "mail", key: "b", count: 1, lastAt: T0 + 5 },
            ],
          },
          { orgId: "o2", effects: [{ kind: "push", key: "c", count: 3, lastAt: T0 - 5 }] },
        ],
        T0,
      ),
    ).toEqual(["o1|mail|a"])
  })
})
