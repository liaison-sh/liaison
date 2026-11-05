// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Pins the shared PDF text layout to the invoicing templates' copy: same widths, same
// wrapping, line for line.
import { describe, expect, test } from "bun:test"
import { textWidth as sharedTextWidth, wrapText as sharedWrapText, wrapRuns } from "@liaison/shared"
import { textWidth, wrapText } from "../../../../../bundled-apps/invoicing/templates/shared"

const CORPUS: string[] = [
  "",
  "   ",
  "Hello",
  "The quick brown fox jumps over the lazy dog",
  "Supercalifragilisticexpialidocious".repeat(8),
  "x".repeat(500),
  "Rue de l'Église, 75011 Paris — Crème brûlée à la façon d'Zoë",
  "東京都千代田区丸の内一丁目九番地 Tokyo Station 1-9-1",
  "日本語のとても長い住所がここに入ります。日本語のとても長い住所がここに入ります。",
  "  leading and   multiple    spaces\tand\nnewlines  ",
  "ABC DEF https://example.com/a/very/long/path/that/has/no/spaces/in/it/at/all/ok end",
]

describe("shared text layout parity with invoicing", () => {
  for (const size of [8, 11]) {
    for (const maxWidth of [60, 150, 495]) {
      for (const bold of [false, true]) {
        test(`size ${size}, width ${maxWidth}, bold ${bold}`, () => {
          for (const text of CORPUS) {
            expect(sharedTextWidth(text, size, bold)).toBe(textWidth(text, size, bold))
            expect(sharedWrapText(text, maxWidth, size, bold)).toEqual(
              wrapText(text, maxWidth, size, bold),
            )
            // One run wraps like wrapText.
            const lines = wrapRuns([{ text, bold }], maxWidth, size).map((l) =>
              l.map((p) => p.text).join(""),
            )
            if (text.trim().length === 0) expect(lines).toEqual([""])
            else expect(lines).toEqual(wrapText(text, maxWidth, size, bold))
          }
        })
      }
    }
  }
})
