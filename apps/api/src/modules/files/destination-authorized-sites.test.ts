// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `attachFileToParent`'s `destinationAuthorized` skips a file parent's `canWrite`
 * check (the edit right on a Knowledge page). It exists for one caller whose
 * transaction cannot run that check: the Knowledge import, attaching inside a
 * privileged transaction to a page it has just created for the person. Any other
 * use needs a review, which means adding its file here with the reason.
 */
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const SRC = join(import.meta.dir, "..", "..")

const SITES: Record<string, string> = {
  "apps/knowledge/import-kind.ts":
    "the import's privileged transaction has no request context; the page is the person's own, created in this run",
  "modules/files/attach.ts": "the option itself",
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name === "node_modules") continue
      sourceFiles(full, out)
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(full)
    }
  }
  return out
}

describe("destinationAuthorized sites", () => {
  test("only the reviewed files skip the destination's edit check", () => {
    const found = sourceFiles(SRC)
      .filter((file) => /\bdestinationAuthorized\b/.test(readFileSync(file, "utf8")))
      .map((file) => relative(SRC, file))
      .sort()
    expect(found).toEqual(Object.keys(SITES).sort())
  })
})
