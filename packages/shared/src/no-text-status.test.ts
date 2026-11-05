// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S10 (owner D1) tripwire: a session's end (Done, Needs you, Failed) is
// decided from its completion signal, never from the text the model or the
// person wrote. This reads the functions that make that decision and fails
// when one of them matches text with a regular expression (`.test(`,
// `.match(`, `.matchAll(`, `RegExp(`). A heuristic guard: the behavioural proof
// is the "All done!" / "Done!" unit tests of the end-of-run path and the host
// tools (job-routes.result.test.ts, session-host-tools.test.ts).
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

const REPO = path.resolve(import.meta.dir, "../../..")

/** The status-decision functions, by file. Each must be found: a rename fails here. */
const DECISIONS: Record<string, string[]> = {
  "apps/api/src/modules/nodes/jobs.ts": ["completeNodeJob", "failNodeJob"],
  "apps/api/src/modules/nodes/job-routes.ts": ["completeSessionResult"],
  // The turn-end decision: the run's result carries the latched completion.
  "apps/desktop/sidecar/unattended.ts": ["withCompletion"],
  // The host tools (mark_done, needs_you) and the latch they set.
  "apps/desktop/sidecar/session-host-tools.ts": ["CompletionLatch", "hostToolHandlers"],
  // Wave 2 (S32, S36, S57): the turn end decides from the latch, Atelier's
  // state.json, git and the PR check; never from the words.
  "apps/desktop/sidecar/turn-end.ts": ["decideTurnEnd", "doneWithPr", "unverified", "AutoContinue"],
  "apps/desktop/sidecar/session-atelier.ts": ["readAtelierState", "mapState"],
  // S60: the post-back fires on the status change, never on the summary's words.
  "apps/api/src/modules/node-sessions/post-back.ts": [
    "postsBack",
    "postBackContent",
    "postBackSessionResult",
  ],
  // Wave 3 (A45, A53): a follow ends (`follow_done.why`) from file facts
  // (size, lstat, the driver registry) and the owner's stop, never the words.
  "apps/desktop/sidecar/follow-host.ts": ["FollowHost"],
  // Wave 3 (S40, S42, A56): an import starts or is refused from the node's
  // check codes, ids and rows, never the transcript's text.
  "apps/api/src/modules/node-sessions/import.ts": ["listImportable", "importStart"],
}

const TEXT_MATCH = /\.test\(|\.match\(|\.matchAll\(|\bRegExp\(/

/**
 * The body of the function or class named `name`: from its declaration to the
 * brace that closes the first `{` ending a line outside the parameter list
 * (so an inline return type such as `): { a: B } {` is skipped).
 */
function bodyOf(source: string, name: string): string | null {
  const decl = new RegExp(`(?:function\\s+${name}\\s*[<(]|class\\s+${name}\\b)`).exec(source)
  if (!decl) return null
  let parens = 0
  let open = -1
  for (let i = decl.index; i < source.length; i++) {
    const c = source[i]
    if (c === "(") parens++
    else if (c === ")") parens--
    else if (c === "{" && parens === 0) {
      const rest = source.slice(i + 1, source.indexOf("\n", i + 1))
      if (rest.trim() === "") {
        open = i
        break
      }
    }
  }
  if (open < 0) return null
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++
    else if (source[i] === "}") {
      depth--
      if (depth === 0) return source.slice(open, i + 1)
    }
  }
  return null
}

describe("S10: no regex on text decides a session's status", () => {
  for (const [file, names] of Object.entries(DECISIONS)) {
    const source = readFileSync(path.join(REPO, file), "utf8")
    for (const name of names) {
      it(`S10: ${file} ${name} matches no text with a regular expression`, () => {
        const body = bodyOf(source, name)
        expect(body, `${name} not found in ${file}`).not.toBeNull()
        const lines = (body ?? "").split("\n").filter((line) => TEXT_MATCH.test(line))
        expect(lines).toEqual([])
      })
    }
  }

  it("S10: the body reader skips an inline return type and finds the whole body", () => {
    const src = [
      "function a(x: { y: number }): { z?: string } {",
      "  if (x) { return {} }",
      "  return { z: 'q' }",
      "}",
      "function b() {}",
    ].join("\n")
    expect(bodyOf(src, "a")).toBe("{\n  if (x) { return {} }\n  return { z: 'q' }\n}")
    expect(bodyOf(src, "nope")).toBeNull()
  })
})
