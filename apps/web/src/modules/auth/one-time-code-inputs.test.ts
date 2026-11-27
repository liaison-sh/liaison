// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Every one-time code field opens the number pad on a phone. The sign-in code
// and the delete-account code asked for `one-time-code` autofill only, so iOS
// showed the full keyboard for six digits.
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const SRC = path.resolve(__dirname, "../..")

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) return name === "node_modules" ? [] : tsxFiles(full)
    return name.endsWith(".tsx") && !name.includes(".test.") ? [full] : []
  })
}

describe("one-time code fields", () => {
  it("every field that autofills a one-time code asks for the number pad", () => {
    const missing: string[] = []
    let seen = 0
    for (const file of tsxFiles(SRC)) {
      const text = readFileSync(file, "utf8")
      let at = text.indexOf('autocomplete="one-time-code"')
      while (at !== -1) {
        const lineStart = text.lastIndexOf("\n", at) + 1
        const lineHead = text.slice(lineStart, at).trim()
        if (lineHead.startsWith("//") || lineHead.startsWith("*")) {
          at = text.indexOf('autocomplete="one-time-code"', at + 1)
          continue
        }
        seen += 1
        const start = text.lastIndexOf("<", at)
        const end = text.indexOf("/>", at)
        const element = text.slice(start, end === -1 ? undefined : end)
        if (!element.includes('inputmode="numeric"')) {
          const line = text.slice(0, at).split("\n").length
          missing.push(`${path.relative(SRC, file)}:${line}`)
        }
        at = text.indexOf('autocomplete="one-time-code"', at + 1)
      }
    }
    expect(seen).toBeGreaterThan(10)
    expect(missing).toEqual([])
  })
})
