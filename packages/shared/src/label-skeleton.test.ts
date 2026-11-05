// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { labelSkeleton } from "./label-skeleton"

describe("labelSkeleton", () => {
  it.each([
    ["case and spacing", "App store", "APP_STORE"],
    ["punctuation", "Settings", "Settings!"],
    ["Cyrillic look-alikes", "Settings", "\u0405\u0435ttings"],
    ["Greek look-alikes", "Home", "\u0397\u03bfme"],
    ["full-width letters", "Security", "\uff33\uff45\uff43\uff55\uff52\uff49\uff54\uff59"],
    ["zero-width characters", "Settings", "Set\u200bti\u200dngs"],
    ["accents", "Security", "S\u00e9curit\u00ff"],
    ["digit look-alikes", "Roles", "R01es"],
    ["rn for m", "Home", "Horne"],
    ["i, l, 1 and | as one", "Liaison", "L1a|son"],
    ["uppercase I for l", "Liaison", "LIAISON"],
  ])("folds %s", (_label, a, b) => {
    expect(labelSkeleton(b)).toBe(labelSkeleton(a))
  })

  it("keeps different words apart", () => {
    expect(labelSkeleton("Settings")).not.toBe(labelSkeleton("Setting"))
    expect(labelSkeleton("Metrics")).not.toBe(labelSkeleton("Home"))
    expect(labelSkeleton("KPI")).not.toBe(labelSkeleton("Users"))
  })
})
