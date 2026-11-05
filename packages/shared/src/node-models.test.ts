// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  currentNodeModels,
  DESKTOP_DEFAULT_LOCAL_MODEL,
  defaultLocalModel,
  exactOfferedModel,
  localModelFamily,
  offeredLocalModelFor,
  parseClaudeModelId,
  resolveNodeModel,
} from "./node-models"

const m = (...ids: string[]) => ids.map((id) => ({ id, label: id }))

describe("the moved matcher keeps its semantics", () => {
  it("family, saved choice and default behave as before", () => {
    expect(localModelFamily("claude-sonnet-5")).toBe("sonnet")
    expect(localModelFamily("gemini-2.5-flash")).toBeNull()
    expect(
      offeredLocalModelFor("claude-sonnet-5", m("claude-haiku-4-5", "claude-sonnet-5-1")),
    ).toBe("claude-sonnet-5-1")
    expect(offeredLocalModelFor("claude-haiku-4-5", m("claude-haiku-4-5-20251001"))).toBe(
      "claude-haiku-4-5-20251001",
    )
    expect(defaultLocalModel(m("claude-opus-5-5", "claude-haiku-4-5-20251001"))).toBe(
      "claude-haiku-4-5-20251001",
    )
    expect(defaultLocalModel([])).toBe(DESKTOP_DEFAULT_LOCAL_MODEL)
  })
})

describe("explicit model resolution (D45, L18)", () => {
  const offered = m("claude-haiku-4-5-20251001", "claude-sonnet-5-1", "claude-opus-5-5")

  it("an exact id and a dated alias resolve", () => {
    expect(exactOfferedModel("claude-opus-5-5", offered)).toBe("claude-opus-5-5")
    expect(exactOfferedModel("claude-haiku-4-5", offered)).toBe("claude-haiku-4-5-20251001")
    expect(resolveNodeModel({ requested: "claude-opus-5-5", offered })).toEqual({
      ok: true,
      model: "claude-opus-5-5",
    })
    expect(resolveNodeModel({ requested: "claude-haiku-4-5", offered })).toEqual({
      ok: true,
      model: "claude-haiku-4-5-20251001",
    })
  })

  it("an unknown requested model is refused with the offered list", () => {
    expect(resolveNodeModel({ requested: "gpt-9", offered })).toEqual({
      ok: false,
      reason: "model_unavailable",
      offered: ["claude-haiku-4-5-20251001", "claude-sonnet-5-1", "claude-opus-5-5"],
    })
  })

  it("claude-opus-9 with claude-opus-5-5 offered is refused (K2)", () => {
    expect(exactOfferedModel("claude-opus-9", offered)).toBeNull()
    expect(resolveNodeModel({ requested: "claude-opus-9", offered }).ok).toBe(false)
    // A requested id never takes the family fallback.
    expect(resolveNodeModel({ requested: "claude-sonnet-5", offered }).ok).toBe(false)
  })

  it("an agent preference claude-sonnet-5 with only claude-sonnet-5-1 offered runs on claude-sonnet-5-1", () => {
    expect(resolveNodeModel({ agentPreference: "claude-sonnet-5", offered })).toEqual({
      ok: true,
      model: "claude-sonnet-5-1",
    })
  })

  it("omitted uses the agent's model when offered", () => {
    expect(resolveNodeModel({ agentPreference: "claude-opus-5-5", offered })).toEqual({
      ok: true,
      model: "claude-opus-5-5",
    })
  })

  it("an agent preference that is a Gemini id falls to the node default", () => {
    expect(resolveNodeModel({ agentPreference: "gemini-2.5-flash-lite", offered })).toEqual({
      ok: true,
      model: "claude-haiku-4-5-20251001",
    })
    expect(resolveNodeModel({ offered })).toEqual({ ok: true, model: "claude-haiku-4-5-20251001" })
  })

  it("requested is never replaced by the default", () => {
    const r = resolveNodeModel({
      requested: "claude-fable-5",
      agentPreference: "claude-opus-5-5",
      offered,
    })
    expect(r.ok).toBe(false)
  })

  it("nothing offered refuses with an empty list", () => {
    expect(resolveNodeModel({ agentPreference: "claude-opus-5-5", offered: [] })).toEqual({
      ok: false,
      reason: "model_unavailable",
      offered: [],
    })
  })
})

