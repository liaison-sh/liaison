// SPDX-License-Identifier: FSL-1.1-ALv2
//
// summarizePause / summarizeGooglePause produce a SummaryCard echoing the ids +
// reason the approver needs to see for a gated pause. Mirrors lab/summarizers.test.ts.

import { describe, expect, it } from "bun:test"
import { summarizePause, summarizeGooglePause } from "./summarizers"

describe("summarizePause", () => {
  it("single object: title counts 1, lines echo the id + reason + delivery note", () => {
    const card = summarizePause({ object_id: "camp_1", reason: "low-roas" })
    expect(card.kind).toBe("pause")
    expect(card.title).toBe("Pause 1 Meta object(s)")
    expect(card.subtitle).toBe("camp_1")
    const joined = card.lines.join(" | ")
    expect(joined).toContain("camp_1")
    expect(joined).toContain("low-roas")
    expect(joined).toContain("stops delivery immediately on approval")
    expect(joined).toContain("learning-phase")
  })

  it("bulk object_ids[]: title counts N and every id appears on its own line", () => {
    const card = summarizePause({ object_ids: ["camp_A", "camp_B", "adset_C"], reason: "stockout" })
    expect(card.title).toBe("Pause 3 Meta object(s)")
    expect(card.subtitle).toBe("camp_A, camp_B, adset_C")
    for (const id of ["camp_A", "camp_B", "adset_C"]) {
      expect(card.lines.some((l) => l.includes(id))).toBe(true)
    }
  })

  it("defaults the reason to agent-paused when omitted", () => {
    const card = summarizePause({ object_id: "adset_9" })
    expect(card.lines.join(" | ")).toContain("agent-paused")
  })
})

describe("summarizeGooglePause", () => {
  it("echoes object_type + object_id + reason + delivery note", () => {
    const card = summarizeGooglePause({ object_id: "111", object_type: "campaign", reason: "low-roas" })
    expect(card.kind).toBe("google_pause")
    expect(card.title).toBe("Pause 1 Google object(s)")
    expect(card.subtitle).toBe("campaign 111")
    const joined = card.lines.join(" | ")
    expect(joined).toContain("111")
    expect(joined).toContain("campaign")
    expect(joined).toContain("low-roas")
    expect(joined).toContain("stops delivery immediately on approval")
  })

  it("composes the ad object id from ad_group_id + ad_id when object_id is absent", () => {
    const card = summarizeGooglePause({ object_type: "ad", ad_group_id: "20", ad_id: "333" })
    expect(card.subtitle).toBe("ad 20~333")
    expect(card.lines.join(" | ")).toContain("20~333")
  })
})
