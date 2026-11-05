// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `liaison_test` on this machine is shared with a second checkout, and a feature
// branch can carry migrations dated far in the future. An unconditional reset
// republishes that ledger into the shared database, after which Drizzle silently
// skips every migration dated below the high water mark for whoever runs next.
// The reset therefore has to be a decision, not a side effect of starting Docker.

import { describe, expect, it } from "bun:test"
import { resetTestDbRequested, shouldResetTestDb } from "./infra-up"

describe("resetting the shared test database is a decision, not a side effect", () => {
  it("leaves an already migrated liaison_test alone", () => {
    expect(shouldResetTestDb({ migrated: true, force: false })).toBe(false)
  })

  it("resets when there is no schema yet, because there is nothing to lose", () => {
    expect(shouldResetTestDb({ migrated: false, force: false })).toBe(true)
  })

  it("resets a migrated database only when asked explicitly", () => {
    expect(shouldResetTestDb({ migrated: true, force: true })).toBe(true)
  })
})

describe("asking for the reset explicitly", () => {
  it("accepts the flag", () => {
    expect(resetTestDbRequested(["bun", "infra-up.ts", "--reset-test-db"], {})).toBe(true)
  })

  it("accepts the environment variable", () => {
    expect(resetTestDbRequested(["bun", "infra-up.ts"], { INFRA_RESET_TEST_DB: "1" })).toBe(true)
  })

  it("does not read a bare infra:up as a request to reset", () => {
    expect(resetTestDbRequested(["bun", "infra-up.ts"], {})).toBe(false)
  })

  it("does not treat the string false as truthy", () => {
    expect(resetTestDbRequested(["bun", "infra-up.ts"], { INFRA_RESET_TEST_DB: "false" })).toBe(
      false,
    )
  })
})
