// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Honest words. What a signer, a client or a member reads about a signature says "simple
// electronic signature" and never claims more: no equivalence to a handwritten signature, no
// qualified level, no presumption, no "legally binding", no "eIDAS compliant", in English or in
// French. The one exception is a fixed negative sentence (one that says what the signature is
// not), listed below by its exact text. The agent reads the agreements tools' descriptions, so
// the same words are checked there.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..", "..", "..", "..", "..")
const LOCALES = join(ROOT, "packages", "shared", "src", "i18n", "locales")
const FILES = ["client-action", "agreement-evidence", "portal", "portal-auth"]
const LANGS = ["en", "fr"]

/** Words that claim more than a simple electronic signature, English and French forms. */
export const OVERCLAIMS: readonly RegExp[] = [
  /\bequivalent\b/i,
  /handwritten equivalent/i,
  /\bqualified\b/i,
  /legally binding/i,
  /\bpresum(?:e|ed|ption)\b/i,
  /eidas[- ]compliant/i,
  /[ée]quivalent(?:e|s|es)?\b/i,
  /\bqualifi[ée]e?s?\b/i,
  /juridiquement contraignant/i,
  /\bpr[ée]sum[ée]e?s?\b|\bpr[ée]somption\b/i,
  /conforme (?:[àa] )?(?:l['’])?eidas/i,
]

/** The fixed negative sentences that may name a level the signature is not, by exact text. */
export const FIXED_NEGATIVE_SENTENCES: ReadonlySet<string> = new Set<string>()

/** Every string of a locale file with its dotted key. */
function strings(value: unknown, key = ""): Array<[string, string]> {
  if (typeof value === "string") return [[key, value]]
  if (value && typeof value === "object")
    return Object.entries(value).flatMap(([k, v]) => strings(v, key ? `${key}.${k}` : k))
  return []
}

/** The sentences of a text that overclaim, minus the fixed negative ones. */
export function overclaims(text: string): string[] {
  const sentences = text.split(/(?<=[.!?])\s+/)
  return sentences.filter(
    (s) => !FIXED_NEGATIVE_SENTENCES.has(s.trim()) && OVERCLAIMS.some((re) => re.test(s)),
  )
}

const load = (lang: string, file: string): unknown =>
  JSON.parse(readFileSync(join(LOCALES, lang, `${file}.json`), "utf8"))

describe("honest words about the signature", () => {
  it("no agreements, client action or portal locale string claims more than a simple electronic signature", () => {
    const found: string[] = []
    for (const lang of LANGS)
      for (const file of FILES)
        for (const [key, text] of strings(load(lang, file)))
          for (const s of overclaims(text)) found.push(`${lang}/${file}:${key}: ${s}`)
    expect(found).toEqual([])
  })

  it("no agreements tool description or parameter claims more than a simple electronic signature", () => {
    const manifest = readFileSync(join(ROOT, "bundled-apps", "agreements", "app.manifest.json"))
    const found = strings(JSON.parse(manifest.toString()))
      .filter(([key]) => /(^|\.)description$/.test(key))
      .flatMap(([key, text]) => overclaims(text).map((s) => `${key}: ${s}`))
    expect(found).toEqual([])
  })

  it("catches each overclaim in English and French, and lets a fixed negative sentence through", () => {
    for (const text of [
      "It is the equivalent of a handwritten signature.",
      "A qualified signature.",
      "This is legally binding.",
      "The signature is presumed reliable.",
      "Fully eIDAS compliant.",
      "Elle a la valeur d'un équivalent manuscrit.",
      "Une signature qualifiée.",
      "Ce document est juridiquement contraignant.",
      "La fiabilité est présumée.",
      "Conforme à eIDAS.",
    ])
      expect(overclaims(text)).toEqual([text])
    expect(overclaims("You read the document and type your name.")).toEqual([])
  })

  it("the signing page names the level and says how it works, in both languages", () => {
    const en = load("en", "client-action") as { page: { levelLead: string; levelBody: string } }
    const fr = load("fr", "client-action") as { page: { levelLead: string; levelBody: string } }
    expect(`${en.page.levelLead} ${en.page.levelBody}`).toBe(
      "Simple electronic signature: you read the document, confirm with a code sent by email, and type your name. You get a copy and the proof.",
    )
    expect(fr.page.levelLead).toContain("Signature électronique simple")
    expect(fr.page.levelBody).toContain("code envoyé par e-mail")
    const sign = strings(en)
      .map(([, t]) => t)
      .join("\n")
    expect(sign.toLowerCase()).toContain("simple electronic signature")
  })
})
