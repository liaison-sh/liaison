// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { isOwnerPrivilegeError, ownerDsnHint } from "./owner-dsn-hint"

describe("owner-dsn-hint", () => {
  it("recognises the RLS and ownership failures the app role produces", () => {
    expect(isOwnerPrivilegeError(new Error('permission denied for table "threads"'))).toBe(true)
    expect(isOwnerPrivilegeError(new Error('must be owner of table "users"'))).toBe(true)
    expect(
      isOwnerPrivilegeError(new Error("new row violates row-level security policy for table")),
    ).toBe(true)
    expect(isOwnerPrivilegeError(Object.assign(new Error("nope"), { code: "42501" }))).toBe(true)
  })

  it("does not claim an unrelated failure is a credentials problem", () => {
    expect(isOwnerPrivilegeError(new Error("connection refused"))).toBe(false)
    expect(isOwnerPrivilegeError(new Error("relation does not exist"))).toBe(false)
    expect(isOwnerPrivilegeError(undefined)).toBe(false)
  })

  it("names the missing credential and where it is needed", () => {
    const hint = ownerDsnHint("scripts/seed-qa.ts")
    expect(hint).toContain("scripts/seed-qa.ts")
    expect(hint).toContain("OWNER")
    expect(hint).toContain("DATABASE_URL")
  })
})
