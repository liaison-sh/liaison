// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Tests that install or read a bundled app's SHIPPED form need its frozen
// `.liaisonapp`, which is a build output (gitignored `bundled-apps/<name>/dist`,
// `app-catalog/`). A checkout that never ran the build (a fresh worktree, a CI
// box) has none, and those tests failed on a missing directory rather than on
// anything they assert. These helpers build what is missing, the same way the
// image build does (`--skip-sign`: first-party bundles ship unsigned inside the
// image), and reuse what is already there.
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const REPO = join(import.meta.dir, "..", "..", "..", "..", "..")

function run(cmd: string[], what: string): void {
  const res = spawnSync(cmd[0]!, cmd.slice(1), { cwd: REPO, encoding: "utf8" })
  if (res.status !== 0) {
    throw new Error(`${what} failed (exit ${res.status}):\n${res.stdout}\n${res.stderr}`)
  }
}

/**
 * The path of `bundled-apps/<name>/dist/<name>-<version>.liaisonapp` for the
 * version its source manifest declares, building it first when it is absent.
 * Pinned to the source version so a stale tarball from an older build is never
 * what the test installs.
 */
export function ensureBundledAppBuilt(name: string): string {
  const manifest = JSON.parse(
    readFileSync(join(REPO, "bundled-apps", name, "app.manifest.json"), "utf8"),
  ) as { version: string }
  const tarball = join(REPO, "bundled-apps", name, "dist", `${name}-${manifest.version}.liaisonapp`)
  if (!existsSync(tarball)) {
    run(
      [
        "bash",
        join(REPO, "scripts", "build-bundled-app.sh"),
        name,
        "--skip-sign",
        "--skip-typecheck",
      ],
      `building bundled app ${name}`,
    )
  }
  if (!existsSync(tarball)) throw new Error(`build of ${name} did not produce ${tarball}`)
  return tarball
}

/** Whether `dir` holds at least one `.liaisonapp`. */
export function catalogHasBundles(dir: string): boolean {
  try {
    return readdirSync(dir).some((f) => f.endsWith(".liaisonapp"))
  } catch {
    return false
  }
}

/**
 * A freshly built first-party app catalog in a temp directory, exactly as
 * `scripts/build-app-catalog.ts` bakes it into the image. The caller points
 * LIAISON_APP_CATALOG_DIR at it and removes it afterwards.
 */
export function buildTempAppCatalog(): string {
  const dir = mkdtempSync(join(tmpdir(), "app-catalog-"))
  run(
    ["bun", "run", join(REPO, "scripts", "build-app-catalog.ts"), "--out-dir", dir],
    "building the app catalog",
  )
  if (!catalogHasBundles(dir)) throw new Error(`build-app-catalog wrote no bundle to ${dir}`)
  return dir
}
