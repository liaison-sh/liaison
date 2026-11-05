// SPDX-License-Identifier: FSL-1.1-ALv2
//
// 6a owns the sidecar signing script, entitlements included. The workflow
// CALLS it; it never re-implements the codesign invocation inline, because a
// second copy of that command is a second place the entitlements, the
// hardened runtime flag or the timestamp can go missing.
import { describe, expect, it } from "bun:test"
import { existsSync } from "node:fs"
import path from "node:path"
import { loadDesktopReleaseWorkflow, REPO_ROOT, secretRef, step, stepIndex } from "./ci/workflow"

const steps = loadDesktopReleaseWorkflow().jobs["build-macos"].steps
const signSidecar = step(steps, "Sign sidecar binaries")

describe("the macOS sidecar signing step", () => {
  it("calls 6a's script rather than a codesign line of its own", () => {
    expect(signSidecar.run).toContain("apps/desktop/ci/sign-sidecar-macos.sh")
    expect(signSidecar.run).not.toContain("codesign --force")
    expect(signSidecar.run).not.toContain("--entitlements")
  })

  it("points at the externalBin directory the bundler reads", () => {
    expect(signSidecar.run).toContain("apps/desktop/src-tauri/binaries")
  })

  it("refuses to pass silently when it signed nothing", () => {
    // An empty binaries directory means the bundle is about to embed an
    // unsigned sidecar, which only shows up as a Gatekeeper refusal later.
    expect(signSidecar.run).toContain("signed=0")
  })

  it("takes its signing material from named secrets only", () => {
    expect(signSidecar.env).toEqual({
      MACOS_CERTIFICATE_P12: secretRef("MACOS_CERTIFICATE_P12"),
      MACOS_CERTIFICATE_PWD: secretRef("MACOS_CERTIFICATE_PWD"),
      MACOS_KEYCHAIN_PWD: secretRef("MACOS_KEYCHAIN_PWD"),
      // The one team the sidecar may be signed as: the runner's keychain can
      // hold other teams' Developer ID certificates, and the script refuses
      // to sign without it.
      APPLE_TEAM_ID: secretRef("APPLE_TEAM_ID"),
    })
  })

  it("runs before the bundle that embeds the sidecar is built", () => {
    expect(stepIndex(steps, "Sign sidecar binaries")).toBeLessThan(
      stepIndex(steps, "Build the app bundle"),
    )
  })

  it("names a script that exists", () => {
    expect(existsSync(path.join(REPO_ROOT, "apps/desktop/ci/sign-sidecar-macos.sh"))).toBe(true)
  })
})
