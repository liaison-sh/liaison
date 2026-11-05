// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The sidecar signing script stays sidecar-scoped: the outer bundle is signed
// by the monorepo's own script, after this one, and a script that reached for
// both would make that ordering impossible to see.
import { describe, expect, it } from "bun:test"
import { readFileSync, statSync } from "node:fs"
import path from "node:path"

const SCRIPT_PATH = path.resolve(import.meta.dir, "..", "ci", "sign-sidecar-macos.sh")
const source = readFileSync(SCRIPT_PATH, "utf8")

describe("sign-sidecar-macos.sh", () => {
  it("the script signs the sidecar binary path, never an outer bundle path", () => {
    expect(source).not.toContain(".app")
  })

  it("the script requires codesign --verify to follow the sign step", () => {
    const signIndex = source.indexOf("codesign --force")
    const verifyIndex = source.indexOf("codesign --verify")
    expect(signIndex).toBeGreaterThan(-1)
    expect(verifyIndex).toBeGreaterThan(signIndex)
  })

  it("signs with the hardened runtime, a timestamp and the sidecar entitlements", () => {
    expect(source).toContain("--options runtime")
    expect(source).toContain("--timestamp")
    expect(source).toContain("entitlements-sidecar.plist")
  })

  it("signs as the one team APPLE_TEAM_ID names, never the keychain's first Developer ID", () => {
    expect(source).toContain('source "$SCRIPT_DIR/macos-signing-identity.sh"')
    expect(source).toContain("resolve_signing_identity")
    expect(source).not.toContain("head -1")
    expect(source.indexOf("require_apple_team_id")).toBeLessThan(
      source.indexOf("setup_temp_keychain"),
    )
    expect(source.indexOf('assert_signed_by_team "$BINARY"')).toBeGreaterThan(
      source.indexOf("codesign --force"),
    )
  })

  it("fails fast and is executable", () => {
    expect(source).toContain("set -euo pipefail")
    expect(statSync(SCRIPT_PATH).mode & 0o111).toBeGreaterThan(0)
  })
})
