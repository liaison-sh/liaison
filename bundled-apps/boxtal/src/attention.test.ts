// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Attention rules. The design claim these tests defend is that the rules are DATA: the smelt and
// cast case below is expressed entirely as a rule row, with no branch anywhere in the code that
// knows about aluminium, the USA, or the Tessera 2.
import { describe, expect, it } from "bun:test"
import { conditionMatches, evaluateAttention, mergeTemplateNeed, ruleMatches, type AttentionFacts, type AttentionRule } from "./attention"

const US_TESSERA2: AttentionFacts = {
  destination: "US",
  carrier: "FEDX-InternationalEconomy",
  category: "sale",
  products: "1xET2, 1xHC",
  weight: 8.1,
  declared_value: 899,
  items: 2,
}

/** The rule Quinn asked for, written the way an operator (or the agent, from a KB article) would
 *  store it — not the way a developer would hardcode it. */
const SMELT_AND_CAST: AttentionRule = {
  name: "Aluminium: smelt and cast (US import)",
  conditions: [
    { field: "destination", op: "in", value: ["US", "PR"] },
    { field: "products", op: "contains", value: "ET2" },
  ],
  documents: [
    { name: "Smelt and cast declaration", note: "Country of smelt and of cast for the aluminium body" },
    { name: "Steel and aluminium derivative worksheet", note: "FedEx clearance form" },
  ],
  knowledge_ref: "kb:customs-us-aluminium",
}

describe("evaluateAttention", () => {
  it("marks the parcel the rule describes, with its documents and its source article", () => {
    const mark = evaluateAttention(US_TESSERA2, [SMELT_AND_CAST])!
    expect(mark.rules).toEqual(["Aluminium: smelt and cast (US import)"])
    expect(mark.documents.map((d) => d.name)).toEqual([
      "Smelt and cast declaration",
      "Steel and aluminium derivative worksheet",
    ])
    expect(mark.knowledge_refs).toEqual(["kb:customs-us-aluminium"])
    expect(mark.summary).toContain("Needs: Smelt and cast declaration")
    // Operator-facing copy: no dash punctuation.
    expect(mark.summary).not.toContain("—")
    expect(mark.summary).not.toContain("--")
  })

  it("leaves the same product to a different country alone", () => {
    expect(evaluateAttention({ ...US_TESSERA2, destination: "DE" }, [SMELT_AND_CAST])).toBeNull()
  })

  it("leaves a different product to the same country alone", () => {
    expect(evaluateAttention({ ...US_TESSERA2, products: "2xHC" }, [SMELT_AND_CAST])).toBeNull()
  })

  it("unions the documents of every matching rule, de-duplicated", () => {
    const heavy: AttentionRule = {
      name: "Over 30 kg: two-person handling note",
      conditions: [{ field: "weight", op: "gte", value: 30 }],
      documents: [
        { name: "Handling note" },
        // Same document as the first rule: the operator must see it once, not twice.
        { name: "smelt and cast declaration" },
      ],
    }
    const mark = evaluateAttention({ ...US_TESSERA2, weight: 44 }, [SMELT_AND_CAST, heavy])!
    expect(mark.rules).toHaveLength(2)
    expect(mark.documents.map((d) => d.name)).toEqual([
      "Smelt and cast declaration",
      "Steel and aluminium derivative worksheet",
      "Handling note",
    ])
  })

  it("returns null for a row no rule describes, and for no rules at all", () => {
    expect(evaluateAttention(US_TESSERA2, [])).toBeNull()
    expect(evaluateAttention({ ...US_TESSERA2, destination: null }, [SMELT_AND_CAST])).toBeNull()
  })
})

describe("a rule that cannot be evaluated stays inert", () => {
  // A false "needs paperwork" on every row teaches the operator to ignore the marker, which is
  // worse than no marker. Anything unanswerable is a non-match, never a throw and never a match.
  it("ignores an unknown field or operator instead of throwing", () => {
    expect(() =>
      ruleMatches(US_TESSERA2, {
        name: "bad",
        conditions: [{ field: "colour" as never, op: "eq", value: "red" }],
      }),
    ).not.toThrow()
    expect(
      ruleMatches(US_TESSERA2, { name: "bad", conditions: [{ field: "colour" as never, op: "eq", value: "red" }] }),
    ).toBe(false)
    expect(
      ruleMatches(US_TESSERA2, { name: "bad", conditions: [{ field: "destination", op: "matches" as never, value: "US" }] }),
    ).toBe(false)
  })

  it("never fires on a rule with no conditions", () => {
    expect(ruleMatches(US_TESSERA2, { name: "empty", conditions: [] })).toBe(false)
    expect(ruleMatches(US_TESSERA2, { name: "empty" })).toBe(false)
  })

  it("respects enabled:false without deleting the rule", () => {
    expect(ruleMatches(US_TESSERA2, { ...SMELT_AND_CAST, enabled: false })).toBe(false)
  })

  it("does not match on a missing fact", () => {
    expect(conditionMatches({ ...US_TESSERA2, weight: null }, { field: "weight", op: "gte", value: 1 })).toBe(false)
  })
})

describe("the condition language", () => {
  it("compares strings case-insensitively and numbers numerically", () => {
    expect(conditionMatches(US_TESSERA2, { field: "destination", op: "eq", value: "us" })).toBe(true)
    expect(conditionMatches(US_TESSERA2, { field: "carrier", op: "starts_with", value: "fedx" })).toBe(true)
    expect(conditionMatches(US_TESSERA2, { field: "declared_value", op: "gte", value: 899 })).toBe(true)
    expect(conditionMatches(US_TESSERA2, { field: "declared_value", op: "lte", value: 898 })).toBe(false)
    expect(conditionMatches(US_TESSERA2, { field: "items", op: "gte", value: "2" })).toBe(true)
  })

  it("requires a list for `in`", () => {
    expect(conditionMatches(US_TESSERA2, { field: "destination", op: "in", value: "US" })).toBe(false)
    expect(conditionMatches(US_TESSERA2, { field: "destination", op: "in", value: ["FR", "US"] })).toBe(true)
  })
})

describe("mergeTemplateNeed", () => {
  const mark = {
    rules: ["Aluminium: smelt and cast"],
    documents: [{ name: "Smelt and cast declaration", note: "From the foundry" }],
    knowledge_refs: ["kb-1"],
    summary: "Needs: Smelt and cast declaration (Aluminium: smelt and cast)",
  }

  it("folds the templates into the one mark, linking a same-named document to its template", () => {
    const merged = mergeTemplateNeed(mark, {
      rules: ["Plate to the US"],
      templates: [
        { id: "t-smelt", name: "smelt and cast declaration" },
        { id: "t-tsca", name: "TSCA certificate" },
      ],
    })
    expect(merged).toEqual({
      rules: ["Aluminium: smelt and cast", "Plate to the US"],
      documents: [
        { name: "Smelt and cast declaration", note: "From the foundry", template_id: "t-smelt" },
        { name: "TSCA certificate", note: null, template_id: "t-tsca" },
      ],
      knowledge_refs: ["kb-1"],
      summary: "Needs: Smelt and cast declaration, TSCA certificate (Aluminium: smelt and cast; Plate to the US)",
    })
  })

  it("no need leaves the mark as it was; a need alone makes one", () => {
    expect(mergeTemplateNeed(mark, undefined)).toBe(mark)
    expect(mergeTemplateNeed(null, undefined)).toBeNull()
    expect(mergeTemplateNeed(null, { rules: ["R"], templates: [{ id: "t", name: "Doc" }] })?.summary).toBe("Needs: Doc (R)")
  })
})
