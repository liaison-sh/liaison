// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A read-only member's editor used to say "no issuer profile exists" when the
// issuer list was REFUSED: a failed read and an empty list looked the same.
import { afterEach, describe, expect, it } from "bun:test"
import { loadIssuerProfiles } from "./Editor"

function withHost(invokeTool: (app: string, tool: string) => Promise<unknown>) {
  // biome-ignore lint/suspicious/noExplicitAny: global host slot the @liaison/host shim reads.
  ;(globalThis as any).__liaisonHost = { invokeTool }
  // biome-ignore lint/suspicious/noExplicitAny: test-bound app name for the `app` namespace.
  ;(globalThis as any).__LIAISON_TEST_APP_NAME = "invoicing"
}

afterEach(() => {
  // biome-ignore lint/suspicious/noExplicitAny: clear the global host slot.
  ;(globalThis as any).__liaisonHost = undefined
  // biome-ignore lint/suspicious/noExplicitAny: clear the bound app name.
  ;(globalThis as any).__LIAISON_TEST_APP_NAME = undefined
})

describe("loadIssuerProfiles", () => {
  it("a 403 is a refusal, not an empty org", async () => {
    withHost(async () => {
      throw Object.assign(new Error("Forbidden"), { status: 403 })
    })
    expect(await loadIssuerProfiles()).toEqual({ items: [], failure: "forbidden" })
  })

  it("a forbidden envelope is a refusal; any other failure is a failed read", async () => {
    withHost(async () => ({ status: "error", error: { code: "forbidden", message: "no" } }))
    expect((await loadIssuerProfiles()).failure).toBe("forbidden")
    withHost(async () => {
      throw Object.assign(new Error("boom"), { status: 500 })
    })
    expect((await loadIssuerProfiles()).failure).toBe("failed")
  })

  it("an empty list is the one case that means not configured", async () => {
    withHost(async () => ({ items: [] }))
    expect(await loadIssuerProfiles()).toEqual({ items: [], failure: null })
  })
})