// 2026-10-15: a node offered every pinned version its SDK lists (twelve on
// the owner's Mac, SDK 0.3.296) and an agent picked claude-opus-4-6. Only the
// current model of each family is offered, read from the ids, no list.
describe("only each family's current model is offered", () => {
  // The explicit ids `supportedModels()` answered on SDK 0.3.296, aliases
  // resolved, in its order.
  const SDK_0_3_296 = m(
    "claude-opus-5-5",
    "claude-fable-5-1",
    "claude-sonnet-5-5",
    "claude-haiku-5-5",
    "claude-haiku-4-5-20251001",
    "claude-sonnet-5",
    "claude-opus-5",
    "claude-fable-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-sonnet-4-6",
  )

  it("keeps one model per family, the highest version, in the SDK's order", () => {
    expect(currentNodeModels(SDK_0_3_296).map((model) => model.id)).toEqual([
      "claude-opus-5-5",
      "claude-fable-5-1",
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
    ])
  })

  it("follows a newer SDK with no change: a newer version or a new family is offered", () => {
    const newer = m("claude-opus-6", ...SDK_0_3_296.map((model) => model.id), "claude-lyric-1-2")
    expect(currentNodeModels(newer).map((model) => model.id)).toEqual([
      "claude-opus-6",
      "claude-fable-5-1",
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
      "claude-lyric-1-2",
    ])
  })

  it("reads a date as a snapshot, never a version, and keeps unknown shapes", () => {
    expect(parseClaudeModelId("claude-haiku-4-5-20251001")).toEqual({
      family: "haiku",
      major: 4,
      minor: 5,
    })
    expect(parseClaudeModelId("claude-fable-5-1[1m]")).toEqual({
      family: "fable",
      major: 5,
      minor: 1,
    })
    expect(
      currentNodeModels(m("claude-haiku-4-5-20251001", "claude-haiku-4")).map((x) => x.id),
    ).toEqual(["claude-haiku-4-5-20251001"])
    expect(currentNodeModels(m("gemini-2.5-flash", "claude-opus-5")).map((x) => x.id)).toEqual([
      "gemini-2.5-flash",
      "claude-opus-5",
    ])
  })

  // Review of #63: only the OFFER is narrowed. A session that names an older
  // version the SDK still runs (a retry, a routine, a dispatch) starts as
  // named, at creation and at claim alike, which both resolve here.
  it("a requested or preferred older version runs as named; nothing chosen runs a current one", () => {
    expect(resolveNodeModel({ requested: "claude-opus-4-6", offered: SDK_0_3_296 })).toEqual({
      ok: true,
      model: "claude-opus-4-6",
    })
    expect(resolveNodeModel({ agentPreference: "claude-sonnet-5", offered: SDK_0_3_296 })).toEqual({
      ok: true,
      model: "claude-sonnet-5",
    })
    // A saved preference the SDK dropped falls to its family's CURRENT model.
    expect(resolveNodeModel({ agentPreference: "claude-opus-4-1", offered: SDK_0_3_296 })).toEqual({
      ok: true,
      model: "claude-opus-5-5",
    })
    // The default is current: never the dated Haiku 4.5 the SDK still lists.
    expect(resolveNodeModel({ offered: SDK_0_3_296 })).toEqual({
      ok: true,
      model: "claude-haiku-5-5",
    })
    // A refusal names only what is offered.
    expect(resolveNodeModel({ requested: "claude-opus-9", offered: SDK_0_3_296 })).toEqual({
      ok: false,
      reason: "model_unavailable",
      offered: ["claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5", "claude-haiku-5-5"],
    })
  })
})
