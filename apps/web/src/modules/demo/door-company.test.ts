// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The door describes the seeded company in words, and the web bundle cannot
// import the seed. So every fact it states is pinned here to the seed itself:
// the company, its dealers, the people its picks name and its desk agents.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import en from "../../../../../packages/shared/src/i18n/locales/en/kernel.json"
import fr from "../../../../../packages/shared/src/i18n/locales/fr/kernel.json"
import {
  DEMO_COMPANY,
  DEMO_DEALERS,
  DEMO_ROLE_AGENTS,
  DEMO_TEAM,
} from "../../../../api/src/seed/world/fiction"
import { SAAS_COMPANY, SAAS_PLANS, SAAS_TEAM } from "../../../../api/src/seed/worlds/saas/fiction"
import { STUDIO_COMPANY, STUDIO_TEAM } from "../../../../api/src/seed/worlds/studio/fiction"
import { DEMO_COMPANY_NAME, DEMO_DOOR, doorCompanyOf } from "./door-company"

const copy = en.demo

describe("the company page states the seed's facts", () => {
  it("names the seeded company, its city and its headcount", () => {
    expect(DEMO_COMPANY_NAME).toBe(DEMO_COMPANY.name)
    expect(copy.companyAbout.startsWith(DEMO_COMPANY.name)).toBe(true)
    expect(copy.companyFacts).toBe(
      `Fictional company · ${DEMO_COMPANY.city} · ${DEMO_TEAM.length} people`,
    )
  })

  it("calls the company an example, by its seeded name", () => {
    expect(copy.companyExample).toContain(DEMO_COMPANY.name)
    expect(fr.demo.companyExample).toContain(DEMO_COMPANY.name)
  })

  it("counts the dealers and the territories they cover", () => {
    expect(DEMO_DEALERS).toHaveLength(6)
    expect(copy.companyAbout).toContain("six dealers in Europe, North America and Japan")
    const countries = new Set(DEMO_DEALERS.map((d) => d.country))
    expect(countries.has("US") && countries.has("JP")).toBe(true)
  })

  it("names the desk agents the seed creates", () => {
    const desks = DEMO_ROLE_AGENTS.map((a) => a.displayName)
    for (const desk of ["Support Desk", "Operations Desk", "Finance Desk"]) {
      expect(desks).toContain(desk)
    }
    expect(copy.pickMoment.commerce).toContain("the Operations Desk")
  })
})

describe("the software company's page states its pack's facts", () => {
  const saas = en.demo.world.saas

  it("names the pack's company, its city and its headcount", () => {
    expect(DEMO_DOOR.saas.name).toBe(SAAS_COMPANY.name)
    expect(saas.companyExample).toContain(SAAS_COMPANY.name)
    expect(fr.demo.world.saas.companyExample).toContain(SAAS_COMPANY.name)
    expect(saas.companyFacts).toBe(
      `Fictional company · ${SAAS_COMPANY.city} · ${SAAS_TEAM.length + 1} people`,
    )
  })

  it("gives the plan price range and the paying count of the pack", () => {
    const monthly = Object.values(SAAS_PLANS).map((plan) => plan.monthlyMinor / 100)
    const euros = (n: number) => `€${n.toLocaleString("en-US")}`
    expect(saas.companyAbout).toContain(
      `from ${euros(Math.min(...monthly))} to ${euros(Math.max(...monthly))} a month`,
    )
    // The pack's plan module reads through the api's path aliases, which this
    // bundle's test runner does not resolve: its source is read for the count.
    const planSource = readFileSync(
      join(process.cwd(), "../api/src/seed/worlds/saas/plan.ts"),
      "utf8",
    )
    const paying = Number(/\bpaying: (\d+)/.exec(planSource)?.[1])
    expect(paying).toBeGreaterThan(0)
    expect(saas.companyAbout).toContain(`${paying} customers pay by card`)
  })

  it("reads as products for any other world", () => {
    expect(doorCompanyOf("saas")).toBe(DEMO_DOOR.saas)
    expect(doorCompanyOf("studio")).toBe(DEMO_DOOR.studio)
    expect(doorCompanyOf("unknown")).toBe(DEMO_DOOR.products)
    expect(doorCompanyOf(null)).toBe(DEMO_DOOR.products)
  })
})

describe("the services door matches its pack's people and counts", () => {
  const studio = en.demo.world.studio

  it("names the pack's company, its city and its headcount, the visitor's seat included", () => {
    expect(DEMO_DOOR.studio.name).toBe(STUDIO_COMPANY.name)
    expect(DEMO_DOOR.studio.initials).toBe("HS")
    expect(studio.companyExample).toContain(STUDIO_COMPANY.name)
    expect(fr.demo.world.studio.companyExample).toContain(STUDIO_COMPANY.name)
    expect(studio.companyAbout.startsWith(STUDIO_COMPANY.name)).toBe(true)
    expect(studio.companyFacts).toBe(
      `Fictional company · ${STUDIO_COMPANY.city} · ${STUDIO_TEAM.length + 1} people`,
    )
    expect(fr.demo.world.studio.companyFacts).toContain(String(STUDIO_TEAM.length + 1))
  })

  it("says the visitor takes a co-founder's seat, not the products company's CEO", () => {
    expect(studio.companyYou).toContain("co-founder")
    expect(studio.companyYou).not.toContain("CEO")
  })

  it("bills in the three ways the pack's agreements do", () => {
    const source = readFileSync(
      join(process.cwd(), "../api/src/seed/worlds/studio/agreements.ts"),
      "utf8",
    )
    for (const mode of ["fixed", "retainer", "tm"]) {
      expect(source, mode).toContain(`pricingMode: "${mode}"`)
    }
    expect(studio.companyAbout).toContain("by the hour or the day")
    expect(studio.companyAbout).toContain("fixed price with milestones")
    expect(studio.companyAbout).toContain("monthly retainer")
  })

  it("names no other world's company", () => {
    const all = JSON.stringify([studio, fr.demo.world.studio])
    for (const other of [DEMO_COMPANY_NAME, DEMO_DOOR.saas.name, "Kestrel", "Stripe", "Shopify"]) {
      expect(all).not.toContain(other)
    }
  })
})

describe("each pick's moment names people of its own pack", () => {
  const firstNames = (team: readonly { name: string }[]) =>
    new Set(team.map((p) => p.name.split(" ")[0]))
  const named = (moments: Record<string, string>) =>
    Object.values(moments).flatMap((line) =>
      [...line.matchAll(/\b([A-ZÉ][a-zé]+)'s\b/g)].map((m) => m[1]),
    )

  it("every possessive name in a moment is a seeded teammate of that world", () => {
    const cases = [
      [copy.pickMoment, firstNames(DEMO_TEAM)],
      [en.demo.world.saas.pickMoment, firstNames(SAAS_TEAM)],
      [en.demo.world.studio.pickMoment, firstNames(STUDIO_TEAM)],
    ] as const
    for (const [moments, team] of cases) {
      const names = named(moments)
      for (const name of names) expect(team.has(name), name).toBe(true)
    }
    expect(named(copy.pickMoment)).toContain("Tobias")
    expect(firstNames(DEMO_TEAM).has("Lucas")).toBe(true)
    expect(firstNames(SAAS_TEAM).has("Clémence")).toBe(true)
    expect(firstNames(STUDIO_TEAM).has("Mathis")).toBe(true)
  })
})
