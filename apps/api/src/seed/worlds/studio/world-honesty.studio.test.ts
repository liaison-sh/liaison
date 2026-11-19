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
import { type ClaimKind, claimHits, scanWorldPackClaims } from "../prose-guard"
import { studioAgreements } from "./agreements"
import { studioPlan } from "./plan"

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
  const demo = (read(locale, "kernel").demo ?? {}) as Record<string, unknown>
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

  it("the products world's suppliers are its literals: a purchase order to one is found", () => {
    for (const supplier of ["Nordkrets Assembly AB", "Cartonnerie du Rhone SAS"])
      expect(foreignLiterals("studio", `Purchase order to ${supplier}`)).toEqual([
        `products: ${supplier}`,
      ])
  })

  it("a literal of another world planted in the tour copy is found", () => {
    const copy = studioCopy("en")
    const tour = Object.keys(copy).find((k) => k.startsWith("tours.")) ?? ""
    const planted = `${copy[tour]} ${(WORLD_LITERALS.products ?? [])[0]}`
    expect(foreignLiterals("studio", planted)).toHaveLength(1)
  })
})

describe("the services world makes no legal or market claim", () => {
  it("its pack, tour copy, door and limits promise no compliance, cite no outside statistic and compare with no named product, in every language", async () => {
    expect(await scanWorldPackClaims(import.meta.dir)).toEqual([])
    for (const locale of locales()) {
      const hits = Object.entries(studioCopy(locale)).flatMap(([where, text]) =>
        claimHits(text).map((h) => `${locale} ${where}: ${h.kind} ${h.match}`),
      )
      expect(hits).toEqual([])
    }
  })

  it("a compliance promise, an outside statistic or a named product planted in the copy is found", () => {
    const copy = studioCopy("en").door ?? ""
    expect(claimHits(copy)).toEqual([])
    const planted: Record<ClaimKind, string> = {
      compliance: "Every signature is legally binding and GDPR-compliant.",
      statistic: "According to a survey, 73% of agencies lose a day a week.",
      comparison: "Faster than Jira for client work.",
    }
    for (const [kind, text] of Object.entries(planted)) {
      expect(claimHits(`${copy} ${text}`).map((h): string => h.kind)).toContain(kind)
    }
    expect(
      claimHits("Une étude dit que 40 % des agences perdent du temps, selon une étude.").map(
        (h) => h.kind,
      ),
    ).toEqual(["statistic"])
  })
})

describe("the services world's door says only what its rows hold", () => {
  it("it claims an agreement behind every piece of work only when every client project has one", () => {
    const anchor = new Date("2026-11-09T08:30:00.000Z")
    const withAgreement = new Set(
      studioAgreements(anchor)
        .agreements.map((a) => a.project)
        .filter(Boolean),
    )
    const without = studioPlan(anchor)
      .projects.filter((p) => p.client && !p.closedAt && p.key !== "SALES")
      .map((p) => p.key)
      .filter((k) => !withAgreement.has(k))
    for (const locale of locales()) {
      const door = studioCopy(locale).door ?? ""
      const claims =
        /every piece of work starts from a signed agreement|chaque travail part d'un contrat/i.test(
          door,
        )
      expect({ locale, claims, without: claims ? without : [] }).toEqual({
        locale,
        claims,
        without: [],
      })
    }
  })
})
