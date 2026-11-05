// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The mobile Home route must stay behind its own lazily loaded chunk: a phone
 * pays for Home's code, not for the whole app. The boundary is a single dynamic
 * import in bootstrap.ts, and a STATIC import of the same module anywhere else
 * silently folds Home back into the entry chunk, which is exactly the
 * regression this pins.
 */

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const SRC = join(import.meta.dirname, "..")

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) yield* walk(full)
    else if (/\.tsx?$/.test(entry)) yield full
  }
}

describe("Home route chunk boundary", () => {
  it("loads Home through a dynamic import in bootstrap", () => {
    const src = readFileSync(join(SRC, "framework/bootstrap.ts"), "utf8")
    expect(src).toContain('lazy(() => import("~/modules/shell/Home"))')
  })

  it("has no static import of the Home module anywhere, which would defeat the split", () => {
    const offenders: string[] = []
    for (const file of walk(SRC)) {
      // Test files are not part of the shipped bundle.
      if (/\.test\.tsx?$/.test(file)) continue
      const src = readFileSync(file, "utf8")
      if (/import\s[^\n]*from\s+["']~\/modules\/shell\/Home["']/.test(src)) offenders.push(file)
      if (/import\s[^\n]*from\s+["']\.\/Home["']/.test(src) && file.includes("modules/shell/")) {
        offenders.push(file)
      }
    }
    expect(offenders).toEqual([])
  })
})
