// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Incident reference tests: `INC-<n>` parsing and formatting, the lock-first numbering
// protocol, the `assign-refs` job and the UUID-or-ref resolver.
import { describe, expect, it } from "bun:test"
import { assignRefsJobHandler, JOB_REF_BATCH } from "../jobs"
import { incidents, makeCtx, type StoredRow } from "../test-ctx"
import { allocateRef, assignMissingRefs, formatRef, parseRef, refFields, refLabel, resolveIncident } from "./refs"

const KEY = "monitoring:incident_ref"
const ALL = { limit: 100 }

function ts(hour: number, minute = 0): string {
  return new Date(Date.UTC(2026, 5, 1, hour, minute)).toISOString()
}

describe("parseRef / formatRef / refLabel / refFields", () => {
  it("parses INC-n case-insensitively and trimmed", () => {
    expect(parseRef("INC-142")).toBe(142)
    expect(parseRef("inc-142")).toBe(142)
    expect(parseRef(" INC-142 ")).toBe(142)
  })

  it("rejects everything that is not a positive INC-n of at most 9 digits", () => {
    for (const bad of ["INC-0", "INC-", "INC-1a", "INC-1234567890", "142", "row-1000", "", undefined, 42, null]) {
      expect(parseRef(bad)).toBeNull()
    }
  })

  it("formats refs and labels", () => {
    expect(formatRef(7)).toBe("INC-7")
    expect(formatRef(null)).toBeNull()
    expect(formatRef(undefined)).toBeNull()
    expect(formatRef(0)).toBeNull()
    expect(refLabel("INC-7")).toBe("[INC-7] ")
    expect(refLabel(null)).toBe("")
    expect(refFields(3)).toEqual({ ref: "INC-3", refLabel: "[INC-3] " })
    expect(refFields(undefined)).toEqual({ ref: null, refLabel: "" })
    // The bridge coerces an integer column to a number: anything else is "not numbered".
    for (const bad of ["12", 1.5, -3, Number.NaN, {}]) expect(refFields(bad)).toEqual({ ref: null, refLabel: "" })
  })
})

describe("assignMissingRefs", () => {
  it("numbers NULL rows in first_seen_at order, ties broken by id", async () => {
    const { ctx, spy } = makeCtx()
    // Insertion order is opposite to the expected order and to id order for the tie.
    spy.rows.set("incidents", [
      { id: "inc-c", first_seen_at: ts(3) },
      { id: "inc-b2", first_seen_at: ts(2) },
      { id: "inc-a", first_seen_at: ts(1) },
      { id: "inc-b1", first_seen_at: ts(2) },
    ])
    expect(await assignMissingRefs(ctx, ALL)).toEqual({ assigned: 4, remaining: false })
    const refs = Object.fromEntries(incidents(spy).map((r) => [r.id, r.ref_number]))
    expect(refs).toEqual({ "inc-a": 1, "inc-b1": 2, "inc-b2": 3, "inc-c": 4 })
  })

  it("never renumbers a numbered row", async () => {
    const { ctx, spy } = makeCtx()
    spy.rows.set("incidents", [
      { id: "n", first_seen_at: ts(1), ref_number: 99 },
      { id: "x", first_seen_at: ts(2) },
      { id: "y", first_seen_at: ts(3) },
    ])
    await assignMissingRefs(ctx, ALL)
    const refs = Object.fromEntries(incidents(spy).map((r) => [r.id, r.ref_number]))
    expect(refs).toEqual({ n: 99, x: 1, y: 2 })
  })

  it("allocates nothing when no row is NULL", async () => {
    const { ctx, spy } = makeCtx()
    spy.rows.set("incidents", [{ id: "n", first_seen_at: ts(1), ref_number: 5 }])
    expect(await assignMissingRefs(ctx, ALL)).toEqual({ assigned: 0, remaining: false })
    expect(spy.sequences.has(KEY)).toBe(false)
  })

  it("sets remaining when the batch is full and continues oldest first", async () => {
    const { ctx, spy } = makeCtx()
    spy.rows.set("incidents", [
      { id: "r3", first_seen_at: ts(3) },
      { id: "r1", first_seen_at: ts(1) },
      { id: "r2", first_seen_at: ts(2) },
    ])
    expect(await assignMissingRefs(ctx, { limit: 2 })).toEqual({ assigned: 2, remaining: true })
    expect(incidents(spy).find((r) => r.id === "r1")?.ref_number).toBe(1)
    expect(incidents(spy).find((r) => r.id === "r2")?.ref_number).toBe(2)
    expect(incidents(spy).find((r) => r.id === "r3")?.ref_number ?? null).toBeNull()
    expect(await assignMissingRefs(ctx, { limit: 2 })).toEqual({ assigned: 1, remaining: false })
    expect(incidents(spy).find((r) => r.id === "r3")?.ref_number).toBe(3)
  })

  it("lock-first: a row numbered by another numberer between the probe and the lock is left alone and the value is burned", async () => {
    const { ctx, spy } = makeCtx()
    spy.rows.set("incidents", [{ id: "x", first_seen_at: ts(1) }])
    spy.duringNextAllocate = async () => {
      incidents(spy)[0]!.ref_number = 7
    }
    expect(await assignMissingRefs(ctx, ALL)).toEqual({ assigned: 0, remaining: false })
    expect(incidents(spy)[0]?.ref_number).toBe(7)
    expect(spy.sequences.get(KEY)).toBe(1)
  })

  it("lock-first: the list is read under the lock, so a row numbered meanwhile is not renumbered", async () => {
    const { ctx, spy } = makeCtx()
    spy.rows.set("incidents", [
      { id: "p", first_seen_at: ts(1) },
      { id: "q", first_seen_at: ts(2) },
    ])
    spy.duringNextAllocate = async () => {
      incidents(spy).find((r) => r.id === "p")!.ref_number = 7
    }
    expect(await assignMissingRefs(ctx, ALL)).toEqual({ assigned: 1, remaining: false })
    expect(incidents(spy).find((r) => r.id === "p")?.ref_number).toBe(7)
    expect(incidents(spy).find((r) => r.id === "q")?.ref_number).toBe(1)
    expect(spy.sequences.get(KEY)).toBe(1)
  })

  it("surfaces an allocation error envelope as ref_allocation_failed and writes nothing", async () => {
    const { ctx, spy } = makeCtx()
    spy.failNextAllocate = true
    await expect(allocateRef(ctx)).rejects.toThrow(/ref_allocation_failed/)

    spy.rows.set("incidents", [{ id: "x", first_seen_at: ts(1) }])
    spy.failNextAllocate = true
    await expect(assignMissingRefs(ctx, ALL)).rejects.toThrow(/ref_allocation_failed/)
    expect(incidents(spy)[0]?.ref_number ?? null).toBeNull()
    expect(spy.sequences.size).toBe(0)
  })
})

