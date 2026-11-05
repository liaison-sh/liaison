// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Every call to the route-test lock helpers is awaited.
//
// releaseTestLock() TRUNCATEs kernel.organizations (CASCADE) and the other
// shared tables before it frees the lock. Fourteen afterAll hooks called it
// without `await`, so bun moved on to the next file while the TRUNCATE was
// still running: the next file's org vanished between its INSERT and the rows
// that name it (memory verbs, channel topic, taint tracker, files policy),
// and its DDL deadlocked against the TRUNCATE. None of that showed when a file
// ran alone, only in a whole-suite or whole-directory run. `afterAll(releaseTestLock)`
// is fine (bun awaits the promise the hook returns); a bare statement is not.
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

const API_ROOT = path.resolve(import.meta.dir, "..")
const ROOTS = [path.join(API_ROOT, "src"), path.join(API_ROOT, "test-support")]
const BARE_CALL = /^\s*(releaseTestLock|releaseTestLockKeepRows|acquireTestLock)\s*\(/

function* testFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) yield* testFiles(full)
    else if (name.endsWith(".ts")) yield full
  }
}

describe("route-test lock helpers", () => {
  it("are never called as a bare statement that nobody awaits", () => {
    const offenders: string[] = []
    for (const root of ROOTS) {
      for (const file of testFiles(root)) {
        readFileSync(file, "utf8")
          .split("\n")
          .forEach((line, i) => {
            if (BARE_CALL.test(line)) offenders.push(`${path.relative(API_ROOT, file)}:${i + 1}`)
          })
      }
    }
    expect(offenders).toEqual([])
  })
})
