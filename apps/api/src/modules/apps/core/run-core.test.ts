// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Core apps run as server code (S2): runApp calls the handler module's named
// export with a typed host ctx, never a sandbox, a ctx shim or a bundle
// transform, and every handler a core manifest names is an export of its module.
import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import { readFileSync } from "node:fs"
import { CORE_OPEN_TRANSACTION, type OpenTransaction } from "~/modules/apps/core/ctx"
import {
  CORE_APP_MODULES,
  CORE_MODULE_SOURCE,
  coreModuleFor,
  isCoreModulePath,
} from "~/modules/apps/core/registry"
import { coreCtxOf } from "~/modules/apps/core/run-core"
import { loadBundle } from "~/modules/apps/sandbox/bundle-loader"
import { exportOnlyBundle } from "~/modules/apps/sandbox/bundle-shake"
import * as executor from "~/modules/apps/sandbox/executor"
import { runApp } from "~/modules/apps/sandbox/run-app"
import * as workerPool from "~/modules/apps/sandbox/worker-pool"
import { onRunSettled, type RunSettledInfo } from "~/modules/apps/workers/run-settled"

const ORG = "00000000-0000-0000-0000-0000000c0e01"
const tickets = CORE_APP_MODULES.tickets!

/** Every handler name an app manifest declares, by where it declares it. */
function manifestHandlerNames(manifest: Record<string, any>): string[] {
  const names = new Set<string>()
  for (const t of Object.values<any>(manifest.tools ?? {})) {
    if (typeof t.handler === "string") names.add(t.handler)
    if (typeof t.preflight === "string") names.add(t.preflight)
  }
  for (const j of Object.values<any>(manifest.jobs ?? {})) names.add(j.handler)
  for (const s of Object.values<any>(manifest.events?.subscribes ?? {})) {
    names.add(typeof s === "string" ? s : s.handler)
  }
  for (const w of Object.values<any>(manifest.webhooks ?? {})) {
    names.add(w.handler)
    if (w.verify) names.add(w.verify)
  }
  if (manifest.export?.handler) names.add(manifest.export.handler)
  const attention = manifest.views?.attentionItems
  if (typeof attention === "string") names.add(attention)
  else if (typeof attention?.handler === "string") names.add(attention.handler)
  return [...names].sort()
}

describe("core app registry", () => {
  for (const [app, mod] of Object.entries(CORE_APP_MODULES)) {
    it(`${app}: its descriptor's bundle path is its module, and every manifest handler is an export`, async () => {
      const descriptor = (await import(`~/apps/${app}/manifest-descriptor`)) as Record<
        string,
        { _bundlePath?: string }
      >
      const declared = Object.values(descriptor).find((d) => d && typeof d === "object")
      expect(declared?._bundlePath).toBe(mod.modulePath)
      const manifest = JSON.parse(
        readFileSync(new URL(`../../../apps/${app}/app.manifest.json`, import.meta.url), "utf8"),
      )
      const exports = await mod.load()
      const missing = manifestHandlerNames(manifest).filter((n) => typeof exports[n] !== "function")
      expect(missing).toEqual([])
    })
  }

  it("matches by app name AND module path, so nothing else reaches a core module", () => {
    expect(coreModuleFor("tickets", tickets.modulePath)).toBe(tickets)
    expect(coreModuleFor("tickets", "/var/lib/liaison/apps/tickets/1.0.0/bundle.js")).toBeNull()
    expect(coreModuleFor("other", tickets.modulePath)).toBeNull()
    expect(coreModuleFor("constructor", tickets.modulePath)).toBeNull()
    expect(isCoreModulePath(tickets.modulePath)).toBe(true)
  })

  it("a core module is never transpiled or shaken as a bundle", async () => {
    expect(await loadBundle(tickets.modulePath)).toBe(CORE_MODULE_SOURCE)
    expect(
      exportOnlyBundle(CORE_MODULE_SOURCE, "search", { trusted: true, firstParty: true }),
    ).toBe(CORE_MODULE_SOURCE)
  })
})

