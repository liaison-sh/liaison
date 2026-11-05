// SPDX-License-Identifier: FSL-1.1-ALv2
// Every process that runs QuickJS WASM must start with JSC's optimizing WASM
// tier off (QUICKJS_HOST_JSC_ENV). JSC reads the option once at process start,
// so it cannot be set from inside the server: each launch point carries it in
// its env. These cases pin every launch point that starts an API server or a
// sandbox worker. The behavioural proof that the option bounds a worker's RSS
// lives in worker-pool.test.ts.
import { describe, expect, it } from "bun:test"
import { join } from "node:path"
import { QUICKJS_HOST_JSC_ENV } from "~/modules/apps/sandbox/pool"
import { workerEnv } from "~/modules/apps/sandbox/worker-pool"

// quickjs-host-jsc-env.test.ts -> liaison repo root (apps/api/src/modules/apps/sandbox -> up 6).
const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..", "..")
const read = (rel: string) => Bun.file(join(REPO_ROOT, rel)).text()
const entries = Object.entries(QUICKJS_HOST_JSC_ENV)

describe("QuickJS host JSC env", () => {
  it("turns the optimizing WASM tier off and nothing else", () => {
    expect({ ...QUICKJS_HOST_JSC_ENV }).toEqual({ BUN_JSC_useOMGJIT: "0" })
  })

  it("every sandbox worker is spawned with it", () => {
    const env = workerEnv()
    for (const [key, value] of entries) expect(env[key]).toBe(value)
  })

  it("the production image starts the API with it", async () => {
    const dockerfile = await read("apps/api/Dockerfile")
    for (const [key, value] of entries) expect(dockerfile).toContain(`\nENV ${key}=${value}\n`)
  })

  it("the api dev and start scripts start the server with it", async () => {
    const pkg = JSON.parse(await read("apps/api/package.json")) as {
      scripts: Record<string, string>
    }
    const prefix = entries.map(([key, value]) => `${key}=${value}`).join(" ")
    expect(pkg.scripts.dev).toStartWith(`${prefix} bun `)
    expect(pkg.scripts.start).toStartWith(`${prefix} bun `)
  })

  it("the dev orchestrator and the e2e harness spawn the API with it", async () => {
    for (const rel of ["scripts/dev.ts", "packages/test-helpers/src/worker-env.ts"]) {
      const src = await read(rel)
      for (const [key, value] of entries) expect(`${rel}: ${src}`).toContain(`${key}: "${value}"`)
    }
  })
})
