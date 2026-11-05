// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, test } from "bun:test"
import { users } from "~/db/schema/kernel"

describe("users schema", () => {
  test("has totpLastUsedAt column", () => {
    expect(users.totpLastUsedAt).toBeDefined()
    expect(users.totpLastUsedAt.name).toBe("totp_last_used_at")
  })
})
