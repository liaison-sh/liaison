// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P4b-D9: the home UI strings that slice 4b shipped as English literals.
//
// They exist in both locales or the French client silently falls back to
// English, which is the failure this pins. The French side also follows the
// product's copy rule: no dash punctuation in anything a customer reads.

import { describe, expect, it } from "bun:test"
import en from "./locales/en/kernel.json"
import fr from "./locales/fr/kernel.json"

const KEYS = [
  "agentStateQueued",
  "agentStateWorking",
  "agentStateStuck",
  "agentStateFailed",
  "addMemberHiddenHistoryWarning",
  "addMemberAddAnyway",
  "withheldCapabilitiesTitle",
  "withheldCapabilitiesBody",
  "withheldContinueInDm",
  "withheldShareAnyway",
  "withheldNotShareableHere",
  "agentArchiveBlocked",
] as const

describe("home UI kernel strings", () => {
  it("every key is translated in both locales", () => {
    const missing = KEYS.filter(
      (k) =>
        typeof (en as unknown as Record<string, unknown>)[k] !== "string" ||
        typeof (fr as unknown as Record<string, unknown>)[k] !== "string",
    )
    expect(missing).toEqual([])
  })

  it("the French text is not the English text", () => {
    for (const key of KEYS) {
      expect({ key, same: (en as any)[key] === (fr as any)[key] }).toEqual({ key, same: false })
    }
  })

  it("no dash punctuation reaches a reader, in either locale", () => {
    for (const key of KEYS) {
      for (const text of [(en as any)[key], (fr as any)[key]]) {
        expect({ key, text, dashes: /--|–|—/.test(text) }).toEqual({
          key,
          text,
          dashes: false,
        })
      }
    }
  })

  it("the warning names the person it is about", () => {
    expect((en as any).addMemberHiddenHistoryWarning).toContain("{{name}}")
    expect((fr as any).addMemberHiddenHistoryWarning).toContain("{{name}}")
  })
})

// The attention feed's relative times, source labels, section count lines and
// alert cluster control were English literals in the components: a French
// reader got translated ITEMS under "Tickets / Team / Knowledge", counted by
// "6 blocked, 1 task assigned", timed by "5h ago" and folded by "Show".
// Every one of them is a catalog string now, and a catalog string that exists
// in one locale only is the same bug wearing a key.
describe("attention feed chrome strings", () => {
  const SUBTREES = ["homeSource", "homeCluster"] as const

  function leaves(value: unknown, prefix: string): Array<[string, string]> {
    if (typeof value === "string") return [[prefix, value]]
    if (value && typeof value === "object") {
      return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
        leaves(v, prefix ? `${prefix}.${k}` : k),
      )
    }
    return []
  }

  it("carries the flat keys in both locales", () => {
    for (const key of [
      "homeTimeJustNow",
      "homeAlso",
      "homeClusterOldest",
      "homeClusterShow",
      "homeClusterHide",
    ]) {
      expect({ key, en: typeof (en as any)[key], fr: typeof (fr as any)[key] }).toEqual({
        key,
        en: "string",
        fr: "string",
      })
      expect({ key, same: (en as any)[key] === (fr as any)[key] }).toEqual({ key, same: false })
    }
  })

  it("translates every source and cluster label", () => {
    for (const subtree of SUBTREES) {
      const enLeaves = leaves((en as any)[subtree], "")
      expect({ subtree, count: enLeaves.length > 0 }).toEqual({ subtree, count: true })
      const frMap = new Map(leaves((fr as any)[subtree], ""))
      for (const [key] of enLeaves) {
        expect({ subtree, key, translated: typeof frMap.get(key) }).toEqual({
          subtree,
          key,
          translated: "string",
        })
      }
    }
  })

  it("gives every kind both a singular and a plural, in both locales", () => {
    const enKinds = Object.keys((en as any).homeKind ?? {})
    expect(enKinds.length).toBeGreaterThan(10)
    for (const kind of enKinds) {
      for (const [name, dict] of [
        ["en", en],
        ["fr", fr],
      ] as const) {
        const forms = (dict as any).homeKind?.[kind]
        expect({ kind, name, one: typeof forms?.one, other: typeof forms?.other }).toEqual({
          kind,
          name,
          one: "string",
          other: "string",
        })
      }
    }
  })

  it("keeps dash punctuation out of the feed chrome, in either locale", () => {
    for (const dict of [en, fr]) {
      for (const subtree of ["homeSource", "homeCluster", "homeKind"]) {
        for (const [key, text] of leaves((dict as any)[subtree], "")) {
          expect({ key, text, dashes: /--|–|—/.test(text) }).toEqual({ key, text, dashes: false })
        }
      }
    }
  })
})
