// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The in-memory ctx double must behave like the sandbox bridge where the handlers depend on
// it: null matching, multi-key orderBy with Postgres ordering, declared-field checks, stamped
// created_at/updated_at, no where.id on updateMany, copy-on-read, per-key sequences, cascade.
import { describe, expect, it } from "bun:test"
import { incidents, makeCtx, type StoredRow } from "./test-ctx"

const T1 = "2026-06-01T01:00:00.000Z"
const T2 = "2026-06-01T02:00:00.000Z"

describe("test double mirrors the bridge", () => {
  it("matches a null where value against a missing key AND a null value, not a number", async () => {
    const { ctx, spy } = makeCtx()
    spy.rows.set("incidents", [
      { id: "missing" },
      { id: "nulled", ref_number: null },
      { id: "numbered", ref_number: 4 },
    ])
    const rows = (await ctx.db.findMany("incidents", { where: { ref_number: null } })) as StoredRow[]
    expect(rows.map((r) => r.id).sort()).toEqual(["missing", "nulled"])
  })

  it("orders by several keys in key order (tie broken by the second key)", async () => {
    const { ctx, spy } = makeCtx()
    spy.rows.set("incidents", [
      { id: "b", first_seen_at: T2 },
      { id: "a", first_seen_at: T2 },
      { id: "c", first_seen_at: T1 },
    ])
    const rows = (await ctx.db.findMany("incidents", {
      orderBy: { first_seen_at: "asc", id: "asc" },
    })) as StoredRow[]
    expect(rows.map((r) => r.id)).toEqual(["c", "a", "b"])
  })

  it("applies each key's own direction", async () => {
    const { ctx, spy } = makeCtx()
    spy.rows.set("incidents", [
      { id: "b", first_seen_at: T2 },
      { id: "a", first_seen_at: T2 },
      { id: "c", first_seen_at: T1 },
    ])
    const rows = (await ctx.db.findMany("incidents", {
      orderBy: { first_seen_at: "desc", id: "asc" },
    })) as StoredRow[]
    expect(rows.map((r) => r.id)).toEqual(["a", "b", "c"])
  })

  it("maps createdAt to the stamped created_at and rejects the snake_case base field", async () => {
    const { ctx } = makeCtx()
    const first = await ctx.db.insert("incident_comments", { body: "one" })
    const second = await ctx.db.insert("incident_comments", { body: "two" })
    const rows = (await ctx.db.findMany("incident_comments", { orderBy: { createdAt: "desc" } })) as StoredRow[]
    expect(rows.map((r) => r.id)).toEqual([second.id, first.id])
    await expect(ctx.db.findMany("incident_comments", { orderBy: { created_at: "asc" } })).rejects.toThrow(
      /Unknown orderBy field/,
    )
    await expect(ctx.db.findMany("incident_comments", { orderBy: { updated_at: "asc" } })).rejects.toThrow(
      /Unknown orderBy field/,
    )
  })

  it("stamps strictly increasing created_at on insert, and an update moves updated_at only", async () => {
    const { ctx, spy } = makeCtx()
    const a = await ctx.db.insert("incident_comments", { body: "a" })
    const b = await ctx.db.insert("incident_comments", { body: "b" })
    const byId = new Map((spy.rows.get("incident_comments") ?? []).map((r) => [r.id, r]))
    const rowA = byId.get(a.id)!
    const rowB = byId.get(b.id)!
    expect(String(rowA.created_at) < String(rowB.created_at)).toBe(true)
    expect(rowA.updated_at).toBe(rowA.created_at)

    const createdA = rowA.created_at
    await ctx.db.update("incident_comments", a.id, { body: "a2" })
    expect(rowA.created_at).toBe(createdA)
    expect(String(rowA.updated_at) > String(rowB.created_at)).toBe(true)

    const before = rowB.updated_at
    expect(await ctx.db.updateMany("incident_comments", { where: { body: "b" }, data: { body: "b2" } })).toEqual({
      count: 1,
    })
    expect(String(rowB.updated_at) > String(before)).toBe(true)
  })

  it("refuses undeclared where, orderBy and write fields, and where operators, like the bridge", async () => {
    const { ctx } = makeCtx()
    await expect(ctx.db.findMany("incidents", { where: { nope: 1 } })).rejects.toThrow(/Unknown where field "nope"/)
    await expect(ctx.db.findMany("incidents", { orderBy: { nope: "asc" } })).rejects.toThrow(/Unknown orderBy field/)
    await expect(ctx.db.insert("incidents", { nope: 1 })).rejects.toThrow(/Unknown field "nope"/)
    await expect(ctx.db.insert("incident_comments", { created_at: "2020-01-01T00:00:00.000Z" })).rejects.toThrow(
      /Unknown field "created_at"/,
    )
    await expect(ctx.db.update("incidents", "x", { nope: 1 })).rejects.toThrow(/Unknown field "nope"/)
    await expect(ctx.db.updateMany("incidents", { where: { nope: 1 }, data: { title: "t" } })).rejects.toThrow(
      /Unknown where field/,
    )
    await expect(ctx.db.findMany("incidents", { where: { status: { in: ["open"] } } })).rejects.toThrow(
      /operators are not supported/,
    )
    await expect(ctx.db.findMany("nope_table", {})).rejects.toThrow(/Unknown entity/)
  })

  it("sorts numbers numerically and NULL last ascending, first descending (Postgres defaults)", async () => {
    const { ctx, spy } = makeCtx()
    spy.rows.set("incidents", [
      { id: "ten", ref_number: 10 },
      { id: "none", ref_number: null },
      { id: "nine", ref_number: 9 },
    ])
    const asc = (await ctx.db.findMany("incidents", { orderBy: { ref_number: "asc" } })) as StoredRow[]
    expect(asc.map((r) => r.id)).toEqual(["nine", "ten", "none"])
    const desc = (await ctx.db.findMany("incidents", { orderBy: { ref_number: "desc" } })) as StoredRow[]
    expect(desc.map((r) => r.id)).toEqual(["none", "ten", "nine"])
  })

  it("deleting an incident cascades to its comments; failNextDelete rejects once", async () => {
    const { ctx, spy } = makeCtx()
    spy.rows.set("incidents", [{ id: "a" }, { id: "b" }])
    await ctx.db.insert("incident_comments", { incident_id: "a", kind: "comment", body: "on a" })
    await ctx.db.insert("incident_comments", { incident_id: "b", kind: "comment", body: "on b" })
    spy.failNextDelete = "incidents"
    await expect(ctx.db.delete("incidents", "a")).rejects.toThrow(/delete failed/)
    expect(incidents(spy).length).toBe(2)
    await ctx.db.delete("incidents", "a")
    expect(incidents(spy).map((r) => r.id)).toEqual(["b"])
    expect((spy.rows.get("incident_comments") ?? []).map((c) => c.body)).toEqual(["on b"])
  })

  it("rejects updateMany with where.id (non-empty data), like the bridge", async () => {
    const { ctx } = makeCtx()
    await expect(ctx.db.updateMany("incidents", { where: { id: "x" }, data: { title: "x" } })).rejects.toThrow(
      /where\.id is not allowed here/,
    )
  })

  it("updateMany with empty data resolves { count: 0 } before validating where", async () => {
    const { ctx } = makeCtx()
    expect(await ctx.db.updateMany("incidents", { where: { id: "x" }, data: {} })).toEqual({ count: 0 })
  })

  it("backstops UNIQUE (org_id, ref_number) on update", async () => {
    const { ctx, spy } = makeCtx()
    spy.rows.set("incidents", [
      { id: "one", ref_number: 1 },
      { id: "two", ref_number: 2 },
    ])
    await expect(ctx.db.update("incidents", "two", { ref_number: 1 })).rejects.toThrow(/UNIQUE constraint/)
    expect(incidents(spy).find((r) => r.id === "two")?.ref_number).toBe(2)
  })

  it("returns copies from findOne and findMany (a later update does not mutate them)", async () => {
    const { ctx, spy } = makeCtx()
    spy.rows.set("incidents", [{ id: "x", title: "old" }])
    const one = (await ctx.db.findOne("incidents", "x")) as StoredRow
    const many = ((await ctx.db.findMany("incidents", {})) as StoredRow[])[0]!
    one.title = "changed"
    many.title = "changed too"
    expect(incidents(spy)[0]?.title).toBe("old")
    const held = (await ctx.db.findOne("incidents", "x")) as StoredRow
    await ctx.db.update("incidents", "x", { title: "new" })
    expect(held.title).toBe("old")
    expect(incidents(spy)[0]?.title).toBe("new")
  })

  it("allocates per-key sequences starting at 1 and resolves an error envelope once on failNextAllocate", async () => {
    const { ctx, spy } = makeCtx()
    expect(await ctx.sequences.allocate({ key: "monitoring:a" })).toEqual({ value: 1 })
    expect(await ctx.sequences.allocate({ key: "monitoring:a" })).toEqual({ value: 2 })
    expect(await ctx.sequences.allocate({ key: "monitoring:b" })).toEqual({ value: 1 })
    spy.failNextAllocate = true
    const failed = (await ctx.sequences.allocate({ key: "monitoring:a" })) as unknown as { error: { code: string } }
    expect(failed.error.code).toBe("test")
    expect(await ctx.sequences.allocate({ key: "monitoring:a" })).toEqual({ value: 3 })
  })

  it("runs each during* hook exactly once, before the call's own work", async () => {
    const { ctx, spy } = makeCtx()
    spy.rows.set("incidents", [{ id: "x", status: "resolved" }])

    let allocateHooks = 0
    spy.duringNextAllocate = async () => {
      allocateHooks++
      spy.failNextAllocate = true
    }
    const first = (await ctx.sequences.allocate({ key: "monitoring:k" })) as unknown as { error?: unknown }
    // The hook ran before failNextAllocate was checked, so this call failed.
    expect(first.error).toBeDefined()
    expect(await ctx.sequences.allocate({ key: "monitoring:k" })).toEqual({ value: 1 })
    expect(allocateHooks).toBe(1)

    let findHooks = 0
    spy.duringNextFindMany = async () => {
      findHooks++
      incidents(spy)[0]!.status = "open"
    }
    const rows = (await ctx.db.findMany("incidents", { where: { status: "open" } })) as StoredRow[]
    expect(rows.length).toBe(1)
    await ctx.db.findMany("incidents", {})
    expect(findHooks).toBe(1)

    let updateHooks = 0
    spy.duringNextUpdateMany = async () => {
      updateHooks++
      incidents(spy)[0]!.status = "resolved"
    }
    const res = await ctx.db.updateMany("incidents", { where: { status: "open" }, data: { title: "t" } })
    expect(res).toEqual({ count: 0 })
    await ctx.db.updateMany("incidents", { where: { status: "resolved" }, data: { title: "t2" } })
    expect(updateHooks).toBe(1)
  })

  it("failNextInsert and failNextFindOne reject once for the named entity", async () => {
    const { ctx, spy } = makeCtx()
    spy.failNextInsert = "incident_comments"
    await expect(ctx.db.insert("incident_comments", { body: "x" })).rejects.toThrow(/insert failed/)
    const ok = await ctx.db.insert("incident_comments", { body: "y" })
    expect(ok.id).toBeTruthy()

    spy.rows.set("incidents", [{ id: "x" }])
    spy.failNextFindOne = "incidents"
    await expect(ctx.db.findOne("incidents", "x")).rejects.toThrow(/findOne failed/)
    expect(((await ctx.db.findOne("incidents", "x")) as StoredRow).id).toBe("x")
  })

  it("records logger.error calls in spy.errors", () => {
    const { ctx, spy } = makeCtx()
    ctx.logger.error("m", { a: 1 })
    expect(spy.errors).toEqual([{ msg: "m", data: { a: 1 } }])
  })
})
