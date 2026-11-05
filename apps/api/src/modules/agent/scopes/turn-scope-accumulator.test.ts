// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  createTurnScopeAccumulator,
  type TurnScopeAccumulator,
} from "~/modules/agent/scopes/turn-scope-accumulator"

describe("turn scope accumulator", () => {
  it("accumulator starts empty", () => {
    const acc = createTurnScopeAccumulator()
    expect(acc.snapshot()).toEqual([])
  })

  it("accumulator unions requiredScopes across multiple record calls, projected onto read scopes", () => {
    const acc = createTurnScopeAccumulator()
    acc.record({ requiredScopes: ["a:b:read"] })
    // A write scope classifies no data: it lands on its catalogued read sibling (scope-taint.ts,
    // rule 5), and one with no read sibling in any catalog is dropped.
    acc.record({ requiredScopes: ["kernel:skills:write", "c:d:write", "a:b:read"] })
    expect(acc.snapshot()).toEqual(["a:b:read", "kernel:skills:read"])
  })

  it("accumulator ignores a tool that declares no scope", () => {
    const acc = createTurnScopeAccumulator()
    acc.record({ requiredScopes: ["a:b:read"] })
    const before = acc.snapshot()
    expect(() => acc.record({})).not.toThrow()
    expect(acc.snapshot()).toEqual(before)
    expect(acc.snapshot()).toEqual(["a:b:read"])
  })

  it("a grant wildcard entering the set is expanded onto the read scopes it covers, never kept", () => {
    const acc = createTurnScopeAccumulator()
    acc.record({ requiredScopes: ["n:a:read"] })
    // scope-taint.ts, rule 10b (2026-11-03): `x:y:*` covers no catalogued read scope here.
    acc.recordInjected(["x:y:*", "z:w:read"])
    expect(acc.snapshot()).toEqual(["n:a:read", "z:w:read"])
    acc.recordInjected(["kernel:*"])
    expect(acc.snapshot()).toContain("kernel:threads:read")
    expect(acc.snapshot().filter((s) => s.split(":").includes("*"))).toEqual([])
  })

  it("exposes no abnormal-end widening: the snapshot is the turn's record whatever the end", () => {
    const acc = createTurnScopeAccumulator()
    acc.record({ requiredScopes: ["n:a:read"] })
    expect("markAbnormalEnd" in acc).toBe(false)
    expect(acc.snapshot()).toEqual(["n:a:read"])
  })

  it("recordInjected unions an externally-resolved requiredScopes array into the same accumulator", () => {
    const acc = createTurnScopeAccumulator()
    acc.record({ requiredScopes: ["a:b:read"] })
    acc.recordInjected(["m:n:read"])
    expect(acc.snapshot()).toEqual(["a:b:read", "m:n:read"])
  })

  it("recordInjected and record accumulate into the same set, order independent", () => {
    const acc = createTurnScopeAccumulator()
    acc.recordInjected(["m:n:read"])
    acc.record({ requiredScopes: ["a:b:read"] })
    expect(acc.snapshot()).toEqual(["a:b:read", "m:n:read"])
  })
})

describe("readInternalData: has the turn read org data (scope-taint.ts, rule 6i)", () => {
  it("is false for a fresh turn, its own instructions and public web reads", () => {
    const acc = createTurnScopeAccumulator()
    expect(acc.readInternalData()).toBe(false)
    acc.recordInstructions(["tickets:read", "knowledge:read"])
    acc.record({ requiredScopes: ["kernel:agent:web"] })
    acc.recordInjected([])
    expect(acc.readInternalData()).toBe(false)
    // The instructions still taint writes.
    expect(acc.snapshot()).toEqual(["kernel:agent:web", "knowledge:read", "tickets:read"])
  })

  it.each([
    ["a scoped tool call", (a: TurnScopeAccumulator) => a.record({ requiredScopes: ["crm:read"] })],
    ["a tool call that declares no scope", (a: TurnScopeAccumulator) => a.record({})],
    ["a scoped injection", (a: TurnScopeAccumulator) => a.recordInjected(["knowledge:read"])],
    ["an explicit mark (memory)", (a: TurnScopeAccumulator) => a.markInternalRead()],
  ])("is true after %s", (_label, read) => {
    const acc = createTurnScopeAccumulator()
    read(acc)
    expect(acc.readInternalData()).toBe(true)
  })
})
