// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import { eq } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { appsActiveVersion, appsInstalled } from "~/db/schema/kernel/apps-installed"
import { env } from "~/lib/env"
import * as bundleLoader from "~/modules/apps/sandbox/bundle-loader"
import * as executor from "~/modules/apps/sandbox/executor"
import * as sandboxPool from "~/modules/apps/sandbox/pool"
import {
  clearInstalledIdentityCache,
  resolveInstalledIdentity,
  resolveWorkersTarget,
  runApp,
  selectExecutor,
} from "~/modules/apps/sandbox/run-app"
import * as workerPool from "~/modules/apps/sandbox/worker-pool"
import * as workersExecutor from "~/modules/apps/workers/executor"
import { WorkersRunError, type WorkersRunInfo } from "~/modules/apps/workers/executor"
import { loaderBreaker, WorkersFallbackTestAccess } from "~/modules/apps/workers/fallback"
import { NETWORK_FAULT } from "~/modules/apps/workers/faults"
import { onRunSettled, type RunSettledInfo } from "~/modules/apps/workers/run-settled"
import { isWorkersRunBridge } from "./bridge/secret-free"

const fakeSandboxPool = { tag: "in-process" }

function spyBoundaries() {
  const inProcess = spyOn(executor, "executeInSandbox").mockResolvedValue("from-inprocess")
  spyOn(sandboxPool, "getSandboxPool").mockReturnValue(fakeSandboxPool as never)
  const execute = mock(async (_: unknown) => "from-pool")
  const init = spyOn(workerPool, "initWorkerPool").mockResolvedValue(undefined as never)
  spyOn(workerPool, "getWorkerPool").mockReturnValue({ execute } as never)
  return { inProcess, execute, init }
}

const bridge = { db_findMany: async () => [] }
const base = {
  appName: "kpi",
  orgId: "00000000-0000-0000-0000-000000000001",
  bundleSource: "globalThis.h = () => 1",
  exportName: "h",
  params: { a: 1 },
  bridge,
  holdsTx: false,
}

