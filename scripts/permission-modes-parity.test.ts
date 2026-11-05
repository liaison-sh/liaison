// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The desktop shell, its sidecar and the API each spell out the local
// permission modes. When the desktop gained "auto" and the API's start schema
// did not, every local session start came back 400 ("Liaison would not record
// this session"). The three lists are compared here, as sets.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const read = (path: string) => readFileSync(join(root, path), "utf8")

function modesIn(source: string, pattern: RegExp): string[] {
  const match = source.match(pattern)
  if (!match) throw new Error(`no mode list matched ${pattern}`)
  return [...match[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]).sort()
}

describe("local permission modes", () => {
  it("are the same in the sidecar, the Rust shell and the API start schema", () => {
    const sidecar = modesIn(
      read("apps/desktop/sidecar/index.ts"),
      /PERMISSION_MODES = \[([^\]]+)\]/,
    )
    const shell = modesIn(
      read("apps/desktop/src-tauri/src/sidecar.rs"),
      /PERMISSION_MODES: \[&str; \d+\] = \[([^\]]+)\]/,
    )
    const api = modesIn(
      read("apps/api/src/modules/agent/local-sessions/local-session-routes.ts"),
      /const permissionMode = z\.enum\(\[([^\]]+)\]\)/,
    )
    expect(shell).toEqual(sidecar)
    expect(api).toEqual(sidecar)
  })
})
