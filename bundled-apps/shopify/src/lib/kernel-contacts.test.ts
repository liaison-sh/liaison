// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Regression coverage for the "Symbol.iterator of undefined" crash in
// reconcileCustomersJob (prod 2026-07-09). The FLAT sandbox bridge alias
// `ctx.listContactsByExternalId` is wrapped by the sandbox's plain `__wrap`,
// which does NOT JSON.parse the string return when every call arg is primitive
// (unlike the nested ctx.kernel.* structured group). So the bridge's JSON string
// reached the handler UNPARSED, `page.contacts` was undefined, and the reconcile
// job's `for (const c of page.contacts)` threw. The accessor now parses defensively.
import { describe, expect, it } from "bun:test"
import type { AppContext } from "@liaison/app-sdk"
import { listContactsByExternalId } from "./kernel-contacts"

function ctxReturning(value: unknown): AppContext {
  return {
    listContactsByExternalId: (_limit?: number, _cursor?: string) => Promise.resolve(value),
  } as unknown as AppContext
}

describe("listContactsByExternalId accessor", () => {
  it("parses a RAW JSON STRING return (the flat-alias sandbox path that crashed prod)", async () => {
    const raw = JSON.stringify({
      contacts: [{ id: "c1", externalId: "gid://shopify/Customer/1" }],
      nextCursor: "cursor-2",
    })
    const page = await listContactsByExternalId(ctxReturning(raw), 50, null)
    expect(Array.isArray(page.contacts)).toBe(true)
    expect(page.contacts).toHaveLength(1)
    expect(page.contacts[0]?.id).toBe("c1")
    expect(page.nextCursor).toBe("cursor-2")
  })

  it("passes an already-parsed OBJECT return through unchanged (nested-alias path)", async () => {
    const obj = { contacts: [{ id: "c2", externalId: null }], nextCursor: null }
    const page = await listContactsByExternalId(ctxReturning(obj), 50, null)
    expect(page.contacts).toHaveLength(1)
    expect(page.contacts[0]?.externalId).toBeNull()
    expect(page.nextCursor).toBeNull()
  })

  it("defaults a missing/empty shape to an empty array (never undefined -> never crashes the for-of)", async () => {
    const empty = await listContactsByExternalId(ctxReturning("{}"), 50, null)
    expect(empty.contacts).toEqual([])
    expect(empty.nextCursor).toBeNull()

    const nullish = await listContactsByExternalId(ctxReturning(null), 50, null)
    expect(nullish.contacts).toEqual([])
  })

  it("forwards the cursor to the bridge on subsequent pages", async () => {
    let seenCursor: string | undefined
    const ctx = {
      listContactsByExternalId: (_limit?: number, cursor?: string) => {
        seenCursor = cursor
        return Promise.resolve({ contacts: [], nextCursor: null })
      },
    } as unknown as AppContext
    await listContactsByExternalId(ctx, 50, "cursor-abc")
    expect(seenCursor).toBe("cursor-abc")
  })

  it("throws loudly when the bridge affordance is unavailable", async () => {
    await expect(listContactsByExternalId({} as AppContext, 50, null)).rejects.toThrow(
      /affordance unavailable/,
    )
  })
})
