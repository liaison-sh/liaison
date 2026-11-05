// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The dictation scorer on hand-made strings: word error rate for the model
// bake-off (S4) and the clean-up checks (S5: no annotated filler left, every
// annotated must-keep term kept). The scorer is the oracle, so its cases are
// worked out by hand here, never from a model's output.
import { describe, expect, it } from "bun:test"
import {
  dominantLanguage,
  HESITATION_TOKENS,
  normalizeWords,
  percentile,
  scoreCleanup,
  wordErrorRate,
} from "./dictation-scorer"

describe("normalizeWords", () => {
  it("lowercases and strips punctuation", () => {
    expect(normalizeWords("Hello, World! It's done.")).toEqual(["hello", "world", "it's", "done"])
  })

  it("splits French elisions off their word, keeps accents, splits hyphenated words", () => {
    expect(normalizeWords("C'est l’Union européenne : s'oppose-t-il ?")).toEqual([
      "c'",
      "est",
      "l'",
      "union",
      "européenne",
      "s'",
      "oppose",
      "t",
      "il",
    ])
  })

  it("leaves English contractions whole", () => {
    expect(normalizeWords("It's what we're doing, don't you think")).toEqual([
      "it's",
      "what",
      "we're",
      "doing",
      "don't",
      "you",
      "think",
    ])
  })

  it("drops a leading or trailing apostrophe, so 'CAUSE and cause match", () => {
    expect(normalizeWords("'CAUSE UM")).toEqual(["cause", "um"])
  })

  it("keeps digits", () => {
    expect(normalizeWords("Le 15 décembre 2015, 400 milliards")).toEqual([
      "le",
      "15",
      "décembre",
      "2015",
      "400",
      "milliards",
    ])
  })
})

describe("wordErrorRate", () => {
  it("is zero for the same words whatever the case and punctuation", () => {
    expect(wordErrorRate("So I can have it.", "so, I can HAVE it").wer).toBe(0)
  })

  it("counts one substitution over four reference words", () => {
    const result = wordErrorRate("the cat sat down", "the dog sat down")
    expect(result.errors).toBe(1)
    expect(result.referenceWords).toBe(4)
    expect(result.wer).toBe(0.25)
  })

  it("counts deletions and insertions (standard Levenshtein over words)", () => {
    // ref: a b c d e ; hyp: a c d x e y -> delete b, insert x, insert y = 3
    expect(wordErrorRate("a b c d e", "a c d x e y").errors).toBe(3)
  })

  it("can ignore hesitation tokens on both sides, as ASR scoring does", () => {
    // The reference keeps the corpus's "um"/"euh"; a model that drops them
    // has not misheard a word.
    const reference = "so um I can have it uh now"
    expect(wordErrorRate(reference, "so I can have it now").errors).toBe(2)
    expect(
      wordErrorRate(reference, "so I can have it now", { ignore: HESITATION_TOKENS }).errors,
    ).toBe(0)
    expect(wordErrorRate("euh la commande", "la commande", { ignore: HESITATION_TOKENS }).wer).toBe(
      0,
    )
  })

  it("is one for an empty hypothesis", () => {
    expect(wordErrorRate("one two three", "").wer).toBe(1)
  })

  it("can exceed one when the hypothesis is much longer", () => {
    // ref: hi you ; hyp: hi there and you all -> 3 insertions over 2 words
    expect(wordErrorRate("hi you", "hi there and you all").wer).toBe(1.5)
  })
})

