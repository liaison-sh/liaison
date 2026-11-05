// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Pins the routine-tick tool pre-seed policy (cache discipline): a tick's
// deferred-tool surface is resolved UP FRONT from the routine's declared
// scopes, so `activeTools` never grows mid-run. Every mid-run discovery
// mutates the provider tool catalog — a byte-level prefix change at position
// 0 that busts the ENTIRE implicit prompt cache (system + guides + history)
// on the step where it lands. Seeding converts N mid-run busts into one
// slightly bigger but byte-stable prefix that caches from step 2 onward.
import { describe, expect, test } from "bun:test"
import { appsFromRoutineScopes, filterSeedTools } from "~/modules/agent/routines/routine-tool-seed"

const catalog = [
  { sdkName: "tickets__get", appName: "tickets", locked: false },
  { sdkName: "tickets__reply", appName: "tickets", locked: false },
  { sdkName: "boxtal__quote", appName: "boxtal", locked: false },
  { sdkName: "boxtal__create_shipment", appName: "boxtal", locked: true },
  { sdkName: "shopify__orders_get", appName: "shopify", locked: false },
  { sdkName: "kernel__skill_read", appName: "kernel", locked: false },
]

describe("appsFromRoutineScopes", () => {
  test("derives app names from scope prefixes, deduped", () => {
    expect(
      appsFromRoutineScopes(["tickets:read", "tickets:write", "boxtal:shipments:create"]),
    ).toEqual(new Set(["tickets", "boxtal"]))
  })

  test("ignores empty and malformed scopes", () => {
    expect(appsFromRoutineScopes(["", ":", "kernel:threads"])).toEqual(new Set(["kernel"]))
  })
})

describe("filterSeedTools", () => {
  test("seeds every unlocked deferred tool of the routine's scope apps", () => {
    const seed = filterSeedTools(catalog, ["tickets:read", "boxtal:shipments"])
    expect(seed).toEqual(new Set(["tickets__get", "tickets__reply", "boxtal__quote"]))
  })

  test("locked tools are never seeded (scope the actor lacks stays a discovery)", () => {
    const seed = filterSeedTools(catalog, ["boxtal:shipments"])
    expect(seed.has("boxtal__create_shipment")).toBe(false)
  })

  test("apps outside the routine's declared scopes stay deferred (lean start preserved)", () => {
    const seed = filterSeedTools(catalog, ["tickets:read"])
    expect(seed.has("shopify__orders_get")).toBe(false)
    expect(seed.has("kernel__skill_read")).toBe(false)
  })

  test("no scopes → empty seed (falls back to pure mid-run discovery)", () => {
    expect(filterSeedTools(catalog, [])).toEqual(new Set())
  })
})
