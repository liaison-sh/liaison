// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Android half of ios-config.test.ts. Same reason: the manifest edit lives
// in a generated file, so without this a regeneration drops the deep link and
// nothing fails.
//
// This machine has no Android SDK and no JDK, so no Gradle build was run and
// nothing here claims one passed: these are assertions about the generated
// FILES, which `cap add android` produces on its own.

import { describe, expect, it } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

const ROOT = import.meta.dir
const ANDROID = path.join(ROOT, "android")
const MANIFEST = path.join(ANDROID, "app", "src", "main", "AndroidManifest.xml")

/** Every `<intent-filter>` block in the manifest, as raw text. */
function intentFilters(manifest: string): string[] {
  return [...manifest.matchAll(/<intent-filter[\s\S]*?<\/intent-filter>/g)].map((m) => m[0])
}

describe("android platform config", () => {
  it("generated the native project", () => {
    expect(existsSync(MANIFEST)).toBe(true)
    expect(existsSync(path.join(ANDROID, "app", "build.gradle"))).toBe(true)
  })

  it("carries the mobile application id", () => {
    const gradle = readFileSync(path.join(ANDROID, "app", "build.gradle"), "utf8")
    expect(gradle).toContain('applicationId "sh.liaison.mobile"')
  })

  it("declares the liaison scheme intent filter on the main activity", () => {
    const manifest = readFileSync(MANIFEST, "utf8")
    const deepLink = intentFilters(manifest).find((f) => f.includes('android:scheme="liaison"'))
    expect(deepLink).toBeDefined()
    expect(deepLink).toContain('android:name="android.intent.action.VIEW"')
    expect(deepLink).toContain('android:name="android.intent.category.DEFAULT"')
    expect(deepLink).toContain('android:name="android.intent.category.BROWSABLE"')
  })

  it("keeps the generated launcher filter intact", () => {
    // The deep link is a SECOND filter. Folding the VIEW action into the
    // launcher filter is the classic way to lose the app's home screen icon.
    const launcher = intentFilters(readFileSync(MANIFEST, "utf8")).find((f) =>
      f.includes("android.intent.category.LAUNCHER"),
    )
    expect(launcher).toBeDefined()
    expect(launcher).toContain('android:name="android.intent.action.MAIN"')
    expect(launcher).not.toContain('android:scheme="liaison"')
  })

  it("asks for the microphone dictation records through (S9)", () => {
    // Capacitor's BridgeWebChromeClient turns the web view's audio capture
    // request into the RECORD_AUDIO runtime prompt, but only for a permission
    // the manifest declares; MODIFY_AUDIO_SETTINGS is what WebRTC capture in
    // the Android web view needs beside it.
    const permissions = [
      ...readFileSync(MANIFEST, "utf8").matchAll(/<uses-permission\s+android:name="([^"]+)"/g),
    ].map((m) => m[1])
    expect(permissions).toContain("android.permission.RECORD_AUDIO")
    expect(permissions).toContain("android.permission.MODIFY_AUDIO_SETTINGS")
    expect(permissions).not.toContain("android.permission.CAMERA")
  })

  it("claims no https app link: the liaison scheme is the only way in", () => {
    // No universal links on either platform. An auto verified filter needs an
    // assetlinks.json served from the operator's own host, every fork runs
    // its own, and a host named here is a customer name in a binary every
    // fork ships.
    const manifest = readFileSync(MANIFEST, "utf8")
    expect(
      intentFilters(manifest).find((f) => f.includes('android:scheme="https"')),
    ).toBeUndefined()
    expect(manifest).not.toContain("autoVerify")
    expect(existsSync(path.join(ROOT, "well-known"))).toBe(false)
  })
})

describe("android release signing", () => {
  const gradle = readFileSync(path.join(ANDROID, "app", "build.gradle"), "utf8")

  it("reads the upload keystore from the environment, never from a file in the tree", () => {
    // A keystore or a password committed here is a key anybody with the
    // repository can sign a Play upload with.
    expect(gradle).toContain("signingConfigs")
    for (const name of [
      "LIAISON_KEYSTORE_FILE",
      "LIAISON_KEYSTORE_PASSWORD",
      "LIAISON_KEYSTORE_ALIAS",
      "LIAISON_KEYSTORE_ALIAS_PASSWORD",
    ]) {
      expect(gradle, `${name} is not read from the environment`).toContain(
        `System.getenv("${name}")`,
      )
    }
    expect(gradle).not.toMatch(/storePassword\s+["'][^"']/)
    expect(gradle).not.toMatch(/keyPassword\s+["'][^"']/)
  })

  it("builds unsigned rather than half signed when the keystore is absent", () => {
    // The whole credential set or none of it: a release build that picks up
    // three of four values enters a signing step it cannot finish.
    expect(gradle).toMatch(/if\s*\(\s*hasUploadKeystore\s*\)/)
    expect(gradle).toContain("UNSIGNED release build")
  })
})
