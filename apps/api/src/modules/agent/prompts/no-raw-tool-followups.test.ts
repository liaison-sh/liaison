// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A follow-up the platform phrases with a raw tool id is a follow-up the agent
// repeats to the person with that id ("I'll confirm when `kernel__import_status`
// reports it done", walk 4, N15). The prompts, skills and agent tool texts
// phrase follow-ups in words; an instruction to call a tool may still name it.

import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

const SRC = path.resolve(import.meta.dir, "..", "..", "..")

/** "follow it with kernel__x", "when `kernel__x` reports", "before x__y says". */
const ID = "`?[a-z][a-z0-9-]*__[a-z][a-z0-9_]*`?"
const FOLLOW_UP_BY_ID = new RegExp(
  `\\bfollow(?:s|ed)?\\s+(?:it|them|up|its progress)(?:\\s+up)?\\s+with\\s+${ID}` +
    `|\\b(?:when|once|until|before)\\s+${ID}(?:\\s+or\\s+[^.]{0,40}?)?\\s+(?:reports?|says?|shows?|confirms?|returns?|reads?)\\b` +
    // An offer phrased with the id, which the agent repeats as one ("let me know if you
    // would like me to set it up using `kernel__config_mail`", demo walk, N15).
    `|\\bto\\s+(?:connect|set up|configure|add)\\s+(?:it|one|them|an?\\s+\\w+),?\\s+use\\s+${ID}` +
    `|\\b(?:set\\s+(?:it|them|this|that)\\s+up|connect\\s+(?:it|one|them)|configure\\s+(?:it|one))\\s+(?:using|with|via|through)\\s+${ID}`,
  "i",
)

function files(dir: string, keep: (f: string) => boolean): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) out.push(...files(full, keep))
    else if (keep(full)) out.push(full)
  }
  return out
}

describe("no follow-up is phrased with a raw tool id", () => {
  const sources = [
    ...files(path.join(SRC, "modules", "agent", "prompts"), (f) => f.endsWith(".md")),
    ...files(
      path.join(SRC, "modules", "agent", "tools"),
      (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
    ),
    // The host apps' manifests: their tool descriptions reach the agent too.
    ...files(path.join(SRC, "apps"), (f) => f.endsWith("app.manifest.json")),
  ]

  it("scans the prompts and the agent tools", () => {
    expect(sources.some((f) => f.endsWith("import-transforms.md"))).toBe(true)
    expect(sources.some((f) => f.endsWith("import-tools.ts"))).toBe(true)
    expect(sources.some((f) => f.endsWith(path.join("mail", "app.manifest.json")))).toBe(true)
  })

  it("catches an offer phrased with an id", () => {
    for (const line of [
      "To connect one, use kernel__config_mail, then kernel__request_secret.",
      "or let me know if you would like me to set it up using `kernel__config_mail`.",
      "Follow it with kernel__import_status.",
    ]) {
      expect({ line, hit: FOLLOW_UP_BY_ID.test(line) }).toEqual({ line, hit: true })
    }
    expect(FOLLOW_UP_BY_ID.test("Call kernel__config_mail, then kernel__request_secret.")).toBe(
      false,
    )
  })

  it("finds none", () => {
    const hits: string[] = []
    for (const file of sources) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          const m = FOLLOW_UP_BY_ID.exec(line)
          if (m) hits.push(`${path.relative(SRC, file)}:${i + 1}: ${m[0]}`)
        })
    }
    expect(hits).toEqual([])
  })
})
