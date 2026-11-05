// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The host half of the non-Latin fix (two reports from Quinn; confirmed on the
// issued document INV-2026-3456, which printed "Igor \u0141ukawski" as
// "Igor ?ukawski").
//
// The base-14 Helvetica pdf-lib embeds carries a WinAnsi encoding: asking it to
// draw U+0141 does not degrade, it THROWS. That is why the template stripped
// the character to "?" before drawing -- the alternative was a failed render.
// The Helvetica family is now served by an embedded Liberation Sans instead.
import { describe, expect, it } from "bun:test"
import type { DrawCommand } from "@liaison/shared"
import { PDFDocument, StandardFonts } from "pdf-lib"
import { replayDrawCommands } from "./replay"
import { faceBytes, needsCjkFace, splitByFace } from "./unicode-fonts"

const POLISH = "Igor \u0141ukawski"

type StandardFontName = Extract<DrawCommand, { op: "embedFont" }>["standardFont"]

const withText = (text: string, font: StandardFontName = "Helvetica"): DrawCommand[] => [
  { op: "embedFont", ref: "f1", standardFont: font },
  { op: "addPage", width: 595, height: 842 },
  { op: "drawText", page: 0, text, x: 40, y: 800, size: 11, font: "f1" },
]

describe("unicode text in the replayer", () => {
  it("renders a name the base-14 font could not encode", async () => {
    const bytes = await replayDrawCommands(withText(POLISH))
    const doc = await PDFDocument.load(bytes, { updateMetadata: false })
    expect(doc.getPageCount()).toBe(1)
  })

  it("proves the RED state: the standard font throws on the same character", async () => {
    // Without this the test above could pass for the wrong reason -- e.g. if
    // pdf-lib had silently substituted the glyph all along.
    const doc = await PDFDocument.create()
    const helv = await doc.embedFont(StandardFonts.Helvetica)
    const page = doc.addPage([595, 842])
    expect(() => page.drawText(POLISH, { x: 40, y: 800, size: 11, font: helv })).toThrow()
  })

  it("renders Greek, Cyrillic and Vietnamese without throwing", async () => {
    for (const s of [
      "\u0393\u03b9\u03ce\u03c1\u03b3\u03bf\u03c2",
      "\u0414\u043c\u0438\u0442\u0440\u0438\u0439",
      "Nguy\u1ec5n",
    ]) {
      const bytes = await replayDrawCommands(withText(s))
      expect(bytes.byteLength).toBeGreaterThan(0)
    }
  })

  it("subsets: a one-word page stays far smaller than the 400 KB face", async () => {
    // Embedding the full face in every invoice would be the obvious way to make
    // this work and the wrong one -- three faces is over a megabyte per PDF.
    const bytes = await replayDrawCommands(withText(POLISH))
    expect(faceBytes("regular").byteLength).toBeGreaterThan(300_000)
    expect(bytes.byteLength).toBeLessThan(100_000)
  })

  it("embeds one copy of a face even when a template asks for it repeatedly", async () => {
    // Templates embed Helvetica under three refs (regular/bold/oblique). Bold
    // and oblique are distinct faces; regular asked for twice must not be
    // embedded twice.
    const twice: DrawCommand[] = [
      { op: "embedFont", ref: "a", standardFont: "Helvetica" },
      { op: "embedFont", ref: "b", standardFont: "Helvetica" },
      { op: "addPage", width: 595, height: 842 },
      { op: "drawText", page: 0, text: POLISH, x: 40, y: 800, size: 11, font: "a" },
      { op: "drawText", page: 0, text: POLISH, x: 40, y: 780, size: 11, font: "b" },
    ]
    const once = await replayDrawCommands(withText(POLISH))
    const dup = await replayDrawCommands(twice)
    // A second embed of the same subset would roughly double the font bytes.
    expect(dup.byteLength).toBeLessThan(once.byteLength * 1.5)
  })

  it("still honours an explicit request for a serif or a monospace", async () => {
    // Only the Helvetica family is remapped. Widening Times to a sans to gain
    // charset coverage would silently change what the template asked for.
    for (const font of ["TimesRoman", "Courier"] as StandardFontName[]) {
      const bytes = await replayDrawCommands(withText("Plain ASCII", font))
      expect(bytes.byteLength).toBeGreaterThan(0)
    }
  })

  it("rejects an un-allowlisted font name as before", async () => {
    await expect(
      replayDrawCommands([
        { op: "embedFont", ref: "f", standardFont: "Comic Sans" } as unknown as DrawCommand,
        { op: "addPage", width: 595, height: 842 },
      ]),
    ).rejects.toThrow()
  })
})

describe("CJK fallback face", () => {
  // Prod carries 17 documents across 11 Japanese parties. Embedding a
  // Latin-only face fixed the European half of the reported bug and left those
  // invoices printing "????????" -- still broken, for a real customer.
  const COMPANY = "\u682a\u5f0f\u4f1a\u793e\u30a2\u30a4\u30b7\u30f3"
  const MIXED = `${COMPANY} YYSystem\u4e8b\u696d\u63a8\u9032\u90e8`

  it("renders a Japanese company name", async () => {
    const bytes = await replayDrawCommands(withText(COMPANY))
    expect(bytes.byteLength).toBeGreaterThan(0)
  })

  it("splits a mixed-script string into runs of one face each", () => {
    // A single drawText takes ONE font, and this is the shape real data comes
    // in: Japanese, a space, Latin, Japanese again.
    const runs = splitByFace(MIXED)
    expect(runs.length).toBeGreaterThan(1)
    expect(runs.map((r) => r.text).join("")).toBe(MIXED)
    expect(runs.some((r) => r.cjk)).toBe(true)
    expect(runs.some((r) => !r.cjk)).toBe(true)
  })

  it("leaves a pure-Latin string as ONE run, so nothing already working is re-laid-out", () => {
    const runs = splitByFace("FABRIKAM SAS -- Invoice INV-2026-3456")
    expect(runs).toHaveLength(1)
    expect(runs[0]!.cjk).toBe(false)
  })

  it("embeds the CJK face only when a document actually needs it", async () => {
    // It is a 4.5 MB face. Subsetting keeps the used glyphs small, but a
    // document with no CJK should not carry the face at all.
    const latin = await replayDrawCommands(withText("Plain ASCII invoice"))
    const japanese = await replayDrawCommands(withText(COMPANY))
    expect(japanese.byteLength).toBeGreaterThan(latin.byteLength)
  })

  it("keeps its coverage list in step with the template's allowlist", () => {
    // These two lists live in different repos-within-the-repo (host replayer vs
    // sandboxed template). A character the template lets through but the host
    // does not route to the fallback renders as a hollow box -- so drift here is
    // silent and visible only on the finished page.
    for (const ch of [...COMPANY, "\u3001", "\uff21", "\u4e00"]) {
      expect(needsCjkFace(ch)).toBe(true)
    }
    for (const ch of [..."Abc123", "\u0141", "\u00e9", "\u0414"]) {
      expect(needsCjkFace(ch)).toBe(false)
    }
  })
})
