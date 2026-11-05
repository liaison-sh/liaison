// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `src/tauri.ts` is the ONE module that may import `@tauri-apps/api`, and the
// reason is not tidiness: the overlay is injected into apps/web's page, which
// is also served in a plain browser with no Tauri under it, and every overlay
// component has to render under jsdom in a test. A stray import anywhere else
// is a module that throws the moment the bundle is evaluated outside the
// shell, which is a blank window rather than a test failure.
//
// The rule was written in a comment at the top of `src/tauri.ts` and enforced
// by nothing, so this is the enforcement.
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

const SRC = path.join(import.meta.dir, "src")
/** Relative to `src`. The one module the whole shell surface is behind. */
const ALLOWED = "tauri.ts"

function sourceFiles(dir: string, prefix = ""): string[] {
  const found: string[] = []
  for (const name of readdirSync(dir)) {
    const absolute = path.join(dir, name)
    const relative = prefix ? `${prefix}/${name}` : name
    if (statSync(absolute).isDirectory()) {
      found.push(...sourceFiles(absolute, relative))
    } else if (name.endsWith(".ts") || name.endsWith(".tsx")) {
      found.push(relative)
    }
  }
  return found
}

const files = sourceFiles(SRC)

describe("the single Tauri import site", () => {
  it("finds the overlay sources at all, so an empty read cannot pass", () => {
    expect(files.length).toBeGreaterThan(5)
    expect(files).toContain(ALLOWED)
  })

  it("lets no module but src/tauri.ts import @tauri-apps/api", () => {
    // An IMPORT, not a mention: the contract is discussed in comments in
    // several of these files and that is not what breaks the browser build.
    const importing = files.filter((file) => {
      if (file === ALLOWED) return false
      const body = readFileSync(path.join(SRC, file), "utf8")
      return /(?:^|\n)\s*(?:import|export)[^\n]*from\s+["']@tauri-apps\/api[^"']*["']/.test(body)
    })
    expect(importing).toEqual([])
  })

  it("still has src/tauri.ts doing the importing", () => {
    const body = readFileSync(path.join(SRC, ALLOWED), "utf8")
    expect(body).toContain('from "@tauri-apps/api/core"')
    expect(body).toContain('from "@tauri-apps/api/event"')
  })
})
