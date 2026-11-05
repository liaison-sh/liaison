// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What is allowed to sit in this package pretending to be an artifact.
//
// The blueprint for this slice assumed the packaging tasks would need dummy
// stand ins (a dummy .app, a dummy installer, a dummy Tauri project) because
// it was written before 6a landed a real one. They were never created: every
// packaging task ran against the real bundle instead, which is why the macOS
// dry run found three defects a fixture could not have shown. So the
// retirement this task was written for has an empty set, and what is left is
// the guard that keeps it empty.
//
// Two kinds of stand in are legitimate and are named here rather than swept
// up: 6a's signing spike, which is a RECORD of a live run and is referenced by
// its own report, and the updater gate's recorded signatures, which exist
// because signing a real 129 MB disk image in a unit test is not a thing a
// unit test does.
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

const DESKTOP = import.meta.dir

function walk(dir: string, skip: string[]): string[] {
  const found: string[] = []
  for (const name of readdirSync(dir)) {
    if (skip.includes(name)) continue
    const entry = path.join(dir, name)
    if (statSync(entry).isDirectory()) found.push(...walk(entry, skip))
    else found.push(entry)
  }
  return found
}

const files = walk(DESKTOP, ["node_modules", "target", "dist", "gen", ".git"])

describe("the desktop package's fixtures", () => {
  it("carries no dummy stand in for anything the real build produces", () => {
    // Named this way in the blueprint. A packaging step proved against a dummy
    // is a packaging step proved against nothing: the real bundle is what
    // carries the sidecar, the entitlements and the build machine's paths.
    const dummies = files.filter((file) => path.basename(file).startsWith("dummy-"))
    expect(dummies).toEqual([])
  })

  it("has a test for every recorded fixture set it keeps", () => {
    // A fixture directory no test reads is a directory nobody will ever
    // update, and the day it is wrong nothing says so.
    const root = path.join(DESKTOP, "ci/fixtures")
    const sources = files
      .filter((file) => file.endsWith(".test.ts") || file.endsWith(".ts"))
      .map((file) => readFileSync(file, "utf8"))
      .join("\n")
    for (const name of readdirSync(root)) {
      expect(sources).toContain(`ci/fixtures/${name}`)
    }
  })

  it("keeps no private key material in any fixture", () => {
    const root = path.join(DESKTOP, "ci/fixtures")
    const header = ["untrusted", "comment:", "minisign", "encrypted", "secret", "key"].join(" ")
    for (const file of walk(root, [])) {
      const contents = readFileSync(file, "utf8")
      expect(contents).not.toContain(header)
      // The public files are base64 over the minisign file, so the header is
      // checked decoded too.
      if (file.endsWith(".pub")) {
        expect(Buffer.from(contents.trim(), "base64").toString("utf8")).not.toContain(header)
      }
    }
  })
})