describe("runApp", () => {
  afterEach(() => mock.restore())

  it("selects in-process for trusted code and the worker pool otherwise", () => {
    expect(selectExecutor({ trusted: true })).toBe("inprocess")
    expect(selectExecutor({ trusted: false })).toBe("pool")
    // Workers only for untrusted code with a Worker bundle resolved.
    expect(selectExecutor({ trusted: false, workersBundleSha: "a".repeat(64) })).toBe("workers")
    expect(selectExecutor({ trusted: true, workersBundleSha: "a".repeat(64) })).toBe("inprocess")
  })

  it("selects per the table: sandbox service, the runtime switch, a site's in-process placement", () => {
    const sha = "a".repeat(64)
    // The instance's sandbox service takes what the loader does not.
    expect(selectExecutor({ trusted: false, sandboxService: true })).toBe("workerd")
    expect(selectExecutor({ trusted: false, workersBundleSha: sha, sandboxService: true })).toBe(
      "workers",
    )
    expect(selectExecutor({ trusted: true, sandboxService: true })).toBe("inprocess")
    // LIAISON_APP_RUNTIME=quickjs: QuickJS whatever is configured.
    const forced = { trusted: false, quickjsForced: true, sandboxService: true }
    expect(selectExecutor({ ...forced, workersBundleSha: sha })).toBe("pool")
    expect(selectExecutor({ ...forced, inProcess: true })).toBe("inprocess")
    // A site's in-process placement is a QuickJS placement only.
    expect(selectExecutor({ trusted: false, inProcess: true })).toBe("inprocess")
    expect(selectExecutor({ trusted: false, inProcess: true, sandboxService: true })).toBe(
      "workerd",
    )
  })

  it("keeps a site's QuickJS placement: its in-process pool, or its own worker pool and limits", async () => {
    const { inProcess, execute, init } = spyBoundaries()
    const ownPool = { tag: "summarizer-pool" }
    expect(
      await runApp({
        ...base,
        trusted: false,
        installed: null,
        quickjs: { inProcess: true, inProcessPool: ownPool as never },
      }),
    ).toBe("from-inprocess")
    expect(inProcess.mock.calls[0]?.[0]).toMatchObject({ pool: ownPool })
    const ownExecute = mock(async (_: unknown) => "from-own-pool")
    const onHeapReport = () => {}
    expect(
      await runApp({
        ...base,
        trusted: false,
        installed: null,
        quickjs: {
          workerPool: { execute: ownExecute } as never,
          memoryLimitBytes: 1024,
          onHeapReport,
        },
      }),
    ).toBe("from-own-pool")
    expect(ownExecute.mock.calls[0]?.[0]).toMatchObject({ memoryLimitBytes: 1024, onHeapReport })
    // The shared worker pool is neither started nor used for it.
    expect(init).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })

  it("runs trusted code in-process with exactly the executor's options", async () => {
    const { inProcess, execute, init } = spyBoundaries()
    const signal = new AbortController().signal
    const out = await runApp({
      ...base,
      trusted: true,
      extraArgs: [{ h: "1" }],
      timeoutMs: 9_000,
      signal,
      // Pool-only options never reach the in-process executor.
      priority: "background",
      appId: "kpi",
      nested: true,
    })
    expect(out).toBe("from-inprocess")
    expect(execute).not.toHaveBeenCalled()
    expect(init).not.toHaveBeenCalled()
    expect(inProcess.mock.calls[0]?.[0]).toEqual({
      pool: fakeSandboxPool as never,
      bundleSource: base.bundleSource,
      exportName: "h",
      params: { a: 1 },
      bridge,
      extraArgs: [{ h: "1" }],
      timeoutMs: 9_000,
      signal,
    })
  })

  it("runs untrusted code on the worker pool, initialised first, with every pool option", async () => {
    const { inProcess, execute, init } = spyBoundaries()
    const signal = new AbortController().signal
    const out = await runApp({
      ...base,
      trusted: false,
      timeoutMs: 60_000,
      signal,
      priority: "background",
      backgroundGroup: "job:kpi",
      appId: "kpi",
      toolName: "kpi_get",
      nested: true,
      nestedParentKey: "exec-1",
      syncContext: { approval: null },
      extraArgs: ["x"],
      holdsTx: true,
    })
    expect(out).toBe("from-pool")
    expect(inProcess).not.toHaveBeenCalled()
    expect(init).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0]?.[0]).toEqual({
      bundleSource: base.bundleSource,
      exportName: "h",
      params: { a: 1 },
      bridge,
      extraArgs: ["x"],
      timeoutMs: 60_000,
      syncContext: { approval: null },
      priority: "background",
      backgroundGroup: "job:kpi",
      nested: true,
      nestedParentKey: "exec-1",
      signal,
      appId: "kpi",
      toolName: "kpi_get",
    })
  })

  it("leaves unset options unset (the pool and executor defaults apply)", async () => {
    const { execute } = spyBoundaries()
    await runApp({ ...base, trusted: false })
    expect(Object.keys(execute.mock.calls[0]?.[0] as object).sort()).toEqual(
      ["bridge", "bundleSource", "exportName", "params"].sort(),
    )
  })

  it("loads the bundle from bundlePath when no source is given", async () => {
    const { execute } = spyBoundaries()
    const load = spyOn(bundleLoader, "loadBundle").mockResolvedValue("loaded-source")
    const { bundleSource: _drop, ...noSource } = base
    await runApp({ ...noSource, trusted: false, bundlePath: "/x/kpi/1.0.0/bundle.js" })
    expect(load).toHaveBeenCalledWith("/x/kpi/1.0.0/bundle.js")
    expect(execute.mock.calls[0]?.[0]).toMatchObject({ bundleSource: "loaded-source" })
  })

  it("refuses a call with neither bundle source nor path", async () => {
    spyBoundaries()
    const { bundleSource: _drop, ...noSource } = base
    await expect(runApp({ ...noSource, trusted: false })).rejects.toThrow(/bundlePath/)
  })
})

