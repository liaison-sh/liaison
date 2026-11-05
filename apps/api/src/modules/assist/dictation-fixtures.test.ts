// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The committed dictation fixture set (S4, S5): the manifest parses, every
// clip it names is a real WebM file within the size budget, each language has
// at least ten real clips (the bake-off's floor), every real clip carries an
// open licence and its attribution, and the Playwright fake-microphone WAV is
// the 16 kHz mono PCM Chromium reads.
import { describe, expect, it } from "bun:test"
import { existsSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { dictationManifestSchema, HESITATION_TOKENS, normalizeWords } from "./dictation-scorer"

const DIR = path.join(import.meta.dir, "__fixtures__", "dictation")
const manifest = dictationManifestSchema.parse(
  JSON.parse(readFileSync(path.join(DIR, "clips.json"), "utf8")),
)
const WAV = path.join(import.meta.dir, "../../../../web/src/tests/e2e/fixtures/dictation-en.wav")

describe("dictation fixtures", () => {
  it("has unique ids, one file per clip", () => {
    const ids = manifest.clips.map((clip) => clip.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const clip of manifest.clips) expect(clip.file).toBe(`${clip.id}.webm`)
  })

  it("stores every clip as WebM no larger than 300 KB", () => {
    for (const clip of manifest.clips) {
      const file = path.join(DIR, clip.file)
      expect(existsSync(file), clip.file).toBe(true)
      expect(statSync(file).size, clip.file).toBeLessThanOrEqual(300 * 1024)
      // EBML magic: the WebM container, not a renamed wav or mp3.
      expect([...readFileSync(file).subarray(0, 4)], clip.file).toEqual([0x1a, 0x45, 0xdf, 0xa3])
    }
  })

  it("has at least ten real clips per language, and four synthetic ones", () => {
    for (const lang of ["en", "fr"] as const) {
      const clips = manifest.clips.filter((clip) => clip.lang === lang)
      expect(clips.filter((clip) => !clip.synthetic).length).toBeGreaterThanOrEqual(10)
      expect(clips.filter((clip) => clip.synthetic).length).toBeGreaterThanOrEqual(4)
    }
  })

  it("licenses real clips openly and generated ones as generated", () => {
    for (const clip of manifest.clips) {
      if (clip.synthetic) {
        expect(clip.licence).toBe("generated")
      } else {
        expect(["CC-BY-4.0", "CC0-1.0"]).toContain(clip.licence)
        expect(clip.attribution.length).toBeGreaterThan(40)
      }
    }
  })

  it("annotates fillers and must-keep terms that the reference actually contains", () => {
    // An annotation absent from its own reference could never be scored. A
    // repetition split by a hesitation ("so um so") counts: once the "um" is
    // gone the clean-up must not leave "so so".
    for (const clip of manifest.clips) {
      const words = normalizeWords(clip.reference)
      const reference = ` ${words.join(" ")} `
      const fluent = ` ${words.filter((w) => !HESITATION_TOKENS.has(w)).join(" ")} `
      for (const filler of clip.fillers) {
        const needle = ` ${normalizeWords(filler).join(" ")} `
        expect(
          reference.includes(needle) || fluent.includes(needle),
          `${clip.id} filler "${filler}"`,
        ).toBe(true)
      }
      for (const term of clip.mustKeep) {
        const spellings = typeof term === "string" ? [term] : term
        expect(
          spellings.some((s) => reference.includes(` ${normalizeWords(s).join(" ")} `)),
          `${clip.id} must-keep "${spellings[0]}"`,
        ).toBe(true)
      }
    }
  })

  it("ships the fake-microphone WAV as 16 kHz mono 16-bit PCM", () => {
    const wav = readFileSync(WAV)
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF")
    expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE")
    expect(wav.readUInt16LE(20)).toBe(1) // PCM
    expect(wav.readUInt16LE(22)).toBe(1) // mono
    expect(wav.readUInt32LE(24)).toBe(16_000)
    expect(wav.readUInt16LE(34)).toBe(16)
    expect(wav.length).toBeLessThanOrEqual(400 * 1024)
  })
})
