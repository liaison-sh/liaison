// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applySuiteExtras, readSuiteExtras, withExtraListings } from "./suite-extras"

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function extrasDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "suite-extras-"))
  dirs.push(dir)
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true })
    writeFileSync(join(dir, rel), text)
  }
  return dir
}

describe("suite extras", () => {
  it("reads one path per line per suite, in file order, without comments or blanks", () => {
    const dir = extrasDir({
      "root/b-feature.txt": "scripts/b.test.ts\n",
      "root/a-feature.txt": "# why these run here\nscripts/a.test.ts  # inline\n\n",
      "root/notes.md": "ignored",
    })
    expect(readSuiteExtras(dir)).toEqual(
      new Map([["root", ["scripts/a.test.ts", "scripts/b.test.ts"]]]),
    )
  })

  it("refuses a line that is not a relative test file path", () => {
    for (const bad of ["scripts/a.ts", "/abs/a.test.ts", "../up/a.test.ts"]) {
      expect(() => readSuiteExtras(extrasDir({ "root/x.txt": `${bad}\n` }))).toThrow(bad)
    }
  })

  it("appends to a bun test suite unless the run names its files, and refuses any other", () => {
    const suites = {
      root: { cmd: ["bun", "test", "--timeout", "1", "scripts/listed.test.ts"] },
      web: { cmd: ["bunx", "vitest", "run"] },
    }
    applySuiteExtras(suites, new Map([["root", ["scripts/extra.test.ts"]]]), false)
    expect(suites.root.cmd.at(-1)).toBe("scripts/extra.test.ts")
    applySuiteExtras(suites, new Map([["root", ["scripts/more.test.ts"]]]), true)
    expect(suites.root.cmd.at(-1)).toBe("scripts/extra.test.ts")
    expect(() => applySuiteExtras(suites, new Map([["web", ["a.test.ts"]]]), false)).toThrow(
      "bun test",
    )
    expect(() => applySuiteExtras(suites, new Map([["nope", ["a.test.ts"]]]), false)).toThrow(
      "no suite",
    )
  })

  it("shows extras to the source-reading guards as quoted listings", () => {
    const block = withExtraListings(
      "root",
      "  cmd: []\n",
      new Map([["root", ["scripts/x.test.ts"]]]),
    )
    expect(block).toContain('"scripts/x.test.ts",')
    expect(withExtraListings("other", "same", new Map())).toBe("same")
  })
})
