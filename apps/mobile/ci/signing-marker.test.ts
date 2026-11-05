// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The store signing credentials do not exist yet (ws_07's environment facts:
// no Apple distribution certificate, no upload keystore, zero Actions secrets
// on this repository). So the interesting case is the one that will be true on
// every run until they do: what a job builds when it cannot sign.
//
// The answer pinned here is: an UNSIGNED artifact, labelled unsigned, naming
// every credential it lacked. The two failures this refuses are a job that
// dies with a keychain error nobody can read, and a job that signs with
// something placeholder shaped and hands back an artifact that looks like a
// release.

import { describe, expect, it } from "bun:test"
import {
  ANDROID_SIGNING_SECRETS,
  IOS_SIGNING_SECRETS,
  resolveSigningMarker,
  SIGNING_MARKER_FILES,
} from "./signing-marker"

const full = (names: readonly string[]) =>
  Object.fromEntries(names.map((name) => [name, `value-for-${name}`]))

describe("the signing marker", () => {
  it("names a marker file for each platform", () => {
    expect(Object.keys(SIGNING_MARKER_FILES).sort()).toEqual(["android", "ios"])
  })

  it("is signed only when every credential is present", () => {
    for (const [platform, names] of [
      ["ios", IOS_SIGNING_SECRETS],
      ["android", ANDROID_SIGNING_SECRETS],
    ] as const) {
      const marker = resolveSigningMarker(platform, full(names))
      expect(marker.signed).toBe(true)
      expect(marker.missing).toEqual([])
      expect(marker.reason).toContain("every credential")
    }
  })

  it("builds unsigned and names every missing credential, never a subset", () => {
    const env = full(IOS_SIGNING_SECRETS)
    delete env[IOS_SIGNING_SECRETS[0]]
    delete env[IOS_SIGNING_SECRETS[1]]
    const marker = resolveSigningMarker("ios", env)
    expect(marker.signed).toBe(false)
    expect(marker.missing).toEqual([IOS_SIGNING_SECRETS[0], IOS_SIGNING_SECRETS[1]])
    expect(marker.reason).toContain(IOS_SIGNING_SECRETS[0])
    expect(marker.reason).toContain(IOS_SIGNING_SECRETS[1])
  })

  it("refuses a partial credential set rather than signing with what it has", () => {
    // Half a credential set is the dangerous case: enough to start a signing
    // step, not enough to finish one, and the failure arrives as a keychain
    // error in the middle of a release.
    const env = full(ANDROID_SIGNING_SECRETS)
    delete env[ANDROID_SIGNING_SECRETS[ANDROID_SIGNING_SECRETS.length - 1]]
    expect(resolveSigningMarker("android", env).signed).toBe(false)
  })

  it("treats an empty or placeholder value as absent", () => {
    for (const placeholder of ["", "   ", "changeme", "TODO", "xxx"]) {
      const env = full(IOS_SIGNING_SECRETS)
      env[IOS_SIGNING_SECRETS[0]] = placeholder
      const marker = resolveSigningMarker("ios", env)
      expect(marker.signed, `placeholder ${JSON.stringify(placeholder)}`).toBe(false)
      expect(marker.missing).toContain(IOS_SIGNING_SECRETS[0])
    }
  })

  it("never copies a credential value into the marker", () => {
    // The marker is uploaded beside the artifact.
    const marker = resolveSigningMarker("ios", full(IOS_SIGNING_SECRETS))
    const serialized = JSON.stringify(marker)
    for (const name of IOS_SIGNING_SECRETS) {
      expect(serialized).not.toContain(`value-for-${name}`)
    }
  })
})
