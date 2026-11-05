// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The outer bundle's signing script, pinned as text. Everything that can go
// wrong here is invisible on the machine that signed it:
//   - signing the outer bundle before its nested code seals a stale hash;
//   - re-signing the ALREADY signed sidecar strips the JIT entitlements it was
//     given and the first agent turn dies on a customer's Mac;
//   - notarizing without --wait submits and exits, so an unstapled app ships;
//   - stapling before the notary accepted leaves a bundle with no ticket.
// So the order is asserted, not reviewed.
import { describe, expect, it } from "bun:test"
import { existsSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { loadDesktopReleaseWorkflow, secretRef, step, stepIndex } from "./ci/workflow"

const CI = path.join(import.meta.dir, "ci")
const SCRIPT = path.join(CI, "sign-app-macos.sh")
const script = readFileSync(SCRIPT, "utf8")

/** Character offset of a marker, asserted present so an order test cannot
 *  silently compare two -1s. */
function at(marker: string): number {
  const index = script.indexOf(marker)
  expect(index, `marker not in sign-app-macos.sh: ${marker}`).toBeGreaterThanOrEqual(0)
  return index
}

describe("the outer app signing script", () => {
  it("is executable", () => {
    expect(statSync(SCRIPT).mode & 0o111).toBeGreaterThan(0)
  })

  it("signs inside out, nested code before the bundle that contains it", () => {
    const dylibs = at('-name "*.dylib"')
    const executables = at("-perm +111")
    const outer = at('--entitlements "$ENTITLEMENTS"')
    expect(dylibs).toBeLessThan(executables)
    expect(executables).toBeLessThan(outer)
  })

  it("restores the embedded sidecar's own entitlements before sealing", () => {
    // Measured live: `tauri build` re-signs the externalBin while bundling it,
    // and the copy inside Contents/MacOS comes out with a valid Developer ID
    // signature, the hardened runtime, and NO entitlements. codesign --verify
    // is happy with that, so nothing catches it until a turn needs the JIT.
    expect(script).toContain("lost its entitlements in the bundler")
    expect(script).toContain('"$SCRIPT_DIR/sign-sidecar-macos.sh" "$SIDECAR"')
    expect(at("sign-sidecar-macos.sh")).toBeLessThan(at('-name "*.dylib"'))
  })

  it("stops when there is no embedded sidecar at all", () => {
    // The entitlements block was wrapped in "if the sidecar is there". A
    // bundle without it is not a bundle to sign quietly: either the externalBin
    // did not make it in, in which case the app cannot run an agent turn at
    // all, or it moved, in which case the block that keeps its JIT grant is a
    // silent no-op and the grant is gone from the shipped app.
    expect(script).toContain("no embedded sidecar")
    expect(at("no embedded sidecar")).toBeLessThan(at('-name "*.dylib"'))
  })

  it("stops when the re-signed sidecar still has no JIT grant", () => {
    expect(script).toContain("still has no JIT entitlement after re-signing")
  })

  it("leaves a nested binary we already signed alone", () => {
    // The sidecar is signed first, with its OWN entitlements. Re-signing it
    // here without them is how JIT quietly disappears from the shipped app.
    expect(script).toContain("keeping the existing signature (Developer ID, team $APPLE_TEAM_ID)")
    expect(at("codesign --verify --strict")).toBeLessThan(at("-perm +111"))
  })

  it("keeps only OUR team's Developer ID signature, never an ad hoc or another team's", () => {
    // codesign --verify is happy with an ad hoc signature (Signature=adhoc),
    // which is what a vendored binary or a local build carries, and with any
    // other team's Developer ID, whose certificate can share the signing
    // Mac's keychain. Keeping either ships a nested binary that is not ours
    // inside a bundle that notarized. So the authority AND the team are read
    // (signed_by_team, driven against stubs in ci/macos-signing-identity.test.ts).
    const helper = readFileSync(path.join(CI, "macos-signing-identity.sh"), "utf8")
    expect(helper).toContain("^Authority=Developer ID Application: ")
    expect(helper).toContain('grep -qx "TeamIdentifier=')
    expect(script).toContain(
      'codesign --verify --strict "$target" >/dev/null 2>&1 && signed_by_team "$target"',
    )
    expect(at("signed_by_team")).toBeLessThan(at('-name "*.dylib"'))
    expect(script).not.toContain('grep "Developer ID Application" | head -1')
  })

  it("signs as the one team APPLE_TEAM_ID names and asserts it on what it signed", () => {
    expect(script).toContain('source "$SCRIPT_DIR/macos-signing-identity.sh"')
    expect(at("require_apple_team_id")).toBeLessThan(at('sign-sidecar-macos.sh" "$SIDECAR"'))
    expect(at("resolve_signing_identity")).toBeLessThan(at('-name "*.dylib"'))
    expect(at('assert_signed_by_team "$APP_PATH"')).toBeGreaterThan(
      at('--entitlements "$ENTITLEMENTS"'),
    )
    expect(at('assert_signed_by_team "$SIDECAR"')).toBeGreaterThan(
      at('--entitlements "$ENTITLEMENTS"'),
    )
  })

  it("hardens and timestamps the outer bundle with the app entitlements", () => {
    expect(script).toContain("--options runtime")
    expect(script).toContain("--timestamp")
    expect(script).toContain('ENTITLEMENTS="$SCRIPT_DIR/entitlements-app.plist"')
  })

  it("verifies after signing, not before", () => {
    expect(at('--entitlements "$ENTITLEMENTS"')).toBeLessThan(
      at("codesign --verify --deep --strict"),
    )
  })

  it("verifies the embedded sidecar survived the outer signature", () => {
    expect(script).toContain("Contents/MacOS/liaison-sidecar")
  })

  it("notarizes in the ditto, submit --wait, staple, re-zip order", () => {
    const zip = at("ditto -c -k --keepParent")
    const submit = at("xcrun notarytool submit")
    const wait = at("--wait")
    const staple = at("xcrun stapler staple")
    expect(zip).toBeLessThan(submit)
    expect(submit).toBeLessThan(staple)
    expect(wait).toBeGreaterThan(submit)
    expect(script.lastIndexOf("ditto -c -k --keepParent")).toBeGreaterThan(staple)
  })

  it("reads the Apple credentials under the names the monorepo script documents", () => {
    for (const name of ["APPLE_ID", "APPLE_APP_PASSWORD", "APPLE_TEAM_ID"]) {
      expect(script).toContain(name)
    }
    // A keychain profile is the alternative on a developer Mac, where the
    // credentials are already stored and must not be re-typed.
    expect(script).toContain("--keychain-profile")
  })

  it("never echoes a credential", () => {
    for (const secret of ["APPLE_APP_PASSWORD", "MACOS_CERTIFICATE_PWD", "MACOS_KEYCHAIN_PWD"]) {
      expect(script).not.toContain(`echo "$${secret}"`)
      expect(script).not.toContain(`echo $${secret}`)
    }
  })

  it("stops rather than shipping an unnotarized app by accident", () => {
    // Skipping notarization has to be asked for, in writing.
    expect(script).toContain("--no-notarize")
    expect(script).toContain("set -euo pipefail")
  })
})

describe("the outer app entitlements", () => {
  const plist = readFileSync(path.join(CI, "entitlements-app.plist"), "utf8")
  const keys = [...plist.replace(/<!--[\s\S]*?-->/g, "").matchAll(/<key>([^<]+)<\/key>/g)].map(
    (match) => match[1],
  )

  it("grants the shell no JIT: the JIT lives in the sidecar, in its own plist", () => {
    expect(keys).not.toContain("com.apple.security.cs.allow-jit")
    expect(keys).not.toContain("com.apple.security.cs.allow-unsigned-executable-memory")
  })

  it("grants no library validation bypass", () => {
    expect(keys).not.toContain("com.apple.security.cs.disable-library-validation")
  })

  it("is a distinct file from the sidecar's", () => {
    expect(plist).not.toEqual(readFileSync(path.join(CI, "entitlements-sidecar.plist"), "utf8"))
  })

  it("grants audio input, which dictation records through (S9), and no other device", () => {
    // Under the hardened runtime a missing audio-input grant makes
    // getUserMedia fail silently in the web view, with no prompt at all. The
    // grant sits on the OUTER app only: the sidecar never records.
    expect(keys).toContain("com.apple.security.device.audio-input")
    expect(keys.filter((key) => key?.startsWith("com.apple.security.device."))).toEqual([
      "com.apple.security.device.audio-input",
    ])
  })
})

describe("the macOS Info.plist merged into the app", () => {
  // Tauri merges src-tauri/Info.plist into the Info.plist it generates, both
  // for the bundle and for the dev binary's embedded plist. macOS asks for the
  // microphone with this text; without it the request is refused outright.
  const SRC_TAURI = path.join(import.meta.dir, "src-tauri")
  const INFO = path.join(SRC_TAURI, "Info.plist")

  /** Top level `<key>`/`<string>` pairs, comments ignored (no plutil: the
   *  desktop tests also run on Linux and Windows runners). */
  function stringEntries(file: string): Record<string, string> {
    const body = readFileSync(file, "utf8").replace(/<!--[\s\S]*?-->/g, "")
    const found: Record<string, string> = {}
    for (const [, key, value] of body.matchAll(
      /<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/g,
    )) {
      if (key !== undefined && value !== undefined) found[key] = value
    }
    return found
  }

  it("exists beside tauri.conf.json, where the bundler and codegen read it", () => {
    expect(existsSync(INFO)).toBe(true)
  })

  it("carries the microphone usage text and nothing the generated plist owns", () => {
    const body = readFileSync(INFO, "utf8").replace(/<!--[\s\S]*?-->/g, "")
    expect([...body.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1])).toEqual([
      "NSMicrophoneUsageDescription",
    ])
    const text = stringEntries(INFO).NSMicrophoneUsageDescription ?? ""
    expect(text.length).toBeGreaterThan(20)
    expect(text.toLowerCase()).toContain("dictat")
  })
})

