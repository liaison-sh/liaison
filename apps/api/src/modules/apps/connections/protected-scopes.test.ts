// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  authorizeScopes,
  optedInScopes,
  recordedGrant,
  withOptionalScopes,
} from "~/modules/apps/connections/protected-scopes"

const DECLARED = [{ scope: "read_all_orders", setting: "fullOrderHistory" }]
const BASE = ["read_orders", "write_orders"]

describe("protected scopes", () => {
  it("an opt-in is a toggle set to true in the app's org settings", () => {
    expect(optedInScopes(DECLARED, {})).toEqual([])
    expect(optedInScopes(DECLARED, { fullOrderHistory: false })).toEqual([])
    expect(optedInScopes(DECLARED, { fullOrderHistory: "yes" })).toEqual([])
    expect(optedInScopes(DECLARED, { fullOrderHistory: true })).toEqual(["read_all_orders"])
    expect(
      optedInScopes([{ scope: "x", setting: "orders.full" }], { orders: { full: true } }),
    ).toEqual(["x"])
  })

  it("the authorize request leaves a protected scope out with no opt-in and no existing grant", () => {
    expect(authorizeScopes(BASE, DECLARED, [], null)).toEqual(BASE)
    expect(authorizeScopes(BASE, DECLARED, [], ["read_orders", "write_orders"])).toEqual(BASE)
  })

  it("the authorize request includes it when the org opted in", () => {
    expect(authorizeScopes(BASE, DECLARED, ["read_all_orders"], null)).toEqual([
      ...BASE,
      "read_all_orders",
    ])
  })

  it("the authorize request keeps it when the re-authorized account already holds it", () => {
    expect(authorizeScopes(BASE, DECLARED, [], ["write_orders", "read_all_orders"])).toEqual([
      ...BASE,
      "read_all_orders",
    ])
  })

  it("an account whose grant was never recorded keeps it: a reconnect never drops a scope", () => {
    expect(authorizeScopes(BASE, DECLARED, [], "unknown")).toEqual([...BASE, "read_all_orders"])
  })

  it("never duplicates a scope already in the base list", () => {
    expect(
      authorizeScopes([...BASE, "read_all_orders"], DECLARED, ["read_all_orders"], null),
    ).toEqual([...BASE, "read_all_orders"])
  })

  it("reads the recorded grant from the account's metadata", () => {
    expect(recordedGrant(null)).toBe("unknown")
    expect(recordedGrant({})).toBe("unknown")
    expect(recordedGrant({ grantedOAuthScopes: [] })).toBe("unknown")
    expect(recordedGrant({ grantedOAuthScopes: ["a", 1, "b"] })).toEqual(["a", "b"])
  })
})

describe("withOptionalScopes", () => {
  const FB = "https://www.googleapis.com/auth/calendar.freebusy"
  it("adds an optional scope only when the flow asks for it or the grant holds it", () => {
    expect(withOptionalScopes(["a"], [FB], [], null)).toEqual(["a"])
    expect(withOptionalScopes(["a"], [FB], [FB], null)).toEqual(["a", FB])
    expect(withOptionalScopes(["a"], [FB], [], ["a", FB])).toEqual(["a", FB])
  })
  it("never adds an undeclared scope, nor one on an unknown grant", () => {
    expect(withOptionalScopes(["a"], [], ["https://evil.example/all"], null)).toEqual(["a"])
    expect(withOptionalScopes(["a"], [FB], [], "unknown")).toEqual(["a"])
    expect(withOptionalScopes(["a", FB], [FB], [FB], null)).toEqual(["a", FB])
  })
})
