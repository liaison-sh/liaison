// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The owner's Morning brief, computed from the plan: at the board date it
// reads the board's figures, and at any anchor of a year it holds no relative
// day word and no literal date or year.
import { describe, expect, it } from "bun:test"
import { scanPackProse } from "~/seed/worlds/prose-guard"
import { foreignLiterals } from "../literals"
import { studioMorningBrief } from "./brief"

const BOARD_DATE = new Date("2026-11-09T08:30:00Z")

describe("services world morning brief", () => {
  it("at the board date it reads the board's figures, every one summed from the seeded rows", () => {
    expect(studioMorningBrief(BOARD_DATE)).toBe(
      [
        "Partner portal rebuild: Beta is due 14 Nov, 80% done, time spent 346 h of 420 h planned.",
        "Éditions Sorel has used 18 h of 40 h for November.",
        "Next week has 336 h planned of 350 h available.",
        'Coopérative Alpine\'s October on Stock and supplier data is ready for planned vs done, and Jean Tessier still has the agreement "Carrier booking and tracking system" to sign.',
        "Sources: Projects, Invoicing, Agreements.",
      ].join("\n\n"),
    )
  })

  it("the brief holds no relative day word and no date literal", () => {
    for (let w = 0; w < 56; w++) {
      const anchor = new Date(BOARD_DATE.getTime() + w * 7 * 86_400_000)
      const brief = studioMorningBrief(anchor)
      // A date enters only through the story clock's formatter, computed from the anchor.
      const hits = scanPackProse({ brief }).filter((h) => h.kind !== "date")
      expect(hits).toEqual([])
      expect(foreignLiterals("studio", brief)).toEqual([])
    }
  })
})
