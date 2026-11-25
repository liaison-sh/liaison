// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The staff screens' copy goes through tr() and every string has its French.
import { afterEach, describe, expect, it } from "bun:test"
import {
  badFrenchEntries,
  copyBypassingTr,
  rawTableReads,
  trStringsWithoutFrench,
  uiFiles,
} from "../../../../packages/app-ui/test-support/ui-copy-guard"
import { CHECK_WORDS_FOR_TEST } from "./Editor-words"
import { tr } from "./i18n"
import { FR } from "./i18n-fr"
import { KIND_GROUPS, KIND_LABEL, LINK_LABEL, PREPARE_WHY, STATUS_LABEL } from "./model"

const UI_DIR = import.meta.dir

afterEach(() => {
  ;(globalThis as any).__liaisonHost = undefined
})

describe("agreements UI copy is translated", () => {
  it("every tr() string has a French entry", () => {
    expect(trStringsWithoutFrench(UI_DIR, FR)).toEqual([])
  })

  it("no copy bypasses tr()", () => {
    expect(uiFiles(UI_DIR).length).toBeGreaterThan(5)
    expect(copyBypassingTr(UI_DIR, FR)).toEqual([])
    expect(rawTableReads(UI_DIR)).toEqual([])
  })

  it("every label table read through tr() has its French", () => {
    const tables = [
      ...Object.values(STATUS_LABEL),
      ...Object.values(PREPARE_WHY),
      ...Object.values(LINK_LABEL),
      ...Object.values(KIND_LABEL),
      ...KIND_GROUPS.map((g) => g.label),
      ...CHECK_WORDS_FOR_TEST.flat(),
    ]
    expect(tables.filter((t) => !(t in FR))).toEqual([])
  })

  it("French keeps every placeholder and uses no dash punctuation", () => {
    expect(badFrenchEntries(FR)).toEqual([])
  })

  it("follows the host's locale", () => {
    expect(tr("Read and sign")).toBe("Read and sign")
    ;(globalThis as any).__liaisonHost = { locale: () => "fr" }
    expect(tr("Read and sign")).toBe("Lire et signer")
  })
})
