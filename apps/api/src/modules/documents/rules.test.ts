// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The needed-template matcher (rules.ts), pure: AND across conditions, any-of
// within one, an empty `when` never matches, unknown keys have no effect, and
// a template that cannot print never comes back.

import { describe, expect, it } from "bun:test"
import { type MatchableRule, type MatchableTemplate, matchRecords, whenMatches } from "./rules"

const T1 = "00000000-0000-4000-8000-000000000001"
const T2 = "00000000-0000-4000-8000-000000000002"
const T3 = "00000000-0000-4000-8000-000000000003"

const usable = (id: string): MatchableTemplate => ({ id, enabled: true, archivedAt: null })
const templates = new Map([T1, T2, T3].map((id) => [id, usable(id)]))

function rule(id: string, when: unknown, templateIds: string[], enabled = true): MatchableRule {
  return { id, name: id, enabled, when, templateIds }
}

const plateToUs = { id: "r1", skus: ["acc-plate-01", "cable-2m"], countryIso2: "us" }

describe("whenMatches", () => {
  it("an empty `when` never matches, whatever the record", () => {
    expect(whenMatches({}, plateToUs)).toBe(false)
    expect(whenMatches(null, plateToUs)).toBe(false)
    expect(whenMatches([], plateToUs)).toBe(false)
    expect(whenMatches({ sku: [] }, plateToUs)).toBe(false)
  })

  it("sku and country combine with AND", () => {
    const when = { sku: ["ACC-PLATE-01"], countryIso2: ["US"] }
    expect(whenMatches(when, plateToUs)).toBe(true)
    expect(whenMatches(when, { ...plateToUs, countryIso2: "FR" })).toBe(false)
    expect(whenMatches(when, { ...plateToUs, skus: ["cable-2m"] })).toBe(false)
  })

  it("values within one key are any-of; a sku matches when ANY record sku is listed", () => {
    expect(whenMatches({ countryIso2: ["CA", "US"] }, plateToUs)).toBe(true)
    expect(whenMatches({ sku: ["other", "cable-2m"] }, plateToUs)).toBe(true)
  })

  it("a sku is an exact match, case-insensitive, never a prefix", () => {
    expect(whenMatches({ sku: ["acc-plate"] }, plateToUs)).toBe(false)
    expect(whenMatches({ sku: ["Acc-Plate-01"] }, plateToUs)).toBe(true)
  })

  it("a record with no skus, country or carrier does not satisfy that condition", () => {
    expect(whenMatches({ sku: ["x"] }, { id: "r" })).toBe(false)
    expect(whenMatches({ countryIso2: ["US"] }, { id: "r", countryIso2: null })).toBe(false)
    expect(whenMatches({ carrier: ["ups"] }, { id: "r" })).toBe(false)
  })

  it("carrier matches the record's carrier family", () => {
    expect(whenMatches({ carrier: ["UPS"] }, { id: "r", carrier_family: "ups" })).toBe(true)
    expect(whenMatches({ carrier: ["dhl"] }, { id: "r", carrier_family: "ups" })).toBe(false)
  })

  it("an unknown key in stored data has no effect, and alone it never matches", () => {
    expect(whenMatches({ material: ["steel"] }, plateToUs)).toBe(false)
    expect(whenMatches({ countryIso2: ["US"], material: ["steel"] }, plateToUs)).toBe(true)
    expect(whenMatches({ countryIso2: ["US"], __proto__: { sku: ["nope"] } }, plateToUs)).toBe(true)
  })

  it("a known key that is not a list of strings never matches", () => {
    expect(whenMatches({ sku: "acc-plate-01" }, plateToUs)).toBe(false)
    expect(whenMatches({ sku: [1, 2] }, plateToUs)).toBe(false)
  })
})

describe("matchRecords", () => {
  it("unions the templates of every matching enabled rule, in rule order, without repeats", () => {
    const rules = [
      rule("a", { sku: ["acc-plate-01"] }, [T1, T2]),
      rule("b", { countryIso2: ["US"] }, [T2, T3]),
      rule("c", { countryIso2: ["US"] }, [T1], false),
      rule("d", { countryIso2: ["FR"] }, [T3]),
    ]
    const [m] = matchRecords(rules, templates, [plateToUs])
    expect(m).toEqual({ recordId: "r1", ruleIds: ["a", "b"], templateIds: [T1, T2, T3] })
  })

  it("drops a template that is missing (deleted), disabled or archived", () => {
    const some = new Map<string, MatchableTemplate>([
      [T1, usable(T1)],
      [T2, { id: T2, enabled: false, archivedAt: null }],
      [T3, { id: T3, enabled: true, archivedAt: new Date() }],
    ])
    const gone = "00000000-0000-4000-8000-0000000000ff"
    const [m] = matchRecords([rule("a", { countryIso2: ["US"] }, [gone, T1, T2, T3])], some, [
      plateToUs,
    ])
    expect(m?.templateIds).toEqual([T1])
    expect(m?.ruleIds).toEqual(["a"])
  })

  it("answers every record, a record that matches nothing with empty lists", () => {
    const out = matchRecords([rule("a", { sku: ["acc-plate-01"] }, [T1])], templates, [
      plateToUs,
      { id: "r2", skus: ["cable-2m"] },
    ])
    expect(out.map((m) => m.templateIds)).toEqual([[T1], []])
  })
})
