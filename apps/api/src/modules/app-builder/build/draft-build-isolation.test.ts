// SPDX-License-Identifier: FSL-1.1-ALv2
// A draft is org-written code: buildDraft must hand it to Bun only in its own
// build subprocess, never in this (the API) process. Bun's parsing entry points
// are wrapped here with counters; a valid draft and a draft with a macro import
// both go through buildDraft and the counters must stay at zero. The static half
// (the subprocess's modules never value-imported by the API, its stripped
// environment) is src/tests/untrusted-host-build.test.ts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { buildDraft } from "./build-draft"

const APP = "isolation-o1a2b3c4d"

const manifest = JSON.stringify({
  name: "whatever",
  version: "9.9.9",
  packageFormat: 1,
  host: "^1",
  license: "MIT",
  description: "Isolation probe",
  scopes: [`${APP}:items:read`],
  tools: {
    items_list: {
      description: "List items",
      requiredScopes: [`${APP}:items:read`],
      handler: "items_list",
      readOnly: true,
      params: { type: "object", properties: {} },
    },
  },
})

const HANDLERS = `import { type AppContext, defineHandlers } from "@liaison/app-sdk"
export async function items_list(_p: Record<string, unknown>, ctx: AppContext) {
  return { data: [], org: ctx.orgId }
}
export default defineHandlers({ items_list })
`

const calls: string[] = []
const real = { build: Bun.build, Transpiler: Bun.Transpiler, plugin: Bun.plugin }

beforeAll(() => {
  const build: typeof Bun.build = (...args) => {
    calls.push("Bun.build")
    return real.build(...args)
  }
  class CountingTranspiler extends real.Transpiler {
    constructor(...args: ConstructorParameters<typeof Bun.Transpiler>) {
      calls.push("Bun.Transpiler")
      super(...args)
    }
  }
  const plugin = Object.assign(
    (...args: Parameters<typeof Bun.plugin>) => {
      calls.push("Bun.plugin")
      return real.plugin(...args)
    },
    { clearAll: () => real.plugin.clearAll() },
  )
  Reflect.set(Bun, "build", build)
  Reflect.set(Bun, "Transpiler", CountingTranspiler)
  Reflect.set(Bun, "plugin", plugin)
})

afterAll(() => {
  Reflect.set(Bun, "build", real.build)
  Reflect.set(Bun, "Transpiler", real.Transpiler)
  Reflect.set(Bun, "plugin", real.plugin)
})

const build = (handlers: string) =>
  buildDraft(
    { "app.manifest.json": manifest, "handlers.ts": handlers },
    { appName: APP, version: "1.0.0" },
  )

describe("the draft build never parses the draft in the API process", () => {
  test("the counters see an in-process parse (the probe works)", () => {
    const before = calls.length
    new Bun.Transpiler({ loader: "js" })
    expect(calls.slice(before)).toEqual(["Bun.Transpiler"])
    calls.length = before
  })

  test("a valid draft builds, with no Bun parse here", async () => {
    calls.length = 0
    const r = await build(HANDLERS)
    expect(r.errors).toEqual([])
    expect(r.ok).toBe(true)
    expect(r.bundle?.bytes.length).toBeGreaterThan(0)
    expect(calls).toEqual([])
  }, 60_000)

  test("a draft with a macro import is refused, with no Bun parse here", async () => {
    calls.length = 0
    const r = await build(`import { m } from "./m.ts" with { type: "macro" }\nm()\n${HANDLERS}`)
    expect(r.ok).toBe(false)
    expect(r.errors.length).toBeGreaterThan(0)
    expect(calls).toEqual([])
  }, 60_000)
})