describe("assignRefsJobHandler", () => {
  it("processes exactly one batch of 50 per call, oldest first, and logs its progress", async () => {
    expect(JOB_REF_BATCH).toBe(50)
    const { ctx, spy } = makeCtx()
    const infos: Array<{ msg: string; data?: unknown }> = []
    ctx.logger.info = (msg: string, data?: unknown) => {
      infos.push({ msg, data })
    }
    // Distinct first_seen_at, one minute apart, so inc-050 is the newest.
    const rows: StoredRow[] = Array.from({ length: JOB_REF_BATCH + 1 }, (_, i) => ({
      id: `inc-${String(i).padStart(3, "0")}`,
      first_seen_at: new Date(Date.UTC(2026, 5, 1, 0, i)).toISOString(),
    }))
    spy.rows.set("incidents", rows.reverse())
    expect(await assignRefsJobHandler({}, ctx)).toEqual({ assigned: JOB_REF_BATCH, remaining: true })
    const open = incidents(spy).filter((r) => r.ref_number == null)
    expect(open.map((r) => r.id)).toEqual(["inc-050"])
    expect(await assignRefsJobHandler({}, ctx)).toEqual({ assigned: 1, remaining: false })
    expect(incidents(spy).find((r) => r.id === "inc-050")?.ref_number).toBe(JOB_REF_BATCH + 1)
    // Nothing left: no third log line.
    expect(await assignRefsJobHandler({}, ctx)).toEqual({ assigned: 0, remaining: false })
    expect(infos.map((i) => i.data)).toEqual([
      { assigned: JOB_REF_BATCH, remaining: true },
      { assigned: 1, remaining: false },
    ])
  })
})

describe("resolveIncident", () => {
  it("resolves by id and by ref (trimmed, any case)", async () => {
    const { ctx, spy } = makeCtx()
    // Insertion order 3, 1, 2 so a positional lookup fails.
    spy.rows.set("incidents", [
      { id: "row-a", ref_number: 3 },
      { id: "row-b", ref_number: 1 },
      { id: "row-c", ref_number: 2 },
    ])
    expect((await resolveIncident(ctx, "row-a")).id).toBe("row-a")
    expect((await resolveIncident(ctx, " row-a ")).id).toBe("row-a")
    expect((await resolveIncident(ctx, " inc-2 ")).id).toBe("row-c")
    expect((await resolveIncident(ctx, "INC-3")).id).toBe("row-a")
  })

  it("rejects an unknown ref, an unknown id and an empty input", async () => {
    const { ctx, spy } = makeCtx()
    spy.rows.set("incidents", [{ id: "row-a", ref_number: 1 }])
    await expect(resolveIncident(ctx, "INC-99")).rejects.toThrow(/incident_not_found/)
    await expect(resolveIncident(ctx, "nope")).rejects.toThrow(/incident_not_found/)
    await expect(resolveIncident(ctx, "")).rejects.toThrow(/incident_not_found/)
  })
})
