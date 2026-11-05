// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  BRIEF_SECTIONS,
  BRIEF_TOKEN_CAP,
  buildIncrementalBrief,
  enforceCap,
  parseBrief,
} from "./brief"
import { estimateTokens } from "./tokens"
import type { CorpusRow } from "./types"

const GOOD = `### Current decisions
- Tessera 2 ships on the 1200 x 1000 pallet: was EUR 1200 x 800 until 2026-09-09, now 1200 x 1000 [m000041, m000042]

### Open loops
- Quinn calls Sonovox in Lyon on Friday 18 September about the backorder, still open [m000050]

### Identifiers and entities
- DHL account number 7492118 [m000004]

### Standing procedures
- Every Monday the stuck list is cleared before the ready list is published [m000020]

### Unresolved contradictions
none
`

describe("the brief parser", () => {
  it("reads every section back", () => {
    const parsed = parseBrief(GOOD)
    expect(parsed.missingSections).toEqual([])
    expect(Object.keys(parsed.sections).sort()).toEqual([...BRIEF_SECTIONS].sort())
    expect(parsed.unattributedLines).toEqual([])
    expect(parsed.withinCap).toBe(true)
  })

  it("names the sections the model omitted", () => {
    const parsed = parseBrief("### Current decisions\n- a decision [m1]\n")
    expect(parsed.missingSections).toContain("Open loops")
    expect(parsed.missingSections).toContain("Unresolved contradictions")
  })

  it("flags a line that carries no message id", () => {
    const parsed = parseBrief("### Open loops\n- someone promised something\n")
    expect(parsed.unattributedLines).toEqual(["someone promised something"])
  })

  it("reports a brief over the cap", () => {
    const fat = `### Current decisions\n- ${"x".repeat(BRIEF_TOKEN_CAP * 4 + 40)} [m1]\n`
    expect(parseBrief(fat).withinCap).toBe(false)
  })
})

describe("the cap enforcement", () => {
  it("leaves a brief under the cap untouched", () => {
    expect(enforceCap(GOOD)).toBe(GOOD)
  })

  it("drops the lowest priority sections first, never the decisions", () => {
    const line = (s: string) => `- ${s.repeat(40)} [m1]`
    const fat = BRIEF_SECTIONS.map((s) => `### ${s}\n${line(s)}\n${line(s)}`).join("\n\n")
    const capped = enforceCap(fat, 120)
    expect(estimateTokens(capped)).toBeLessThanOrEqual(120)
    expect(capped).toContain("### Current decisions")
    expect(capped).not.toContain("### Unresolved contradictions")
  })

  it("hard clips a brief with no headings at all", () => {
    expect(enforceCap("z".repeat(4000), 10)).toHaveLength(40)
  })
})

describe("the incremental build", () => {
  it("feeds the previous brief back in, once per week", async () => {
    const rows: CorpusRow[] = [1, 1, 2, 2, 3].map((week, i) => ({
      id: `m${i}`,
      week,
      ts: "2026-09-08T09:14:00Z",
      authorType: "user",
      author: "quinn",
      kind: "message",
      content: `week ${week} row ${i}`,
    }))
    const seen: string[] = []
    const build = await buildIncrementalBrief({
      rows,
      throughWeek: 2,
      summarize: async (prompt, text) => {
        seen.push(
          `${prompt.includes("(empty, this is the first region)") ? "empty" : "carried"}|${text.slice(0, 40)}`,
        )
        return {
          text: `### Current decisions\n- brief after ${text.slice(0, 20)} [m0]`,
          tokens: 10,
        }
      },
    })
    expect(seen).toHaveLength(2)
    expect(seen[0]).toContain("empty")
    expect(seen[1]).toContain("carried")
    expect(build.tokens).toBe(20)
    expect(build.text).toContain("Current decisions")
  })
})
