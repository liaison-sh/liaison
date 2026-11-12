// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { attentionRulesList, attentionRuleUpsert, loadAttentionRules } from "./attention-store"
import type { BoxtalToolCtx } from "./ctx"
import { createMockDb } from "./test-db"

function makeCtx(seed: Record<string, Array<Record<string, unknown>>> = {}) {
  const db = createMockDb({ seed })
  return { db } as unknown as BoxtalToolCtx
}

const VALID = {
  name: "Aluminium: smelt and cast (US import)",
  conditions: [
    { field: "destination", op: "in", value: ["US"] },
    { field: "products", op: "contains", value: "ET2" },
  ],
  documents: [{ name: "Smelt and cast declaration", note: "Country of smelt and of cast" }],
  knowledge_ref: "kb:customs-us-aluminium",
}

describe("attentionRuleUpsert", () => {
  it("stores a rule and hands back its id", async () => {
    const ctx = makeCtx()
    const { rule } = await attentionRuleUpsert(ctx, VALID)
    expect(rule.id).toBeTruthy()
    expect(rule.enabled).toBe(true)
    expect((await loadAttentionRules(ctx))[0]!.name).toBe(VALID.name)
  })

  // Refused at WRITE time, because a malformed rule that is merely inert at evaluation time is
  // indistinguishable from a parcel that needs nothing: the operator would never learn it is broken.
  it("refuses a rule with no conditions", async () => {
    await expect(attentionRuleUpsert(makeCtx(), { ...VALID, conditions: [] })).rejects.toThrow(
      /at least one condition/,
    )
  })

  it("refuses an unknown field or operator, naming the vocabulary", async () => {
    await expect(
      attentionRuleUpsert(makeCtx(), {
        ...VALID,
        conditions: [{ field: "colour", op: "eq", value: "red" }],
      }),
    ).rejects.toThrow(/must be one of: destination/)
    await expect(
      attentionRuleUpsert(makeCtx(), {
        ...VALID,
        conditions: [{ field: "destination", op: "matches", value: "US" }],
      }),
    ).rejects.toThrow(/must be one of: eq/)
  })

  it("refuses `in` without a list, and a document with no name", async () => {
    await expect(
      attentionRuleUpsert(makeCtx(), {
        ...VALID,
        conditions: [{ field: "destination", op: "in", value: "US" }],
      }),
    ).rejects.toThrow(/value must be a list/)
    await expect(
      attentionRuleUpsert(makeCtx(), { ...VALID, documents: [{ note: "orphan" }] }),
    ).rejects.toThrow(/name is required/)
  })

  it("refuses a rule with no name", async () => {
    await expect(attentionRuleUpsert(makeCtx(), { ...VALID, name: "  " })).rejects.toThrow(
      /name is required/,
    )
  })
})

describe("attentionRulesList", () => {
  it("returns the vocabulary alongside the rules, so a caller cannot invent a field", async () => {
    const res = await attentionRulesList(makeCtx())
    expect(res.fields).toContain("destination")
    expect(res.fields).toContain("declared_value")
    expect(res.ops).toContain("starts_with")
  })
})

describe("loadAttentionRules", () => {
  it("degrades to no rules rather than failing the worklist read", async () => {
    const broken = {
      db: {
        findMany: async () => {
          throw new Error("table missing")
        },
      },
    } as unknown as BoxtalToolCtx
    expect(await loadAttentionRules(broken)).toEqual([])
  })
})
