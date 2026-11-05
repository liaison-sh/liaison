// SPDX-License-Identifier: FSL-1.1-ALv2
// @vitest-environment node
//
// The web bundle's zod never reaches for eval: the page's CSP has no 'unsafe-eval', and zod 4's
// `new Function("")` probe, caught or not, raised a script-src violation on every load.
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

describe("the web build's zod", () => {
  it("comes configured jitless, so it neither probes for nor compiles with eval", async () => {
    // What every `from "zod"` resolves to in the web build (vite.config.ts alias).
    const { z } = await import("~/lib/zod-jitless")
    const { globalConfig } = await import("zod/v4/core")
    expect(globalConfig.jitless).toBe(true)
    const schema = z.object({
      kind: z.enum(["address", "domain"]),
      nested: z.object({ n: z.number() }),
    })
    expect(schema.parse({ kind: "address", nested: { n: 1 } })).toEqual({
      kind: "address",
      nested: { n: 1 },
    })
  })

  it("is the jitless wrapper for every bare zod import", () => {
    const viteConfig = readFileSync(resolve(__dirname, "../../vite.config.ts"), "utf8")
    expect(viteConfig).toContain(
      '{ find: /^zod$/, replacement: resolve(__dirname, "src/lib/zod-jitless.ts") }',
    )
  })
})
