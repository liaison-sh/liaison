// SPDX-License-Identifier: FSL-1.1-ALv2
// Regression guard: the legacy `apps/api/src/modules/chaos-debug/` module was
// removed in the 2026-05-23 SDK-gaps port. Future code must not reintroduce
// imports of that path. The chaos fault injector and its sandboxed app live
// outside this repository and are named at run time (CHAOS_DEBUG_INJECTOR_MODULE,
// LIAISON_DEV_APP_ROOTS).
import { describe, expect, it } from "bun:test"
import { existsSync } from "node:fs"
import { dirname, join, resolve as resolvePath } from "node:path"
import { fileURLToPath } from "node:url"

// Resolve the repo root by walking up from this file's location to the first
// directory that contains the well-known `docker-compose.yml` marker. This is
// stable regardless of which cwd the test runner happens to be in (bun test
// can be invoked from monorepo root, from apps/api, from a worktree, …).
function findRepoRoot(): string {
  let dir = resolvePath(dirname(fileURLToPath(import.meta.url)))
  while (dir !== "/" && !existsSync(join(dir, "docker-compose.yml"))) {
    dir = dirname(dir)
  }
  if (dir === "/") {
    throw new Error("imports.test.ts: could not locate repo root (no docker-compose.yml found)")
  }
  return dir
}

describe("legacy chaos-debug module is fully removed", () => {
  it("no source file in the repo imports from ~/modules/chaos-debug/ (the old path)", async () => {
    const repoRoot = findRepoRoot()
    const proc = Bun.spawn(
      [
        "grep",
        "-rEln",
        "modules/chaos-debug[^-]",
        "--include=*.ts",
        "--include=*.tsx",
        "--include=*.js",
        "apps",
        "packages",
        "scripts",
      ],
      { stdout: "pipe", stderr: "pipe", cwd: repoRoot },
    )
    const stdout = await new Response(proc.stdout).text()
    await proc.exited
    const offenders = stdout
      .split("\n")
      .filter(Boolean)
      // Allow this test file itself (it contains the literal pattern as a string).
      .filter((f) => !f.endsWith("imports.test.ts"))
    expect(offenders).toEqual([])
  })
})
