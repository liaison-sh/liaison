// SPDX-License-Identifier: FSL-1.1-ALv2
// @vitest-environment node
//
// `src/ui` is the presentation layer: it must not reach into domain modules or
// the framework, including through a SUBPATH. Biome's restricted-import rule
// enforces the same boundary at lint time; this test is the falsifiable twin
// that fails in the test suite rather than only in CI lint.
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const UI_DIR = join(import.meta.dirname, ".")
const FORBIDDEN = /from\s+["']~\/(modules|framework)(\/|["'])/

function uiSourceFiles(): string[] {
  return readdirSync(UI_DIR)
    .filter((name) => /\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name))
    .map((name) => join(UI_DIR, name))
}

describe("src/ui layer boundary", () => {
  it("no ui file imports from ~/modules or ~/framework, subpaths included", () => {
    const offenders = uiSourceFiles().filter((file) => FORBIDDEN.test(readFileSync(file, "utf8")))
    expect(offenders.map((f) => f.split("/").pop())).toEqual([])
  })
})