describe("scoreCleanup", () => {
  const fillers = ["um", "uh", "we we", "of the of the"]
  const mustKeep = ["pernilla", ["ten", "10"], "hash tables"] as const

  it("passes when every filler is gone and every must-keep term stays", () => {
    const score = scoreCleanup({
      raw: "Um, we we sent ten of the of the hash tables to Pernilla, uh.",
      cleaned: "We sent 10 of the hash tables to Pernilla.",
      fillers,
      mustKeep,
    })
    expect(score.fillersRemaining).toEqual([])
    expect(score.mustKeepMissing).toEqual([])
    expect(score.mustKeepDroppedByCleanup).toEqual([])
    expect(score.pass).toBe(true)
  })

  it("fails on a filler left in the cleaned text, single word or repetition", () => {
    const score = scoreCleanup({
      raw: "um we we sent ten hash tables to pernilla",
      cleaned: "Um, we we sent ten hash tables to Pernilla.",
      fillers,
      mustKeep,
    })
    expect(score.fillersRemaining).toEqual(["um", "we we"])
    expect(score.pass).toBe(false)
  })

  it("matches fillers as whole words, never inside another word", () => {
    // "drum" and "uhm"-less text: "um" is not a substring hit.
    const score = scoreCleanup({
      raw: "the drum has ten hash tables for pernilla",
      cleaned: "The drum has ten hash tables for Pernilla.",
      fillers,
      mustKeep,
    })
    expect(score.fillersRemaining).toEqual([])
  })

  it("fails when the clean-up drops a must-keep term the raw transcript had", () => {
    const score = scoreCleanup({
      raw: "um we sent ten hash tables to pernilla",
      cleaned: "We sent the tables to Pernilla.",
      fillers,
      mustKeep,
    })
    expect(score.mustKeepDroppedByCleanup).toEqual(["ten", "hash tables"])
    expect(score.mustKeepMissing).toEqual(["ten", "hash tables"])
    expect(score.pass).toBe(false)
  })

  it("accepts any listed spelling of a must-keep term", () => {
    const score = scoreCleanup({
      raw: "we sent 10 hash tables to pernilla",
      cleaned: "We sent 10 hash tables to Pernilla.",
      fillers,
      mustKeep,
    })
    expect(score.mustKeepMissing).toEqual([])
  })

  it("blames the transcription, not the clean-up, for a term the raw never had", () => {
    // The model misheard the name: the clean-up could not keep what it never got.
    const score = scoreCleanup({
      raw: "we sent ten hash tables to pernila",
      cleaned: "We sent ten hash tables to Pernila.",
      fillers,
      mustKeep,
    })
    expect(score.mustKeepMissing).toEqual(["pernilla"])
    expect(score.mustKeepDroppedByCleanup).toEqual([])
    expect(score.pass).toBe(true)
  })

  it("finds a must-keep term behind a French elision", () => {
    const score = scoreCleanup({
      raw: "sa soumission à l'OMC",
      cleaned: "Sa soumission à l'OMC.",
      fillers: [],
      mustKeep: ["omc"],
    })
    expect(score.mustKeepMissing).toEqual([])
  })

  it("scores French: euh and a false start removed, numbers kept", () => {
    const score = scoreCleanup({
      raw: "Euh, la la commande 2087 est partie, euh, mardi.",
      cleaned: "La commande 2087 est partie mardi.",
      fillers: ["euh", "la la"],
      mustKeep: [["2087", "deux mille quatre-vingt-sept"], "mardi"],
    })
    expect(score.pass).toBe(true)
  })
})

describe("dominantLanguage (S5: French stays French)", () => {
  it("reads French and English off their function words", () => {
    expect(dominantLanguage("Je pense que la commission doit agir pour les citoyens.")).toBe("fr")
    expect(dominantLanguage("C'est l'avis du groupe, et nous le soutenons.")).toBe("fr")
    expect(dominantLanguage("I think that the project is on track for the next release.")).toBe(
      "en",
    )
  })

  it("a French clip translated to English reads as English", () => {
    expect(dominantLanguage("The Commission must act for the citizens of the Union.")).toBe("en")
  })

  it("is null when the text carries no marker either way", () => {
    expect(dominantLanguage("Laura, 25, HTML")).toBeNull()
    expect(dominantLanguage("")).toBeNull()
  })
})

describe("percentile", () => {
  it("takes the nearest-rank percentile of the samples", () => {
    const samples = [5, 1, 4, 2, 3, 10, 9, 8, 7, 6]
    expect(percentile(samples, 50)).toBe(5)
    expect(percentile(samples, 95)).toBe(10)
    expect(percentile([3], 95)).toBe(3)
  })

  it("is null without samples", () => {
    expect(percentile([], 50)).toBeNull()
  })
})
