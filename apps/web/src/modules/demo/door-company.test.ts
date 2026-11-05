// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The door describes the seeded company in words, and the web bundle cannot
// import the seed. So every fact it states is pinned here to the seed itself:
// the company, its price range, its dealers, its people and its desk agents.
import { describe, expect, it } from "vitest"
import en from "../../../../../packages/shared/src/i18n/locales/en/kernel.json"
import fr from "../../../../../packages/shared/src/i18n/locales/fr/kernel.json"
import {
  DEMO_CATALOG,
  DEMO_COMPANY,
  DEMO_DEALERS,
  DEMO_ROLE_AGENTS,
  DEMO_TEAM,
} from "../../../../api/src/seed/world/fiction"
import { DEMO_COMPANY_NAME, DEMO_DOOR_TEAM } from "./door-company"

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

  it("gives the flagship price range of the catalog", () => {
    const flagships = DEMO_CATALOG.filter((sku) => sku.tier === "flagship").map(
      (sku) => sku.priceMinor / 100,
    )
    const euros = (n: number) => `€${n.toLocaleString("en-US")}`
    expect(copy.companyAbout).toContain(
      `from ${euros(Math.min(...flagships))} to ${euros(Math.max(...flagships))}`,
    )
    expect(copy.companyAbout).toContain("the Kestrel line")
    expect(
      DEMO_CATALOG.filter((sku) => sku.tier === "flagship").every((sku) =>
        sku.title.startsWith("Kestrel"),
      ),
    ).toBe(true)
  })

  it("counts the dealers and the territories they cover", () => {
    expect(DEMO_DEALERS).toHaveLength(6)
    expect(copy.companyAbout).toContain("six dealers in Europe, North America and Japan")
    const countries = new Set(DEMO_DEALERS.map((d) => d.country))
    expect(countries.has("US") && countries.has("JP")).toBe(true)
  })

  it("lists every seeded teammate but the founder, with a title taken from theirs", () => {
    const seeded = DEMO_TEAM.filter((p) => p.role !== "founder_admin")
    expect(DEMO_DOOR_TEAM.map((p) => [p.key, p.name])).toEqual(seeded.map((p) => [p.key, p.name]))
    const roles: Record<string, string> = copy.teamRole
    for (const person of seeded) {
      const short = roles[person.key]
      expect(short, person.key).toBeTruthy()
      expect(person.jobTitle, person.key).toContain(short)
    }
  })

  it("names the desk agents the seed creates", () => {
    const desks = DEMO_ROLE_AGENTS.map((a) => a.displayName)
    for (const desk of ["Support Desk", "Operations Desk", "Finance Desk"]) {
      expect(desks).toContain(desk)
    }
    expect(copy.companyOps.support.body).toContain("The Support Desk agent")
    expect(copy.companyOps.orders.body).toContain("The Operations Desk agent")
    expect(copy.companyOps.invoicing.body).toContain("The Finance Desk agent")
  })
})