describe("runApp: a loader fault before any bridge call", () => {
  const KEYS = [
    "LIAISON_APP_LOADER_URL",
    "LIAISON_APP_LOADER_CELL_ID",
    "LIAISON_APP_LOADER_KEY",
    "LIAISON_SANDBOX_URL",
  ] as const
  type Mutable = Record<string, string | undefined>
  const saved = Object.fromEntries(KEYS.map((k) => [k, (env as unknown as Mutable)[k]]))
  const savedRole = env.LIAISON_ROLE
  const settled: RunSettledInfo[] = []
  const unsubscribe = onRunSettled((i) => {
    if (i.app === "lf") settled.push(i)
  })

  function workersOn() {
    const e = env as unknown as Mutable
    e.LIAISON_APP_LOADER_URL = "http://loader.invalid"
    e.LIAISON_APP_LOADER_CELL_ID = "cell-lf"
    e.LIAISON_APP_LOADER_KEY = "lf-cell-key-0123456789abcdef"
    ;(env as unknown as Mutable).LIAISON_ROLE = "all"
  }

  /** The Workers run fails as `info` says; what it was handed is kept. */
  function failingWorkers(info: WorkersRunInfo) {
    const seen: Array<Record<string, unknown>> = []
    spyOn(workersExecutor, "executeOnWorkers").mockImplementation(async (opts, onInfo) => {
      seen.push(opts.bridge)
      onInfo?.(info)
      throw new WorkersRunError("App loader unreachable: connection refused", NETWORK_FAULT)
    })
    return seen
  }

  // config_get decrypts `token` (a QuickJS bridge reads it; a Workers one must not).
  const quickjsBridge = () => {
    const b: Record<string, (...a: any[]) => any> = {
      config_get: async (key: string) => `value-of-${key}`,
      emit: async () => 1,
    }
    return b
  }
  const run = (bridge: Record<string, (...a: any[]) => any>) =>
    runApp({
      ...base,
      appName: "lf",
      trusted: false,
      installed: { version: "1.0.0", sha256: "c".repeat(64), workerSha256: "b".repeat(64) },
      bridge,
      timeoutMs: 4_000,
    })

  afterEach(() => {
    mock.restore()
    settled.length = 0
    WorkersFallbackTestAccess.reset()
    const e = env as unknown as Mutable
    for (const k of KEYS) e[k] = saved[k]
    ;(env as unknown as Mutable).LIAISON_ROLE = savedRole
  })
  afterAll(() => unsubscribe())

  it("runs once more on QuickJS, on the untouched bridge, recorded loader_fault", async () => {
    workersOn()
    const { execute } = spyBoundaries()
    const seen = failingWorkers({
      runId: "r-1",
      attempts: 2,
      bridgeCalls: 0,
      fault: NETWORK_FAULT,
    })
    const bridge = quickjsBridge()
    const out = await run(bridge)
    expect(out).toBe("from-pool")
    // Workers got a secret-free copy; QuickJS the original, unchanged.
    expect(seen).toHaveLength(1)
    expect(seen[0]).not.toBe(bridge)
    expect(isWorkersRunBridge(seen[0])).toBe(true)
    const workersConfigGet = seen[0]?.config_get as (k: string) => Promise<unknown>
    await expect(workersConfigGet("token")).rejects.toThrow(/not available/)
    const pooled = execute.mock.calls[0]?.[0] as { bridge: unknown; timeoutMs: number }
    expect(pooled.bridge).toBe(bridge)
    expect(isWorkersRunBridge(bridge)).toBe(false)
    expect(await bridge.config_get?.("token")).toBe("value-of-token")
    expect(pooled.timeoutMs).toBeGreaterThan(0)
    expect(pooled.timeoutMs).toBeLessThanOrEqual(4_000)
    expect(settled.at(-1)).toMatchObject({
      executor: "quickjs",
      ok: true,
      fallback: "loader_fault",
      attempts: 2,
      faultClass: "loader",
      errorKind: "network",
    })
  })

  it("never falls back once a bridge call was made", async () => {
    workersOn()
    const { execute } = spyBoundaries()
    failingWorkers({ runId: "r-2", attempts: 1, bridgeCalls: 1, fault: NETWORK_FAULT })
    await expect(run(quickjsBridge())).rejects.toThrow("App loader unreachable")
    expect(execute).not.toHaveBeenCalled()
    expect(settled.at(-1)).toMatchObject({ executor: "workers", ok: false, faultClass: "loader" })
    expect(settled.at(-1)?.fallback).toBeUndefined()
  })

  /** The loader fails (network, before any bridge call); the sandbox service answers. */
  function loaderDownServiceUp() {
    const calls: Array<{ loaderUrl: string; opts: Record<string, unknown> }> = []
    spyOn(workersExecutor, "executeOnWorkers").mockImplementation(async (opts, onInfo) => {
      calls.push({ loaderUrl: opts.config.loaderUrl, opts: opts as never })
      if (opts.config.loaderUrl === "http://sandbox.invalid") {
        onInfo?.({ runId: "r-sb", attempts: 1, bridgeCalls: 0 })
        return "from-workerd"
      }
      onInfo?.({ runId: "r-ld", attempts: 2, bridgeCalls: 0, fault: NETWORK_FAULT })
      throw new WorkersRunError("App loader unreachable: connection refused", NETWORK_FAULT)
    })
    return calls
  }

  it("with the sandbox service configured: runs once more there, secret-free, labelled workerd", async () => {
    workersOn()
    ;(env as unknown as Mutable).LIAISON_SANDBOX_URL = "http://sandbox.invalid/"
    const { execute } = spyBoundaries()
    const calls = loaderDownServiceUp()
    const bridge = quickjsBridge()
    expect(await run(bridge)).toBe("from-workerd")
    expect(execute).not.toHaveBeenCalled()
    expect(calls.map((c) => c.loaderUrl)).toEqual([
      "http://loader.invalid",
      "http://sandbox.invalid",
    ])
    const service = calls[1]?.opts as {
      bridge: Record<string, unknown>
      config: { cellId: string }
    }
    // Same cell identity, a secret-free bridge, never the QuickJS one.
    expect(service.config.cellId).toBe("cell-lf")
    expect(service.bridge).not.toBe(bridge)
    expect(isWorkersRunBridge(service.bridge)).toBe(true)
    // Its own breaker and no app fallbacks: the loader's state is not its to change.
    expect(calls[1]?.opts.breaker).toBeDefined()
    expect(calls[1]?.opts.breaker).not.toBe(loaderBreaker)
    expect(settled.at(-1)).toMatchObject({
      executor: "workerd",
      ok: true,
      fallback: "loader_fault",
      runId: "r-sb",
      attempts: 2,
      faultClass: "loader",
      errorKind: "network",
    })
  })

  it("with the sandbox service configured: an open breaker sends the run there, labelled breaker", async () => {
    workersOn()
    ;(env as unknown as Mutable).LIAISON_SANDBOX_URL = "http://sandbox.invalid"
    const { execute } = spyBoundaries()
    for (let i = 0; i < 5; i++) loaderBreaker.record("loader_fault")
    expect(loaderBreaker.state()).toBe("open")
    const calls = loaderDownServiceUp()
    expect(await run(quickjsBridge())).toBe("from-workerd")
    expect(execute).not.toHaveBeenCalled()
    expect(calls.map((c) => c.loaderUrl)).toEqual(["http://sandbox.invalid"])
    expect(settled.at(-1)).toMatchObject({ executor: "workerd", ok: true, fallback: "breaker" })
  })

  it("without it: an open breaker sends the run to QuickJS, labelled breaker", async () => {
    workersOn()
    const { execute } = spyBoundaries()
    for (let i = 0; i < 5; i++) loaderBreaker.record("loader_fault")
    const calls = loaderDownServiceUp()
    expect(await run(quickjsBridge())).toBe("from-pool")
    expect(execute).toHaveBeenCalledTimes(1)
    expect(calls).toHaveLength(0)
    expect(settled.at(-1)).toMatchObject({ executor: "quickjs", ok: true, fallback: "breaker" })
  })

  it("an app-level or final fault is the run's error (no fallback for that run)", async () => {
    workersOn()
    const { execute } = spyBoundaries()
    failingWorkers({ attempts: 1, bridgeCalls: 0, fault: { class: "final", kind: "handler" } })
    await expect(run(quickjsBridge())).rejects.toThrow()
    failingWorkers({ attempts: 1, bridgeCalls: 0, fault: { class: "app", kind: "load" } })
    await expect(run(quickjsBridge())).rejects.toThrow()
    expect(execute).not.toHaveBeenCalled()
  })
})