describe("the macOS signing step", () => {
  const steps = loadDesktopReleaseWorkflow().jobs["build-macos"].steps
  const sign = step(steps, "Sign and notarize the app")

  it("calls the script with the built bundle", () => {
    expect(sign.run).toContain("apps/desktop/ci/sign-app-macos.sh")
    expect(sign.run).toContain("Liaison.app")
  })

  it("takes every credential from a named secret", () => {
    expect(sign.env).toEqual({
      MACOS_CERTIFICATE_P12: secretRef("MACOS_CERTIFICATE_P12"),
      MACOS_CERTIFICATE_PWD: secretRef("MACOS_CERTIFICATE_PWD"),
      MACOS_KEYCHAIN_PWD: secretRef("MACOS_KEYCHAIN_PWD"),
      APPLE_ID: secretRef("APPLE_ID"),
      APPLE_APP_PASSWORD: secretRef("APPLE_APP_PASSWORD"),
      APPLE_TEAM_ID: secretRef("APPLE_TEAM_ID"),
    })
  })

  it("runs after the bundle is built and the sidecar is already signed", () => {
    const index = stepIndex(steps, "Sign and notarize the app")
    expect(index).toBeGreaterThan(stepIndex(steps, "Build the app bundle"))
    expect(index).toBeGreaterThan(stepIndex(steps, "Sign sidecar binaries"))
  })
})
