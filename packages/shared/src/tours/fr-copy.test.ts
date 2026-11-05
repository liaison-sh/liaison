// SPDX-License-Identifier: FSL-1.1-ALv2
// The French tour copy reads as French: one register ("vous"), a visit is
// feminine, no calques of the English ("play", "looks like" dropped).
import { describe, expect, it } from "bun:test"
import fr from "../i18n/locales/fr/tours.json"

function strings(node: unknown, path = ""): Array<[string, string]> {
  if (typeof node === "string") return [[path, node]]
  if (node && typeof node === "object")
    return Object.entries(node).flatMap(([k, v]) => strings(v, path ? `${path}.${k}` : k))
  return []
}

const all = strings(fr)

describe("French tour copy", () => {
  it("addresses the person as vous, never tu", () => {
    // Word edges by letter class: \b is ASCII-only and splits "boîtes" at the î.
    const tu =
      /(?<!\p{L})(Fais|Écris|Ouvre|Clique|Appuie|Réessaie|Choisis|tu|toi|ton|ta|tes)(?!\p{L})/u
    expect(all.filter(([, s]) => tu.test(s)).map(([p]) => p)).toEqual([])
    expect(fr.engine.doItForMe).toBe("Faites-le pour moi")
  })

  it("agrees with la visite and never calques 'play'", () => {
    expect(fr.engine.completed).not.toMatch(/terminé(?!e)/)
    // "lecture" is right for an API read, not for a tour playing on.
    expect(fr.engine.stopPlaying).not.toContain("lecture")
    expect(
      all.filter(([, s]) => /(?<!\p{L})(joue|jouer|Jouer)(?!\p{L})/u.test(s)).map(([p]) => p),
    ).toEqual([])
  })

  it("puts no comma before ou, and keeps the English hedges", () => {
    expect(all.filter(([, s]) => /, ou /.test(s)).map(([p]) => p)).toEqual([])
    expect(fr.tickets.basics.note.text).toContain("ce que nous savons déjà")
    expect(fr.kernel.threads.post.text).toContain("je découvre Liaison")
    expect(fr.kernel.sample.postMessage.text).not.toContain("de la part de la visite")
  })
})
