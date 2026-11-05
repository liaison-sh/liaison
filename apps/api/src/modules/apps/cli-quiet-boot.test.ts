// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A CLI command prints its own output first: loading the app registry must not
// print an Ajv strict-mode warning (the manifest schema's union types) or a
// WARN block for the mail <-> tickets optional dependencies, which point at each
// other by design.
import { describe, expect, it, spyOn } from "bun:test"
import Ajv from "ajv"
import { appsLogger } from "~/lib/logger"
import { MANIFEST_AJV_OPTIONS } from "~/modules/apps/contract"
import { appManifestJsonSchema } from "~/modules/apps/manifest-schema"
import { resolveAppOrder } from "~/modules/apps/resolver"

describe("quiet boot for the CLI", () => {
  it("the manifest schema compiles without a strict-mode warning", () => {
    const warnings: unknown[] = []
    const logger = { log: () => {}, warn: (...a: unknown[]) => warnings.push(a), error: () => {} }
    new Ajv({ ...MANIFEST_AJV_OPTIONS, logger }).compile(appManifestJsonSchema)
    expect(warnings).toEqual([])
  })

  it("mutual optional dependencies resolve without a warn log, and the result still says so", () => {
    const warn = spyOn(appsLogger, "warn")
    try {
      const result = resolveAppOrder([
        { name: "mail", dependencies: { optional: ["tickets"] } },
        { name: "tickets", dependencies: { optional: ["mail"] } },
      ])
      expect(result.success).toBe(true)
      expect(result.warnings.some((w) => w.includes("would create cycle"))).toBe(true)
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})
