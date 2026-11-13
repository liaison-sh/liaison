// SPDX-License-Identifier: FSL-1.1-ALv2
// A manifest `summarizerContext` with `when` runs its hydration read only when
// that dot-path of the gated call's params holds a value (api-connector's
// connector_write: only a write whose adapter pinned an approval context).
import { describe, expect, it } from "bun:test"
import { summarizerContextWanted } from "./runtime"

describe("summarizerContext when", () => {
  const decl = { tool: "connector_read", params: {}, when: "approval.context" }

  it("runs when the path holds a value", () => {
    expect(summarizerContextWanted(decl, { approval: { context: { operation: "x" } } })).toBe(true)
  })

  it("skips when the path is absent or null", () => {
    expect(summarizerContextWanted(decl, { connection: "crm" })).toBe(false)
    expect(summarizerContextWanted(decl, { approval: { description: "d" } })).toBe(false)
    expect(summarizerContextWanted(decl, { approval: { context: null } })).toBe(false)
    expect(summarizerContextWanted(decl, null)).toBe(false)
  })

  it("without when, always runs (every manifest that predates it)", () => {
    expect(summarizerContextWanted({ tool: "findings_get", params: {} }, {})).toBe(true)
  })
})
