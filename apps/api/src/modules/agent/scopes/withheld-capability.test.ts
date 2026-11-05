// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Withheld capabilities reach a public reply only as category labels: never a
// raw scope string, never an app prefix that has no label.

import { describe, expect, test } from "bun:test"
import { buildWithheldItems, describeWithheldCapabilities } from "./withheld-capability"
import { WITHHELD_CAPABILITY_LABELS } from "./withheld-capability-labels"

describe("describeWithheldCapabilities", () => {
  test("describeWithheldCapabilities maps scope prefixes to category labels, never the raw scope string", () => {
    const withheld = ["pennylane:payouts:read", "boxtal:shipments:write"]
    const out = describeWithheldCapabilities(withheld, {
      pennylane: "finance data",
      boxtal: "shipping data",
    })
    expect([...out].sort()).toEqual(["finance data", "shipping data"])
    for (const element of out) {
      expect(element.includes(":")).toBe(false)
      expect(withheld).not.toContain(element)
    }
  })

  test("unmapped prefixes fall back to a generic label, never the raw scope", () => {
    const out = describeWithheldCapabilities(["unknownapp:x:read"], {})
    expect(out).toEqual(["a capability"])
    expect(out.join(" ")).not.toContain("unknownapp")
  })

  test("duplicate category labels are deduplicated", () => {
    const out = describeWithheldCapabilities(
      ["pennylane:payouts:read", "pennylane:invoices:write"],
      {
        pennylane: "finance data",
      },
    )
    expect(out).toEqual(["finance data"])
    expect(out).toHaveLength(1)
  })

  test("prefixes named after Object.prototype members still fall back to the generic label", () => {
    const out = describeWithheldCapabilities(["constructor:x:read", "__proto__:y:read"], {})
    expect(out).toEqual(["a capability"])
  })
})

describe("the shipped labels are what a card actually says", () => {
  test("a withheld scope names its capability category, not the generic label", () => {
    // Every call site passed an EMPTY label map, so every scope fell through
    // to the generic label and every card in the product read "a capability".
    expect(describeWithheldCapabilities(["pennylane:payouts:read"])).toEqual(["finance data"])
    expect(describeWithheldCapabilities(["tickets:tickets:write"])).toEqual(["support tickets"])
    expect(buildWithheldItems(["boxtal:shipments:write"]).map((i) => i.label)).toEqual(["shipping"])
  })

  test("an app with no curated label still says nothing about itself", () => {
    expect(describeWithheldCapabilities(["unknownapp:x:read"])).toEqual(["a capability"])
    // An explicit map still wins, and an explicit EMPTY one still labels nothing.
    expect(describeWithheldCapabilities(["pennylane:payouts:read"], {})).toEqual(["a capability"])
  })

  test("no label is a scope string, an app prefix or a tool name", () => {
    for (const [app, label] of Object.entries(WITHHELD_CAPABILITY_LABELS)) {
      expect(label.includes(":")).toBe(false)
      expect(label.toLowerCase()).not.toBe(app.toLowerCase())
      expect(label.trim().length).toBeGreaterThan(0)
    }
  })
})
