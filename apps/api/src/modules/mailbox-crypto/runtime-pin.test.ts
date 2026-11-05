// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 1 Task 1.4: the deployed Bun runtime is the one this design asserts its
// crypto surface against, not whatever `oven/bun:1` floats to. Every stage that
// starts from the Bun image must name an explicit patch version, and all of
// them must name the SAME version. The variant suffix (`-slim`) is per file and
// is deliberately preserved.

import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

const REPO_ROOT = path.resolve(import.meta.dir, "../../../../..")
const DOCKERFILES = [
  path.join(REPO_ROOT, "apps/api/Dockerfile"),
  path.join(REPO_ROOT, "apps/db-gate/Dockerfile"),
]

function bunFromLines(): string[] {
  const lines: string[] = []
  for (const file of DOCKERFILES) {
    const contents = readFileSync(file, "utf8")
    for (const line of contents.split("\n")) {
      if (/^FROM oven\/bun:/.test(line)) lines.push(line.trim())
    }
  }
  return lines
}

describe("bun base image pin", () => {
  it("finds exactly three FROM oven/bun stages, so a new stage cannot slip past", () => {
    expect(bunFromLines().length).toBe(3)
  })

  it("pins an explicit patch version on every stage and the same version on all of them", () => {
    const lines = bunFromLines()
    expect(lines.length).toBeGreaterThan(0)
    const versions = new Set<string>()
    for (const line of lines) {
      // The digest after the tag is checked by scripts/dockerfile-pins.test.ts.
      const match = line.match(
        /^FROM oven\/bun:(\d+\.\d+\.\d+)(-[a-z0-9]+)?(@sha256:[0-9a-f]{64})? /,
      )
      expect(match, `unpinned Bun base image: ${line}`).not.toBeNull()
      versions.add((match as RegExpMatchArray)[1])
    }
    expect(Array.from(versions).length).toBe(1)
  })

  it("keeps the db-gate stages on the slim variant", () => {
    const dbGate = bunFromLines().filter((l) => l.includes("-slim"))
    expect(dbGate.length).toBe(2)
  })
})
