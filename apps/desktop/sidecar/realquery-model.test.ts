// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Owner rule (2026-10-15): every committed test that runs a real Claude
// session on this computer runs it on Haiku, claude-haiku-5-5, never Sonnet,
// Opus or an older Haiku.
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

const DIR = import.meta.dir
const files = readdirSync(DIR).filter((f) => f.endsWith(".realquery.test.ts"))

describe("realquery tests run on claude-haiku-5-5", () => {
  it("every realquery test's model is claude-haiku-5-5 and it names no other Claude model", () => {
    expect(files.length).toBeGreaterThan(0)
    const found = files.map((file) => {
      const text = readFileSync(path.join(DIR, file), "utf8")
      return {
        file,
        model: /const MODEL = "([^"]+)"/.exec(text)?.[1] ?? null,
        others: [...new Set(text.match(/claude-(?:haiku|sonnet|opus)-[0-9][a-z0-9-]*/g) ?? [])]
          .filter((id) => id !== "claude-haiku-5-5")
          .sort(),
      }
    })
    expect(found).toEqual(files.map((file) => ({ file, model: "claude-haiku-5-5", others: [] })))
  })
})
