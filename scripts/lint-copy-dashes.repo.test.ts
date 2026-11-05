// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The no-dash copy lint, run over the REAL repository. lint-copy-dashes.test.ts
// pins the scanner's behaviour on synthetic sources; that one stays green
// forever while customer copy drifts, because nothing executes the sweep. This
// file IS the gate: `bun run lint:copy` is a developer convenience, and until
// a suite ran the sweep, CI never failed on a dash that shipped.
import { describe, expect, it } from "bun:test"
import path from "node:path"
import { lintCopyDashes } from "./lint-copy-dashes"

const ROOT = path.resolve(import.meta.dir, "..")

describe("no dash punctuation in customer-visible copy", () => {
  it("reports zero violations across every copy root and locale file", async () => {
    const violations = await lintCopyDashes(ROOT)
    const report = violations.map((v) => `${v.file}:${v.line}: "${v.text}"`).join("\n")
    expect(report).toBe("")
    expect(violations.length).toBe(0)
  }, 120_000)
})
