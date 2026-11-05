// SPDX-License-Identifier: FSL-1.1-ALv2
// @vitest-environment node
//
// Bundled apps colour their own items (a monitoring source) with the hue
// helper from @liaison/app-ui, since they cannot import the shell. That helper
// must stay the shell's formula, or a source and the app it names stop reading
// as one family. Imported by relative path: no new package dependency.
import { describe, expect, it } from "vitest"
import { hueGlyphColor, appHue as kitHue } from "../../../../../packages/app-ui/src/hue"
import { appHue, appIconColor } from "./app-color"

const SAMPLES = [
  "",
  "a",
  "monitoring",
  "tickets",
  "projects",
  "aws-security",
  "watchdog-prod",
  "business-probes",
  "backup-cron",
  "grafana/prod eu-west-3",
  "émoji ✓ source",
  "x".repeat(300),
]

describe("app-ui hue matches the shell app colour", () => {
  it("gives the same hue for every sample id", () => {
    for (const id of SAMPLES) expect([id, kitHue(id)]).toEqual([id, appHue(id)])
  })

  it("gives the same glyph colour", () => {
    for (const id of SAMPLES) expect(hueGlyphColor(kitHue(id))).toBe(appIconColor(id))
  })
})
