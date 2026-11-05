// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Regular expressions an app manifest declares run on the API host's event
// loop. A backtracking-prone pattern met by a crafted value would hold every
// org on the process, so only patterns proven linear compile.
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { appSettingsSchema } from "@liaison/app-sdk"
import {
  assertManifestPatternsSafe,
  MAX_MANIFEST_PATTERN_LENGTH,
  manifestRegExp,
  UnsafeManifestPatternError,
} from "~/lib/manifest-regex"
import { resolveAuthorizeConfigParams } from "~/modules/apps/connections/oauth-manifest-knobs"
import { createParamValidatorCache } from "~/modules/apps/param-validator"
import { buildManifestSettingsEntry } from "~/modules/apps/settings-schema-from-manifest"

const EVIL = "^(a|a)+$"
// 27 characters is enough for hundreds of ms; each extra one doubles the time.
const INPUT = `${"a".repeat(27)}!`
const BUDGET_MS = 250

function settingsWithPattern(pattern: string) {
  return {
    sections: [
      {
        id: "general",
        title: "General",
        scope: "org",
        blocks: [
          { block: "field", key: "name", type: "text", label: "Name", validation: { pattern } },
        ],
      },
    ],
  }
}

describe("manifest regular expressions run bounded on the host", () => {
  test("a tool param pattern cannot hold the event loop", () => {
    const validator = createParamValidatorCache({ allErrors: true, allowUnionTypes: true })
    const schema = { type: "object", properties: { q: { type: "string", pattern: EVIL } } }
    let refusedAtCompile = false
    let validate: ReturnType<typeof validator> | undefined
    try {
      validate = validator(schema)
    } catch (e) {
      refusedAtCompile = e instanceof UnsafeManifestPatternError
    }
    expect(refusedAtCompile).toBe(true)
    if (!validate) return
    const t0 = performance.now()
    validate({ q: INPUT })
    expect(performance.now() - t0).toBeLessThan(BUDGET_MS)
  })

  test("a settings field validation pattern cannot hold the event loop", () => {
    const parsed = appSettingsSchema.parse(settingsWithPattern(EVIL))
    expect(() => buildManifestSettingsEntry(parsed, { app: "probe" })).toThrow(
      UnsafeManifestPatternError,
    )
  })

  test("an authorize config param pattern is refused, not run", () => {
    const t0 = performance.now()
    const r = resolveAuthorizeConfigParams(
      { tenant: { configKey: "tenant", pattern: "(a|a)+" } },
      { tenant: INPUT },
    )
    expect(performance.now() - t0).toBeLessThan(BUDGET_MS)
    expect(r.ok).toBe(false)
  })

  test("install refuses a manifest declaring an unsafe pattern anywhere it runs", () => {
    const cases: unknown[] = [
      {
        tools: {
          search: {
            params: { type: "object", properties: { q: { type: "string", pattern: EVIL } } },
          },
        },
      },
      {
        tools: {
          s: { params: { type: "object", patternProperties: { "^(x+)+$": { type: "string" } } } },
        },
      },
      { settings: settingsWithPattern("(\\d+)*z") },
      { connections: { c: { templateVars: { shop: { pattern: "^(a|aa)+$" } } } } },
      {
        connections: {
          c: { authorizeConfigParams: { t: { configKey: "t", pattern: "\\d*\\d*\\d*!" } } },
        },
      },
      { settings: settingsWithPattern(`^${"a".repeat(MAX_MANIFEST_PATTERN_LENGTH)}$`) },
    ]
    for (const m of cases)
      expect(() => assertManifestPatternsSafe(m)).toThrow(UnsafeManifestPatternError)
  })

  test("linear patterns still compile and match", () => {
    expect(
      manifestRegExp("^[a-z0-9][a-z0-9-]*(\\.myshopify\\.com)?$").test("shop.myshopify.com"),
    ).toBe(true)
    expect(manifestRegExp("^\\d{4}-\\d{2}-\\d{2}$").test("2026-11-02")).toBe(true)
    const validator = createParamValidatorCache({ allErrors: true })
    const v = validator({
      type: "object",
      properties: { d: { type: "string", pattern: "^\\d{4}$" } },
    })
    expect(v({ d: "2026" })).toBe(true)
    expect(v({ d: "x" })).toBe(false)
  })

  test("every first-party manifest declares only safe patterns", () => {
    const root = join(import.meta.dir, "..", "..", "..", "..", "..", "bundled-apps")
    let checked = 0
    for (const name of readdirSync(root)) {
      const p = join(root, name, "app.manifest.json")
      try {
        if (!statSync(p).isFile()) continue
      } catch {
        continue
      }
      assertManifestPatternsSafe(JSON.parse(readFileSync(p, "utf8")))
      checked++
    }
    expect(checked).toBeGreaterThan(5)
  })
})
