// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The contract harness turns red on each mutation it exists for: a module
// level cache that changes a result, an in-run 10 s sleep, a loop past its
// budget, a bridge call nobody recorded; and stays green on a well-behaved
// entry, on QuickJS and on the Workers-shaped executor (worker-core).
import { afterAll, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runLimits } from "~/modules/apps/run-limits"
import type { ContractEntry } from "./entries"
import { type AppUnderContract, runAppContract } from "./harness"
import { quickJsContractExecutor } from "./quickjs-isolate"
import { lintAppWaits } from "./wait-lint"
import { workerCoreContractExecutor } from "./worker-core-isolate"

const HANDLERS = {
  pure: `async function pure(params, ctx) { ctx.logger.info("pure"); return { n: (params.n || 0) + 1, at: Date.now(), r: Math.random() } }`,
  cached: `var memo = null;
async function cached(params, ctx) { if (memo === null) memo = { count: 0 }; memo.count++; return { count: memo.count } }`,
  sleepy: `async function sleepy() { await new Promise(function (r) { setTimeout(r, 10000) }); return "woke" }`,
  pacedShort: `async function pacedShort() { for (var i = 0; i < 3; i++) await new Promise(function (r) { setTimeout(r, 500) }); return "ok" }`,
  spin: `async function spin() { while (true) {} }`,
  fetches: `async function fetches(params, ctx) { var r = await ctx.fetch("https://api.example.test/items", { method: "GET" }); return r.items.length }`,
}
const SCRIPT = `${Object.values(HANDLERS).join("\n")}
${Object.keys(HANDLERS)
  .map((k) => `globalThis.${k} = ${k};`)
  .join("\n")}`

const entry = (name: string): ContractEntry => ({
  entry: `tool:${name}`,
  kind: "tool",
  exportName: name,
})
const SURFACE = [
  ["fetch", "async"],
  ["log_info", "sync"],
] as const

const FIXTURES = {
  "tool:fetches": {
    entry: "tool:fetches",
    calls: [
      {
        method: "fetch",
        args: ["https://api.example.test/items", JSON.stringify({ method: "GET" })],
        reply: JSON.stringify({ items: [1, 2, 3] }),
      },
    ],
  },
}

const fastLimits = () => ({ ...runLimits("tool"), wallMs: 2_000 })

describe("app contract harness on QuickJS (one reused isolate)", () => {
  async function verdicts(names: string[], fixtures = {}) {
    const app: AppUnderContract = {
      app: "mutants",
      dir: "/nonexistent",
      entries: names.map(entry),
      source: { script: SCRIPT },
      surface: SURFACE,
      fixtures,
    }
    const out = await runAppContract(app, quickJsContractExecutor, { limitsFor: fastLimits })
    return Object.fromEntries(out.map((v) => [v.entry.slice("tool:".length), v]))
  }

  it("keeps a well-behaved entry green, short paced waits and replayed egress included", async () => {
    const v = await verdicts(["pure", "pacedShort", "fetches"], FIXTURES)
    expect(v.pure?.reasons).toEqual([])
    expect(v.pacedShort?.reasons).toEqual([])
    expect(v.fetches?.reasons).toEqual([])
  })

  it("is red on a module-level cache that changes a result", async () => {
    const v = await verdicts(["cached"])
    expect(v.cached?.reasons).toEqual(["module-state"])
  })

  it("is red on an in-run 10 s sleep (and it costs no real time)", async () => {
    const t0 = Date.now()
    const v = await verdicts(["sleepy"])
    expect(v.sleepy?.reasons).toEqual(["wait", "budget"])
    expect(Date.now() - t0).toBeLessThan(5_000)
  })

  it("is red on a loop past its budget, and the next entry still runs", async () => {
    const v = await verdicts(["spin", "pure"])
    expect(v.spin?.reasons).toEqual(["budget"])
    expect(v.pure?.reasons).toEqual([])
  })

  it("reports an unrecorded bridge call as no-fixture, and a missing export", async () => {
    const v = await verdicts(["fetches", "absent"])
    expect(v.fetches?.reasons).toEqual(["no-fixture"])
    expect(v.absent?.reasons).toEqual(["missing-export"])
  })
})

describe("app contract harness on the Workers-shaped executor", () => {
  const dir = mkdtempSync(join(tmpdir(), "contract-worker-core-"))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it("sees module state survive between runs of one isolate", async () => {
    const modulePath = join(dir, "app.mjs")
    writeFileSync(
      modulePath,
      `let memo = 0
export async function cached() { memo++; return { memo } }
export async function pure(params) { return { n: (params.n || 0) + 1 } }
`,
    )
    const app: AppUnderContract = {
      app: "mutants",
      dir,
      entries: [entry("cached"), entry("pure")],
      source: { modulePath },
      surface: SURFACE,
    }
    const out = await runAppContract(app, workerCoreContractExecutor, { limitsFor: fastLimits })
    expect(out.map((v) => [v.entry, v.reasons])).toEqual([
      ["tool:cached", ["module-state"]],
      ["tool:pure", []],
    ])
  })
})

describe("wait lint", () => {
  const dir = mkdtempSync(join(tmpdir(), "contract-lint-"))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it("flags timers, sleeps and poll loops that may wait past 2 s, never a short literal or UI code", () => {
    mkdirSync(join(dir, "src", "ui"), { recursive: true })
    writeFileSync(
      join(dir, "handlers.ts"),
      [
        "export async function a() { await sleep(10_000) }",
        "export async function b() { await new Promise((r) => setTimeout(r, 500)) }",
        "export async function c(ms: number) { await new Promise((r) => setTimeout(r, ms)) }",
        "export async function d() { while (Date.now() < deadline) await ping() }",
        "export async function e() { while (attempts < JOB_POLL_MAX_ATTEMPTS) await ping() }",
        "export async function f() { await sleep(250) }",
        "function sleep(ms: number) { return Promise.resolve(ms) }",
      ].join("\n"),
    )
    writeFileSync(join(dir, "src", "ui", "view.ts"), "setTimeout(() => {}, 60_000)\n")
    writeFileSync(join(dir, "src", "x.test.ts"), "await sleep(60_000)\n")
    expect(lintAppWaits(dir).map((s) => `${s.file}:${s.line}`)).toEqual([
      "handlers.ts:1",
      "handlers.ts:3",
      "handlers.ts:4",
      "handlers.ts:5",
    ])
  })
})
