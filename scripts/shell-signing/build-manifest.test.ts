// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { stampWebBuildId, WEB_BUILD_ID_TOKEN } from "../../apps/web/scripts/stamp-build-id"
import { SHELL_BRIDGE_RANGE } from "../../apps/web/src/lib/shell-bridge-range"
import { SETTINGS_SCHEMA_VERSION } from "../../packages/app-sdk/src/app-settings"
import { sha256Hex } from "../../packages/shared/src/app-signing/encoding"
import { buildShellManifest, listFiles, manifestBytes } from "./build-manifest"

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "shell-manifest-"))
  dirs.push(d)
  return d
}

function write(root: string, rel: string, text: string) {
  mkdirSync(dirname(join(root, rel)), { recursive: true })
  writeFileSync(join(root, rel), text)
}

const COMMIT = "f".repeat(40)

/**
 * A dist shaped like a real one: what Rollup emitted (an index.html carrying
 * the placeholder, a chunk, a css asset), what Vite copied from public/, the
 * app frame runtime, stamped by the build's last step (build-id.txt).
 */
function fixtureDist(overrides: Record<string, string> = {}): { dist: string; id: string } {
  const files: Record<string, string> = {
    "index.html": `<html><head><meta name="liaison-web-build" content="${WEB_BUILD_ID_TOKEN}"></head></html>`,
    "assets/index-abc.js": "console.log(1)",
    "assets/index-def.css": "body{}",
    "favicon.svg": "<svg/>",
    "liaison-sw.js": "self.onfetch=null",
    "_app-runtime/solid-js.js": "export {}",
    "app-frame-runtime.js": "(()=>{})()",
    ...overrides,
  }
  const dist = tmp()
  for (const [rel, text] of Object.entries(files)) write(dist, rel, text)
  return { dist, id: stampWebBuildId(dist) }
}

describe("buildShellManifest", () => {
  it("lists every file with its sha256 and checks the build id against the plugin's rule", async () => {
    const { dist, id } = fixtureDist()
    const manifest = await buildShellManifest({
      mode: "desktop",
      distDir: dist,
      commit: COMMIT,
      seq: 1_764_300_000,
      liaisonVersion: "nightly-20261128",
    })
    expect(manifest.buildId).toBe(id)
    expect(Object.keys(manifest.files)).toEqual(listFiles(dist))
    expect(Object.keys(manifest.files)).toContain("build-id.txt")
    expect(Object.keys(manifest.files)).toContain("_app-runtime/solid-js.js")
    expect(manifest.files["assets/index-abc.js"]).toBe(
      await sha256Hex(new TextEncoder().encode("console.log(1)")),
    )
    expect(manifest.bridge).toEqual({ ...SHELL_BRIDGE_RANGE })
    expect(manifest.settingsSchema).toBe(SETTINGS_SCHEMA_VERSION)
    // Canonical bytes: keys sorted, no whitespace.
    const bytes = manifestBytes(manifest)
    expect(bytes.startsWith('{"bridge":')).toBe(true)
    expect(bytes).not.toContain(" ")
  })

  it("gives the same bytes for two copies of one build in different places", async () => {
    const a = fixtureDist()
    const b = fixtureDist()
    const input = { mode: "native" as const, commit: COMMIT, seq: 1, liaisonVersion: "v1.0.0" }
    const ma = await buildShellManifest({ ...input, distDir: a.dist })
    const mb = await buildShellManifest({ ...input, distDir: b.dist })
    expect(manifestBytes(ma)).toBe(manifestBytes(mb))
  })

  it("gets another build id when only a public/ file or only the app frame changed", async () => {
    const input = { mode: "desktop" as const, commit: COMMIT, seq: 1, liaisonVersion: "v1.0.0" }
    const base = await buildShellManifest({ ...input, distDir: fixtureDist().dist })
    const changes: Array<Record<string, string>> = [
      { "liaison-sw.js": "self.onfetch=undefined" },
      { "_app-runtime/solid-js.js": "export const a=1" },
      { "app-frame-runtime.js": "(()=>{1})()" },
    ]
    for (const change of changes) {
      const m = await buildShellManifest({ ...input, distDir: fixtureDist(change).dist })
      expect(m.buildId).not.toBe(base.buildId)
    }
  })

  it("refuses a build whose files do not hash to its build-id.txt, a public/ or frame file included", async () => {
    for (const rel of ["assets/index-abc.js", "liaison-sw.js", "app-frame-runtime.js"]) {
      const { dist } = fixtureDist()
      write(dist, rel, "tampered")
      await expect(
        buildShellManifest({
          mode: "desktop",
          distDir: dist,
          commit: COMMIT,
          seq: 1,
          liaisonVersion: "dev",
        }),
      ).rejects.toThrow(/hash to/)
    }
  })

  it("refuses a build with no build id, and a malformed commit", async () => {
    const { dist } = fixtureDist()
    const base = {
      mode: "desktop" as const,
      distDir: dist,
      seq: 1,
      liaisonVersion: "dev",
    }
    await expect(buildShellManifest({ ...base, commit: "abc" })).rejects.toThrow(/commit/)
    rmSync(join(dist, "build-id.txt"))
    await expect(buildShellManifest({ ...base, commit: COMMIT })).rejects.toThrow(/build-id.txt/)
  })
})
