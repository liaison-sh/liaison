// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Tauri shell scaffold. The product name is fixed copy (spec-native.md):
// the window and the bundle are called Liaison, with no model or platform
// suffix, so it is pinned here rather than left to a template default.
import { beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { prepareSidecar } from "./prepare-sidecar"

const DESKTOP = path.resolve(import.meta.dir)
const SRC_TAURI = path.join(DESKTOP, "src-tauri")

describe("tauri scaffold", () => {
  // Tauri refuses to build at all when the declared externalBin is missing, so
  // the compiled sidecar has to be installed before `cargo check` runs.
  beforeAll(() => {
    prepareSidecar()
  })

  it("tauri.conf.json declares the fixed Liaison product name", () => {
    const config = JSON.parse(readFileSync(path.join(SRC_TAURI, "tauri.conf.json"), "utf8"))
    expect(config.productName).toBe("Liaison")
    // Changed from the legacy identifier after 0.1.19: the shell copies the
    // per-user data across on first launch (src-tauri/src/identifier_migration.rs).
    expect(config.identifier).toBe("sh.liaison.desktop")
    expect(config.app.windows[0].title).toBe("Liaison")
  })

  it("cargo check succeeds", () => {
    const result = Bun.spawnSync(["cargo", "check", "--quiet"], {
      cwd: SRC_TAURI,
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(result.stderr.toString().slice(-4000)).toBe("")
    expect(result.exitCode).toBe(0)
  })
})