describe("runApp on a core app", () => {
  afterEach(() => mock.restore())

  it("calls the module export in this process, on no sandbox, recorded as in-process", async () => {
    const inProcess = spyOn(executor, "executeInSandbox")
    const pool = spyOn(workerPool, "getWorkerPool")
    const settled: RunSettledInfo[] = []
    const off = onRunSettled((i) => {
      if (i.orgId === ORG) settled.push(i)
    })
    const calls: string[] = []
    const bridge = {
      tickets_search: async (paramsJson: string) => {
        calls.push(paramsJson)
        return JSON.stringify({ items: [], total: 0, extra: undefined })
      },
    }
    try {
      const out = await runApp({
        // What the site says about trust no longer decides where a core handler runs.
        trusted: false,
        appName: "tickets",
        orgId: ORG,
        bundlePath: tickets.modulePath,
        bundleSource: CORE_MODULE_SOURCE,
        exportName: "search",
        params: { q: "x" },
        bridge,
        holdsTx: false,
      })
      expect(out).toEqual({ items: [], total: 0 })
      expect(calls).toEqual([JSON.stringify({ q: "x" })])
      expect(inProcess).not.toHaveBeenCalled()
      expect(pool).not.toHaveBeenCalled()
      expect(settled.map((s) => [s.app, s.executor, s.ok])).toEqual([
        ["tickets", "inprocess", true],
      ])
    } finally {
      off()
    }
  })

  it("an unknown export fails typed, and a thrown error keeps its own shape", async () => {
    const run = (exportName: string, bridge: Record<string, (...a: any[]) => any>) =>
      runApp({
        trusted: true,
        appName: "tickets",
        orgId: ORG,
        bundlePath: tickets.modulePath,
        exportName,
        params: {},
        bridge,
        holdsTx: false,
      })
    await expect(run("nope", {})).rejects.toThrow('Export "nope" not found in core app tickets')
    const boom = Object.assign(new Error("db down"), { code: "upstream" })
    const err = await run("search", {
      tickets_search: async () => {
        throw boom
      },
    }).catch((e: unknown) => e)
    expect(err).toBe(boom)
  })
})

describe("ctx.transaction", () => {
  it("runs on the held transaction when the run holds one", async () => {
    const bridge = { m: () => "held" }
    const ctx = coreCtxOf(bridge, true, null)
    expect(await ctx.transaction(async (c) => c.m())).toBe("held")
  })

  it("opens one through the run's opener, with a ctx over the transaction's bridge", async () => {
    const opened: string[] = []
    const txBridge = { m: () => "in-tx" }
    const open: OpenTransaction = async (fn) => {
      opened.push("begin")
      const r = await fn(txBridge)
      opened.push("commit")
      return r
    }
    const bridge = { m: () => "session" }
    Object.defineProperty(bridge, CORE_OPEN_TRANSACTION, { value: open })
    const ctx = coreCtxOf(bridge, false, { approvalRequestId: "a" })
    const out = await ctx.transaction(async (c) => {
      // Nested: already inside, no second transaction.
      const inner = await c.transaction(async (c2) => c2.m())
      return [c.m(), inner, c.approval]
    })
    expect(out).toEqual(["in-tx", "in-tx", { approvalRequestId: "a" }])
    expect(opened).toEqual(["begin", "commit"])
  })

  it("refuses when the run has none to open", async () => {
    const ctx = coreCtxOf({}, false, null)
    await expect(ctx.transaction(async () => 1)).rejects.toThrow("no transaction to open")
  })

  it("the tickets setters and convertToMail run their whole body in one", async () => {
    const mod = await tickets.load()
    for (const name of [
      "assign",
      "setCategory",
      "setLanguage",
      "setTeam",
      "setAudience",
      "convertToMail",
    ]) {
      let inTx = false
      const ctx = {
        transaction: async (fn: (c: unknown) => Promise<unknown>) => {
          inTx = true
          return fn(txCtx)
        },
      }
      const seen: boolean[] = []
      const txCtx = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "then") return undefined
            if (prop === "transaction") return ctx.transaction
            return async () => {
              seen.push(inTx)
              throw new Error("stop")
            }
          },
        },
      )
      await (mod[name] as (p: unknown, c: unknown) => Promise<unknown>)(
        { ticketId: "ticket-1", accountId: "a" },
        ctx,
      ).catch(() => {})
      expect({ name, inTx, seen }).toEqual({ name, inTx: true, seen: [true] })
    }
  })
})
