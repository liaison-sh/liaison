// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { mockAppContext } from "~/modules/apps/test-helpers"
import { handlers } from "./handlers"

describe("example app — demonstrates every SDK surface", () => {
  it("items_list returns persisted items via ctx.db", async () => {
    const ctx = mockAppContext({ orgId: "test" })
    await handlers.items_create({ text: "hello" }, ctx)
    const res = await handlers.items_list({}, ctx)
    expect(res.data.some((x) => x.text === "hello")).toBe(true)
  })

  it("items_create emits an item.created event", async () => {
    const ctx = mockAppContext({ orgId: "test" })
    await handlers.items_create({ text: "x" }, ctx)
    expect(ctx.emit).toHaveBeenCalledWith(
      expect.objectContaining({ entity: "item", action: "created" }),
    )
  })

  it("external_fetch demonstrates the connections surface (mocked)", async () => {
    const ctx = mockAppContext({
      orgId: "test",
      connections: { exampleApi: { getToken: async () => "tok" } },
      fetchMock: async () => ({ status: 200, headers: {}, body: '{"ok":true}' }),
    })
    const res = await handlers.external_fetch({}, ctx)
    expect(res.ok).toBe(true)
  })

  it("nightly_summary counts items and emits a summary:computed event (scheduled-job surface)", async () => {
    const ctx = mockAppContext({ orgId: "test" })
    await handlers.items_create({ text: "a" }, ctx)
    await handlers.items_create({ text: "b" }, ctx)
    const res = await handlers.nightly_summary({}, ctx)
    expect(res.itemCount).toBe(2)
    expect(ctx.emit).toHaveBeenCalledWith(
      expect.objectContaining({ entity: "summary", action: "computed" }),
    )
  })

  it("resolve_contact uses ctx.resolveContact (contacts integration surface)", async () => {
    const ctx = mockAppContext({ orgId: "test" })
    ctx.resolveContact.mockResolvedValueOnce({ id: "c1", email: "x@y.com" })
    const res = await handlers.resolve_contact({ email: "x@y.com" }, ctx)
    expect(res.contact).toEqual(expect.objectContaining({ id: "c1" }))
    expect(ctx.resolveContact).toHaveBeenCalledWith(expect.objectContaining({ email: "x@y.com" }))
  })
})
