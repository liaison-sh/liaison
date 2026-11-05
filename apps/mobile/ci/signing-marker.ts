#!/usr/bin/env bun
// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Whether a store build could be signed, decided in one place and written down
// beside the artifact.
//
// The rule is 6c's, carried over from the desktop Windows job: a missing
// credential makes the job build an UNSIGNED artifact and SAY SO, loudly, in
// the log and in a marker file that travels with the build. It never fails
// quietly, and it never signs with whatever happened to be in the environment.
// Half a credential set is the worst of the three outcomes: enough to enter a
// signing step, not enough to leave one, and the failure then arrives as an
// unreadable keychain or keytool error in the middle of a release.
//
// No credential VALUE is ever read here beyond asking whether it is present
// and non placeholder, and none is written into the marker: the marker is an
// artifact anyone with the run can download.
//
// Usage: bun ci/signing-marker.ts --platform ios|android [--out <file>]

import { writeFileSync } from "node:fs"
import path from "node:path"

export type SigningPlatform = "ios" | "android"

/**
 * The App Store distribution set: the certificate and its password, the
 * provisioning profile, the keychain the certificate is imported into, and the
 * App Store Connect API key the upload authenticates with.
 */
export const IOS_SIGNING_SECRETS = [
  "APPLE_DISTRIBUTION_CERTIFICATE_P12",
  "APPLE_DISTRIBUTION_CERTIFICATE_PASSWORD",
  "APPLE_KEYCHAIN_PASSWORD",
  "APPLE_PROVISIONING_PROFILE",
  "APPLE_TEAM_ID",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER_ID",
  "APPLE_API_PRIVATE_KEY",
] as const

/** The Play upload keystore set. */
export const ANDROID_SIGNING_SECRETS = [
  "ANDROID_KEYSTORE_BASE64",
  "ANDROID_KEYSTORE_PASSWORD",
  "ANDROID_KEYSTORE_ALIAS",
  "ANDROID_KEYSTORE_ALIAS_PASSWORD",
] as const

export const SIGNING_SECRETS: Record<SigningPlatform, readonly string[]> = {
  ios: IOS_SIGNING_SECRETS,
  android: ANDROID_SIGNING_SECRETS,
}

/** Where each job writes its marker, relative to apps/mobile. */
export const SIGNING_MARKER_FILES: Record<SigningPlatform, string> = {
  ios: "ci/ios-signing-marker.json",
  android: "ci/android-signing-marker.json",
}

/**
 * Values that are present and mean nothing. A secret that was created to
 * silence a check is not a credential, and a build signed with one is an
 * artifact that looks signed to everything except the store.
 */
const PLACEHOLDER = /^(?:|changeme|change-me|todo|placeholder|none|null|undefined|x+)$/i

export interface SigningMarker {
  platform: SigningPlatform
  signed: boolean
  /** Readable in the log and in the marker. Never carries a value. */
  reason: string
  missing: string[]
}

function present(value: string | undefined): boolean {
  return typeof value === "string" && !PLACEHOLDER.test(value.trim())
}

export function resolveSigningMarker(
  platform: SigningPlatform,
  env: Record<string, string | undefined>,
): SigningMarker {
  const required = SIGNING_SECRETS[platform]
  const missing = required.filter((name) => !present(env[name]))
  if (missing.length === 0) {
    return {
      platform,
      signed: true,
      reason: `every credential this ${platform} build needs is present`,
      missing: [],
    }
  }
  return {
    platform,
    signed: false,
    reason:
      `UNSIGNED ${platform} build: ${missing.length} of ${required.length} credentials are ` +
      `absent or placeholder shaped (${missing.join(", ")}). The artifact is real and it is ` +
      "not signed, so it cannot be submitted to the store.",
    missing: [...missing],
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const platform = argv[argv.indexOf("--platform") + 1] as SigningPlatform
  if (platform !== "ios" && platform !== "android") {
    console.log("usage: bun ci/signing-marker.ts --platform ios|android [--out <file>]")
    process.exit(2)
  }
  const marker = resolveSigningMarker(platform, process.env)
  const outIndex = argv.indexOf("--out")
  const out =
    outIndex >= 0
      ? argv[outIndex + 1]
      : path.join(import.meta.dir, "..", SIGNING_MARKER_FILES[platform])
  writeFileSync(out, `${JSON.stringify(marker, null, 2)}\n`)
  if (marker.signed) {
    console.log(`${platform}: ${marker.reason}`)
  } else {
    // Loud in the job summary, not one line in the middle of a build log.
    console.log(`::warning title=${platform} build is unsigned::${marker.reason}`)
    console.log(`${platform}: ${marker.reason}`)
  }
  console.log(`marker written to ${out}`)
}
