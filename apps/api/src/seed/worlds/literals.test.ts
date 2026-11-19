// SPDX-License-Identifier: FSL-1.1-ALv2
//
// No world's text holds another world's literals: its pack (people, desks,
// support, knowledge, threads, named rows), the software world's brief, and
// the door strings a visitor reads for the world in every language. A planted
// literal of the other world is found.
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { findDemoWorldPack, seedableDemoWorlds } from "./index"
import { foreignLiterals, WORLD_LITERALS } from "./literals"
import { saasMorningBrief } from "./saas/brief"
import { studioMorningBrief } from "./studio/brief"

const LOCALES = path.join(import.meta.dir, "../../../../../packages/shared/src/i18n/locales")
const BOARD_DATE = new Date("2026-11-09T08:30:00Z")

/** A pack's data as text, functions left out. */
function packText(world: Parameters<typeof findDemoWorldPack>[0]): string {
  const pack = findDemoWorldPack(world)
  return JSON.stringify(pack, (_k, v) => (typeof v === "function" ? undefined : v))
}

describe("world literals", () => {
  it("each world has a list, and the lists do not share a name", () => {
    const products = WORLD_LITERALS.products ?? []
    const saas = WORLD_LITERALS.saas ?? []
    const studio = WORLD_LITERALS.studio ?? []
    expect(products.length).toBeGreaterThan(10)
    expect(saas.length).toBeGreaterThan(200)
    expect(studio.length).toBeGreaterThan(30)
    const shared = (a: readonly string[], b: readonly string[]) => a.filter((l) => b.includes(l))
    expect(shared(products, saas)).toEqual([])
    expect(shared(products, studio)).toEqual([])
    expect(shared(saas, studio)).toEqual([])
  })

  for (const world of seedableDemoWorlds()) {
    it(`the ${world} pack holds no other world's literal`, () => {
      expect(foreignLiterals(world, packText(world))).toEqual([])
    })
  }

  it("the software world's brief holds no other world's literal", () => {
    expect(foreignLiterals("saas", saasMorningBrief(BOARD_DATE))).toEqual([])
  })

  for (const world of ["saas", "studio"] as const) {
    it(`the door strings for the ${world} world hold no other world's literal, in every language`, () => {
      const locales = readdirSync(LOCALES, { withFileTypes: true }).filter((d) => d.isDirectory())
      expect(locales.length).toBeGreaterThan(1)
      for (const { name: locale } of locales) {
        const file = path.join(LOCALES, locale, "kernel.json")
        const kernel = JSON.parse(readFileSync(file, "utf8")) as {
          demo?: { world?: Record<string, unknown> }
        }
        const door = kernel.demo?.world?.[world]
        if (!door) continue
        expect({ locale, hits: foreignLiterals(world, JSON.stringify(door)) }).toEqual({
          locale,
          hits: [],
        })
      }
    })
  }

  it("the services world's brief holds no other world's literal", () => {
    expect(foreignLiterals("studio", studioMorningBrief(BOARD_DATE))).toEqual([])
  })

  it("a planted literal of the other world is found", () => {
    const planted = `${saasMorningBrief(BOARD_DATE)} ${(WORLD_LITERALS.products ?? [])[0]}`
    expect(foreignLiterals("saas", planted)).toHaveLength(1)
    const inStudio = `${studioMorningBrief(BOARD_DATE)} ${(WORLD_LITERALS.saas ?? [])[0]}`
    expect(foreignLiterals("studio", inStudio)).toHaveLength(1)
  })
})
