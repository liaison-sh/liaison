// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shared steps of the bundled-app freeze round-trip tests
// (bundled-apps/<app>/src/build-roundtrip.test.ts in the "bundled-freeze" suite):
// run `scripts/build-bundled-app.sh <app> --skip-sign --skip-typecheck`, then
// list or read entries of the `.liaisonapp` tarball it wrote. Extracted entries
// go to a fresh temp dir that is removed before the read returns.
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const LIAISON_ROOT = join(import.meta.dir, "..", "..")
const SCRIPT = join(LIAISON_ROOT, "scripts", "build-bundled-app.sh")

/** The tarball the freeze writes for the app at `appDir`, named after its manifest version. */
export function freezeTarballPath(app: string, appDir: string): string {
  // Follow the MANIFEST version: freeze-app.ts names the tarball
  // `<manifest.name>-<manifest.version>.liaisonapp`.
  const version = (
    JSON.parse(readFileSync(join(appDir, "app.manifest.json"), "utf8")) as { version: string }
  ).version
  return join(appDir, "dist", `${app}-${version}.liaisonapp`)
}

/** Run the freeze for `app`; throws with the script's output when it exits non-zero. */
export function runFreeze(app: string, timeout: number): void {
  // Invoke via explicit `bash` rather than relying on the script's shebang:
  // bun:test's spawnSync doesn't always resolve `#!/usr/bin/env bash` from
  // its sandboxed PATH (manifests as `res.status === undefined`).
  const res = spawnSync("bash", [SCRIPT, app, "--skip-sign", "--skip-typecheck"], {
    cwd: LIAISON_ROOT,
    stdio: "pipe",
    timeout,
  })
  if (res.status !== 0) {
    throw new Error(
      `build-bundled-app.sh ${app} exit ${res.status}\n` +
        `error: ${res.error?.message ?? "none"}\n` +
        `stdout:\n${res.stdout?.toString() ?? ""}\n` +
        `stderr:\n${res.stderr?.toString() ?? ""}`,
    )
  }
}

/** The entry names in `tarball`. */
export function tarballEntries(tarball: string): string[] {
  return spawnSync("tar", ["-tzf", tarball]).stdout.toString().split("\n")
}

/** The text of one `entry` of `tarball`, extracted to a temp dir that is removed afterwards. */
export function readTarballEntry(tarball: string, entry: string): string {
  const tmp = mkdtempSync(join(tmpdir(), "freeze-roundtrip-"))
  try {
    spawnSync("tar", ["-xzf", tarball, "-C", tmp, entry])
    return readFileSync(join(tmp, entry), "utf8")
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
