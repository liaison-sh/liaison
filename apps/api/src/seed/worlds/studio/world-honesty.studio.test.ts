// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The services world's copy holds no literal of another world: the tour copy a
// visitor reads in every language, its door strings, and the limits panel. Its
// seeded rows are checked where the world is seeded once for its snapshot
// (`seed/tiers/demo/seed-snapshot.integration.test.ts`), and its pack, brief
// and door in `literals.test.ts`. A planted literal is found.
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { foreignLiterals, WORLD_LITERALS } from "../literals"

const LOCALES = path.join(import.meta.dir, "../../../../../../packages/shared/src/i18n/locales")

function locales(): string[] {
  return readdirSync(LOCALES, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
}

function read(locale: string, ns: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(LOCALES, locale, `${ns}.json`), "utf8")) as Record<
    string,
    unknown
  >
}

/** The services world's served copy in one language: its tours, door and the limits panel. */
function studioCopy(locale: string): Record<string, string> {
  const tours = (read(locale, "tours").scenarios ?? {}) as Record<string, unknown>
  const demo = ((read(locale, "kernel").demo ?? {}) as Record<string, unknown>) ?? {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(tours))
    if (key.startsWith("studio")) out[`tours.${key}`] = JSON.stringify(value)
  out.door = JSON.stringify((demo.world as Record<string, unknown> | undefined)?.studio ?? {})
  for (const [key, value] of Object.entries(demo))
    if (key.startsWith("limit")) out[`limits.${key}`] = JSON.stringify(value)
  return out
}

describe("the services world's copy", () => {
  it("the services world's tour copy, door and limits hold no literal of another world, in every language", () => {
    expect(locales().length).toBeGreaterThan(1)
    for (const locale of locales()) {
      const copy = studioCopy(locale)
      expect(Object.keys(copy).filter((k) => k.startsWith("tours.")).length).toBeGreaterThan(5)
      const hits = Object.entries(copy).flatMap(([where, text]) =>
        foreignLiterals("studio", text).map((h) => `${locale} ${where}: ${h}`),
      )
      expect(hits).toEqual([])
    }
  })

  it("a literal of another world planted in the tour copy is found", () => {
    const copy = studioCopy("en")
    const tour = Object.keys(copy).find((k) => k.startsWith("tours.")) ?? ""
    const planted = `${copy[tour]} ${(WORLD_LITERALS.products ?? [])[0]}`
    expect(foreignLiterals("studio", planted)).toHaveLength(1)
  })
})
