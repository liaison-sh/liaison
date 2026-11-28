// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { SHELL_BRIDGE_RANGE } from "../../apps/web/src/lib/shell-bridge-range"
import { computeWebBuildId, WEB_BUILD_ID_TOKEN } from "../../apps/web/src/lib/web-build-id-plugin"
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
 * the id, a chunk, a css asset), what Vite copied from public/, the app frame
 * runtime written after the build, and build-id.txt.
 */
function fixtureDist(): { dist: string; publicDir: string; id: string } {
  const bundled = {
    "index.html": `<html><head><meta name="liaison-web-build" content="${WEB_BUILD_ID_TOKEN}"></head></html>`,
    "assets/index-abc.js": "console.log(1)",
    "assets/index-def.css": "body{}",
  }
  const id = computeWebBuildId(
    Object.fromEntries(
      Object.entries(bundled).map(([fileName, source]) => [
        fileName,
        { type: "asset" as const, fileName, source },
      ]),
    ),
  )
  const dist = tmp()
  for (const [rel, text] of Object.entries(bundled)) {
    write(dist, rel, text.split(WEB_BUILD_ID_TOKEN).join(id))
  }
  const publicDir = tmp()
  write(publicDir, "favicon.svg", "<svg/>")
  write(publicDir, "_app-runtime/solid-js.js", "export {}")
  write(dist, "favicon.svg", "<svg/>")
  write(dist, "_app-runtime/solid-js.js", "export {}")
  write(dist, "app-frame-runtime.js", "(()=>{})()")
  write(dist, "build-id.txt", `${id}\n`)
  return { dist, publicDir, id }
}

describe("buildShellManifest", () => {
  it("lists every file with its sha256 and checks the build id against the plugin's rule", async () => {
    const { dist, publicDir, id } = fixtureDist()
    const manifest = await buildShellManifest({
      mode: "desktop",
      distDir: dist,
      commit: COMMIT,
      seq: 1_764_300_000,
      liaisonVersion: "nightly-20261128",
      publicDir,
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
    const ma = await buildShellManifest({ ...input, distDir: a.dist, publicDir: a.publicDir })
    const mb = await buildShellManifest({ ...input, distDir: b.dist, publicDir: b.publicDir })
    expect(manifestBytes(ma)).toBe(manifestBytes(mb))
  })

  it("refuses a build whose bundled files do not hash to its build-id.txt", async () => {
    const { dist, publicDir } = fixtureDist()
    write(dist, "assets/index-abc.js", "console.log(2)")
    await expect(
      buildShellManifest({
        mode: "desktop",
        distDir: dist,
        commit: COMMIT,
        seq: 1,
        liaisonVersion: "dev",
        publicDir,
      }),
    ).rejects.toThrow(/hash to/)
  })

  it("refuses a build with no build id, and a malformed commit", async () => {
    const { dist, publicDir } = fixtureDist()
    const base = {
      mode: "desktop" as const,
      distDir: dist,
      seq: 1,
      liaisonVersion: "dev",
      publicDir,
    }
    await expect(buildShellManifest({ ...base, commit: "abc" })).rejects.toThrow(/commit/)
    rmSync(join(dist, "build-id.txt"))
    await expect(buildShellManifest({ ...base, commit: COMMIT })).rejects.toThrow(/build-id.txt/)
  })
})
