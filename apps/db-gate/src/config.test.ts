// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Unit tests for the pure startup-gate logic (review_code.md MINOR:
// "db-gate startup gate untested" — extract assertCleanStartupOrThrow and
// unit-test the 3 cases). No DB, no HTTP server.

import { describe, expect, test } from "bun:test"
import { assertCleanStartupOrThrow, ConfigError, loadConfig } from "./config"

describe("assertCleanStartupOrThrow", () => {
  test("allowQuery=true + dirty probe -> throws (refuses to start)", () => {
    expect(() => assertCleanStartupOrThrow({ allowQuery: true }, { ok: false })).toThrow(
      ConfigError,
    )
  })

  test("allowQuery=true + clean probe -> does not throw (ok to start)", () => {
    expect(() => assertCleanStartupOrThrow({ allowQuery: true }, { ok: true })).not.toThrow()
  })

  test("allowQuery=false + dirty probe -> does not throw (curated-reads-only gate doesn't require a clean probe)", () => {
    expect(() => assertCleanStartupOrThrow({ allowQuery: false }, { ok: false })).not.toThrow()
  })
})

describe("loadConfig", () => {
  test("refuses a weak token", () => {
    expect(() => loadConfig({ DB_GATE_DSN: "postgres://x/y", DB_GATE_TOKEN: "too-short" })).toThrow(
      ConfigError,
    )
  })

  test("refuses a missing DSN", () => {
    expect(() => loadConfig({ DB_GATE_TOKEN: "a".repeat(32) })).toThrow(ConfigError)
  })
})
