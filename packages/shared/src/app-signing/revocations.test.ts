// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { utf8 } from "./encoding"
import { REVOCATION_FLOOR } from "./keys"
import {
  acceptRevocationList,
  compareAppVersions,
  type RevocationList,
  revocationBytes,
  revocationFor,
  verifyRevocationList,
} from "./revocations"
import { createTestSigningKey } from "./testing"

const LIST: RevocationList = {
  v: 1,
  seq: 7,
  issuedAt: "2026-10-26T00:00:00.000Z",
  entries: [
    { name: "boxtal", versions: ["0.15.1"] },
    { name: "invoicing", below: "0.19.0" },
  ],
}

describe("compareAppVersions", () => {
  it("orders numerically and puts a pre-release before its release", () => {
    expect(compareAppVersions("0.10.0", "0.9.9")).toBeGreaterThan(0)
    expect(compareAppVersions("1.0.0-rc.1", "1.0.0")).toBeLessThan(0)
    expect(compareAppVersions("1.2.3", "1.2.3")).toBe(0)
  })

  it("orders pre-release identifiers as semver does", () => {
    expect(compareAppVersions("1.0.0-rc.9", "1.0.0-rc.10")).toBeLessThan(0)
    expect(compareAppVersions("1.0.0-alpha", "1.0.0-alpha.1")).toBeLessThan(0)
    expect(compareAppVersions("1.0.0-1", "1.0.0-alpha")).toBeLessThan(0)
    expect(compareAppVersions("1.0.0-beta.11", "1.0.0-beta.2")).toBeGreaterThan(0)
  })

  it("a floor below a later release candidate revokes an earlier one", () => {
    const floor = [{ name: "boxtal", below: "1.0.0-rc.10" }]
    expect(revocationFor("boxtal", "1.0.0-rc.9", { list: null, floor })).toBe("below_floor")
    expect(revocationFor("boxtal", "1.0.0-rc.10", { list: null, floor })).toBeNull()
  })
})

describe("verifyRevocationList", () => {
  it("accepts a list signed by a pinned key", async () => {
    const key = await createTestSigningKey("test-1")
    const bytes = revocationBytes(LIST)
    const result = await verifyRevocationList(bytes, await key.sign(bytes), [key.key])
    expect(result).toEqual({ ok: true, list: LIST })
  })

  it("refuses an unpinned key, an altered list, non-canonical bytes and an empty key list", async () => {
    const key = await createTestSigningKey("test-1")
    const other = await createTestSigningKey("test-1")
    const bytes = revocationBytes(LIST)
    expect((await verifyRevocationList(bytes, await other.sign(bytes), [key.key])).ok).toBe(false)
    const sig = await key.sign(bytes)
    const altered = revocationBytes({ ...LIST, entries: [] })
    expect((await verifyRevocationList(altered, sig, [key.key])).ok).toBe(false)
    const pretty = utf8.encode(JSON.stringify(LIST, null, 2))
    expect((await verifyRevocationList(pretty, await key.sign(pretty), [key.key])).ok).toBe(false)
    expect(await verifyRevocationList(bytes, sig, [])).toEqual({ ok: false, reason: "no_keys" })
  })
})

describe("acceptRevocationList (monotonic)", () => {
  it("keeps the highest sequence seen: an older list is refused", () => {
    expect(acceptRevocationList(null, LIST)).toBe(true)
    expect(acceptRevocationList(7, LIST)).toBe(true)
    expect(acceptRevocationList(8, LIST)).toBe(false)
  })
})

describe("revocationFor", () => {
  it("names a listed version and a version below a listed floor", () => {
    expect(revocationFor("boxtal", "0.15.1", { list: LIST, floor: [] })).toBe("revoked")
    expect(revocationFor("invoicing", "0.18.9", { list: LIST, floor: [] })).toBe("revoked")
    expect(revocationFor("invoicing", "0.19.0", { list: LIST, floor: [] })).toBeNull()
    expect(revocationFor("boxtal", "0.15.2", { list: LIST, floor: [] })).toBeNull()
  })

  it("applies the compiled floor even without a downloaded list", () => {
    const floor = [{ name: "shopify", below: "0.2.50" }]
    expect(revocationFor("shopify", "0.2.49", { list: null, floor })).toBe("below_floor")
    expect(revocationFor("shopify", "0.2.50", { list: null, floor })).toBeNull()
    expect(revocationFor("shopify", "0.2.49", { list: LIST, floor })).toBe("below_floor")
  })

  it("defaults to the compiled REVOCATION_FLOOR", () => {
    expect(Array.isArray(REVOCATION_FLOOR)).toBe(true)
    expect(revocationFor("boxtal", "0.15.1", { list: LIST })).toBe("revoked")
  })
})
