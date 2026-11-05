// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The DMG is assembled by hand, with hdiutil, and not by tauri's bundler:
// `tauri build`'s own bundle_dmg.sh failed on this machine AFTER the .app had
// been written (recorded in the 6a signing spike), so the disk image step is
// this pipeline's, and the app step is tauri's.
//
// What is pinned here is the order and the two refusals. A DMG built from an
// unsigned or unstapled .app looks exactly like a good one until a customer
// double clicks it.
import { describe, expect, it } from "bun:test"
import { readFileSync, statSync } from "node:fs"
import path from "node:path"
import { loadDesktopReleaseWorkflow, secretRef, step, stepIndex } from "./ci/workflow"

const SCRIPT = path.join(import.meta.dir, "ci", "make-dmg.sh")
const script = readFileSync(SCRIPT, "utf8")

function at(marker: string): number {
  const index = script.indexOf(marker)
  expect(index, `marker not in make-dmg.sh: ${marker}`).toBeGreaterThanOrEqual(0)
  return index
}

describe("the DMG assembly script", () => {
  it("is executable", () => {
    expect(statSync(SCRIPT).mode & 0o111).toBeGreaterThan(0)
  })

  it("creates the image, then notarizes it, then staples it", () => {
    expect(at("hdiutil create")).toBeLessThan(at("xcrun notarytool submit"))
    expect(at("xcrun notarytool submit")).toBeLessThan(at("xcrun stapler staple"))
  })

  it("verifies the image it just wrote", () => {
    expect(at("hdiutil verify")).toBeGreaterThan(at("hdiutil create"))
  })

  it("refuses an app that is not signed", () => {
    expect(at("codesign --verify --strict")).toBeLessThan(at("hdiutil create"))
    expect(script).toContain("is not signed")
  })

  it("refuses an app signed by any team but APPLE_TEAM_ID's", () => {
    expect(at('assert_signed_by_team "$APP_PATH"')).toBeLessThan(at("hdiutil create"))
    expect(script).toContain("refusing to package it")
  })

  it("refuses an app with no notarization ticket unless told not to notarize", () => {
    expect(at("xcrun stapler validate")).toBeLessThan(at("hdiutil create"))
    expect(script).toContain("--no-notarize")
  })

  it("names the image after the version in the built app, not a second source", () => {
    // A version typed twice is a version that disagrees with itself.
    expect(script).toContain("CFBundleShortVersionString")
    // The shape itself is derived by ci/artifact-names.ts and asserted in
    // artifact-names.test.ts. What this file pins is that the script ASKS for
    // it, with the version and arch it measured, rather than spelling the name
    // a second time: two spellings is how the image and the upload glob drift.
    expect(script).toContain('artifact-names.ts" name macos dmg "$VERSION" "$ARCH"')
    expect(script).toContain('DMG_PATH="$OUT_DIR/$DMG_NAME"')
  })

  it("names the image after the slices in the app, not the runner's CPU", () => {
    // A universal app built on an arm64 runner named after `uname -m` reads
    // as Apple silicon only, and Intel users skip the one image that runs.
    expect(script).toContain('lipo -archs "$APP_PATH/Contents/MacOS/$EXECUTABLE"')
    expect(script).toContain('ARCH="universal"')
    expect(script).toContain('ARCH="aarch64"')
    expect(script).not.toContain("uname -m")
  })

  it("never echoes a credential", () => {
    for (const secret of ["APPLE_APP_PASSWORD", "MACOS_CERTIFICATE_PWD"]) {
      expect(script).not.toContain(`echo "$${secret}"`)
      expect(script).not.toContain(`echo $${secret}`)
    }
  })
})

describe("the DMG step", () => {
  const steps = loadDesktopReleaseWorkflow().jobs["build-macos"].steps
  const dmg = step(steps, "Package DMG")

  it("calls the script", () => {
    expect(dmg.run).toContain("apps/desktop/ci/make-dmg.sh")
  })

  it("runs after the app is signed and stapled", () => {
    expect(stepIndex(steps, "Package DMG")).toBeGreaterThan(
      stepIndex(steps, "Sign and notarize the app"),
    )
  })

  it("takes its notarization credentials from named secrets", () => {
    expect(dmg.env).toEqual({
      APPLE_ID: secretRef("APPLE_ID"),
      APPLE_APP_PASSWORD: secretRef("APPLE_APP_PASSWORD"),
      APPLE_TEAM_ID: secretRef("APPLE_TEAM_ID"),
    })
  })
})
