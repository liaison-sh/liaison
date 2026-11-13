// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The one door (run-app.ts): every site that runs sandboxed code goes through
// `runApp`, which alone picks the executor. This guard reads the API's source
// and fails when a file outside the executors calls one directly: the QuickJS
// executor (`executeInSandbox`, a pool's `execute` with a bundle, a QuickJS
// context's `evalCode`/`callFunction`, a fresh QuickJS module) or the remote
// one (`executeOnWorkers`). It also pins the entry points that must stay on
// the door, so a site moved off it fails here rather than in production.
import { describe, expect, it } from "bun:test"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const SRC = join(import.meta.dir, "../../..")

/** A direct call of an executor. Matched on source with comments removed. */
const DIRECT_CALLS: Array<{ name: string; re: RegExp }> = [
  { name: "executeInSandbox(", re: /\bexecuteInSandbox\s*\(/ },
  { name: "executeOnWorkers(", re: /\bexecuteOnWorkers\s*\(/ },
  { name: "getWorkerPool().execute", re: /\bgetWorkerPool\(\)\s*\.\s*execute\b/ },
  { name: "a pool's execute({ bundleSource })", re: /\.execute\(\s*\{[^}]*\bbundleSource\b/ },
  { name: "QuickJS evalCode / callFunction", re: /\.(?:evalCode|callFunction)\s*\(/ },
  { name: "a new QuickJS module", re: /\bnewQuickJS\w*\s*\(/ },
]

/** The executors themselves, the door, and test support (each with its reason). */
const ALLOWED: Record<string, string> = {
  "modules/apps/sandbox/run-app.ts": "the door",
  "modules/apps/sandbox/executor.ts": "the in-process QuickJS executor",
  "modules/apps/sandbox/pool.ts": "the in-process QuickJS pool",
  "modules/apps/sandbox/worker-pool.ts": "the out-of-process QuickJS pool",
  "modules/apps/sandbox/sandbox-worker.ts": "the out-of-process QuickJS worker",
  "modules/apps/sandbox/webcrypto-shim.ts": "the QuickJS executor's WebCrypto shim",
  "modules/apps/sandbox/bridge-rejection.ts": "the QuickJS executor's error marshalling",
  "modules/apps/workers/executor.ts": "the remote executor (loader, sandbox service)",
  "modules/apps/contract/quickjs-isolate.ts":
    "test support: the contract harness's QuickJS isolate",
}

/** Test code: `*.test.ts`, fixtures, and the test trees. */
function isTestCode(rel: string): boolean {
  return (
    rel.endsWith(".test.ts") ||
    rel.includes("/__fixtures__/") ||
    rel.startsWith("tests/") ||
    rel.startsWith("test/") ||
    rel.endsWith(".d.ts")
  )
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) sourceFiles(path, out)
    else if (name.endsWith(".ts")) out.push(path)
  }
  return out
}

/** Source without comments (a comment may name an executor). */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1")
}

function violationsIn(text: string): string[] {
  const body = code(text)
  return DIRECT_CALLS.filter((c) => c.re.test(body)).map((c) => c.name)
}

describe("the one door", () => {
  it("no site outside the executors calls an executor directly", () => {
    const found: string[] = []
    for (const path of sourceFiles(SRC)) {
      const rel = relative(SRC, path)
      if (isTestCode(rel) || rel in ALLOWED) continue
      for (const v of violationsIn(readFileSync(path, "utf8"))) found.push(`${rel}: ${v}`)
    }
    expect(found).toEqual([])
  })

  it("catches each kind of direct call (the guard itself works)", () => {
    expect(violationsIn("await executeInSandbox({ pool, bundleSource })")).toEqual([
      "executeInSandbox(",
    ])
    expect(violationsIn("await pool.execute({ bundleSource, exportName })")).toEqual([
      "a pool's execute({ bundleSource })",
    ])
    expect(violationsIn("return executeOnWorkers(opts)")).toEqual(["executeOnWorkers("])
    expect(violationsIn("getWorkerPool().execute(exec)")).toEqual(["getWorkerPool().execute"])
    expect(violationsIn("slot.context.evalCode(src)")).toEqual(["QuickJS evalCode / callFunction"])
    expect(violationsIn("await newQuickJSAsyncWASMModule()")).toEqual(["a new QuickJS module"])
    // A comment that names an executor is not a call.
    expect(violationsIn("// executeInSandbox(opts) used to run here\nconst x = 1")).toEqual([])
  })

  it("lists only files that exist (a stale exception fails)", () => {
    for (const rel of Object.keys(ALLOWED)) expect(existsSync(join(SRC, rel))).toBe(true)
  })

  // Every entry point that runs sandboxed code (tools, preflights, webhooks,
  // jobs, events, polls, reconciles, search, attention, exports, disconnect
  // hooks, import kinds, import transforms, PDF templates, approval
  // summarizers, app-builder previews, app pages, provisioning, knowledge
  // sync, the mail send bundle) reaches it through runApp.
  it.each([
    "modules/apps/execute-tool.ts",
    "modules/apps/runtime.ts",
    "modules/webhooks/manifest-execution.ts",
    "modules/export/invoke-export.ts",
    "modules/apps/attention-store.ts",
    "modules/apps/connections/before-disconnect.ts",
    "modules/imports/runner.ts",
    "modules/imports/transforms/execute.ts",
    "modules/pdf/sandbox-render.ts",
    "modules/app-builder/preview.ts",
    "modules/apps/app-pages.ts",
    "modules/apps/app-provisioning.ts",
    "modules/apps/knowledge-sync-dispatch.ts",
    "modules/mail/service.ts",
  ])("%s runs its sandboxed code through runApp", (rel) => {
    expect(code(readFileSync(join(SRC, rel), "utf8"))).toMatch(/\brunApp\s*\(/)
  })
})