describe("resolveWorkersTarget: every sandboxed app once a loader is configured", () => {
  const KEYS = [
    "LIAISON_APP_LOADER_URL",
    "LIAISON_APP_LOADER_CELL_ID",
    "LIAISON_APP_LOADER_KEY",
  ] as const
  type Mutable = Record<string, string | undefined>
  const saved = Object.fromEntries(KEYS.map((k) => [k, (env as unknown as Mutable)[k]]))
  afterEach(() => {
    const e = env as unknown as Mutable
    for (const k of KEYS) e[k] = saved[k]
  })
  const loaderOn = () => {
    const e = env as unknown as Mutable
    e.LIAISON_APP_LOADER_URL = "http://loader.invalid"
    e.LIAISON_APP_LOADER_CELL_ID = "cell-sel"
    e.LIAISON_APP_LOADER_KEY = "sel-cell-key-0123456789abcdef"
  }
  const WORKER = "d".repeat(64)
  const at = (installed: { version: string; sha256: string; workerSha256: string | null }) => ({
    trusted: false,
    appName: "any-catalog-app",
    orgId: base.orgId,
    installed,
  })

  it("runs nothing on Workers without a loader", async () => {
    const e = env as unknown as Mutable
    for (const k of KEYS) e[k] = undefined
    expect(
      await resolveWorkersTarget(
        at({ version: "1.0.0", sha256: "c".repeat(64), workerSha256: WORKER }),
      ),
    ).toBeNull()
  })

  it("runs any untrusted app on its recorded Worker module, no allowlist", async () => {
    loaderOn()
    const target = await resolveWorkersTarget(
      at({ version: "1.0.0", sha256: "c".repeat(64), workerSha256: WORKER }),
    )
    expect(target?.sha256).toBe(WORKER)
    expect(target?.version).toBe("1.0.0")
    expect(target?.config.cellId).toBe("cell-sel")
    // Trusted code never goes there.
    expect(
      await resolveWorkersTarget({
        ...at({ version: "1.0.0", sha256: "c".repeat(64), workerSha256: WORKER }),
        trusted: true,
      }),
    ).toBeNull()
  })

  it("keeps a version installed without a Worker module on QuickJS", async () => {
    loaderOn()
    expect(
      await resolveWorkersTarget(
        at({ version: "1.0.0", sha256: "c".repeat(64), workerSha256: null }),
      ),
    ).toBeNull()
  })
})

