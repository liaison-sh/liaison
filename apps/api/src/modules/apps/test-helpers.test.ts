// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import type { AppContext } from "@liaison/app-sdk"
import { mockAppContext } from "./test-helpers"

describe("mockAppContext", () => {
  it("returns a value assignable to the real AppContext contract", () => {
    // Compile-time guarantee: the mock IS an AppContext. If the SDK contract
    // gains a member, this assignment fails until the mock is updated.
    const ctx: AppContext = mockAppContext({ orgId: "test-org" })
    expect(ctx.orgId).toBe("test-org")
    expect(typeof ctx.logger.info).toBe("function")
  })

  it("provides an in-memory db (insert returns {id}, findMany filters by where)", async () => {
    const ctx = mockAppContext({ orgId: "test-org" })
    const { id } = await ctx.db.insert("items", { text: "x", orgId: "test-org" })
    expect(typeof id).toBe("string")
    const rows = await ctx.db.findMany("items", { where: { orgId: "test-org" } })
    expect(rows).toHaveLength(1)
    expect((rows[0] as { id: string }).id).toBe(id)
  })

  it("tracks emit calls and the enqueued job queue", async () => {
    const ctx = mockAppContext({ orgId: "test-org" })
    await ctx.emit({ entity: "item", action: "created", entityId: "1", data: {} })
    expect(ctx.emit).toHaveBeenCalledTimes(1)
    await ctx.enqueueJob("nightly_summary", {})
    expect(ctx._jobs).toEqual([{ name: "nightly_summary", payload: {} }])
  })

  it("completes partial connections with a default getAccounts", async () => {
    const ctx = mockAppContext({
      orgId: "x",
      connections: { exampleApi: { getToken: async () => "tok" } },
      fetchMock: async () => ({ status: 200, headers: {}, body: '{"ok":true}' }),
    })
    expect(await ctx.connections.exampleApi.getToken()).toBe("tok")
    expect(await ctx.connections.exampleApi.getAccounts()).toEqual([])
    expect((await ctx.fetch("https://example.com")).status).toBe(200)
  })

  it("db.findMany filters by the provided where clause", async () => {
    const ctx = mockAppContext({ orgId: "o" })
    await ctx.db.insert("items", { id: "1", status: "open" })
    await ctx.db.insert("items", { id: "2", status: "closed" })
    const open = await ctx.db.findMany("items", { where: { status: "open" } })
    expect(open).toHaveLength(1)
    expect((open[0] as { id: string }).id).toBe("1")
  })

  it("db supports findOne, update, count, delete", async () => {
    const ctx = mockAppContext({ orgId: "o" })
    const { id } = await ctx.db.insert("items", { text: "a" })
    expect(await ctx.db.findOne("items", id)).toMatchObject({ text: "a" })
    await ctx.db.update("items", id, { text: "b" })
    expect(await ctx.db.findOne("items", id)).toMatchObject({ text: "b" })
    expect(await ctx.db.count("items")).toBe(1)
    await ctx.db.delete("items", id)
    expect(await ctx.db.findOne("items", id)).toBeNull()
  })
})
