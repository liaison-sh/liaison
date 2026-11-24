// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Reach of the away tool, offline (no model). An agent holds `set_away` on every turn, so it needs
// no search for it; a surface that searches the whole catalog (an outside MCP client) finds it in
// the top five with what it types when someone says a colleague is off, now that company days off
// have their own tools whose names also say "off".

import { describe, expect, it } from "bun:test"
import { appNamesOf, rankForm } from "~/modules/agent/tools/tool-bench/bench"
import { loadBenchCatalog, searchableTools } from "~/modules/agent/tools/tool-bench/catalog"

const catalog = loadBenchCatalog()
/** What an agent's search ranks: the tools it does not already hold. */
const searchable = searchableTools(catalog)
/** What a search of the whole catalog ranks. */
const all = catalog.filter((t) => t.agentVisible)
const apps = appNamesOf(catalog)

const PERSON_OFF = [
  "Tobias is off week 48",
  "is off week 48",
  "off week 48",
  "off next week",
  "Elodie is off next week",
  "away",
  "set away",
  "out of office",
  "holiday",
  "next in line",
]

describe("away tool reach", () => {
  it("an agent holds the away tool on every turn, by its own declaration", () => {
    const away = catalog.find((t) => t.sdkName === "kernel__set_away")
    expect(away).toMatchObject({
      declaredDeferLoading: false,
      deferred: false,
      agentVisible: true,
      routineOnly: false,
    })
  })

  it("the off-next-week phrasings reach the away tool in the top five", () => {
    const missed = PERSON_OFF.filter(
      (form) => !rankForm(all, apps, form, ["kernel__set_away"]).top5,
    )
    expect(missed).toEqual([])
  })

  it("a week number said of a person ranks the away tool first, ahead of company days off", () => {
    for (const form of ["Tobias is off week 48", "off week 48", "off next week"]) {
      expect(rankForm(all, apps, form, ["kernel__set_away"]).top1).toBe(true)
    }
  })

  it("company day off phrasings reach the company tool", () => {
    for (const form of ["public holiday", "bank holiday", "company holiday", "fermeture"]) {
      expect(rankForm(searchable, apps, form, ["projects__days_off_set"]).top5).toBe(true)
    }
  })
})
