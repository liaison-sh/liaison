// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { clearBundleCache, isBundleLoadError, loadBundle } from "./bundle-loader"

// An app name with no `bundled-apps/<name>/handlers.ts`, so the source side
// channel never applies and the installed bundle file is what loads.
const root = mkdtempSync(join(tmpdir(), "bundle-loader-test-"))
const bundleDir = join(root, "zz-bundle-loader-fixture", "1.0.0")
const bundlePath = join(bundleDir, "bundle.js")

function writeBundle(body: string, mtime?: Date): void {
  writeFileSync(bundlePath, `${body}\nexport { handler };\n`)
  if (mtime) utimesSync(bundlePath, mtime, mtime)
}

describe("loadBundle cache", () => {
  beforeEach(() => {
    clearBundleCache()
    rmSync(root, { recursive: true, force: true })
    mkdirSync(bundleDir, { recursive: true })
  })
  afterAll(() => {
    clearBundleCache()
    rmSync(root, { recursive: true, force: true })
  })

  test("serves the new code when the bundle at the same path is replaced (same-version reinstall)", async () => {
    writeBundle(`function handler() { return "old" }`)
    const first = await loadBundle(bundlePath)
    expect(first).toContain(`"old"`)

    // Reinstall at the same version: same path, new content.
    writeBundle(`function handler() { return "new" }`)
    const second = await loadBundle(bundlePath)
    expect(second).toContain(`"new"`)
    expect(second).not.toContain(`"old"`)
  })

  test("detects a replacement even when size and mtime are unchanged", async () => {
    const stamp = new Date("2026-01-01T00:00:00Z")
    writeBundle(`function handler() { return "aaa" }`, stamp)
    expect(await loadBundle(bundlePath)).toContain(`"aaa"`)

    writeBundle(`function handler() { return "bbb" }`, stamp)
    expect(await loadBundle(bundlePath)).toContain(`"bbb"`)
  })

  test("returns the cached transform while the file is unchanged", async () => {
    writeBundle(`function handler() { return "same" }`)
    const first = await loadBundle(bundlePath)
    const second = await loadBundle(bundlePath)
    expect(second).toBe(first)
    expect(second).toContain("globalThis.handler = handler;")
  })

  test("serves the cached code while the file is briefly gone (uninstall/reinstall window)", async () => {
    writeBundle(`function handler() { return "kept" }`)
    const first = await loadBundle(bundlePath)
    rmSync(bundlePath)
    expect(await loadBundle(bundlePath)).toBe(first)
  })

  test("a missing bundle never loaded before fails as a bundle load error", async () => {
    rmSync(bundlePath, { force: true })
    const err = await loadBundle(bundlePath).then(
      () => null,
      (e: unknown) => e,
    )
    expect(isBundleLoadError(err)).toBe(true)
  })
})
