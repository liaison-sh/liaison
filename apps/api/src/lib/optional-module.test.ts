// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  chaosInjectorModulePath,
  importOptionalModule,
  OptionalModuleMissingError,
} from "./optional-module"

describe("importOptionalModule", () => {
  it("loads a module that is present", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "optional-module-"))
    const file = path.join(dir, "present.ts")
    writeFileSync(file, "export const answer = 42\n")
    const logs: string[] = []
    const mod = await importOptionalModule<{ answer: number }>({
      feature: "TEST_FLAG",
      modulePath: file,
      log: (m) => logs.push(m),
    })
    expect(mod.answer).toBe(42)
    expect(logs).toEqual([])
  })

  it("fails closed with a logged message naming the feature and the path when the module is absent", async () => {
    const missing = path.join(tmpdir(), "optional-module-absent", "routes.ts")
    const logs: string[] = []
    const run = importOptionalModule({
      feature: "CHAOS_DEBUG",
      modulePath: missing,
      log: (m) => logs.push(m),
    })
    await expect(run).rejects.toBeInstanceOf(OptionalModuleMissingError)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain("CHAOS_DEBUG is enabled")
    expect(logs[0]).toContain(missing)
  })
})

describe("the chaos injector module path", () => {
  // The injector lives outside this repository: the harness names it.
  it("comes from CHAOS_DEBUG_INJECTOR_MODULE, and an unset path refuses to load", async () => {
    const prev = process.env.CHAOS_DEBUG_INJECTOR_MODULE
    try {
      process.env.CHAOS_DEBUG_INJECTOR_MODULE = " /abs/injector/routes.ts "
      expect(chaosInjectorModulePath()).toBe("/abs/injector/routes.ts")
      delete process.env.CHAOS_DEBUG_INJECTOR_MODULE
      expect(chaosInjectorModulePath()).toBe("")
      const logs: string[] = []
      await expect(
        importOptionalModule({
          feature: "CHAOS_DEBUG",
          modulePath: chaosInjectorModulePath(),
          log: (m) => logs.push(m),
        }),
      ).rejects.toBeInstanceOf(OptionalModuleMissingError)
      expect(logs[0]).toContain("no module path configured")
    } finally {
      if (prev === undefined) delete process.env.CHAOS_DEBUG_INJECTOR_MODULE
      else process.env.CHAOS_DEBUG_INJECTOR_MODULE = prev
    }
  })
})