describe("runApp on a self-hosted instance (the sandbox service, no loader)", () => {
  const KEYS = [
    "LIAISON_APP_LOADER_URL",
    "LIAISON_APP_LOADER_CELL_ID",
    "LIAISON_APP_LOADER_KEY",
    "LIAISON_SANDBOX_URL",
    "LIAISON_SANDBOX_BRIDGE_URL",
    "LIAISON_APP_RUNTIME",
  ] as const
  type Mutable = Record<string, string | undefined>
  const saved = Object.fromEntries(KEYS.map((k) => [k, (env as unknown as Mutable)[k]]))
  const settled: RunSettledInfo[] = []
  const unsubscribe = onRunSettled((i) => {
    if (i.app === "sh") settled.push(i)
  })
  afterEach(() => {
    mock.restore()
    settled.length = 0
    const e = env as unknown as Mutable
    for (const k of KEYS) e[k] = saved[k]
  })
  afterAll(() => unsubscribe())

  const WORKER = "e".repeat(64)
  const sandboxOn = () => {
    const e = env as unknown as Mutable
    for (const k of KEYS) e[k] = undefined
    e.LIAISON_SANDBOX_URL = "http://sandbox.invalid:8790"
    e.LIAISON_SANDBOX_BRIDGE_URL = "http://bridge.invalid:3100"
  }
  const run = (over: Partial<Parameters<typeof runApp>[0]> = {}) =>
    runApp({
      ...base,
      appName: "sh",
      trusted: false,
      installed: { version: "2.0.0", sha256: "c".repeat(64), workerSha256: WORKER },
      bridge: { config_get: async (k: string) => `value-of-${k}` },
      ...over,
    })

  function serviceAnswers() {
    const calls: Array<Record<string, any>> = []
    spyOn(workersExecutor, "executeOnWorkers").mockImplementation(async (opts, onInfo) => {
      calls.push(opts as never)
      onInfo?.({ runId: "r-sh", attempts: 1, bridgeCalls: 0 })
      return "from-workerd"
    })
    return calls
  }

  it("runs every sandboxed app with a Worker module there, secret-free, labelled workerd", async () => {
    sandboxOn()
    const { execute, inProcess } = spyBoundaries()
    const calls = serviceAnswers()
    expect(await run()).toBe("from-workerd")
    expect(execute).not.toHaveBeenCalled()
    expect(inProcess).not.toHaveBeenCalled()
    const opts = calls[0] ?? {}
    expect(opts.config).toMatchObject({
      loaderUrl: "http://sandbox.invalid:8790",
      cellId: "sandbox",
      bridgeBaseUrl: "http://bridge.invalid:3100",
    })
    expect(opts.bundleSha256).toBe(WORKER)
    expect(isWorkersRunBridge(opts.bridge)).toBe(true)
    // The module is pushed (the service fetches nothing), and the loader's state is untouched.
    expect(typeof opts.pushModule).toBe("function")
    expect(opts.breaker).not.toBe(loaderBreaker)
    expect(settled.at(-1)).toMatchObject({ executor: "workerd", ok: true, runId: "r-sh" })
    expect(settled.at(-1)?.fallback).toBeUndefined()
  })

  it("keeps trusted code in process, and code with no installed version on QuickJS", async () => {
    sandboxOn()
    const { execute, inProcess } = spyBoundaries()
    const calls = serviceAnswers()
    expect(await run({ trusted: true })).toBe("from-inprocess")
    expect(await run({ installed: null })).toBe("from-pool")
    expect(await run({ installed: null, quickjs: { inProcess: true } })).toBe("from-inprocess")
    expect(calls).toHaveLength(0)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(inProcess).toHaveBeenCalledTimes(2)
  })

  it("LIAISON_APP_RUNTIME=quickjs puts every run back on QuickJS", async () => {
    sandboxOn()
    ;(env as unknown as Mutable).LIAISON_APP_RUNTIME = "quickjs"
    const { execute } = spyBoundaries()
    const calls = serviceAnswers()
    expect(await run()).toBe("from-pool")
    expect(calls).toHaveLength(0)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(settled.at(-1)).toMatchObject({ executor: "quickjs", ok: true })
  })

  it("LIAISON_APP_RUNTIME=quickjs also overrides a configured loader", async () => {
    sandboxOn()
    const e = env as unknown as Mutable
    e.LIAISON_APP_LOADER_URL = "http://loader.invalid"
    e.LIAISON_APP_LOADER_CELL_ID = "cell-sh"
    e.LIAISON_APP_LOADER_KEY = "sh-cell-key-0123456789abcdef"
    e.LIAISON_APP_RUNTIME = "quickjs"
    spyBoundaries()
    const calls = serviceAnswers()
    expect(await run()).toBe("from-pool")
    expect(calls).toHaveLength(0)
  })

  it("without the sandbox service (the default): QuickJS, as before", async () => {
    const e = env as unknown as Mutable
    for (const k of KEYS) e[k] = undefined
    const { execute } = spyBoundaries()
    const calls = serviceAnswers()
    expect(await run()).toBe("from-pool")
    expect(calls).toHaveLength(0)
    expect(execute).toHaveBeenCalledTimes(1)
  })
})

