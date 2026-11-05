// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A French org read this app entirely in English: an app bundle had no way to
// know the reader's language and no French at all. The host now hands over
// its locale and the UI keys its copy by the English text (i18n.ts). This
// pins the two ways that can rot: a literal that bypasses `tr()`, and a
// `tr()` string with no French entry, which silently falls back to English.
import { afterEach, describe, expect, it } from "bun:test"
import {
  badFrenchEntries,
  copyBypassingTr,
  rawTableReads,
  trStringsWithoutFrench,
  uiFiles,
} from "../../../../packages/app-ui/test-support/ui-copy-guard"
import { tr } from "./i18n"
import { FR } from "./i18n-fr"

const UI_DIR = import.meta.dir

afterEach(() => {
  ;(globalThis as any).__liaisonHost = undefined
})

describe("monitoring UI copy is translated", () => {
  it("every tr() string has a French entry", () => {
    expect(trStringsWithoutFrench(UI_DIR, FR)).toEqual([])
  })

  it("no copy bypasses tr(), except module label tables translated where rendered", () => {
    expect(uiFiles(UI_DIR).length).toBeGreaterThan(3)
    expect(copyBypassingTr(UI_DIR, FR)).toEqual([])
  })

  it("a module label table is read through tr() wherever it reaches the screen", () => {
    // "+ New quote" and "Search number or customer" reached a French reader:
    // their tables had French, but the render site read the table raw.
    expect(rawTableReads(UI_DIR)).toEqual([])
  })

  it("French keeps every placeholder and uses no dash punctuation", () => {
    expect(badFrenchEntries(FR)).toEqual([])
  })

  it("says \"prendre en compte\" for the acknowledge action in French", () => {
    ;(globalThis as any).__liaisonHost = { locale: () => "fr" }
    expect(tr("Ack")).toBe("Prendre en compte")
    expect(tr("Acknowledge")).toBe("Prendre en compte")
    expect(tr("Acknowledged")).toBe("Pris en compte")
  })

  it("follows the host's locale, English without one", () => {
    expect(tr("Resolve")).toBe("Resolve")
    ;(globalThis as any).__liaisonHost = { locale: () => "fr" }
    expect(tr("Resolve")).toBe("Résoudre")
    ;(globalThis as any).__liaisonHost = { locale: () => "en" }
    expect(tr("Resolve")).toBe("Resolve")
  })
})
