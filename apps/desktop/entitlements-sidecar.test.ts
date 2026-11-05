// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The sidecar is a Bun standalone binary and JavaScriptCore JITs inside it, so
// the hardened runtime has to allow JIT and unsigned executable memory. The
// monorepo's own ci/entitlements.plist (tessera_lab's) DISABLES exactly those two
// and enables library validation, so reusing it would produce an app that
// signs, notarizes, and then dies the first time the sidecar runs a turn.
//
// Two failure modes are pinned here: the grant drifting (a key added, removed
// or flipped) and a SECOND plist appearing beside 6a's, which is how two
// entitlement files quietly disagree about what the same binary is allowed to
// do.
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

const CI = path.join(import.meta.dir, "ci")
const PLIST = path.join(CI, "entitlements-sidecar.plist")
const plist = readFileSync(PLIST, "utf8")

/** `<key>name</key><true/>` pairs, comments and whitespace ignored. */
function entitlements(source: string): Record<string, boolean> {
  const body = source.replace(/<!--[\s\S]*?-->/g, "")
  const found: Record<string, boolean> = {}
  for (const [, key, value] of body.matchAll(/<key>([^<]+)<\/key>\s*<(true|false)\/>/g)) {
    found[key] = value === "true"
  }
  return found
}

describe("the sidecar entitlements", () => {
  it("grants exactly the three keys the sidecar needs and nothing else", () => {
    expect(entitlements(plist)).toEqual({
      "com.apple.security.cs.allow-jit": true,
      "com.apple.security.cs.allow-unsigned-executable-memory": true,
      "com.apple.security.network.client": true,
    })
  })

  it("never carries the outer app's library validation or device grants", () => {
    const keys = Object.keys(entitlements(plist))
    expect(keys).not.toContain("com.apple.security.cs.disable-library-validation")
    expect(keys.filter((key) => key.startsWith("com.apple.security.device."))).toEqual([])
  })

  it("is the file the signing script actually passes to codesign", () => {
    const script = readFileSync(path.join(CI, "sign-sidecar-macos.sh"), "utf8")
    expect(script).toContain('ENTITLEMENTS="$SCRIPT_DIR/entitlements-sidecar.plist"')
    expect(script).toContain('--entitlements "$ENTITLEMENTS"')
  })

  it("is the only sidecar entitlements file in the tree", () => {
    // A second copy under src-tauri or scripts is how the two drift apart.
    const found = readdirSync(path.join(import.meta.dir), { recursive: true })
      .map((entry) => String(entry))
      .filter((entry) => !entry.includes("node_modules") && !entry.includes("target/"))
      .filter((entry) => /entitlements.*sidecar.*\.plist$/i.test(entry))
    expect(found).toEqual(["ci/entitlements-sidecar.plist"])
  })
})
