// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The iOS app makes its main page out of a served build the way build-mobile.ts
// makes it out of the bundled one (boot script first, viewport pinned, the
// phone's CSP, inline scripts moved to files), in Swift
// (ios/LiaisonShell/Sources/LiaisonShell/MobilePage.swift). Its XCTest suite
// compares that port with PageFixtures.swift, which this test proves is what the
// TypeScript original produces today: a change to boot-injection.ts that is not
// carried to the Swift side fails one of the two.

import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { MOBILE_CSP } from "./scripts/boot-injection"
import { PAGE_FIXTURES, renderPageFixtures } from "./scripts/gen-shell-fixtures"

describe("served shell page parity", () => {
  it("PageFixtures.swift is what boot-injection.ts makes of the samples", () => {
    expect(readFileSync(PAGE_FIXTURES, "utf8")).toBe(renderPageFixtures())
  })

  it("MobilePage.swift carries the phone's CSP verbatim", () => {
    const swift = readFileSync(
      path.join(import.meta.dir, "ios/LiaisonShell/Sources/LiaisonShell/MobilePage.swift"),
      "utf8",
    )
    const parts = [...swift.matchAll(/^ {8}"([^"]+)",$/gm)].map((m) => m[1])
    expect(parts.join("; ")).toBe(MOBILE_CSP)
  })
})
