// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Every string this app's UI passes through tr() has a French entry (a missing one silently reads
// in English), and the French entries are well formed.
import { afterEach, describe, expect, it } from "bun:test"
import { badFrenchEntries, trStringsWithoutFrench } from "../../../../packages/app-ui/test-support/ui-copy-guard"
import { tr } from "./i18n"
import { FR } from "./i18n-fr"

afterEach(() => {
  ;(globalThis as { __liaisonHost?: unknown }).__liaisonHost = undefined
})

describe("boxtal UI copy is translated", () => {
  it("every tr() string has a French entry", () => {
    expect(trStringsWithoutFrench(import.meta.dir, FR)).toEqual([])
  })

  it("French entries are well formed", () => {
    expect(badFrenchEntries(FR)).toEqual([])
  })

  it("tr() fills placeholders in English without a host", () => {
    expect(tr("Seen on {{count}} row(s)", { count: 3 })).toBe("Seen on 3 row(s)")
  })
})
