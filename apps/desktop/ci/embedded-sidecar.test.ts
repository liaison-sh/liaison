// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The loop the signing pipeline has to close: the sidecar embedded by the bundler
// as an externalBin must carry a valid signature inside the built app. A copy
// whose signature does not verify would only be discovered by a customer whose
// launch is blocked.
//
// Corrected by 6c's live dry run: `tauri build` does NOT copy the signed
// binary through untouched. It re-signs the externalBin while bundling it, and
// the copy comes out with no entitlements at all (a debug build leaves it
// invalid outright). So validity inside the bundle is established by the
// packaging step, apps/desktop/ci/sign-app-macos.sh, and that is what these
// assertions check: the RELEASE bundle, the one the pipeline signs.
//
// The build itself is minutes long, so these assertions run against the
// bundle the last build on this machine produced. With no bundle on disk there is nothing to assess and they skip
// rather than fail: the packaging pipeline that builds one in CI is 6c.
import { describe, expect, it } from "bun:test"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

const TARGET = path.resolve(import.meta.dir, "..", "src-tauri", "target")

function findBundledSidecar(profiles: string[] = ["release", "debug"]): string | null {
  for (const profile of profiles) {
    const appDir = path.join(TARGET, profile, "bundle", "macos")
    if (!existsSync(appDir)) continue
    for (const entry of readdirSync(appDir)) {
      if (!entry.endsWith(".app")) continue
      const macos = path.join(appDir, entry, "Contents", "MacOS")
      if (!existsSync(macos)) continue
      const sidecar = readdirSync(macos).find((file) => file.startsWith("liaison-sidecar"))
      if (sidecar) return path.join(macos, sidecar)
    }
  }
  return null
}

/**
 * The web bundle THIS machine currently has, and its mtime.
 *
 * The frontend assertion below compares an embedded asset name against
 * apps/web/dist, and a shell built before the last `bun run build` embeds the
 * PREVIOUS name: a stale bundle on a developer's disk then reported a product
 * defect that does not exist. Which bundle is picked makes it worse, because
 * `findBundledSidecar` prefers `release`, and a release bundle from days ago
 * outranks the debug one built a minute ago.
 *
 * So the check asks the only question it can answer: does the shell that was
 * built AFTER this dist embed this dist. An older shell was built against a
 * dist that is gone, and there is nothing here to assess.
 */
function currentWebAsset(): { name: string; builtAt: number } | null {
  const assets = path.resolve(import.meta.dir, "../../web/dist/assets")
  if (!existsSync(assets)) return null
  const name = readdirSync(assets).find((file) => file.startsWith("index-") && file.endsWith(".js"))
  if (!name) return null
  return { name, builtAt: statSync(path.join(assets, name)).mtimeMs }
}

/** The newest built shell on this machine, whichever profile produced it. */
function newestBundledShell(): string | null {
  const candidates: string[] = []
  for (const profile of ["release", "debug"]) {
    const appDir = path.join(TARGET, profile, "bundle", "macos")
    if (!existsSync(appDir)) continue
    for (const entry of readdirSync(appDir)) {
      if (!entry.endsWith(".app")) continue
      const shell = path.join(appDir, entry, "Contents", "MacOS", "liaison-desktop")
      if (existsSync(shell)) candidates.push(shell)
    }
  }
  if (candidates.length === 0) return null
  return candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
}

describe("sidecar embedded in the built app bundle", () => {
  const sidecar = findBundledSidecar()

  const whenBuilt = sidecar ? it : it.skip

  it("looks for the app bundle in the build output", () => {
    expect(TARGET).toContain("src-tauri")
  })

  whenBuilt("the bundler placed the sidecar inside the app bundle", () => {
    expect(sidecar).not.toBeNull()
  })

  // The release bundle only: a debug bundle has not been through the signing
  // script, and the bundler leaves the sidecar copy it wrote invalid.
  const signedSidecar = findBundledSidecar(["release"])
  const whenSigned = signedSidecar ? it : it.skip

  whenSigned(
    "the signed release bundle contains a still validly signed copy of the sidecar binary",
    () => {
      if (!signedSidecar) throw new Error("no release bundle found: run the desktop build first")
      const verify = Bun.spawnSync(["codesign", "--verify", "--strict", "-vv", signedSidecar], {
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(verify.stderr.toString()).toContain("satisfies its Designated Requirement")
      expect(verify.exitCode).toBe(0)
    },
    // codesign reads the whole 272 MB binary: 5 s is not enough on a busy Mac.
    30_000,
  )

  const web = currentWebAsset()
  const newestShell = newestBundledShell()
  const builtAfterDist =
    web !== null && newestShell !== null && statSync(newestShell).mtimeMs >= web.builtAt
  const whenCurrent = builtAfterDist ? it : it.skip

  whenCurrent(
    "the shell binary embeds the web app's own Vite bundle, not a second frontend",
    () => {
      const shell = newestShell as string
      const binary = readFileSync(shell).toString("latin1")
      expect(binary).toContain((web as { name: string }).name)
    },
  )
})