describe("resolveInstalledIdentity", () => {
  it("answers null without a database read for a bundle outside the install layout", async () => {
    // An in-tree app's bundle: its directory is not `<app>/<version>`.
    expect(
      await resolveInstalledIdentity(
        "kpi",
        base.orgId,
        "/repo/apps/api/src/apps/tickets/handlers.ts",
      ),
    ).toBeNull()
  })

  const APP = "run-app-identity-probe"
  afterAll(async () => {
    clearInstalledIdentityCache()
    await withSystemDb("run-app-test-cleanup", async (db) => {
      await db.delete(appsActiveVersion).where(eq(appsActiveVersion.name, APP))
      await db.delete(appsInstalled).where(eq(appsInstalled.name, APP))
    })
  })

  it("reads the version directory's record, cached per version directory", async () => {
    const row = (version: string, sha256: string) => ({
      name: APP,
      version,
      sourceUrl: "file:///probe",
      sha256,
      installedBy: "00000000-0000-0000-0000-000000000000",
    })
    await withSystemDb("run-app-test-seed", async (db) => {
      await db
        .insert(appsInstalled)
        .values([row("1.0.0", "a".repeat(64)), row("1.1.0", "b".repeat(64))])
      await db.insert(appsActiveVersion).values({ name: APP, version: "1.1.0" })
    })
    const at = (v: string) => `/srv/apps/${APP}/${v}/bundle.js`
    expect(await resolveInstalledIdentity(APP, base.orgId, at("1.0.0"))).toEqual({
      version: "1.0.0",
      sha256: "a".repeat(64),
      // No Workers module recorded for this version.
      workerSha256: null,
    })
    // Without a bundle path: the active version.
    expect(await resolveInstalledIdentity(APP, base.orgId)).toEqual({
      version: "1.1.0",
      sha256: "b".repeat(64),
      workerSha256: null,
    })
    // A version directory never changes: the second answer comes from the cache.
    await withSystemDb("run-app-test-drop", (db) =>
      db.delete(appsInstalled).where(eq(appsInstalled.version, "1.0.0")),
    )
    expect((await resolveInstalledIdentity(APP, base.orgId, at("1.0.0")))?.version).toBe("1.0.0")
    expect(await resolveInstalledIdentity(APP, base.orgId, at("9.9.9"))).toBeNull()
  })
})
