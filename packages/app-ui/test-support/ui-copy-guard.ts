// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The checks behind each bundled app's `src/ui/i18n.test.ts`: an app UI keys
// its copy by the English text through `tr()` and a French table, and two
// things rot that silently — a literal that bypasses `tr()`, and a `tr()`
// string with no French entry, which falls back to English. Each check returns
// the offending `file: text` lines, so a test asserts it is empty.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import {
  literalCallArguments,
  scanHardcodedStringsScoped,
  untranslatedTableReads,
} from "../../../apps/web/src/modules/i18n/hardcoded-scan"

/** The UI source files under `dir`: .ts/.tsx, minus tests, declarations and the i18n files. */
export function uiFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...uiFiles(path))
    else if (/\.tsx?$/.test(name) && !/\.test\.|\.d\.ts$|i18n/.test(name)) out.push(path)
  }
  return out
}

/** Every `tr()` string under `uiDir` that has no entry in `fr`. */
export function trStringsWithoutFrench(uiDir: string, fr: Record<string, string>): string[] {
  const missing: string[] = []
  for (const file of uiFiles(uiDir)) {
    for (const text of literalCallArguments(file, readFileSync(file, "utf8"), "tr")) {
      if (!(text in fr)) missing.push(`${file.slice(uiDir.length + 1)}: ${text}`)
    }
  }
  return missing
}

/** Copy that bypasses `tr()`, and module label table entries with no French. */
export function copyBypassingTr(uiDir: string, fr: Record<string, string>): string[] {
  const bypass: string[] = []
  for (const file of uiFiles(uiDir)) {
    const rel = file.slice(uiDir.length + 1)
    for (const hit of scanHardcodedStringsScoped(rel, readFileSync(file, "utf8"))) {
      // Rendered where it stands: must go through tr().
      if (hit.inFunction) bypass.push(`${rel}:${hit.line}: ${hit.text}`)
      // A module-level table entry: wrapped in tr() at its render site, so
      // it still needs its French.
      else if (!(hit.text in fr)) bypass.push(`${rel}:${hit.line}: no French for ${hit.text}`)
    }
  }
  return bypass
}

/** Module label tables read raw (not through `tr()`) where they reach the screen. */
export function rawTableReads(uiDir: string): string[] {
  const raw: string[] = []
  for (const file of uiFiles(uiDir)) {
    const rel = file.slice(uiDir.length + 1)
    for (const hit of untranslatedTableReads(rel, readFileSync(file, "utf8"))) {
      raw.push(`${rel}:${hit.line}: ${hit.text}`)
    }
  }
  return raw
}

/** French entries that drop or add a `{{placeholder}}`, or use dash punctuation. */
export function badFrenchEntries(fr: Record<string, string>): string[] {
  const bad: string[] = []
  const ph = (s: string) => [...s.matchAll(/\{\{\w+\}\}/g)].map((m) => m[0]).sort()
  for (const [en, text] of Object.entries(fr)) {
    if (JSON.stringify(ph(en)) !== JSON.stringify(ph(text))) bad.push(`placeholder: ${en}`)
    if (/[–—]/.test(text)) bad.push(`dash: ${text}`)
  }
  return bad
}
